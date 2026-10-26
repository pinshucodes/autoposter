import {
  tg, esc, ROLES, PLANS, APP_ORIGIN, getChannels, addChannel, getSetting, setSetting,
  setState, clearState, formatDelay, shortenUrl, getStarPrices, starsEnabled,
  getSubExpiry, fmtDate, dayString, alertOwner, makeDeepLink
} from "./core.js";
import { checkAndRunScheduledDigest } from "./digest.js";

export const MAIN_MENU = {
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

const BACK_BUTTON = [[{ text: "⬅️ Back", callback_data: "back" }]];

export async function showMainMenu(env, chatId, messageId) {
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: MAIN_MENU.text,
    parse_mode: "HTML", reply_markup: { inline_keyboard: MAIN_MENU.buttons },
  });
}

export async function buildRoleMenu(env, role, page = 0) {
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

export async function showRoleMenu(env, chatId, messageId, role, page = 0) {
  const menu = await buildRoleMenu(env, role, page);
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: menu.text,
    parse_mode: "HTML", reply_markup: { inline_keyboard: menu.buttons },
  });
}

export async function buildCoverMenu(env, note) {
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

export async function showCoverMenu(env, chatId, messageId, note) {
  const menu = await buildCoverMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: menu.text,
    parse_mode: "HTML", reply_markup: { inline_keyboard: menu.buttons },
  });
}

export async function buildDeleteMenu(env, note) {
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

export async function showDeleteMenu(env, chatId, messageId, note) {
  const menu = await buildDeleteMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: menu.text,
    parse_mode: "HTML", reply_markup: { inline_keyboard: menu.buttons },
  });
}

export async function buildMetaMenu(env, note) {
  const metaOn = (await getSetting(env, "meta_enabled")) === "1";
  const miOn = (await getSetting(env, "mediainfo_enabled")) !== "0";
  const groupOn = (await getSetting(env, "group_qualities")) !== "0";
  const shieldOn = (await getSetting(env, "shield_redirect")) !== "0";
  const protectOn = (await getSetting(env, "protect_files")) === "1";
  const tmdbKey = await getSetting(env, "tmdb_key");
  const omdbKey = await getSetting(env, "omdb_key");
  const sampleUrl = await getSetting(env, "sample_url");

  let text = "🎬 <b>IMDb, TMDb, Series Batching & Shield</b>\n\n" +
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
    [{ text: "🔑 Set TMDb Key", callback_data: "meta:tmdb" }, { text: "🔑 Set OMDb Key", callback_data: "meta:omdb" }],
    [{ text: sampleUrl ? "🎬 Change Sample Channel Link" : "🎬 Set Sample Channel Link", callback_data: "meta:sample" }],
  ];
  if (sampleUrl) buttons.push([{ text: "🗑 Remove Sample Link", callback_data: "meta:rmsample" }]);
  buttons.push(...BACK_BUTTON);
  return { text, buttons };
}

export async function buildShortlinkMenu(env, note) {
  const on = (await getSetting(env, "shortlink_enabled")) === "1";
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  const tut = await getSetting(env, "tutorial_url");
  const vpassOn = (await getSetting(env, "vpass_enabled")) !== "0";

  let text = "🔗 <b>Shortlink & Tutorial Settings</b>\n\n" +
    `Status: ${on ? "✅ ON (Anti-Copy Mini App Shield Active)" : "❌ OFF"}\n` +
    `⏱️ 6-Hour Verify Pass: ${vpassOn ? "🟢 <b>ON (Verify once for all movies)</b>" : "🔴 <b>OFF (Verify every movie)</b>"}\n` +
    `Domain: ${domain ? esc(domain) : "<i>not set</i>"}\n` +
    `API Key: ${key ? "<code>" + esc(key.slice(0, 6)) + "••••••</code>" : "<i>not set</i>"}\n` +
    `How to Verify Tutorial: ${tut ? esc(tut) : "<i>not set</i>"}`;
  if (note) text += `\n\n${note}`;

  const buttons = [
    [{ text: on ? "🔴 Turn OFF" : "🟢 Turn ON", callback_data: "sl:toggle" }],
    [{ text: vpassOn ? "⏱️ 6-Hour Pass: 🟢 ON (Tap to OFF)" : "⏱️ 6-Hour Pass: 🔴 OFF (Tap to ON)", callback_data: "sl:toggle_vpass" }],
    [{ text: "🌐 Set Domain", callback_data: "sl:domain" }, { text: "🔑 Set API Key", callback_data: "sl:key" }],
    [{ text: "🎬 Set Tutorial Link (How to Verify)", callback_data: "sl:tutorial" }],
  ];
  if (tut) buttons.push([{ text: "🗑️ Remove Tutorial Link", callback_data: "sl:rmtut" }]);
  buttons.push(...BACK_BUTTON);
  return { text, buttons };
}

export async function showShortlinkMenu(env, chatId, messageId, note) {
  const menu = await buildShortlinkMenu(env, note);
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: menu.text,
    parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: menu.buttons },
  });
}

export async function buildPayMenu(env, note) {
  const upi = await getSetting(env, "upi_id");
  const name = await getSetting(env, "upi_name");
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'submitted'").first();
  let text = "💳 <b>Payments (UPI)</b>\n\n" +
    `UPI ID: ${upi ? `<code>${esc(upi)}</code>` : "<i>not set</i>"}\n` +
    `Payee name: ${name ? esc(name) : "<i>not set (shows Premium)</i>"}\n` +
    `Waiting for approval: ${waiting.n}\n\n<b>Plans</b>\n` +
    Object.values(PLANS).map((p) => `${p.name}: ₹${p.price}`).join("\n");
  const stars = await getStarPrices(env);
  const starsOn = await starsEnabled(env);
  text += `\n\n⭐ <b>Telegram Stars: ${starsOn ? "ON" : "OFF"}</b>\n` +
    Object.entries(PLANS).map(([k, p]) => `${p.name}: ${stars[k]} Stars`).join("\n");
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

export async function sendSkipAds(env, chatId, userId) {
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
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⭐ Choose a plan", web_app: { url: `${APP_ORIGIN}/app` } }]] },
  });
}

export async function handleSettingInput(env, msg, field) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (field.startsWith("cover_")) {
    if (!msg.photo) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Please send a photo (not a file), or /cancel to stop." });
      return;
    }
    await setSetting(env, field, msg.photo[msg.photo.length - 1].file_id);
    await clearState(env, userId);
    const cmenu = await buildCoverMenu(env, "✅ Cover saved.");
    await tg(env, "sendMessage", { chat_id: chatId, text: cmenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: cmenu.buttons } });
    return;
  }

  if (field === "stars_prices") {
    const nums = (msg.text || "").trim().split(/[\s,]+/).map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100000)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Please send 4 whole numbers: week, month, 2 months, year. Example: 12 35 58 290\n\n/cancel to stop." });
      return;
    }
    const keys = Object.keys(PLANS);
    for (let k = 0; k < keys.length; k++) await setSetting(env, `stars_${keys[k]}`, String(nums[k]));
    await clearState(env, userId);
    const smenu = await buildPayMenu(env, "✅ Star prices saved.");
    await tg(env, "sendMessage", { chat_id: chatId, text: smenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: smenu.buttons } });
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
        text: field === "upi_id" ? "Invalid UPI ID. Format: name@bank. Try again or /cancel." : "Send a short name (2-40 letters), or /cancel.",
      });
      return;
    }
    await setSetting(env, field, v);
    await clearState(env, userId);
    const pmenu = await buildPayMenu(env, "✅ Saved.");
    await tg(env, "sendMessage", { chat_id: chatId, text: pmenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: pmenu.buttons } });
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
      await tg(env, "sendMessage", { chat_id: chatId, text: "Send minutes between 1 and 2820, or /cancel." });
      return;
    }
    await setSetting(env, "delete_minutes", String(mins));
    await clearState(env, userId);
    const dmenu = await buildDeleteMenu(env, "✅ Saved.");
    await tg(env, "sendMessage", { chat_id: chatId, text: dmenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: dmenu.buttons } });
    return;
  }

  if (field === "tmdb_key" || field === "omdb_key") {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    await setSetting(env, field, value);
    await setSetting(env, "meta_enabled", "1");
    await clearState(env, userId);
    const mmenu = await buildMetaMenu(env, "✅ API key saved & IMDb/TMDb enabled!");
    await tg(env, "sendMessage", { chat_id: chatId, text: mmenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: mmenu.buttons } });
    return;
  }

  if (field === "tutorial_url" || field === "sample_url") {
    if (!/^https?:\/\/\S+/i.test(value) && !/^@\w+$/i.test(value)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Send a valid link starting with https:// or @username, or /cancel." });
      return;
    }
    if (value.startsWith("@")) value = `https://t.me/${value.slice(1)}`;
    await setSetting(env, field, value);
    await clearState(env, userId);
    const menu = field === "sample_url" ? await buildMetaMenu(env, "✅ Sample link saved!") : await buildShortlinkMenu(env, "✅ Tutorial link saved!");
    await tg(env, "sendMessage", { chat_id: chatId, text: menu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: menu.buttons } });
    return;
  }

  if (field === "shortlink_domain") value = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (field === "shortlink_key") await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id });

  await setSetting(env, field, value);
  await clearState(env, userId);

  let note = "✅ Saved.";
  const domain = await getSetting(env, "shortlink_domain");
  const key = await getSetting(env, "shortlink_key");
  if (domain && key) {
    const test = await shortenUrl(env, "https://t.me/telegram");
    note += test ? " Test shortlink worked ✅" : " ⚠️ Test failed. Check domain and API key.";
  }
  const menu = await buildShortlinkMenu(env, note);
  await tg(env, "sendMessage", { chat_id: chatId, text: menu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: menu.buttons } });
}

export function extractChannelRef(msg) {
  const fo = msg.forward_origin;
  if (fo && fo.type === "channel") return fo.chat.id;
  if (fo && fo.type === "chat" && fo.sender_chat) return fo.sender_chat.id;
  if (msg.forward_from_chat) return msg.forward_from_chat.id;
  const t = (msg.text || "").trim();
  if (/^-100\d+$/.test(t) || /^@\w+$/.test(t)) return t;
  return null;
}

export async function checkChannel(env, ref, role) {
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
    return { error: "I'm an admin there, but I need the <b>Post Messages</b> permission." };
  }
  if (role === "forcesub") {
    let link = chat.result.username ? `https://t.me/${chat.result.username}` : null;
    if (!link) {
      const inv = await tg(env, "exportChatInviteLink", { chat_id: chat.result.id });
      if (inv.ok) link = inv.result;
    }
    if (!link) return { error: "Give me the <b>Invite Users via Link</b> permission in that channel and send again." };
    return { id: chat.result.id, title: chat.result.title, link };
  }
  return { id: chat.result.id, title: chat.result.title };
}

export async function getPostTargets(env) {
  const r = await env.DB.prepare("SELECT chat_id, title, GROUP_CONCAT(role) AS roles FROM channels GROUP BY chat_id ORDER BY title, chat_id").all();
  return (r.results || []).slice(0, 30);
}

export async function countBroadcastUsers(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND active = 1").first();
  return r ? r.n : 0;
}

export function renderPicker(targets, mask, note) {
  let text = "📣 <b>Choose where to post</b>\n\nTap a channel to switch it on or off, then tap Send.";
  if (note) text += `\n\n${note}`;
  const buttons = targets.map((c, i) => [{ text: `${mask & (1 << i) ? "✅" : "⬜"} ${c.title}`.slice(0, 60), callback_data: `pk:t:${i}` }]);
  buttons.push([{ text: "📤 Send", callback_data: "pk:go" }, { text: "✖️ Cancel", callback_data: "pk:no" }]);
  return { text, buttons };
}

export async function askConfirm(env, msg, kind) {
  const userId = String(msg.from.id);
  await clearState(env, userId);

  if (kind === "post") {
    const targets = await getPostTargets(env);
    if (!targets.length) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "You haven't added any channels yet. Add them in /settings first." });
      return;
    }
    let mask = 0;
    targets.forEach((c, i) => { if (c.roles !== "source") mask |= 1 << i; });
    await setState(env, userId, `pick:${msg.message_id}:${mask}`);
    const view = renderPicker(targets, mask);
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id, text: view.text, parse_mode: "HTML",
      reply_to_message_id: msg.message_id, reply_markup: { inline_keyboard: view.buttons },
    });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: `📢 Send this message to <b>${await countBroadcastUsers(env)}</b> users?`,
    parse_mode: "HTML", reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: [[{ text: "✅ Yes, send", callback_data: `pst:broadcast:${msg.message_id}` }, { text: "✖️ Cancel", callback_data: "pst:no" }]] },
  });
}

export async function processBroadcast(env, limit) {
  const job = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;

  const now = Date.now();
  const lock = await env.DB.prepare("UPDATE broadcasts SET locked_until = ? WHERE id = ? AND locked_until < ? AND status = 'running'")
    .bind(now + 55000, job.id, now).run();
  if (!lock.meta.changes) return;

  const users = await env.DB.prepare("SELECT rowid AS rid, user_id FROM users WHERE rowid > ? AND banned = 0 AND active = 1 ORDER BY rowid LIMIT ?")
    .bind(job.last_rowid, limit).all();
  const list = users.results || [];

  let sent = 0, failed = 0, last = job.last_rowid, backoff = 0;
  for (const u of list) {
    const r = await tg(env, "copyMessage", { chat_id: u.user_id, from_chat_id: job.from_chat, message_id: job.message_id });
    if (!r.ok && r.error_code === 429) {
      backoff = ((r.parameters && r.parameters.retry_after) || 5) * 1000;
      break;
    }
    if (r.ok) sent++;
    else {
      failed++;
      if (r.error_code === 403) await env.DB.prepare("UPDATE users SET active = 0 WHERE user_id = ?").bind(u.user_id).run();
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
      await tg(env, "sendMessage", { chat_id: job.owner_chat, text: `✅ Broadcast finished.\nDelivered: ${job.sent + sent}\nFailed: ${job.failed + failed}` });
    }
  }
}

async function runDeletions(env, limit) {
  const due = await env.DB.prepare("SELECT id, chat_id, message_id, attempts FROM deletions WHERE delete_at <= ? ORDER BY delete_at LIMIT ?")
    .bind(Date.now(), limit).all();
  for (const d of due.results || []) {
    const r = await tg(env, "deleteMessage", { chat_id: d.chat_id, message_id: d.message_id });
    if (r.ok || r.error_code === 400 || r.error_code === 403 || d.attempts >= 8) {
      await env.DB.prepare("DELETE FROM deletions WHERE id = ?").bind(d.id).run();
    } else {
      await env.DB.prepare("UPDATE deletions SET attempts = attempts + 1, delete_at = ? WHERE id = ?")
        .bind(Date.now() + (d.attempts + 1) * 60000, d.id).run();
    }
  }
}

export async function runCron(env) {
  try {
    await setSetting(env, "last_cron", String(Date.now()));
    const job = await env.DB.prepare("SELECT 1 AS x FROM broadcasts WHERE status = 'running' LIMIT 1").first();
    await runDeletions(env, job ? 15 : 40);
    if (job) await processBroadcast(env, 30);
    await checkAndRunScheduledDigest(env, { tg, getChannels, getSetting, setSetting, makeDeepLink });
  } catch (err) {
    console.log("Cron error:", err);
    await alertOwner(env, "cron", `The scheduled cleanup job hit an error: ${String(err).slice(0, 300)}`);
  }
}

export async function sendStats(env, chatId) {
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
    "📅 <b>Last 7 days</b>\n" + lines.join("\n") + "\n\n<i>Days follow India time (IST).</i>";
  await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

export async function sendStatus(env, chatId) {
  const lines = [];
  const hook = await tg(env, "getWebhookInfo", {});
  if (hook.ok) {
    const h = hook.result;
    lines.push(`${h.url ? "✅" : "⚠️"} Webhook: ${h.url ? "set" : "NOT set"}, waiting updates: ${h.pending_update_count}`);
    if (h.last_error_message) lines.push(`⚠️ Last Telegram error: ${esc(h.last_error_message)}`);
  }

  const lc = parseInt((await getSetting(env, "last_cron")) || "0", 10);
  const age = lc ? Math.round((Date.now() - lc) / 60000) : null;
  lines.push(age === null ? "⚠️ Cleanup job: hasn't run yet" : age <= 3 ? `✅ Cleanup job: ran ${age} min ago` : `⚠️ Cleanup job: last ran ${age} min ago`);

  const q = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(delete_at <= ?) AS due FROM deletions").bind(Date.now()).first();
  lines.push(`🗑 Deletions waiting: ${q.n} (${q.due || 0} due now)`);

  if ((await getSetting(env, "shortlink_enabled")) === "1") {
    const test = await shortenUrl(env, "https://t.me/telegram");
    lines.push(test ? "✅ Shortlink: working (Anti-Copy Shield ON)" : "⚠️ Shortlink: NOT working");
  } else {
    lines.push("➖ Shortlink: off");
  }

  const rawMins = await getSetting(env, "delete_minutes");
  const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
  lines.push(`🛡️ Auto-delete: ${formatDelay(mins)}`);

  await tg(env, "sendMessage", { chat_id: chatId, text: "🩺 <b>Status</b>\n\n" + lines.join("\n"), parse_mode: "HTML" });
}
