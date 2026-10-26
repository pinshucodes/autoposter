import { sendDailyDigest } from "./digest.js";
import { handleTestCommand } from "./testmode.js";
import {
  tg, esc, safeEqual, ROLES, PLANS, MIN_VERIFY_SECONDS, setAppOrigin,
  getSetting, setSetting, getChannels, addChannel, removeChannel,
  setState, getState, clearState, getFileRow, getBatchRow, getBotUsername,
  makeDeepLink, isRateLimited, recordUser, activateSubscription, fmtDate,
  dayString, sendFileToUser, sendBatchMenuToUser, deliverFile, deliverBatch,
  getMissingChannels, starsEnabled, formatDelay
} from "./core.js";
import { handleChannelPost } from "./media.js";
import {
  MAIN_MENU, showMainMenu, showRoleMenu, showCoverMenu, showDeleteMenu,
  buildMetaMenu, showShortlinkMenu, buildPayMenu, sendSkipAds,
  handleSettingInput, extractChannelRef, checkChannel, getPostTargets,
  countBroadcastUsers, renderPicker, askConfirm, processBroadcast,
  runCron, sendStats, sendStatus
} from "./menus.js";
import {
  VERIFY_HTML, APP_HTML, handleApi, handlePreCheckout, handleStarsPaid
} from "./webapp.js";

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
    // Matches both /start v_token and /start vtoken (Fixes Bug #4)
    const tok = text.match(/^\/start v_?([A-Za-z0-9]+)/);
    if (tok) {
      const t = await env.DB.prepare("SELECT file_row_id, user_id, created FROM tokens WHERE token = ?").bind(tok[1]).first();
      const fresh = t && Date.now() - t.created < 60 * 60 * 1000;
      if (!t || String(t.user_id) !== userId || !fresh) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ This verification link is invalid or has expired. Please tap the button on the channel post again." });
        return;
      }
      if (Date.now() - t.created < MIN_VERIFY_SECONDS * 1000) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Bypass detected! Please complete the verification steps properly without skipping." });
        return;
      }
      const used = await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(tok[1]).run();
      if (!used.meta.changes) return;
      await env.DB.prepare("INSERT INTO verifications (user_id, file_row_id, day) VALUES (?, ?, ?)").bind(userId, Math.abs(t.file_row_id), dayString(0)).run();

      if (t.file_row_id < 0) {
        const batch = await getBatchRow(env, -t.file_row_id);
        if (!batch) await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that season batch is no longer available." });
        else await deliverBatch(env, chatId, msg.from.id, batch, true);
      } else {
        const row = await getFileRow(env, t.file_row_id);
        if (!row) await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
        else await deliverFile(env, chatId, msg.from.id, row, true);
      }
      return;
    }

    const bMatch = text.match(/^\/start b(\d+)/);
    if (bMatch) {
      const batch = await getBatchRow(env, Number(bMatch[1]));
      if (!batch) await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that season batch is no longer available." });
      else await deliverBatch(env, chatId, msg.from.id, batch, false);
      return;
    }

    const match = text.match(/^\/start f(\d+)/);
    if (match) {
      const row = await getFileRow(env, Number(match[1]));
      if (!row) await tg(env, "sendMessage", { chat_id: chatId, text: "Sorry, that file is no longer available." });
      else await deliverFile(env, chatId, msg.from.id, row, false);
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
    if (!/^\d{5,15}$/.test(target) || target === String(env.OWNER_ID)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Use it like this: /ban 123456789 (or /unban 123456789)" });
      return;
    }
    await env.DB.prepare("INSERT INTO users (user_id, first_name, joined_day, last_seen, banned, active) VALUES (?, '', ?, 0, ?, 0) ON CONFLICT(user_id) DO UPDATE SET banned = excluded.banned")
      .bind(target, dayString(0), unban ? 0 : 1).run();
    await tg(env, "sendMessage", { chat_id: chatId, text: `${unban ? "✅ Unbanned" : "🚫 Banned"} user ${target}.` });
    return;
  }

  if (text.startsWith("/stopbroadcast")) {
    const r = await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE status = 'running'").run();
    await tg(env, "sendMessage", { chat_id: chatId, text: r.meta.changes ? "🛑 Broadcast stopped." : "No broadcast is running." });
    return;
  }

  if (text.startsWith("/test")) {
    await clearState(env, userId);
    await handleTestCommand(env, chatId, text, { tg, getSetting, setSetting });
    return;
  }

    if (text.startsWith("/digest")) {
    await clearState(env, userId);
    const res = await sendDailyDigest(env, { tg, getChannels, getSetting, setSetting, makeDeepLink });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: res.ok ? `✅ Daily Digest posted to ${res.sentCount} channel(s) (${res.totalUploads} titles).` : `⚠️ Could not post digest: ${res.reason}`,
    });
    return;
  }


  if (text.startsWith("/stats")) {
    await clearState(env, userId);
    await sendStats(env, chatId);
    return;
  }

  if (text.startsWith("/post")) {
    await setState(env, userId, "post");
    await tg(env, "sendMessage", { chat_id: chatId, text: "📣 Send the message you want to post. /cancel to stop." });
    return;
  }

  if (text.startsWith("/broadcast")) {
    await setState(env, userId, "broadcast");
    await tg(env, "sendMessage", { chat_id: chatId, text: "📢 Send the message you want to broadcast to all users. /cancel to stop." });
    return;
  }

  if (text.startsWith("/settings")) {
    await clearState(env, userId);
    await tg(env, "sendMessage", {
      chat_id: chatId, text: MAIN_MENU.text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU.buttons }, reply_to_message_id: msg.message_id,
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
      await tg(env, "sendMessage", { chat_id: chatId, text: "Forward a message from the channel, or send its ID (-100...) or @username.\n/cancel to stop." });
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
      chat_id: chatId, text: `✅ Saved <b>${esc(result.title)}</b> as ${ROLES[role].name}.`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `Open ${ROLES[role].name}`, callback_data: `role:${role}:0` }]] },
    });
  }
}

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
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "File no longer available.", show_alert: true });
        return;
      }
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Sending file..." });
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
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `Sending ${items.length} files...` });
      for (const ep of items) {
        const row = await getFileRow(env, ep.rowId);
        if (row) await sendFileToUser(env, chatId, row, true);
      }
      const rawMins = await getSetting(env, "delete_minutes");
      const mins = rawMins === null ? 5 : parseInt(rawMins, 10);
      if (mins) {
        const notice = await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `⏳ <b>Auto-Delete Notice:</b> All files above will be deleted in <b>${formatDelay(mins)}</b>. Forward or share them to your Saved Messages now!`,
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
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "You haven't joined all the channels yet.", show_alert: true });
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
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Only the owner can do this.", show_alert: true });
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
      chat_id: chatId, message_id: messageId,
      text: `${ROLES[role].emoji} <b>${ROLES[role].name}</b>\n\nMake me an <b>admin</b> in the channel first. Then <b>forward any message</b> from that channel here, or send its ID (<code>-100...</code>) or @username.`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `role:${role}` }]] },
    });
    return;
  }
  if (action === "rm" && ROLES[parts[1]]) {
    const page = Number.isInteger(Number(parts[2])) ? Number(parts[2]) : 0;
    const targetChatId = Number.isInteger(Number(parts[2])) ? parts.slice(3).join(":") : parts.slice(2).join(":");
    await removeChannel(env, parts[1], targetChatId);
    await showRoleMenu(env, chatId, messageId, parts[1], page);
    return;
  }

  if (action === "pst") {
    const edit = (text) => tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
    if (parts[1] === "no") { await edit("Cancelled."); return; }
    if (parts[1] === "broadcast") {
      const srcMsg = Number(parts[2]);
      const running = await env.DB.prepare("SELECT 1 AS x FROM broadcasts WHERE status = 'running' LIMIT 1").first();
      if (running) { await edit("⚠️ A broadcast is already running."); return; }
      const total = await countBroadcastUsers(env);
      await env.DB.prepare("INSERT INTO broadcasts (from_chat, message_id, owner_chat, total) VALUES (?, ?, ?, ?)")
        .bind(String(chatId), srcMsg, String(chatId), total).run();
      await edit(`📢 Broadcast started for <b>${total}</b> users.`);
      await processBroadcast(env, 35);
    }
    return;
  }

  if (action === "pk") {
    const edit = (text, markup) => tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: markup });
    if (parts[1] === "no") { await clearState(env, userId); await edit("Cancelled."); return; }
    const st = (await getState(env, userId)) || "";
    const m = st.match(/^pick:(\d+):(\d+)$/);
    if (!m) { await edit("Session expired. Send /post again."); return; }
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
      for (const c of chosen) {
        const r = await tg(env, "copyMessage", { chat_id: c.chat_id, from_chat_id: chatId, message_id: srcMsg });
        if (r.ok) ok++;
      }
      await clearState(env, userId);
      await edit(`✅ Posted to ${ok} of ${chosen.length} channel(s).`);
    }
    return;
  }

  if (action === "cov") {
    const sub = parts[1], kind = parts[2];
    if (sub === "set" && (kind === "pdf" || kind === "lecture")) {
      await setState(env, userId, `set:cover_${kind}`);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: `🖼️ Send the photo to use as the <b>${kind === "pdf" ? "PDF" : "Video"} cover</b>.`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "cov:menu" }]] },
      });
      return;
    }
    if (sub === "rm") await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`cover_${kind}`).run();
    await clearState(env, userId);
    await showCoverMenu(env, chatId, messageId);
    return;
  }

  if (action === "del") {
    if (parts[1] === "custom") {
      await setState(env, userId, "set:delete_minutes");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId, text: "✏️ Send the number of minutes (1 to 2820).",
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "del:menu" }]] },
      });
      return;
    }
    if (parts[1] === "set") await setSetting(env, "delete_minutes", String(parseInt(parts[2], 10) || 0));
    await clearState(env, userId);
    await showDeleteMenu(env, chatId, messageId);
    return;
  }

  if (action === "pay") {
    const sub = parts[1];
    if (sub === "stars") {
      await setState(env, userId, "set:stars_prices");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId, text: "⭐ Send the 4 Star prices: week, month, 2 months, year.\nExample: <code>12 35 58 290</code>",
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "pay:menu" }]] },
      });
      return;
    }
    if (sub === "startoggle") await setSetting(env, "stars_off", (await starsEnabled(env)) ? "1" : "0");
    if (sub === "upi" || sub === "name") {
      await setState(env, userId, `set:upi_${sub === "upi" ? "id" : "name"}`);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: sub === "upi" ? "💳 Send your UPI ID, like <code>name@bank</code>." : "💳 Send the payee name.",
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "pay:menu" }]] },
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
      if (!upd.meta.changes) { await edit(`Already ${esc(pay.status)}.`); return; }
      const plan = PLANS[pay.plan];
      if (approve) {
        const exp = await activateSubscription(env, pay.user_id, pay.plan);
        await tg(env, "sendMessage", { chat_id: pay.user_id, text: `✅ Payment approved! Premium active until ${fmtDate(exp)}.` });
        await edit(`✅ Approved: user ${esc(pay.user_id)}, ${esc(plan.name)}.`);
      } else {
        await tg(env, "sendMessage", { chat_id: pay.user_id, text: "❌ We couldn't confirm your payment." });
        await edit(`❌ Rejected: user ${esc(pay.user_id)}.`);
      }
      return;
    }
    await clearState(env, userId);
    const pm = await buildPayMenu(env);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: pm.text, parse_mode: "HTML", reply_markup: { inline_keyboard: pm.buttons } });
    return;
  }

  if (action === "meta") {
    const sub = parts[1];
    if (sub === "tmdb" || sub === "omdb" || sub === "sample") {
      const fieldName = sub === "sample" ? "sample_url" : `${sub}_key`;
      await setState(env, userId, `set:${fieldName}`);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: sub === "sample" ? "🎬 Send your Sample Channel Link:" : `🔑 Send your ${sub.toUpperCase()} API Key:`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "meta:menu" }]] },
      });
      return;
    }
    let note = "";
    if (sub === "rmsample") { await env.DB.prepare("DELETE FROM settings WHERE key = 'sample_url'").run(); note = "🗑 Removed."; }
    if (sub === "toggle") {
      const on = (await getSetting(env, "meta_enabled")) === "1";
      if (on) await setSetting(env, "meta_enabled", "0");
      else if (!(await getSetting(env, "tmdb_key")) && !(await getSetting(env, "omdb_key"))) note = "⚠️ Set a TMDb or OMDb key first.";
      else await setSetting(env, "meta_enabled", "1");
    }
    if (sub === "mitoggle") await setSetting(env, "mediainfo_enabled", (await getSetting(env, "mediainfo_enabled")) !== "0" ? "0" : "1");
    if (sub === "grouptoggle") await setSetting(env, "group_qualities", (await getSetting(env, "group_qualities")) !== "0" ? "0" : "1");
    if (sub === "shieldtoggle") await setSetting(env, "shield_redirect", (await getSetting(env, "shield_redirect")) !== "0" ? "0" : "1");
    if (sub === "prottoggle") await setSetting(env, "protect_files", (await getSetting(env, "protect_files")) === "1" ? "0" : "1");

    await clearState(env, userId);
    const mmenu = await buildMetaMenu(env, note);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: mmenu.text, parse_mode: "HTML", reply_markup: { inline_keyboard: mmenu.buttons } });
    return;
  }

  if (action === "sl") {
    const sub = parts[1];
    if (sub === "domain" || sub === "key" || sub === "tutorial") {
      const fieldMap = { domain: "shortlink_domain", key: "shortlink_key", tutorial: "tutorial_url" };
      await setState(env, userId, `set:${fieldMap[sub]}`);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: sub === "domain" ? "🌐 Send shortlink domain:" : sub === "key" ? "🔑 Send shortlink API key:" : "🎬 Send tutorial link:",
        parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "sl:menu" }]] },
      });
      return;
    }
    let note = "";
    if (sub === "toggle_vpass") {
      const cur = (await getSetting(env, "vpass_enabled")) !== "0";
      await setSetting(env, "vpass_enabled", cur ? "0" : "1");
    }
    if (sub === "rmtut") await env.DB.prepare("DELETE FROM settings WHERE key = 'tutorial_url'").run();
    if (sub === "toggle") {
      const on = (await getSetting(env, "shortlink_enabled")) === "1";
      if (on) await setSetting(env, "shortlink_enabled", "0");
      else if (!(await getSetting(env, "shortlink_domain")) || !(await getSetting(env, "shortlink_key"))) note = "⚠️ Set Domain & API Key first.";
      else await setSetting(env, "shortlink_enabled", "1");
    }
    await clearState(env, userId);
    await showShortlinkMenu(env, chatId, messageId, note);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    setAppOrigin(url.origin);

    if (request.method === "GET" && url.pathname === "/verify") {
      return new Response(VERIFY_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname.startsWith("/get/")) {
      const startParam = url.pathname.slice(5).replace(/[^A-Za-z0-9_-]/g, "");
      const username = await getBotUsername(env);
      if (!username || !startParam) return new Response("Not found", { status: 404 });
      return Response.redirect(`https://t.me/${username}?start=${startParam}`, 302);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url.pathname);
    }
    if (request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (env.WEBHOOK_SECRET && !safeEqual(secret, env.WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        if (update.pre_checkout_query) await handlePreCheckout(update.pre_checkout_query, env);
        else if (update.message) await handleMessage(update.message, env);
        else if (update.channel_post) await handleChannelPost(update.channel_post, env);
        else if (update.callback_query) await handleButton(update.callback_query, env);
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
