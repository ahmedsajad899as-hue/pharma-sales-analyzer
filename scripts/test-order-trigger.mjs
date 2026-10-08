// ════════════════════════════════════════════════════════════════════════════
// اختبار كاشف الطلبيات في رسائل البوت (server/modules/orders/order-trigger.js)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/test-order-trigger.mjs
//
// لماذا يستحق اختباراً: هذا الكاشف هو الحدّ الفاصل بين «رسالة تُكلّف نداء Gemini»
// و«رسالة تُتجاهل مجاناً». خطأ بالاتجاه الأول يحرق الحصة ويملأ طابور المراجعة
// بدردشة الكروب؛ وخطأ بالاتجاه الثاني يُسقط طلبية حقيقية بصمت — والمندوب لن
// يعرف أبداً أن طلبيته لم تُقرأ، تماماً كما حدث في مطابقة أسماء المندوبين.
// والقرار كله نصّي حتمي فهو قابل للاختبار بلا قاعدة بيانات ولا شبكة.
// ════════════════════════════════════════════════════════════════════════════

import {
  isOrderTrigger, hasTriggerWord, stripBotCommandSuffix, normalizeAr,
  ORDER_TEXT_MODES, MAX_ORDER_TEXT_LEN,
} from '../server/modules/orders/order-trigger.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

// ── 1) إزالة لاحقة اسم البوت من الأوامر ─────────────────────────────────────
console.log('\n── لاحقة @BotName ──');
check('/order@MySalesBot → /order', stripBotCommandSuffix('/order@MySalesBot'), '/order');
check('/order بلا لاحقة',           stripBotCommandSuffix('/order'), '/order');
check('نص عادي لا يتأثر',            stripBotCommandSuffix('طلبية'), 'طلبية');

// ── 2) الكلمة المفتاحية: كل الصيغ العربية الشائعة ───────────────────────────
console.log('\n── الكلمة المفتاحية ──');
for (const w of ['طلبية', 'طلبيه', 'الطلبية', 'الطلبيه', 'طلبيات', 'اوردر', 'أوردر', 'order', '/order', '/order@Bot', 'ORDER']) {
  check(`«${w}» كلمة مفتاحية`, hasTriggerWord(`${w} صيدلية النور`), true);
}
// يجب أن تكون أول كلمة — كلمة مفتاحية في وسط الدردشة ليست طلبية.
check('«شكرا على الطلبية» ليست طلبية (الكلمة ليست أولاً)', hasTriggerWord('شكرا على الطلبية'), false);
check('تحية ليست طلبية', hasTriggerWord('صباح الخير'), false);
check('نص فارغ',          hasTriggerWord(''), false);
check('null',             hasTriggerWord(null), false);

// ── 3) التطبيع: أرقام هندية وتشكيل ──────────────────────────────────────────
console.log('\n── التطبيع ──');
check('٠-٩ → 0-9', normalizeAr('٥ علبة'), '5 علبه');
check('إسقاط التشكيل', normalizeAr('طَلَبِيَّة'), 'طلبيه');

// ── 4) وضع off — سلوك اليوم قبل الميزة: لا شيء يُقرأ ────────────────────────
console.log('\n── mode = off ──');
check('طلبية صريحة تُتجاهل',  isOrderTrigger('طلبية صيدلية النور 5 بانادول', 'off'), false);
check('حتى الردّ على البوت',  isOrderTrigger('5 بانادول', 'off', { isReplyToBot: true }), false);
check('حتى مع صورة',          isOrderTrigger('', 'off', { hasMedia: true }), false);

// ── 5) وضع trigger (الافتراضي) ──────────────────────────────────────────────
console.log('\n── mode = trigger ──');
check('طلبية بكلمة مفتاحية',  isOrderTrigger('طلبية صيدلية النور\nبانادول 5 علبة', 'trigger'), true);
check('دردشة تُرفض',           isOrderTrigger('صباح الخير شباب', 'trigger'), false);
check('أرقام بلا كلمة تُرفض',   isOrderTrigger('الحساب 250000 دينار اليوم', 'trigger'), false);
check('ردّ على البوت يُقبل',    isOrderTrigger('بانادول 5 علبة', 'trigger', { isReplyToBot: true }), true);
check('صورة بكابشن فيه الكلمة', isOrderTrigger('طلبية الهدى', 'trigger', { hasMedia: true }), true);
check('صورة بلا كابشن تُرفض',   isOrderTrigger('', 'trigger', { hasMedia: true }), false);

// ── 6) وضع all — كروب طلبيات مخصّص ─────────────────────────────────────────
console.log('\n── mode = all ──');
check('نص طويل فيه رقم يُقبل',   isOrderTrigger('صيدلية الهدى بانادول 5 علبة', 'all'), true);
check('«تمام» بلا أرقام تُرفض',   isOrderTrigger('تمام', 'all'), false);
check('نص طويل بلا أرقام يُرفض',  isOrderTrigger('اوكي خلص نشوفكم باچر انشالله', 'all'), false);
check('نص قصير فيه رقم يُرفض',    isOrderTrigger('5 علبة', 'all'), false);
check('صورة بلا كابشن تُقبل',     isOrderTrigger('', 'all', { hasMedia: true }), true);

// ── 7) حدود الطول — حماية من إرسال نص ضخم لـGemini ──────────────────────────
console.log('\n── حدود الطول ──');
const huge = 'طلبية ' + 'بانادول 5 علبة '.repeat(400);
check(`نص > ${MAX_ORDER_TEXT_LEN} حرف يُرفض حتى بكلمة مفتاحية`, isOrderTrigger(huge, 'trigger'), false);
check('نص ضخم يُرفض حتى في all', isOrderTrigger(huge, 'all'), false);

// ── 8) وضع غير معروف يرتدّ إلى trigger لا إلى all ──────────────────────────
console.log('\n── وضع غير صالح ──');
check('قيمة مجهولة = trigger (كلمة مطلوبة)', isOrderTrigger('صيدلية الهدى بانادول 5 علبة', 'wat'), false);
check('قيمة مجهولة تقبل الكلمة المفتاحية',    isOrderTrigger('طلبية الهدى 5 بانادول', 'wat'), true);
check('undefined = trigger',                  isOrderTrigger('طلبية الهدى 5 بانادول', undefined), true);
check('الأوضاع المعلنة ثلاثة', ORDER_TEXT_MODES, ['off', 'trigger', 'all']);

// ── 9) طلبيات واقعية كما تُكتب في الكروبات ──────────────────────────────────
console.log('\n── طلبيات واقعية ──');
const REAL = [
  'طلبية صيدلية النور - الكرخ\nزنتاك 20 علبة 9500\nبانادول 5 علبة',
  'اوردر\nابو احمد\n٥ علبة بانادول\n٣ فيتامين سي',
  '/order@PharmaBot صيدلية الهدى: دافلون 10 + 1 بونص',
];
REAL.forEach((t, i) => check(`طلبية واقعية #${i + 1}`, isOrderTrigger(t, 'trigger'), true));

const CHATTER = [
  'صباح الخير',
  'شكرا دكتور',
  'رقمي 07701234567 راسلني',
  'اني بالطريق اوصل بعد ساعة',
  'شكرا على الطلبية وصلت تمام',
];
CHATTER.forEach((t, i) => check(`دردشة #${i + 1} تُتجاهل`, isOrderTrigger(t, 'trigger'), false));

console.log(failed === 0 ? '\n✅ كل الاختبارات نجحت' : `\n❌ فشل ${failed} اختبار`);
process.exit(failed === 0 ? 0 : 1);
