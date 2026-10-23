// digest.js - Daily 7:00 PM IST Upload Digest for ForceSub Channels

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Builds and sends the Style A Daily Digest to all ForceSub channels.
 * Pass in small helpers from index.js so you don't have to duplicate them.
 */
export async function sendDailyDigest(env, { tg, getChannels, getSetting, setSetting, makeDeepLink }) {
  // 1. Find all ForceSub channels
  const forcesubChannels = await getChannels(env, "forcesub");
  if (!forcesubChannels.length) return { ok: false, reason: "No ForceSub channels configured." };

  // 2. Query batches updated in the last 24 hours (1 single D1 query!)
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(
    "SELECT batch_id, group_key, title, items_json, updated FROM batches WHERE updated >= ? ORDER BY updated DESC LIMIT 35"
  ).bind(since).all();

  const batches = rows.results || [];
  if (!batches.length) return { ok: false, reason: "No new uploads in the last 24 hours." };

  // 3. Format today's IST date header (e.g., "23 Oct 2026")
  const istNow = new Date(Date.now() + 330 * 60000);
  const dateLabel = istNow.toUTCString().split(" ").slice(1, 4).join(" ");

  const lines = [
    `📅 <b>Daily Upload Digest — ${esc(dateLabel)}</b>`,
    `<i>Missed today's releases? Tap any pill below to unlock directly in our bot:</i>`,
    "",
  ];

  // 4. Build Style A: Title on line 1, clickable dark pill badge(s) on line 2
  let count = 0;
  for (const b of batches) {
    count++;
    const isSeries = String(b.group_key || "").startsWith("series:");
    const icon = isSeries ? "📺" : "🎬";

    let items = [];
    try { items = JSON.parse(b.items_json || "[]"); } catch (_) { items = []; }

    // Collect distinct qualities available inside this batch
    const quals = [];
    for (const it of items) {
      if (it.quality && !quals.includes(it.quality)) quals.push(it.quality);
    }
    const qualTag = quals.length ? ` [${quals.join(" • ")}]` : "";
    const deepLink = await makeDeepLink(env, `b${b.batch_id}`);

    // Line 1: Bold Movie/Series Title
    lines.push(`<b>${count}. ${icon} ${esc(b.title)}</b><i>${esc(qualTag)}</i>`);

    // Line 2: Sleek dark pill button(s) using <code> inside <a href> with ↗
    const btnLabel = isSeries && items.length > 1
      ? `📥 All ${items.length} Episodes ↗`
      : `📥 Get File ↗`;

    lines.push(`<a href="${deepLink}"><code> ${btnLabel} </code></a>\n`);
  }

  lines.push(`🔔 <i>Stay joined for tomorrow's 7:00 PM update!</i>`);
  const text = lines.join("\n");

  // Optional bottom inline button for main channel or premium
  const cover = await getSetting(env, "cover_lecture");
  let sentCount = 0;

  for (const ch of forcesubChannels) {
    let res;
    if (cover) {
      res = await tg(env, "sendPhoto", {
        chat_id: ch.chat_id,
        photo: cover,
        caption: text,
        parse_mode: "HTML",
      });
    }
    if (!cover || !res || !res.ok) {
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
 * Checks if it is currently the 7:00 PM IST window (19:00 IST) and hasn't run today yet.
 */
export async function checkAndRunScheduledDigest(env, helpers) {
  const istDate = new Date(Date.now() + 330 * 60000);
  const istHour = istDate.getUTCHours(); // 19 = 7:00 PM IST
  const todayStr = istDate.toISOString().slice(0, 10);

  if (istHour !== 19) return;

  const lastSent = await helpers.getSetting(env, "last_digest_day");
  if (lastSent === todayStr) return; // Already posted today!

  await helpers.setSetting(env, "last_digest_day", todayStr);
  await sendDailyDigest(env, helpers);
}
