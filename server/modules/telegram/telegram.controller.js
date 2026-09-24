import { handleUpdate } from './telegram.service.js';

/**
 * POST /api/telegram/webhook — مسار عام (خارج قائمة JWT، راجع server/index.js)،
 * موثَّق بدلاً من ذلك بهيدر X-Telegram-Bot-Api-Secret-Token الذي يُثبَّت مرة
 * واحدة عند تسجيل الويب-هوك (setWebhook secret_token) ويُعاد إرساله من تلكرام
 * مع كل تحديث. راجع commercial.controller.js::apiKeyAuth لنمط مشابه لمسار عام آخر.
 */
export async function webhook(req, res) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  // رد فوري لتلكرام كي لا يُعيد إرسال نفس التحديث بسبب بطء معالجة الملف — رسالة
  // التأكيد/الخطأ الفعلية تصل عبر sendMessage منفصلة داخل handleUpdate.
  res.sendStatus(200);
  handleUpdate(req.body).catch(err => console.error('[telegram] handleUpdate crashed:', err));
}
