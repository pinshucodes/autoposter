// digest.js - Daily 7:00 PM IST Upload Digest for ForceSub Channels
import { ensureExtraTables } from "./core.js";
import { resolveTargetChannels } from "./testmode.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const QUALITY_ORDER = ["360p", "480p", "720p", "1080p", "1440p", "2160p 4K", "HD"];
function sortQualities(a, b) {
  const ia = QUALITY_ORDER.indexOf(a);
  const ib = QUALITY_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
}

export async function sendDailyDigest(env, { tg, getChannels, getSetting, setSetting, makeDeepLink }) {
  await ensureExtraTables(env);

  // 1. Get ForceSub channels, respecting Test Mode if /test on is active!
  const rawChannels = await getChannels(env, "forcesub");
  const { isTestMode, targets: targetChannels } = await resolveTargetChannels(env, rawChannels, getSetting);

  if (!targetChannels.length) {
    return { ok: false, reason: "No ForceSub channels set in /settings (and Test Mode is off)." };
  }

  // 2. Always get a valid Bot Username
  let username = await getSetting(env, "bot_username");
  if (!username) {
    const me = await tg(env, "getMe", {});
    if (me.ok && me.result && me.result.username) {
      username = me.result.username;
      if (setSetting) await setSetting(env, "bot_username", username);
    }
  }
  if (!username) {
    return { ok: false, reason: "Could not fetch bot username from Telegram." };
  }

  // 3. Get Movie & Series batches from last 24h (If Live, exclude test_ uploads; if Test Mode, allow all)
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const sql = isTestMode
    ? "SELECT batch_id, group_key, title, items_json, updated FROM batches WHERE updated >= ? ORDER BY updated DESC LIMIT 30"
    : "SELECT batch_id, group_key, title, items_json, updated FROM batches WHERE updated >= ? AND group_key NOT LIKE 'test_%' ORDER BY updated DESC LIMIT 30";

  const rows = await env.DB.prepare(sql).bind(since).all();
  const batches = rows.results || [];

  if (!batches.length) {
    return { ok: false, reason: "No new movies or series uploaded in the last 24 hours." };
  }

  // 4. Format today's IST date
  const istNow = new Date(Date.now() + 330 * 60000);
  const dateLabel = istNow.toUTCString().split(" ").slice(1, 4).join(" ");

  const lines = [
    `📅 <b>Today's Uploads (${esc(dateLabel)})</b>${isTestMode ? " 🧪 <i>[TEST MODE]</i>" : ""}`,
    `<i>Tap any blue button below a title to get the file directly in bot PM:</i>`,
    "",
  ];

  // 5. Build each Movie/Series entry with Qualities + Audio Languages + Quote Pill Link
  let count = 0;
  for (const b of batches) {
    count++;
    const isSeries = String(b.group_key || "").replace(/^test_/, "").startsWith("series:");
    const icon = isSeries ? "📺" : "🎬";

    const cleanTitle = String(b.title || "Untitled").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

    let items = [];
    try { items = JSON.parse(b.items_json || "[]"); } catch (_) { items = []; }

    const quals = [];
    const langs = [];
    for (const it of items) {
      if (it.quality && !quals.includes(it.quality)) quals.push(it.quality);
      for (const l of it.audioLangs || []) {
        if (l && !langs.includes(l)) langs.push(l);
      }
    }
    quals.sort(sortQualities);

    const qualTag = quals.length ? ` (${quals.join(" | ")})` : "";
    const langLine = langs.length ? `\n🔊 <i>${esc(langs.join(" + "))}</i>` : "";

    const botUrl = makeDeepLink
      ? await makeDeepLink(env, `b${b.batch_id}`)
      : `https://t.me/${username}?start=b${b.batch_id}`;

    const btnLabel = isSeries && items.length > 1
      ? `📥 All ${items.length} Episodes ↗`
      : `📥 Get File ↗`;

    lines.push(`<b>${count}. ${icon} ${esc(cleanTitle)}</b><i>${esc(qualTag)}</i>${langLine}`);
    lines.push(`<blockquote>👉 <a href="${botUrl}"><b>${btnLabel}</b></a></blockquote>\n`);
  }

  // 6. Bottom "How to Download" Blockquote Pill
  const tutorialUrl = await getSetting(env, "tutorial_url");
  lines.push(`🔔 <i>Stay joined for daily 7:00 PM upload updates!</i>`);
  if (tutorialUrl) {
    lines.push(`<blockquote>🎬 <a href="${tutorialUrl}"><b>How to Download (Tutorial) ↗</b></a></blockquote>`);
  }

  const text = lines.join("\n");
  const cover = await getSetting(env, "cover_lecture");
  let sentCount = 0;

  for (const ch of targetChannels) {
    let res = null;
    if (cover && text.length <= 1024) {
      res = await tg(env, "sendPhoto", {
        chat_id: ch.chat_id,
        photo: cover,
        caption: text,
        parse_mode: "HTML",
        protect_content: true,
      });
    }
    if (!res || !res.ok) {
      res = await tg(env, "sendMessage", {
        chat_id: ch.chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        protect_content: true,
      });
    }
    if (res && res.ok) sentCount++;
  }

  return { ok: true, sentCount, totalUploads: count };
}

export async function checkAndRunScheduledDigest(env, helpers) {
  // Don't auto-fire the 7:00 PM scheduled digest while Test Mode is ON
  if ((await helpers.getSetting(env, "test_mode")) === "1") return;

  const istDate = new Date(Date.now() + 330 * 60000);
  const istHour = istDate.getUTCHours(); // 19 = 7:00 PM IST
  const todayStr = istDate.toISOString().slice(0, 10);

  if (istHour !== 19) return;

  const lastSent = await helpers.getSetting(env, "last_digest_day");
  if (lastSent === todayStr) return;

  await helpers.setSetting(env, "last_digest_day", todayStr);
  await sendDailyDigest(env, helpers);
}
