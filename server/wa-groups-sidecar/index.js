// ════════════════════════════════════════════════════════════════════════════
// wa-groups-sidecar — «رقم الكروبات»: واتساب ويب غير رسمي (Baileys) على شريحة
// مخصّصة، لإرسال الطلبيات لكروبات المذاخر واستقبال ردودهم.
//
// لماذا عملية مستقلة: الـCloud API الرسمي لا يدخل كروبات واتساب العادية، وBaileys
// يمسك اتصال websocket دائماً وحالة تشفير على القرص — فصله يحمي التطبيق الرئيسي
// من أعطاله ويسمح بإيقافه بلا أثر. ⚠️ غير رسمي: احتمال حظر الرقم قائم — لا تستعمل
// رقم البوت الرسمي ولا رقماً مهماً.
//
// يسمع على 127.0.0.1 فقط، وكل طلب يحمل x-wa-groups-secret. رسائل الكروبات المربوطة
// بمذاخر (known-jids من التطبيق) تُمرَّر للتطبيق على /api/wa-groups/internal/inbound.
//
// التصويت (poll) بديل الأزرار: واتساب لا يعرض أزرار تفاعلية في الكروبات لغير الـAPI
// الرسمي. أصوات التصويت مشفّرة بسرّ الرسالة (messageSecret) و Baileys rc14 لا يفكّها
// تلقائياً، فنحفظ السرّ بأنفسنا في polls.json ونفكّ كل صوت هنا، ثم نمرّر للتطبيق
// { pollVote: { pollId, option } } — option = رقم الخيار أو null (سحب الصوت).
//
// متغيّرات البيئة: WA_GROUPS_SECRET (إلزامي)، WA_GROUPS_PORT (8091)،
// WA_GROUPS_MAIN_URL (http://127.0.0.1:8080)، WA_GROUPS_AUTH_DIR (./auth).
// ════════════════════════════════════════════════════════════════════════════

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage, decryptPollVote, jidNormalizedUser,
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.WA_GROUPS_SECRET || '';
const PORT = Number(process.env.WA_GROUPS_PORT || 8091);
const MAIN_URL = process.env.WA_GROUPS_MAIN_URL || 'http://127.0.0.1:8080';
const AUTH_DIR = process.env.WA_GROUPS_AUTH_DIR || path.join(__dirname, 'auth');
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

if (!SECRET) {
  console.error('[wa-groups] WA_GROUPS_SECRET غير مضبوط — الخدمة لن تعمل');
  process.exit(1);
}

const logger = pino({ level: 'warn' });

const state = { status: 'starting', me: null, qr: null, pairingCode: null, error: null, since: new Date().toISOString() };
let sock = null;
let reconnectTimer = null;

// ─── الكروبات المعنيّة (مذاخر مربوطة) ────────────────────────────────────────

let knownJids = new Set();
async function refreshKnownJids() {
  try {
    const res = await fetch(`${MAIN_URL}/api/wa-groups/internal/known-jids`, { headers: { 'x-wa-groups-secret': SECRET }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) knownJids = new Set((await res.json()).jids || []);
  } catch (e) {
    logger.warn({ err: e.message }, 'known-jids');
  }
}
setInterval(refreshKnownJids, 2 * 60_000).unref();

// رسائل حديثة لاقتباسها عند الرد (Baileys يحتاج الرسالة كاملة لا معرّفها فقط)
const recent = new Map();
function remember(msg) {
  if (!msg?.key?.id) return;
  recent.set(msg.key.id, msg);
  while (recent.size > 1000) recent.delete(recent.keys().next().value);
}

// ─── التصويتات المرسَلة: معرّف الرسالة ← السرّ والخيارات (على القرص) ─────────────

const POLLS_FILE = () => path.join(AUTH_DIR, 'polls.json');
const POLL_TTL_MS = 10 * 24 * 60 * 60 * 1000;
let polls = {};
try { polls = JSON.parse(fs.readFileSync(POLLS_FILE(), 'utf8')); } catch { polls = {}; }
function savePolls() {
  const now = Date.now();
  for (const [id, p] of Object.entries(polls)) if (now - p.at > POLL_TTL_MS) delete polls[id];
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(POLLS_FILE(), JSON.stringify(polls));
  } catch (e) { console.error('[wa-groups] حفظ التصويتات:', e.message); }
}

const sha256hex = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

/**
 * يفكّ صوتاً على تصويت أرسلناه. معرّف المنشئ/المصوّت قد يكون رقماً (PN) أو LID حسب
 * وضع الكروب، والتشفير مربوط بالصيغة التي استعملها هاتف المصوّت — نجرّب التراكيب،
 * والتحقق (GCM) يرفض الخاطئ. يُعيد رقم الخيار، null لسحب الصوت، undefined للفشل.
 */
function decodeVote(msg, upd, poll) {
  const creators = [...new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser))];
  const voters = [...new Set([msg.key.participant, msg.key.participantAlt].filter(Boolean).map(jidNormalizedUser))];
  const pollEncKey = Buffer.from(poll.secret, 'hex');
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const vote = decryptPollVote(upd.vote, { pollCreatorJid, pollMsgId: upd.pollCreationMessageKey.id, pollEncKey, voterJid });
        const picked = (vote.selectedOptions || []).map(h => Buffer.from(h).toString('hex'));
        if (!picked.length) return null;
        const idx = poll.options.findIndex(o => picked.includes(sha256hex(o)));
        return idx >= 0 ? idx : undefined;
      } catch { /* تركيبة أخرى */ }
    }
  }
  return undefined;
}

// ─── الإرسال: طابور بفاصل بشري (يقلّل خطر الحظر) ─────────────────────────────

let chain = Promise.resolve();
let lastSendAt = 0;
function enqueue(fn) {
  const run = chain.then(async () => {
    const gap = 2500 + Math.random() * 2500;
    const wait = lastSendAt + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { lastSendAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

// ─── الاتصال ─────────────────────────────────────────────────────────────────

async function connect() {
  clearTimeout(reconnectTimer);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    if (u.qr) { state.qr = u.qr; state.status = 'awaiting_link'; }
    if (u.connection === 'open') {
      Object.assign(state, { status: 'connected', qr: null, pairingCode: null, error: null, me: sock.user?.id || null, since: new Date().toISOString() });
      console.log('[wa-groups] متصل:', state.me);
      refreshKnownJids();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[wa-groups] فُصل الرقم (logged out) — يلزم ربط جديد');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        polls = {};
        Object.assign(state, { status: 'logged_out', me: null, error: 'فُصل الرقم من واتساب — اربطه من جديد' });
      } else {
        state.status = 'reconnecting';
        state.error = u.lastDisconnect?.error?.message || null;
      }
      reconnectTimer = setTimeout(() => connect().catch(e => console.error('[wa-groups] connect:', e)), code === DisconnectReason.loggedOut ? 2000 : 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        // الأصوات تصل أحياناً كـappend (أُرسلت أثناء انقطاعنا) — لا نفوّتها
        if (unwrap(msg.message)?.pollUpdateMessage) await onPollVote(msg);
        else if (type === 'notify') await onMessage(msg);
      } catch (e) { console.error('[wa-groups] رسالة واردة:', e.message); }
    }
  });
}

function unwrap(m) {
  // رسائل «مؤقتة» و«عرض مرة» تلفّ المحتوى الحقيقي
  return m?.ephemeralMessage?.message || m?.viewOnceMessageV2?.message || m?.viewOnceMessage?.message || m;
}

function forward(body) {
  return fetch(`${MAIN_URL}/api/wa-groups/internal/inbound`, {
    method: 'POST',
    headers: { 'x-wa-groups-secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(e => console.error('[wa-groups] تمرير للتطبيق:', e.message));
}

async function onPollVote(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us') || msg.key.fromMe || !knownJids.has(jid)) return;
  const upd = unwrap(msg.message).pollUpdateMessage;
  const pollId = upd?.pollCreationMessageKey?.id;
  const poll = pollId && polls[pollId];
  if (!poll || !upd.vote) return; // ليس تصويتنا (أو قديم انتهى)
  const option = decodeVote(msg, upd, poll);
  if (option === undefined) { console.warn('[wa-groups] تعذّر فكّ صوت على', pollId); return; }
  await forward({
    jid, msgId: msg.key.id, sender: msg.key.participantAlt || msg.key.participant || null, senderName: msg.pushName || null,
    pollVote: { pollId, option },
  });
}

async function onMessage(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  remember(msg);
  if (msg.key.fromMe || !knownJids.has(jid)) return;

  const m = unwrap(msg.message);
  if (!m) return;
  const image = m.imageMessage || (m.documentMessage && /^image\//.test(m.documentMessage.mimetype || '') ? m.documentMessage : null);
  const text = m.conversation || m.extendedTextMessage?.text || image?.caption || '';
  const ctx = m.extendedTextMessage?.contextInfo || image?.contextInfo || null;

  let imageBase64 = null;
  if (image) {
    if (Number(image.fileLength || 0) > MAX_IMAGE_BYTES) return;
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    imageBase64 = Buffer.from(buf).toString('base64');
  }
  if (!text && !imageBase64) return;

  await forward({
    jid, msgId: msg.key.id, sender: msg.key.participant || null, senderName: msg.pushName || null,
    text, quotedId: ctx?.stanzaId || null, imageBase64,
  });
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const authorized = (req) => {
  const got = String(req.headers['x-wa-groups-secret'] || '');
  return got.length === SECRET.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(SECRET));
};

const routes = {
  'GET /status': async () => [200, { ...state, connected: state.status === 'connected' }],

  'POST /pair': async (body) => {
    const phone = String(body.phone || '').replace(/\D/g, '').replace(/^00/, '').replace(/^07(\d{9})$/, '9647$1');
    if (!/^\d{10,15}$/.test(phone)) return [400, { error: 'رقم غير صالح — اكتبه دولياً مثل 9647701234567' }];
    if (state.status === 'connected') return [400, { error: 'الرقم مربوط ومتصل أصلاً' }];
    if (!sock) await connect();
    // ننتظر حتى يجهز الاتصال لطلب الكود (يظهر QR أولاً)
    for (let i = 0; i < 20 && state.status !== 'awaiting_link'; i++) await new Promise(r => setTimeout(r, 500));
    const code = await sock.requestPairingCode(phone);
    state.pairingCode = code;
    return [200, { pairingCode: code }];
  },

  'GET /groups': async () => {
    if (state.status !== 'connected') return [409, { error: 'رقم الكروبات غير متصل' }];
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all).map(g => ({ jid: g.id, name: g.subject, size: g.participants?.length || 0 }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
    return [200, { groups }];
  },

  'POST /send': async (body) => {
    if (state.status !== 'connected') return [409, { error: 'رقم الكروبات غير متصل' }];
    const jid = String(body.jid || '');
    if (!jid.endsWith('@g.us')) return [400, { error: 'معرّف كروب غير صالح' }];
    const quoted = body.quotedId ? recent.get(String(body.quotedId)) : undefined;
    const sent = await enqueue(() => sock.sendMessage(jid, { text: String(body.text || '').slice(0, 6000) }, quoted ? { quoted } : {}));
    remember(sent);
    return [200, { id: sent?.key?.id || null }];
  },

  // تصويت بخيار واحد (بديل الأزرار). السرّ نولّده نحن ونحفظه لفكّ الأصوات لاحقاً.
  'POST /send-poll': async (body) => {
    if (state.status !== 'connected') return [409, { error: 'رقم الكروبات غير متصل' }];
    const jid = String(body.jid || '');
    if (!jid.endsWith('@g.us')) return [400, { error: 'معرّف كروب غير صالح' }];
    const options = (Array.isArray(body.options) ? body.options : []).map(o => String(o).slice(0, 100)).filter(Boolean);
    if (options.length < 2 || options.length > 12) return [400, { error: 'خيارات التصويت غير صالحة' }];
    const secret = crypto.randomBytes(32);
    const quoted = body.quotedId ? recent.get(String(body.quotedId)) : undefined;
    const sent = await enqueue(() => sock.sendMessage(jid, {
      poll: { name: String(body.name || '').slice(0, 255), values: options, selectableCount: 1, messageSecret: secret },
    }, quoted ? { quoted } : {}));
    const id = sent?.key?.id || null;
    if (id) { polls[id] = { jid, secret: secret.toString('hex'), options, at: Date.now() }; savePolls(); }
    remember(sent);
    return [200, { id }];
  },

  'POST /logout': async () => {
    try { await sock?.logout(); } catch { /* مفصول أصلاً */ }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    polls = {};
    Object.assign(state, { status: 'logged_out', me: null, qr: null, pairingCode: null });
    setTimeout(() => connect().catch(() => {}), 1500);
    return [200, { ok: true }];
  },
};

http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 403, { error: 'forbidden' });
  const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  try {
    const [code, obj] = await route(req.method === 'POST' ? await readJson(req) : {});
    send(res, code, obj);
  } catch (e) {
    console.error('[wa-groups]', req.url, e);
    send(res, 500, { error: e.message || 'خطأ' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[wa-groups] يسمع على 127.0.0.1:${PORT}`));

connect().catch(e => { console.error('[wa-groups] connect:', e); state.error = e.message; });
