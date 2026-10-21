// Autoposter Bot - Phase 1 (security and reliability) + Mini App payments (UPI)
// Runs on Cloudflare Workers + D1 database.
//
// Secrets (Settings > Variables and Secrets): BOT_TOKEN, OWNER_ID, WEBHOOK_SECRET
// Database binding: DB (set in wrangler.toml)

// ---------- Talking to Telegram ----------
async function tg(env, method, data, retried) {
  let json;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    json = await res.json();
  } catch (err) {
    // Never let the bot token leak into logs or messages
    const text = String(err).split(env.BOT_TOKEN).join("***");
    return { ok: false, error_code: 0, description: text };
  }
  // Telegram says "slow down": wait a moment and try once more
  if (!json.ok && json.error_code === 429 && !retried) {
    const wait = (json.parameters && json.parameters.retry_after) || 1;
    if (wait <= 2) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 100));
      return tg(env, method, data, true);
    }
  }
  return json;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Channel settings we manage ----------
// multi = can have many channels (true) or just one (false)
const ROLES = {
  source: {
    emoji: "📥", name: "Source Channels", multi: true,
    help: "Channels or groups where you upload your files. I watch these for new files. (For a group, make me an admin so I can see the files. Only group admins can add files.)",
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

  if (!sent.ok) {
    console.log("Send file failed:", sent.error_code, sent.description);
    if (sent.error_code !== 403) { // 403 = the user blocked the bot, nothing to tell them
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ I couldn't send the file right now. Please try again in a minute.",
      });
      await alertOwner(env, `send${row.id}`, `Could not send file #${row.id} "${row.title}": ${sent.description}`);
    }
    return false;
  }

  await env.DB.prepare("INSERT INTO downloads (user_id, file_row_id, day) VALUES (?, ?, ?)")
    .bind(String(chatId), row.id, dayString(0)).run();

  // Auto-delete: warn the user and schedule removal
  const mins = parseInt((await getSetting(env, "delete_minutes")) || "0", 10);
  if (!mins) return true;

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
  return true;
}

// Runs every minute (Cron Trigger): deletes messages whose time is up, and retries if Telegram had a hiccup
async function runDeletions(env, limit) {
  const due = await env.DB.prepare(
    "SELECT id, chat_id, message_id, attempts FROM deletions WHERE delete_at <= ? ORDER BY delete_at LIMIT ?"
  ).bind(Date.now(), limit).all();

  for (const d of due.results || []) {
    const r = await tg(env, "deleteMessage", { chat_id: d.chat_id, message_id: d.message_id });
    // Done, or Telegram says it can never work (already deleted, too old, user blocked me)
    const finalAnswer = r.ok || r.error_code === 400 || r.error_code === 403;
    if (finalAnswer || d.attempts >= 8) {
      await env.DB.prepare("DELETE FROM deletions WHERE id = ?").bind(d.id).run();
    } else {
      // Temporary problem: try again soon, waiting a bit longer each time
      await env.DB.prepare("UPDATE deletions SET attempts = attempts + 1, delete_at = ? WHERE id = ?")
        .bind(Date.now() + (d.attempts + 1) * 60000, d.id).run();
    }
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
    // Shortener is down or misconfigured - don't leave the user stuck, but tell the owner
    await alertOwner(env, "shortlink",
      "The shortlink service isn't responding, or the API key is wrong. Users are getting files WITHOUT verification until it's fixed. Check /status.");
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
  const checks = await Promise.all(channels.map(async (c) => {
    const r = await tg(env, "getChatMember", { chat_id: c.chat_id, user_id: userId });
    if (!r.ok) {
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return c; // not joined
      // I can't check this channel (maybe I lost admin). Don't lock users out, but warn the owner.
      await alertOwner(env, `fs${c.chat_id}`,
        `ForceSub can't check "${c.title}": ${r.description}. Make sure I'm still an admin there. Until then users are NOT being checked for that channel.`);
      return null;
    }
    const st = r.result.status;
    const joined = st === "member" || st === "administrator" || st === "creator" ||
      (st === "restricted" && r.result.is_member);
    return joined ? null : c;
  }));
  return checks.filter(Boolean);
}

// Makes sure a ForceSub channel has a join link (older channels may not have one saved)
async function ensureLink(env, c) {
  if (c.link) return c.link;
  const chat = await tg(env, "getChat", { chat_id: c.chat_id });
  let link = chat.ok && chat.result.username ? `https://t.me/${chat.result.username}` : null;
  if (!link) {
    const inv = await tg(env, "exportChatInviteLink", { chat_id: c.chat_id });
    if (inv.ok) link = inv.result;
  }
  if (link) {
    await env.DB.prepare("UPDATE channels SET link = ? WHERE role = 'forcesub' AND chat_id = ?").bind(link, c.chat_id).run();
  } else {
    await alertOwner(env, `lnk${c.chat_id}`, `I have no join link for ForceSub channel "${c.title}". Give me the Invite Users permission there.`);
  }
  return link;
}

// Sends the file, or asks the user to join the channels first
async function deliverFile(env, chatId, userId, row, verified) {
  const missing = await getMissingChannels(env, userId);
  if (!missing.length) {
    if (!verified && (await shortlinkReady(env)) && !(await hasActiveSub(env, userId))) {
      await sendVerifyLink(env, chatId, userId, row);
      return;
    }
    await sendFileToUser(env, chatId, row);
    return;
  }
  const buttons = [];
  for (const c of missing) {
    const link = await ensureLink(env, c);
    if (link) buttons.push([{ text: `📢 Join ${c.title}`.slice(0, 60), url: link }]);
  }
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
    [{ text: "🖼️ Cover Images", callback_data: "cov:menu" }],
    [{ text: "💳 Payments", callback_data: "pay:menu" }],
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

// ---------- Cover images menu ----------
async function buildCoverMenu(env, note) {
  const pdf = await getSetting(env, "cover_pdf");
  const lec = await getSetting(env, "cover_lecture");
  let text = "🖼️ <b>Cover Images</b>\n\n" +
    "A cover is the picture shown on each channel post. If none is set, I use the file's own thumbnail when it has one.\n\n" +
    `📄 PDF cover: ${pdf ? "✅ Set" : "❌ Not set"}\n` +
    `🎓 Lecture cover: ${lec ? "✅ Set" : "❌ Not set"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: pdf ? "📄 Change PDF Cover" : "📄 Set PDF Cover", callback_data: "cov:set:pdf" }],
    [{ text: lec ? "🎓 Change Lecture Cover" : "🎓 Set Lecture Cover", callback_data: "cov:set:lecture" }],
  ];
  if (pdf) buttons.push([{ text: "🗑 Remove PDF Cover", callback_data: "cov:rm:pdf" }]);
  if (lec) buttons.push([{ text: "🗑 Remove Lecture Cover", callback_data: "cov:rm:lecture" }]);
  buttons.push(...BACK_BUTTON);
  return { text, buttons };
}

async function showCoverMenu(env, chatId, messageId, note) {
  const menu = await buildCoverMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: menu.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: menu.buttons },
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
  if (field.startsWith("cover_")) {
    if (!msg.photo) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Please send a photo (not a file), or /cancel to stop.",
      });
      return;
    }
    await setSetting(env, field, msg.photo[msg.photo.length - 1].file_id);
    await clearState(env, userId);
    const cmenu = await buildCoverMenu(env, "✅ Cover saved.");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: cmenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: cmenu.buttons },
    });
    return;
  }

  if (field === "upi_id" || field === "upi_name") {
    const v = (msg.text || "").trim();
    const valid = field === "upi_id"
      ? /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$/.test(v)
      : v.length >= 2 && v.length <= 40 && !/[&?=#%<>]/.test(v);
    if (!valid) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: field === "upi_id"
          ? "That doesn't look like a UPI ID. It should look like name@bank. Try again, or /cancel."
          : "Please send a short name (2 to 40 letters, no special symbols), or /cancel.",
      });
      return;
    }
    await setSetting(env, field, v);
    await clearState(env, userId);
    const pmenu = await buildPayMenu(env, "✅ Saved.");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: pmenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: pmenu.buttons },
    });
    return;
  }

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
  if (fo && fo.type === "chat" && fo.sender_chat) return fo.sender_chat.id;
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
  const isGroup = chat.result.type === "supergroup" || chat.result.type === "group";
  if (chat.result.type !== "channel" && !(role === "source" && isGroup)) {
    return { error: role === "source" ? "That's not a channel or group." : "That's not a channel. Please send a channel." };
  }

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

// ---------- Users, stats, post and broadcast ----------
// Days (for stats) follow this time zone. 330 = India (IST). Change if you like.
const TZ_OFFSET_MIN = 330;

// Coming back from the shortlink faster than this = they skipped it
const MIN_VERIFY_SECONDS = 8;

// Rate limit: at most RATE_MAX actions per RATE_WINDOW_MS for each user
const RATE_MAX = 8;
const RATE_WINDOW_MS = 10000;

function dayString(daysAgo) {
  const t = Date.now() + TZ_OFFSET_MIN * 60000 - daysAgo * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// Saves the user and returns true if they are banned
async function recordUser(env, from) {
  const r = await env.DB.prepare(
    "INSERT INTO users (user_id, first_name, joined_day, last_seen, active) VALUES (?, ?, ?, ?, 1) " +
    "ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, last_seen = excluded.last_seen, active = 1 " +
    "RETURNING banned"
  ).bind(String(from.id), from.first_name || "", dayString(0), Date.now()).first();
  return !!(r && r.banned);
}

// Every channel I know, so /post can let you choose (max 30)
async function getPostTargets(env) {
  const r = await env.DB.prepare(
    "SELECT chat_id, title, GROUP_CONCAT(role) AS roles FROM channels GROUP BY chat_id ORDER BY title, chat_id"
  ).all();
  return (r.results || []).slice(0, 30);
}

async function countBroadcastUsers(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND active = 1").first();
  return r ? r.n : 0;
}

// ---------- Alerts to the owner ----------
// Tells the owner about a problem, at most once per 30 minutes for each kind of problem
async function alertOwner(env, key, text) {
  try {
    const last = parseInt((await getSetting(env, `alert_${key}`)) || "0", 10);
    if (Date.now() - last < 30 * 60 * 1000) return;
    await setSetting(env, `alert_${key}`, String(Date.now()));
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `🚨 ${text}` });
  } catch (err) {
    console.log("Alert failed:", err);
  }
}

// ---------- Rate limit ----------
// Returns true if this user is sending too fast and should be ignored
async function isRateLimited(env, userId, chatId) {
  const now = Date.now();
  const r = await env.DB.prepare("SELECT window_start, count FROM rate WHERE user_id = ?").bind(String(userId)).first();
  if (!r || now - r.window_start > RATE_WINDOW_MS) {
    await env.DB.prepare("INSERT OR REPLACE INTO rate (user_id, window_start, count) VALUES (?, ?, 1)")
      .bind(String(userId), now).run();
    return false;
  }
  const count = r.count + 1;
  await env.DB.prepare("UPDATE rate SET count = ? WHERE user_id = ?").bind(count, String(userId)).run();
  if (count === RATE_MAX + 1) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⏳ You're going too fast. Please wait a few seconds." });
    await alertOwner(env, `rl${userId}`, `User ${userId} is sending requests very fast. To block them: /ban ${userId}`);
  }
  return count > RATE_MAX;
}

// In a Source group, only admins (or you) may add files; otherwise anyone could post through me
async function isTrustedSender(env, post) {
  if (post.sender_chat && post.sender_chat.id === post.chat.id) return true; // admin posting anonymously
  if (!post.from) return false;
  if (String(post.from.id) === String(env.OWNER_ID)) return true;
  const r = await tg(env, "getChatMember", { chat_id: post.chat.id, user_id: post.from.id });
  return r.ok && (r.result.status === "creator" || r.result.status === "administrator");
}

// The /post channel picker
function renderPicker(targets, mask, note) {
  let text = "📣 <b>Choose where to post</b>\n\nTap a channel to switch it on or off, then tap Send.";
  if (note) text += `\n\n${note}`;
  const buttons = targets.map((c, i) => [{
    text: `${mask & (1 << i) ? "✅" : "⬜"} ${c.title}`.slice(0, 60),
    callback_data: `pk:t:${i}`,
  }]);
  buttons.push([
    { text: "📤 Send", callback_data: "pk:go" },
    { text: "✖️ Cancel", callback_data: "pk:no" },
  ]);
  return { text, buttons };
}

// After the owner sends the message for /post or /broadcast
async function askConfirm(env, msg, kind) {
  const userId = String(msg.from.id);
  await clearState(env, userId);

  if (kind === "post") {
    const targets = await getPostTargets(env);
    if (!targets.length) {
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: "You haven't added any channels yet. Add them in /settings first.",
      });
      return;
    }
    // Everything is switched on except channels that are only Source channels
    let mask = 0;
    targets.forEach((c, i) => { if (c.roles !== "source") mask |= 1 << i; });
    await setState(env, userId, `pick:${msg.message_id}:${mask}`);
    const view = renderPicker(targets, mask);
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: view.text,
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: view.buttons },
    });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: `📢 Send this message to <b>${await countBroadcastUsers(env)}</b> users?`,
    parse_mode: "HTML",
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Yes, send", callback_data: `pst:broadcast:${msg.message_id}` },
        { text: "✖️ Cancel", callback_data: "pst:no" },
      ]],
    },
  });
}

// Sends the broadcast to the next batch of users. Called right away and then every minute by the cron.
async function processBroadcast(env, limit) {
  const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;

  // Short lock so two runs can never send to the same users at once
  const now = Date.now();
  const lock = await env.DB.prepare(
    "UPDATE broadcasts SET locked_until = ? WHERE id = ? AND locked_until < ? AND status = 'running'"
  ).bind(now + 55000, job.id, now).run();
  if (!lock.meta.changes) return;

  const users = await env.DB.prepare(
    "SELECT rowid AS rid, user_id FROM users WHERE rowid > ? AND banned = 0 AND active = 1 ORDER BY rowid LIMIT ?"
  ).bind(job.last_rowid, limit).all();
  const list = users.results || [];

  let sent = 0, failed = 0, last = job.last_rowid, backoff = 0;
  for (const u of list) {
    const r = await tg(env, "copyMessage", {
      chat_id: u.user_id, from_chat_id: job.from_chat, message_id: job.message_id,
    });
    if (!r.ok && r.error_code === 429) { // Telegram says slow down: pause and continue later
      backoff = ((r.parameters && r.parameters.retry_after) || 5) * 1000;
      break;
    }
    if (r.ok) {
      sent++;
    } else {
      failed++;
      if (r.error_code === 403) { // blocked the bot: skip them in future broadcasts
        await env.DB.prepare("UPDATE users SET active = 0 WHERE user_id = ?").bind(u.user_id).run();
      }
    }
    last = u.rid;
  }

  const finished = !backoff && list.length < limit;
  await env.DB.prepare(
    "UPDATE broadcasts SET last_rowid = ?, sent = sent + ?, failed = failed + ?, locked_until = ?, " +
    "status = CASE WHEN status = 'running' AND ? = 1 THEN 'done' ELSE status END WHERE id = ?"
  ).bind(last, sent, failed, backoff ? Date.now() + backoff : 0, finished ? 1 : 0, job.id).run();

  if (finished) {
    const after = await env.DB.prepare("SELECT status FROM broadcasts WHERE id = ?").bind(job.id).first();
    if (after && after.status === "done") {
      await tg(env, "sendMessage", {
        chat_id: job.owner_chat,
        text: `✅ Broadcast finished.\nDelivered: ${job.sent + sent}\nFailed: ${job.failed + failed}`,
      });
    }
  }
}

// Runs every minute. Deletions and broadcasts share Cloudflare's free request limit per run.
async function runCron(env) {
  try {
    await setSetting(env, "last_cron", String(Date.now()));
    const job = await env.DB.prepare("SELECT 1 AS x FROM broadcasts WHERE status = 'running' LIMIT 1").first();
    await runDeletions(env, job ? 15 : 40);
    if (job) await processBroadcast(env, 30);
  } catch (err) {
    console.log("Cron error:", err);
    await alertOwner(env, "cron", `The scheduled cleanup job hit an error: ${String(err).slice(0, 300)}`);
  }
}

async function sendStats(env, chatId) {
  const today = dayString(0);
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();

  const total = await one("SELECT COUNT(*) AS n FROM users");
  const active = await one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND banned = 0");
  const banned = await one("SELECT COUNT(*) AS n FROM users WHERE banned = 1");
  const joined = await one("SELECT COUNT(*) AS n FROM users WHERE joined_day = ?", today);
  const ver = await one("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM verifications WHERE day = ?", today);
  const dl = await one("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM downloads WHERE day = ?", today);
  const files = await one("SELECT COUNT(*) AS n FROM files");
  const subs = await one("SELECT COUNT(*) AS n FROM subscriptions WHERE expires_at > ?", Date.now());

  const since = dayString(6);
  const vWeek = await env.DB.prepare("SELECT day, COUNT(*) AS n FROM verifications WHERE day >= ? GROUP BY day").bind(since).all();
  const dWeek = await env.DB.prepare("SELECT day, COUNT(*) AS n FROM downloads WHERE day >= ? GROUP BY day").bind(since).all();
  const v = {}, d = {};
  for (const r of vWeek.results || []) v[r.day] = r.n;
  for (const r of dWeek.results || []) d[r.day] = r.n;
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const day = dayString(i);
    lines.push(`${day}: ${v[day] || 0} verified · ${d[day] || 0} delivered`);
  }

  const text =
    "📊 <b>Stats</b>\n\n" +
    `👥 Users: <b>${total.n}</b> (${active.n} reachable, ${banned.n} banned)\n` +
    `🆕 Joined today: <b>${joined.n}</b>\n` +
    `✅ Verifications today: <b>${ver.n}</b> (${ver.u} people)\n` +
    `📥 Files delivered today: <b>${dl.n}</b> (${dl.u} people)\n` +
    `📁 Files posted: <b>${files.n}</b>\n` +
    `⭐ Active subscribers: <b>${subs.n}</b>\n\n` +
    "📅 <b>Last 7 days</b>\n" + lines.join("\n") +
    "\n\n<i>Days follow India time (IST).</i>";
  await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

// /status: is everything healthy?
async function sendStatus(env, chatId) {
  const lines = [];

  // Telegram connection
  const hook = await tg(env, "getWebhookInfo", {});
  if (hook.ok) {
    const h = hook.result;
    lines.push(`${h.url ? "✅" : "⚠️"} Webhook: ${h.url ? "set" : "NOT set"}, waiting updates: ${h.pending_update_count}`);
    if (h.last_error_message) {
      const when = h.last_error_date ? new Date(h.last_error_date * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
      lines.push(`⚠️ Last Telegram delivery error: ${esc(h.last_error_message)} ${when}`);
    }
  } else {
    lines.push(`⚠️ Can't reach Telegram: ${esc(hook.description || "unknown error")}`);
  }

  // Scheduled job
  const lc = parseInt((await getSetting(env, "last_cron")) || "0", 10);
  const age = lc ? Math.round((Date.now() - lc) / 60000) : null;
  lines.push(age === null ? "⚠️ Cleanup job: hasn't run yet"
    : age <= 3 ? `✅ Cleanup job: ran ${age} min ago`
    : `⚠️ Cleanup job: last ran ${age} min ago (check the cron trigger)`);

  // Queues
  const q = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(delete_at <= ?) AS due FROM deletions").bind(Date.now()).first();
  lines.push(`🗑 Deletions waiting: ${q.n} (${q.due || 0} due now)`);
  const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'running' LIMIT 1").first();
  if (job) lines.push(`📢 Broadcast running: ${job.sent + job.failed} of ${job.total} done`);

  // Shortlink
  if ((await getSetting(env, "shortlink_enabled")) === "1") {
    const test = await shortenUrl(env, "https://t.me/telegram");
    lines.push(test ? "✅ Shortlink: working" : "⚠️ Shortlink: NOT working (users skip verification)");
  } else {
    lines.push("➖ Shortlink: off");
  }
  const mins = parseInt((await getSetting(env, "delete_minutes")) || "0", 10);
  lines.push(`➖ Auto-delete: ${formatDelay(mins)}`);
  const upiId = await getSetting(env, "upi_id");
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'submitted'").first();
  lines.push(upiId ? `✅ Payments: UPI set, ${waiting.n} waiting for your approval` : "➖ Payments: UPI ID not set");

  // Channels: am I still an admin?
  const me = await tg(env, "getMe", {});
  const chans = await env.DB.prepare(
    "SELECT chat_id, title, GROUP_CONCAT(role) AS roles FROM channels GROUP BY chat_id ORDER BY title LIMIT 10"
  ).all();
  const rows = await Promise.all((chans.results || []).map(async (c) => {
    const r = me.ok ? await tg(env, "getChatMember", { chat_id: c.chat_id, user_id: me.result.id }) : null;
    let mark = "✅", note = "";
    if (!r || !r.ok || r.result.status !== "administrator") { mark = "⚠️"; note = " - I'm not an admin there"; }
    else if (r.result.can_post_messages === false && /lectures|pdfs/.test(c.roles)) { mark = "⚠️"; note = " - I can't post there"; }
    return `${mark} ${esc(c.title)} (${esc(c.roles)})${note}`;
  }));
  if (rows.length) lines.push("\n<b>Channels</b>\n" + rows.join("\n"));

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🩺 <b>Status</b>\n\n" + lines.join("\n"),
    parse_mode: "HTML",
  });
}

// ---------- Subscriptions (skip ads) ----------
const PLANS = {
  week: { name: "1 Week", price: 20, days: 7 },
  month: { name: "1 Month", price: 60, days: 30 },
  two: { name: "2 Months", price: 100, days: 60 },
  year: { name: "1 Year", price: 500, days: 365 },
};

let APP_ORIGIN = null; // this Worker's web address, learned from incoming requests

function fmtDate(ms) {
  return new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// Returns the expiry time if the user has an active plan, otherwise 0. Checked at every delivery.
async function getSubExpiry(env, userId) {
  const r = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  return r && r.expires_at > Date.now() ? r.expires_at : 0;
}

async function hasActiveSub(env, userId) {
  return (await getSubExpiry(env, userId)) > 0;
}

// Adds the plan's days on top of whatever time the user still has left
async function activateSubscription(env, userId, planKey) {
  const cur = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  const start = Math.max(Date.now(), cur ? cur.expires_at : 0);
  const expires = start + PLANS[planKey].days * 86400000;
  await env.DB.prepare("INSERT OR REPLACE INTO subscriptions (user_id, expires_at, plan) VALUES (?, ?, ?)")
    .bind(String(userId), expires, planKey).run();
  return expires;
}

// ---------- Mini App security: proves the request really comes from this Telegram user ----------
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

// Returns the Telegram user if the Mini App data is genuine and fresh (under 24 hours), otherwise null
async function verifyInitData(env, initData) {
  if (!initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacSha256("WebAppData", env.BOT_TOKEN);
  const sig = [...(await hmacSha256(secret, check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!safeEqual(sig, hash)) return null;
  if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 86400) return null;
  try {
    const user = JSON.parse(params.get("user"));
    return user && Number.isInteger(user.id) ? user : null;
  } catch (err) {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------- Mini App API ----------
async function handleApi(request, env, path) {
  if (request.method !== "POST") return json({ error: "Not allowed" }, 405);
  const user = await verifyInitData(env, request.headers.get("X-Init-Data") || "");
  if (!user) return json({ error: "auth" }, 401);
  const uid = String(user.id);

  const ban = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(uid).first();
  if (ban && ban.banned) return json({ error: "Your account can't use this." }, 403);

  let body = {};
  try { body = await request.json(); } catch (err) { /* empty body is fine */ }

  const upiId = await getSetting(env, "upi_id");

  if (path === "/api/me") {
    const until = await getSubExpiry(env, uid);
    const w = await env.DB.prepare(
      "SELECT id, plan, amount FROM payments WHERE user_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1"
    ).bind(uid).first();
    return json({
      premium_until: until ? fmtDate(until) : null,
      upi_ready: !!upiId,
      plans: Object.entries(PLANS).map(([key, p]) => ({ key, name: p.name, price: p.price, days: p.days })),
      waiting: w ? { plan_name: PLANS[w.plan].name, amount: w.amount } : null,
    });
  }

  if (path === "/api/pay") {
    if (!upiId) return json({ error: "Payments aren't set up yet." }, 400);
    const plan = PLANS[body.plan];
    if (!plan) return json({ error: "Unknown plan." }, 400);
    // The price always comes from the server, never from the app
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND created > ?")
      .bind(uid, Date.now() - 3600000).first();
    if (recent.n >= 8) return json({ error: "Too many attempts. Please try again in a while." }, 429);

    const ins = await env.DB.prepare(
      "INSERT INTO payments (user_id, plan, amount, status, created) VALUES (?, ?, ?, 'pending', ?)"
    ).bind(uid, body.plan, plan.price, Date.now()).run();
    const payee = (await getSetting(env, "upi_name")) || "Premium";
    const link = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}` +
      `&am=${plan.price}.00&cu=INR&tn=${encodeURIComponent("Premium " + plan.name)}`;
    return json({ id: ins.meta.last_row_id, plan: plan.name, amount: plan.price, upi_id: upiId, payee, link });
  }

  if (path === "/api/utr") {
    const utr = String(body.utr || "").trim();
    if (!/^[0-9]{12}$/.test(utr)) return json({ error: "The reference number (UTR) is 12 digits. Please check and try again." }, 400);
    const pay = await env.DB.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").bind(Number(body.id), uid).first();
    if (!pay || pay.status !== "pending") return json({ error: "This payment can't be updated." }, 400);
    try {
      const upd = await env.DB.prepare("UPDATE payments SET utr = ?, status = 'submitted' WHERE id = ? AND status = 'pending'")
        .bind(utr, pay.id).run();
      if (!upd.meta.changes) return json({ error: "This payment can't be updated." }, 400);
    } catch (err) {
      // The same reference number can't be used for two payments
      return json({ error: "This reference number was already used." }, 400);
    }
    const plan = PLANS[pay.plan];
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_ID,
      text: `💳 <b>Payment to approve</b>\n\nUser: <code>${esc(uid)}</code> ${esc(user.first_name || "")}\nPlan: ${esc(plan.name)} (₹${plan.price})\nUTR: <code>${esc(utr)}</code>\n\nCheck your bank or UPI app for ₹${plan.price} with this reference number before approving.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `pay:ok:${pay.id}` },
          { text: "❌ Reject", callback_data: `pay:no:${pay.id}` },
        ]],
      },
    });
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---------- /skipads and the payments settings ----------
async function sendSkipAds(env, chatId, userId) {
  if (!APP_ORIGIN) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Premium isn't available yet. Please try again later." });
    return;
  }
  const until = await getSubExpiry(env, userId);
  const plans = Object.values(PLANS).map((p) => `• ${p.name}: ₹${p.price}`).join("\n");
  const text = until
    ? `⭐ <b>Premium is active</b> until ${fmtDate(until)}.\n\nYou can add more time any time:\n${plans}`
    : `⭐ <b>Skip the ads</b>\n\nGet your files instantly, with no verification step.\n\n${plans}`;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⭐ Choose a plan", web_app: { url: `${APP_ORIGIN}/app` } }]] },
  });
}

async function buildPayMenu(env, note) {
  const upi = await getSetting(env, "upi_id");
  const name = await getSetting(env, "upi_name");
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'submitted'").first();
  let text = "💳 <b>Payments (UPI)</b>\n\n" +
    "Customers pay your UPI ID from the Mini App, then send their reference number (UTR). " +
    "You approve each payment after checking your bank or UPI app.\n\n" +
    `UPI ID: ${upi ? `<code>${esc(upi)}</code>` : "<i>not set</i>"}\n` +
    `Payee name: ${name ? esc(name) : "<i>not set (shows Premium)</i>"}\n` +
    `Waiting for approval: ${waiting.n}\n\n<b>Plans</b>\n` +
    Object.values(PLANS).map((p) => `${p.name}: ₹${p.price}`).join("\n");
  if (note) text += `\n\n${note}`;
  const buttons = [
    [{ text: "🆔 Set UPI ID", callback_data: "pay:upi" }],
    [{ text: "📝 Set Payee Name", callback_data: "pay:name" }],
    ...BACK_BUTTON,
  ];
  return { text, buttons };
}

// ---------- The Mini App page ----------
const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Skip Ads</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--text:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#707579);--accent:var(--tg-theme-button-color,#2481cc);--accent-text:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#f1f3f5)}
*{box-sizing:border-box}
body{margin:0;padding:16px 16px calc(28px + env(safe-area-inset-bottom,0px));background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
h1{font-size:22px;margin:4px 0}
.sub{color:var(--hint);margin:4px 0 14px;font-size:15px}
.card{background:var(--card);border-radius:14px;padding:14px;margin-bottom:12px}
.plan{display:flex;justify-content:space-between;align-items:center;width:100%;border:0;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.plan b{font-size:18px}
.btn{display:block;width:100%;padding:13px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;margin-top:10px}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.big{font-size:30px;font-weight:700;margin:2px 0}
.mono{font-family:ui-monospace,Menlo,monospace;word-break:break-all}
input{width:100%;padding:13px;border-radius:12px;border:1px solid var(--hint);background:var(--bg);color:var(--text);font:inherit;font-size:18px;letter-spacing:1px}
.err{color:#d93025;margin-top:8px;min-height:20px;font-size:14px}
ol{padding-left:20px;margin:6px 0 12px;color:var(--hint);font-size:15px}
</style></head>
<body><div id="root"></div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
var root = document.getElementById("root");

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
function api(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Init-Data": tg ? tg.initData : "" },
    body: JSON.stringify(body || {})
  }).then(function (r) { return r.json(); })
    .catch(function () { return { error: "Network problem. Please try again." }; });
}
function fail(text) {
  clear();
  root.appendChild(el("h1", null, "Something went wrong"));
  root.appendChild(el("p", "sub", text === "auth" ? "Please open this page from the bot's /skipads button." : text));
  var b = el("button", "btn", "Try again");
  b.onclick = load;
  root.appendChild(b);
}
function load() {
  clear();
  root.appendChild(el("p", "sub", "Loading..."));
  api("/api/me").then(function (me) {
    if (me.error) return fail(me.error);
    home(me);
  });
}
function home(me) {
  clear();
  root.appendChild(el("h1", null, "\\u2B50 Skip the ads"));
  root.appendChild(el("p", "sub", "Get your files instantly, with no verification step."));
  var st = el("div", "card");
  if (me.premium_until) {
    st.appendChild(el("b", null, "Premium active"));
    st.appendChild(el("div", "sub", "Until " + me.premium_until + ". Buying again adds time on top."));
  } else {
    st.appendChild(el("b", null, "No active plan"));
  }
  root.appendChild(st);
  if (me.waiting) {
    var w = el("div", "card");
    w.appendChild(el("b", null, "Payment waiting for approval"));
    w.appendChild(el("div", "sub", me.waiting.plan_name + " - Rs " + me.waiting.amount + ". You'll get a message in the bot as soon as it's approved."));
    var r = el("button", "btn ghost", "Refresh");
    r.onclick = load;
    w.appendChild(r);
    root.appendChild(w);
  }
  if (!me.upi_ready) {
    root.appendChild(el("p", "sub", "Payments aren't set up yet. Please try again later."));
    return;
  }
  me.plans.forEach(function (p) {
    var b = el("button", "card plan");
    b.appendChild(el("span", null, p.name));
    b.appendChild(el("b", null, "Rs " + p.price));
    b.onclick = function () { startPay(p); };
    root.appendChild(b);
  });
}
function startPay(p) {
  api("/api/pay", { plan: p.key }).then(function (d) {
    if (d.error) return fail(d.error);
    pay(d);
  });
}
function pay(d) {
  clear();
  root.appendChild(el("h1", null, d.plan));
  var c = el("div", "card");
  c.appendChild(el("div", "sub", "Pay exactly"));
  c.appendChild(el("div", "big", "Rs " + d.amount));
  c.appendChild(el("div", "sub", "to this UPI ID (" + d.payee + ")"));
  c.appendChild(el("div", "mono", d.upi_id));
  var copy = el("button", "btn ghost", "Copy UPI ID");
  copy.onclick = function () {
    if (navigator.clipboard) navigator.clipboard.writeText(d.upi_id);
    copy.textContent = "Copied";
  };
  c.appendChild(copy);
  var open = el("a", "btn", "Open UPI app");
  open.href = d.link;
  c.appendChild(open);
  root.appendChild(c);

  var steps = el("ol");
  ["Pay the amount above in any UPI app.", "Find the 12-digit reference number (UTR) in your payment details.", "Enter it below and submit."].forEach(function (t) {
    steps.appendChild(el("li", null, t));
  });
  root.appendChild(steps);

  var input = el("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 12;
  input.placeholder = "12-digit UTR number";
  root.appendChild(input);
  var err = el("div", "err");
  root.appendChild(err);
  var go = el("button", "btn", "I've paid - submit");
  go.onclick = function () {
    go.disabled = true;
    err.textContent = "";
    api("/api/utr", { id: d.id, utr: input.value }).then(function (res) {
      go.disabled = false;
      if (res.error) { err.textContent = res.error; return; }
      done();
    });
  };
  root.appendChild(go);
  var back = el("button", "btn ghost", "Back");
  back.onclick = load;
  root.appendChild(back);
}
function done() {
  clear();
  root.appendChild(el("h1", null, "Thank you!"));
  root.appendChild(el("p", "sub", "Your payment is being checked. You'll get a message in the bot as soon as Premium is active."));
  var b = el("button", "btn", "Close");
  b.onclick = function () { if (tg) tg.close(); else load(); };
  root.appendChild(b);
}
load();
</script></body></html>`;

// ---------- Handling messages ----------
async function handleMessage(msg, env) {
  // Files posted in a Source group (anything that isn't a private chat with the bot)
  if (msg.chat.type !== "private") {
    await handleChannelPost(msg, env);
    return;
  }
  if (!msg.from) return;

  const text = msg.text || "";
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const isOwner = userId === String(env.OWNER_ID);

  const banned = await recordUser(env, msg.from);
  if (!isOwner) {
    if (banned) return;
    if (await isRateLimited(env, userId, chatId)) return;
  }

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
      // Back too fast = they skipped the shortlink. Keep the token so they can still do it properly.
      if (Date.now() - t.created < MIN_VERIFY_SECONDS * 1000) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Verification not completed. Please finish the steps on the link first, then come back.",
        });
        return;
      }
      // The token works once, even if two taps arrive together
      const used = await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(tok[1]).run();
      if (!used.meta.changes) return;
      await env.DB.prepare("INSERT INTO verifications (user_id, file_row_id, day) VALUES (?, ?, ?)")
        .bind(userId, t.file_row_id, dayString(0)).run();
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

  if (/^\/(skipads|premium)(\s|@|$)/.test(text)) {
    await sendSkipAds(env, chatId, userId);
    return;
  }

  if (!isOwner) return;

  if (/^\/grant(\s|$)/.test(text)) {
    const [, target, planKey] = text.split(/\s+/);
    if (!/^\d{5,15}$/.test(target || "") || !PLANS[planKey]) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Use it like this: /grant 123456789 month\nPlans: week, month, two, year" });
      return;
    }
    const exp = await activateSubscription(env, target, planKey);
    await tg(env, "sendMessage", { chat_id: chatId, text: `✅ Premium for ${target} until ${fmtDate(exp)}.` });
    await tg(env, "sendMessage", { chat_id: target, text: `⭐ Premium activated until ${fmtDate(exp)}. Enjoy ad-free downloads!` });
    return;
  }

  if (/^\/revoke(\s|$)/.test(text)) {
    const target = text.split(/\s+/)[1] || "";
    const r = await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(target).run();
    await tg(env, "sendMessage", { chat_id: chatId, text: r.meta.changes ? `Premium removed for ${target}.` : "That user has no premium plan." });
    return;
  }

  if (text.startsWith("/status")) {
    await clearState(env, userId);
    await sendStatus(env, chatId);
    return;
  }

  if (/^\/(ban|unban)(\s|$)/.test(text)) {
    const unban = text.startsWith("/unban");
    const target = text.split(/\s+/)[1] || "";
    if (!/^\d{5,15}$/.test(target)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Use it like this: /ban 123456789 (or /unban 123456789)" });
      return;
    }
    if (target === String(env.OWNER_ID)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "You can't ban yourself." });
      return;
    }
    await env.DB.prepare(
      "INSERT INTO users (user_id, first_name, joined_day, last_seen, banned, active) VALUES (?, '', ?, 0, ?, 0) " +
      "ON CONFLICT(user_id) DO UPDATE SET banned = excluded.banned"
    ).bind(target, dayString(0), unban ? 0 : 1).run();
    await tg(env, "sendMessage", { chat_id: chatId, text: `${unban ? "✅ Unbanned" : "🚫 Banned"} user ${target}.` });
    return;
  }

  if (text.startsWith("/stopbroadcast")) {
    const r = await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE status = 'running'").run();
    await tg(env, "sendMessage", { chat_id: chatId, text: r.meta.changes ? "🛑 Broadcast stopped." : "No broadcast is running." });
    return;
  }

  if (text.startsWith("/stats")) {
    await clearState(env, userId);
    await sendStats(env, chatId);
    return;
  }

  if (text.startsWith("/post")) {
    await setState(env, userId, "post");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "📣 Send the message you want to post (text, photo, video, file, anything). I'll ask you to confirm before it goes out.\n\nIt will be posted as it is to your Lectures, PDFs, and ForceSub channels.\n\n/cancel to stop.",
    });
    return;
  }

  if (text.startsWith("/broadcast")) {
    await setState(env, userId, "broadcast");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "📢 Send the message you want to broadcast to all bot users (text, photo, video, file, anything). I'll ask you to confirm first.\n\n/cancel to stop.",
    });
    return;
  }

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
  if (state === "post" || state === "broadcast") {
    await askConfirm(env, msg, state);
    return;
  }
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
  if (!query.message || !query.data) {
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = String(query.from.id);
  const parts = query.data.split(":");
  const action = parts[0];

  // "I've Joined" button - anyone can use this one
  if (action === "chk") {
    if (userId !== String(env.OWNER_ID)) {
      const b = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(userId).first();
      if ((b && b.banned) || (await isRateLimited(env, userId, chatId))) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
        return;
      }
    }
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

  // /broadcast confirm: pst:broadcast:<msgid>, pst:no
  if (action === "pst") {
    const edit = (text) => tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    });
    if (parts[1] === "no") {
      await edit("Cancelled.");
      return;
    }
    if (parts[1] === "broadcast") {
      const srcMsg = Number(parts[2]);
      const running = await env.DB.prepare("SELECT 1 AS x FROM broadcasts WHERE status = 'running' LIMIT 1").first();
      if (running) {
        await edit("⚠️ A broadcast is already running. Please wait for it to finish, or send /stopbroadcast.");
        return;
      }
      const total = await countBroadcastUsers(env);
      await env.DB.prepare(
        "INSERT INTO broadcasts (from_chat, message_id, owner_chat, total) VALUES (?, ?, ?, ?)"
      ).bind(String(chatId), srcMsg, String(chatId), total).run();
      await edit(`📢 Broadcast started for <b>${total}</b> users. I'll message you when it's finished. (/stopbroadcast cancels it.)`);
      await processBroadcast(env, 35);
    }
    return;
  }

  // /post channel picker: pk:t:<index>, pk:go, pk:no
  if (action === "pk") {
    const edit = (text, markup) => tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: markup,
    });
    if (parts[1] === "no") {
      await clearState(env, userId);
      await edit("Cancelled.");
      return;
    }
    const st = (await getState(env, userId)) || "";
    const m = st.match(/^pick:(\d+):(\d+)$/);
    if (!m) {
      await edit("This /post session has expired. Send /post again.");
      return;
    }
    const srcMsg = Number(m[1]);
    let mask = Number(m[2]);
    const targets = await getPostTargets(env);

    if (parts[1] === "t") {
      mask ^= 1 << Number(parts[2]);
      await setState(env, userId, `pick:${srcMsg}:${mask}`);
      const view = renderPicker(targets, mask);
      await edit(view.text, { inline_keyboard: view.buttons });
      return;
    }

    if (parts[1] === "go") {
      const chosen = targets.filter((c, i) => mask & (1 << i));
      if (!chosen.length) {
        const view = renderPicker(targets, mask, "⚠️ Choose at least one channel.");
        await edit(view.text, { inline_keyboard: view.buttons });
        return;
      }
      let ok = 0;
      const failed = [];
      for (const c of chosen) {
        const r = await tg(env, "copyMessage", { chat_id: c.chat_id, from_chat_id: chatId, message_id: srcMsg });
        if (r.ok) ok++; else failed.push(c.title);
      }
      await clearState(env, userId);
      let text = `✅ Posted to ${ok} of ${chosen.length} channel(s).`;
      if (failed.length) {
        text += `\n\n⚠️ Failed: ${failed.map(esc).join(", ")}\nCheck that I'm an admin there with the Post Messages permission.`;
      }
      await edit(text);
    }
    return;
  }

  // Cover images: cov:menu, cov:set:<pdf|lecture>, cov:rm:<pdf|lecture>
  if (action === "cov") {
    const sub = parts[1];
    const kind = parts[2];
    const validKind = kind === "pdf" || kind === "lecture";
    if (sub === "set" && validKind) {
      await setState(env, userId, `set:cover_${kind}`);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `🖼️ Send the photo to use as the <b>${kind === "pdf" ? "PDF" : "Lecture"} cover</b>. It will be shown on every new post.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "cov:menu" }]] },
      });
      return;
    }
    if (sub === "rm" && validKind) {
      await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`cover_${kind}`).run();
    }
    await clearState(env, userId);
    await showCoverMenu(env, chatId, messageId);
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

  // Payments: pay:menu, pay:upi, pay:name, pay:ok:<id>, pay:no:<id>
  if (action === "pay") {
    const sub = parts[1];
    if (sub === "upi" || sub === "name") {
      await setState(env, userId, `set:upi_${sub === "upi" ? "id" : "name"}`);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: sub === "upi"
          ? "💳 Send your UPI ID, like <code>name@bank</code>. Customers will pay to this ID."
          : "💳 Send the name to show on payments, like <code>My Classes</code>.",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "pay:menu" }]] },
      });
      return;
    }
    if (sub === "ok" || sub === "no") {
      const id = Number(parts[2]);
      const pay = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
      const edit = (text) => tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
      if (!pay) { await edit("Payment not found."); return; }
      const approve = sub === "ok";
      // Only a payment that is still waiting can be decided, and only once
      const upd = await env.DB.prepare("UPDATE payments SET status = ?, decided = ? WHERE id = ? AND status = 'submitted'")
        .bind(approve ? "approved" : "rejected", Date.now(), id).run();
      if (!upd.meta.changes) { await edit(`This payment was already ${esc(pay.status)}.`); return; }
      const plan = PLANS[pay.plan];
      if (approve) {
        const exp = await activateSubscription(env, pay.user_id, pay.plan);
        await tg(env, "sendMessage", { chat_id: pay.user_id, text: `✅ Payment approved! Premium is active until ${fmtDate(exp)}. Enjoy ad-free downloads.` });
        await edit(`✅ Approved: user ${esc(pay.user_id)}, ${esc(plan.name)} (₹${plan.price}). Premium until ${fmtDate(exp)}.`);
      } else {
        await tg(env, "sendMessage", { chat_id: pay.user_id, text: "❌ We couldn't confirm your payment. If you paid, please contact the admin with your payment screenshot." });
        await edit(`❌ Rejected: user ${esc(pay.user_id)}, ${esc(plan.name)} (₹${plan.price}).`);
      }
      return;
    }
    await clearState(env, userId);
    const pm = await buildPayMenu(env);
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId, text: pm.text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: pm.buttons },
    });
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

  // In a group, only admins (or you) may add files
  if (post.chat.type !== "channel" && !(await isTrustedSender(env, post))) return;

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

  const postText = `${emoji} <b>${esc(title.slice(0, 300))}</b>\n\n🏷 Type: ${label}\n📦 Size: ${formatSize(info.file.file_size)}`;
  const markup = {
    inline_keyboard: [[
      { text: "📥 Get File", url: `https://t.me/${me.result.username}?start=f${rowId}` },
    ]],
  };

  // Cover: your saved cover first, otherwise the file's own thumbnail
  const thumb = info.file.thumbnail || info.file.thumb;
  const cover = (await getSetting(env, info.kind === "pdf" ? "cover_pdf" : "cover_lecture")) ||
    (thumb ? thumb.file_id : null);

  if (cover) {
    const sent = await tg(env, "sendPhoto", {
      chat_id: dest[0].chat_id,
      photo: cover,
      caption: postText,
      parse_mode: "HTML",
      reply_markup: markup,
    });
    if (sent.ok) return;
    console.log("Cover failed, posting without it:", JSON.stringify(sent));
  }
  const posted = await tg(env, "sendMessage", {
    chat_id: dest[0].chat_id,
    text: postText,
    parse_mode: "HTML",
    reply_markup: markup,
  });
  if (!posted.ok) {
    // Allow this file to be posted again later, and tell the owner why it failed
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(rowId).run();
    await alertOwner(env, `post${dest[0].chat_id}`,
      `I couldn't post "${title}" to "${dest[0].title}": ${posted.description}. Check that I'm an admin there with the Post Messages permission, then upload the file again.`);
  }
}

// ---------- Entry point ----------
// Compares two texts without leaking how many characters matched
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  // Cron Trigger: runs every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    APP_ORIGIN = url.origin;

    // Mini App page and its API
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(APP_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        console.log("API error:", String(err).split(env.BOT_TOKEN).join("***"));
        return json({ error: "Server problem. Please try again." }, 500);
      }
    }

    if (request.method !== "POST") {
      return new Response("Autoposter bot is running ✅");
    }
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!safeEqual(secret, env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response("Bad request", { status: 400 });
    }

    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleButton(update.callback_query, env);
      if (update.channel_post) await handleChannelPost(update.channel_post, env);
    } catch (err) {
      const detail = String(err && err.stack ? err.stack : err).split(env.BOT_TOKEN).join("***");
      console.log("Error:", detail);
      await alertOwner(env, "error", `Something went wrong in the bot: ${detail.slice(0, 300)}`);
    }
    return new Response("OK");
  },
};
