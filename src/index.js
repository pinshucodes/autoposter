// Autoposter Bot - Movie & Series Season Batching + Anti-Bypass Shortlink Shield + IMDb/TMDb/MediaInfo
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

// ---------- Auto-create tables for Multi-Quality & Series Season Batches ----------
let SCHEMA_READY = false;
async function ensureExtraTables(env) {
  if (SCHEMA_READY) return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS media_posts (" +
        "group_key TEXT PRIMARY KEY, " +
        "chat_id TEXT, " +
        "message_id INTEGER, " +
        "has_photo INTEGER, " +
        "meta_json TEXT, " +
        "items_json TEXT, " +
        "updated INTEGER)"
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS media_post_channels (" +
        "group_key TEXT, " +
        "chat_id TEXT, " +
        "message_id INTEGER, " +
        "has_photo INTEGER, " +
        "PRIMARY KEY (group_key, chat_id))"
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS batches (" +
        "batch_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "group_key TEXT, " +
        "quality TEXT, " +
        "title TEXT, " +
        "items_json TEXT, " +
        "updated INTEGER)"
      ),
      env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_gk_q ON batches(group_key, quality)"
      ),
    ]);
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
    emoji: "🎬", name: "Movies / Series Channel", multi: true, max: 50,
    help: "The main channel where movie and series posts will be published and auto-updated.",
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

async function getBatchRow(env, batchId) {
  await ensureExtraTables(env);
  return env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?").bind(batchId).first();
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

async function makeDeepLink(env, startParam) {
  const shieldOn = (await getSetting(env, "shield_redirect")) !== "0"; // ON by default
  if (shieldOn && APP_ORIGIN) {
    return `${APP_ORIGIN}/get/${startParam}`;
  }
  const username = await getBotUsername(env);
  return `https://t.me/${username}?start=${startParam}`;
}

// Sends a single file to the user (unlocked by default so they can share/forward within 5 mins)
async function sendFileToUser(env, chatId, row, skipNotice) {
  const asVideo = row.send_as === "video";
  const protect = (await getSetting(env, "protect_files")) === "1"; // OFF by default so users can forward/share
  const sent = await tg(env, asVideo ? "sendVideo" : "sendDocument", {
    chat_id: chatId,
    [asVideo ? "video" : "document"]: row.file_id,
    caption: `🎬 <b>${esc(row.title)}</b>`,
    parse_mode: "HTML",
    protect_content: protect,
  });

  if (!sent.ok) {
    console.log("Send file failed:", sent.error_code, sent.description);
    if (sent.error_code !== 403 && !skipNotice) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ I couldn't send the file right now. Please try again in a minute.",
      });
      await alertOwner(env, `send${row.id}`, `Could not send file #${row.id} "${row.title}": ${sent.description}`);
    }
    return null;
  }

  await env.DB.prepare("INSERT INTO downloads (user_id, file_row_id, day) VALUES (?, ?, ?)")
    .bind(String(chatId), row.id, dayString(0)).run();

  // Default auto-delete is 5 minutes so users can forward/share before it vanishes
  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
  if (!mins) return sent.result.message_id;

  const deleteAt = Date.now() + mins * 60 * 1000;
  const ids = [sent.result.message_id];

  if (!skipNotice) {
    const notice = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `⏳ <b>Auto-Delete Notice:</b> This file will be deleted in <b>${formatDelay(mins)}</b>. Forward or share it to your Saved Messages now!`,
      parse_mode: "HTML",
    });
    if (notice.ok) ids.push(notice.result.message_id);
  }

  for (const id of ids) {
    await env.DB.prepare("INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)")
      .bind(String(chatId), id, deleteAt).run();
  }
  return sent.result.message_id;
}

// Sends Paginated File / Episode Picker inside the bot (10 files per page + PREV/NEXT)
async function sendBatchMenuToUser(env, chatId, batch, page = 0, editMsgId = null) {
  let items = [];
  try { items = JSON.parse(batch.items_json || "[]"); } catch (e) { items = []; }

  if (!items.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, no files found for this title." });
    return;
  }

  // Sort series by Season/Episode, or movies by size (largest to smallest)
  items.sort((a, b) => {
    if (a.episode || b.episode) {
      return (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0) || (b.size || 0) - (a.size || 0);
    }
    return (b.size || 0) - (a.size || 0);
  });

  const perPage = 10;
  const totalPages = Math.ceil(items.length / perPage);
  const curPage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = items.slice(curPage * perPage, (curPage + 1) * perPage);

  const lines = [
    `📁 <b>Found ✨ ${items.length} Files For : #${esc(batch.title)} 👇</b>`,
    `📄 <b>Page:</b> ${curPage + 1} of ${totalPages}`,
    "",
    `🔻 <b>Choose your file from the buttons below to start downloading</b> 🔻`,
  ];

  const buttons = [];

  for (const ep of slice) {
    const sizeStr = formatSize(ep.size);
    let label = ep.fileName || "";
    if (!label) {
      const sStr = ep.season ? `S${String(ep.season).padStart(2, "0")}` : "";
      const eStr = ep.episode ? `E${String(ep.episode).padStart(2, "0")}` : "";
      const seTag = (sStr || eStr) ? `${sStr}${eStr} • ` : "";
      const langTag = ep.audioLangs && ep.audioLangs.length ? ` • ${ep.audioLangs.join("+")}` : "";
      label = `${seTag}${ep.quality || "HD"}${langTag}`;
    }
    buttons.push([{
      text: `${sizeStr} - ${label}`.slice(0, 62),
      callback_data: `bep:${ep.rowId}`,
    }]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (curPage > 0) {
      navRow.push({ text: "⏪ PREVIOUS", callback_data: `bpage:${batch.batch_id}:${curPage - 1}` });
    }
    if (curPage < totalPages - 1) {
      navRow.push({ text: "⏩ NEXT", callback_data: `bpage:${batch.batch_id}:${curPage + 1}` });
    }
    if (navRow.length) buttons.push(navRow);
  }

  if (items.length > 1) {
    buttons.push([{ text: `📦 Send All ${items.length} Files`, callback_data: `ball:${batch.batch_id}` }]);
  }

  if (editMsgId) {
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  const sent = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });

  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
  if (mins && sent.ok) {
    await env.DB.prepare("INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)")
      .bind(String(chatId), sent.result.message_id, Date.now() + mins * 60 * 1000).run();
  }
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

// ---------- Shortlink & Anti-Bypass Verification ----------
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

// Anti-Bypass Verification:
// Uses a Telegram Mini App (web_app) button so long-pressing NEVER shows a URL or "Copy" option!
// Plus adds the "How to Verify" tutorial button right below it.
// Negative file_row_id (-batchId) represents a Series Season Batch!
async function sendVerifyLink(env, chatId, userId, targetId, displayTitle) {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("DELETE FROM tokens WHERE created < ?").bind(Date.now() - 24 * 3600 * 1000).run();
  await env.DB.prepare("INSERT INTO tokens (token, user_id, file_row_id, created) VALUES (?, ?, ?, ?)")
    .bind(token, String(userId), targetId, Date.now()).run();

  const tutorialUrl = await getSetting(env, "tutorial_url");
  const keyboard = [];

  if (APP_ORIGIN) {
    // WebApp button: impossible to long-press & copy URL in Telegram!
    keyboard.push([{ text: "🛡️ Verify Now & Unlock File", web_app: { url: `${APP_ORIGIN}/verify?t=${token}` } }]);
  } else {
    const username = await getBotUsername(env);
    const short = await shortenUrl(env, `https://t.me/${username}?start=v${token}`);
    if (!short) {
      await alertOwner(env, "shortlink", "Shortlink failed. Sending without verification.");
      if (targetId < 0) {
        const b = await getBatchRow(env, -targetId);
        if (b) await sendBatchMenuToUser(env, chatId, b);
      } else {
        const row = await getFileRow(env, targetId);
        if (row) await sendFileToUser(env, chatId, row);
      }
      return;
    }
    keyboard.push([{ text: "🛡️ Verify Now & Unlock File", url: short }]);
  }

  if (tutorialUrl) {
    keyboard.push([{ text: "🎬 How to Verify (Tutorial)", url: tutorialUrl }]);
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `🛡️ <b>Secure Verification Required</b>\n\n` +
      `🎬 <b>${esc(displayTitle)}</b>\n\n` +
      `Complete the quick verification below to unlock your selected content.\n` +
      `<i>🔒 Protected link — copying or external bypass tools are blocked.</i>`,
    parse_mode: "HTML",
    protect_content: true, // Locks the verification message from forwarding/copying
    reply_markup: { inline_keyboard: keyboard },
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
        `ForceSub can't check "${c.title}": ${r.description}. Make sure I'm still an admin there.`);
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
    await alertOwner(env, `lnk${c.chat_id}`, `I have no join link for ForceSub channel "${c.title}". Give me Invite Users permission.`);
  }
  return link;
}

// Delivers a single file ( checks ForceSub -> Shortlink -> Sends File )
async function deliverFile(env, chatId, userId, row, verified) {
  const missing = await getMissingChannels(env, userId);
  if (!missing.length) {
    if (!verified && (await shortlinkReady(env)) && !(await hasActiveSub(env, userId))) {
      await sendVerifyLink(env, chatId, userId, row.id, row.title);
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

// Delivers a Series Season Batch ( checks ForceSub -> Shortlink -> Opens Jarvis-style Episode List )
async function deliverBatch(env, chatId, userId, batch, verified) {
  const missing = await getMissingChannels(env, userId);
  if (!missing.length) {
    if (!verified && (await shortlinkReady(env)) && !(await hasActiveSub(env, userId))) {
      await sendVerifyLink(env, chatId, userId, -batch.batch_id, `${batch.title} (${batch.quality})`);
      return;
    }
    await sendBatchMenuToUser(env, chatId, batch);
    return;
  }
  const buttons = [];
  for (const c of missing) {
    const link = await ensureLink(env, c);
    if (link) buttons.push([{ text: `📢 Join ${c.title}`.slice(0, 60), url: link }]);
  }
  buttons.push([{ text: "✅ I've Joined", callback_data: `chkb:${batch.batch_id}` }]);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔐 To access this season batch, please join the channel(s) below, then tap <b>I've Joined</b>.",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

// ---------- Menus ----------
const MAIN_MENU = {
  text: "⚙️ <b>Settings</b>\n\nSelect what you want to configure:",
  buttons: [
    [{ text: "📥 Source Channels", callback_data: "role:source" }],
    [{ text: "🎬 Movies / Series Channel", callback_data: "role:lectures" }],
    [{ text: "📄 PDFs Channel", callback_data: "role:pdfs" }],
    [{ text: "🔐 ForceSub Settings", callback_data: "role:forcesub" }],
    [{ text: "🎬 IMDb, TMDb, Grouping & Shield", callback_data: "meta:menu" }],
    [{ text: "🔗 Shortlink & Tutorial Settings", callback_data: "sl:menu" }],
    [{ text: "🗑️ File Delete Settings", callback_data: "del:menu" }],
    [{ text: "🖼️ Cover Images", callback_data: "cov:menu" }],
    [{ text: "💳 Payments", callback_data: "pay:menu" }],
    [{ text: "❌ Close", callback_data: "close" }],
  ],
};

const SUB_MENUS = {};
const BACK_BUTTON = [[{ text: "⬅️ Back", callback_data: "back" }]];

async function buildRoleMenu(env, role, page = 0) {
  const info = ROLES[role];
  const channels = await getChannels(env, role);

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(channels.length / perPage));
  const curPage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = channels.slice(curPage * perPage, (curPage + 1) * perPage);

  let text = `${info.emoji} <b>${info.name}</b> (${channels.length}${info.max ? `/${info.max}` : ""})\n\n${info.help}\n\n`;
  if (channels.length) {
    text += `📄 <b>Page ${curPage + 1} of ${totalPages}</b>\n`;
    text += slice.map((c, idx) => `${curPage * perPage + idx + 1}. ${esc(c.title)} (<code>${c.chat_id}</code>)`).join("\n");
  } else {
    text += "<i>None set yet.</i>";
  }

  const buttons = slice.map((c) => [
    { text: `🗑 Remove ${c.title}`.slice(0, 60), callback_data: `rm:${role}:${curPage}:${c.chat_id}` },
  ]);

  if (totalPages > 1) {
    const nav = [];
    if (curPage > 0) nav.push({ text: "⏪ Prev", callback_data: `role:${role}:${curPage - 1}` });
    if (curPage < totalPages - 1) nav.push({ text: "⏩ Next", callback_data: `role:${role}:${curPage + 1}` });
    if (nav.length) buttons.push(nav);
  }

  if (!info.max || channels.length < info.max) {
    const addLabel = info.multi ? "➕ Add Channel" : channels.length ? "🔄 Change Channel" : "➕ Set Channel";
    buttons.push([{ text: addLabel, callback_data: `add:${role}` }]);
  }
  buttons.push(...BACK_BUTTON);

  return { text, buttons };
}

async function showRoleMenu(env, chatId, messageId, role, page = 0) {
  const menu = await buildRoleMenu(env, role, page);
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
  const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
  let text = "🗑️ <b>File Delete Settings</b>\n\n" +
    "Files sent by the bot can be shared/forwarded by users for the time you choose, and then are automatically deleted from the chat.\n\n" +
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
  const protectOn = (await getSetting(env, "protect_files")) === "1"; // OFF by default so users can forward/share
  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");
  const sampleUrl = await getSetting(env, "sample_url");

  let text = "🎬 <b>IMDb, TMDb, Series Batching & Shield</b>\n\n" +
    "• <b>Combine Qualities & Series Seasons:</b> Merges 480p, 720p, 1080p, 4K of a Movie or an entire TV Season into ONE channel post. Tapping 720p on a series opens the Jarvis-style Episode Batch list!\n" +
    "• <b>MediaInfo:</b> Extracts audio languages, subtitles, codecs & resolution.\n" +
    "• <b>Redirect Shield:</b> Uses Worker links on channel posts to protect your channel.\n" +
    "• <b>Forward Lock:</b> Keep OFF so users can forward/share files within 5 minutes.\n\n" +
    `🎬 IMDb/TMDb Info: ${metaOn ? "✅ ON" : "❌ OFF"}\n` +
    `🗂 Combine Qualities & Seasons: ${groupOn ? "✅ ON" : "❌ OFF"}\n` +
    `📊 Deep MediaInfo (Audio/Subs): ${miOn ? "✅ ON" : "❌ OFF"}\n` +
    `🛡️ Worker Redirect Shield: ${shieldOn ? "✅ ON" : "❌ OFF"}\n` +
    `🔒 Lock File Forwarding: ${protectOn ? "✅ ON (No Share)" : "❌ OFF (Users Can Share)"}\n\n` +
    `TMDb Key: ${tmdbKey ? "<code>" + esc(tmdbKey.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}\n` +
    `OMDb (IMDb) Key: ${omdbKey ? "<code>" + esc(omdbKey.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}\n` +
    `🎬 Sample Channel Link: ${sampleUrl ? esc(sampleUrl) : "<i>not set</i>"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: metaOn ? "🎬 IMDb/TMDb: ON" : "🎬 IMDb/TMDb: OFF (Tap to ON)", callback_data: "meta:toggle" }],
    [{ text: groupOn ? "🗂 Combine Qualities/Seasons: ON" : "🗂 Combine Qualities/Seasons: OFF", callback_data: "meta:grouptoggle" }],
    [{ text: miOn ? "📊 MediaInfo (Audio/Subs): ON" : "📊 MediaInfo: OFF", callback_data: "meta:mitoggle" }],
    [
      { text: shieldOn ? "🛡️ Link Shield: ON" : "🛡️ Link Shield: OFF", callback_data: "meta:shieldtoggle" },
      { text: protectOn ? "🔒 Forward Lock: ON" : "🔓 Forward Lock: OFF", callback_data: "meta:prottoggle" },
    ],
    [
      { text: "🔑 Set TMDb Key", callback_data: "meta:tmdb" },
      { text: "🔑 Set OMDb Key", callback_data: "meta:omdb" },
    ],
    [{ text: sampleUrl ? "🎬 Change Sample Channel Link" : "🎬 Set Sample Channel Link", callback_data: "meta:sample" }],
  ];
  if (sampleUrl) buttons.push([{ text: "🗑 Remove Sample Link", callback_data: "meta:rmsample" }]);
  buttons.push(...BACK_BUTTON);
  return { text, buttons };
}
// ---------- Shortlink & Tutorial settings menu ----------
async function buildShortlinkMenu(env, note) {
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  const on = (await getSetting(env, "shortlink_enabled")) === "1";
  const tut = await getSetting(env, "tutorial_url");

  let text = "🔗 <b>Shortlink & Tutorial Settings</b>\n\n" +
    "Users pass a copy-protected shortlink before they get a file or season batch.\n\n";
  text += `Status: ${on ? "✅ ON (Anti-Copy Mini App Shield Active)" : "❌ OFF"}\n`;
  text += `Domain: ${domain ? esc(domain) : "<i>not set</i>"}\n`;
  text += `API key: ${key ? "<code>" + esc(key.slice(0, 4)) + "••••</code>" : "<i>not set</i>"}\n`;
  text += `How to Verify Tutorial: ${tut ? esc(tut) : "<i>not set</i>"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: on ? "🔴 Turn OFF" : "🟢 Turn ON", callback_data: "sl:toggle" }],
    [{ text: "🌐 Set Domain", callback_data: "sl:domain" }, { text: "🔑 Set API Key", callback_data: "sl:key" }],
    [{ text: "🎬 Set Tutorial Link (How to Verify)", callback_data: "sl:tutorial" }],
  ];
  if (tut) buttons.push([{ text: "🗑 Remove Tutorial Link", callback_data: "sl:rmtut" }]);
  buttons.push(...BACK_BUTTON);
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
    await setSetting(env, "meta_enabled", "1");
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
  if (field === "tutorial_url" || field === "sample_url") {
    if (!/^https?:\/\/\S+/i.test(value) && !/^@\w+$/i.test(value)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Please send a valid channel link starting with https:// (like https://t.me/yourchannel) or @username, or /cancel.",
      });
      return;
    }
    if (value.startsWith("@")) value = `https://t.me/${value.slice(1)}`;
    await setSetting(env, field, value);
    await clearState(env, userId);
    const menu = field === "sample_url"
      ? await buildMetaMenu(env, "✅ Sample channel link saved!")
      : await buildShortlinkMenu(env, "✅ Tutorial link saved!");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: menu.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: menu.buttons },
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
const MIN_VERIFY_SECONDS = 10;
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
    lines.push(test ? "✅ Shortlink: working (Anti-Copy Shield ON)" : "⚠️ Shortlink: NOT working (users skip verification)");
  } else {
    lines.push("➖ Shortlink: off");
  }
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  lines.push(metaOn ? "✅ IMDb/TMDb: on" : "➖ IMDb/TMDb: off");
  const groupOn = (await getSetting(env, "group_qualities")) !== "0";
  lines.push(groupOn ? "✅ Multi-Quality & Series Batching: on" : "➖ Grouping: off");
  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
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

  // Anti-Bypass Shortlink Generator inside Telegram Mini App
  if (path === "/api/verify-link") {
    const tok = String(body.token || "").trim();
    const t = await env.DB.prepare("SELECT token, user_id, file_row_id, created FROM tokens WHERE token = ?")
      .bind(tok).first();
    if (!t || String(t.user_id) !== uid || Date.now() - t.created > 3600 * 1000) {
      return json({ error: "This verification session has expired. Please tap the button in the bot again." }, 400);
    }
    // Reset timer to the exact moment the user opened the verification mini-app
    await env.DB.prepare("UPDATE tokens SET created = ? WHERE token = ?").bind(Date.now(), tok).run();
    const username = await getBotUsername(env);
    const short = await shortenUrl(env, `https://t.me/${username}?start=v${tok}`);
    if (!short) return json({ error: "Verification server is busy. Please try again." }, 500);
    return json({ url: short });
  }

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

// ---------- Anti-Bypass Verification Mini App Page ----------
const VERIFY_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Secure Verification</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#0f172a);--text:var(--tg-theme-text-color,#f8fafc);--hint:var(--tg-theme-hint-color,#94a3b8);--accent:var(--tg-theme-button-color,#2563eb);--accent-text:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#1e293b)}
*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
body{margin:0;padding:24px 18px;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;display:flex;flex-direction:column;justify-content:center;min-height:92vh}
.card{background:var(--card);border-radius:18px;padding:24px 18px;box-shadow:0 8px 24px rgba(0,0,0,0.25)}
.icon{font-size:44px;margin-bottom:8px}
h1{font-size:20px;margin:6px 0}
p{color:var(--hint);font-size:14px;margin:8px 0 20px}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer}
.btn:disabled{opacity:0.6}
.err{color:#ef4444;font-size:14px;margin-top:12px}
</style></head>
<body oncontextmenu="return false;">
<div class="card" id="box">
  <div class="icon">🛡️</div>
  <h1 id="title">Preparing Secure Verification...</h1>
  <p id="desc">Please wait a moment while we generate your one-time verification session.</p>
  <button class="btn" id="go" style="display:none">🚀 Continue to Verification</button>
  <div class="err" id="err"></div>
</div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
var params = new URLSearchParams(location.search);
var token = params.get("t") || "";
var titleEl = document.getElementById("title");
var descEl = document.getElementById("desc");
var btnEl = document.getElementById("go");
var errEl = document.getElementById("err");

function launchShortlink(rawUrl) {
  var u = String(rawUrl || "").trim();
  if (!/^https?:\\/\\//i.test(u)) u = "https://" + u.replace(/^\\/+/, "");
  if (tg && typeof tg.openLink === "function") {
    tg.openLink(u, { try_instant_view: false });
    setTimeout(function() { try { tg.close(); } catch (e) {} }, 350);
  } else {
    window.open(u, "_blank", "noopener,noreferrer");
  }
}

if (!tg || !tg.initData) {
  titleEl.textContent = "🚫 Access Denied";
  descEl.textContent = "This verification link can only be opened directly inside the official Telegram app. External browsers and bypass tools are blocked.";
} else {
  fetch("/api/verify-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Init-Data": tg.initData },
    body: JSON.stringify({ token: token })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error || !d.url) {
      titleEl.textContent = "⚠️ Session Expired";
      descEl.textContent = d.error || "Please return to the bot and tap the button again.";
      return;
    }
    titleEl.textContent = "🛡️ Security Check Ready";
    descEl.textContent = "Tap the button below and complete the short step to unlock your file automatically.";
    btnEl.style.display = "block";
    btnEl.onclick = function() {
      btnEl.disabled = true;
      launchShortlink(d.url);
    };
  }).catch(function() {
    errEl.textContent = "Network error. Please close and try again.";
  });
}
</script></body></html>`;


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

// ---------- The Mini App page (Skip Ads / Premium) ----------
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
    // 1. Returning from Shortlink Verification: /start v<token>
    const tok = text.match(/^\/start v([A-Za-z0-9]+)/);
    if (tok) {
      const t = await env.DB.prepare("SELECT file_row_id, user_id, created FROM tokens WHERE token = ?")
        .bind(tok[1]).first();
      const fresh = t && Date.now() - t.created < 60 * 60 * 1000;
      if (!t || String(t.user_id) !== userId || !fresh) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ This verification link is invalid or has expired. Please tap the button on the channel post again.",
          parse_mode: "HTML",
        });
        return;
      }
      if (Date.now() - t.created < MIN_VERIFY_SECONDS * 1000) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Bypass detected! Please complete the verification steps properly without skipping.",
        });
        return;
      }
      const used = await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(tok[1]).run();
      if (!used.meta.changes) return;
      await env.DB.prepare("INSERT INTO verifications (user_id, file_row_id, day) VALUES (?, ?, ?)")
        .bind(userId, Math.abs(t.file_row_id), dayString(0)).run();

      // Negative file_row_id means it's a TV Series Season Batch
      if (t.file_row_id < 0) {
        const batch = await getBatchRow(env, -t.file_row_id);
        if (!batch) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that season batch is no longer available." });
        } else {
          await deliverBatch(env, chatId, msg.from.id, batch, true);
        }
      } else {
        const row = await getFileRow(env, t.file_row_id);
        if (!row) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
        } else {
          await deliverFile(env, chatId, msg.from.id, row, true);
        }
      }
      return;
    }

    // 2. Opening a Series Season Quality Batch from Channel: /start b12
    const bMatch = text.match(/^\/start b(\d+)/);
    if (bMatch) {
      const batch = await getBatchRow(env, Number(bMatch[1]));
      if (!batch) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that season batch is no longer available." });
      } else {
        await deliverBatch(env, chatId, msg.from.id, batch, false);
      }
      return;
    }

    // 3. Opening a Movie / Single File from Channel: /start f12
    const match = text.match(/^\/start f(\d+)/);
    if (match) {
      const row = await getFileRow(env, Number(match[1]));
      if (!row) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
      } else {
        await deliverFile(env, chatId, msg.from.id, row, false);
      }
      return;
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "👋 Hi! Select any quality button on our channel posts to get your Movie or Series Season instantly.\n\nOwner can use /settings to configure me.",
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

  // User tapped a File button, NEXT/PREVIOUS page, or Send All inside the DM File Menu
  if (action === "bep" || action === "ball" || action === "bpage") {
    if (userId !== String(env.OWNER_ID)) {
      const b = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(userId).first();
      if ((b && b.banned) || (await isRateLimited(env, userId, chatId))) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
        return;
      }
    }
    if (action === "bpage") {
      const batch = await getBatchRow(env, Number(parts[1]));
      if (!batch) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Menu expired.", show_alert: true });
        return;
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
      await sendBatchMenuToUser(env, chatId, batch, Number(parts[2]) || 0, messageId);
      return;
    }
    if (action === "bep") {
      const row = await getFileRow(env, Number(parts[1]));
      if (!row) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Episode no longer available.", show_alert: true });
        return;
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Sending episode..." });
      await sendFileToUser(env, chatId, row, false);
      return;
    }
    if (action === "ball") {
      const batch = await getBatchRow(env, Number(parts[1]));
      if (!batch) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Batch no longer available.", show_alert: true });
        return;
      }
      let items = [];
      try { items = JSON.parse(batch.items_json || "[]"); } catch (e) { items = []; }
      items.sort((a, b) => (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0));
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `Sending ${items.length} episodes...` });
      for (const ep of items) {
        const row = await getFileRow(env, ep.rowId);
        if (row) await sendFileToUser(env, chatId, row, true);
      }
      const rawMins = await getSetting(env, "delete_minutes");
      const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
      if (mins) {
        const notice = await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `⏳ <b>Auto-Delete Notice:</b> All episodes above will be deleted in <b>${formatDelay(mins)}</b>. Forward or share them to your Saved Messages now!`,
          parse_mode: "HTML",
        });
        if (notice.ok) {
          await env.DB.prepare("INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)")
            .bind(String(chatId), notice.result.message_id, Date.now() + mins * 60 * 1000).run();
        }
      }
      return;
    }
  }

  // ForceSub "I've Joined" check for Single File (chk) or Series Season Batch (chkb)
  if (action === "chk" || action === "chkb") {
    if (userId !== String(env.OWNER_ID)) {
      const b = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(userId).first();
      if ((b && b.banned) || (await isRateLimited(env, userId, chatId))) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
        return;
      }
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

    if (action === "chkb") {
      const batch = await getBatchRow(env, Number(parts[1]));
      if (batch) await deliverBatch(env, chatId, query.from.id, batch, false);
    } else {
      const row = await getFileRow(env, Number(parts[1]));
      if (row) await deliverFile(env, chatId, query.from.id, row, false);
    }
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
    const page = Number.isInteger(Number(parts[2])) ? Number(parts[2]) : 0;
    await showRoleMenu(env, chatId, messageId, parts[1], page);
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
        text: "✏️ Send the number of minutes (1 to 2820). For example, <code>5</code> means 5 minutes.",
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
    if (sub === "tmdb" || sub === "omdb" || sub === "sample") {
      const fieldName = sub === "sample" ? "sample_url" : `${sub}_key`;
      await setState(env, userId, `set:${fieldName}`);
      const prompt = sub === "tmdb"
        ? "🔑 Send your <b>TMDb API Key (v3 auth)</b> from themoviedb.org.\n\nI'll delete your message right after saving it."
        : sub === "omdb"
        ? "🔑 Send your <b>OMDb API Key</b> from omdbapi.com.\n\nI'll delete your message right after saving it."
        : "🎬 Send your <b>Sample Channel Link</b> (like <code>https://t.me/yoursamplechannel</code> or <code>@yoursamplechannel</code>).\n\nThis button will appear on all Movie & Series posts.";
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
    if (sub === "rmsample") {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'sample_url'").run();
      note = "🗑 Sample channel link removed.";
    }
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

  // Shortlink & Tutorial settings: sl:menu, sl:toggle, sl:domain, sl:key, sl:tutorial, sl:rmtut
  if (action === "sl") {
    const sub = parts[1];
    if (sub === "domain" || sub === "key" || sub === "tutorial") {
      const fieldMap = { domain: "shortlink_domain", key: "shortlink_key", tutorial: "tutorial_url" };
      await setState(env, userId, `set:${fieldMap[sub]}`);
      const prompts = {
        domain: "🌐 Send your shortlink domain (for example: <code>gplinks.in</code> or <code>shrinkme.io</code>).",
        key: "🔑 Send your shortlink API key. I'll delete your message right after saving it.",
        tutorial: "🎬 Send the link to your <b>How to Verify</b> tutorial video/post (for example: <code>https://t.me/yourchannel/123</code>).",
      };
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: prompts[sub],
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "sl:menu" }]] },
      });
      return;
    }
    let note = "";
    if (sub === "rmtut") {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'tutorial_url'").run();
      note = "🗑 Tutorial link removed.";
    }
    if (sub === "toggle") {
      const on = (await getSetting(env, "shortlink_enabled")) === "1";
      if (on) {
        await setSetting(env, "shortlink_enabled", "0");
      } else {
        const d = await getSetting(env, "shortlink_domain");
        const k = await getSetting(env, "shortlink_key");
        if (!d || !k) {
          note = "⚠️ Set both your Domain and API Key first.";
        } else {
          await setSetting(env, "shortlink_enabled", "1");
        }
      }
    }
    await clearState(env, userId);
    await showShortlinkMenu(env, chatId, messageId, note);
    return;
  }
}

// ---------- Filename, Quality, Audio & Season/Episode Parser ----------
function parseMediaFilename(rawName, rawCaption) {
  const full = `${rawName || ""} ${rawCaption || ""}`;
  const rawFirstLine = (rawName || (rawCaption || "").split("\n")[0] || "Untitled")
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/^(\[@[^\]]+\]|\[[^\]]+\]|\(@[^)]+\))\s*/g, "")
    .trim();

  let isSeries = false;
  let season = null;
  let episode = null;

  const seMatch =
    full.match(/\bS(\d{1,2})[\s._-]*E(?:P)?(\d{1,3})\b/i) ||
    full.match(/\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i);
  const epRangeMatch = full.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})[\s._-]*[-~][\s._-]*E?(\d{1,3})\b/i);
  const sOnlyMatch =
    full.match(/\bS(\d{1,2})\b(?![\s._-]*E\d)/i) ||
    full.match(/\bSeason[\s._-]*(\d{1,2})\b/i);
  const epOnlyMatch = full.match(/\b(?:EP|Episode)[\s._-]*(\d{1,3})\b/i);

  if (seMatch) {
    isSeries = true;
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
  } else if (epRangeMatch) {
    isSeries = true;
    season = parseInt(epRangeMatch[1], 10);
    episode = parseInt(epRangeMatch[2], 10);
  } else if (sOnlyMatch) {
    isSeries = true;
    season = parseInt(sOnlyMatch[1], 10);
    if (epOnlyMatch) episode = parseInt(epOnlyMatch[1], 10);
  } else if (epOnlyMatch) {
    isSeries = true;
    season = 1;
    episode = parseInt(epOnlyMatch[1], 10);
  }

  let quality = "HD";
  if (/\b(2160p|4k|uhd)\b/i.test(full)) quality = "2160p 4K";
  else if (/\b1440p\b/i.test(full)) quality = "1440p";
  else if (/\b1080p\b/i.test(full)) quality = "1080p";
  else if (/\b720p\b/i.test(full)) quality = "720p";
  else if (/\b480p\b/i.test(full)) quality = "480p";
  else if (/\b360p\b/i.test(full)) quality = "360p";

  let source = "";
  if (/\bblu[\s._-]?ray|bdrip|brrip\b/i.test(full)) source = "BluRay";
  else if (/\bweb[\s._-]?dl\b/i.test(full)) source = "WEB-DL";
  else if (/\bweb[\s._-]?rip\b/i.test(full)) source = "WEBRip";
  else if (/\bhdrip\b/i.test(full)) source = "HDRip";
  else if (/\bhdcam|camrip\b/i.test(full)) source = "HDCAM";

  let vCodec = "";
  if (/\b(x265|h\.?265|hevc)\b/i.test(full)) vCodec = "HEVC x265";
  else if (/\b(x264|h\.?264|avc)\b/i.test(full)) vCodec = "x264";
  else if (/\bav1\b/i.test(full)) vCodec = "AV1";

  let aCodec = "";
  if (/\batmos\b/i.test(full)) aCodec = "Atmos";
  else if (/\b(ddp|eac3|dd\+|5\.1)\b/i.test(full)) aCodec = "DD+ 5.1";
  else if (/\baac\b/i.test(full)) aCodec = "AAC";

  const langMap = [
    [/\bhindi\b|\bhin\b/i, "Hindi"],
    [/\benglish\b|\beng\b/i, "English"],
    [/\btamil\b|\btam\b/i, "Tamil"],
    [/\btelugu\b|\btel\b/i, "Telugu"],
    [/\bmalayalam\b|\bmal\b/i, "Malayalam"],
    [/\bkannada\b|\bkan\b/i, "Kannada"],
    [/\bbengali\b|\bben\b/i, "Bengali"],
    [/\bmarathi\b|\bmar\b/i, "Marathi"],
    [/\bpunjabi\b|\bpun\b/i, "Punjabi"],
    [/\bkorean\b|\bkor\b/i, "Korean"],
    [/\bjapanese\b|\bjap\b|\bjpn\b/i, "Japanese"],
    [/\bspanish\b|\bspa\b/i, "Spanish"],
    [/\brussian\b|\brus\b/i, "Russian"],
    [/\bdual[\s._-]*audio\b/i, "Dual Audio"],
    [/\bmulti[\s._-]*audio\b/i, "Multi Audio"],
  ];
  const audioLangs = [];
  for (const [rx, label] of langMap) {
    if (rx.test(full) && !audioLangs.includes(label)) audioLangs.push(label);
  }

  let year = null;
  const yearMatch = rawFirstLine.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) year = yearMatch[1];

  // Strip "Sample", languages, qualities, and tags so Sample & all Languages share the EXACT same groupKey!
  let cleanTitle = rawFirstLine
    .replace(/\bS\d{1,2}[\s._-]*E(?:P)?\d{1,3}.*$/i, "")
    .replace(/\bS\d{1,2}\b.*$/i, "")
    .replace(/\bSeason[\s._-]*\d{1,2}.*$/i, "")
    .replace(/\b(?:EP|Episode)[\s._-]*\d{1,3}.*$/i, "")
    .replace(/\b(19\d{2}|20\d{2})\b.*$/, "")
    .replace(/\b(sample|trailer|teaser|promo|hq|proper|repack|2160p|1440p|1080p|720p|480p|360p|4k|uhd|web-?dl|web-?rip|bluray|bdrip|brrip|hdrip|hdcam|camrip|x264|x265|h264|h265|hevc|avc|10bit|dual|multi|hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|korean|japanese|spanish|russian|hin|eng|tam|tel|mal|kan|esub|esubs|aac|ddp|eac3|atmos).*$/i, "")
    .replace(/[()[\]\-_.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanTitle) cleanTitle = rawFirstLine.slice(0, 40).trim() || "Untitled";

  const slug = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const groupKey = isSeries
    ? `series:${slug}:${year || "na"}:s${String(season || 1).padStart(2, "0")}`
    : `movie:${slug}:${year || "na"}`;

  return {
    cleanTitle,
    displayFileName: rawFirstLine,
    year,
    isSeries,
    season: isSeries ? (season || 1) : null,
    episode,
    quality,
    source,
    vCodec,
    aCodec,
    audioLangs,
    groupKey,
  };
}

// ---------- Fetch TMDb & OMDb (IMDb) Metadata ----------
async function fetchMediaMeta(env, info) {
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  if (!metaOn) return null;

  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");
  const out = {
    title: info.cleanTitle,
    year: info.year || "",
    rating: "",
    genres: "",
    plot: "",
    poster: "",
    type: info.isSeries ? "TV Series" : "Movie",
  };

  if (tmdbKey) {
    try {
      const endpoint = info.isSeries ? "tv" : "movie";
      const yParam = info.year
        ? (info.isSeries ? `&first_air_date_year=${info.year}` : `&year=${info.year}`)
        : "";
      const url = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(info.cleanTitle)}${yParam}`;
      const res = await fetch(url);
      const data = await res.json();
      const hit = data.results && data.results[0];
      if (hit) {
        out.title = hit.title || hit.name || out.title;
        const dateStr = hit.release_date || hit.first_air_date || "";
        if (dateStr) out.year = dateStr.slice(0, 4);
        if (hit.vote_average) out.rating = `${Number(hit.vote_average).toFixed(1)}/10`;
        if (hit.overview) out.plot = hit.overview.slice(0, 240) + (hit.overview.length > 240 ? "..." : "");
        if (hit.backdrop_path || hit.poster_path) {
          out.poster = `https://image.tmdb.org/t/p/w780${hit.poster_path || hit.backdrop_path}`;
        }
      }
    } catch (err) {
      console.log("TMDb lookup error:", err);
    }
  }

  if (omdbKey) {
    try {
      const oType = info.isSeries ? "series" : "movie";
      const yParam = info.year ? `&y=${info.year}` : "";
      const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbKey)}&t=${encodeURIComponent(info.cleanTitle)}&type=${oType}${yParam}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.Response === "True") {
        out.title = data.Title || out.title;
        if (data.Year && !out.year) out.year = data.Year.slice(0, 4);
        if (data.imdbRating && data.imdbRating !== "N/A") out.rating = `${data.imdbRating}/10`;
        if (data.Genre && data.Genre !== "N/A") out.genres = data.Genre;
        if (!out.plot && data.Plot && data.Plot !== "N/A") out.plot = data.Plot.slice(0, 240);
        if (!out.poster && data.Poster && data.Poster.startsWith("http")) out.poster = data.Poster;
      }
    } catch (err) {
      console.log("OMDb lookup error:", err);
    }
  }

  return out;
}

// ---------- Build Channel Post Caption & Inline Keyboard ----------
const QUALITY_ORDER = ["360p", "480p", "720p", "1080p", "1440p", "2160p 4K", "HD"];

function sortQualities(a, b) {
  const ia = QUALITY_ORDER.indexOf(a);
  const ib = QUALITY_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
}

async function buildChannelPostView(env, meta, info, items, showMediaInfo, sampleRowId, batchId) {
  const titleText = (meta && meta.title) ? meta.title : info.cleanTitle;
  const yearText = (meta && meta.year) || info.year;
  const headerTitle = yearText ? `${titleText} (${yearText})` : titleText;
  const sTag = info.isSeries ? ` — Season ${String(info.season || 1).padStart(2, "0")}` : "";

  const lines = [
    `🎬 <b>${esc(headerTitle)}${esc(sTag)}</b>`,
  ];

  if (meta) {
    const badges = [];
    if (meta.rating) badges.push(`⭐ <b>IMDb:</b> ${esc(meta.rating)}`);
    if (meta.type) badges.push(`📺 <b>Type:</b> ${esc(meta.type)}`);
    if (badges.length) lines.push(badges.join("  |  "));
    if (meta.genres) lines.push(`🎭 <b>Genre:</b> ${esc(meta.genres)}`);
  }

  const allLangs = [];
  const allQuals = [];
  const allCodecs = [];
  for (const it of items) {
    if (it.quality && !allQuals.includes(it.quality)) allQuals.push(it.quality);
    for (const l of it.audioLangs || []) {
      if (!allLangs.includes(l)) allLangs.push(l);
    }
    const cStr = [it.source, it.vCodec, it.aCodec].filter(Boolean).join(" ");
    if (cStr && !allCodecs.includes(cStr)) allCodecs.push(cStr);
  }
  allQuals.sort(sortQualities);

  if (showMediaInfo) {
    if (allLangs.length) lines.push(`🔊 <b>Audio:</b> ${esc(allLangs.join(", "))}`);
    if (allQuals.length) lines.push(`💿 <b>Qualities:</b> ${esc(allQuals.join(" | "))}`);
    if (allCodecs.length) lines.push(`⚙️ <b>Format:</b> ${esc(allCodecs[0])}`);
    if (items.length) lines.push(`📂 <b>Total Files:</b> ${items.length}`);
  }

  if (meta && meta.plot) {
    lines.push(`\n📝 <i>${esc(meta.plot)}</i>`);
  }

  lines.push("");
  lines.push(`⬇️ <b>Tap below to view all files & download:</b>`);

  const buttons = [];

  const sampleChannelUrl = await getSetting(env, "sample_url");
  if (sampleChannelUrl) {
    buttons.push([{ text: "🎬 Watch Sample Video", url: sampleChannelUrl }]);
  } else if (sampleRowId) {
    const sampleLink = await makeDeepLink(env, `f${sampleRowId}`);
    buttons.push([{ text: "🎬 Watch Sample Video", url: sampleLink }]);
  }

  if (batchId) {
    const dlLink = await makeDeepLink(env, `b${batchId}`);
    const countLabel = items.length > 1 ? ` (${items.length} Files)` : "";
    buttons.push([{ text: `📥 Download Now${countLabel}`, url: dlLink }]);
  }

  return { caption: lines.join("\n"), buttons };
}

// ---------- Upsert Master Batch in D1 (Used for both Movies & Series) ----------
async function upsertSeasonBatch(env, groupKey, quality, title, epEntry) {
  await ensureExtraTables(env);
  const existing = await env.DB.prepare(
    "SELECT batch_id, items_json FROM batches WHERE group_key = ? AND quality = ?"
  ).bind(groupKey, quality).first();

  if (!existing) {
    const items = epEntry ? [epEntry] : [];
    const ins = await env.DB.prepare(
      "INSERT INTO batches (group_key, quality, title, items_json, updated) VALUES (?, ?, ?, ?, ?)"
    ).bind(groupKey, quality, title, JSON.stringify(items), Date.now()).run();
    return ins.meta.last_row_id;
  }

  if (!epEntry) return existing.batch_id;

  let items = [];
  try { items = JSON.parse(existing.items_json || "[]"); } catch (e) { items = []; }

  const idx = items.findIndex((x) => x.rowId === epEntry.rowId);
  if (idx >= 0) items[idx] = epEntry;
  else items.push(epEntry);

  await env.DB.prepare(
    "UPDATE batches SET title = ?, items_json = ?, updated = ? WHERE batch_id = ?"
  ).bind(title, JSON.stringify(items), Date.now(), existing.batch_id).run();

  return existing.batch_id;
}

// ---------- Handling Source Channel Uploads ----------
async function handleChannelPost(post, env) {
  const sources = await getChannels(env, "source");
  if (!sources.some((s) => String(s.chat_id) === String(post.chat.id))) return;
  if (!(await isTrustedSender(env, post))) return;

  const info = classifyPost(post);
  if (!info) return;

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

  if (info.kind === "pdf") {
    const targets = await getChannels(env, "pdfs");
    if (!targets.length) return;
    const targetChat = targets[0].chat_id;
    const cover = await getSetting(env, "cover_pdf");
    const link = await makeDeepLink(env, `f${rowId}`);
    const caption = `📄 <b>${esc(title)}</b>\n📦 <b>Size:</b> ${formatSize(info.file.file_size)}`;
    const markup = { inline_keyboard: [[{ text: "📥 Download PDF", url: link }]] };

    if (cover) {
      await tg(env, "sendPhoto", {
        chat_id: targetChat, photo: cover, caption, parse_mode: "HTML", reply_markup: markup,
      });
    } else {
      await tg(env, "sendMessage", {
        chat_id: targetChat, text: caption, parse_mode: "HTML", reply_markup: markup,
      });
    }
    return;
  }

  const targets = (await getChannels(env, "lectures")).slice(0, 50);
  if (!targets.length) return;

  await ensureExtraTables(env);
  const fullText = `${info.name || ""} ${post.caption || ""}`;
  const isSample = /\bsample\b/i.test(fullText);
  const parsed = parseMediaFilename(info.name, post.caption || "");
  const groupOn = (await getSetting(env, "group_qualities")) !== "0";
  const showMediaInfo = (await getSetting(env, "mediainfo_enabled")) !== "0";

  const existingPost = groupOn
    ? await env.DB.prepare("SELECT * FROM media_posts WHERE group_key = ?").bind(parsed.groupKey).first()
    : null;

  let meta = null;
  let items = [];
  let sampleRowId = null;

  if (existingPost) {
    try { meta = JSON.parse(existingPost.meta_json || "null"); } catch (e) { meta = null; }
    try { items = JSON.parse(existingPost.items_json || "[]"); } catch (e) { items = []; }
    if (meta && meta.sampleRowId) sampleRowId = meta.sampleRowId;
  } else {
    meta = await fetchMediaMeta(env, parsed);
  }
  if (!meta) {
    meta = {
      title: parsed.cleanTitle,
      year: parsed.year || "",
      rating: "",
      genres: "",
      plot: "",
      poster: "",
      type: parsed.isSeries ? "TV Series" : "Movie",
    };
  }

  const displayTitle = meta.title
    ? (parsed.isSeries ? `${meta.title} S${String(parsed.season || 1).padStart(2, "0")}` : `${meta.title}${meta.year ? " " + meta.year : ""}`)
    : (parsed.isSeries ? `${parsed.cleanTitle} S${String(parsed.season || 1).padStart(2, "0")}` : parsed.cleanTitle);

  let batchId = null;

  if (isSample) {
    sampleRowId = rowId;
    meta.sampleRowId = sampleRowId;
    batchId = await upsertSeasonBatch(env, parsed.groupKey, "ALL", displayTitle, null);
  } else {
    const newItem = {
      rowId,
      fileName: parsed.displayFileName,
      quality: parsed.quality,
      season: parsed.season,
      episode: parsed.episode,
      size: info.file.file_size || 0,
      source: parsed.source,
      vCodec: parsed.vCodec,
      aCodec: parsed.aCodec,
      audioLangs: parsed.audioLangs,
    };

    batchId = await upsertSeasonBatch(env, parsed.groupKey, "ALL", displayTitle, newItem);
    newItem.batchId = batchId;

    const idx = items.findIndex((x) => x.rowId === rowId);
    if (idx >= 0) items[idx] = newItem;
    else items.push(newItem);
  }

  meta.sampleRowId = sampleRowId;
  meta.batchId = batchId;

  const view = await buildChannelPostView(env, meta, parsed, items, showMediaInfo, sampleRowId, batchId);

  const chanMap = {};
  if (groupOn) {
    const chRows = await env.DB.prepare(
      "SELECT chat_id, message_id, has_photo FROM media_post_channels WHERE group_key = ?"
    ).bind(parsed.groupKey).all();
    for (const r of chRows.results || []) {
      chanMap[String(r.chat_id)] = { message_id: r.message_id, has_photo: r.has_photo };
    }
    if (existingPost && existingPost.chat_id && existingPost.message_id && !chanMap[String(existingPost.chat_id)]) {
      chanMap[String(existingPost.chat_id)] = {
        message_id: existingPost.message_id,
        has_photo: existingPost.has_photo,
      };
    }
  }

  const fallbackCover = await getSetting(env, "cover_lecture");
  let photoSource = (meta && meta.poster) || fallbackCover || null;
  let firstMsgId = existingPost ? existingPost.message_id : 0;
  let firstChatId = existingPost ? existingPost.chat_id : "";
  let firstHasPhoto = existingPost ? existingPost.has_photo : 0;
  let anySuccess = false;

  for (const t of targets) {
    const targetChat = String(t.chat_id);
    const prev = chanMap[targetChat];

    if (groupOn && prev && prev.message_id) {
      const editMethod = prev.has_photo ? "editMessageCaption" : "editMessageText";
      const editPayload = {
        chat_id: targetChat,
        message_id: prev.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: view.buttons },
      };
      if (prev.has_photo) editPayload.caption = view.caption;
      else editPayload.text = view.caption;

      const edited = await tg(env, editMethod, editPayload);
      if (edited.ok || /message is not modified/i.test(edited.description || "")) {
        anySuccess = true;
        continue;
      }
    }

    let sent = null;
    let hasPhoto = 0;

    if (photoSource) {
      sent = await tg(env, "sendPhoto", {
        chat_id: targetChat,
        photo: photoSource,
        caption: view.caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: view.buttons },
      });
      if (sent.ok) {
        hasPhoto = 1;
        if (sent.result.photo && sent.result.photo.length) {
          photoSource = sent.result.photo[sent.result.photo.length - 1].file_id;
        }
      }
    }

    if (!sent || !sent.ok) {
      sent = await tg(env, "sendMessage", {
        chat_id: targetChat,
        text: view.caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: view.buttons },
      });
    }

    if (sent && sent.ok) {
      anySuccess = true;
      if (!firstMsgId) {
        firstMsgId = sent.result.message_id;
        firstChatId = targetChat;
        firstHasPhoto = hasPhoto;
      }
      if (groupOn) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO media_post_channels (group_key, chat_id, message_id, has_photo) VALUES (?, ?, ?, ?)"
        ).bind(parsed.groupKey, targetChat, sent.result.message_id, hasPhoto).run();
      }
    }
  }

  if (anySuccess && groupOn) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO media_posts (group_key, chat_id, message_id, has_photo, meta_json, items_json, updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      parsed.groupKey,
      String(firstChatId),
      firstMsgId,
      firstHasPhoto,
      JSON.stringify(meta),
      JSON.stringify(items),
      Date.now()
    ).run();
  }
}

// ---------- Constant-time string compare for webhook & HMAC ----------
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------- Cloudflare Worker Entrypoint ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    APP_ORIGIN = url.origin;

    // 1. Anti-Bypass Verification Mini App Page
    if (request.method === "GET" && url.pathname === "/verify") {
      return new Response(VERIFY_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // 2. Skip-Ads / Premium Mini App Page
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(APP_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // 3. Worker Redirect Shield for Channel Buttons (/get/f12 or /get/b5)
    if (request.method === "GET" && url.pathname.startsWith("/get/")) {
      const startParam = url.pathname.slice(5).replace(/[^A-Za-z0-9_-]/g, "");
      const username = await getBotUsername(env);
      if (!username || !startParam) return new Response("Not found", { status: 404 });
      return Response.redirect(`https://t.me/${username}?start=${startParam}`, 302);
    }

    // 4. Mini App JSON APIs (/api/verify-link, /api/me, /api/pay, /api/stars, /api/utr)
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url.pathname);
    }

    // 5. Telegram Webhook Endpoint
    if (request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (env.WEBHOOK_SECRET && !safeEqual(secret, env.WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        if (update.pre_checkout_query) {
          await handlePreCheckout(update.pre_checkout_query, env);
        } else if (update.message) {
          await handleMessage(update.message, env);
        } else if (update.channel_post) {
          await handleChannelPost(update.channel_post, env);
        } else if (update.callback_query) {
          await handleButton(update.callback_query, env);
        }
      } catch (err) {
        console.log("Webhook error:", String(err).split(env.BOT_TOKEN).join("***"));
      }
      return new Response("OK");
    }

    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
