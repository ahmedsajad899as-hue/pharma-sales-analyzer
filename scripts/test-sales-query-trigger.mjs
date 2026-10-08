// ════════════════════════════════════════════════════════════════════════════
// اختبار كاشف سؤال المبيعات في رسائل البوت
// (server/modules/orders/sales-query-trigger.js)
// تشغيل: node scripts/test-sales-query-trigger.mjs
// ════════════════════════════════════════════════════════════════════════════

import { parseSalesQuery } from '../server/modules/orders/sales-query-trigger.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

const CUR_YEAR = new Date().getFullYear();

console.log('\n── اسم قبل الكلمة المفتاحية ──');
check('محمد باقر مبيع شهر 9', parseSalesQuery('محمد باقر مبيع شهر 9'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: false });
check('محمد باقر مبيعات شهر 9', parseSalesQuery('محمد باقر مبيعات شهر 9'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: false });
check('أرقام هندية ٩', parseSalesQuery('محمد باقر مبيع شهر ٩'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: false });

console.log('\n── الكلمة المفتاحية أولاً ──');
check('مبيع محمد باقر شهر 9', parseSalesQuery('مبيع محمد باقر شهر 9'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: false });
check('مبيعات محمد باقر لشهر 9', parseSalesQuery('مبيعات محمد باقر لشهر 9'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: false });

console.log('\n── سنة صريحة ──');
check('محمد باقر مبيع شهر 9 سنة 2026', parseSalesQuery('محمد باقر مبيع شهر 9 سنة 2026'),
  { repNameRaw: 'محمد باقر', month: 9, year: 2026, qualifier: null, detailed: false });
check('محمد باقر مبيع شهر 9 2025', parseSalesQuery('محمد باقر مبيع شهر 9 2025'),
  { repNameRaw: 'محمد باقر', month: 9, year: 2025, qualifier: null, detailed: false });

console.log('\n── مؤهِّل الشركة/المكتب عند تعدّد المرشحين ──');
check('محمد باقر مبيع شهر 9 مكتب الكرخ', parseSalesQuery('محمد باقر مبيع شهر 9 مكتب الكرخ'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: 'مكتب الكرخ', detailed: false });

console.log('\n── وضع «تفاصيل» ──');
check('تفاصيل لا تتسرّب إلى الاسم', parseSalesQuery('محمد باقر مبيع شهر 9 تفاصيل'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: true });
check('تفاصيل في أول الرسالة', parseSalesQuery('تفاصيل محمد باقر مبيع شهر 9'),
  { repNameRaw: 'محمد باقر', month: 9, year: CUR_YEAR, qualifier: null, detailed: true });

console.log('\n── حالات ترفض ──');
check('بلا شهر', parseSalesQuery('محمد باقر مبيع كثير هذا الشهر'), null);
check('شهر بلا مبيع', parseSalesQuery('محمد باقر شهر 9'), null);
check('شهر خارج المدى', parseSalesQuery('محمد باقر مبيع شهر 13'), null);
check('رسالة طلبية عادية لا تتأثر', parseSalesQuery('طلبية صيدلية النور بانادول 5 علبة'), null);
check('دردشة عادية', parseSalesQuery('صباح الخير شباب'), null);
check('نص فارغ', parseSalesQuery(''), null);
check('null', parseSalesQuery(null), null);
check('اسم فارغ بعد الاستخراج', parseSalesQuery('مبيع شهر 9'), null);

console.log(failed === 0 ? '\n✅ كل الاختبارات نجحت' : `\n❌ فشل ${failed} اختبار`);
process.exit(failed === 0 ? 0 : 1);
