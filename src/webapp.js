import {
  tg, esc, safeEqual, PLANS, getSetting, getSubExpiry, getStarPrices,
  starsEnabled, activateSubscription, fmtDate, getBotUsername, shortenUrl, alertOwner
} from "./core.js";

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
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleApi(request, env, path) {
  if (request.method !== "POST") return json({ error: "Not allowed" }, 405);
  const user = await verifyInitData(env, request.headers.get("X-Init-Data") || "");
  if (!user) return json({ error: "auth" }, 401);
  const uid = String(user.id);

  const ban = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(uid).first();
  if (ban && ban.banned) return json({ error: "Your account can't use this." }, 403);

  let body = {};
  try { body = await request.json(); } catch (err) {}

  if (path === "/api/verify-link") {
    const tok = String(body.token || "").trim();
    const t = await env.DB.prepare("SELECT token, user_id, file_row_id, created FROM tokens WHERE token = ?").bind(tok).first();
    if (!t || String(t.user_id) !== uid || Date.now() - t.created > 3600 * 1000) {
      return json({ error: "This verification session has expired. Please tap the button in the bot again." }, 400);
    }
    await env.DB.prepare("UPDATE tokens SET created = ? WHERE token = ?").bind(Date.now(), tok).run();
    const username = await getBotUsername(env);
    const short = await shortenUrl(env, `https://t.me/${username}?start=v_${tok}`);
    if (!short) return json({ error: "Verification server is busy. Please try again." }, 500);
    return json({ url: short });
  }

  const upiId = await getSetting(env, "upi_id");

  if (path === "/api/me") {
    const until = await getSubExpiry(env, uid);
    const w = await env.DB.prepare("SELECT id, plan, amount FROM payments WHERE user_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1").bind(uid).first();
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
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND created > ?").bind(uid, Date.now() - 3600000).first();
    if (recent.n >= 8) return json({ error: "Too many attempts. Please try again in a while." }, 429);

    const ins = await env.DB.prepare("INSERT INTO payments (user_id, plan, amount, status, created) VALUES (?, ?, ?, 'pending', ?)")
      .bind(uid, body.plan, plan.price, Date.now()).run();
    const payee = (await getSetting(env, "upi_name")) || "Premium";
    const link = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${plan.price}.00&cu=INR&tn=${encodeURIComponent("Premium " + plan.name)}`;
    return json({ id: ins.meta.last_row_id, plan: plan.name, amount: plan.price, upi_id: upiId, payee, link });
  }

  if (path === "/api/stars") {
    if (!(await starsEnabled(env))) return json({ error: "Stars payments aren't available right now." }, 400);
    const plan = PLANS[body.plan];
    if (!plan) return json({ error: "Unknown plan." }, 400);
    const stars = (await getStarPrices(env))[body.plan];
    const ins = await env.DB.prepare("INSERT INTO payments (user_id, plan, amount, status, method, created) VALUES (?, ?, ?, 'pending', 'stars', ?)")
      .bind(uid, body.plan, stars, Date.now()).run();
    const inv = await tg(env, "createInvoiceLink", {
      title: `Premium - ${plan.name}`,
      description: `Skip the ads for ${plan.name}. Active right after payment.`,
      payload: `pay:${ins.meta.last_row_id}`,
      currency: "XTR",
      prices: [{ label: plan.name, amount: stars }],
    });
    if (!inv.ok) return json({ error: "Couldn't start the payment. Please try again." }, 500);
    return json({ link: inv.result, stars });
  }

  if (path === "/api/utr") {
    const utr = String(body.utr || "").trim();
    if (!/^[0-9]{12}$/.test(utr)) return json({ error: "The reference number (UTR) is 12 digits." }, 400);
    const pay = await env.DB.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").bind(Number(body.id), uid).first();
    if (!pay || pay.status !== "pending") return json({ error: "This payment can't be updated." }, 400);
    try {
      const upd = await env.DB.prepare("UPDATE payments SET utr = ?, status = 'submitted' WHERE id = ? AND status = 'pending'").bind(utr, pay.id).run();
      if (!upd.meta.changes) return json({ error: "This payment can't be updated." }, 400);
    } catch (err) {
      return json({ error: "This reference number was already used." }, 400);
    }
    const plan = PLANS[pay.plan];
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_ID,
      text: `💳 <b>Payment to approve</b>\n\nUser: <code>${esc(uid)}</code> ${esc(user.first_name || "")}\nPlan: ${esc(plan.name)} (₹${plan.price})\nUTR: <code>${esc(utr)}</code>`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pay:ok:${pay.id}` }, { text: "❌ Reject", callback_data: `pay:no:${pay.id}` }]] },
    });
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

export async function handlePreCheckout(q, env) {
  let ok = false;
  try {
    const m = /^pay:(\d+)$/.exec(q.invoice_payload || "");
    const pay = m ? await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(Number(m[1])).first() : null;
    const ban = await env.DB.prepare("SELECT banned FROM users WHERE user_id = ?").bind(String(q.from.id)).first();
    ok = !!pay && pay.method === "stars" && pay.status === "pending" &&
      pay.user_id === String(q.from.id) && q.currency === "XTR" && q.total_amount === pay.amount && !(ban && ban.banned);
  } catch (err) {}
  await tg(env, "answerPreCheckoutQuery", ok
    ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: "Sorry, this payment can't be completed." });
}

export async function handleStarsPaid(env, msg) {
  const sp = msg.successful_payment;
  if (sp.currency !== "XTR") return;
  const uid = String(msg.from.id);
  const charge = sp.telegram_payment_charge_id;
  try {
    const m = /^pay:(\d+)$/.exec(sp.invoice_payload || "");
    const pay = m ? await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(Number(m[1])).first() : null;
    if (!pay || pay.method !== "stars" || pay.user_id !== uid) return;
    const claim = await env.DB.prepare("UPDATE payments SET status = 'approved', utr = ?, decided = ? WHERE id = ? AND status = 'pending'")
      .bind(`stars:${charge}`, Date.now(), pay.id).run();
    if (!claim.meta.changes) return;

    const exp = await activateSubscription(env, uid, pay.plan);
    const plan = PLANS[pay.plan];
    await tg(env, "sendMessage", { chat_id: uid, text: `✅ Payment received! Premium is active until ${fmtDate(exp)}.` });
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `⭐ New Stars payment: user ${uid}, ${plan.name}, ${pay.amount} Stars. Premium until ${fmtDate(exp)}.` });
  } catch (err) {
    await alertOwner(env, `stars_error${charge}`, `Stars payment error for user ${uid}: ${String(err).slice(0, 200)}`);
  }
}

export const VERIFY_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Secure Verification</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#0f172a);--text:var(--tg-theme-text-color,#f8fafc);--hint:var(--tg-theme-hint-color,#94a3b8);--accent:var(--tg-theme-button-color,#2563eb);--accent-text:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#1e293b)}
*{box-sizing:border-box;-webkit-user-select:none;user-select:none}
body{margin:0;padding:24px 18px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;text-align:center;display:flex;flex-direction:column;justify-content:center;min-height:92vh}
.card{background:var(--card);border-radius:18px;padding:24px 18px;box-shadow:0 8px 24px rgba(0,0,0,0.25)}
.icon{font-size:44px;margin-bottom:8px}h1{font-size:20px;margin:6px 0}p{color:var(--hint);font-size:14px;margin:8px 0 20px}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer}
.err{color:#ef4444;font-size:14px;margin-top:12px}
</style></head><body oncontextmenu="return false;">
<div class="card"><div class="icon">🛡️</div><h1 id="title">Preparing Verification...</h1><p id="desc">Generating your one-time verification session.</p><button class="btn" id="go" style="display:none">🚀 Continue to Verification</button><div class="err" id="err"></div></div>
<script>
var tg = window.Telegram && window.Telegram.WebApp; if (tg) { tg.ready(); tg.expand(); }
var token = new URLSearchParams(location.search).get("t") || "";
var titleEl = document.getElementById("title"), descEl = document.getElementById("desc"), btnEl = document.getElementById("go"), errEl = document.getElementById("err");
if (!tg || !tg.initData) { titleEl.textContent = "🚫 Access Denied"; descEl.textContent = "Open this inside the official Telegram app."; }
else {
  fetch("/api/verify-link", { method: "POST", headers: { "Content-Type": "application/json", "X-Init-Data": tg.initData }, body: JSON.stringify({ token: token }) })
  .then(r => r.json()).then(d => {
    if (d.error || !d.url) { titleEl.textContent = "⚠️ Session Expired"; descEl.textContent = d.error || "Tap the button in the bot again."; return; }
    titleEl.textContent = "🛡️ Security Check Ready"; descEl.textContent = "Tap below and complete the short step to unlock your file.";
    btnEl.style.display = "block"; btnEl.onclick = function() { btnEl.disabled = true; tg.openLink(d.url, { try_instant_view: false }); setTimeout(() => tg.close(), 350); };
  }).catch(() => { errEl.textContent = "Network error. Please try again."; });
}
</script></body></html>`;

// Keep your existing APP_HTML string here or import it:
export const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Skip Ads</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--text:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#707579);--accent:var(--tg-theme-button-color,#2481cc);--accent-text:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#f1f3f5)}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,sans-serif}
h1{font-size:22px;margin:4px 0}.sub{color:var(--hint);margin:4px 0 14px;font-size:15px}.card{background:var(--card);border-radius:14px;padding:14px;margin-bottom:12px}
.plan{display:flex;justify-content:space-between;align-items:center;width:100%;border:0;color:var(--text);font:inherit;cursor:pointer}.plan b{font-size:18px}
.btn{display:block;width:100%;padding:13px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;margin-top:10px}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}.big{font-size:30px;font-weight:700;margin:2px 0}.mono{font-family:monospace;word-break:break-all}
input{width:100%;padding:13px;border-radius:12px;border:1px solid var(--hint);background:var(--bg);color:var(--text);font-size:18px}.err{color:#d93025;margin-top:8px;font-size:14px}
</style></head><body><div id="root"></div>
<script>
var tg = window.Telegram && window.Telegram.WebApp; if (tg) { tg.ready(); tg.expand(); }
var root = document.getElementById("root"), ME = null;
function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
function api(p, b) { return fetch(p, { method: "POST", headers: { "Content-Type": "application/json", "X-Init-Data": tg ? tg.initData : "" }, body: JSON.stringify(b || {}) }).then(r => r.json()).catch(() => ({ error: "Network error" })); }
function load() { clear(); root.appendChild(el("p", "sub", "Loading...")); api("/api/me").then(me => { if (me.error) { clear(); root.appendChild(el("p", "sub", me.error)); return; } ME = me; home(me); }); }
function home(me) {
  clear(); root.appendChild(el("h1", null, "⭐ Skip the ads")); root.appendChild(el("p", "sub", "Get your files instantly, with no verification step."));
  var st = el("div", "card"); st.appendChild(el("b", null, me.premium_until ? "Premium active until " + me.premium_until : "No active plan")); root.appendChild(st);
  me.plans.forEach(p => { var b = el("button", "card plan"); b.appendChild(el("span", null, p.name)); b.appendChild(el("b", null, me.upi_ready ? "Rs " + p.price : "⭐ " + p.stars)); b.onclick = () => choose(p); root.appendChild(b); });
}
function choose(p) {
  if (ME.upi_ready && ME.stars_ready) {
    clear(); root.appendChild(el("h1", null, p.name));
    var u = el("button", "btn", "Pay with UPI - Rs " + p.price); u.onclick = () => startPay(p); root.appendChild(u);
    var s = el("button", "btn", "Pay with Stars - ⭐ " + p.stars); s.onclick = () => startStars(p); root.appendChild(s);
    var bk = el("button", "btn ghost", "Back"); bk.onclick = load; root.appendChild(bk); return;
  }
  if (ME.stars_ready) return startStars(p); startPay(p);
}
function startStars(p) { api("/api/stars", { plan: p.key }).then(d => { if (!d.error && tg) tg.openInvoice(d.link, st => { if (st === "paid") load(); }); }); }
function startPay(p) { api("/api/pay", { plan: p.key }).then(d => { if (!d.error) pay(d); }); }
function pay(d) {
  clear(); root.appendChild(el("h1", null, d.plan));
  var c = el("div", "card"); c.appendChild(el("div", "big", "Rs " + d.amount)); c.appendChild(el("div", "mono", d.upi_id));
  var open = el("a", "btn", "Open UPI app"); open.href = d.link; c.appendChild(open); root.appendChild(c);
  var inp = el("input"); inp.placeholder = "12-digit UTR number"; inp.maxLength = 12; root.appendChild(inp);
  var err = el("div", "err"); root.appendChild(err);
  var go = el("button", "btn", "I've paid - submit");
  go.onclick = () => { api("/api/utr", { id: d.id, utr: inp.value }).then(r => { if (r.error) err.textContent = r.error; else load(); }); };
  root.appendChild(go);
}
load();
</script></body></html>`;
