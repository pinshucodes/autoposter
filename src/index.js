// Autoposter Bot - Multi-Quality Movie Grouping + Deep MediaInfo + Anti-Copyright Shield
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
    const text = String(err).split(env.BOT_TOKEN).join("***");
    return { ok: false, error_code: 0, description: text };
  }
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

// ---------- Auto-create new table for Multi-Quality Grouped Posts ----------
let SCHEMA_READY = false;
async function ensureExtraTables(env) {
  if (SCHEMA_READY) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS media_posts (" +
      "group_key TEXT PRIMARY KEY, " +
      "chat_id TEXT, " +
      "message_id INTEGER, " +
      "has_photo INTEGER, " +
      "meta_json TEXT, " +
      "items_json TEXT, " +
      "updated INTEGER)"
    ).run();
    SCHEMA_READY = true;
  } catch (err) {
    console.log("Table init note:", err);
  }
}

// ---------- Channel settings we manage ----------
const ROLES = {
  source: {
    emoji: "📥", name: "Source Channels", multi: true,
    help: "Channels or groups where you upload your files. I watch these for new files. (For a group, make me an admin so I can see the files. Only group admins can add files.)",
  },
  lectures: {
    emoji: "🎬", name: "Movies / Videos Channel", multi: false,
    help: "The main channel where video/movie posts will be published and auto-updated with new qualities.",
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
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO files (file_id, file_unique_id, kind, send_as, title, size) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(f.file_id, f.file_unique_id, f.kind, f.send_as, f.title, f.size).run();
  if (r.meta.changes > 0) return r.meta.last_row_id;
  const ex = await env.DB.prepare("SELECT id FROM files WHERE file_unique_id = ?").bind(f.file_unique_id).first();
  return ex ? ex.id : null;
}

async function getFileRow(env, id) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
}

function formatSize(bytes) {
  if (!bytes) return "Unknown";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(0) + " MB";
}

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
    if (mime.startsWith("video/") || /\.(mkv|mp4|avi|mov|webm|flv|m4v|ts)$/i.test(name)) {
      return { kind: "lecture", send_as: "document", file: d, name };
    }
  }
  return null;
}

function makeTitle(post, name) {
  const caption = (post.caption || "").split("\n")[0].trim();
  if (caption) return caption;
  const cleaned = name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim();
  return cleaned || "Untitled";
}

// Cache bot username so we don't call getMe repeatedly
let CACHED_BOT_USERNAME = null;
async function getBotUsername(env) {
  if (CACHED_BOT_USERNAME) return CACHED_BOT_USERNAME;
  const me = await tg(env, "getMe", {});
  if (me.ok && me.result.username) {
    CACHED_BOT_USERNAME = me.result.username;
    await setSetting(env, "bot_username", CACHED_BOT_USERNAME);
    return CACHED_BOT_USERNAME;
  }
  return (await getSetting(env, "bot_username")) || "";
}

// Generates a copyright-safe link that routes through your Worker if enabled
async function makeDeepLink(env, startParam) {
  const shieldOn = (await getSetting(env, "shield_redirect")) !== "0"; // ON by default
  if (shieldOn && APP_ORIGIN) {
    return `${APP_ORIGIN}/get/${startParam}`;
  }
  const username = await getBotUsername(env);
  return `https://t.me/${username}?start=${startParam}`;
}

async function sendFileToUser(env, chatId, row) {
  const asVideo = row.send_as === "video";
  const protect = (await getSetting(env, "protect_files")) === "1";
  const sent = await tg(env, asVideo ? "sendVideo" : "sendDocument", {
    chat_id: chatId,
    [asVideo ? "video" : "document"]: row.file_id,
    caption: `🎬 <b>${esc(row.title)}</b>`,
    parse_mode: "HTML",
    protect_content: protect,
  });

  if (!sent.ok) {
    console.log("Send file failed:", sent.error_code, sent.description);
    if (sent.error_code !== 403) {
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

  // Auto-delete: default to 10 minutes if not set so copyright bots can't scan chat history
  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 10 : parseInt(rawMins, 10);
  if (!mins) return true;

  const notice = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `⏳ <b>Auto-Delete Notice:</b> Due to copyright protection, this file will be deleted here in <b>${formatDelay(mins)}</b>.${protect ? "" : " Please forward or save it immediately."}`,
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

// Runs every minute (Cron Trigger)
async function runDeletions(env, limit) {
  const due = await env.DB.prepare(
    "SELECT id, chat_id, message_id, attempts FROM deletions WHERE delete_at <= ? ORDER BY delete_at LIMIT ?"
  ).bind(Date.now(), limit).all();

  for (const d of due.results || []) {
    const r = await tg(env, "deleteMessage", { chat_id: d.chat_id, message_id: d.message_id });
    const finalAnswer = r.ok || r.error_code === 400 || r.error_code === 403;
    if (finalAnswer || d.attempts >= 8) {
      await env.DB.prepare("DELETE FROM deletions WHERE id = ?").bind(d.id).run();
    } else {
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

async function sendVerifyLink(env, chatId, userId, row) {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("DELETE FROM tokens WHERE created < ?").bind(Date.now() - 24 * 3600 * 1000).run();
  await env.DB.prepare("INSERT INTO tokens (token, user_id, file_row_id, created) VALUES (?, ?, ?, ?)")
    .bind(token, String(userId), row.id, Date.now()).run();

  const username = await getBotUsername(env);
  const short = await shortenUrl(env, `https://t.me/${username}?start=v${token}`);
  if (!short) {
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
async function getMissingChannels(env, userId) {
  const channels = await getChannels(env, "forcesub");
  const checks = await Promise.all(channels.map(async (c) => {
    const r = await tg(env, "getChatMember", { chat_id: c.chat_id, user_id: userId });
    if (!r.ok) {
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return c;
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
    [{ text: "🎬 Movies / Videos Channel", callback_data: "role:lectures" }],
    [{ text: "📄 PDFs Channel", callback_data: "role:pdfs" }],
    [{ text: "🔐 ForceSub Settings", callback_data: "role:forcesub" }],
    [{ text: "🎬 IMDb, TMDb, Grouping & Shield", callback_data: "meta:menu" }],
    [{ text: "🔗 Shortlink Settings", callback_data: "sl:menu" }],
    [{ text: "🗑️ File Delete Settings", callback_data: "del:menu" }],
    [{ text: "🖼️ Cover Images", callback_data: "cov:menu" }],
    [{ text: "💳 Payments", callback_data: "pay:menu" }],
    [{ text: "❌ Close", callback_data: "close" }],
  ],
};

const SUB_MENUS = {};
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
    "A cover is the picture shown on each channel post. If none is set, I automatically use the official TMDb/IMDb poster or the file's thumbnail.\n\n" +
    `📄 PDF cover: ${pdf ? "✅ Set" : "❌ Not set"}\n` +
    `🎬 Video/Movie fallback cover: ${lec ? "✅ Set" : "❌ Not set (uses TMDb/IMDb poster)"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: pdf ? "📄 Change PDF Cover" : "📄 Set PDF Cover", callback_data: "cov:set:pdf" }],
    [{ text: lec ? "🎬 Change Video Cover" : "🎬 Set Video Cover", callback_data: "cov:set:lecture" }],
  ];
  if (pdf) buttons.push([{ text: "🗑 Remove PDF Cover", callback_data: "cov:rm:pdf" }]);
  if (lec) buttons.push([{ text: "🗑 Remove Video Cover", callback_data: "cov:rm:lecture" }]);
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
  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 10 : parseInt(rawMins, 10);
  let text = "🗑️ <b>File Delete Settings (Anti-Copyright)</b>\n\n" +
    "Files sent by the bot are automatically deleted from the user's private chat after the time you choose. " +
    "Keeping this around 5–15 minutes strongly protects your bot from copyright strikes.\n\n" +
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

// ---------- IMDb, TMDb, Multi-Quality & Anti-Copyright Menu ----------
async function buildMetaMenu(env, note) {
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  const miOn = (await getSetting(env, "mediainfo_enabled")) !== "0"; // ON by default
  const groupOn = (await getSetting(env, "group_qualities")) !== "0"; // ON by default
  const shieldOn = (await getSetting(env, "shield_redirect")) !== "0"; // ON by default
  const protectOn = (await getSetting(env, "protect_files")) === "1"; // OFF by default
  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");

  let text = "🎬 <b>IMDb, TMDb, Multi-Quality & Copyright Shield</b>\n\n" +
    "• <b>Combine Qualities:</b> Merges 480p, 720p, 1080p, 4K uploads of the same movie into ONE post with multiple buttons.\n" +
    "• <b>MediaInfo:</b> Extracts audio languages, subtitles, codecs, resolution & bitrate.\n" +
    "• <b>Redirect Shield:</b> Uses your Worker link on channel buttons instead of a direct bot link—protects the channel & lets you swap bots if banned.\n" +
    "• <b>Forward Lock:</b> Blocks users from forwarding files out of the bot.\n\n" +
    `🎬 IMDb/TMDb Info: ${metaOn ? "✅ ON" : "❌ OFF"}\n` +
    `🗂 Combine Qualities (1 Post): ${groupOn ? "✅ ON" : "❌ OFF"}\n` +
    `📊 Deep MediaInfo (Audio/Subs): ${miOn ? "✅ ON" : "❌ OFF"}\n` +
    `🛡️ Worker Redirect Shield: ${shieldOn ? "✅ ON" : "❌ OFF"}\n` +
    `🔒 Lock File Forwarding: ${protectOn ? "✅ ON" : "❌ OFF"}\n\n` +
    `TMDb Key: ${tmdbKey ? "<code>" + esc(tmdbKey.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}\n` +
    `OMDb (IMDb) Key: ${omdbKey ? "<code>" + esc(omdbKey.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: metaOn ? "🎬 IMDb/TMDb: ON" : "🎬 IMDb/TMDb: OFF (Tap to ON)", callback_data: "meta:toggle" }],
    [{ text: groupOn ? "🗂 Combine Qualities: ON" : "🗂 Combine Qualities: OFF", callback_data: "meta:grouptoggle" }],
    [{ text: miOn ? "📊 MediaInfo (Audio/Subs): ON" : "📊 MediaInfo: OFF", callback_data: "meta:mitoggle" }],
    [
      { text: shieldOn ? "🛡️ Link Shield: ON" : "🛡️ Link Shield: OFF", callback_data: "meta:shieldtoggle" },
      { text: protectOn ? "🔒 Forward Lock: ON" : "🔓 Forward Lock: OFF", callback_data: "meta:prottoggle" },
    ],
    [
      { text: "🔑 Set TMDb Key", callback_data: "meta:tmdb" },
      { text: "🔑 Set OMDb Key", callback_data: "meta:omdb" },
    ],
    ...BACK_BUTTON,
  ];
  return { text, buttons };
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

// Owner typed a new setting value
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

  if (field === "stars_prices") {
    const nums = (msg.text || "").trim().split(/[\s,]+/).map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100000)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Please send 4 whole numbers in this order: week, month, 2 months, year. Example: 12 35 58 290\n\n/cancel to stop.",
      });
      return;
    }
    const keys = Object.keys(PLANS);
    for (let k = 0; k < keys.length; k++) await setSetting(env, `stars_${keys[k]}`, String(nums[k]));
    await clearState(env, userId);
    const smenu = await buildPayMenu(env, "✅ Star prices saved.");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: smenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: smenu.buttons },
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
  if (field === "tmdb_key" || field === "omdb_key") {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    await setSetting(env, field, value);
    await setSetting(env, "meta_enabled", "1"); // Auto-enable once key is added
    await clearState(env, userId);
    const mmenu = await buildMetaMenu(env, "✅ API key saved & IMDb/TMDb enabled!");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: mmenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: mmenu.buttons },
    });
    return;
  }
  if (field === "shortlink_domain") {
    value = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  }
  if (field === "shortlink_key") {
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
const TZ_OFFSET_MIN = 330;
const MIN_VERIFY_SECONDS = 8;
const RATE_MAX = 8;
const RATE_WINDOW_MS = 10000;

function dayString(daysAgo) {
  const t = Date.now() + TZ_OFFSET_MIN * 60000 - daysAgo * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

async function recordUser(env, from) {
  const r = await env.DB.prepare(
    "INSERT INTO users (user_id, first_name, joined_day, last_seen, active) VALUES (?, ?, ?, ?, 1) " +
    "ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, last_seen = excluded.last_seen, active = 1 " +
    "RETURNING banned"
  ).bind(String(from.id), from.first_name || "", dayString(0), Date.now()).first();
  return !!(r && r.banned);
}

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

async function isTrustedSender(env, post) {
  if (post.sender_chat && post.sender_chat.id === post.chat.id) return true;
  if (!post.from) return false;
  if (String(post.from.id) === String(env.OWNER_ID)) return true;
  const r = await tg(env, "getChatMember", { chat_id: post.chat.id, user_id: post.from.id });
  return r.ok && (r.result.status === "creator" || r.result.status === "administrator");
}

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

async function processBroadcast(env, limit) {
  const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;

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
    if (!r.ok && r.error_code === 429) {
      backoff = ((r.parameters && r.parameters.retry_after) || 5) * 1000;
      break;
    }
    if (r.ok) {
      sent++;
    } else {
      failed++;
      if (r.error_code === 403) {
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
    `📁 Total files indexed: <b>${files.n}</b>\n` +
    `⭐ Active subscribers: <b>${subs.n}</b>\n\n` +
    "📅 <b>Last 7 days</b>\n" + lines.join("\n") +
    "\n\n<i>Days follow India time (IST).</i>";
  await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

async function sendStatus(env, chatId) {
  const lines = [];

  const hook = await tg(env, "getWebhookInfo", {});
  if (hook.ok) {
    const h = hook.result;
    lines.push(`${h.url ? "✅" : "⚠️"} Webhook: ${h.url ? "set" : "NOT set"}, waiting updates: ${h.pending_update_count}`);
    if (h.allowed_updates && !h.allowed_updates.includes("pre_checkout_query")) {
      lines.push("⚠️ Webhook is not receiving payment updates. Re-run the setWebhook link with pre_checkout_query added, or Stars payments will fail.");
    }
    if (h.last_error_message) {
      const when = h.last_error_date ? new Date(h.last_error_date * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
      lines.push(`⚠️ Last Telegram delivery error: ${esc(h.last_error_message)} ${when}`);
    }
  } else {
    lines.push(`⚠️ Can't reach Telegram: ${esc(hook.description || "unknown error")}`);
  }

  const lc = parseInt((await getSetting(env, "last_cron")) || "0", 10);
  const age = lc ? Math.round((Date.now() - lc) / 60000) : null;
  lines.push(age === null ? "⚠️ Cleanup job: hasn't run yet"
    : age <= 3 ? `✅ Cleanup job: ran ${age} min ago`
    : `⚠️ Cleanup job: last ran ${age} min ago (check the cron trigger)`);

  const q = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(delete_at <= ?) AS due FROM deletions").bind(Date.now()).first();
  lines.push(`🗑 Deletions waiting: ${q.n} (${q.due || 0} due now)`);
  const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'running' LIMIT 1").first();
  if (job) lines.push(`📢 Broadcast running: ${job.sent + job.failed} of ${job.total} done`);

  if ((await getSetting(env, "shortlink_enabled")) === "1") {
    const test = await shortenUrl(env, "https://t.me/telegram");
    lines.push(test ? "✅ Shortlink: working" : "⚠️ Shortlink: NOT working (users skip verification)");
  } else {
    lines.push("➖ Shortlink: off");
  }
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  lines.push(metaOn ? "✅ IMDb/TMDb: on" : "➖ IMDb/TMDb: off");
  const groupOn = (await getSetting(env, "group_qualities")) !== "0";
  lines.push(groupOn ? "✅ Multi-Quality Grouping: on" : "➖ Multi-Quality Grouping: off");
  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 10 : parseInt(rawMins, 10);
  lines.push(`🛡️ Auto-delete: ${formatDelay(mins)}`);

  const upiId = await getSetting(env, "upi_id");
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'submitted'").first();
  lines.push(upiId ? `✅ Payments: UPI set, ${waiting.n} waiting for your approval` : "➖ Payments: UPI ID not set");
  lines.push((await starsEnabled(env)) ? "✅ Payments: Stars on" : "➖ Payments: Stars off");

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

const STAR_DEFAULTS = { week: 12, month: 35, two: 58, year: 290 };

async function getStarPrices(env) {
  const out = {};
  for (const key of Object.keys(PLANS)) {
    const v = parseInt((await getSetting(env, `stars_${key}`)) || "", 10);
    out[key] = v > 0 ? v : STAR_DEFAULTS[key];
  }
  return out;
}

async function starsEnabled(env) {
  return (await getSetting(env, "stars_off")) !== "1";
}

let APP_ORIGIN = null;

function fmtDate(ms) {
  return new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

async function getSubExpiry(env, userId) {
  const r = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  return r && r.expires_at > Date.now() ? r.expires_at : 0;
}

async function hasActiveSub(env, userId) {
  return (await getSubExpiry(env, userId)) > 0;
}

async function activateSubscription(env, userId, planKey) {
  const cur = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  const start = Math.max(Date.now(), cur ? cur.expires_at : 0);
  const expires = start + PLANS[planKey].days * 86400000;
  await env.DB.prepare("INSERT OR REPLACE INTO subscriptions (user_id, expires_at, plan) VALUES (?, ?, ?)")
    .bind(String(userId), expires, planKey).run();
  return expires;
}

// ---------- Mini App security ----------
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

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
    const starPrices = await getStarPrices(env);
    return json({
      premium_until: until ? fmtDate(until) : null,
      upi_ready: !!upiId,
      stars_ready: await starsEnabled(env),
      plans: Object.entries(PLANS).map(([key, p]) => ({ key, name: p.name, price: p.price, days: p.days, stars: starPrices[key] })),
      waiting: w ? { plan_name: PLANS[w.plan].name, amount: w.amount } : null,
    });
  }

  if (path === "/api/pay") {
    if (!upiId) return json({ error: "Payments aren't set up yet." }, 400);
    const plan = PLANS[body.plan];
    if (!plan) return json({ error: "Unknown plan." }, 400);
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

  if (path === "/api/stars") {
    if (!(await starsEnabled(env))) return json({ error: "Stars payments aren't available right now." }, 400);
    const plan = PLANS[body.plan];
    if (!plan) return json({ error: "Unknown plan." }, 400);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND created > ?")
      .bind(uid, Date.now() - 3600000).first();
    if (recent.n >= 8) return json({ error: "Too many attempts. Please try again in a while." }, 429);

    const stars = (await getStarPrices(env))[body.plan];
    const ins = await env.DB.prepare(
      "INSERT INTO payments (user_id, plan, amount, status, method, created) VALUES (?, ?, ?, 'pending', 'stars', ?)"
    ).bind(uid, body.plan, stars, Date.now()).run();
    const inv = await tg(env, "createInvoiceLink", {
      title: `Premium - ${plan.name}`,
      description: `Skip the ads for ${plan.name}. Active right after payment.`,
      payload: `pay:${ins.meta.last_row_id}`,
      currency: "XTR",
      prices: [{ label: plan.name, amount: stars }],
    });
    if (!inv.ok) {
      console.log("Invoice failed:", inv.description);
      return json({ error: "Couldn't start the payment. Please try again." }, 500);
    }
    return json({ link: inv.result, stars });
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

// ---------- Telegram Stars ----------
async function handlePreCheckout(q, env) {
  let ok = false;
  try {
    const m = /^pay:(\d+)$/.exec(q.invoice_payload || "");
    const pay = m ? await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(Number(m[1])).first() : null;
    const ban = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(String(q.from.id)).first();
    ok = !!pay && pay.method === "stars" && pay.status === "pending" &&
      pay.user_id === String(q.from.id) && q.currency === "XTR" && q.total_amount === pay.amount &&
      !(ban && ban.banned);
  } catch (err) {
    console.log("Pre-checkout error:", String(err).split(env.BOT_TOKEN).join("***"));
  }
  await tg(env, "answerPreCheckoutQuery", ok
    ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: "Sorry, this payment can't be completed. Please try again." });
}

async function handleStarsPaid(env, msg) {
  const sp = msg.successful_payment;
  if (sp.currency !== "XTR") return;
  const uid = String(msg.from.id);
  const charge = sp.telegram_payment_charge_id;
  try {
    const m = /^pay:(\d+)$/.exec(sp.invoice_payload || "");
    const pay = m ? await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(Number(m[1])).first() : null;
    if (!pay || pay.method !== "stars" || pay.user_id !== uid) {
      await alertOwner(env, `stars_unknown${charge}`,
        `A Stars payment arrived that I can't match: user ${uid}, ${sp.total_amount} Stars, charge ID ${charge}. Please check it and use /grant if it's valid.`);
      return;
    }
    const claim = await env.DB.prepare(
      "UPDATE payments SET status = 'approved', utr = ?, decided = ? WHERE id = ? AND status = 'pending'"
    ).bind(`stars:${charge}`, Date.now(), pay.id).run();
    if (!claim.meta.changes) return;

    const exp = await activateSubscription(env, uid, pay.plan);
    const plan = PLANS[pay.plan];
    await tg(env, "sendMessage", { chat_id: uid, text: `✅ Payment received! Premium is active until ${fmtDate(exp)}. Enjoy ad-free downloads.` });
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_ID,
      text: `⭐ New Stars payment: user ${uid}, ${plan.name}, ${pay.amount} Stars. Premium until ${fmtDate(exp)}.`,
    });
  } catch (err) {
    await alertOwner(env, `stars_error${charge}`,
      `A Stars payment from user ${uid} (${sp.total_amount} Stars, charge ID ${charge}) was received but I hit an error activating Premium. Please use /grant ${uid} <plan>. Error: ${String(err).slice(0, 200)}`);
  }
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
  const stars = await getStarPrices(env);
  const starsOn = await starsEnabled(env);
  text += `\n\n⭐ <b>Telegram Stars: ${starsOn ? "ON" : "OFF"}</b>\n` +
    Object.entries(PLANS).map(([k, p]) => `${p.name}: ${stars[k]} Stars`).join("\n") +
    "\nStars payments are confirmed by Telegram automatically.";
  if (note) text += `\n\n${note}`;
  const buttons = [
    [{ text: starsOn ? "⭐ Stars: ON (tap to turn off)" : "⭐ Stars: OFF (tap to turn on)", callback_data: "pay:startoggle" }],
    [{ text: "⭐ Set Star Prices", callback_data: "pay:stars" }],
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
var ME = null;

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
    ME = me;
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
  if (!me.upi_ready && !me.stars_ready) {
    root.appendChild(el("p", "sub", "Payments aren't set up yet. Please try again later."));
    return;
  }
  me.plans.forEach(function (p) {
    var b = el("button", "card plan");
    b.appendChild(el("span", null, p.name));
    b.appendChild(el("b", null, me.upi_ready ? "Rs " + p.price : "\\u2B50 " + p.stars));
    b.onclick = function () { choose(p); };
    root.appendChild(b);
  });
}
function choose(p) {
  if (ME.upi_ready && ME.stars_ready) return methods(p);
  if (ME.stars_ready) return startStars(p);
  startPay(p);
}
function methods(p) {
  clear();
  root.appendChild(el("h1", null, p.name));
  root.appendChild(el("p", "sub", "Choose how you'd like to pay."));
  var u = el("button", "btn", "Pay with UPI - Rs " + p.price);
  u.onclick = function () { startPay(p); };
  root.appendChild(u);
  var st = el("button", "btn", "Pay with Stars - \\u2B50 " + p.stars);
  st.onclick = function () { startStars(p); };
  root.appendChild(st);
  var back = el("button", "btn ghost", "Back");
  back.onclick = load;
  root.appendChild(back);
}
function startStars(p) {
  api("/api/stars", { plan: p.key }).then(function (d) {
    if (d.error) return fail(d.error);
    if (tg && tg.openInvoice) {
      tg.openInvoice(d.link, function (status) {
        if (status === "paid") return paid();
        if (status === "failed") return fail("The payment didn't go through. You were not charged.");
        load();
      });
    } else if (tg) {
      tg.openTelegramLink(d.link);
    }
  });
}
function paid() {
  clear();
  root.appendChild(el("h1", null, "Payment received!"));
  root.appendChild(el("p", "sub", "Premium turns on in a moment. You'll get a message in the bot."));
  var b = el("button", "btn", "Check my plan");
  b.onclick = load;
  root.appendChild(b);
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
  if (msg.chat.type !== "private") {
    await handleChannelPost(msg, env);
    return;
  }
  if (!msg.from) return;

  if (msg.successful_payment) {
    await handleStarsPaid(env, msg);
    return;
  }

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
    const tok = text.match(/^\/start v([A-Za-z0-9]+)/);
    if (tok) {
      const t = await env.DB.prepare("SELECT file_row_id, user_id, created FROM tokens WHERE token = ?")
        .bind(tok[1]).first();
      const fresh = t && Date.now() - t.created < 60 * 60 * 1000;
      if (!t || String(t.user_id) !== userId || !fresh) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ This verification link is invalid or has expired. Please tap the quality button on the channel post again.",
          parse_mode: "HTML",
        });
        return;
      }
      if (Date.now() - t.created < MIN_VERIFY_SECONDS * 1000) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Verification not completed. Please finish the steps on the link first, then come back.",
        });
        return;
      }
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
      text: "👋 Hi! Select any quality button on our channel posts to get your file instantly.\n\nOwner can use /settings to configure me.",
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
      text: "📣 Send the message you want to post (text, photo, video, file, anything). I'll ask you to confirm before it goes out.\n\n/cancel to stop.",
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

  if (action === "role" && ROLES[parts[1]]) {
    await clearState(env, userId);
    await showRoleMenu(env, chatId, messageId, parts[1]);
    return;
  }

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

  if (action === "rm" && ROLES[parts[1]]) {
    await removeChannel(env, parts[1], parts.slice(2).join(":"));
    await showRoleMenu(env, chatId, messageId, parts[1]);
    return;
  }

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

  if (action === "cov") {
    const sub = parts[1];
    const kind = parts[2];
    const validKind = kind === "pdf" || kind === "lecture";
    if (sub === "set" && validKind) {
      await setState(env, userId, `set:cover_${kind}`);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `🖼️ Send the photo to use as the <b>${kind === "pdf" ? "PDF" : "Video"} cover</b>.`,
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

  if (action === "del") {
    const sub = parts[1];
    if (sub === "custom") {
      await setState(env, userId, "set:delete_minutes");
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "✏️ Send the number of minutes (1 to 2820). For example, <code>10</code> means 10 minutes.",
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

  if (action === "pay") {
    const sub = parts[1];
    if (sub === "stars") {
      await setState(env, userId, "set:stars_prices");
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "⭐ Send the 4 Star prices in this order: week, month, 2 months, year.\n\nExample: <code>12 35 58 290</code>",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "pay:menu" }]] },
      });
      return;
    }
    if (sub === "startoggle") {
      await setSetting(env, "stars_off", (await starsEnabled(env)) ? "1" : "0");
    }
    if (sub === "upi" || sub === "name") {
      await setState(env, userId, `set:upi_${sub === "upi" ? "id" : "name"}`);
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: sub === "upi"
          ? "💳 Send your UPI ID, like <code>name@bank</code>. Customers will pay to this ID."
          : "💳 Send the name to show on payments, like <code>My Channel</code>.",
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

  // IMDb, TMDb, Multi-Quality & Shield settings
  if (action === "meta") {
    const sub = parts[1];
    if (sub === "tmdb" || sub === "omdb") {
      await setState(env, userId, `set:${sub}_key`);
      const prompt = sub === "tmdb"
        ? "🔑 Send your <b>TMDb API Key (v3 auth)</b> from themoviedb.org.\n\nI'll delete your message right after saving it."
        : "🔑 Send your <b>OMDb API Key</b> from omdbapi.com.\n\nI'll delete your message right after saving it.";
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: prompt,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "meta:menu" }]] },
      });
      return;
    }
    let note = "";
    if (sub === "toggle") {
      const on = (await getSetting(env, "meta_enabled")) === "1";
      if (on) {
        await setSetting(env, "meta_enabled", "0");
      } else if (!(await getSetting(env, "tmdb_key")) && !(await getSetting(env, "omdb_key"))) {
        note = "⚠️ Set at least one API key (TMDb or OMDb) first.";
      } else {
        await setSetting(env, "meta_enabled", "1");
      }
    }
    if (sub === "mitoggle") {
      const miOn = (await getSetting(env, "mediainfo_enabled")) !== "0";
      await setSetting(env, "mediainfo_enabled", miOn ? "0" : "1");
    }
    if (sub === "grouptoggle") {
      const gOn = (await getSetting(env, "group_qualities")) !== "0";
      await setSetting(env, "group_qualities", gOn ? "0" : "1");
    }
    if (sub === "shieldtoggle") {
      const sOn = (await getSetting(env, "shield_redirect")) !== "0";
      await setSetting(env, "shield_redirect", sOn ? "0" : "1");
    }
    if (sub === "prottoggle") {
      const pOn = (await getSetting(env, "protect_files")) === "1";
      await setSetting(env, "protect_files", pOn ? "0" : "1");
    }
    await clearState(env, userId);
    const mmenu = await buildMetaMenu(env, note);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: mmenu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: mmenu.buttons },
    });
    return;
  }

  // Shortlink settings
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

// ---------- IMDb, TMDb & Deep MediaInfo (Audio, Subtitles, Quality) ----------

function parseMediaTitle(raw) {
  const firstLine = (raw || "").split("\n")[0].trim();
  // Remove leading @channel tags or [brackets] at start
  const withoutPrefix = firstLine
    .replace(/^(@\w+\s*[-–|:]?\s*)+/i, "")
    .replace(/^(\[[^\]]+\]\s*)+/, "")
    .replace(/\.[a-zA-Z0-9]{2,4}$/, "")
    .replace(/[._]+/g, " ")
    .trim();

  // 1. Detect TV Show pattern (e.g., S01E02 or S01)
  const tvMatch = withoutPrefix.match(/^(.*?)\bS(\d{1,2})[\s._-]*E?(\d{1,3})?\b/i);
  if (tvMatch && tvMatch[1].trim().length > 1) {
    const cleanTv = tvMatch[1].replace(/\b(19\d{2}|20\d{2})\b.*/, "").replace(/[\(\[\-\–:]+$/, "").trim();
    const yearMatch = tvMatch[1].match(/\b(19\d{2}|20\d{2})\b/);
    return {
      query: cleanTv,
      year: yearMatch ? yearMatch[1] : null,
      isTv: true,
      season: parseInt(tvMatch[2], 10),
      episode: tvMatch[3] ? parseInt(tvMatch[3], 10) : null,
    };
  }

  // 2. Strip quality/codec/language tags before looking for Movie Year (so "2024" beats "2160p")
  const tagRegex = /\b(2160p|1440p|1080p|720p|540p|480p|360p|4k|uhd|fhd|hd|camrip|hdcam|predvd|web-?dl|webrip|bluray|brrip|bdrip|hdrip|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|10bit|hdr10?\+?|dv|dolby|aac|ac3|eac3|ddp?5?\.?1|atmos|truehd|dts|dual\s*audio|multi\s*audio|hindi|english|tamil|telugu|malayalam|kannada|esubs?|msubs?)\b.*/i;
  const beforeTags = withoutPrefix.replace(tagRegex, "").trim();

  const yearMatch = beforeTags.match(/^(.*?)\b(19\d{2}|20[0-3]\d)\b/);
  if (yearMatch && yearMatch[1].replace(/[\(\[\-\–:]+$/, "").trim().length > 1) {
    return {
      query: yearMatch[1].replace(/[\(\[\-\–:]+$/, "").trim(),
      year: yearMatch[2],
      isTv: false,
      season: null,
      episode: null,
    };
  }

  const cleanFallback = beforeTags.replace(/[\(\[\-\–:]+$/, "").trim();
  return {
    query: cleanFallback || withoutPrefix.slice(0, 60),
    year: null,
    isTv: false,
    season: null,
    episode: null,
  };
}

// Language dictionary for both filename tags & binary MKV/MP4 track codes
const LANG_PATTERNS = [
  { name: "Hindi", re: /\b(hindi|hin)\b/i },
  { name: "English", re: /\b(english|eng)\b/i },
  { name: "Tamil", re: /\b(tamil|tam)\b/i },
  { name: "Telugu", re: /\b(telugu|tel)\b/i },
  { name: "Malayalam", re: /\b(malayalam|mal)\b/i },
  { name: "Kannada", re: /\b(kannada|kan)\b/i },
  { name: "Bengali", re: /\b(bengali|ben)\b/i },
  { name: "Marathi", re: /\b(marathi|mar)\b/i },
  { name: "Punjabi", re: /\b(punjabi|pan)\b/i },
  { name: "Gujarati", re: /\b(gujarati|guj)\b/i },
  { name: "Japanese", re: /\b(japanese|jpn|jap)\b/i },
  { name: "Korean", re: /\b(korean|kor)\b/i },
  { name: "Chinese", re: /\b(chinese|chi|zho)\b/i },
  { name: "Spanish", re: /\b(spanish|spa)\b/i },
  { name: "French", re: /\b(french|fre|fra)\b/i },
  { name: "German", re: /\b(german|ger|deu)\b/i },
  { name: "Russian", re: /\b(russian|rus)\b/i },
  { name: "Arabic", re: /\b(arabic|ara)\b/i },
  { name: "Indonesian", re: /\b(indonesian|ind)\b/i },
];

// Deep binary inspection for files <= 20MB (Telegram getFile limit)
async function inspectBinaryHeader(env, fileId, fileSize) {
  if (!fileSize || fileSize > 20 * 1024 * 1024) return null;
  try {
    const gf = await tg(env, "getFile", { file_id: fileId });
    if (!gf.ok || !gf.result || !gf.result.file_path) return null;
    const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
    const res = await fetch(url, { headers: { Range: "bytes=0-131071" } });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf);
    const langs = [];
    for (const lp of LANG_PATTERNS) {
      if (lp.re.test(text) && !langs.includes(lp.name)) langs.push(lp.name);
    }
    const hasSub = /S_TEXT\/UTF8|S_TEXT\/ASS|wvtt|tx3g|stpp/i.test(text);
    return { langs, hasSub };
  } catch (err) {
    return null;
  }
}

async function extractMediaInfo(env, info, rawCaption) {
  const f = info.file;
  const sourceStr = `${info.name || ""}\n${rawCaption || ""}`;

  // 1. Quality / Resolution Label + Sort Order (480p -> 720p -> 1080p -> 2160p)
  let quality = "HD";
  let qOrder = 5;
  let exactRes = null;

  const qMatch = sourceStr.match(/\b(2160p|4K|UHD|1440p|2K|1080p|FHD|720p|540p|480p|360p|240p|CAMRip|HDCAM|PreDVD|HQ\s*S-?Print)\b/i);
  if (f.width && f.height) {
    exactRes = `${f.width}×${f.height}`;
    const shortSide = Math.min(f.width, f.height);
    const longSide = Math.max(f.width, f.height);
    if (longSide >= 3800 || shortSide >= 2100) { quality = "2160p 4K"; qOrder = 4; }
    else if (longSide >= 2500 || shortSide >= 1400) { quality = "1440p 2K"; qOrder = 3.5; }
    else if (longSide >= 1900 || shortSide >= 1000) { quality = "1080p"; qOrder = 3; }
    else if (longSide >= 1200 || shortSide >= 700) { quality = "720p"; qOrder = 2; }
    else if (longSide >= 800 || shortSide >= 460) { quality = "480p"; qOrder = 1; }
    else { quality = "360p"; qOrder = 0.5; }
  }
  if (qMatch) {
    const rawQ = qMatch[1].toUpperCase();
    if (/2160P|4K|UHD/.test(rawQ)) { quality = "2160p 4K"; qOrder = 4; }
    else if (/1440P|2K/.test(rawQ)) { quality = "1440p 2K"; qOrder = 3.5; }
    else if (/1080P|FHD/.test(rawQ)) { quality = "1080p"; qOrder = 3; }
    else if (/720P/.test(rawQ)) { quality = "720p"; qOrder = 2; }
    else if (/540P/.test(rawQ)) { quality = "540p"; qOrder = 1.5; }
    else if (/480P/.test(rawQ)) { quality = "480p"; qOrder = 1; }
    else if (/360P/.test(rawQ)) { quality = "360p"; qOrder = 0.5; }
    else { quality = rawQ; qOrder = 0.2; }
  }

  // 2. Source & Video Codec
  const ripMatch = sourceStr.match(/\b(BluRay|BRRip|BDRip|REMUX|WEB-?DL|WEBRip|HDRip|DVDRip|HDTV|CAMRip|HDCAM)\b/i);
  const vCodecMatch = sourceStr.match(/\b(x264|x265|H\.?264|H\.?265|HEVC|AVC|AV1|VP9|10-?bit)\b/i);
  const hdrMatch = sourceStr.match(/\b(HDR10\+?|Dolby\s*Vision|DV|HDR)\b/i);

  const vParts = [];
  if (ripMatch) vParts.push(ripMatch[1]);
  if (vCodecMatch) vParts.push(vCodecMatch[1].toUpperCase());
  if (hdrMatch) vParts.push(hdrMatch[1].toUpperCase());
  const videoTag = vParts.join(" · ") || null;

  // 3. Audio Languages & Audio Codec
  const detectedLangs = [];
  for (const lp of LANG_PATTERNS) {
    if (lp.re.test(sourceStr)) detectedLangs.push(lp.name);
  }

  // Optional binary header check if file <= 20MB
  const bin = await inspectBinaryHeader(env, f.file_id, f.file_size);
  if (bin && bin.langs.length) {
    for (const l of bin.langs) {
      if (!detectedLangs.includes(l)) detectedLangs.push(l);
    }
  }

  let audioLangStr = detectedLangs.join(", ");
  if (!audioLangStr) {
    if (/\bdual\s*audio\b/i.test(sourceStr)) audioLangStr = "Dual Audio (Hindi, English)";
    else if (/\bmulti\s*audio\b/i.test(sourceStr)) audioLangStr = "Multi Audio";
  } else if (/\bdual\s*audio\b/i.test(sourceStr) && detectedLangs.length === 1) {
    audioLangStr += " + Dual Audio";
  }

  const aCodecMatch = sourceStr.match(/\b(AAC|AC3|EAC3|DDP|DD\+|DTS(?:-HD)?|TrueHD|Atmos|FLAC|MP3|Opus)\b/i);
  const chanMatch = sourceStr.match(/\b(7\.1|5\.1|2\.0)\b/);
  const aCodecParts = [];
  if (aCodecMatch) aCodecParts.push(aCodecMatch[1].toUpperCase().replace("DDP", "DD+"));
  if (chanMatch) aCodecParts.push(`${chanMatch[1]}ch`);
  const audioCodecStr = aCodecParts.join(" ");

  const fullAudio = [audioLangStr, audioCodecStr ? `(${audioCodecStr})` : ""].filter(Boolean).join(" ") || null;

  // 4. Subtitles
  let subtitles = null;
  if (/\b(esubs?|eng\s*subs?|english\s*subs?|subtitles?|soft\s*subs?)\b/i.test(sourceStr)) {
    subtitles = "English (ESub)";
  } else if (/\b(msubs?|multi\s*subs?)\b/i.test(sourceStr)) {
    subtitles = "Multi-Language (MSub)";
  } else if (/\b(hc-?sub|hardsub|korsub)\b/i.test(sourceStr)) {
    subtitles = "Hardcoded Subtitles";
  } else if (bin && bin.hasSub) {
    subtitles = "Embedded Subtitles";
  }

  // 5. Duration & Bitrate & Container
  let duration = null;
  if (f.duration) {
    const hrs = Math.floor(f.duration / 3600);
    const mins = Math.floor((f.duration % 3600) / 60);
    duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  }

  let bitrate = null;
  if (f.file_size && f.duration && f.duration > 0) {
    const kbps = Math.round((f.file_size * 8) / f.duration / 1000);
    bitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps} kbps`;
  }

  const extMatch = (info.name || "").match(/\.([a-zA-Z0-9]{2,4})$/);
  const container = extMatch ? extMatch[1].toUpperCase() : (f.mime_type ? f.mime_type.split("/")[1].toUpperCase() : "MKV");

  // Extra tag for button disambiguation (e.g. HEVC, 10bit)
  let shortCodec = "";
  if (/\b(hevc|x265|10bit)\b/i.test(sourceStr)) shortCodec = "HEVC";

  return {
    quality,
    qOrder,
    exactRes,
    videoTag,
    audioLangs: detectedLangs,
    audioCodecStr,
    fullAudio,
    subtitles,
    duration,
    bitrate,
    container,
    shortCodec,
  };
}

async function fetchMovieMeta(env, rawTitle, parsed) {
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  if (!metaOn) return null;

  const explicitImdb = (rawTitle || "").match(/\b(tt\d{7,9})\b/i);
  if (!parsed.query && !explicitImdb) return null;

  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");

  let result = {
    title: null,
    year: parsed.year,
    rating: null,
    genres: null,
    plot: null,
    poster: null,
    imdbId: explicitImdb ? explicitImdb[1] : null,
    tmdbId: null,
    mediaType: parsed.isTv ? "tv" : "movie",
    runtime: null,
    languages: null,
  };

  // 1. TMDb Lookup
  if (tmdbKey) {
    try {
      let item = null;
      if (result.imdbId) {
        const findUrl = `https://api.themoviedb.org/3/find/${result.imdbId}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`;
        const findRes = await fetch(findUrl).then((r) => r.json());
        item = (findRes.movie_results && findRes.movie_results[0]) || (findRes.tv_results && findRes.tv_results[0]);
        if (findRes.tv_results && findRes.tv_results[0]) result.mediaType = "tv";
      } else {
        const type = parsed.isTv ? "tv" : "movie";
        const yearParam = parsed.year ? (parsed.isTv ? `&first_air_date_year=${parsed.year}` : `&year=${parsed.year}`) : "";
        const searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(parsed.query)}${yearParam}`;
        const sRes = await fetch(searchUrl).then((r) => r.json());
        item = sRes.results && sRes.results[0];
        // Retry without year if strict year search returned nothing
        if (!item && yearParam) {
          const retryUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(parsed.query)}`;
          const rRes = await fetch(retryUrl).then((r) => r.json());
          item = rRes.results && rRes.results[0];
        }
      }

      if (item) {
        result.tmdbId = item.id;
        result.title = item.title || item.name;
        const dateStr = item.release_date || item.first_air_date || "";
        if (dateStr) result.year = dateStr.slice(0, 4);
        if (item.vote_average) result.rating = `⭐ ${Number(item.vote_average).toFixed(1)}/10 (TMDb)`;
        if (item.overview) result.plot = item.overview;
        if (item.poster_path) result.poster = `https://image.tmdb.org/t/p/w780${item.poster_path}`;

        const detUrl = `https://api.themoviedb.org/3/${result.mediaType}/${item.id}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids`;
        const det = await fetch(detUrl).then((r) => r.json());
        if (det.genres && det.genres.length) {
          result.genres = det.genres.slice(0, 3).map((g) => g.name).join(", ");
        }
        if (det.runtime) result.runtime = `${det.runtime} min`;
        if (det.spoken_languages && det.spoken_languages.length) {
          result.languages = det.spoken_languages.map((l) => l.english_name || l.name).filter(Boolean).join(", ");
        }
        if (det.external_ids && det.external_ids.imdb_id) {
          result.imdbId = det.external_ids.imdb_id;
        }
      }
    } catch (err) {
      console.log("TMDb lookup error:", err);
    }
  }

  // 2. OMDb (IMDb) Lookup
  if (omdbKey) {
    try {
      let omdbUrl = null;
      if (result.imdbId) {
        omdbUrl = `https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbKey)}&i=${encodeURIComponent(result.imdbId)}`;
      } else {
        const yParam = parsed.year ? `&y=${encodeURIComponent(parsed.year)}` : "";
        omdbUrl = `https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbKey)}&t=${encodeURIComponent(parsed.query)}${yParam}`;
      }
      const omdb = await fetch(omdbUrl).then((r) => r.json());
      if (omdb && omdb.Response === "True") {
        if (!result.title) result.title = omdb.Title;
        if (!result.year && omdb.Year) result.year = omdb.Year.slice(0, 4);
        if (omdb.imdbID) result.imdbId = omdb.imdbID;
        if (omdb.imdbRating && omdb.imdbRating !== "N/A") {
          result.rating = `⭐ ${omdb.imdbRating}/10 (IMDb)`;
        }
        if (!result.genres && omdb.Genre && omdb.Genre !== "N/A") result.genres = omdb.Genre;
        if (!result.plot && omdb.Plot && omdb.Plot !== "N/A") result.plot = omdb.Plot;
        if (!result.runtime && omdb.Runtime && omdb.Runtime !== "N/A") result.runtime = omdb.Runtime;
        if (!result.languages && omdb.Language && omdb.Language !== "N/A") result.languages = omdb.Language;
        if (!result.poster && omdb.Poster && omdb.Poster.startsWith("http")) result.poster = omdb.Poster;
      }
    } catch (err) {
      console.log("OMDb lookup error:", err);
    }
  }

  return result.title || result.rating || result.plot ? result : null;
}

// Builds the rich caption and sorted multi-quality buttons for a Movie / Episode post
async function buildGroupedMediaMessage(env, meta, parsed, fallbackTitle, items) {
  const miEnabled = (await getSetting(env, "mediainfo_enabled")) !== "0";

  // Sort items from lowest quality (480p) to highest (4K), then by file size
  items.sort((a, b) => (a.qOrder - b.qOrder) || (a.size - b.size));

  let epTag = "";
  if (parsed && parsed.isTv && parsed.season) {
    epTag = ` — S${String(parsed.season).padStart(2, "0")}${parsed.episode ? "E" + String(parsed.episode).padStart(2, "0") : ""}`;
  }

  const displayTitle = meta && meta.title
    ? `${meta.title}${meta.year ? ` (${meta.year})` : ""}${epTag}`
    : `${(parsed && parsed.query) || fallbackTitle.slice(0, 200)}${parsed && parsed.year ? ` (${parsed.year})` : ""}${epTag}`;

  const lines = [`🎬 <b>${esc(displayTitle)}</b>`, ""];

  if (meta) {
    if (meta.rating) lines.push(`🏆 <b>Rating:</b> ${esc(meta.rating)}`);
    if (meta.genres) lines.push(`🎭 <b>Genre:</b> ${esc(meta.genres)}`);
  }

  // Combine Audio, Subtitles, Runtime, and Codecs across all uploaded qualities
  if (miEnabled) {
    const allAudioLangs = [...new Set(items.flatMap((x) => x.audioLangs || []))];
    const allAudioCodecs = [...new Set(items.map((x) => x.audioCodecStr).filter(Boolean))];
    let audioText = allAudioLangs.join(", ");
    if (!audioText) {
      const customFull = items.map((x) => x.fullAudio).find(Boolean);
      if (customFull) audioText = customFull;
      else if (meta && meta.languages) audioText = meta.languages;
    } else if (allAudioCodecs.length) {
      audioText += ` (${allAudioCodecs.join(" / ")})`;
    }
    if (audioText) lines.push(`🔊 <b>Audio:</b> ${esc(audioText)}`);

    const allSubs = [...new Set(items.map((x) => x.subtitles).filter(Boolean))];
    if (allSubs.length) {
      lines.push(`💬 <b>Subtitles:</b> ${esc(allSubs.join(" / "))}`);
    }

    const runtimeStr = items.map((x) => x.duration).find(Boolean) || (meta && meta.runtime);
    if (runtimeStr) lines.push(`⏱ <b>Runtime:</b> ${esc(runtimeStr)}`);

    const quals = [...new Set(items.map((x) => x.quality))];
    const vTags = [...new Set(items.map((x) => x.videoTag).filter(Boolean))];
    const containers = [...new Set(items.map((x) => x.container).filter(Boolean))];
    const techParts = [
      quals.join(" | "),
      vTags.join(" / "),
      containers.join("/"),
    ].filter(Boolean);
    if (techParts.length) {
      lines.push(`📊 <b>MediaInfo:</b> <code>${esc(techParts.join(" • "))}</code>`);
    }
  } else if (meta && meta.runtime) {
    lines.push(`⏱ <b>Runtime:</b> ${esc(meta.runtime)}`);
  }

  if (meta && meta.plot) {
    const shortPlot = meta.plot.length > 240 ? meta.plot.slice(0, 237) + "..." : meta.plot;
    lines.push(`\n📝 <b>Storyline:</b> <i>${esc(shortPlot)}</i>`);
  }

  lines.push(`\n⬇️ <b>Select your preferred quality below:</b>`);

  // Build quality buttons (pair 2 buttons per row when there are multiple files)
  const qButtons = [];
  for (const item of items) {
    const link = await makeDeepLink(env, `f${item.rowId}`);
    const codecBadge = item.shortCodec ? ` ${item.shortCodec}` : "";
    const label = `📥 ${item.quality}${codecBadge} [${formatSize(item.size)}]`;
    qButtons.push({ text: label, url: link });
  }

  const keyboard = [];
  if (qButtons.length === 1) {
    keyboard.push([qButtons[0]]);
  } else {
    for (let i = 0; i < qButtons.length; i += 2) {
      keyboard.push(qButtons.slice(i, i + 2));
    }
  }

  const extLinks = [];
  if (meta && meta.imdbId) {
    extLinks.push({ text: "⭐ IMDb", url: `https://www.imdb.com/title/${meta.imdbId}/` });
  }
  if (meta && meta.tmdbId) {
    extLinks.push({ text: "🎬 TMDb", url: `https://www.themoviedb.org/${meta.mediaType}/${meta.tmdbId}` });
  }
  if (extLinks.length) keyboard.push(extLinks);

  return {
    postText: lines.join("\n"),
    markup: { inline_keyboard: keyboard },
  };
}

// ---------- Handling new posts in channels ----------
async function handleChannelPost(post, env) {
  await ensureExtraTables(env);

  const chatId = String(post.chat.id);
  const isSource = await env.DB.prepare(
    "SELECT 1 AS ok FROM channels WHERE role = 'source' AND chat_id = ?"
  ).bind(chatId).first();
  if (!isSource) return;

  if (post.chat.type !== "channel" && !(await isTrustedSender(env, post))) return;

  const info = classifyPost(post);
  if (!info) return;

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
  if (!rowId) return;

  // --- PDF Posting (Single Post) ---
  if (info.kind === "pdf") {
    const link = await makeDeepLink(env, `f${rowId}`);
    const postText = `📄 <b>${esc(title.slice(0, 300))}</b>\n\n🏷 <b>Type:</b> PDF Document\n📦 <b>Size:</b> ${formatSize(info.file.file_size)}`;
    const markup = { inline_keyboard: [[{ text: `📥 Get PDF [${formatSize(info.file.file_size)}]`, url: link }]] };
    const thumb = info.file.thumbnail || info.file.thumb;
    const cover = (await getSetting(env, "cover_pdf")) || (thumb ? thumb.file_id : null);
    if (cover) {
      const sent = await tg(env, "sendPhoto", { chat_id: dest[0].chat_id, photo: cover, caption: postText, parse_mode: "HTML", reply_markup: markup });
      if (sent.ok) return;
    }
    await tg(env, "sendMessage", { chat_id: dest[0].chat_id, text: postText, parse_mode: "HTML", reply_markup: markup });
    return;
  }

  // --- Video / Movie Posting (Multi-Quality Grouping + IMDb/TMDb + Deep MediaInfo) ---
  const rawSearchText = `${post.caption || ""}\n${info.name}`;
  const parsed = parseMediaTitle(rawSearchText);
  const mi = await extractMediaInfo(env, info, post.caption);
  const meta = await fetchMovieMeta(env, rawSearchText, parsed);

  // Build unique group key so 480p, 720p, 1080p, 2160p of the same Movie (or TV Episode) merge into 1 post
  const epSuffix = parsed.isTv && parsed.season ? `_s${parsed.season}e${parsed.episode || 0}` : "";
  let baseKey = "";
  if (meta && meta.imdbId) {
    baseKey = `imdb_${meta.imdbId}`;
  } else if (meta && meta.tmdbId) {
    baseKey = `tmdb_${meta.mediaType}_${meta.tmdbId}`;
  } else {
    const slug = (parsed.query || title).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
    baseKey = `raw_${slug}_${parsed.year || "na"}`;
  }
  const groupKey = `${dest[0].chat_id}:${baseKey}${epSuffix}`;

  const newItem = {
    rowId,
    quality: mi.quality,
    qOrder: mi.qOrder,
    size: info.file.file_size || 0,
    shortCodec: mi.shortCodec,
    videoTag: mi.videoTag,
    audioLangs: mi.audioLangs,
    audioCodecStr: mi.audioCodecStr,
    fullAudio: mi.fullAudio,
    subtitles: mi.subtitles,
    duration: mi.duration,
    container: mi.container,
  };

  const groupEnabled = (await getSetting(env, "group_qualities")) !== "0";
  const existing = groupEnabled
    ? await env.DB.prepare("SELECT * FROM media_posts WHERE group_key = ?").bind(groupKey).first()
    : null;

  // If a post for this movie already exists in the channel, add the new quality button & update MediaInfo!
  if (existing && String(existing.chat_id) === String(dest[0].chat_id)) {
    let items = [];
    try { items = JSON.parse(existing.items_json || "[]"); } catch (e) { items = []; }

    const idx = items.findIndex((x) => x.rowId === rowId || (x.quality === newItem.quality && x.shortCodec === newItem.shortCodec && Math.abs(x.size - newItem.size) < 5 * 1024 * 1024));
    if (idx >= 0) items[idx] = newItem;
    else items.push(newItem);

    let savedMeta = meta;
    if (!savedMeta && existing.meta_json) {
      try { savedMeta = JSON.parse(existing.meta_json); } catch (e) {}
    }

    const built = await buildGroupedMediaMessage(env, savedMeta, parsed, title, items);
    const editMethod = existing.has_photo ? "editMessageCaption" : "editMessageText";
    const editPayload = {
      chat_id: existing.chat_id,
      message_id: existing.message_id,
      parse_mode: "HTML",
      reply_markup: built.markup,
      [existing.has_photo ? "caption" : "text"]: built.postText,
    };

    const edited = await tg(env, editMethod, editPayload);
    if (edited.ok || (edited.description && /message is not modified/i.test(edited.description))) {
      await env.DB.prepare(
        "UPDATE media_posts SET items_json = ?, meta_json = ?, updated = ? WHERE group_key = ?"
      ).bind(JSON.stringify(items), savedMeta ? JSON.stringify(savedMeta) : existing.meta_json, Date.now(), groupKey).run();
      return;
    }
    // If the old channel post was manually deleted from the channel, fall through and create a fresh post containing all qualities!
    console.log("Could not edit existing post, creating a fresh combined post:", edited.description);
  }

  // Create a brand new post (or replacement post if the old one was deleted)
  const items = [newItem];
  const built = await buildGroupedMediaMessage(env, meta, parsed, title, items);

  const thumb = info.file.thumbnail || info.file.thumb;
  const savedCover = await getSetting(env, "cover_lecture");
  // Priority: Official TMDb/IMDb Poster -> Custom Fallback Cover -> Video Thumbnail
  const cover = (meta && meta.poster) || savedCover || (thumb ? thumb.file_id : null);

  let postedMsg = null;
  let hasPhoto = 0;

  if (cover) {
    const sent = await tg(env, "sendPhoto", {
      chat_id: dest[0].chat_id,
      photo: cover,
      caption: built.postText,
      parse_mode: "HTML",
      reply_markup: built.markup,
    });
    if (sent.ok) {
      postedMsg = sent.result;
      hasPhoto = 1;
    } else {
      console.log("Cover failed, posting without it:", JSON.stringify(sent));
    }
  }

  if (!postedMsg) {
    const posted = await tg(env, "sendMessage", {
      chat_id: dest[0].chat_id,
      text: built.postText,
      parse_mode: "HTML",
      reply_markup: built.markup,
    });
    if (posted.ok) {
      postedMsg = posted.result;
    } else {
      await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(rowId).run();
      await alertOwner(env, `post${dest[0].chat_id}`,
        `I couldn't post "${title}" to "${dest[0].title}": ${posted.description}. Check that I'm an admin there with the Post Messages permission.`);
      return;
    }
  }

  if (groupEnabled && postedMsg) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO media_posts (group_key, chat_id, message_id, has_photo, meta_json, items_json, updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      groupKey,
      String(dest[0].chat_id),
      postedMsg.message_id,
      hasPhoto,
      meta ? JSON.stringify(meta) : null,
      JSON.stringify(items),
      Date.now()
    ).run();
  }
}

// ---------- Entry point ----------
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    APP_ORIGIN = url.origin;

    // Anti-Copyright Redirect Shield: /get/f123 -> bounces user to current active Telegram bot
    if (request.method === "GET" && url.pathname.startsWith("/get/")) {
      const token = url.pathname.slice(5).replace(/[^A-Za-z0-9_-]/g, "");
      const username = await getBotUsername(env);
      if (username && token) {
        return Response.redirect(`https://t.me/${username}?start=${token}`, 302);
      }
      return new Response("Bot link not ready yet.", { status: 404 });
    }

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
      if (update.pre_checkout_query) await handlePreCheckout(update.pre_checkout_query, env);
    } catch (err) {
      const detail = String(err && err.stack ? err.stack : err).split(env.BOT_TOKEN).join("***");
      console.log("Error:", detail);
      await alertOwner(env, "error", `Something went wrong in the bot: ${detail.slice(0, 300)}`);
    }
    return new Response("OK");
  },
};
