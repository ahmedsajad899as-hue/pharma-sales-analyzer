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
// 2026-11-11: البونص داخل القوس، والقوس غير مغلق كما كتبه المندوب
check('Potafast (30+3 → قوس غير مغلق مع بونص', parseItemLine('Potafast (30+3'), { name: 'Potafast', quantity: 30, bonus: 3 });
check('Potafast (10+1) → بونص داخل القوس', parseItemLine('Potafast (10+1)'), { name: 'Potafast', quantity: 10, bonus: 1 });
check('Potafast 10+1) → قوس ختامي فقط', parseItemLine('Potafast 10+1)'), { name: 'Potafast', quantity: 10, bonus: 1 });
check('Pandev 40 بلا قوس ولا وحدة → لا حسم (تركيز)', parseItemLine('Pandev 40'), null);
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
), [{ item: 'pandev 40mg', quantity: 10, bonus: 0, pharmacy: 'شمس الرواسي', area: 'الامين', warehouse: 'الكندي' }]);

console.log('\n── حالات لا يجوز أن تتغيّر ──');
check('سطر واحد «سر الدواء/ الحارثية» بلا «ص» ⇒ لا حسم (الموديل)', parseOrderText('طلبيه\nسر الدواء/ الحارثية\nPantactive40.  50\nمذخر الناقوس').header,
  { pharmacy: null, area: null, warehouse: 'الناقوس', pharmacyLines: 0 });
check('«ص النور / الكرخ» في سطر واحد', parseOrderText('طلبية\nص النور / الكرخ\nبانادول 5 علبة').header,
  { pharmacy: 'النور', area: 'الكرخ', warehouse: null, pharmacyLines: 1 });
check('«طلبية صيدلية النور» ملتصقة', parseOrderText('طلبية صيدلية النور\nالكرخ\nبانادول علبتين').header,
  { pharmacy: 'النور', area: 'الكرخ', warehouse: null, pharmacyLines: 1 });
// 2026-11-18: آخر سطر عربي بعد الأصناف = المذخر (بتأكيد صاحب المشروع) — فلا يصير منطقة،
// وصنف عربي بلا كمية في الذيل يُقرأ مذخراً (ثمن مقبول يراه المراجِع).
check('سطر عربي في الذيل لا يصير منطقة (بل مذخراً)', parseOrderText('ص النور\nAmoxil 500 (5)\nبانادول').header,
  { pharmacy: 'النور', area: null, warehouse: 'بانادول', pharmacyLines: 1 });
check('سطر عربي بعد الأصناف ليس الأخير ⇒ لا مذخر', parseOrderText('ص النور\nAmoxil 500 (5)\nبانادول\nPandev (3)').header.warehouse, null);
check('صيدليتان في رسالة واحدة ⇒ لا حسم', parseOrderText('ص النور\nAmoxil (5)\nص الشفاء\nPandev (3)').header,
  { pharmacy: null, area: null, warehouse: null, pharmacyLines: 2 });
check('«صباح» ليست بادئة «ص»', parseOrderText('صباح الخير\nAmoxil (5)').header.pharmacy, null);
check('مذخر معروف بلا كلمة «مذخر»', parseOrderText('الحرية\nص العترة\nدواء الكندي\nPandev (3)').header,
  { pharmacy: 'العترة', area: 'الحرية', warehouse: 'الكندي', pharmacyLines: 1 });
check('مذخر من دفتر رصيد المذاخر', parseOrderText('الحرية\nص العترة\nالنهرين\nPandev (3)', { isKnownWarehouse: t => t === 'النهرين' }).header,
  { pharmacy: 'العترة', area: 'الحرية', warehouse: 'النهرين', pharmacyLines: 1 });

console.log('\n── العلامة + الجرعة المختصرة (Devit 50 = 50,000) ──');
const { brandDoseFallback } = await import('../server/modules/orders/orders.service.js');
// أسماء الكتالوج الفعلية كما في صفحة «الايتمات» بالسوبر أدمن (2026-10-19).
const cat = [
  { id: 1, name: 'DEVIT 3 50.000IU 8CAP' }, { id: 2, name: 'DEVIT 3 5000 I.U' },
  { id: 6, name: 'DEVIT 3 10.000IU 30CAP' }, { id: 7, name: 'DEVIT 3 300.000IU 1AMP' },
  { id: 8, name: 'DEVIT-3 ORAL DAMLA, 15ML' },
  { id: 3, name: 'Pandev 20mg' }, { id: 4, name: 'Pandev 40mg' }, { id: 5, name: 'Candexil plus' },
];
const fb = (n) => { const r = brandDoseFallback(n, cat); return r && [r.confidence, r.canonicalItem?.id ?? null]; };
check('Devit 50 ← 50.000IU', fb('Devit 50'), ['high', 1]);
check('Devit 5 ← 5000', fb('Devit 5'), ['high', 2]);
check('Devit 10 ← 10.000IU', fb('Devit 10'), ['high', 6]);
check('Devit 300 ← 300.000IU', fb('Devit 300'), ['high', 7]);
check('Devit 50000 ← 50.000IU', fb('Devit 50000'), ['high', 1]);
check('Devit 50,000 ← 50.000IU', fb('Devit 50,000'), ['high', 1]);
check('Devit 3 50 (رقم العلامة يُتجاهل)', fb('Devit 3 50'), ['high', 1]);
check('خطأ إملائي: Divit 10', fb('Divit 10'), ['high', 6]);
check('خطأ إملائي: Devet 300', fb('Devet 300'), ['high', 7]);
check('Devit drops ← DAMLA', fb('Devit drops'), ['high', 8]);
check('Devit بلا جرعة ⇒ اقتراحات بلا ربط', fb('Devit'), ['medium', null]);
check('Devit 20 جرعة غير موجودة ⇒ لا ربط', fb('Devit 20'), ['medium', null]);
check('Pandev 80 جرعة غير موجودة ⇒ لا ربط', fb('Pandev 80'), ['medium', null]);
check('علامة غير موجودة ⇒ null', fb('Zinnat 500'), null);
const cat2 = [{ id: 20, name: 'Azitro 500mg Tab' }, { id: 21, name: 'AZITRO Susp 200mg/5ml' }];
check('Azitro sus ← AZITRO Susp', brandDoseFallback('Azitro sus', cat2)?.canonicalItem?.id, 21);
check('Azitro tab 500 ← Tab', brandDoseFallback('Azitro tab 500', cat2)?.canonicalItem?.id, 20);
check('Azitro بلا جرعة ولا شكل ⇒ لا ربط', brandDoseFallback('Azitro', cat2)?.confidence, 'medium');

console.log('\n── الجرعة المركّبة (400/57 = 457) ──');
// الطلبيتان #139/#141 (2026-10-31): الفاتورة «Amoklavin-BID 400/57mg deva»، والكتالوج
// بأسماء ملف الكوديشن (test-manual-duplicates).
const cat3 = [
  { id: 30, name: 'AMOKLAVIN BID 625 500 125MG 10CAP' },
  { id: 31, name: 'AMOKLAVIN BID 1000MG 10TAB' },
  { id: 32, name: 'AMOKLAVIN BID 457MG SYRUP' },
];
const fb3 = (n, c = cat3) => { const r = brandDoseFallback(n, c); return r && [r.confidence, r.canonicalItem?.id ?? null]; };
check('400/57mg deva ← 457MG SYRUP', fb3('Amoklavin-BID 400/57mg deva'), ['high', 32]);
check('875/125 ← 1000MG', fb3('Amoklavin 875/125mg'), ['high', 31]);
check('500/125 ← 625 500 125MG', fb3('Amoklavin 500/125'), ['high', 30]);
check('العكس: 457 ← 400/57MG SUSP', fb3('Amoklavin 457',
  [{ id: 33, name: 'AMOKLAVIN BID 400/57MG SUSP' }, { id: 31, name: 'AMOKLAVIN BID 1000MG 10TAB' }]), ['high', 33]);
check('200mg/5ml تركيز لا مكوّنان (ليس 205)', fb3('Zoxan 200mg/5ml',
  [{ id: 40, name: 'ZOXAN 205MG TAB' }, { id: 41, name: 'ZOXAN 100MG TAB' }]), ['medium', null]);
const sizes = brandDoseFallback('Amoklavin-BID 400/57mg', [
  { id: 34, name: 'AMOKLAVIN BID 457MG SYRUP 70ML' }, { id: 35, name: 'AMOKLAVIN BID 457MG SYRUP 35ML' },
  { id: 31, name: 'AMOKLAVIN BID 1000MG 10TAB' },
]);
check('حجمان لنفس الجرعة ⇒ لا ربط، والمرشّحان هما الحجمان',
  [sizes.confidence, sizes.candidates.map(c => c.id).join(',')], ['medium', '34,35']);

console.log('\n── المذاخر ──');
const { findKnownWarehouse, cleanWarehouseName } = await import('../server/modules/orders/order-text-parse.js');
check('ملاحظة بعد المذخر تُقصّ', cleanWarehouseName('الناقوس بسبب عدم الانضمام الى ميركاتو'), 'الناقوس');
check('مذخر مجهول + ملاحظة', cleanWarehouseName('النهرين بسبب عدم الانضمام'), 'النهرين');
check('العناية ← العناية الطبية', findKnownWarehouse('العنايه'), 'العناية الطبية');
check('الفصول ← الفصول الاربعة', findKnownWarehouse('الفصول'), 'الفصول الاربعة');
check('خطأ إملائي بسيط: الناقوص', findKnownWarehouse('الناقوص'), 'الناقوس');
check('مذخران: الأول يغلب', cleanWarehouseName('اوزون او الناقوس'), 'اوزون');
check('طلبية الناقوس كاملة', run(
  'الحارثية\nص محمود وضاح\nColastin 20(30)\nVazkor5(30)\nتجهز ترانزيت من مذخر الناقوس بسبب عدم الانضمام الى ميركاتو',
  [
    { item: 'Colastin 20', quantity: 30, pharmacy: 'محمود وضاح', area: 'الحارثية', warehouse: 'الناقوس بسبب عدم الانضمام الى ميركاتو' },
    { item: 'Vazkor 5', quantity: 30, pharmacy: 'محمود وضاح', area: 'الحارثية', warehouse: 'الناقوس بسبب عدم الانضمام الى ميركاتو' },
  ],
).map(r => [r.item, r.quantity, r.pharmacy, r.area, r.warehouse]), [
  ['Colastin 20', 30, 'محمود وضاح', 'الحارثية', 'الناقوس'],
  ['Vazkor 5', 30, 'محمود وضاح', 'الحارثية', 'الناقوس'],
]);
check('سطر مذاخر بعد الأصناف ليس صنفاً (الصورة 10)', run(
  'ابو غريب\nص جوهرة خان ضاري\nAzitro sus (10)\nتجهز ترانزيت من مذخر التفاح الاخضر\nسنايا اسبرين منارة',
  [
    { item: 'Azitro sus', quantity: 10, pharmacy: 'جوهرة خان ضاري', area: 'ابو غريب', warehouse: 'التفاح الاخضر' },
    { item: 'سنايا اسبرين', quantity: null, pharmacy: 'جوهرة خان ضاري', area: 'ابو غريب', warehouse: 'التفاح الاخضر' },
  ],
).map(r => [r.item, r.quantity, r.pharmacy, r.area, r.warehouse]), [
  ['Azitro sus', 10, 'جوهرة خان ضاري', 'ابو غريب', 'التفاح الاخضر'],
]);
check('«اسبرين 10 علبة» دواء حقيقي يبقى', run('ص النور\nاسبرين 10 علبة',
  [{ item: 'اسبرين', quantity: 10, pharmacy: 'النور' }]).map(r => r.item), ['اسبرين']);
check('مذخر الموديل بلا سطر واضح يُنظَّف', run('Colastin 20(30)',
  [{ item: 'Colastin 20', quantity: 30, warehouse: 'مذخر طريق السلام لعدم وجود' }]).map(r => r.warehouse), ['طريق السلام']);
check('سطر «اوزون» وحده = مذخر', parseOrderText('العامرية\nص قمر الثلج\nاوزون\npandev 20 (5)').header,
  { pharmacy: 'قمر الثلج', area: 'العامرية', warehouse: 'اوزون', pharmacyLines: 1 });

// ── قاعدة المناطق (2026-10-19): «مدينة الصدر / هيثم عكلة حنو» بلا «ص» (الطلبية #80) ──
const AREAS = new Map([['مدينه الصدر', 'مدينة الصدر'], ['الاورفلي', 'مدينة الصدر'], ['الداخل', 'مدينة الصدر'], ['الحريه', 'الحرية']]);
const areaOf = (t) => AREAS.get(String(t).trim().replace(/ة/g, 'ه')) ?? null;
check('منطقة مسجّلة بلا «ص» ⇒ السطر الآخر صيدلية (#80)',
  parseOrderText('مدينة الصدر\nهيثم عكلة حنو\nCandexil 16/12.5 (10)\nمذخر العهد الجديد', { areaOf }).header,
  { pharmacy: 'هيثم عكلة حنو', area: 'مدينة الصدر', warehouse: 'العهد الجديد', pharmacyLines: 1 });
check('اسم مدموج («الاورفلي») ⇒ مدينة الصدر',
  parseOrderText('الاورفلي\nص النور\nPandev (3)', { areaOf }).header.area, 'مدينة الصدر');
check('بلا «ص» وسطران غير منطقة ⇒ لا حسم (الموديل)',
  parseOrderText('مدينة الصدر\nهيثم عكلة\nالعهد الجديد\nCandexil (10)', { areaOf }).header.pharmacy, null);
check('#80 كاملة: الموديل قلب الصيدلية والمنطقة', run(
  'مدينة الصدر\nهيثم عكلة حنو\nCandexil 16/12.5 (10)\nمذخر العهد الجديد',
  [{ item: 'Candexil plus', quantity: 10, pharmacy: 'مدينة الصدر', area: null, warehouse: 'العهد الجديد' }],
  { areaOf },
).map(r => [r.pharmacy, r.area]), [['هيثم عكلة حنو', 'مدينة الصدر']]);

// ── كروب الديوانية (2026-11-17، الطلبية #219): «ق» = قطعة، «م.» = مذخر، سهم يفصل الحقلين ──
// ذهبت للذكاء لأن «20 ق» لم تُعرف كمية، وقُرئ «م. الضامن ⬅️» منطقةً.
check('Nasomista 20 ق → كمية 20', parseItemLine('Nasomista 20 ق'), { name: 'Nasomista', quantity: 20, bonus: null });
check('Nasomista 5 قطعة', parseItemLine('Nasomista 5 قطعة'), { name: 'Nasomista', quantity: 5, bonus: null });
check('#219: م. الضامن ⬅️ ص. علاء عبد الحسن + سطر الطبيب',
  parseOrderText('Nasomista 20 ق\nم. الضامن ⬅️ ص. علاء عبد الحسن\n( الدكتور محمد سعيد )'),
  { header: { pharmacy: 'علاء عبد الحسن', area: null, warehouse: 'الضامن', pharmacyLines: 1 }, itemLines: ['Nasomista 20 ق'] });
check('«م. الضامن ص. علاء» بلا سهم، والطبيب قبل الأصناف لا يصير مذخراً',
  parseOrderText('م. الضامن ص. علاء عبد الحسن\n( الدكتور محمد سعيد )\nNasomista 20 ق').header,
  { pharmacy: 'علاء عبد الحسن', area: null, warehouse: 'الضامن', pharmacyLines: 1 });
check('«د. علي» سطر طبيب لا منطقة', parseOrderText('ص النور\nد. علي حسين\nPandev (3)').header,
  { pharmacy: 'النور', area: null, warehouse: null, pharmacyLines: 1 });
check('«منصور» ليست بادئة «م»', parseOrderText('منصور\nص النور\nPandev (3)').header.area, 'منصور');

// ── كروب الديوانية #220 (2026-11-17): الكمية في سطر وحدها، و«5 amp» حجم العبوة لا الكمية ──
// ذهبت للذكاء فقرأ «5» كمية والصحيح 10؛ وسطر «@رقم» (إشارة واتساب) كان يُعدّ صنفاً.
const T220 = 'Amikavir. 5 amp\n10 قطعة\nصيدلية الولاية\nمذخر الضامن\n@244168991453375';
check('#220: سطر «10 قطعة» يلتصق بصنفه والإشارة تُتجاهل', parseOrderText(T220),
  { header: { pharmacy: 'الولاية', area: null, warehouse: 'الضامن', pharmacyLines: 1 }, itemLines: ['Amikavir. 5 amp (10)'] });
check('#220: الاسم يحتفظ بـ«5 amp» والكمية 10', parseItemLine('Amikavir. 5 amp (10)'), { name: 'Amikavir 5 amp', quantity: 10, bonus: null });
check('#220: قراءة الموديل (5) تُصحَّح إلى 10', run(T220,
  [{ item: 'Amikavir', quantity: 5, pharmacy: 'الولاية', area: null, warehouse: 'الضامن' }]).map(r => [r.item, r.quantity]),
  [['Amikavir 5 amp', 10]]);
check('سطر كمية بعد صنف كميته صريحة لا يلتصق', parseOrderText('ص النور\nPandev (3)\n10').itemLines, ['Pandev (3)', '10']);
check('«10+2 علبة» وحدها = كمية وبونص', parseOrderText('ص النور\nPandev 40\n10+2 علبة').itemLines, ['Pandev 40 (10+2)']);
const cat220 = [{ id: 1, name: 'Amikaver 500mg 2ml 5 amp' }, { id: 2, name: 'Amikaver 500mg 2ml 1 amp' }];
check('#220: «Amikavir 5 amp» ← حجم 5 amp (عدد العبوة يحسم)', brandDoseFallback('Amikavir 5 amp', cat220)?.canonicalItem?.id, 1);
check('«Amikavir 1 amp» ← حجم 1 amp', brandDoseFallback('Amikavir 1 amp', cat220)?.canonicalItem?.id, 2);
check('«Amikavir» بلا عدد ⇒ لا ربط', brandDoseFallback('Amikavir', cat220)?.confidence, 'medium');
check('عدد لا يطابق أي حجم ⇒ لا ربط', brandDoseFallback('Amikavir 10 amp', cat220)?.confidence, 'medium');

// ── كروب الديوانية #228 (2026-11-17): صورة + كابشن، «ع 10» الوحدة قبل الرقم، بدائل مذخر بـ«او» ──
// قُرئت الصيدلية «م . ضرغام» والمنطقة «الخليج» (بديل مذخر) والمذخر فارغاً.
const T228 = 'Amoklavin 625\nع 10\nAmoklavin 457\nع 10\nص احمد الشيباني\nم الضرغام او الخليج او الضامن\n@244168991453375';
check('#228: الترويسة والأصناف من النص', parseOrderText(T228),
  { header: { pharmacy: 'احمد الشيباني', area: null, warehouse: 'الضرغام', pharmacyLines: 1 }, itemLines: ['Amoklavin 625 (10)', 'Amoklavin 457 (10)'] });
check('«Amoklavin 625 ع 10» في سطر واحد', parseItemLine('Amoklavin 625 ع 10'), { name: 'Amoklavin 625', quantity: 10, bonus: null });
check('«مذخر اوزون او الناقوس» ← الأول', cleanWarehouseName('الضرغام او الخليج'), 'الضرغام');
const img228 = () => [
  { item: 'AMOKLAVIN BID 625 500 125MG 10CAP', quantity: 10, pharmacy: 'م . ضرغام', area: 'حي الخليج', _areaRaw: 'الخليج', warehouse: null },
  { item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 10, pharmacy: 'م . ضرغام', area: 'الخليج', warehouse: null },
];
check('#228 صورة: الكابشن يحسم الصيدلية والمذخر ويمسح منطقة البديل، والأصناف تبقى',
  reconcileRowsWithText(img228(), T228, { headerOnly: true }).map(r => [r.item, r.quantity, r.pharmacy, r.area, r.warehouse]), [
    ['AMOKLAVIN BID 625 500 125MG 10CAP', 10, 'احمد الشيباني', null, 'الضرغام'],
    ['AMOKLAVIN BID 457MG SYRUP', 10, 'احمد الشيباني', null, 'الضرغام'],
  ]);
check('منطقة الموديل غير المذكورة في سطر المذخر تبقى', run('ص النور\nم الضامن\nPandev (3)',
  [{ item: 'Pandev', quantity: 3, pharmacy: 'النور', area: 'الحرية' }]).map(r => r.area), ['الحرية']);

// 2026-11-18: كابشن صورة يُقرأ وحده كنصّ حين «تحليل الصور» مطفأ (كروب ديوانية مكتب النسق)
{
  const cap = 'Amoklavin ES\n30 قطعة\nصيدلية البدوية\nترانزيت من مذخر الغدير\n@9647812345678\nالى الدكتور سعد عباس جوده';
  const { header, itemLines } = parseOrderText(cap);
  check('كابشن صورة: ترويسة', { pharmacy: header.pharmacy, warehouse: header.warehouse }, { pharmacy: 'البدوية', warehouse: 'الغدير' });
  check('كابشن صورة: الصنف والكمية', itemLines.map(parseItemLine), [{ name: 'Amoklavin ES', quantity: 30, bonus: null }]);
}

// 2026-11-18: كروب Basra nasq — «عدد 10» سطراً وحده تحت الصنف (المحلل وحده رفضه فضاعت الطلبية)
{
  const t = 'ص زهراء هاشم رشيد\nDaytrix im\nعدد 10\nWinfast\nعدد 5';
  const { header, itemLines } = parseOrderText(t);
  check('«عدد N»: الصيدلية', header.pharmacy, 'زهراء هاشم رشيد');
  check('«عدد N»: الأصناف والكميات', itemLines.map(parseItemLine),
    [{ name: 'Daytrix im', quantity: 10, bonus: null }, { name: 'Winfast', quantity: 5, bonus: null }]);
  check('«سيادة» في الذيل بلا «مذخر» = المذخر', parseOrderText(t + '\nسيادة').header.warehouse, 'سيادة');
  check('ذيل مجاملة «شكرا» ليس مذخراً', parseOrderText(t + '\nشكرا').header.warehouse, null);
  check('ذيل «تسليم باجر» ليس مذخراً', parseOrderText(t + '\nتسليم باجر').header.warehouse, null);
  check('«مذخر» صريح يغلب الذيل', parseOrderText('ص النور\nمذخر الضامن\nPandev (3)\nسيادة').header.warehouse, 'الضامن');
  check('«Pandev 40 10 عدد» في سطر واحد', parseItemLine('Pandev 40 10 عدد'), { name: 'Pandev 40', quantity: 10, bonus: null });
}

// 2026-11-19: كروب البصرة (المرسل Murtadha Khalid) — «عدد50قطعة» الرقم بين وحدتين ملتصقاً بهما.
// رُفعت «للمراجعة» بكمية فارغة والاسم يحمل «عدد50قطعة» فلم يُربط الصنف.
{
  const t = 'Amikaver 5 amp عدد50قطعة\nDikloron gel عدد30قطعة\nص الارض الطيبة\nم سيادة';
  const { header, itemLines } = parseOrderText(t);
  check('البصرة: الترويسة', { pharmacy: header.pharmacy, warehouse: header.warehouse }, { pharmacy: 'الارض الطيبة', warehouse: 'سيادة' });
  check('البصرة: الأصناف والكميات', itemLines.map(parseItemLine), [
    { name: 'Amikaver 5 amp', quantity: 50, bonus: null },
    { name: 'Dikloron gel', quantity: 30, bonus: null },
  ]);
  check('صفوف المراجعة القديمة تُشفى عند الفتح', run(t, [
    { item: 'Amikaver 5 amp عدد50قطعة', quantity: null, pharmacy: 'الارض الطيبة', warehouse: 'سيادة' },
    { item: 'Dikloron gel عدد30قطعة', quantity: null, pharmacy: 'الارض الطيبة', warehouse: 'سيادة' },
  ]).map(r => [r.item, r.quantity]), [['Amikaver 5 amp', 50], ['Dikloron gel', 30]]);
  check('«عدد 50 قطعة» بمسافات', parseItemLine('Pandev 40 عدد 50 قطعة'), { name: 'Pandev 40', quantity: 50, bonus: null });
  const catB = [{ id: 1, name: 'Amikaver 500mg 2ml 5 amp' }, { id: 2, name: 'Amikaver 500mg 2ml 1 amp' },
    { id: 3, name: 'Dikloron 50 g Gel' }, { id: 4, name: 'Dikloron 75mg 3ml 5 amp' }, { id: 5, name: 'Dikloron 50mg 20 tab' }];
  check('«Amikaver 5 amp» ← Amikaver 500mg 2ml 5 amp', brandDoseFallback('Amikaver 5 amp', catB)?.canonicalItem?.id, 1);
  check('«Dikloron gel» ← Dikloron 50 g Gel', brandDoseFallback('Dikloron gel', catB)?.canonicalItem?.id, 3);
}

// 2026-11-21: كروب «مكتب النسق _ ميسان» (المحلل وحده) — الكمية ووحدتها قبل اسم عربي.
// parseItemLine كان يُعيد null ⇒ المحلل يرفض، وقراءة المراجعة تشترط اسماً لاتينياً ⇒ ضاعت الأربع.
{
  const cases = [
    ['10 ق تينتيز\nص ابن سينا النموذجيه\nد نائل حسين\nم ابن سينا',
      { pharmacy: 'ابن سينا النموذجيه', warehouse: 'ابن سينا' }, [{ name: 'تينتيز', quantity: 10, bonus: null }]],
    ['10 ق جيرولين\nص ابن سينا النموذجيه\nم ابن سينا\nد نائل',
      { pharmacy: 'ابن سينا النموذجيه', warehouse: 'ابن سينا' }, [{ name: 'جيرولين', quantity: 10, bonus: null }]],
    ['50 ق ديتركس iv\nص القمر\nد عصام صدام\nمذخر الصيدلي\n@~حيدر عبدالله',
      { pharmacy: 'القمر', warehouse: 'الصيدلي' }, [{ name: 'ديتركس iv', quantity: 50, bonus: null }]],
    ['20 ق سيكوسيتام شراب\nص للحسنين\nمذخر المعتصم\n@~حيدر عبدالله',
      { pharmacy: 'للحسنين', warehouse: 'المعتصم' }, [{ name: 'سيكوسيتام شراب', quantity: 20, bonus: null }]],
  ];
  for (const [t, head, items] of cases) {
    const { header, itemLines } = parseOrderText(t);
    check(`ميسان: ترويسة «${items[0].name}»`, { pharmacy: header.pharmacy, warehouse: header.warehouse }, head);
    check(`ميسان: صنف «${items[0].name}»`, itemLines.map(parseItemLine), items);
  }
  check('«10+1 ق Pandev» بونص قبل الاسم', parseItemLine('10+1 ق Pandev'), { name: 'Pandev', quantity: 10, bonus: 1 });
  check('«10+1 Pandev» بونص بلا وحدة', parseItemLine('10+1 Pandev'), { name: 'Pandev', quantity: 10, bonus: 1 });
  check('«10 علبة بانادول»', parseItemLine('10 علبة بانادول'), { name: 'بانادول', quantity: 10, bonus: null });
  check('رقم وحده أول السطر بلا وحدة ⇒ لا حسم', parseItemLine('5 FU cream'), null);
  check('«10 pandev» لا تُقرأ «p» وحدة', parseItemLine('10 pandev'), null);
  check('«10 ق Amikavir 5 amp» حجم العبوة يبقى بالاسم', parseItemLine('10 ق Amikavir 5 amp'), { name: 'Amikavir 5 amp', quantity: 10, bonus: null });
}

console.log(failed ? `\n✗ ${failed} فشل` : '\n✓ كلها ناجحة');
process.exit(failed ? 1 : 0);
