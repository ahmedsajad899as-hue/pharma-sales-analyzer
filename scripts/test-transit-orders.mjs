// اختبار طلبيات الترانزيت (server/lib/transitOrders.js) — منطق نقيّ بلا قاعدة بيانات.
// npm run test:transit
import { parseTransitNote, parseTransitRow, placeFromNote } from '../server/lib/transitOrders.js';
import { buildMasterIndex } from '../server/lib/invoiceCustomerMatch.js';
import { buildProvinceLookup } from '../server/lib/provinces.js';
import { normalizeAreaName } from '../server/lib/itemResolver.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// ── الملاحظة ──
eq('ص/ اسم شخص', parseTransitNote('ترانزيت إلى ص/ احمد رعد صالح'), { pharmacy: 'احمد رعد صالح', areaHint: '' });
eq('صيدلية + منطقة', parseTransitNote('ترانزيت الى صيدلية العامرية المركزية / الفلوجة'), { pharmacy: 'العامرية المركزية', areaHint: 'الفلوجة' });
eq('ص/ بلا مسافة', parseTransitNote('ترانزيت الى ص/ركن المضيف'), { pharmacy: 'ركن المضيف', areaHint: '' });
eq('بلا بادئة', parseTransitNote('ترانزيت الى ابواب الحمد'), { pharmacy: 'ابواب الحمد', areaHint: '' });
eq('تعليمات ملحقة', parseTransitNote('ترانزيت إلى ص/ البصمة ترسل مع الطلبية'), { pharmacy: 'البصمة', areaHint: '' });
eq('منطقة بين قوسين', parseTransitNote('ترانزيت الى ص/ الشفاء (الكرادة)'), { pharmacy: 'الشفاء', areaHint: 'الكرادة' });
eq('لصيدلية', parseTransitNote('ترانزيت لصيدلية النور'), { pharmacy: 'النور', areaHint: '' });
eq('ليست ترانزيت', parseTransitNote('طلبية عادية'), null);

// ── الصف ──
const row = (o) => JSON.stringify({ 'اسم العميل': 'واحة الريان', 'معلومات الزبون': 'علمي', 'صنف': 'مذخر', 'الملاحظة': 'ترانزيت الى ص/ البصمة', ...o });
eq('علمي ✓', parseTransitRow(row({}), 3300)?.pharmacy, 'البصمة');
eq('تجاري ✓', parseTransitRow(row({ 'معلومات الزبون': 'تجاري' }), 100)?.pharmacy, 'البصمة');
eq('فارماسي لاين ✗', parseTransitRow(row({ 'معلومات الزبون': 'فارماسي لاين' }), 100), null);
eq('بلا معلومات زبون ✗', parseTransitRow(row({ 'معلومات الزبون': '' }), 100), null);
eq('ليس مذخر ✗', parseTransitRow(row({ 'صنف': 'صيدلية' }), 100), null);
eq('فري ترانزيت ✗', parseTransitRow(row({ 'الملاحظة': 'فري ترانزيت إلى ص/ البصمة ترسل مع الطلبية' }), 0), null);
eq('قيمة صفر ✗', parseTransitRow(row({}), 0), null);
eq('بلا ترانزيت ✗', parseTransitRow(row({ 'الملاحظة': 'تسليم سريع' }), 100), null);

// ── مكان الصيدلية (المحافظة تحكم بحث الاسم) ──
const PROV = [
  { id: 1, name: 'بغداد', aliases: '[]' },
  { id: 9, name: 'الأنبار', aliases: '["الانبار","الرمادي","الفلوجة"]' },
  { id: 15, name: 'القادسية', aliases: '["الديوانية","ديوانية"]' },
];
const AREAS = [
  { id: 10, name: 'الحارثية', provinceId: 1 }, { id: 11, name: 'المنصور', provinceId: 1 },
  { id: 20, name: 'الفلوجة', provinceId: 9 }, { id: 30, name: 'حي العسكري', provinceId: 15 },
];
const m = buildMasterIndex(AREAS.map(a => ({ ...a, needsReview: false })), [],
  [{ id: 1, name: 'النموذجية', pharmacyName: null, ownerName: null, areaName: 'الحارثية' }]);
const ofArea = new Map();
for (const a of AREAS) ofArea.set(normalizeAreaName(a.name), new Set([a.provinceId]));
const pIdx = { byName: buildProvinceLookup(PROV), ofArea };
const place = (note, rowProvince = '') => { const t = { ...parseTransitNote(note), rowProvince }; const r = placeFromNote(t, m, pIdx); return [r.place.areaName, r.place.provinceName, r.place.how || (r.needsSales ? 'sales?' : '')]; };

eq('صيدلية بغداد بنفس الاسم لا تُنسب لترانزيت الديوانية', place('ترانزيت الى ص/ النموذجية / الديوانية'), ['', 'القادسية', 'sales?']);
eq('محافظة ملتصقة بالاسم', place('ترانزيت الى ص/ النموذجية الديوانية'), ['', 'القادسية', 'sales?']);
eq('بلا تلميح ← السيرفي', place('ترانزيت الى ص/ النموذجية'), ['الحارثية', '', 'survey']);
eq('منطقة باسم بديل لمحافظة', place('ترانزيت الى صيدلية العامرية المركزية / الفلوجة'), ['الفلوجة', 'الأنبار', 'note']);
eq('منطقة داخل المحافظة', place('ترانزيت الى ص/ النموذجية / الديوانية - حي العسكري'), ['حي العسكري', 'القادسية', 'note']);
eq('محافظة الصف تمنع صيدلية بغداد', place('ترانزيت الى ص/ النموذجية', 'الديوانية'), ['', 'القادسية', 'sales?']);
eq('صف بغداد ← السيرفي في بغداد', place('ترانزيت الى ص/ النموذجية', 'بغداد'), ['الحارثية', '', 'survey']);
eq('بغداد بلا منطقة لا تُنسب للمحافظة', place('ترانزيت الى ص/ غير موجودة / بغداد'), ['', '', 'sales?']);
eq('منطقة مكتوبة غير معروفة', place('ترانزيت الى ص/ النموذجية / قرية بعيدة'), ['', '', 'unknown-area']);

console.log(fail ? `\n${fail} فشل` : '\nكل الاختبارات نجحت');
process.exit(fail ? 1 : 0);
