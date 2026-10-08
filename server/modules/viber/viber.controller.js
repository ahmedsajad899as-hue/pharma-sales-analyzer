import crypto from 'crypto';
import { handleViberEvent, viberToken } from './viber.service.js';

/**
 * POST /api/viber/webhook — مسار عام (خارج قائمة JWT، راجع server/index.js)،
 * موثَّق بتوقيع فايبر: X-Viber-Content-Signature = HMAC-SHA256 للجسم **الخام**
 * بمفتاح توكن الحساب. الجسم الخام يحفظه ردّ verify في express.json
 * (server/index.js) لهذا المسار وحده — فـexpress.json يستهلك البايتات ويرميها.
 *
 * ما دام VIBER_AUTH_TOKEN غير مضبوط تُعيد النقطة **404**: لا 401 ولا 500. نقطة
 * نائمة تبدو «غير منشورة» لأي فاحص، بلا سجلّات وبلا إنذارات كاذبة، وتفعيلها
 * لاحقاً إضافة متغيّر بيئة وpm2 restart --update-env بلا نشر جديد.
 */
export async function webhook(req, res) {
  const token = viberToken();
  if (!token) return res.sendStatus(404);

  const sig = String(req.headers['x-viber-content-signature'] || '');
  const raw = req.rawBody;
  if (!raw || !sig) return res.sendStatus(403);

  const expected = crypto.createHmac('sha256', token).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig.toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);

  const event = req.body?.event;

  // فايبر يُرسل event:'webhook' لحظة set_webhook و**يشترط** رداً 200 بهذا الشكل،
  // وإلا رفض التسجيل. وبقية الأحداث تُقَرّ ولا تُعالَج.
  if (event !== 'message') {
    return res.json({ status: 0, status_message: 'ok' });
  }

  // إقرار فوري ثم معالجة بلا انتظار — نفس نمط ويب-هوك تلكرام: قراءة الطلبية
  // بالذكاء قد تأخذ عشرات الثواني، ولا يجوز أن يُعيد فايبر إرسال التحديث بسببها.
  res.json({ status: 0, status_message: 'ok' });
  handleViberEvent(req.body).catch(err => console.error('[viber] handleViberEvent crashed:', err));
}
