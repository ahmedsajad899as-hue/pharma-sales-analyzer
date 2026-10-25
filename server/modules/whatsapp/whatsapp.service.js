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
import { handleWarehouseCloudMessage, handleDispatchStatus } from '../warehouse-dispatch/dispatch.inbound.js';
import { registerNotifier } from '../warehouse-dispatch/dispatch.notify.js';

/** قراءات متأخّرة — لا قيمة محفوظة في نطاق الموديل. */
export const whatsappToken     = () => process.env.WHATSAPP_TOKEN || '';
export const whatsappAppSecret = () => process.env.WHATSAPP_APP_SECRET || '';
export const whatsappVerifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN || '';
const phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';
// إصدارات Graph تنتهي بعد ~سنتين من صدورها — قابلة للتغيير بمتغيّر بيئة بلا نشر.
const graphBase = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v23.0'}`;

export const whatsappEnabled = () => Boolean(whatsappToken() && phoneNumberId());

/**
 * لا يرمي أبداً: يُعيد { data } أو { error: { code, message } } — الإرسال للمذاخر
 * يحتاج رمز الخطأ (131047 = خارج نافذة الـ24 ساعة ⇒ قالب).
 */
async function graphCall(path, { method = 'GET', body } = {}) {
  const token = whatsappToken();
  if (!token) {
    console.error(`[whatsapp] WHATSAPP_TOKEN غير مضبوط — تعذّر استدعاء ${path}`);
    return { error: { code: 'NO_TOKEN', message: 'WHATSAPP_TOKEN غير مضبوط' } };
  }
  try {
    const res = await fetch(`${graphBase()}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[whatsapp] ${method} ${path} → ${res.status}:`, data?.error?.message || data);
      return { error: { code: data?.error?.code ?? res.status, message: data?.error?.error_data?.details || data?.error?.message || `HTTP ${res.status}` } };
    }
    return { data };
  } catch (e) {
    console.error(`[whatsapp] ${method} ${path} failed:`, e.message);
    return { error: { code: 'NETWORK', message: e.message } };
  }
}

/** لا يرمي أبداً: يُسجّل ويُعيد null حين لا توكن أو عند فشل الشبكة/الـAPI. */
async function graphApi(path, opts) {
  return (await graphCall(path, opts)).data ?? null;
}

// ── عدّاد الرسائل الصادرة (كلفة Meta) ─────────────────────────────────────────
// service = ردّ حرّ داخل نافذة الـ24 ساعة (أول 1000 شهرياً لكل رقم مجانية)،
// template = قالب (مدفوع دائماً). best-effort: فشل العدّاد لا يمسّ الإرسال.
const monthKey = () => new Date().toISOString().slice(0, 7);
export async function countOutgoing(kind) {
  try {
    await prisma.waMessageCounter.upsert({
      where: { month_kind: { month: monthKey(), kind } },
      create: { month: monthKey(), kind, count: 1 },
      update: { count: { increment: 1 } },
    });
  } catch (e) { console.error('[whatsapp] عدّاد الرسائل:', e?.message); }
}

/** إرسال رسالة واتساب خام (أي نوع) — يُعيد { id } أو { error }. */
export async function sendRaw(to, payload, { kind = 'service' } = {}) {
  const r = await graphCall(`${phoneNumberId()}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), ...payload },
  });
  const id = r.data?.messages?.[0]?.id ?? null;
  if (id) await countOutgoing(kind);
  return id ? { id } : { error: r.error || { code: 'UNKNOWN', message: 'لم يُرجع واتساب معرّف رسالة' } };
}

// حدّ نصّ رسالة واتساب 4096 حرفاً — الزائد يُرفض كاملاً لا يُقصّ.
const MAX_TEXT = 4096;

async function sendMessage(to, text) {
  const body = String(text ?? '').slice(0, MAX_TEXT);
  const r = await sendRaw(to, { type: 'text', text: { body } });
  return r.id ?? null;
}
export { sendMessage as sendWhatsAppText };

// حدود واتساب للرسائل التفاعلية: نص 1024، عنوان زر 20، معرّف زر 256، 3 أزرار.
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** رسالة بأزرار ردّ سريع (داخل نافذة الـ24 ساعة فقط). buttons: [{ id, title }] */
export async function sendButtons(to, bodyText, buttons, { footer } = {}) {
  return sendRaw(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(bodyText, 1024) },
      ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })) },
    },
  });
}

/** قائمة اختيار (حتى 10 صفوف) — «هذه الفاتورة لأي طلبية؟». rows: [{ id, title, description }] */
export async function sendList(to, bodyText, buttonLabel, rows) {
  return sendRaw(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(bodyText, 1024) },
      action: {
        button: clip(buttonLabel, 20),
        sections: [{ title: clip('الطلبيات', 24), rows: rows.slice(0, 10).map(r => ({ id: clip(r.id, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })) }],
      },
    },
  });
}

/**
 * قالب معتمد (خارج نافذة الـ24 ساعة). معاملات النص لا تقبل أسطراً جديدة ولا
 * أكثر من 4 مسافات متتالية — تُنظَّف هنا. buttonPayloads: حمولة كل زر ردّ سريع بالترتيب.
 */
export async function sendTemplate(to, name, lang, bodyParams = [], buttonPayloads = []) {
  const flat = (v) => clip(String(v ?? '—').replace(/[\r\n\t]+/g, ' • ').replace(/ {4,}/g, '   ').trim() || '—', 900);
  const components = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(p => ({ type: 'text', text: flat(p) })) });
  buttonPayloads.forEach((payload, i) => components.push({
    type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: clip(payload, 256) }],
  }));
  return sendRaw(to, { type: 'template', template: { name, language: { code: lang }, components } }, { kind: 'template' });
}

/** media id → رابط قصير العمر → البايتات. كلا الطلبين يحتاجان التوكن. */
export async function downloadMedia(mediaId) {
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

  // ردود المذاخر (أزرار الطلبية، صورة فاتورة، سبب رفض) قبل مسار طلبيات المندوبين —
  // رقم المذخر غير مربوط بحساب فكان سيتلقّى «هذا الرقم غير مربوط».
  try {
    if (await handleWarehouseCloudMessage(message, contactName, imageRef(message))) return;
  } catch (err) {
    console.error('[whatsapp] فشل معالجة ردّ المذخر:', err);
  }

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
 * أحداث statuses (sent/delivered/read/failed) تحدّث طلبيات المذاخر المرسَلة فقط.
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
      for (const st of value.statuses || []) {
        try { await handleDispatchStatus(st); } catch (err) { console.error('[whatsapp] حالة رسالة:', err?.message); }
      }
    }
  }
}

// خارج نافذة الـ24 ساعة للمندوب يفشل الإشعار بصمت (لا قالب للمندوبين).
registerNotifier('whatsapp', (to, text) => sendMessage(to, text));
