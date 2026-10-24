// digest.js - Daily 7:00 PM IST Upload Digest for ForceSub Channels

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const QUALITY_ORDER = ["360p", "480p", "720p", "1080p", "1440p", "2160p 4K", "HD"];
function sortQualities(a, b) {
  const ia = QUALITY_ORDER.indexOf(a);
  const ib = QUALITY_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
}

/**
 * Builds and posts the Style A Daily Digest to all ForceSub channels.
 */
export async function sendDailyDigest(env, { tg, getChannels, getSetting, makeDeepLink }) {
  // 1. Get all ForceSub channels
  const forcesubChannels = await getChannels(env, "forcesub");
  if (!forcesubChannels.length) {
    return { ok: false, reason: "No ForceSub channels set in /settings." };
  }

  // 2. Get all Movie & Series batches updated in the last 24 hours
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(
    "SELECT batch_id, group_key, title, items_json, updated FROM batches WHERE updated >= ? ORDER BY updated DESC LIMIT 30"
  ).bind(since).all();

  const batches = rows.results || [];
  if (!batches.length) {
    return { ok: false, reason: "No new movies or series uploaded in the last 24 hours." };
  }

  // 3. Format today's IST date (e.g., "24 Oct 2026")
  const istNow = new Date(Date.now() + 330 * 60000);
  const dateLabel = istNow.toUTCString().split(" ").slice(1, 4).join(" ");

  const lines = [
    `📅 <b>Today's Uploads (${esc(dateLabel)})</b>`,
    `<i>Tap any button below a title to get the file directly in bot PM:</i>`,
    "",
  ];

  // 4. Build Style A: Title on line 1, clickable dark blockquote pill on line 2
  let count = 0;
  for (const b of batches) {
    count++;
    const isSeries = String(b.group_key || "").startsWith("series:");
    const icon = isSeries ? "📺" : "🎬";

    // Clean any accidental line breaks inside the title
    const cleanTitle = String(b.title || "Untitled").replace(/\s+/g, " ").trim();

    let items = [];
    try { items = JSON.parse(b.items_json || "[]"); } catch (_) { items = []; }

    const quals = [];
    for (const it of items) {
      if (it.quality && !quals.includes(it.quality)) quals.push(it.quality);
    }
    quals.sort(sortQualities);

    const qualTag = quals.length ? ` (${quals.join(" | ")})` : "";
    const deepLink = await makeDeepLink(env, `b${b.batch_id}`);

    // Line 1: Number + Title + Sorted Qualities
    lines.push(`<b>${count}. ${icon} ${esc(cleanTitle)}</b><i>${esc(qualTag)}</i>`);

    // Line 2: Clickable pill box that opens the bot directly without copying text
    const pillLabel = isSeries && items.length > 1
      ? `📥 All ${items.length} Episodes ↗`
      : `📥 Get File ↗`;

    lines.push(`<blockquote><a href="${deepLink}"><b>${pillLabel}</b></a></blockquote>\n`);
  }

  lines.push(`🔔 <i>Stay joined for daily 7:00 PM upload updates!</i>`);
  const text = lines.join("\n");

  const cover = await getSetting(env, "cover_lecture");
  let sentCount = 0;

  for (const ch of forcesubChannels) {
    let res = null;
    if (cover && text.length <= 1024) {
      res = await tg(env, "sendPhoto", {
        chat_id: ch.chat_id,
        photo: cover,
        caption: text,
        parse_mode: "HTML",
      });
    }
    if (!res || !res.ok) {
      res = await tg(env, "sendMessage", {
        chat_id: ch.chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
    if (res && res.ok) sentCount++;
  }

  return { ok: true, sentCount, totalUploads: count };
}

/**
 * Automatically triggers the digest once per day during the 7:00 PM IST hour (19:00 IST).
 */
export async function checkAndRunScheduledDigest(env, helpers) {
  const istDate = new Date(Date.now() + 330 * 60000);
  const istHour = istDate.getUTCHours(); // 19 = 7:00 PM IST
  const todayStr = istDate.toISOString().slice(0, 10);

  if (istHour !== 19) return;

  const lastSent = await helpers.getSetting(env, "last_digest_day");
  if (lastSent === todayStr) return; // Already posted today

  await helpers.setSetting(env, "last_digest_day", todayStr);
  await sendDailyDigest(env, helpers);
}
