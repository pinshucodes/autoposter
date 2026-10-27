export const TZ_OFFSET_MIN = 330;
export const MIN_VERIFY_SECONDS = 10;
export const RATE_MAX = 8;
export const RATE_WINDOW_MS = 10000;

export const ROLES = {
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

export const PLANS = {
  week: { name: "1 Week", price: 20, days: 7 },
  month: { name: "1 Month", price: 60, days: 30 },
  two: { name: "2 Months", price: 100, days: 60 },
  year: { name: "1 Year", price: 500, days: 365 },
};

export const STAR_DEFAULTS = { week: 12, month: 35, two: 58, year: 290 };

export let APP_ORIGIN = null;
export function setAppOrigin(origin) { APP_ORIGIN = origin; }

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function dayString(daysAgo = 0) {
  const t = Date.now() + TZ_OFFSET_MIN * 60000 - daysAgo * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtDate(ms) {
  return new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

export function formatSize(bytes) {
  if (!bytes) return "Unknown";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(0) + " MB";
}

export function formatDelay(mins) {
  if (!mins) return "Off";
  if (mins >= 60 && mins % 60 === 0) {
    const h = mins / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${mins} min`;
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function tg(env, method, data, retried = false) {
  let json;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
    const raw = (await res.text()).trim();
    try {
      json = JSON.parse(raw);
    } catch (_) {
      return { ok: false, error_code: res.status, description: `Non-JSON Telegram response: ${raw.slice(0, 120)}` };
    }
  } catch (err) {
    return { ok: false, error_code: 0, description: String(err).split(env.BOT_TOKEN).join("***") };
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

let SCHEMA_READY = false;
export async function ensureExtraTables(env) {
  if (SCHEMA_READY) return;
  try {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS media_posts (group_key TEXT PRIMARY KEY, chat_id TEXT, message_id INTEGER, has_photo INTEGER, meta_json TEXT, items_json TEXT, updated INTEGER)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS media_post_channels (group_key TEXT, chat_id TEXT, message_id INTEGER, has_photo INTEGER, PRIMARY KEY (group_key, chat_id))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS batches (batch_id INTEGER PRIMARY KEY AUTOINCREMENT, group_key TEXT, quality TEXT, title TEXT, items_json TEXT, updated INTEGER)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_gk_q ON batches(group_key, quality)"),
    ]);
    SCHEMA_READY = true;
  } catch (err) {
    console.log("Table init note:", err);
  }
}

export async function getSetting(env, key) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
}

export async function getChannels(env, role) {
  const r = await env.DB.prepare("SELECT chat_id, title, link FROM channels WHERE role = ?").bind(role).all();
  return r.results || [];
}

export async function addChannel(env, role, chatId, title, link) {
  const steps = [];
  if (!ROLES[role].multi) steps.push(env.DB.prepare("DELETE FROM channels WHERE role = ?").bind(role));
  steps.push(env.DB.prepare("INSERT OR REPLACE INTO channels (role, chat_id, title, link) VALUES (?, ?, ?, ?)").bind(role, String(chatId), title, link || null));
  await env.DB.batch(steps);
}

export async function removeChannel(env, role, chatId) {
  await env.DB.prepare("DELETE FROM channels WHERE role = ? AND chat_id = ?").bind(role, String(chatId)).run();
}

export async function setState(env, userId, action) {
  await env.DB.prepare("INSERT OR REPLACE INTO state (user_id, action) VALUES (?, ?)").bind(String(userId), action).run();
}

export async function getState(env, userId) {
  const r = await env.DB.prepare("SELECT action FROM state WHERE user_id = ?").bind(String(userId)).first();
  return r ? r.action : null;
}

export async function clearState(env, userId) {
  await env.DB.prepare("DELETE FROM state WHERE user_id = ?").bind(String(userId)).run();
}

export async function saveFile(env, f) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO files (file_id, file_unique_id, kind, send_as, title, size) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(f.file_id, f.file_unique_id, f.kind, f.send_as, f.title, f.size).run();
  if (r.meta.changes > 0) return r.meta.last_row_id;
  const ex = await env.DB.prepare("SELECT id FROM files WHERE file_unique_id = ?").bind(f.file_unique_id).first();
  return ex ? ex.id : null;
}

export async function getFileRow(env, id) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
}

export async function getBatchRow(env, batchId) {
  await ensureExtraTables(env);
  return env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?").bind(batchId).first();
}

let CACHED_BOT_USERNAME = null;
export async function getBotUsername(env) {
  if (CACHED_BOT_USERNAME) return CACHED_BOT_USERNAME;
  const me = await tg(env, "getMe", {});
  if (me.ok && me.result.username) {
    CACHED_BOT_USERNAME = me.result.username;
    await setSetting(env, "bot_username", CACHED_BOT_USERNAME);
    return CACHED_BOT_USERNAME;
  }
  return (await getSetting(env, "bot_username")) || "";
}

export async function makeDeepLink(env, startParam) {
  const shieldOn = (await getSetting(env, "shield_redirect")) !== "0";
  if (shieldOn && APP_ORIGIN) return `${APP_ORIGIN}/get/${startParam}`;
  const username = await getBotUsername(env);
  return `https://t.me/${username}?start=${startParam}`;
}

export async function alertOwner(env, key, text) {
  try {
    const last = parseInt((await getSetting(env, `alert_${key}`)) || "0", 10);
    if (Date.now() - last < 30 * 60 * 1000) return;
    await setSetting(env, `alert_${key}`, String(Date.now()));
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `🚨 ${text}` });
  } catch (err) {
    console.log("Alert failed:", err);
  }
}

export async function isRateLimited(env, userId, chatId) {
  const now = Date.now();
  const r = await env.DB.prepare("SELECT window_start, count FROM rate WHERE user_id = ?").bind(String(userId)).first();
  if (!r || now - r.window_start > RATE_WINDOW_MS) {
    await env.DB.prepare("INSERT OR REPLACE INTO rate (user_id, window_start, count) VALUES (?, ?, 1)").bind(String(userId), now).run();
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

export async function recordUser(env, from) {
  const r = await env.DB.prepare(
    "INSERT INTO users (user_id, first_name, joined_day, last_seen, active) VALUES (?, ?, ?, ?, 1) " +
    "ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, last_seen = excluded.last_seen, active = 1 RETURNING banned"
  ).bind(String(from.id), from.first_name || "", dayString(0), Date.now()).first();
  return !!(r && r.banned);
}

// ---------- Subscriptions ----------
export async function getStarPrices(env) {
  const out = {};
  for (const key of Object.keys(PLANS)) {
    const v = parseInt((await getSetting(env, `stars_${key}`)) || "", 10);
    out[key] = v > 0 ? v : STAR_DEFAULTS[key];
  }
  return out;
}

export async function starsEnabled(env) {
  return (await getSetting(env, "stars_off")) !== "1";
}

export async function getSubExpiry(env, userId) {
  const r = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  return r && r.expires_at > Date.now() ? r.expires_at : 0;
}

export async function hasActiveSub(env, userId) {
  return (await getSubExpiry(env, userId)) > 0;
}

export async function activateSubscription(env, userId, planKey) {
  const cur = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE user_id = ?").bind(String(userId)).first();
  const start = Math.max(Date.now(), cur ? cur.expires_at : 0);
  const expires = start + PLANS[planKey].days * 86400000;
  await env.DB.prepare("INSERT OR REPLACE INTO subscriptions (user_id, expires_at, plan) VALUES (?, ?, ?)").bind(String(userId), expires, planKey).run();
  return expires;
}

// ---------- Shortlink & ForceSub ----------
export async function shortlinkReady(env) {
  const on = await getSetting(env, "shortlink_enabled");
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  return on === "1" && !!domain && !!key;
}

export async function shortenUrl(env, longUrl) {
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  if (!domain || !key) return null;

  let cleanDomain = String(domain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  cleanDomain = cleanDomain.split("/")[0].split("?")[0].split("#")[0].trim();

  let cleanKey = String(key).trim();
  cleanKey = cleanKey.replace(/^["']+|["']+$/g, "").trim();
  cleanKey = cleanKey.replace(/^api[=:]/i, "").trim();
  cleanKey = cleanKey.replace(/^["']+|["']+$/g, "").trim();
  if (!cleanDomain || !cleanKey) return null;

  const isHttp = (/^http:\/\//i.test(String(domain).trim()) || cleanDomain.startsWith("127.0.0.1") || cleanDomain.startsWith("localhost")) && !String(domain).includes("linkmorph");
  const proto = isHttp ? "http" : "https";

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
  };

  const parseShortUrl = (data) => {
    if (!data || typeof data !== "object") return null;
    const findStr = (obj) => {
      if (!obj || typeof obj !== "object") return null;
      return (
        obj.shortenedUrl ||
        obj.shortUrl ||
        obj.short_url ||
        obj.shortened_url ||
        obj.shorturl ||
        obj.url ||
        obj.link ||
        obj.short ||
        obj.alias
      );
    };

    let candidate = findStr(data);
    if (!candidate && Array.isArray(data) && data[0]) {
      candidate = findStr(data[0]);
    }
    if (!candidate && data.data && typeof data.data === "object") {
      candidate = findStr(data.data);
    }
    if (!candidate && data.result && typeof data.result === "object") {
      candidate = findStr(data.result);
    }
    if (!candidate && Array.isArray(data.links) && data.links[0]) {
      candidate = findStr(data.links[0]);
    }
    if (!candidate && Array.isArray(data.results) && data.results[0]) {
      candidate = findStr(data.results[0]);
    }
    if (!candidate && Array.isArray(data.data) && data.data[0]) {
      candidate = findStr(data.data[0]);
    }
    if (!candidate && Array.isArray(data.result) && data.result[0]) {
      candidate = findStr(data.result[0]);
    }

    if (candidate && typeof candidate === "string") {
      let result = candidate.trim();
      if (!result || result.toLowerCase() === "null" || result.toLowerCase() === "undefined" || result.toLowerCase() === "false") return null;
      if (/^\/\//.test(result)) {
        result = `${proto}:${result}`;
      }
      if (/^https?:\/\//i.test(result)) {
        if (/^http:\/\//i.test(result) && (cleanDomain.includes("linkmorph") || result.includes("linkmorph"))) {
          result = result.replace(/^http:\/\//i, "https://");
        }
        return result;
      }
      if (result.startsWith(cleanDomain)) {
        return `${proto}://${result.replace(/^\/+/, "")}`;
      }
      return `${proto}://${cleanDomain}/${result.replace(/^\/+/, "")}`;
    }
    return null;
  };

  const parsePlainText = (text) => {
    if (!text || typeof text !== "string") return null;
    let t = text.trim();
    if (!t || t.includes("<") || t.includes("\n") || t.includes(" ") || t.length > 256) {
      return null;
    }
    const lower = t.toLowerCase();
    if (lower === "null" || lower === "undefined" || lower === "error" || lower === "failed" || lower === "false" || lower === "0") {
      return null;
    }
    if (/^\/\//.test(t)) return `${proto}:${t}`;
    if (/^https?:\/\//i.test(t)) {
      if (/^http:\/\//i.test(t) && (cleanDomain.includes("linkmorph") || t.includes("linkmorph"))) {
        t = t.replace(/^http:\/\//i, "https://");
      }
      return t;
    }
    if (t.startsWith(cleanDomain)) return `${proto}://${t.replace(/^\/+/, "")}`;
    if (/^[A-Za-z0-9_\-\/]+$/.test(t)) return `${proto}://${cleanDomain}/${t.replace(/^\/+/, "")}`;
    return null;
  };

  // 1. LinkMorph native REST API (Endpoint 2: /api/v1/links/batch)
  const isLinkMorph = cleanDomain.includes("linkmorph") || cleanKey.startsWith("lm_api_");
  const lmHost = cleanDomain.includes("linkmorph") ? cleanDomain : "linkmorph.in";
  if (isLinkMorph) {
    try {
      const lmRes = await fetch(`https://${lmHost}/api/v1/links/batch`, {
        method: "POST",
        headers: {
          ...headers,
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [longUrl] }),
        signal: AbortSignal.timeout(8000),
      });
      const rawText = (await lmRes.text()).trim();
      if (lmRes.ok) {
        const plain = parsePlainText(rawText);
        if (plain) return plain;
      }
      try {
        const data = JSON.parse(rawText);
        const url = parseShortUrl(data);
        if (url) return url;
        if (data && (data.error || data.message || data.status === "error")) {
          console.log(`LinkMorph error (${lmRes.status}):`, data.message || data.error);
        }
      } catch (_) {
        console.log(`LinkMorph non-JSON (${lmRes.status}):`, rawText.slice(0, 250));
      }
    } catch (err) {
      console.log("LinkMorph fetch error:", err.message || String(err));
    }
  }

  // 2. Standard ShortX / GET endpoint: /api?api=...&url=...
  try {
    const api = `${proto}://${cleanDomain}/api?api=${encodeURIComponent(cleanKey)}&url=${encodeURIComponent(longUrl)}`;
    const res = await fetch(api, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
    const rawText = (await res.text()).trim();

    if (res.ok) {
      const plain = parsePlainText(rawText);
      if (plain) return plain;
    }

    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      console.log(`Shortlink non-JSON (${res.status}) from ${cleanDomain}:`, rawText.slice(0, 250));
    }

    if (data) {
      const url = parseShortUrl(data);
      if (url) return url;
      if (data.status === "error" || data.error || data.message) {
        console.log(`Shortlink error from ${cleanDomain}:`, data.message || data.error || data.status);
      } else {
        console.log("Shortlink JSON unrecognized:", rawText.slice(0, 250));
      }
    }
  } catch (err) {
    console.log("Shortlink GET fetch error:", err.message || String(err));
  }

  // 3. Fallback: if not explicitly detected as LinkMorph by domain/key, try batch endpoint
  if (!isLinkMorph) {
    try {
      const lmRes = await fetch(`${proto}://${cleanDomain}/api/v1/links/batch`, {
        method: "POST",
        headers: {
          ...headers,
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [longUrl] }),
        signal: AbortSignal.timeout(8000),
      });
      if (lmRes.ok) {
        const rawText = (await lmRes.text()).trim();
        const plain = parsePlainText(rawText);
        if (plain) return plain;
        try {
          const data = JSON.parse(rawText);
          const url = parseShortUrl(data);
          if (url) return url;
        } catch (_) {}
      }
    } catch (_) {}
  }

  return null;
}

export async function isVerifiedLast6Hours(env, userId) {
  if (await hasActiveSub(env, userId)) return true;
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`vpass_${userId}`).first();
  if (r && Number(r.value) > Date.now()) {
    const passEnabled = (await getSetting(env, "vpass_enabled")) !== "0";
    if (passEnabled) return true;
    // Even if 6-hour pass is disabled globally, allow a 15-minute grace window
    // so user can complete ForceSub checks or batch downloads without re-verifying
    const remainingMs = Number(r.value) - Date.now();
    if (remainingMs > (6 * 3600 - 900) * 1000) return true;
  }
  return false;
}

export async function sendVerifyLink(env, chatId, userId, targetId, displayTitle) {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("DELETE FROM tokens WHERE created < ?").bind(Date.now() - 24 * 3600 * 1000).run();
  await env.DB.prepare("INSERT INTO tokens (token, user_id, file_row_id, created) VALUES (?, ?, ?, ?)")
    .bind(token, String(userId), targetId, Date.now()).run();

  const tutorialUrl = await getSetting(env, "tutorial_url");
  const vpassOn = (await getSetting(env, "vpass_enabled")) !== "0";
  const username = await getBotUsername(env);

  const keyboard = [];
  if (APP_ORIGIN) {
    keyboard.push([{ text: "🔓 Click Here to Verify", web_app: { url: `${APP_ORIGIN}/verify?t=${token}` } }]);
  } else {
    const short = await shortenUrl(env, `https://t.me/${username}?start=v_${token}`);
    keyboard.push([{ text: "🔓 Click Here to Verify (Open Browser)", url: short || `https://t.me/${username}?start=v_${token}` }]);
  }

  if (tutorialUrl) keyboard.push([{ text: "🎬 How to Verify (Tutorial Video)", url: tutorialUrl }]);

  const modeNote = vpassOn
    ? "⏱️ <b>1 Verification unlocks ALL movies & series for 6 Hours!</b>"
    : "🔓 <b>Complete 1 quick verification to unlock this file!</b>";

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `🔐 <b>Verification Required</b>\n\n` +
      `🎬 <b>${esc(displayTitle || "Media File")}</b>\n\n` +
      `${modeNote}\n` +
      `1️⃣ Tap <b>Click Here to Verify</b> below.\n` +
      `2️⃣ Complete the shortlink step — it will automatically bring you back here and deliver your file!`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function getMissingChannels(env, userId) {
  const channels = await getChannels(env, "forcesub");
  const checks = await Promise.all(channels.map(async (c) => {
    const r = await tg(env, "getChatMember", { chat_id: c.chat_id, user_id: userId });
    if (!r.ok) {
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return c;
      await alertOwner(env, `fs${c.chat_id}`, `ForceSub can't check "${c.title}": ${r.description}. Make sure I'm still an admin there.`);
      return null;
    }
    const st = r.result.status;
    const joined = st === "member" || st === "administrator" || st === "creator" || (st === "restricted" && r.result.is_member);
    return joined ? null : c;
  }));
  return checks.filter(Boolean);
}

export async function ensureLink(env, c) {
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

// ---------- Sending Files & Batches to User ----------
export async function sendFileToUser(env, chatId, row, skipNotice = false) {
  const asVideo = row.send_as === "video";
  const protect = (await getSetting(env, "protect_files")) === "1";
  const sent = await tg(env, asVideo ? "sendVideo" : "sendDocument", {
    chat_id: chatId,
    [asVideo ? "video" : "document"]: row.file_id,
    caption: `🎬 <b>${esc(row.title)}</b>\n📦 <b>Size:</b> ${formatSize(row.size || 0)}`,
    parse_mode: "HTML",
    protect_content: protect,
  });

  if (!sent.ok) {
    if (sent.error_code !== 403 && !skipNotice) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ I couldn't send the file right now. Please try again in a minute." });
      await alertOwner(env, `send${row.id}`, `Could not send file #${row.id} "${row.title}": ${sent.description}`);
    }
    return null;
  }

  await env.DB.prepare("INSERT INTO downloads (user_id, file_row_id, day) VALUES (?, ?, ?)").bind(String(chatId), row.id, dayString(0)).run();

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
    await env.DB.prepare("INSERT INTO deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)").bind(String(chatId), id, deleteAt).run();
  }
  return sent.result.message_id;
}

export async function sendBatchMenuToUser(env, chatId, batch, page = 0, editMsgId = null) {
  let items = [];
  try { items = JSON.parse(batch.items_json || "[]"); } catch (e) { items = []; }

  if (!items.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, no files found for this title." });
    return;
  }

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
    buttons.push([{ text: `${sizeStr} - ${label}`.slice(0, 62), callback_data: `bep:${ep.rowId}` }]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (curPage > 0) navRow.push({ text: "⏪ PREVIOUS", callback_data: `bpage:${batch.batch_id}:${curPage - 1}` });
    if (curPage < totalPages - 1) navRow.push({ text: "⏩ NEXT", callback_data: `bpage:${batch.batch_id}:${curPage + 1}` });
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

export async function deliverFile(env, chatId, userId, row, justVerified = false) {
  if (justVerified) await setSetting(env, `vpass_${userId}`, String(Date.now() + 6 * 3600 * 1000));

  if (!justVerified && (await shortlinkReady(env)) && !(await isVerifiedLast6Hours(env, userId))) {
    await sendVerifyLink(env, chatId, userId, row.id, row.title);
    return;
  }

  const missing = await getMissingChannels(env, userId);
  if (missing.length) {
    const buttons = [];
    for (const c of missing) {
      const link = await ensureLink(env, c);
      if (link) buttons.push([{ text: `📢 Join ${c.title}`.slice(0, 60), url: link }]);
    }
    buttons.push([{ text: "🔄 Try Again / Get File", callback_data: `chk:${row.id}` }]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔐 <b>Almost there!</b>\n\nJoin our backup channel(s) below and tap <b>Try Again / Get File</b> to receive your file instantly:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  await sendFileToUser(env, chatId, row, false);
}

export async function deliverBatch(env, chatId, userId, batch, justVerified = false) {
  if (justVerified) await setSetting(env, `vpass_${userId}`, String(Date.now() + 6 * 3600 * 1000));

  if (!justVerified && (await shortlinkReady(env)) && !(await isVerifiedLast6Hours(env, userId))) {
    await sendVerifyLink(env, chatId, userId, -batch.batch_id, `${batch.title} (${batch.quality})`);
    return;
  }

  const missing = await getMissingChannels(env, userId);
  if (missing.length) {
    const buttons = [];
    for (const c of missing) {
      const link = await ensureLink(env, c);
      if (link) buttons.push([{ text: `📢 Join ${c.title}`.slice(0, 60), url: link }]);
    }
    buttons.push([{ text: "🔄 Try Again / Get Files", callback_data: `chkb:${batch.batch_id}` }]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔐 <b>Almost there!</b>\n\nJoin our backup channel(s) below and tap <b>Try Again / Get Files</b> to unlock all files:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  let items = [];
  try { items = JSON.parse(batch.items_json || "[]"); } catch (e) { items = []; }
  if (items.length === 1) {
    const fRow = await getFileRow(env, items[0].rowId);
    if (fRow) {
      await sendFileToUser(env, chatId, fRow, false);
      return;
    }
  }
  await sendBatchMenuToUser(env, chatId, batch, 0, null);
}
