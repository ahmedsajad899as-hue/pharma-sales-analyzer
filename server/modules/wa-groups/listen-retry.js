// listen-retry.js — قرارات إعادة رسائل كروبات المندوبين الصامتة (نقي: بلا قاعدة بيانات).
// اختباره: npm run test:wa-groups
//
// الكروب صامت فلا أحد يُبلَّغ حين تُرفض رسالة، لذلك امتلاء طابور المراجعة ليس رفضاً نهائياً
// كباقي أخطاء 4xx: الرسالة تنتظر في السجلّ حتى يراجع المسؤول طلبياته.
import { isOrderTrigger } from '../orders/order-trigger.js';
import { hasPersonalSaleTrigger } from '../province-teams/personal-sale-trigger.js';

export const QUEUE_FULL_CODE = 'PENDING_ORDERS_FULL';

/** فشل يستحق الإعادة: طابور ممتلئ، أو عطل ذكاء/خادم (5xx)، أو خطأ غير متوقّع — لا مدخل مرفوض (4xx). */
export const retryable = (err) =>
  err?.code === QUEUE_FULL_CODE || !err?.isOperational || (err.statusCode ?? 500) >= 500;

/**
 * هل تُؤجَّل الرسالة قبل قراءتها؟ الطابور ممتلئ وهي ستدخله فعلاً. القراءة تسبق فحص
 * الطابور في المسار العادي، فبدون هذا تُدفع توكنزها مع كل إعادة. الدردشة و«مبيعي»
 * لا تدخل الطابور فلا تُؤجَّل.
 */
export function shouldDeferForFullQueue({ text, mode, hasMedia, pending, limit }) {
  if (pending < limit) return false;
  if (mode !== 'off' && hasPersonalSaleTrigger(text)) return false;
  return isOrderTrigger(text, mode, { hasMedia });
}
