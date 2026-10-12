// اختبار مطابقة الصيدلية/المنطقة المستخرَجة من الفواتير مع بيانات الماستر.
// نقيّ بلا قاعدة بيانات: npm run test:invoice-match
import { buildMasterIndex, resolveOne, matchArea } from '../server/lib/invoiceCustomerMatch.js';
import { isWarehouseAsPharmacy, foldBonusRows, isStaffField, splitPharmacyArea } from '../server/modules/sales/sales.service.js';

const areas = [
  { id: 1, name: 'المنصور', needsReview: false },
  { id: 2, name: 'المنصورية', needsReview: false },
  { id: 3, name: 'الحارثية', needsReview: false },
  { id: 4, name: 'الكرادة', needsReview: false },
  { id: 5, name: 'حي الجامعة', needsReview: false },
  { id: 6, name: 'الطارمية', needsReview: false },
  { id: 7, name: 'المنصور', needsReview: true }, // نسخة حساب آخر
];
const aliases = [{ fromKey: 'دوره جمعه', areaId: 4 }];
const pharmacies = [
  { id: 10, name: 'صيدلية فوزي', pharmacyName: null, ownerName: 'فوزي عبد الله', areaName: 'المنصور' },
  { id: 11, name: 'نور الكرادة', pharmacyName: null, ownerName: null, areaName: 'الكرادة' },
  { id: 12, name: 'سر الدواء', pharmacyName: null, ownerName: null, areaName: 'الحارثية' },
  { id: 13, name: 'اسامة سليمان العبيدي', pharmacyName: null, ownerName: null, areaName: 'حي الجامعة' },
  { id: 14, name: 'النور', pharmacyName: null, ownerName: null, areaName: 'المنصور' },
  { id: 15, name: 'النور', pharmacyName: null, ownerName: null, areaName: 'الكرادة' },
];
const m = buildMasterIndex(areas, aliases, pharmacies);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`}`);
};
const r = (ph, ar) => { const x = resolveOne(ph, ar, m); return [x.pharmacy, x.area]; };

eq('منصور ← المنصور (بلا ال)', matchArea('منصور', m)?.name, 'المنصور');
eq('لا يخلط المنصور بالمنصورية', matchArea('المنصوريه', m)?.name, 'المنصورية');
eq('بغداد - منصور ← الحيّ', matchArea('بغداد - منصور', m)?.name, 'المنصور');
eq('عنوان حقل يُسقَط: المنطقة: الكرادة', matchArea('المنطقة: الكرادة', m)?.name, 'الكرادة');
eq('alias محفوظ', matchArea('دورة جمعة', m)?.name, 'الكرادة');
eq('منطقة مجهولة تبقى null', matchArea('حي العامل', m), null);

eq('الفاتورة: فوزي / منصور', r('فوزي', 'منصور'), ['صيدلية فوزي', 'المنصور']);
eq('بلا فاصل: فوزي منصور', r('فوزي منصور', ''), ['صيدلية فوزي', 'المنصور']);
eq('اسم صيدلية ينتهي بحيّ يبقى كاملاً', r('نور الكرادة', ''), ['نور الكرادة', 'الكرادة']);
eq('صيدلية بلا منطقة تأخذ منطقتها من السيرفي', r('سر الدواء', ''), ['سر الدواء', 'الحارثية']);
eq('تاء مربوطة/همزة', r('أسامة سليمان العبيدي', ''), ['اسامة سليمان العبيدي', 'حي الجامعة']);
eq('النور مكرّرة: المنطقة تحسم', r('النور', 'منصور'), ['النور', 'المنصور']);
const amb = resolveOne('النور', '', m);
eq('النور بلا منطقة: لا حسم + مرشّحون', [amb.matched, amb.candidates.length >= 2], [false, true]);
eq('صيدلية جديدة لا تُستبدل', r('بيت الشفاء', 'الطارمية'), ['بيت الشفاء', 'الطارمية']);

eq('المذخر كصيدلية: aspirin', isWarehouseAsPharmacy('aspirin', 'Aspirin Drug store'), true);
eq('المذخر كصيدلية: مذخر …', isWarehouseAsPharmacy('مذخر الناقوس', ''), true);
eq('صيدلية عادية ليست مذخراً', isWarehouseAsPharmacy('فوزي', 'Aspirin Drug store'), false);

eq('حقل المجهز ليس صيدلية', isStaffField('المجهز: حسين فالح'), true);
eq('حقل المندوب برقم هاتف', isStaffField('عبد الرحمن مسلم 07721951402'), true);
eq('صيدلية عادية ليست حقل موظف', isStaffField('النعيمي'), false);
eq('السيد : صيدلية النعيمي/ السعوديه', splitPharmacyArea('السيد : صيدلية النعيمي/ السعوديه', ''), { pharmacy: 'النعيمي', area: 'السعوديه' });

const b1 = foldBonusRows([{ item: 'lexur 500mg', quantity: '10+2', unitPrice: 7680, total: 76800, bonus: 0 }]);
eq('10+2 داخل الكمية', [b1[0].quantity, b1[0].bonus], [10, 2]);
const b2 = foldBonusRows([
  { item: 'lexur 500mg', quantity: 10, unitPrice: 7680, total: 76800, bonus: 0 },
  { item: 'Lexur 500mg', quantity: 2, unitPrice: 0, total: 0, bonus: 0 },
  { item: 'other', quantity: 3, unitPrice: 0, total: 0, bonus: 0 },
]);
eq('سطر مجاني لنفس المادة يُطوى بونصاً', b2.map(x => [x.item, x.quantity, x.bonus]), [['lexur 500mg', 10, 2], ['other', 3, 0]]);

console.log(fail ? `\n${fail} فشل` : '\nكل الاختبارات نجحت');
process.exit(fail ? 1 : 0);
