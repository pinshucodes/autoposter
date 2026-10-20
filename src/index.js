// Autoposter Bot - Step 6: File auto-delete (sent files are removed after a delay)
// Runs on Cloudflare Workers + D1 database.
//
// Secrets (Settings > Variables and Secrets): BOT_TOKEN, OWNER_ID, WEBHOOK_SECRET
// Database binding: DB (set in wrangler.toml)

// ---------- Talking to Telegram ----------
async function tg(env, method, data) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Channel settings we manage ----------
// multi = can have many channels (true) or just one (false)
const ROLES = {
  source: {
    emoji: "📥", name: "Source Channels", multi: true,
    help: "Channels where you upload your files. I watch these for new files.",
  },
  lectures: {
    emoji: "🎓", name: "Lectures Channel", multi: false,
    help: "The channel where lecture posts will be published.",
  },
  pdfs: {
    emoji: "📄", name: "PDFs Channel", multi: false,
    help: "The channel where PDF posts will be published.",
  },
  forcesub: {
    emoji: "🔐", name: "ForceSub Channels", multi: true,
    help: "Users must join all of these before they can get a file. Make me an admin in each one (with Invite Users permission for private channels). No channels = ForceSub is off.",
  },
};

// ---------- Database helpers ----------
async function getChannels(env, role) {
  const r = await env.DB.prepare("SELECT chat_id, title, link FROM channels WHERE role = ?").bind(role).all();
  return r.results || [];
}

async function addChannel(env, role, chatId, title, link) {
  const steps = [];
  if (!ROLES[role].multi) {
    steps.push(env.DB.prepare("DELETE FROM channels WHERE role = ?").bind(role));
  }
  steps.push(
    env.DB.prepare("INSERT OR REPLACE INTO channels (role, chat_id, title, link) VALUES (?, ?, ?, ?)")
      .bind(role, String(chatId), title, link || null)
  );
  await env.DB.batch(steps);
}

async function removeChannel(env, role, chatId) {
  await env.DB.prepare("DELETE FROM channels WHERE role = ? AND chat_id = ?").bind(role, String(chatId)).run();
}

async function setState(env, userId, action) {
  await env.DB.prepare("INSERT OR REPLACE INTO state (user_id, action) VALUES (?, ?)").bind(String(userId), action).run();
}

async function getState(env, userId) {
  const r = await env.DB.prepare("SELECT action FROM state WHERE user_id = ?").bind(String(userId)).first();
  return r ? r.action : null;
}

async function clearState(env, userId) {
  await env.DB.prepare("DELETE FROM state WHERE user_id = ?").bind(String(userId)).run();
}

// ---------- Files we have seen in source channels ----------
async function saveFile(env, f) {
  // Returns the new row id, or null if we already saw this exact file
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO files (file_id, file_unique_id, kind, send_as, title, size) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(f.file_id, f.file_unique_id, f.kind, f.send_as, f.title, f.size).run();
  return r.meta.changes > 0 ? r.meta.last_row_id : null;
}

async function getFileRow(env, id) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
}

function formatSize(bytes) {
  if (!bytes) return "Unknown";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
}

// Decides if a post is a lecture (video) or a PDF. Anything else is ignored.
function classifyPost(post) {
  if (post.video) {
    return { kind: "lecture", send_as: "video", file: post.video, name: post.video.file_name || "" };
  }
  if (post.document) {
    const d = post.document;
    const name = d.file_name || "";
    const mime = d.mime_type || "";
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      return { kind: "pdf", send_as: "document", file: d, name };
    }
    if (mime.startsWith("video/")) {
      return { kind: "lecture", send_as: "document", file: d, name };
    }
  }
  return null;
}

// Title = first line of the caption, otherwise the file name without extension
function makeTitle(post, name) {
  const caption = (post.caption || "").split("\n")[0].trim();
  if (caption) return caption;
  const cleaned = name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim();
  return cleaned || "Untitled";
}

async function sendFileToUser(env, chatId, row) {
  const asVideo = row.send_as === "video";
  const sent = await tg(env, asVideo ? "sendVideo" : "sendDocument", {
    chat_id: chatId,
    [asVideo ? "video" : "document"]: row.file_id,
    caption: row.title,
  });

  // Auto-delete: warn the user and schedule removal
  const mins = parseInt((await getSetting(env, "delete_minutes")) || "0", 10);
  if (!sent.ok || !mins) return;

  const notice = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `⚠️ This file will be deleted in <b>${formatDelay(mins)}</b>. Forward it or save it somewhere now.`,
    parse_mode: "HTML",
  });
  const deleteAt = Date.now() + mins * 60 * 1000;
  const ids = [sent.result.message_id];
  if (notice.ok) ids.push(notice.result.message_id);
  for (const id of ids) {
    await env.DB.prepare("INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)")
      .bind(String(chatId), id, deleteAt).run();
  }
}

// Runs every minute (Cron Trigger): deletes messages whose time is up
async function runDeletions(env) {
  const due = await env.DB.prepare(
    "SELECT id, chat_id, message_id FROM deletions WHERE delete_at <= ? ORDER BY delete_at LIMIT 40"
  ).bind(Date.now()).all();
  for (const d of due.results || []) {
    await tg(env, "deleteMessage", { chat_id: d.chat_id, message_id: d.message_id });
    await env.DB.prepare("DELETE FROM deletions WHERE id = ?").bind(d.id).run();
  }
}

// ---------- Simple saved settings ----------
async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
}

// ---------- Shortlink ----------
async function shortlinkReady(env) {
  const on = await getSetting(env, "shortlink_enabled");
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  return on === "1" && !!domain && !!key;
}

// Works with most shortener sites that use the standard /api?api=KEY&url=LINK format
async function shortenUrl(env, longUrl) {
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  if (!domain || !key) return null;
  try {
    const api = `https://${domain}/api?api=${encodeURIComponent(key)}&url=${encodeURIComponent(longUrl)}`;
    const res = await fetch(api);
    const data = await res.json();
    if (data.status === "success" && data.shortenedUrl) return data.shortenedUrl;
    console.log("Shortlink API said:", JSON.stringify(data));
  } catch (err) {
    console.log("Shortlink error:", err);
  }
  return null;
}

// Gives the user a one-time shortlink. After passing it, they come back to the bot with a token.
async function sendVerifyLink(env, chatId, userId, row) {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("DELETE FROM tokens WHERE created < ?").bind(Date.now() - 24 * 3600 * 1000).run();
  await env.DB.prepare("INSERT INTO tokens (token, user_id, file_row_id, created) VALUES (?, ?, ?, ?)")
    .bind(token, String(userId), row.id, Date.now()).run();

  const me = await tg(env, "getMe", {});
  const short = await shortenUrl(env, `https://t.me/${me.result.username}?start=v${token}`);
  if (!short) {
    // Shortener is down or misconfigured - don't leave the user stuck
    await sendFileToUser(env, chatId, row);
    return;
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `🔗 <b>Verify to get your file</b>\n\n<b>${esc(row.title)}</b>\n\nTap the button below and complete the short step. You'll be brought back here and I'll send the file.`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "✅ Verify & Get File", url: short }]] },
  });
}

// ---------- ForceSub check ----------
// Returns the ForceSub channels this user has NOT joined yet
async function getMissingChannels(env, userId) {
  const channels = await getChannels(env, "forcesub");
  const missing = [];
  for (const c of channels) {
    const r = await tg(env, "getChatMember", { chat_id: c.chat_id, user_id: userId });
    if (!r.ok) continue; // can't check (e.g. I lost admin) - don't block the user
    const st = r.result.status;
    const joined = st === "member" || st === "administrator" || st === "creator" ||
      (st === "restricted" && r.result.is_member);
    if (!joined) missing.push(c);
  }
  return missing;
}

// Sends the file, or asks the user to join the channels first
async function deliverFile(env, chatId, userId, row, verified) {
  const missing = await getMissingChannels(env, userId);
  if (!missing.length) {
    if (!verified && (await shortlinkReady(env))) {
      await sendVerifyLink(env, chatId, userId, row);
      return;
    }
    await sendFileToUser(env, chatId, row);
    return;
  }
  const buttons = missing.map((c) => [{ text: `📢 Join ${c.title}`.slice(0, 60), url: c.link }]);
  buttons.push([{ text: "✅ I've Joined", callback_data: `chk:${row.id}` }]);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔐 To get this file, please join the channel(s) below, then tap <b>I've Joined</b>.",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

// ---------- Menus ----------
const MAIN_MENU = {
  text: "⚙️ <b>Settings</b>\n\nSelect what you want to configure:",
  buttons: [
    [{ text: "📥 Source Channels", callback_data: "role:source" }],
    [{ text: "🎓 Lectures Channel", callback_data: "role:lectures" }],
    [{ text: "📄 PDFs Channel", callback_data: "role:pdfs" }],
    [{ text: "🔐 ForceSub Settings", callback_data: "role:forcesub" }],
    [{ text: "🔗 Shortlink Settings", callback_data: "sl:menu" }],
    [{ text: "🗑️ File Delete Settings", callback_data: "del:menu" }],
    [{ text: "❌ Close", callback_data: "close" }],
  ],
};

// Placeholders for settings we build in later steps
const SUB_MENUS = {
};

const BACK_BUTTON = [[{ text: "⬅️ Back", callback_data: "back" }]];

async function buildRoleMenu(env, role) {
  const info = ROLES[role];
  const channels = await getChannels(env, role);

  let text = `${info.emoji} <b>${info.name}</b>\n\n${info.help}\n\n`;
  text += channels.length
    ? channels.map((c) => `• ${esc(c.title)} (<code>${c.chat_id}</code>)`).join("\n")
    : "<i>None set yet.</i>";

  const buttons = channels.map((c) => [
    { text: `🗑 Remove ${c.title}`.slice(0, 60), callback_data: `rm:${role}:${c.chat_id}` },
  ]);
  const addLabel = info.multi ? "➕ Add Channel" : channels.length ? "🔄 Change Channel" : "➕ Set Channel";
  buttons.push([{ text: addLabel, callback_data: `add:${role}` }]);
  buttons.push(...BACK_BUTTON);

  return { text, buttons };
}

async function showRoleMenu(env, chatId, messageId, role) {
  const menu = await buildRoleMenu(env, role);
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: menu.buttons },
  });
}

async function showMainMenu(env, chatId, messageId) {
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: MAIN_MENU.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: MAIN_MENU.buttons },
  });
}

// ---------- File delete settings menu ----------
function formatDelay(mins) {
  if (!mins) return "Off";
  if (mins >= 60 && mins % 60 === 0) {
    const h = mins / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${mins} min`;
}

async function buildDeleteMenu(env, note) {
  const mins = parseInt((await getSetting(env, "delete_minutes")) || "0", 10);
  let text = "🗑️ <b>File Delete Settings</b>\n\n" +
    "Files sent by the bot are deleted from the user's chat after the time you choose. " +
    "Telegram allows up to 47 hours.\n\n" +
    `Current: <b>${formatDelay(mins)}</b>`;
  if (note) text += `\n\n${note}`;

  const choice = (label, value) => ({
    text: (mins === value ? "✅ " : "") + label,
    callback_data: `del:set:${value}`,
  });
  const buttons = [
    [choice("Off", 0), choice("5 min", 5), choice("10 min", 10)],
    [choice("30 min", 30), choice("1 hour", 60), choice("6 hours", 360)],
    [choice("24 hours", 1440), { text: "✏️ Custom", callback_data: "del:custom" }],
    ...BACK_BUTTON,
  ];
  return { text, buttons };
}

async function showDeleteMenu(env, chatId, messageId, note) {
  const menu = await buildDeleteMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: menu.buttons },
  });
}

// ---------- Shortlink settings menu ----------
async function buildShortlinkMenu(env, note) {
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  const on = (await getSetting(env, "shortlink_enabled")) === "1";

  let text = "🔗 <b>Shortlink Settings</b>\n\nUsers pass a shortlink before they get a file.\n\n";
  text += `Status: ${on ? "✅ ON" : "❌ OFF"}\n`;
  text += `Domain: ${domain ? esc(domain) : "<i>not set</i>"}\n`;
  text += `API key: ${key ? "<code>" + esc(key.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: on ? "🔴 Turn OFF" : "🟢 Turn ON", callback_data: "sl:toggle" }],
    [{ text: "🌐 Set Domain", callback_data: "sl:domain" }],
    [{ text: "🔑 Set API Key", callback_data: "sl:key" }],
    ...BACK_BUTTON,
  ];
  return { text, buttons };
}

async function showShortlinkMenu(env, chatId, messageId, note) {
  const menu = await buildShortlinkMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: menu.buttons },
  });
}

// Owner typed a new domain or API key
async function handleSettingInput(env, msg, field) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  let value = (msg.text || "").trim();
  if (!value) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Please send it as text, or /cancel to stop." });
    return;
  }
  if (field === "delete_minutes") {
    const mins = parseInt(value, 10);
    if (!/^\d+$/.test(value) || mins < 1 || mins > 2820) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Please send a number of minutes between 1 and 2820 (that's 47 hours), or /cancel to stop.",
      });
      return;
    }
    await setSetting(env, "delete_minutes", String(mins));
    await clearState(env, userId);
    const dmenu = await buildDeleteMenu(env, "✅ Saved.");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: dmenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: dmenu.buttons },
    });
    return;
  }
  if (field === "shortlink_domain") {
    value = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  }
  if (field === "shortlink_key") {
    // Remove the owner's message so the key doesn't stay in the chat
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  }
  await setSetting(env, field, value);
  await clearState(env, userId);

  let note = "✅ Saved.";
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  if (domain && key) {
    const test = await shortenUrl(env, "https://t.me/telegram");
    note += test ? " Test shortlink worked ✅" : " ⚠️ Test failed. Double-check your domain and API key.";
  }
  const menu = await buildShortlinkMenu(env, note);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: menu.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: menu.buttons },
  });
}

// ---------- Checking a channel ----------
// Works out which channel the owner meant (forwarded message, ID, or @username)
function extractChannelRef(msg) {
  const fo = msg.forward_origin;
  if (fo && fo.type === "channel") return fo.chat.id;
  if (msg.forward_from_chat) return msg.forward_from_chat.id;
  const t = (msg.text || "").trim();
  if (/^-100\d+$/.test(t)) return t;
  if (/^@\w+$/.test(t)) return t;
  return null;
}

// Makes sure the channel exists and that I'm an admin there
async function checkChannel(env, ref, role) {
  const chat = await tg(env, "getChat", { chat_id: ref });
  if (!chat.ok) return { error: "I can't find that channel. Check the ID and make sure I'm added as an admin." };
  if (chat.result.type !== "channel") return { error: "That's not a channel. Please send a channel." };

  const me = await tg(env, "getMe", {});
  const member = await tg(env, "getChatMember", { chat_id: chat.result.id, user_id: me.result.id });
  if (!member.ok || member.result.status !== "administrator") {
    return { error: "Please add me as an <b>admin</b> in that channel first, then send it again." };
  }
  if ((role === "lectures" || role === "pdfs") && member.result.can_post_messages === false) {
    return { error: "I'm an admin there, but I need the <b>Post Messages</b> permission. Turn it on and send again." };
  }
  // ForceSub channels need a join link for the buttons
  if (role === "forcesub") {
    let link = chat.result.username ? `https://t.me/${chat.result.username}` : null;
    if (!link) {
      const inv = await tg(env, "exportChatInviteLink", { chat_id: chat.result.id });
      if (inv.ok) link = inv.result;
    }
    if (!link) {
      return { error: "I couldn't get a join link. Give me the <b>Invite Users via Link</b> permission in that channel and send again." };
    }
    return { id: chat.result.id, title: chat.result.title, link };
  }
  return { id: chat.result.id, title: chat.result.title };
}

// ---------- Handling messages ----------
async function handleMessage(msg, env) {
  const text = msg.text || "";
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const isOwner = userId === String(env.OWNER_ID);

  if (text.startsWith("/start")) {
    // Coming back from the shortlink: /start v<token>
    const tok = text.match(/^\/start v([A-Za-z0-9]+)/);
    if (tok) {
      const t = await env.DB.prepare("SELECT file_row_id, user_id, created FROM tokens WHERE token = ?")
        .bind(tok[1]).first();
      const fresh = t && Date.now() - t.created < 60 * 60 * 1000;
      if (!t || String(t.user_id) !== userId || !fresh) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ This verification link is invalid or has expired. Please tap <b>Get File</b> on the channel post again.",
          parse_mode: "HTML",
        });
        return;
      }
      await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(tok[1]).run();
      const row = await getFileRow(env, t.file_row_id);
      if (!row) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
      } else {
        await deliverFile(env, chatId, msg.from.id, row, true);
      }
      return;
    }

    // Links from channel posts look like /start f12
    const match = text.match(/^\/start f(\d+)/);
    if (match) {
      const row = await getFileRow(env, Number(match[1]));
      if (!row) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
      } else {
        await deliverFile(env, chatId, msg.from.id, row);
      }
      return;
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "👋 Hi! I'm your Autoposter bot.\nOwner can use /settings to configure me.",
    });
    return;
  }

  if (!isOwner) return;

  if (text.startsWith("/settings")) {
    await clearState(env, userId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: MAIN_MENU.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU.buttons },
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  if (text.startsWith("/cancel")) {
    await clearState(env, userId);
    await tg(env, "sendMessage", { chat_id: chatId, text: "Cancelled." });
    return;
  }

  // Are we waiting for the owner to send a channel?
  const state = await getState(env, userId);
  if (state && state.startsWith("set:")) {
    await handleSettingInput(env, msg, state.split(":")[1]);
    return;
  }
  if (state && state.startsWith("add:")) {
    const role = state.split(":")[1];
    const ref = extractChannelRef(msg);
    if (!ref) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Please forward any message from the channel, or send its ID (like -1001234567890) or @username.\nSend /cancel to stop.",
      });
      return;
    }
    const result = await checkChannel(env, ref, role);
    if (result.error) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ " + result.error, parse_mode: "HTML" });
      return;
    }
    await addChannel(env, role, result.id, result.title, result.link);
    await clearState(env, userId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Saved <b>${esc(result.title)}</b> as ${ROLES[role].name}.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: `Open ${ROLES[role].name}`, callback_data: `role:${role}:new` }]],
      },
    });
  }
}

// ---------- Handling button taps ----------
async function handleButton(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = String(query.from.id);
  const parts = query.data.split(":");
  const action = parts[0];

  // "I've Joined" button - anyone can use this one
  if (action === "chk") {
    const row = await getFileRow(env, Number(parts[1]));
    if (!row) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id, text: "That file is no longer available.", show_alert: true,
      });
      return;
    }
    const missing = await getMissingChannels(env, query.from.id);
    if (missing.length) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id, text: "You haven't joined all the channels yet.", show_alert: true,
      });
      return;
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    await deliverFile(env, chatId, query.from.id, row, false);
    return;
  }

  if (userId !== String(env.OWNER_ID)) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Only the owner can do this.",
      show_alert: true,
    });
    return;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });

  if (action === "close") {
    await clearState(env, userId);
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    return;
  }

  if (action === "back") {
    await clearState(env, userId);
    await showMainMenu(env, chatId, messageId);
    return;
  }

  // Open a channel menu: role:source
  if (action === "role" && ROLES[parts[1]]) {
    await clearState(env, userId);
    await showRoleMenu(env, chatId, messageId, parts[1]);
    return;
  }

  // Start adding a channel: add:source
  if (action === "add" && ROLES[parts[1]]) {
    const role = parts[1];
    await setState(env, userId, `add:${role}`);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text:
        `${ROLES[role].emoji} <b>${ROLES[role].name}</b>\n\n` +
        "Make me an <b>admin</b> in the channel first. Then <b>forward any message</b> from that channel here, " +
        "or send its ID (like <code>-1001234567890</code>) or @username.",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `role:${role}` }]] },
    });
    return;
  }

  // Remove a channel: rm:source:-100123...
  if (action === "rm" && ROLES[parts[1]]) {
    await removeChannel(env, parts[1], parts.slice(2).join(":"));
    await showRoleMenu(env, chatId, messageId, parts[1]);
    return;
  }

  // File delete settings: del:menu, del:set:<minutes>, del:custom
  if (action === "del") {
    const sub = parts[1];
    if (sub === "custom") {
      await setState(env, userId, "set:delete_minutes");
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "✏️ Send the number of minutes (1 to 2820). For example, <code>90</code> means 1.5 hours.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "del:menu" }]] },
      });
      return;
    }
    if (sub === "set") {
      await setSetting(env, "delete_minutes", String(parseInt(parts[2], 10) || 0));
    }
    await clearState(env, userId);
    await showDeleteMenu(env, chatId, messageId);
    return;
  }

  // Shortlink settings: sl:menu, sl:toggle, sl:domain, sl:key
  if (action === "sl") {
    const sub = parts[1];
    if (sub === "domain" || sub === "key") {
      await setState(env, userId, `set:shortlink_${sub}`);
      const prompt = sub === "domain"
        ? "🌐 Send your shortener's domain, like <code>example.com</code>."
        : "🔑 Send your shortener's API key. I'll delete your message after saving it.";
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: prompt,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "sl:menu" }]] },
      });
      return;
    }
    let note = "";
    if (sub === "toggle") {
      const on = (await getSetting(env, "shortlink_enabled")) === "1";
      if (on) {
        await setSetting(env, "shortlink_enabled", "0");
      } else if (!(await getSetting(env, "shortlink_domain")) || !(await getSetting(env, "shortlink_key"))) {
        note = "⚠️ Set the domain and API key first.";
      } else {
        await setSetting(env, "shortlink_enabled", "1");
      }
    }
    await clearState(env, userId);
    await showShortlinkMenu(env, chatId, messageId, note);
    return;
  }

  if (SUB_MENUS[action]) {
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: SUB_MENUS[action],
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: BACK_BUTTON },
    });
  }
}

// ---------- Handling new posts in channels ----------
async function handleChannelPost(post, env) {
  // Only react to channels saved as Source Channels
  const chatId = String(post.chat.id);
  const isSource = await env.DB.prepare(
    "SELECT 1 AS ok FROM channels WHERE role = 'source' AND chat_id = ?"
  ).bind(chatId).first();
  if (!isSource) return;

  const info = classifyPost(post);
  if (!info) return;

  // Find where to publish it
  const destRole = info.kind === "pdf" ? "pdfs" : "lectures";
  const dest = await getChannels(env, destRole);
  if (!dest.length) return;

  const title = makeTitle(post, info.name);
  const rowId = await saveFile(env, {
    file_id: info.file.file_id,
    file_unique_id: info.file.file_unique_id,
    kind: info.kind,
    send_as: info.send_as,
    title,
    size: info.file.file_size || 0,
  });
  if (!rowId) return; // already posted before

  const me = await tg(env, "getMe", {});
  const emoji = info.kind === "pdf" ? "📄" : "🎓";
  const label = info.kind === "pdf" ? "PDF" : "Lecture";

  await tg(env, "sendMessage", {
    chat_id: dest[0].chat_id,
    text: `${emoji} <b>${esc(title)}</b>\n\n🏷 Type: ${label}\n📦 Size: ${formatSize(info.file.file_size)}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "📥 Get File", url: `https://t.me/${me.result.username}?start=f${rowId}` },
      ]],
    },
  });
}

// ---------- Entry point ----------
export default {
  // Cron Trigger: runs every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDeletions(env));
  },

  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Autoposter bot is running ✅");
    }
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json();
    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleButton(update.callback_query, env);
      if (update.channel_post) await handleChannelPost(update.channel_post, env);
    } catch (err) {
      console.log("Error:", err);
    }
    return new Response("OK");
  },
};
