// اختبار منطق «هل الفاتورة محفوظة سابقاً؟» (server/lib/manualDuplicateCheck.js) بلا قاعدة بيانات.
// npm run test:manual-duplicates
import { __test } from '../server/lib/manualDuplicateCheck.js';

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

if (fail) { console.error(`\n${fail} اختبار فشل`); process.exit(1); }
console.log('\nكل الاختبارات نجحت');
