// ════════════════════════════════════════════════════════════════════════════
// اختبار القراءة الحتمية لنصّ الطلبية (server/modules/orders/order-text-parse.js)
// تشغيل:  npm run test:order-text
//
// الحالات أدناه طلبيات حقيقية من كروب «مبيع الكوديشن» (2026-10-19) مع **ما أعاده
// Gemini فعلاً** لكلٍّ منها (كما ظهر في شبكة المراجعة). أي تعديل يُعيد أحد هذه
// الأخطاء يجب أن يُسقط الاختبار.
// ════════════════════════════════════════════════════════════════════════════

import { parseOrderText, parseItemLine, reconcileRowsWithText } from '../server/modules/orders/order-text-parse.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};
const pick = (r) => ({ item: r.item, quantity: r.quantity, bonus: r.bonus, pharmacy: r.pharmacy, area: r.area, warehouse: r.warehouse });
const run = (text, modelRows, opts) => reconcileRowsWithText(modelRows.map(r => ({ bonus: 0, unitPrice: null, total: null, ...r })), text, opts).map(pick);

console.log('\n── سطر الصنف ──');
check('pandev 20 (5) → التركيز في الاسم والكمية 5', parseItemLine('pandev 20 (5)'), { name: 'pandev 20', quantity: 5, bonus: null });
check('Devit50(5) → فصل الالتصاق', parseItemLine('Devit50(5)'), { name: 'Devit 50', quantity: 5, bonus: null });
check('Devit 50,000 (20) → بلا فاصل آلاف', parseItemLine('Devit 50,000 (20)'), { name: 'Devit 50000', quantity: 20, bonus: null });
check('pandev 40mg(10p)', parseItemLine('pandev 40mg(10p)'), { name: 'pandev 40mg', quantity: 10, bonus: null });
check('Azitro tap 500.   50+5p', parseItemLine('Azitro tap 500.   50+5p'), { name: 'Azitro tap 500', quantity: 50, bonus: 5 });
check('candexil 10 p', parseItemLine('candexil 10 p'), { name: 'candexil', quantity: 10, bonus: null });
check('Pandev 40(10)', parseItemLine('Pandev 40(10)'), { name: 'Pandev 40', quantity: 10, bonus: null });
check('بلا شكل كمية صريح ⇒ null (الموديل يقرّر)', parseItemLine('Pandev 40'), null);
check('تركيز عشري يبقى', parseItemLine('Digoxin 0.125mg (3)'), { name: 'Digoxin 0.125mg', quantity: 3, bonus: null });

console.log('\n── الصور السبع ──');
check('1) الشعلة / ص. الماسة الثمينة', run(
  'الشعلة\nص. الماسة الثمينة\n\nAzitro tap 500.   50+5p',
  [{ item: 'Azitro tap 500', quantity: 50, bonus: 5, pharmacy: 'الماسة الثمينة', area: null }],
), [{ item: 'Azitro tap 500', quantity: 50, bonus: 5, pharmacy: 'الماسة الثمينة', area: 'الشعلة', warehouse: undefined }]);

check('2) الحرية / ص. العترة / مذخر الناقوس', run(
  'الحرية\nص. العترة\n\ncandexil 10 p\n\nمذخر الناقوس',
  [{ item: 'candexil', quantity: 10, pharmacy: 'الحرية ص. العترة', area: null, warehouse: 'الناقوس' }],
), [{ item: 'candexil', quantity: 10, bonus: 0, pharmacy: 'العترة', area: 'الحرية', warehouse: 'الناقوس' }]);

check('3) المنصور / ص ابن النفيس / تم التجهيز من مذخر اسبرين', run(
  'المنصور\nص ابن النفيس\nPandev 40(10)\nتم التجهيز من مذخر اسبرين',
  [{ item: 'Pandev 40', quantity: 10, pharmacy: 'المنصور ص ابن النفيس', area: 'المنصور', warehouse: 'اسبرين' }],
), [{ item: 'Pandev 40', quantity: 10, bonus: 0, pharmacy: 'ابن النفيس', area: 'المنصور', warehouse: 'اسبرين' }]);

check('4) ابو غريب خان ضاري / ص دار الحكمة (+ Devit)', run(
  'ابو غريب خان ضاري\nص دار الحكمة\nDevit50(5)\nDevit5(5)\nGetamisin 10amp (10)\nAzitro tab 500 (10)\nPandev20(30)\nمذخر الكندي',
  [
    { item: 'Devit50(5)', quantity: 5, pharmacy: 'ابو غريب', area: 'خان ضاري', warehouse: 'الكندي' },
    { item: 'Devit5(5)', quantity: 5, pharmacy: 'ابو غريب', area: 'خان ضاري', warehouse: 'الكندي' },
    { item: 'Getamisin 10amp', quantity: 10, pharmacy: 'ابو غريب', area: 'خان ضاري', warehouse: 'الكندي' },
    { item: 'Azitro tab 500', quantity: 10, pharmacy: 'ابو غريب', area: 'خان ضاري', warehouse: 'الكندي' },
    { item: 'Pandev20', quantity: 30, pharmacy: 'ابو غريب', area: 'خان ضاري', warehouse: 'الكندي' },
  ],
).map(r => [r.item, r.quantity, r.pharmacy, r.area]), [
  ['Devit 50', 5, 'دار الحكمة', 'ابو غريب خان ضاري'],
  ['Devit 5', 5, 'دار الحكمة', 'ابو غريب خان ضاري'],
  ['Getamisin 10amp', 10, 'دار الحكمة', 'ابو غريب خان ضاري'],
  ['Azitro tab 500', 10, 'دار الحكمة', 'ابو غريب خان ضاري'],
  ['Pandev 20', 30, 'دار الحكمة', 'ابو غريب خان ضاري'],
]);

check('5) العامرية / ص قمر الثلج / مذخر اوزون / pandev 20 (5)', run(
  'العامرية\nص قمر الثلج\nمذخر اوزون\npandev 20 (5)',
  [{ item: 'pandev', quantity: 20, bonus: 5, pharmacy: 'قمر الثلج', area: 'العامريه', warehouse: 'اوزون' }],
), [{ item: 'pandev 20', quantity: 5, bonus: 0, pharmacy: 'قمر الثلج', area: 'العامرية', warehouse: 'اوزون' }]);

check('6) Devit 50,000 (20)', run(
  'العامرية\nص قمر الثلج\nDevit 50,000 (20)',
  [{ item: 'Devit 50,000', quantity: 20, pharmacy: 'قمر الثلج', area: 'العامريه' }],
).map(r => [r.item, r.quantity, r.area]), [['Devit 50000', 20, 'العامرية']]);

check('7) ص شمس الرواسي / دواء الكندي / منطقة الامين', run(
  'ص شمس الرواسي\nدواء الكندي\nمنطقة الامين\npandev 40mg(10p)',
  [{ item: 'Pandev 40mg', quantity: null, pharmacy: 'شمس الرواسي دواء الكندي', area: 'الامين' }],
), [{ item: 'pandev 40mg', quantity: 10, bonus: 0, pharmacy: 'شمس الرواسي', area: 'الامين', warehouse: 'دواء الكندي' }]);

console.log('\n── حالات لا يجوز أن تتغيّر ──');
check('سطر واحد «سر الدواء/ الحارثية» بلا «ص» ⇒ لا حسم (الموديل)', parseOrderText('طلبيه\nسر الدواء/ الحارثية\nPantactive40.  50\nمذخر الناقوس').header,
  { pharmacy: null, area: null, warehouse: 'الناقوس', pharmacyLines: 0 });
check('«ص النور / الكرخ» في سطر واحد', parseOrderText('طلبية\nص النور / الكرخ\nبانادول 5 علبة').header,
  { pharmacy: 'النور', area: 'الكرخ', warehouse: null, pharmacyLines: 1 });
check('«طلبية صيدلية النور» ملتصقة', parseOrderText('طلبية صيدلية النور\nالكرخ\nبانادول علبتين').header,
  { pharmacy: 'النور', area: 'الكرخ', warehouse: null, pharmacyLines: 1 });
check('صنف عربي بلا رقم بعد الأصناف لا يصير منطقة', parseOrderText('ص النور\nAmoxil 500 (5)\nبانادول').header,
  { pharmacy: 'النور', area: null, warehouse: null, pharmacyLines: 1 });
check('صيدليتان في رسالة واحدة ⇒ لا حسم', parseOrderText('ص النور\nAmoxil (5)\nص الشفاء\nPandev (3)').header,
  { pharmacy: null, area: null, warehouse: null, pharmacyLines: 2 });
check('«صباح» ليست بادئة «ص»', parseOrderText('صباح الخير\nAmoxil (5)').header.pharmacy, null);
check('مذخر معروف بلا كلمة «مذخر»', parseOrderText('الحرية\nص العترة\nدواء الكندي\nPandev (3)', { isKnownWarehouse: t => t === 'دواء الكندي' }).header,
  { pharmacy: 'العترة', area: 'الحرية', warehouse: 'دواء الكندي', pharmacyLines: 1 });

console.log('\n── العلامة + الجرعة المختصرة (Devit 50 = 50,000) ──');
const { brandDoseFallback } = await import('../server/modules/orders/orders.service.js');
const cat = [
  { id: 1, name: 'Devit 50,000 IU Cap' }, { id: 2, name: 'Devit 5000 IU Tab' },
  { id: 3, name: 'Pandev 20mg' }, { id: 4, name: 'Pandev 40mg' }, { id: 5, name: 'Candexil plus' },
];
const fb = (n) => { const r = brandDoseFallback(n, cat); return r && [r.confidence, r.canonicalItem?.id ?? null]; };
check('Devit 50 ← 50,000', fb('Devit 50'), ['high', 1]);
check('Devit 5 ← 5000', fb('Devit 5'), ['high', 2]);
check('Devit 50000 ← 50,000', fb('Devit 50000'), ['high', 1]);
check('Devit بلا جرعة ⇒ اقتراحات بلا ربط', fb('Devit'), ['medium', null]);
check('Pandev 80 جرعة غير موجودة ⇒ لا ربط', fb('Pandev 80'), ['medium', null]);
check('علامة غير موجودة ⇒ null', fb('Zinnat 500'), null);

console.log(failed ? `\n✗ ${failed} فشل` : '\n✓ كلها ناجحة');
process.exit(failed ? 1 : 0);
