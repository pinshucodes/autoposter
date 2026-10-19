// Autoposter Bot - Step 3: auto-posting files from Source channels
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
};

// ---------- Database helpers ----------
async function getChannels(env, role) {
  const r = await env.DB.prepare("SELECT chat_id, title FROM channels WHERE role = ?").bind(role).all();
  return r.results || [];
}

async function addChannel(env, role, chatId, title) {
  const steps = [];
  if (!ROLES[role].multi) {
    steps.push(env.DB.prepare("DELETE FROM channels WHERE role = ?").bind(role));
  }
  steps.push(
    env.DB.prepare("INSERT OR REPLACE INTO channels (role, chat_id, title) VALUES (?, ?, ?)")
      .bind(role, String(chatId), title)
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
  await tg(env, asVideo ? "sendVideo" : "sendDocument", {
    chat_id: chatId,
    [asVideo ? "video" : "document"]: row.file_id,
    caption: row.title,
  });
}

// ---------- Menus ----------
const MAIN_MENU = {
  text: "⚙️ <b>Settings</b>\n\nSelect what you want to configure:",
  buttons: [
    [{ text: "📥 Source Channels", callback_data: "role:source" }],
    [{ text: "🎓 Lectures Channel", callback_data: "role:lectures" }],
    [{ text: "📄 PDFs Channel", callback_data: "role:pdfs" }],
    [{ text: "🔐 ForceSub Settings", callback_data: "forcesub" }],
    [{ text: "🔗 Shortlink Settings", callback_data: "shortlink" }],
    [{ text: "🗑️ File Delete Settings", callback_data: "delete" }],
    [{ text: "❌ Close", callback_data: "close" }],
  ],
};

// Placeholders for settings we build in later steps
const SUB_MENUS = {
  forcesub: "🔐 <b>ForceSub Settings</b>\n\nComing in a later step.",
  shortlink: "🔗 <b>Shortlink Settings</b>\n\nComing in a later step.",
  delete: "🗑️ <b>File Delete Settings</b>\n\nComing in a later step.",
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
  if (role !== "source" && member.result.can_post_messages === false) {
    return { error: "I'm an admin there, but I need the <b>Post Messages</b> permission. Turn it on and send again." };
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
    // Links from channel posts look like /start f12
    const match = text.match(/^\/start f(\d+)/);
    if (match) {
      const row = await getFileRow(env, Number(match[1]));
      if (!row) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
      } else {
        await sendFileToUser(env, chatId, row);
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
    await addChannel(env, role, result.id, result.title);
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
