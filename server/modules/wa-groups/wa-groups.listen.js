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
const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INBOX_MAX_ATTEMPTS = 3;
const inboxFile = (key) => path.join(INBOX_DIR, `${String(key).replace(/[^\w-]/g, '_')}.json`);

function journalWrite(key, entry) {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.writeFileSync(inboxFile(key), JSON.stringify({ at: Date.now(), attempts: 0, ...entry }));
  } catch (e) {
    console.error('[wa-groups] تعذّر حفظ الرسالة في السجلّ:', e?.message);
  }
}
const journalDone = (key) => fs.promises.unlink(inboxFile(key)).catch(() => {});

// ─── المعالجة ────────────────────────────────────────────────────────────────

async function processMessage(m, link) {
  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user?.isActive) return;
  const buffer = m.imageBase64 ? Buffer.from(m.imageBase64, 'base64') : null;
  // مفتاح ثابت للصورة (معرّف الرسالة) ⇒ sourceHash يطوي إعادة المعالجة بعد انقطاع
  const ref = buffer ? (m.msgId || crypto.createHash('sha1').update(buffer).digest('hex')) : null;
  await handleIncomingOrderMessage({
    transport: {
      name: LISTEN_SOURCE,
      sendText: async () => null, // قراءة صامتة: لا شيء يخرج من الرقم أبداً
      downloadMedia: async () => buffer,
      resolveSenderRep,
    },
    link, user,
    chatId: link.jid, chatTitle: link.name || null,
    senderName: m.senderName || null,
    senderId: senderPhone(m),
    text: String(m.text || '').trim(),
    mediaRefs: ref ? [ref] : [],
    isReplyToBot: false,
  });
}

/** @param {{ jid, msgId, sender, senderName, text, imageBase64 }} m */
export async function handleListenGroupMessage(m, link) {
  const key = m.msgId ? `wag_${m.msgId}` : null;
  if (key) journalWrite(key, { m });
  try {
    await processMessage(m, link);
  } catch (e) {
    console.error('[wa-groups] فشل تسجيل رسالة كروب المندوبين:', e);
  } finally {
    if (key) journalDone(key);
  }
}

/** عند الإقلاع: رسائل قطعتها إعادة التشغيل أثناء قراءتها ← تُعاد. */
export async function resumeListenInbox() {
  let files = [];
  try { files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const file = path.join(INBOX_DIR, f);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - entry.at > INBOX_MAX_AGE_MS || entry.attempts >= INBOX_MAX_ATTEMPTS || !entry.m?.jid) { fs.unlinkSync(file); continue; }
      fs.writeFileSync(file, JSON.stringify({ ...entry, attempts: entry.attempts + 1 }));
      const link = await listenLinkFor(entry.m.jid);
      if (link) { await processMessage(entry.m, link); n++; }
      fs.unlinkSync(file);
    } catch (e) {
      console.error('[wa-groups] استئناف رسالة منقطعة:', f, e?.message);
    }
  }
  return n;
}
