// اختبار منطق «هل الفاتورة محفوظة سابقاً؟» (server/lib/manualDuplicateCheck.js) بلا قاعدة بيانات.
// npm run test:manual-duplicates
import { __test, flagConditionTransitDups } from '../server/lib/manualDuplicateCheck.js';

const { compareOrder, buildIncomingOrder, pharmKey, areaKey, dayOf, realInvoice } = __test;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name} → ${got}${ok ? '' : ` (المتوقع ${want})`}`);
};

const NOW = new Date('2026-10-16T09:00:00Z');
const exItem = (name, qty, company = 'deva') => ({ itemId: null, name, keys: new Set([name.toLowerCase()]), qty, company });
// فاتورة 67644 كما في ملف الكوديشن (الرشاقة / الدورة)
const saved = {
  invoice: realInvoice('67644'), rawInvoice: '67644',
  pharmacy: pharmKey('الرشاقه'), pharmacyName: 'الرشاقه', area: areaKey('الدورة'), areaName: 'الدورة',
  day: dayOf(new Date('2026-10-14T00:00:00Z')), savedDay: dayOf(new Date('2026-10-15T10:00:00Z')),
  items: [
    exItem('AMOKLAVIN BID 625 500 125MG 10CAP', 50),
    exItem('AMOKLAVIN BID 1000MG 10TAB', 50),
    exItem('AMOKLAVIN BID 457MG SYRUP', 50),
  ],
};
const inc = (rows, receivedAt = NOW) =>
  buildIncomingOrder('g', rows.map((r, i) => ({ _index: i, ...r })), null, dayOf(receivedAt));
const level = (rows, ex = saved, at) => compareOrder(inc(rows, at), ex)?.level ?? 'new';

// 1) نفس الصورة أُعيد رفعها: نفس الرقم، قراءة سعر مختلفة لا تهم
check('إعادة رفع نفس الفاتورة', level([
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'ص الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 625 500 125MG 10CAP', quantity: 50 },
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'ص الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'ص الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 50 },
]), 'duplicate');

// 2) طلبية نصية ناقصة (بلا رقم ولا تاريخ) بعد حفظ الصورة
check('طلبية نصية بعد الصورة', level([
  { pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
  { pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 50 },
]), 'duplicate');

// 3) العكس: نُصّ صنفان محفوظان أولاً، ثم وصلت الصورة بثلاثة ⇒ جزئية (الثالث جديد)
const textSaved = { ...saved, invoice: '', rawInvoice: '', day: null, items: saved.items.slice(1) };
check('صورة بعد طلبية نصية ناقصة', level([
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 625 500 125MG 10CAP', quantity: 50 },
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
  { invoiceNumber: '67644', date: '2026-10-14', pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 50 },
], textSaved), 'partial');

// 4) صيدلية أخرى بنفس الأصناف والكميات ⇒ ليست مكررة
check('صيدلية مختلفة', level([
  { pharmacy: 'ياسر عمار حسين', area: 'البياع', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
]), 'new');

// 5) نفس الصيدلية لكن بعد شهر ⇒ طلبية جديدة
check('نفس الصيدلية بعد شهر', level([
  { date: '2026-11-20', pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
]), 'new');

// 6) رقمان حقيقيان مختلفان لنفس الصيدلية ⇒ فاتورتان
check('رقم فاتورة مختلف', level([
  { invoiceNumber: '67990', date: '2026-10-14', pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 20 },
]), 'new');

// 7) جرعة مختلفة لا تُعدّ نفس الصنف (حارس الجرعة)
check('جرعة مختلفة', level([
  { pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 400/57MG SUSP', quantity: 50 },
]), 'new');

// 8) نفس الأصناف لكن الكمية مختلفة ⇒ محتملة فقط
check('كمية مختلفة', level([
  { pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 20 },
  { pharmacy: 'الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 10 },
]), 'possible');

// 9) BOT-<id> رقم تركيبي لا يُعدّ رقم فاتورة
check('رقم BOT تركيبي', realInvoice('BOT-55'), '');

// 10) صورة فاتورة المذخر لطلبية جهّزها ميركاتو: رقم الفاتورة غير رقم طلبية ميركاتو،
//     والفاتورة بعد التجهيز بيومين ⇒ مكررة (رقمان مختلفان لا ينفيان التطابق هنا)
const mercatoSaved = { ...saved, mercato: true, invoice: realInvoice('M-88123'), rawInvoice: 'M-88123', area: areaKey('الدوره') };
check('صورة فاتورة طلبية ميركاتو', level([
  { invoiceNumber: '5521', date: '2026-10-16', pharmacy: 'صيدلية الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
  { invoiceNumber: '5521', date: '2026-10-16', pharmacy: 'صيدلية الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 457MG SYRUP', quantity: 50 },
], mercatoSaved), 'duplicate');
check('نفس رقم الفاتورة مع ملف كوديشن ⇒ ما زالت فاتورتين', level([
  { invoiceNumber: '5521', date: '2026-10-16', pharmacy: 'صيدلية الرشاقة', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
], { ...mercatoSaved, mercato: false }), 'new');
check('ميركاتو: صيدلية أخرى ⇒ جديدة', level([
  { invoiceNumber: '5521', date: '2026-10-16', pharmacy: 'النور', area: 'الدورة', item: 'AMOKLAVIN BID 1000MG 10TAB', quantity: 50 },
], mercatoSaved), 'new');

// 11) حالتا 2026-10-21: نفس الصيدلية والصنف والكمية، لكن ميركاتو جهّزها مذخر آخر ⇒ طلبية جديدة
const mercatoOrder = (pharmacy, warehouse, item, qty) => ({
  invoice: '', rawInvoice: '', mercato: true, pharmacy: pharmKey(pharmacy), pharmacyName: pharmacy, area: '', areaName: '',
  warehouse, warehouseKey: __test.whKey(warehouse),
  day: dayOf(new Date('2026-10-12T00:00:00Z')), savedDay: dayOf(NOW), items: [exItem(item, qty)],
});
check('هيثم عكلة: المنارة (ميركاتو) ≠ العهد الجديد (البوت)', level([
  { date: '2026-10-12', pharmacy: 'هيثم عكلة حنون', area: 'مدينة الصدر', warehouse: 'العهد الجديد', item: 'CANDEXIL PLUS 16/12.5MG 28TAB', quantity: 10 },
], mercatoOrder('هيثم عكله حنون', 'المنارة - بغداد', 'CANDEXIL PLUS 16/12.5MG 28TAB', 10)), 'new');
check('شناشيل: طريق السلام (ميركاتو) ≠ سما المحيط (البوت)', level([
  { date: '2026-10-12', pharmacy: 'شناشيل', area: 'بغداد الجديدة', warehouse: 'سما المحيط', item: 'PANDEV 40MG 14TAB', quantity: 10 },
], mercatoOrder('الشناشيل', 'طريق السلام - بغداد', 'PANDEV 40MG 14TAB', 10)), 'new');
check('نفس المذخر بصيغتين («مذخر المنارة» = «المنارة - بغداد») ⇒ مكررة', level([
  { date: '2026-10-12', pharmacy: 'هيثم عكلة حنون', warehouse: 'مذخر المنارة', item: 'CANDEXIL PLUS 16/12.5MG 28TAB', quantity: 10 },
], mercatoOrder('هيثم عكله حنون', 'المنارة - بغداد', 'CANDEXIL PLUS 16/12.5MG 28TAB', 10)), 'duplicate');
check('البوت بلا مذخر ⇒ يبقى التنبيه', level([
  { date: '2026-10-12', pharmacy: 'هيثم عكلة حنون', item: 'CANDEXIL PLUS 16/12.5MG 28TAB', quantity: 10 },
], mercatoOrder('هيثم عكله حنون', 'المنارة - بغداد', 'CANDEXIL PLUS 16/12.5MG 28TAB', 10)), 'duplicate');

// 12) زر «قارن» في ملف اللكوديشن: سطر ميركاتو بأعمدة الجدول، والطرف الآخر من الترانزيت
const line = __test.mercatoLineView({
  id: 9, quantity: 20, totalValue: 121120, saleDate: new Date('2026-10-12T00:00:00Z'),
  item: { name: 'AMOKLAVIN BID 1000MG 10TAB' }, area: { name: 'الدورة', province: { name: 'بغداد' } }, customer: { name: 'الرشاقة' },
  rawData: JSON.stringify({ 'رقم طلبية المذخر': '5521', 'اسم المذخر': 'بلاتين - بغداد', 'الصنف': 'Deva', 'اسم المندوب': 'محمود بلال', 'كمية البونص': '5', 'السعر': '6056' }),
}, 'USD');
check('سطر ميركاتو: الرقم', line.invoice, '5521');
check('سطر ميركاتو: المذخر', line.warehouse, 'بلاتين - بغداد');
check('سطر ميركاتو: الشركة', line.company, 'Deva');
check('سطر ميركاتو: البونص', line.bonus, 5);
check('سطر ميركاتو: السعر', line.unitPrice, 6056);
check('سطر ميركاتو: المحافظة', line.province, 'بغداد');
check('سطر ميركاتو: العملة', line.currency, 'USD');
check('سطر ميركاتو: تاريخ', line.date, '2026-10-12');
const noPrice = __test.mercatoLineView({ id: 10, quantity: 4, totalValue: 100, saleDate: new Date(0), rawData: '{}' }, null);
check('بلا سعر ⇒ القيمة ÷ الكمية', noPrice.unitPrice, 25);
check('بلا بونص ⇒ 0', noPrice.bonus, 0);
check('بلا تاريخ (علامة 1970) ⇒ فارغ', noPrice.date, '');
check('بلا عملة ⇒ IQD', noPrice.currency, 'IQD');

const baseRow = { pharmacy: 'النور', warehouse: 'بلاتين', item: 'PANDEV 40MG 14TAB', company: 'Deva', quantity: 10, bonus: 0, unitPrice: 100, total: 1000, area: '', province: 'بغداد', invoice: '' };
const condRow = { ...baseRow, id: 1, date: '2026-10-12', rep: 'محمود بلال', source: 'بوت تلكرام', bonus: 2 };
const transitCopies = [
  { ...baseRow, id: 2, date: '2026-10-10', rep: 'علي', source: 'ترانزيت', transit: true },
  { ...baseRow, id: 2, date: '2026-10-10', rep: 'سارة', source: 'ترانزيت', transit: true },
];
flagConditionTransitDups([{ rows: [condRow] }, { rows: [transitCopies[0]] }, { rows: [transitCopies[1]] }]);
check('ترانزيت: صف اللكوديشن يرى كل مندوبي الترانزيت', condRow.transitMatch?.other?.rep, 'علي، سارة');
check('ترانزيت: صف اللكوديشن يرى الايتم', condRow.transitMatch?.other?.item, 'PANDEV 40MG 14TAB');
check('ترانزيت: علامة الترانزيت في الطرف الآخر', condRow.transitMatch?.other?.transit, true);
check('ترانزيت: كل نسخة ترى صف اللكوديشن', transitCopies.every(c => c.transitMatch?.other?.id === 1), true);
check('ترانزيت: بونص الطرف الآخر', transitCopies[1].transitMatch?.other?.bonus, 2);

if (fail) { console.error(`\n${fail} اختبار فشل`); process.exit(1); }
console.log('\nكل الاختبارات نجحت');
