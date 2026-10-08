// ════════════════════════════════════════════════════════════════════════════
// viber.service.js — استقبال طلبيات فايبر. **خامدة** حتى يُضبط VIBER_AUTH_TOKEN.
//
// الاختلافات الجوهرية عن تلكرام، وكلها معالَجة هنا لا في الكود المشترك:
//  • التوكن يُقرأ **بتأخّر داخل الدوال** لا عند تحميل الموديل. dotenv.config()
//    في server/index.js يعمل بعد رفع الاستيرادات (ESM hoisting)، فقراءة عند
//    التحميل ترى undefined في أي إعداد يعتمد ملف .env — وهذا بالضبط سبب أن
//    telegram.service.js يعمل في الإنتاج فقط (البيئة من المنصة هناك).
//  • **لا تعديل رسائل في فايبر**: لا editText في عقد الـtransport، فرسالة
//    «⏳ جاري قراءة الطلبية…» تصبح رسالة ثانية بدل تعديل في المكان.
//  • الوسائط تأتي **رابط https** في message.media لا معرّف getFile.
//  • message_token رقم ~19 خانة وليس عدّاداً تصاعدياً، فلا يصلح حارساً بالمقارنة
//    — التكرار الحقيقي يحرسه PendingBotOrder.sourceHash، وهذا العمود للتشخيص.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { handleIncomingOrderMessage } from '../orders/bot-order-flow.js';

const API_BASE = 'https://chatapi.viber.com/pa';

/** قراءة متأخّرة — لا قيمة محفوظة في نطاق الموديل. */
export const viberToken = () => process.env.VIBER_AUTH_TOKEN || '';

export const viberEnabled = () => Boolean(viberToken());

/** لا يرمي أبداً، كـtelegramApi: يُسجّل ويُعيد null حين لا توكن أو عند فشل الشبكة. */
async function viberApi(method, body) {
  const token = viberToken();
  if (!token) { console.error(`[viber] VIBER_AUTH_TOKEN غير مضبوط — تعذّر استدعاء ${method}`); return null; }
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': token },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error(`[viber] ${method} failed:`, e.message);
    return null;
  }
}

const sendMessage = (receiver, text) =>
  viberApi('send_message', { receiver, min_api_version: 2, type: 'text', text });

/** تنزيل وسائط فايبر — رابط مباشر قصير العمر، بلا خطوة getFile. */
async function downloadMedia(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('تعذّر تنزيل الصورة من فايبر');
  return Buffer.from(await res.arrayBuffer());
}

/** عقد المنصة — **بلا editText** عن قصد: فايبر لا يملك تعديل الرسائل. */
const viberTransport = {
  name: 'viber',
  sendText: async (receiver, text) => { await sendMessage(receiver, text); return null; },
  downloadMedia,
};

async function resolveActor(receiverId, senderName) {
  const link = await prisma.viberChatLink.findUnique({ where: { receiverId: String(receiverId) } });
  if (!link) {
    // الاكتشاف: نردّ بالمعرّف ليربطه الأدمن. فايبر محادثة مباشرة مع البوت غالباً
    // (لا كروب مزدحم بالدردشة كتلكرام) فالردّ هنا مفيد لا مزعج.
    await sendMessage(receiverId, `هذه المحادثة غير مربوطة بأي حساب بعد.\nشارك هذا المعرّف مع الأدمن ليربطه: ${receiverId}`);
    return null;
  }
  if (!link.isActive) {
    await sendMessage(receiverId, 'الربط معطّل حالياً — تواصل مع الأدمن.');
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: link.userId } });
  if (!user || !user.isActive) {
    await sendMessage(receiverId, '⚠️ الحساب المرتبط غير فعّال — تواصل مع الأدمن.');
    return null;
  }
  return { link, user, senderName: senderName || null };
}

// حارس تكرار في الذاكرة: message_token نصّ لا عدّاد، فالمقارنة الوحيدة الممكنة
// «هل رأيته قبلاً». الحماية الحقيقية هي sourceHash في طابور الطلبيات.
const SEEN_TOKEN_MAX = 500;
const seenTokens = new Set();
const seenOnce = (tok) => {
  if (!tok) return false;
  if (seenTokens.has(tok)) return true;
  seenTokens.add(tok);
  while (seenTokens.size > SEEN_TOKEN_MAX) seenTokens.delete(seenTokens.values().next().value);
  return false;
};

/**
 * يعالج حدث فايبر من النوع message. لا يرمي أبداً (الكونترولر يُقرّ 200 ثم ينسى).
 * الصوت والفيديو خارج النطاق بقرار صريح — نصّ وصور فقط، كما في تلكرام.
 */
export async function handleViberEvent(update) {
  const receiverId = update?.sender?.id;
  const message = update?.message;
  if (!receiverId || !message) return;
  if (seenOnce(update.message_token)) return;

  const type = message.type;
  if (type !== 'text' && type !== 'picture') return; // ستيكر/موقع/ملف/صوت — تجاهل

  const actor = await resolveActor(receiverId, update?.sender?.name);
  if (!actor) return;

  // للتشخيص فقط — نصّ لأن message_token يتجاوز Number.MAX_SAFE_INTEGER.
  await prisma.viberChatLink.update({
    where: { receiverId: String(receiverId) },
    data:  { lastMessageToken: String(update.message_token ?? '') },
  }).catch(() => {});

  try {
    await handleIncomingOrderMessage({
      transport: viberTransport,
      link: actor.link,
      user: actor.user,
      chatId: String(receiverId),
      chatTitle: actor.senderName,
      senderName: actor.senderName,
      text: String(message.text || '').trim(),
      mediaRefs: type === 'picture' && message.media ? [message.media] : [],
      isReplyToBot: false, // فايبر لا يُعلِم بأن الرسالة ردّ على رسالة البوت
    });
  } catch (err) {
    console.error('[viber] فشل معالجة الرسالة:', err);
  }
}
