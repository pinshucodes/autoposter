// Autoposter Bot - Step 1: the /settings menu
// Runs on Cloudflare Workers. No libraries needed.
//
// Secrets to add in Cloudflare (Settings > Variables and Secrets):
//   BOT_TOKEN       - token from BotFather
//   OWNER_ID        - your numeric Telegram user ID
//   WEBHOOK_SECRET  - any random text you make up (letters/numbers only)

// ---------- Talking to Telegram ----------
async function tg(env, method, data) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

// ---------- Menus ----------
// Each button has a label and a "callback" name that tells us which button was tapped.
const MAIN_MENU = {
  text: "⚙️ <b>Settings</b>\n\nSelect what you want to configure:",
  buttons: [
    [{ text: "📥 Source Channels", callback_data: "source" }],
    [{ text: "🎓 Lectures Channel", callback_data: "lectures" }],
    [{ text: "📄 PDFs Channel", callback_data: "pdfs" }],
    [{ text: "🔐 ForceSub Settings", callback_data: "forcesub" }],
    [{ text: "🔗 Shortlink Settings", callback_data: "shortlink" }],
    [{ text: "🗑️ File Delete Settings", callback_data: "delete" }],
    [{ text: "❌ Close", callback_data: "close" }],
  ],
};

// Sub-menus. For now they are placeholders; we fill them in later steps.
const SUB_MENUS = {
  source: "📥 <b>Source Channels</b>\n\nComing in the next step.",
  lectures: "🎓 <b>Lectures Channel</b>\n\nComing in the next step.",
  pdfs: "📄 <b>PDFs Channel</b>\n\nComing in the next step.",
  forcesub: "🔐 <b>ForceSub Settings</b>\n\nComing in the next step.",
  shortlink: "🔗 <b>Shortlink Settings</b>\n\nComing in the next step.",
  delete: "🗑️ <b>File Delete Settings</b>\n\nComing in the next step.",
};

const BACK_BUTTON = [[{ text: "⬅️ Back", callback_data: "back" }]];

// ---------- Handling messages ----------
async function handleMessage(msg, env) {
  const text = msg.text || "";
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (text.startsWith("/start")) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "👋 Hi! I'm your Autoposter bot.\nOwner can use /settings to configure me.",
    });
    return;
  }

  if (text.startsWith("/settings")) {
    // Only the owner may open settings
    if (userId !== String(env.OWNER_ID)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⛔ Only the bot owner can use this command.",
      });
      return;
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: MAIN_MENU.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU.buttons },
      reply_to_message_id: msg.message_id,
    });
  }
}

// ---------- Handling button taps ----------
async function handleButton(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const action = query.data;

  // Block anyone who isn't the owner
  if (String(query.from.id) !== String(env.OWNER_ID)) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Only the owner can do this.",
      show_alert: true,
    });
    return;
  }

  // Tell Telegram the tap was received (removes the loading spinner)
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });

  if (action === "close") {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    return;
  }

  if (action === "back") {
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: MAIN_MENU.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU.buttons },
    });
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

// ---------- Entry point: Telegram calls this for every update ----------
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Autoposter bot is running ✅");
    }

    // Reject requests that don't come from Telegram
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json();
    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleButton(update.callback_query, env);
    } catch (err) {
      console.log("Error:", err);
    }
    return new Respons
    e("OK");
  },
};
