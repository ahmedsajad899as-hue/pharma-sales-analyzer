// ════════════════════════════════════════════════════════════════════════════
// wa-groups.listen.js — كروبات المندوبين بقراءة صامتة عبر «رقم الكروبات».
//
// نوعا الكروبات على هذا الرقم:
//  • كروب مذخر (OrderWarehouse.groupJid) — يرسل له النظام الطلبيات ويقرأ ردوده
//    (dispatch.inbound.js).
//  • كروب مندوبين (WaGroupLink) — هنا: كل طلبية/فاتورة يكتبها المندوبون تمرّ بنفس
//    مسار بوت تلكرام (bot-order-flow ← طابور المراجعة ← ملف اللكوديشن) **بلا أي
//    رسالة خارجة**: transport.sendText لا يفعل شيئاً. الرقم يقرأ فقط ⇒ أقل خطر حظر.
//
// المصدر 'wa_group' بلا notifier مسجّل ⇒ إشعارات المذاخر لا تعود للكروب أيضاً.
// سجلّ على القرص (كتلكرام) — إعادة تشغيل أثناء قراءة صورة لا تُضيّعها.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import { normalizeWaId } from '../../lib/waId.js';
import { handleIncomingOrderMessage } from '../orders/bot-order-flow.js';

export const LISTEN_SOURCE = 'wa_group';

// ─── ربط الكروب (تخزين مؤقت قصير — كل رسالة كروب تسأل) ─────────────────────

const CACHE_TTL_MS = 60 * 1000;
const linkCache = new Map(); // jid → { link|null, ts }
export const invalidateListenCache = () => linkCache.clear();

export async function listenLinkFor(jid) {
  const key = String(jid || '');
  if (!key) return null;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.link;
  const link = await prisma.waGroupLink.findUnique({ where: { jid: key } });
  const v = link?.isActive ? link : null;
  linkCache.set(key, { link: v, ts: Date.now() });
  return v;
}

// ─── المرسِل ─────────────────────────────────────────────────────────────────

/** رقم المرسل إن وصل بصيغة الهاتف (participantAlt)؛ صيغة LID لا تكشف الرقم. */
function senderPhone(m) {
  const s = String(m.sender || '');
  return s.endsWith('@s.whatsapp.net') ? s.split('@')[0].split(':')[0] : null;
}

/** رقم المرسل مربوط بحساب مندوب علمي في «روابط واتساب» ⇒ اسمه للصفوف غير المحسومة. */
async function resolveSenderRep(_chatId, phone) {
  const waId = normalizeWaId(phone);
  if (!waId) return null;
  const link = await prisma.whatsAppChatLink.findUnique({ where: { waId }, select: { userId: true, isActive: true } });
  if (!link?.isActive) return null;
  const u = await prisma.user.findUnique({ where: { id: link.userId }, select: { displayName: true, username: true, isActive: true, role: true } });
  if (!u?.isActive || u.role !== 'scientific_rep') return null;
  return { id: link.userId, name: u.displayName?.trim() || u.username };
}

// ─── السجلّ على القرص ────────────────────────────────────────────────────────

const INBOX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'uploads', 'wa-group-inbox');
// مدخل السجلّ: { at, m, boots, attempts, retry?: { nextAt, lastError } }
//  • بلا retry = قيد المعالجة الآن (أو قطعته إعادة تشغيل ⇒ يُستأنف عند الإقلاع، boots حارس الحلقة).
//  • مع retry = فشلت قراءته (رصيد الذكاء نفد، انقطاع…) ⇒ مؤقّت يعيده بتباعد متزايد حتى
//    ينجح أو يمضي RETRY_MAX_AGE_MS. الكروب صامت فلا أحد يُبلَّغ بالفشل — بدون هذا تضيع الفاتورة.
const INBOX_MAX_BOOTS = 3;
const RETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RETRY_DELAYS_MIN = [5, 15, 30, 60, 120, 240, 480]; // ثم كل 8 س
const RETRY_MAX_ATTEMPTS = 10; // ≈ 40 ساعة — صورة تُفشل القراءة دائماً لا تستنزف الرصيد
const RETRY_TICK_MS = 5 * 60 * 1000;
const inboxFile = (key) => path.join(INBOX_DIR, `${String(key).replace(/[^\w-]/g, '_')}.json`);

function journalWrite(key, entry) {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.writeFileSync(inboxFile(key), JSON.stringify(entry));
  } catch (e) {
    console.error('[wa-groups] تعذّر حفظ الرسالة في السجلّ:', e?.message);
  }
}
const journalDone = (key) => fs.promises.unlink(inboxFile(key)).catch(() => {});

function readJournal() {
  let files = [];
  try { files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push({ key: f.slice(0, -5), entry: JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf8')) }); }
    catch { fs.promises.unlink(path.join(INBOX_DIR, f)).catch(() => {}); }
  }
  return out;
}

/** للوحة الماستر: رسائل فشلت قراءتها وتنتظر الإعادة، لكل كروب. */
export function listRetryingByJid() {
  const out = {};
  for (const { entry } of readJournal()) {
    if (!entry.retry || !entry.m?.jid) continue;
    const r = (out[entry.m.jid] ||= { count: 0, nextAt: null, lastError: null });
    r.count++;
    if (!r.nextAt || entry.retry.nextAt < r.nextAt) r.nextAt = entry.retry.nextAt;
    r.lastError = entry.retry.lastError;
  }
  return out;
}

// ─── العدّادات (تشخيص فقط — فشلها لا يمسّ المعالجة) ─────────────────────────

const bumpCounters = (jid, data) =>
  prisma.waGroupLink.update({ where: { jid }, data }).catch(e => console.error('[wa-groups] عدّاد:', e?.message));

// ─── المعالجة ────────────────────────────────────────────────────────────────

/** فشل يستحق الإعادة: عطل ذكاء/خادم (5xx) أو خطأ غير متوقّع — لا «مكرّرة» ولا مدخل مرفوض (4xx). */
const retryable = (err) => !err?.isOperational || (err.statusCode ?? 500) >= 500;

/** @returns {Promise<{ failed: Error|null }>} */
async function processMessage(m, link) {
  const outcome = { failed: null };
  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user?.isActive) return outcome;
  const buffer = m.imageBase64 ? Buffer.from(m.imageBase64, 'base64') : null;
  // مفتاح ثابت للصورة (معرّف الرسالة) ⇒ sourceHash يطوي إعادة المعالجة بعد انقطاع
  const ref = buffer ? (m.msgId || crypto.createHash('sha1').update(buffer).digest('hex')) : null;
  await handleIncomingOrderMessage({
    transport: {
      name: LISTEN_SOURCE,
      sendText: async () => null, // قراءة صامتة: لا شيء يخرج من الرقم أبداً
      downloadMedia: async () => buffer,
      resolveSenderRep,
      onQueued: () => bumpCounters(link.jid, { orderCount: { increment: 1 }, lastOrderAt: new Date() }),
      onAttached: () => bumpCounters(link.jid, { attachedCount: { increment: 1 }, lastOrderAt: new Date() }),
      onFailed: (err) => { outcome.failed = err; },
    },
    link, user,
    chatId: link.jid, chatTitle: link.name || null,
    senderName: m.senderName || null,
    senderId: senderPhone(m),
    text: String(m.text || '').trim(),
    mediaRefs: ref ? [ref] : [],
    isReplyToBot: false,
  });
  return outcome;
}

/** يعالج مدخلاً من السجلّ؛ الفشل القابل للإعادة يبقى فيه بموعد إعادة، غيره يُحذف. */
async function runEntry(key, entry, link) {
  let failed;
  try {
    ({ failed } = await processMessage(entry.m, link));
  } catch (e) {
    failed = e;
  }
  if (failed?.code === 'DUPLICATE_ORDER') failed = null; // بانتظار المراجعة أصلاً — ليست فشلاً
  if (failed && retryable(failed) && (entry.attempts || 0) < RETRY_MAX_ATTEMPTS && Date.now() - entry.at < RETRY_MAX_AGE_MS) {
    const attempts = (entry.attempts || 0) + 1;
    const delayMin = RETRY_DELAYS_MIN[Math.min(attempts, RETRY_DELAYS_MIN.length) - 1];
    journalWrite(key, { ...entry, attempts, retry: { nextAt: Date.now() + delayMin * 60_000, lastError: String(failed?.message || failed).slice(0, 200) } });
    console.warn(`[wa-groups] فشلت قراءة رسالة كروب (محاولة ${attempts}) — إعادة بعد ${delayMin} د: ${failed?.message}`);
    return 'retry';
  }
  journalDone(key);
  if (failed) {
    bumpCounters(link.jid, { failedCount: { increment: 1 } });
    console.error(`[wa-groups] رسالة كروب فشلت نهائياً بعد ${entry.attempts || 0} إعادة:`, failed?.message);
    return 'failed';
  }
  return 'done';
}

/** @param {{ jid, msgId, sender, senderName, text, imageBase64 }} m */
export async function handleListenGroupMessage(m, link) {
  bumpCounters(link.jid, { messageCount: { increment: 1 }, lastMessageAt: new Date() });
  const key = m.msgId ? `wag_${m.msgId}` : `wag_${crypto.randomBytes(8).toString('hex')}`;
  const entry = { at: Date.now(), m, boots: 0, attempts: 0 };
  journalWrite(key, entry);
  await runEntry(key, entry, link);
}

/** مؤقّت: يعيد الرسائل الفاشلة التي حان موعدها. لا يتداخل مع نفسه. */
let retryBusy = false;
export async function retryFailedListenMessages() {
  if (retryBusy) return 0;
  retryBusy = true;
  let n = 0;
  try {
    for (const { key, entry } of readJournal()) {
      if (!entry.retry || entry.retry.nextAt > Date.now()) continue;
      const link = entry.m?.jid ? await listenLinkFor(entry.m.jid) : null;
      if (!link) { journalDone(key); continue; } // الكروب أُلغي/أُوقف
      if (await runEntry(key, entry, link) === 'done') n++;
    }
  } finally {
    retryBusy = false;
  }
  if (n) console.log(`✓ [wa-groups] نجحت إعادة قراءة ${n} رسالة كروب مندوبين`);
  return n;
}

/**
 * عند الإقلاع: رسائل قطعتها إعادة التشغيل أثناء قراءتها ← تُعاد فوراً، ثم يبدأ مؤقّت
 * إعادة الفاشلة.
 */
export async function resumeListenInbox() {
  setInterval(() => { retryFailedListenMessages().catch(e => console.error('[wa-groups] مؤقّت الإعادة:', e?.message)); }, RETRY_TICK_MS).unref();
  let n = 0;
  for (const { key, entry } of readJournal()) {
    if (entry.retry) continue; // للمؤقّت
    try {
      if (!entry.m?.jid || (entry.boots || 0) >= INBOX_MAX_BOOTS || Date.now() - (entry.at || 0) > RETRY_MAX_AGE_MS) { journalDone(key); continue; }
      const resumed = { ...entry, boots: (entry.boots || 0) + 1 };
      journalWrite(key, resumed); // قبل المعالجة: انهيار متكرّر عليها لا يدور للأبد
      const link = await listenLinkFor(entry.m.jid);
      if (!link) { journalDone(key); continue; }
      await runEntry(key, resumed, link);
      n++;
    } catch (e) {
      console.error('[wa-groups] استئناف رسالة منقطعة:', key, e?.message);
    }
  }
  return n;
}
