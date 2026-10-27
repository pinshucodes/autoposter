// src/media.js - Filename Parser, TMDb/OMDb & Channel Auto-Poster
import {
  tg, esc, ensureExtraTables, getChannels, getSetting, saveFile,
  formatSize, makeDeepLink, shortenUrl
} from "./core.js";
import { resolveTargetChannels } from "./testmode.js";

const QUALITY_ORDER = ["360p", "480p", "720p", "1080p", "1440p", "2160p 4K", "HD"];

function sortQualities(a, b) {
  const ia = QUALITY_ORDER.indexOf(a);
  const ib = QUALITY_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
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

async function isTrustedSender(env, post) {
  if (post.sender_chat && post.sender_chat.id === post.chat.id) return true;
  if (!post.from) return false;
  if (String(post.from.id) === String(env.OWNER_ID)) return true;
  const r = await tg(env, "getChatMember", { chat_id: post.chat.id, user_id: post.from.id });
  return r.ok && (r.result.status === "creator" || r.result.status === "administrator");
}

export function parseMediaFilename(rawName, rawCaption) {
  const full = `${rawName || ""} ${rawCaption || ""}`;
  const rawFirstLine = (rawName || (rawCaption || "").split("\n")[0] || "Untitled")
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/^(\[@[^\]]+\]|\[[^\]]+\]|\(@[^)]+\))\s*/g, "")
    .trim();

  let isSeries = false, season = null, episode = null;

  const seMatch =
    full.match(/\bS(\d{1,2})[\s._-]*E(?:P)?(\d{1,3})\b/i) ||
    full.match(/\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i);
  const epRangeMatch = full.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})[\s._-]*[-~][\s._-]*E?(\d{1,3})\b/i);
  const sOnlyMatch =
    full.match(/\bS(\d{1,2})\b(?![\s._-]*E\d)/i) ||
    full.match(/\bSeason[\s._-]*(\d{1,2})\b/i);
  const epOnlyMatch = full.match(/\b(?:EP|Episode)[\s._-]*(\d{1,3})\b/i);

  if (seMatch) {
    isSeries = true; season = parseInt(seMatch[1], 10); episode = parseInt(seMatch[2], 10);
  } else if (epRangeMatch) {
    isSeries = true; season = parseInt(epRangeMatch[1], 10); episode = parseInt(epRangeMatch[2], 10);
  } else if (sOnlyMatch) {
    isSeries = true; season = parseInt(sOnlyMatch[1], 10);
    if (epOnlyMatch) episode = parseInt(epOnlyMatch[1], 10);
  } else if (epOnlyMatch) {
    isSeries = true; season = 1; episode = parseInt(epOnlyMatch[1], 10);
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
    [/\bhindi\b|\bhin\b/i, "Hindi"], [/\benglish\b|\beng\b/i, "English"],
    [/\btamil\b|\btam\b/i, "Tamil"], [/\btelugu\b|\btel\b/i, "Telugu"],
    [/\bmalayalam\b|\bmal\b/i, "Malayalam"], [/\bkannada\b|\bkan\b/i, "Kannada"],
    [/\bbengali\b|\bben\b/i, "Bengali"], [/\bmarathi\b|\bmar\b/i, "Marathi"],
    [/\bpunjabi\b|\bpun\b/i, "Punjabi"], [/\bkorean\b|\bkor\b/i, "Korean"],
    [/\bjapanese\b|\bjap\b|\bjpn\b/i, "Japanese"], [/\bspanish\b|\bspa\b/i, "Spanish"],
    [/\brussian\b|\brus\b/i, "Russian"], [/\bdual[\s._-]*audio\b/i, "Dual Audio"],
    [/\bmulti[\s._-]*audio\b/i, "Multi Audio"],
  ];
  const audioLangs = [];
  for (const [rx, label] of langMap) {
    if (rx.test(full) && !audioLangs.includes(label)) audioLangs.push(label);
  }

  let year = null;
  const yearMatch = rawFirstLine.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) year = yearMatch[1];

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
    cleanTitle, displayFileName: rawFirstLine, year, isSeries,
    season: isSeries ? (season || 1) : null, episode,
    quality, source, vCodec, aCodec, audioLangs, groupKey,
  };
}

async function fetchMediaMeta(env, info) {
  if ((await getSetting(env, "meta_enabled")) !== "1") return null;

  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");
  const out = {
    title: info.cleanTitle, year: info.year || "", rating: "",
    genres: "", plot: "", poster: "", type: info.isSeries ? "TV Series" : "Movie",
  };

  if (tmdbKey) {
    try {
      const endpoint = info.isSeries ? "tv" : "movie";
      const yParam = info.year ? (info.isSeries ? `&first_air_date_year=${info.year}` : `&year=${info.year}`) : "";
      const url = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(info.cleanTitle)}${yParam}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const rawText = (await res.text()).trim();
      let data = null;
      try { data = JSON.parse(rawText); } catch (_) {}
      const hit = data && data.results && data.results[0];
      if (hit) {
        out.title = hit.title || hit.name || out.title;
        const dateStr = hit.release_date || hit.first_air_date || "";
        if (dateStr) out.year = dateStr.slice(0, 4);
        if (hit.vote_average) out.rating = `${Number(hit.vote_average).toFixed(1)}/10`;
        if (hit.overview) out.plot = hit.overview.slice(0, 240) + (hit.overview.length > 240 ? "..." : "");
        // PRIORITIZE PORTRAIT POSTER PATH FIRST INSTEAD OF LANDSCAPE BACKDROP
        if (hit.poster_path || hit.backdrop_path) {
          out.poster = `https://image.tmdb.org/t/p/w780${hit.poster_path || hit.backdrop_path}`;
        }
      }
    } catch (err) {
      console.log("TMDb lookup error:", err.message || String(err));
    }
  }

  if (omdbKey) {
    try {
      const oType = info.isSeries ? "series" : "movie";
      const yParam = info.year ? `&y=${info.year}` : "";
      const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbKey)}&t=${encodeURIComponent(info.cleanTitle)}&type=${oType}${yParam}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const rawText = (await res.text()).trim();
      let data = null;
      try { data = JSON.parse(rawText); } catch (_) {}
      if (data && data.Response === "True") {
        out.title = data.Title || out.title;
        if (data.Year && !out.year) out.year = data.Year.slice(0, 4);
        if (data.imdbRating && data.imdbRating !== "N/A") out.rating = `${data.imdbRating}/10`;
        if (data.Genre && data.Genre !== "N/A") out.genres = data.Genre;
        if (!out.plot && data.Plot && data.Plot !== "N/A") out.plot = data.Plot.slice(0, 240);
        if (!out.poster && data.Poster && data.Poster.startsWith("http")) out.poster = data.Poster;
      }
    } catch (err) {
      console.log("OMDb lookup error:", err.message || String(err));
    }
  }

  return out;
}

async function buildChannelPostView(env, meta, info, items, showMediaInfo, sampleRowId, batchId) {
  const titleText = (meta && meta.title) ? meta.title : info.cleanTitle;
  const yearText = (meta && meta.year) || info.year;
  const headerTitle = yearText ? `${titleText} (${yearText})` : titleText;
  const sTag = info.isSeries ? ` — Season ${String(info.season || 1).padStart(2, "0")}` : "";

  const lines = [`🎬 <b>${esc(headerTitle)}${esc(sTag)}</b>`];

  if (meta) {
    const badges = [];
    if (meta.rating) badges.push(`⭐ <b>IMDb:</b> ${esc(meta.rating)}`);
    if (meta.type) badges.push(`📺 <b>Type:</b> ${esc(meta.type)}`);
    if (badges.length) lines.push(badges.join("  |  "));
    if (meta.genres) lines.push(`🎭 <b>Genre:</b> ${esc(meta.genres)}`);
  }

  const allLangs = [], allQuals = [], allCodecs = [];
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

  if (meta && meta.plot) lines.push(`\n📝 <i>${esc(meta.plot)}</i>`);

  lines.push("", `⬇️ <b>Tap below to download directly in browser:</b>`);

  const buttons = [];
  const sampleChannelUrl = await getSetting(env, "sample_url");
  if (sampleChannelUrl) {
    buttons.push([{ text: "🎬 Watch Sample Video", url: sampleChannelUrl }]);
  } else if (sampleRowId) {
    const sampleLink = await makeDeepLink(env, `f${sampleRowId}`);
    buttons.push([{ text: "🎬 Watch Sample Video", url: sampleLink }]);
  }

  if (batchId) {
    const dLink = await makeDeepLink(env, `b${batchId}`);
    const countLabel = items.length > 1 ? ` (${items.length} Files)` : "";
    
    // AUTOMATICALLY SHORTEN SO CLICKING OPENS DIRECTLY IN BROWSER
    const shortDl = await shortenUrl(env, dLink);
    const finalDl = shortDl || dLink;

    buttons.push([{ text: `📥 Download Now${countLabel}`, url: finalDl }]);
  }

  const tutorialUrl = await getSetting(env, "tutorial_url");
  if (tutorialUrl) buttons.push([{ text: "❓ How to Download", url: tutorialUrl }]);

  return { caption: lines.join("\n"), buttons };
}

async function upsertSeasonBatch(env, groupKey, quality, title, epEntry) {
  await ensureExtraTables(env);
  const existing = await env.DB.prepare("SELECT batch_id, items_json FROM batches WHERE group_key = ? AND quality = ?")
    .bind(groupKey, quality).first();

  if (!existing) {
    const items = epEntry ? [epEntry] : [];
    const ins = await env.DB.prepare("INSERT INTO batches (group_key, quality, title, items_json, updated) VALUES (?, ?, ?, ?, ?)")
      .bind(groupKey, quality, title, JSON.stringify(items), Date.now()).run();
    return ins.meta.last_row_id;
  }

  if (!epEntry) return existing.batch_id;

  let items = [];
  try { items = JSON.parse(existing.items_json || "[]"); } catch (e) { items = []; }

  const idx = items.findIndex((x) => x.rowId === epEntry.rowId);
  if (idx >= 0) items[idx] = epEntry;
  else items.push(epEntry);

  await env.DB.prepare("UPDATE batches SET title = ?, items_json = ?, updated = ? WHERE batch_id = ?")
    .bind(title, JSON.stringify(items), Date.now(), existing.batch_id).run();

  return existing.batch_id;
}

export async function handleChannelPost(post, env) {
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
      await tg(env, "sendPhoto", { chat_id: targetChat, photo: cover, caption, parse_mode: "HTML", reply_markup: markup, protect_content: true });
    } else {
      await tg(env, "sendMessage", { chat_id: targetChat, text: caption, parse_mode: "HTML", reply_markup: markup, protect_content: true });
    }
    return;
  }

  const rawTargets = (await getChannels(env, "lectures")).slice(0, 50);
  const { isTestMode, targets } = await resolveTargetChannels(env, rawTargets, getSetting);
  if (!targets.length) return;
  await ensureExtraTables(env);

  const fullText = `${info.name || ""} ${post.caption || ""}`;
  const isSample = /\bsample\b/i.test(fullText);
  const parsed = parseMediaFilename(info.name, post.caption || "");
  if (isTestMode) parsed.groupKey = `test_${parsed.groupKey}`;

  const groupOn = (await getSetting(env, "group_qualities")) !== "0";
  const showMediaInfo = (await getSetting(env, "mediainfo_enabled")) !== "0";
  const existingPost = groupOn
    ? await env.DB.prepare("SELECT * FROM media_posts WHERE group_key = ?").bind(parsed.groupKey).first()
    : null;

  let meta = null, items = [], sampleRowId = null;

  if (existingPost) {
    try { meta = JSON.parse(existingPost.meta_json || "null"); } catch (e) { meta = null; }
    try { items = JSON.parse(existingPost.items_json || "[]"); } catch (e) { items = []; }
    if (meta && meta.sampleRowId) sampleRowId = meta.sampleRowId;
  } else {
    meta = await fetchMediaMeta(env, parsed);
  }
  if (!meta) {
    meta = {
      title: parsed.cleanTitle, year: parsed.year || "", rating: "",
      genres: "", plot: "", poster: "", type: parsed.isSeries ? "TV Series" : "Movie",
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
      rowId, fileName: parsed.displayFileName, quality: parsed.quality,
      season: parsed.season, episode: parsed.episode, size: info.file.file_size || 0,
      source: parsed.source, vCodec: parsed.vCodec, aCodec: parsed.aCodec, audioLangs: parsed.audioLangs,
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
    const chRows = await env.DB.prepare("SELECT chat_id, message_id, has_photo FROM media_post_channels WHERE group_key = ?")
      .bind(parsed.groupKey).all();
    for (const r of chRows.results || []) {
      chanMap[String(r.chat_id)] = { message_id: r.message_id, has_photo: r.has_photo };
    }
    if (existingPost && existingPost.chat_id && existingPost.message_id && !chanMap[String(existingPost.chat_id)]) {
      chanMap[String(existingPost.chat_id)] = { message_id: existingPost.message_id, has_photo: existingPost.has_photo };
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
        chat_id: targetChat, message_id: prev.message_id,
        parse_mode: "HTML", reply_markup: { inline_keyboard: view.buttons },
      };
      if (prev.has_photo) editPayload.caption = view.caption;
      else editPayload.text = view.caption;

      const edited = await tg(env, editMethod, editPayload);
      if (edited.ok || /message is not modified/i.test(edited.description || "")) {
        anySuccess = true;
        continue;
      }
    }

    let sent = null, hasPhoto = 0;
    if (photoSource) {
      // PROTECT CONTENT LOCKED (Turn off copy / forward feature)
      sent = await tg(env, "sendPhoto", {
        chat_id: targetChat, photo: photoSource, caption: view.caption,
        parse_mode: "HTML", reply_markup: { inline_keyboard: view.buttons }, protect_content: true,
      });
      if (sent.ok) {
        hasPhoto = 1;
        if (sent.result.photo && sent.result.photo.length) {
          photoSource = sent.result.photo[sent.result.photo.length - 1].file_id;
        }
      }
    }

    if (!sent || !sent.ok) {
      // PROTECT CONTENT LOCKED (Turn off copy / forward feature)
      sent = await tg(env, "sendMessage", {
        chat_id: targetChat, text: view.caption,
        parse_mode: "HTML", reply_markup: { inline_keyboard: view.buttons }, protect_content: true,
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
        await env.DB.prepare("INSERT OR REPLACE INTO media_post_channels (group_key, chat_id, message_id, has_photo) VALUES (?, ?, ?, ?)")
          .bind(parsed.groupKey, targetChat, sent.result.message_id, hasPhoto).run();
      }
    }
  }

  if (anySuccess && groupOn) {
    await env.DB.prepare("INSERT OR REPLACE INTO media_posts (group_key, chat_id, message_id, has_photo, meta_json, items_json, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(parsed.groupKey, String(firstChatId), firstMsgId, firstHasPhoto, JSON.stringify(meta), JSON.stringify(items), Date.now()).run();
  }
}
