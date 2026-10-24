import crypto from 'crypto';
import { handleWhatsAppWebhook, whatsappEnabled, whatsappAppSecret, whatsappVerifyToken } from './whatsapp.service.js';

/**
 * GET /api/whatsapp/webhook — مصافحة التسجيل من لوحة Meta: تُرسل hub.verify_token
 * الذي كتبناه هناك وتنتظر hub.challenge نصاً حرفياً. أي شيء آخر = رفض التسجيل.
 *
 * المصافحة تحتاج WHATSAPP_VERIFY_TOKEN **وحده**: لوحة Meta تطلب تسجيل الويب-هوك
 * قبل إضافة الرقم (فلا PHONE_NUMBER_ID بعد). بلاه تُعيد **404** — نفس منطق ويب-هوك
 * فايبر: نقطة نائمة تبدو «غير منشورة» بلا إنذارات كاذبة. الـPOST يبقى خامداً حتى
 * يكتمل الإعداد.
 */
export function verify(req, res) {
  const expected = whatsappVerifyToken();
  if (!expected) return res.sendStatus(404);
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === expected) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  return res.sendStatus(403);
}

/**
 * POST /api/whatsapp/webhook — مسار عام (خارج قائمة JWT، راجع server/index.js)،
 * موثَّق بتوقيع Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 للجسم **الخام**
 * بمفتاح App Secret. الجسم الخام يحفظه verify في express.json لهذا المسار وحده.
 * بلا App Secret مضبوط نرفض كل شيء — ويب-هوك بلا توقيع يعني أن أي أحد يستطيع
 * حقن «طلبيات» باسم أي رقم مربوط.
 */
export async function webhook(req, res) {
  if (!whatsappEnabled()) return res.sendStatus(404);

  const secret = whatsappAppSecret();
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const raw = req.rawBody;
  if (!secret) { console.error('[whatsapp] WHATSAPP_APP_SECRET غير مضبوط — رُفض الويب-هوك'); return res.sendStatus(403); }
  if (!raw || !sig.startsWith('sha256=')) return res.sendStatus(403);

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig.slice(7).toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);

  // إقرار فوري ثم معالجة بلا انتظار: قراءة الطلبية بالذكاء قد تأخذ عشرات الثواني،
  // وMeta تُعيد الإرسال إن لم يصلها 200 سريعاً.
  res.sendStatus(200);
  handleWhatsAppWebhook(req.body).catch(err => console.error('[whatsapp] handleWhatsAppWebhook crashed:', err));
}
