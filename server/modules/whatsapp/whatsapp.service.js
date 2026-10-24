// ════════════════════════════════════════════════════════════════════════════
// whatsapp.service.js — استقبال طلبيات واتساب عبر WhatsApp Cloud API (Meta) الرسمي.
// **خامدة** حتى يُضبط WHATSAPP_TOKEN و WHATSAPP_PHONE_NUMBER_ID.
//
// محادثات فردية فقط (المندوب ↔ رقم البوت) — الـCloud API لا يُدخل البوت في
// كروبات عادية. الاختلافات عن تلكرام، وكلها معالَجة هنا لا في الكود المشترك:
//  • التوكن يُقرأ **بتأخّر داخل الدوال** — نفس سبب viber.service.js (ESM hoisting
//    يسبق dotenv.config()).
//  • **لا تعديل رسائل**: لا editText في عقد الـtransport، فـ«⏳» رسالة مستقلة.
//  • الوسائط تأتي **media id**: نطلب رابطها من Graph ثم ننزّلها بنفس التوكن
//    (الرابط وحده يُعيد 401 بلا Authorization).
//  • نافذة 24 ساعة: الردّ الحرّ مسموح فقط خلال 24 ساعة من آخر رسالة للمستخدم.
//    البوت لا يبادر أبداً — كل ردّ هنا جواب على رسالة وصلت للتو، فلا قوالب.
//  • معرّف المحادثة = wa_id = رقم هاتف المرسل بلا «+» (مثال 9647701234567).
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { handleIncomingOrderMessage } from '../orders/bot-order-flow.js';

/** قراءات متأخّرة — لا قيمة محفوظة في نطاق الموديل. */
export const whatsappToken     = () => process.env.WHATSAPP_TOKEN || '';
export const whatsappAppSecret = () => process.env.WHATSAPP_APP_SECRET || '';
export const whatsappVerifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN || '';
const phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';
// إصدارات Graph تنتهي بعد ~سنتين من صدورها — قابلة للتغيير بمتغيّر بيئة بلا نشر.
const graphBase = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v23.0'}`;

export const whatsappEnabled = () => Boolean(whatsappToken() && phoneNumberId());

/** لا يرمي أبداً: يُسجّل ويُعيد null حين لا توكن أو عند فشل الشبكة/الـAPI. */
async function graphApi(path, { method = 'GET', body } = {}) {
  const token = whatsappToken();
  if (!token) { console.error(`[whatsapp] WHATSAPP_TOKEN غير مضبوط — تعذّر استدعاء ${path}`); return null; }
  try {
    const res = await fetch(`${graphBase()}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[whatsapp] ${method} ${path} → ${res.status}:`, data?.error?.message || data);
      return null;
    }
    return data;
  } catch (e) {
    console.error(`[whatsapp] ${method} ${path} failed:`, e.message);
    return null;
  }
}

// حدّ نصّ رسالة واتساب 4096 حرفاً — الزائد يُرفض كاملاً لا يُقصّ.
const MAX_TEXT = 4096;

async function sendMessage(to, text) {
  const body = String(text ?? '').slice(0, MAX_TEXT);
  const data = await graphApi(`${phoneNumberId()}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), type: 'text', text: { body } },
  });
  return data?.messages?.[0]?.id ?? null;
}

/** media id → رابط قصير العمر → البايتات. كلا الطلبين يحتاجان التوكن. */
async function downloadMedia(mediaId) {
  const meta = await graphApi(String(mediaId));
  if (!meta?.url) throw new Error('تعذّر الحصول على رابط الصورة من واتساب');
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${whatsappToken()}` } });
  if (!res.ok) throw new Error('تعذّر تنزيل الصورة من واتساب');
  return Buffer.from(await res.arrayBuffer());
}

/** عقد المنصة — **بلا editText** عن قصد: الـCloud API لا يعدّل الرسائل. */
const whatsappTransport = {
  name: 'whatsapp',
  sendText: async (to, text) => { await sendMessage(to, text); return null; },
  downloadMedia,
};

async function resolveActor(waId, senderName) {
  const link = await prisma.whatsAppChatLink.findUnique({ where: { waId: String(waId) } });
  if (!link) {
    // الاكتشاف: محادثة فردية مع البوت، فالردّ بالرقم مفيد لا مزعج (كفايبر).
    await sendMessage(waId, `هذا الرقم غير مربوط بأي حساب بعد.\nشارك هذا المعرّف مع الأدمن ليربطه: ${waId}`);
    return null;
  }
  if (!link.isActive) {
    await sendMessage(waId, 'الربط معطّل حالياً — تواصل مع الأدمن.');
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user || !user.isActive) {
    await sendMessage(waId, '⚠️ الحساب المرتبط غير فعّال — تواصل مع الأدمن.');
    return null;
  }
  return { link, user, senderName: senderName || link.chatTitle || null };
}

// حارس تكرار في الذاكرة: Meta تُعيد إرسال الويب-هوك إن تأخّر الـ200 أو فشل، و
// message.id (wamid) نصّ لا عدّاد. الحماية الحقيقية هي sourceHash في طابور الطلبيات.
const SEEN_MAX = 500;
const seenIds = new Set();
const seenOnce = (id) => {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  while (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.values().next().value);
  return false;
};

/** صورة مرسَلة كصورة، أو كملف (document) نوعه image/* — المندوبون يفعلون الاثنين. */
function imageRef(message) {
  if (message.type === 'image' && message.image?.id) return { id: message.image.id, caption: message.image.caption };
  if (message.type === 'document' && message.document?.id && /^image\//.test(message.document.mime_type || '')) {
    return { id: message.document.id, caption: message.document.caption };
  }
  return null;
}

async function handleOneMessage(message, contactName) {
  const waId = message?.from;
  if (!waId || seenOnce(message.id)) return;

  const img = imageRef(message);
  if (message.type !== 'text' && !img) return; // صوت/ملصق/موقع/PDF — تجاهل كتلكرام

  const actor = await resolveActor(waId, contactName);
  if (!actor) return;

  await prisma.whatsAppChatLink.update({
    where: { waId: String(waId) },
    data:  { lastMessageId: String(message.id ?? '') },
  }).catch(() => {});

  try {
    await handleIncomingOrderMessage({
      transport: whatsappTransport,
      link: actor.link,
      user: actor.user,
      chatId: String(waId),
      chatTitle: actor.link.chatTitle || actor.senderName,
      senderName: actor.senderName,
      text: String(img ? (img.caption || '') : (message.text?.body || '')).trim(),
      mediaRefs: img ? [img.id] : [],
      // ردّ المستخدم على رسالة البوت (سحب-للرد) يصل كـcontext.id
      isReplyToBot: Boolean(message.context?.id),
    });
  } catch (err) {
    console.error('[whatsapp] فشل معالجة الرسالة:', err);
  }
}

/**
 * يعالج جسم ويب-هوك واتساب كاملاً (قد يحمل عدة رسائل). لا يرمي أبداً.
 * أحداث statuses (sent/delivered/read) تُتجاهل.
 */
export async function handleWhatsAppWebhook(body) {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      // رقم آخر على نفس حساب Meta — ليس لنا
      if (phoneNumberId() && value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId()) continue;
      const names = new Map((value.contacts || []).map(c => [c.wa_id, c.profile?.name || null]));
      for (const message of value.messages || []) {
        await handleOneMessage(message, names.get(message.from));
      }
    }
  }
}
