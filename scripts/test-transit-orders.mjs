// اختبار طلبيات الترانزيت (server/lib/transitOrders.js) — منطق نقيّ بلا قاعدة بيانات.
// npm run test:transit
import { parseTransitNote, parseTransitRow } from '../server/lib/transitOrders.js';

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

console.log(fail ? `\n${fail} فشل` : '\nكل الاختبارات نجحت');
process.exit(fail ? 1 : 0);
