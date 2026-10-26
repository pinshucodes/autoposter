// src/testmode.js - Standalone Test Mode (Sandbox) Manager

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Handles the /test command in bot private chat:
 * - /test               -> View status & instructions
 * - /test set <chat_id> -> Save your test channel
 * - /test on            -> Enable Test Mode (pauses 30+ live channels)
 * - /test off           -> Disable Test Mode (resumes live channels)
 */
export async function handleTestCommand(env, chatId, text, { tg, getSetting, setSetting }) {
  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] || "").toLowerCase();
  const arg = parts[2] || "";

  // 1. Set the Test Channel: /test set -100xxxx or /test set @channel
  if (sub === "set") {
    if (!arg) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Usage: <code>/test set -1001234567890</code> or <code>/test set @channelusername</code>",
        parse_mode: "HTML",
      });
      return;
    }
    const chatRes = await tg(env, "getChat", { chat_id: arg });
    if (!chatRes.ok || !chatRes.result) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Could not find that channel. Make sure I am added as an Admin in the test channel first!",
      });
      return;
    }
    const chId = String(chatRes.result.id);
    const chTitle = chatRes.result.title || chatRes.result.username || chId;
    await setSetting(env, "test_channel_id", chId);
    await setSetting(env, "test_channel_title", chTitle);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ <b>Test Channel Saved!</b>\n\n📺 <b>${esc(chTitle)}</b> (<code>${esc(chId)}</code>)\n\nSend <code>/test on</code> whenever you want to pause live channels and test posts here.`,
      parse_mode: "HTML",
    });
    return;
  }

  // 2. Turn Test Mode ON: /test on
  if (sub === "on") {
    const chId = await getSetting(env, "test_channel_id");
    const chTitle = (await getSetting(env, "test_channel_title")) || chId;
    if (!chId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Set a test channel first using:\n<code>/test set -1001234567890</code>",
        parse_mode: "HTML",
      });
      return;
    }
    await setSetting(env, "test_mode", "1");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `🟢 <b>TEST MODE IS NOW ON!</b>\n\nAll 30+ live channels are safely paused.\nNew uploads and <code>/digest</code> will post ONLY to:\n🧪 <b>${esc(chTitle)}</b> (<code>${esc(chId)}</code>)\n\nSend <code>/test off</code> when you are ready to go live again.`,
      parse_mode: "HTML",
    });
    return;
  }

  // 3. Turn Test Mode OFF: /test off
  if (sub === "off") {
    await setSetting(env, "test_mode", "0");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔴 <b>TEST MODE IS NOW OFF!</b>\n\n✅ Your 30+ live channels are active again. All new uploads will publish normally.",
      parse_mode: "HTML",
    });
    return;
  }

  // 4. Default: Show Status & Help (/test)
  const isOn = (await getSetting(env, "test_mode")) === "1";
  const chId = await getSetting(env, "test_channel_id");
  const chTitle = await getSetting(env, "test_channel_title");

  const statusLine = isOn
    ? "🟢 <b>ON (Live Channels Paused — Posting ONLY to Test Channel)</b>"
    : "🔴 <b>OFF (Normal — Posting to 30+ Live Channels)</b>";

  const chanLine = chId
    ? `📺 <b>${esc(chTitle || "Saved Channel")}</b> (<code>${esc(chId)}</code>)`
    : "<i>Not set yet</i>";

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `🧪 <b>Test Mode (Sandbox) Control</b>\n\n` +
      `<b>Status:</b> ${statusLine}\n` +
      `<b>Test Channel:</b> ${chanLine}\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/test set -100123456789</code> — Set your test channel\n` +
      `• <code>/test on</code> — Pause live channels & post only to test channel\n` +
      `• <code>/test off</code> — Resume normal live posting`,
    parse_mode: "HTML",
  });
}

/**
 * Helper used by index.js & digest.js:
 * If Test Mode is ON, overrides the target channel list with the Test Channel.
 */
export async function resolveTargetChannels(env, normalChannels, getSetting) {
  const isOn = (await getSetting(env, "test_mode")) === "1";
  if (!isOn) return { isTestMode: false, targets: normalChannels };

  const chId = await getSetting(env, "test_channel_id");
  const chTitle = (await getSetting(env, "test_channel_title")) || "Test Channel";
  if (!chId) return { isTestMode: false, targets: normalChannels };

  return {
    isTestMode: true,
    targets: [{ chat_id: chId, role: "test", title: chTitle }],
  };
}
