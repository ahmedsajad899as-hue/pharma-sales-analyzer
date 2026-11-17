// ════════════════════════════════════════════════════════════════════════════
// اختبار سياق الكروب (server/modules/orders/group-context.js)
// تشغيل:  npm run test:group-context
// الحالة الأصلية: كروب «ديوانية مكتب النسق»، المرسل «Ameer Madher» = المندوب «امير مضر».
// ════════════════════════════════════════════════════════════════════════════

import { areaFromTitle, sameNameAcrossScripts, pickRepBySenderName, nameSkeleton } from '../server/modules/orders/group-context.js';
import { reconcileRowsWithText } from '../server/modules/orders/order-text-parse.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

console.log('\n── الاسم بين الأبجديتين ──');
check('هيكل Ameer Madher', nameSkeleton('Ameer Madher'), ['MR', 'MDR']);
check('هيكل امير مضر', nameSkeleton('امير مضر'), ['MR', 'MDR']);
check('Ameer Madher ≡ امير مضر', sameNameAcrossScripts('Ameer Madher', 'امير مضر'), true);
check('Ameer Madher ≡ أمير مضر جاسم (اسم أطول)', sameNameAcrossScripts('Ameer Madher', 'أمير مضر جاسم'), true);
check('Hussein Ali ≡ حسين علي', sameNameAcrossScripts('Hussein Ali', 'حسين علي'), true);
check('Mohammed Abdullah ≡ محمد عبدالله', sameNameAcrossScripts('Mohammed Abdullah', 'محمد عبدالله'), true);
check('Mustafa Kadhim ≡ مصطفى كاظم', sameNameAcrossScripts('Mustafa Kadhim', 'مصطفى كاظم'), true);
check('Ahmed Saad ≡ احمد سعد', sameNameAcrossScripts('Ahmed Saad', 'احمد سعد'), true);
check('Ameer Madher ≠ امير حسن', sameNameAcrossScripts('Ameer Madher', 'امير حسن'), false);
check('كلمة واحدة لا تكفي (Ameer ≠ امير)', sameNameAcrossScripts('Ameer', 'امير'), false);
check('ameer madher ≡ Ameer Madher', sameNameAcrossScripts('ameer madher', 'Ameer Madher'), true);

console.log('\n── اختيار المندوب ──');
const reps = [
  { id: 1, name: 'امير مضر', provinces: new Set([7]) },
  { id: 2, name: 'حسين علي', provinces: new Set([7]) },
  { id: 3, name: 'امير مضر', provinces: new Set([1]) }, // سميّ في بغداد
];
check('سميّان ← المحافظة تحسم', pickRepBySenderName('Ameer Madher', reps, 7)?.id, 1);
check('سميّان بلا محافظة ← لا حسم', pickRepBySenderName('Ameer Madher', reps, null), null);
check('بلا مطابقة ← null', pickRepBySenderName('Zaid Karim', reps, 7), null);
check('اسم فارغ ← null', pickRepBySenderName('', reps, 7), null);

console.log('\n── المنطقة من اسم الكروب ──');
const areaIndex = new Map([['ديوانيه', 'الديوانية'], ['قادسيه', 'القادسية'], ['كرخ', 'الكرخ']]);
const provinceIndex = new Map([['قادسيه', { id: 7, name: 'القادسية' }], ['نجف', { id: 9, name: 'النجف' }]]);
check('«ديوانية مكتب النسق» ← الديوانية', areaFromTitle('ديوانية مكتب النسق', areaIndex, provinceIndex), { area: 'الديوانية', provinceId: null, kind: 'area' });
check('«نجف مبيعات» ← محافظة النجف', areaFromTitle('نجف مبيعات', areaIndex, provinceIndex), { area: 'النجف', provinceId: 9, kind: 'province' });
check('«مبيع الكوديشن» ← لا شيء', areaFromTitle('مبيع الكوديشن', areaIndex, provinceIndex), null);
check('عنوان فارغ ← null', areaFromTitle('', areaIndex, provinceIndex), null);

console.log('\n── شفاء الطلبية #219 المعلَّقة عند فتحها ──');
check('منطقة «م. الضامن ⬅️» القديمة تُمسح والمذخر يُضبط',
  reconcileRowsWithText([{ item: 'Nasomista spray', quantity: 20, bonus: 0, pharmacy: 'علاء عبد الحسن', area: 'م. الضامن ⬅️', warehouse: null }],
    'Nasomista 20 ق\nم. الضامن ⬅️ ص. علاء عبد الحسن\n( الدكتور محمد سعيد )')
    .map(r => [r.item, r.quantity, r.pharmacy, r.area, r.warehouse]),
  [['Nasomista', 20, 'علاء عبد الحسن', null, 'الضامن']]);

console.log(failed ? `\n✗ ${failed} فشل` : '\n✓ كلها ناجحة');
process.exit(failed ? 1 : 0);
