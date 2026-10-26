// Director Tricks bot server: Telegram webhook + API for the Mini App + scheduled jobs.
// Secrets (Cloudflare dashboard → Variables and Secrets): BOT_TOKEN, WEBHOOK_SECRET, SETUP_KEY.
import { SCHEMA } from "./schema.js";

const PRICES = { m: { stars: 600, days: 30, title: "Pro · 1 month" }, y: { stars: 5000, days: 365, title: "Pro · 12 months" } };
const NEW_USER_DAYS = 3, DISCOUNT = 0.85;
const RANKS = [[5, "Director"], [3, "Crew"], [1, "Insider"], [0, "Viewer"]];
const DEFAULT_TABS = [
  { id: "latest", label: "Latest", kind: "latest" },
  { id: "plugins", label: "Plugins", filters: ["Photoshop", "After Effects", "Premiere Pro", "DaVinci Resolve", "Final Cut Pro"] },
  { id: "overlays", label: "Overlays", filters: ["Transitions", "Film & retro", "VFX elements", "Titles", "Textures & PNG", "Light leaks", "Glitch", "Packs"] },
  { id: "sfx", label: "SFX", filters: ["Whooshes", "Impacts", "Risers", "Ambience", "Sound packs"] },
  { id: "luts", label: "LUTs", filters: ["Film emulation", "Music video", "Log to Rec.709", "Lightroom presets", "Teal & orange", "Black & white"] },
  { id: "course", label: "Course", kind: "course" },
  { id: "ai", label: "AI", pub: true, filters: ["Prompts", "Workflows", "Higgsfield", "Seedance", "Midjourney", "Voice"] }
];
async function getTabs(env) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k='tabs'").first(); return r ? JSON.parse(r.v) : DEFAULT_TABS; }
const sectionIds = tabs => tabs.filter(t => !t.kind).map(t => t.id);
const ACCESS = { "#free": 0, "#f1": 1, "#f3": 3, "#f5": 5, "#pro": 9 };

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const plusDays = (from, n) => { const d = new Date(Math.max(Date.now(), Date.parse(from || 0) || 0)); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const json = (data, status = 200, env) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors(env) } });
const cors = env => ({ "access-control-allow-origin": env?.APP_ORIGIN || "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
const admins = env => String(env.ADMIN_IDS || "").split(",").map(s => +s.trim()).filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(+id);
const isPro = u => u && u.plan === "pro" && (u.until || "") >= today();

let migrated = false;
async function migrate(env) { if (migrated) return; await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); migrated = true; }

async function tg(env, method, body) {
  let j;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    j = await r.json().catch(() => ({ ok: false }));
  } catch (e) { j = { ok: false, description: String(e) }; }
  if (!j.ok) console.log("telegram error", method, JSON.stringify(j).slice(0, 300));
  return j;
}
const appButton = (env, text = "Open the Vault") => ({ inline_keyboard: [[{ text, web_app: { url: env.APP_URL } }]] });

// ---------- Mini App login check (Telegram initData signature) ----------
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
async function checkInitData(env, initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData), hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - +p.get("auth_date") > 86400) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

// ---------- users ----------
async function upsertUser(env, u, refBy) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  const old = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
  if (old) { await env.DB.prepare("UPDATE users SET username=?, name=?, last_seen=? WHERE id=?").bind(u.username || null, name, now(), u.id).run(); return { user: { ...old, username: u.username, name }, isNew: false }; }
  const ref = refBy && refBy !== u.id ? refBy : null;
  await env.DB.prepare("INSERT INTO users(id,username,name,joined,last_seen,ref_by) VALUES(?,?,?,?,?,?)").bind(u.id, u.username || null, name, now(), now(), ref).run();
  return { user: await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first(), isNew: true };
}
const invitedCount = async (env, id) => (await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE ref_by=?").bind(id).first()).c;
const rankOf = inv => RANKS.find(([k]) => inv >= k)[1];
const logEv = (env, uid, kind, text) => env.DB.prepare("INSERT INTO events(user_id,at,kind,text) VALUES(?,?,?,?)").bind(uid, now(), kind, text).run();
const canOpen = (u, inv, it) => it.shop || isPro(u) || it.tier === 0 || (it.tier <= 5 && inv >= it.tier);
const canDiscount = u => !u.paid && Date.now() - Date.parse(u.joined) < NEW_USER_DAYS * 864e5;

async function grantPro(env, uid, days, note) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
  const until = plusDays(isPro(u) ? u.until : null, days);
  await env.DB.prepare("UPDATE users SET plan='pro', until=? WHERE id=?").bind(until, uid).run();
  await logEv(env, uid, "sys", `${note}: Pro until ${until}`);
  await tg(env, "sendMessage", { chat_id: uid, text: `✅ Your Pro plan is active until ${until}. Every pack and lesson is open.`, reply_markup: appButton(env) });
  return until;
}

// ---------- catalog parsing for source channels ----------
function parsePost(text, src, tabs) {
  const SECTIONS = sectionIds(tabs);
  const low = (text || "").toLowerCase(), lines = (text || "").split("\n").map(s => s.trim()).filter(Boolean);
  const cat = src.sec !== "auto" ? src.sec : (SECTIONS.find(s => low.includes("#" + s)) || SECTIONS[0]);
  const tab = tabs.find(t => t.id === cat) || {}, norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const f = (tab.filters || []).find(x => low.includes("#" + norm(x))) || null;
  const tagTier = Object.entries(ACCESS).find(([k]) => low.includes(k));
  const tier = src.kind === "partner" ? 0 : src.tier === "tag" ? (tagTier ? tagTier[1] : 0) : +src.tier;
  const name = (lines[0] || "New resource").replace(/#\S+/g, "").trim().slice(0, 120);
  const descr = lines.slice(1).filter(l => !/^#/.test(l)).join("\n").slice(0, 600);
  const link = src.kind === "partner" ? ((text || "").match(/https?:\/\/\S+/) || [null])[0] : null;
  return { cat, f, tier, name, descr, link };
}
async function nextSlot(env) {
  const last = (await env.DB.prepare("SELECT MAX(date) d FROM items WHERE status='scheduled'").first()).d;
  let d = new Date(Date.parse(last && last > today() ? last : today()) + 864e5);
  while (![1, 3, 5].includes(d.getUTCDay())) d = new Date(d.getTime() + 864e5);
  return d.toISOString().slice(0, 10);
}
async function onChannelPost(env, post) {
  const src = await env.DB.prepare("SELECT * FROM sources WHERE chat_id=?").bind(post.chat.id).first();
  if (!src) return;
  const tabs = await getTabs(env);
  const caption = post.caption || post.text || "";
  const media = {};
  if (post.photo) Object.assign(media, { preview_id: post.photo.at(-1).file_id, preview_type: "photo" });
  if (post.video) Object.assign(media, { preview_id: post.video.file_id, preview_type: "video" });
  if (post.animation) Object.assign(media, { preview_id: post.animation.file_id, preview_type: "animation" });
  if (post.document && src.kind === "own") Object.assign(media, { file_id: post.document.file_id, file_type: "document", size: post.document.file_size ? (post.document.file_size / 1048576).toFixed(0) + " MB" : null });
  if (post.audio && src.kind === "own") Object.assign(media, { file_id: post.audio.file_id, file_type: "audio" });
  const group = post.media_group_id ? `${post.chat.id}:${post.media_group_id}` : null;
  const existing = group && await env.DB.prepare("SELECT * FROM items WHERE src_group=?").bind(group).first();
  if (existing) {
    const p = caption ? parsePost(caption, src, tabs) : {};
    const f = { ...p, ...media };
    const keys = Object.keys(f).filter(k => f[k] != null && (k !== "preview_id" || !existing.preview_id));
    if (keys.length) await env.DB.prepare(`UPDATE items SET ${keys.map(k => k + "=?").join(",")} WHERE id=?`).bind(...keys.map(k => f[k]), existing.id).run();
    return;
  }
  const p = parsePost(caption, src, tabs);
  const status = src.on_post === "publish" ? "live" : src.on_post === "draft" ? "draft" : "scheduled";
  const date = status === "scheduled" ? await nextSlot(env) : today();
  await env.DB.prepare(`INSERT INTO items(cat,f,name,descr,tier,date,status,shop,brand,link,file_id,file_type,preview_id,preview_type,size,src_chat,src_msg,src_group)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(p.cat, p.f, p.name, p.descr, p.tier, date, status, src.kind === "partner" ? 1 : 0, src.kind === "partner" ? src.title : null,
    p.link, media.file_id || null, media.file_type || null, media.preview_id || null, media.preview_type || null, media.size || null, post.chat.id, post.message_id, group).run();
  await env.DB.prepare("UPDATE sources SET last=?, count=count+1 WHERE chat_id=?").bind(now(), post.chat.id).run();
}

// ---------- Telegram webhook ----------
async function onUpdate(env, up) {
  if (up.channel_post) return onChannelPost(env, up.channel_post);
  if (up.my_chat_member && up.my_chat_member.chat.type === "channel") {
    const c = up.my_chat_member.chat, st = up.my_chat_member.new_chat_member.status;
    if (st === "administrator") {
      await env.DB.prepare("INSERT INTO sources(chat_id,title,handle,last) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, ok=1").bind(c.id, c.title, c.username ? "@" + c.username : null, now()).run();
      for (const a of admins(env)) await tg(env, "sendMessage", { chat_id: a, text: `📥 Bot is now admin in “${c.title}”. New posts there will be read. Set its type in Admin → Sources.` });
    } else await env.DB.prepare("UPDATE sources SET ok=0 WHERE chat_id=?").bind(c.id).run();
    return;
  }
  if (up.pre_checkout_query) return tg(env, "answerPreCheckoutQuery", { pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
  if (up.callback_query) return onCallback(env, up.callback_query);
  const m = up.message;
  if (!m || m.chat.type !== "private") return;
  const from = m.from;

  if (m.successful_payment) {
    const sp = m.successful_payment, pl = JSON.parse(sp.invoice_payload || "{}");
    await upsertUser(env, from);
    await env.DB.prepare("INSERT INTO payments(user_id,method,plan,amount,status,charge_id,via,at) VALUES(?,?,?,?,?,?,?,?)").bind(from.id, "Telegram Stars", pl.plan, sp.total_amount + " ⭐", "paid", sp.telegram_payment_charge_id, "app", now()).run();
    await env.DB.prepare("UPDATE users SET paid=1 WHERE id=?").bind(from.id).run();
    await grantPro(env, from.id, PRICES[pl.plan]?.days || 30, "paid with Stars");
    for (const a of admins(env)) await tg(env, "sendMessage", { chat_id: a, text: `💰 ${from.first_name} (@${from.username || from.id}) paid ${sp.total_amount} ⭐ for ${pl.plan === "y" ? "12 months" : "1 month"}` });
    return;
  }

  const text = m.text || "";
  if (text.startsWith("/start")) {
    const arg = text.split(" ")[1] || "";
    let refBy = null;
    if (arg.startsWith("ref_")) { const r = arg.slice(4); const ref = /^\d+$/.test(r) ? await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(+r).first() : await env.DB.prepare("SELECT id FROM users WHERE lower(username)=?").bind(r.toLowerCase()).first(); refBy = ref?.id; }
    const { isNew } = await upsertUser(env, from, refBy);
    await logEv(env, from.id, "in", "/start" + (arg ? " " + arg : ""));
    await tg(env, "sendMessage", { chat_id: from.id, text: `Welcome to Director Tricks 🎬\n\nEditing packs, LUTs, SFX and the breakdowns behind viral music videos. Invite friends to unlock more, or go Pro for everything.`, reply_markup: appButton(env) });
    if (isNew && refBy) {
      const n = await invitedCount(env, refBy);
      await logEv(env, refBy, "sys", `friend joined: ${from.first_name} (${n}/5)`);
      await tg(env, "sendMessage", { chat_id: refBy, text: `🎉 ${from.first_name} joined with your link. Friends: ${n}/5, status ${rankOf(n)}.`, reply_markup: appButton(env) });
    }
    return;
  }
  await upsertUser(env, from);
  if (m.photo || (m.document && /^image\//.test(m.document.mime_type || ""))) {
    // payment screenshot for a manual (USDT) transfer → admins approve in Telegram or in the app
    const fid = m.photo ? m.photo.at(-1).file_id : m.document.file_id;
    const r = await env.DB.prepare("INSERT INTO payments(user_id,method,plan,amount,status,proof_file_id,via,at) VALUES(?,?,?,?,?,?,?,?) RETURNING id").bind(from.id, "USDT transfer", "m", "check screenshot", "pending", fid, "bot chat", now()).first();
    await logEv(env, from.id, "in", `sent payment screenshot → #${r.id}`);
    await tg(env, "sendMessage", { chat_id: from.id, text: `Got it. Payment #${r.id} is being checked, usually within a few hours.` });
    for (const a of admins(env)) await tg(env, "sendPhoto", { chat_id: a, photo: fid, caption: `🧾 Payment #${r.id} from ${from.first_name} (@${from.username || from.id})`, reply_markup: { inline_keyboard: [[{ text: "✅ Approve 1 month", callback_data: `pay:${r.id}:m` }, { text: "✅ 12 months", callback_data: `pay:${r.id}:y` }], [{ text: "❌ Reject", callback_data: `pay:${r.id}:x` }]] } });
    return;
  }
  const fwd = m.forward_origin?.type === "channel" ? m.forward_origin.chat : m.forward_from_chat;
  if (fwd && isAdmin(env, from.id)) {
    const meBot = await tg(env, "getMe"), mem = await tg(env, "getChatMember", { chat_id: fwd.id, user_id: meBot.result?.id });
    if (!["administrator", "creator"].includes(mem.result?.status)) return tg(env, "sendMessage", { chat_id: from.id, text: `Make me an admin of “${fwd.title}” first, then forward a post again.` });
    await env.DB.prepare("INSERT INTO sources(chat_id,title,handle,last) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET ok=1").bind(fwd.id, fwd.title, fwd.username ? "@" + fwd.username : null, now()).run();
    return tg(env, "sendMessage", { chat_id: from.id, text: `📥 “${fwd.title}” is connected. New posts there will be read. Set its type in Admin → Sources.` });
  }
  if (text && !isAdmin(env, from.id)) {
    await logEv(env, from.id, "in", "message: " + text.slice(0, 500));
    for (const a of admins(env)) await tg(env, "sendMessage", { chat_id: a, text: `💬 ${from.first_name} (@${from.username || from.id}, id ${from.id}):\n${text.slice(0, 1000)}\n\nReply from Admin → Users in the app.` });
  }
}

async function settlePayment(env, id, plan, adminId) {
  const p = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(id).first();
  if (!p || p.status !== "pending") return "already handled";
  if (plan === "x") {
    await env.DB.prepare("UPDATE payments SET status='rejected' WHERE id=?").bind(id).run();
    await logEv(env, p.user_id, "sys", `payment #${id} rejected by ${adminId}`);
    await tg(env, "sendMessage", { chat_id: p.user_id, text: "We couldn't confirm this transfer. Reply here and we'll sort it out." });
    return "rejected";
  }
  await env.DB.prepare("UPDATE payments SET status='approved', plan=? WHERE id=?").bind(plan, id).run();
  await env.DB.prepare("UPDATE users SET paid=1 WHERE id=?").bind(p.user_id).run();
  await grantPro(env, p.user_id, PRICES[plan].days, `payment #${id} approved`);
  return "approved";
}
async function onCallback(env, q) {
  const [kind, id, plan] = (q.data || "").split(":");
  if (kind !== "pay" || !isAdmin(env, q.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const res = await settlePayment(env, +id, plan, q.from.id);
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: `#${id} ${res}` });
  if (q.message) await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: `#${id} ${res}`, callback_data: "noop" }]] } });
}

// ---------- API for the Mini App ----------
const publicItem = it => ({ id: it.id, cat: it.cat, name: it.name, descr: it.descr, f: it.f, soft: it.soft ? JSON.parse(it.soft) : [], size: it.size || "", n: it.n || "", tier: it.tier, val: it.val, date: it.date,
  shop: !!it.shop, brand: it.brand, link: it.shop ? it.link : undefined, img: it.img || (it.preview_id ? `/img/${it.id}` : null), vid: it.preview_type === "video" });
const adminItem = it => ({ ...publicItem(it), status: it.status, hasFile: !!it.file_id, fileLink: it.shop ? undefined : it.link, pass: it.pass });

async function api(env, req, url, me) {
  const path = url.pathname.slice(4), admin = isAdmin(env, me.id);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const { user } = await upsertUser(env, me);

  if (path === "/me") {
    const inv = await invitedCount(env, me.id), got = (await env.DB.prepare("SELECT item_id FROM gets WHERE user_id=?").bind(me.id).all()).results.map(r => r.item_id);
    return { user: { id: user.id, name: user.name, username: user.username, plan: isPro(user) ? "pro" : "free", until: user.until, phone: user.phone, email: user.email, joined: user.joined },
      inv, rank: rankOf(inv), admin, disc: canDiscount(user), got, bot: env.BOT_USERNAME, prices: PRICES };
  }
  if (path === "/tabs") return { tabs: await getTabs(env) };
  if (path === "/items") {
    const q = admin ? "SELECT * FROM items ORDER BY date DESC" : "SELECT * FROM items WHERE status='live' ORDER BY date DESC";
    return { items: (await env.DB.prepare(q).all()).results.map(admin ? adminItem : publicItem) };
  }
  if (path === "/get") {
    const it = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(+body.id).first();
    if (!it || (it.status !== "live" && !admin)) return { error: "not found" };
    const inv = await invitedCount(env, me.id);
    if (!canOpen(user, inv, it) && !admin) return { error: "locked" };
    let sent;
    if (it.file_id) sent = await tg(env, it.file_type === "audio" ? "sendAudio" : "sendDocument", { chat_id: me.id, [it.file_type === "audio" ? "audio" : "document"]: it.file_id, caption: `${it.name}${it.pass ? `\nPassword: ${it.pass}` : ""}` });
    else if (it.link) sent = await tg(env, "sendMessage", { chat_id: me.id, text: `${it.name}\n${it.link}${it.pass ? `\nPassword: ${it.pass}` : ""}` });
    else return { error: "file not attached yet" };
    if (!sent.ok) return { error: "could not send, open the bot chat and press Start" };
    await env.DB.prepare("INSERT OR IGNORE INTO gets(user_id,item_id,at) VALUES(?,?,?)").bind(me.id, it.id, now()).run();
    await logEv(env, me.id, "in", "get " + it.name);
    return { ok: true };
  }
  if (path === "/invoice") {
    const pr = PRICES[body.plan]; if (!pr) return { error: "plan" };
    const amount = Math.round(pr.stars * (canDiscount(user) ? DISCOUNT : 1));
    const r = await tg(env, "createInvoiceLink", { title: pr.title, description: "All packs, every course lesson and new drops.", payload: JSON.stringify({ plan: body.plan, uid: me.id }), currency: "XTR", prices: [{ label: pr.title, amount }] });
    await logEv(env, me.id, "in", `opened Stars invoice ${amount} ⭐`);
    return r.ok ? { link: r.result, amount } : { error: "invoice" };
  }
  if (path === "/profile") {
    await env.DB.prepare("UPDATE users SET phone=?, email=? WHERE id=?").bind(body.phone ?? user.phone, body.email ?? user.email, me.id).run();
    return { ok: true };
  }
  if (path === "/log") { await logEv(env, me.id, "in", String(body.text || "").slice(0, 200)); return { ok: true }; }

  if (!admin) return { error: "forbidden", status: 403 };
  return adminApi(env, path, body, me);
}

async function adminApi(env, path, body, me) {
  const all = async (q, ...b) => (await env.DB.prepare(q).bind(...b).all()).results;
  if (path === "/admin/overview") {
    const one = async q => (await env.DB.prepare(q).first()).c;
    return { users: await one("SELECT COUNT(*) c FROM users"), pro: await one(`SELECT COUNT(*) c FROM users WHERE plan='pro' AND until>='${today()}'`),
      today: await one(`SELECT COUNT(*) c FROM users WHERE joined>='${today()}'`), pending: await one("SELECT COUNT(*) c FROM payments WHERE status='pending'"),
      gets: await one("SELECT COUNT(*) c FROM gets"), items: await one("SELECT COUNT(*) c FROM items WHERE status='live'") };
  }
  if (path === "/admin/users") return { users: await all("SELECT u.*, (SELECT COUNT(*) FROM users r WHERE r.ref_by=u.id) inv FROM users u ORDER BY last_seen DESC LIMIT 500") };
  if (path === "/admin/events") return { events: await all("SELECT * FROM events WHERE user_id=? ORDER BY id DESC LIMIT 200", +body.uid) };
  if (path === "/admin/act") {
    const uid = +body.uid;
    if (body.act === "grant") return { until: await grantPro(env, uid, +body.days || 30, `granted by admin`) };
    if (body.act === "free") { await env.DB.prepare("UPDATE users SET plan='free' WHERE id=?").bind(uid).run(); await logEv(env, uid, "sys", "admin: plan set to Free"); return { ok: true }; }
    if (body.act === "message") {
      const r = await tg(env, "sendMessage", { chat_id: uid, text: String(body.text).slice(0, 4000) });
      await logEv(env, uid, "admin", "you → " + body.text); await logEv(env, uid, "bot", r.ok ? "bot → delivered" : "bot → not delivered (user blocked the bot?)");
      return { ok: r.ok };
    }
  }
  if (path === "/admin/payments") return { payments: await all("SELECT p.*, u.name, u.username FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200") };
  if (path === "/admin/pay") return { result: await settlePayment(env, +body.id, body.plan || "m", me.id) };
  if (path === "/admin/item") {
    const f = ["cat", "name", "descr", "f", "size", "n", "tier", "val", "date", "status", "brand", "link", "pass", "img"].filter(k => k in body);
    const vals = f.map(k => body[k]);
    if ("soft" in body) { f.push("soft"); vals.push(JSON.stringify(body.soft || [])); }
    if (body.shop !== undefined) { f.push("shop"); vals.push(body.shop ? 1 : 0); }
    if (body.id) await env.DB.prepare(`UPDATE items SET ${f.map(k => k + "=?").join(",")} WHERE id=?`).bind(...vals, +body.id).run();
    else await env.DB.prepare(`INSERT INTO items(${f.join(",")}) VALUES(${f.map(() => "?").join(",")})`).bind(...vals).run();
    return { ok: true };
  }
  if (path === "/admin/tabs") {
    const tabs = (body.tabs || []).filter(t => t && t.id && t.label).map(t => ({ id: String(t.id).slice(0, 30), label: String(t.label).slice(0, 30), kind: t.kind || undefined, pub: !!t.pub || undefined,
      filters: t.kind ? undefined : (t.filters || []).map(f => String(f).slice(0, 40)).filter(Boolean) }));
    if (!tabs.length) return { error: "empty" };
    await env.DB.prepare("INSERT INTO settings(k,v) VALUES('tabs',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(tabs)).run();
    return { tabs };
  }
  if (path === "/admin/sources") return { sources: await all("SELECT * FROM sources ORDER BY title") };
  if (path === "/admin/source/add") {
    // for channels where the bot was made admin before the server was running
    const h = String(body.handle || "").trim().replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "").replace(/\/.*$/, "");
    const chat = await tg(env, "getChat", { chat_id: /^-?\d+$/.test(h) ? +h : "@" + h });
    if (!chat.ok) return { error: "Channel not found. For a private channel forward any of its posts to the bot" };
    const meBot = await tg(env, "getMe"), mem = await tg(env, "getChatMember", { chat_id: chat.result.id, user_id: meBot.result?.id });
    if (!["administrator", "creator"].includes(mem.result?.status)) return { error: "Make the bot an admin of this channel first" };
    await env.DB.prepare("INSERT INTO sources(chat_id,title,handle,kind,last) VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET ok=1, kind=excluded.kind").bind(chat.result.id, chat.result.title, chat.result.username ? "@" + chat.result.username : null, body.kind === "partner" ? "partner" : "own", now()).run();
    return { ok: true };
  }
  if (path === "/admin/source") {
    const f = ["kind", "on_post", "sec", "tier"].filter(k => k in body);
    if (body.remove) await env.DB.prepare("DELETE FROM sources WHERE chat_id=?").bind(+body.chat_id).run();
    else if (f.length) await env.DB.prepare(`UPDATE sources SET ${f.map(k => k + "=?").join(",")} WHERE chat_id=?`).bind(...f.map(k => body[k]), +body.chat_id).run();
    return { ok: true };
  }
  if (path === "/admin/broadcasts") return { broadcasts: await all("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50") };
  if (path === "/admin/broadcast") {
    const when = body.send_at ? new Date(body.send_at).toISOString() : now();
    await env.DB.prepare("INSERT INTO broadcasts(text,btn,aud,send_at,status) VALUES(?,?,?,?,'scheduled')").bind(body.text, body.btn || null, body.aud || "all", when).run();
    if (!body.send_at) await sendDueBroadcasts(env);
    return { ok: true };
  }
  return { error: "unknown", status: 404 };
}

// ---------- scheduled jobs: publish drops, send broadcasts ----------
async function sendDueBroadcasts(env) {
  const due = (await env.DB.prepare("SELECT * FROM broadcasts WHERE status='scheduled' AND send_at<=? ORDER BY id").bind(now()).all()).results;
  for (const b of due) {
    await env.DB.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").bind(b.id).run();
    const where = { all: "1=1", free: `NOT (plan='pro' AND until>='${today()}')`, pro: `plan='pro' AND until>='${today()}'`, idle: `last_seen < '${new Date(Date.now() - 7 * 864e5).toISOString()}'` }[b.aud] || "1=1";
    const users = (await env.DB.prepare(`SELECT id FROM users WHERE blocked=0 AND ${where}`).all()).results;
    let reach = 0;
    for (const u of users) {
      const r = await tg(env, "sendMessage", { chat_id: u.id, text: b.text, reply_markup: b.btn ? appButton(env, b.btn) : undefined });
      if (r.ok) reach++; else if (r.error_code === 403) await env.DB.prepare("UPDATE users SET blocked=1 WHERE id=?").bind(u.id).run();
      await new Promise(r => setTimeout(r, 40)); // stay under Telegram's ~30 messages per second
    }
    await env.DB.prepare("UPDATE broadcasts SET status='sent', reach=? WHERE id=?").bind(reach, b.id).run();
  }
}
async function scheduled(env) {
  await migrate(env);
  await env.DB.prepare("UPDATE items SET status='live' WHERE status='scheduled' AND date<=?").bind(today()).run();
  await sendDueBroadcasts(env);
}

// ---------- preview images, proxied so the bot token never reaches the browser ----------
async function image(env, id, ctx, req) {
  const cache = caches.default, hit = await cache.match(req);
  if (hit) return hit;
  const it = await env.DB.prepare("SELECT preview_id, preview_type FROM items WHERE id=?").bind(id).first();
  if (!it?.preview_id) return new Response("no preview", { status: 404 });
  const f = await tg(env, "getFile", { file_id: it.preview_id });
  if (!f.ok) return new Response("preview too large", { status: 404 });
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  const res = new Response(r.body, { headers: { "content-type": it.preview_type === "photo" ? "image/jpeg" : "video/mp4", "cache-control": "public, max-age=86400", ...cors(env) } });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    await migrate(env);
    if (url.pathname === "/tg" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const up = await req.json();
      ctx.waitUntil(onUpdate(env, up).catch(e => console.log("update failed", e.stack)));
      return new Response("ok");
    }
    if (url.pathname === "/setup") {
      // one-time: open https://<worker>/setup?key=SETUP_KEY in a browser to register the webhook and the menu button
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return new Response("forbidden", { status: 403 });
      const hook = await tg(env, "setWebhook", { url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "pre_checkout_query", "channel_post", "my_chat_member"] });
      const menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Open Vault", web_app: { url: env.APP_URL } } });
      return json({ webhook: hook.ok ? "ok" : hook.description, menu: menu.ok ? "ok" : menu.description, admins: admins(env) });
    }
    if (url.pathname.startsWith("/img/")) return image(env, +url.pathname.slice(5), ctx, req);
    if (url.pathname.startsWith("/api/")) {
      const me = await checkInitData(env, (req.headers.get("authorization") || "").replace(/^tma /, ""));
      if (!me) return json({ error: "Open the app from the Telegram bot" }, 401, env);
      const out = await api(env, req, url, me);
      return json(out, out.status || (out.error ? 400 : 200), env);
    }
    if (url.pathname === "/") return new Response("Director Tricks bot server is running.");
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(scheduled(env)); }
};
