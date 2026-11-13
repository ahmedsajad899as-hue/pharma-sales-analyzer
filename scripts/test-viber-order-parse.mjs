// ════════════════════════════════════════════════════════════════════════════
// اختبار قراءة طلبيات كروب الفايبر (server/modules/rep-orders/viber-order-parse.js)
// تشغيل:  npm run test:viber-order
//
// الحالات من كروب «مبيعات فارماكتف مذاخر» (سكرين شوت صاحب المشروع 2026-11-13).
// ════════════════════════════════════════════════════════════════════════════

import { parseViberOrder, parseViberItemLine, splitHeaderLine, orderFingerprint, splitPasteIntoOrders } from '../server/modules/rep-orders/viber-order-parse.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};
const pick = (r) => ({ pharmacy: r.pharmacy, area: r.area, warehouses: r.warehouses, items: r.items, notes: r.notes, needsAi: r.needsAi });

console.log('\n── سطر الصنف ──');
check('Potafast 10(+1)', parseViberItemLine('Potafast 10(+1)'), { name: 'Potafast', quantity: 10, bonus: 1, note: null });
check('Amoklavin 625mg *20(+2)', parseViberItemLine('Amoklavin 625mg *20(+2)'), { name: 'Amoklavin 625mg', quantity: 20, bonus: 2, note: null });
check('Pantactive 40mg*5(+1) test order', parseViberItemLine('Pantactive 40mg*5(+1) test order'), { name: 'Pantactive 40mg', quantity: 5, bonus: 1, note: 'test order' });
check('Pantactive 40mg 10+3', parseViberItemLine('Pantactive 40mg 10+3'), { name: 'Pantactive 40mg', quantity: 10, bonus: 3, note: null });
check('Pantactive 20mg 10 — رقم بعد تركيز', parseViberItemLine('Pantactive 20mg 10'), { name: 'Pantactive 20mg', quantity: 10, bonus: 0, note: null });
check('Devit 50 — لبس: يُترك للذكاء', parseViberItemLine('Devit 50'), null);
check('Pandev 40(10) — شكل البوت', parseViberItemLine('Pandev 40(10)'), { name: 'Pandev 40', quantity: 10, bonus: 0, note: null });
check('Amoklavin 625mg *20', parseViberItemLine('Amoklavin 625mg *20'), { name: 'Amoklavin 625mg', quantity: 20, bonus: 0, note: null });

console.log('\n── الترويسة ──');
check('حي الجامعة/ص.دوائكم الراقي', splitHeaderLine('حي الجامعة/ص.دوائكم الراقي'), { pharmacy: 'دوائكم الراقي', area: 'الجامعة', sure: true });
check('ص النور / الكرخ', splitHeaderLine('ص النور / الكرخ'), { pharmacy: 'النور', area: 'الكرخ', sure: true });
check('ماجد حميد - شارع فلسطين', splitHeaderLine('ماجد حميد - شارع فلسطين'), { pharmacy: 'ماجد حميد', area: 'شارع فلسطين', sure: false });
check('منطقة مسجّلة أولاً بلا «ص»', splitHeaderLine('المنصور/الشفاء', (t) => (t === 'المنصور' ? 'المنصور' : null)), { pharmacy: 'الشفاء', area: 'المنصور', sure: true });

console.log('\n── طلبيات كاملة ──');
const o1 = `حي الجامعة/ص.دوائكم الراقي
Potafast 10(+1)
Moreserc 10(+1)
عن طريق مذاخر
اوزون
شغف
الدواء المتكامل
@Ahmed Sajad
@عمر ليدر الكرخ`;
check('دوائكم الراقي: مادتان + 3 مذاخر بالترتيب', pick(parseViberOrder(o1)), {
  pharmacy: 'دوائكم الراقي', area: 'الجامعة', warehouses: ['اوزون', 'شغف', 'الدواء المتكامل'],
  items: [{ name: 'Potafast', quantity: 10, bonus: 1 }, { name: 'Moreserc', quantity: 10, bonus: 1 }],
  notes: [], needsAi: false,
});
check('المنشنات تُلتقط ولا تصير أصنافاً', parseViberOrder(o1).mentions, ['Ahmed Sajad', 'عمر ليدر الكرخ']);

const o2 = `حي الجامعة/ص.تسنيم الحياة
Amoklavin 625mg *20(+2)
Pantactive 40mg*5(+1) test order
+class A لوصفات الدكتور اكرم مقصود اخصائي كسور
عن طريق مذخر
طريق السلام
Ahmed Sajad@
عمر ليدر الكرخ@`;
check('تسنيم الحياة: ملاحظتان + مذخر واحد', pick(parseViberOrder(o2)), {
  pharmacy: 'تسنيم الحياة', area: 'الجامعة', warehouses: ['طريق السلام'],
  items: [{ name: 'Amoklavin 625mg', quantity: 20, bonus: 2 }, { name: 'Pantactive 40mg', quantity: 5, bonus: 1 }],
  notes: ['test order', '+class A لوصفات الدكتور اكرم مقصود اخصائي كسور'], needsAi: false,
});

const o3 = `ماجد حميد - شارع فلسطين

Pantactive 20mg 10
Pantactive 40mg 10+3

مذخر طريق السلام`;
check('ماجد حميد: «مذخر X» في سطر واحد', pick(parseViberOrder(o3)), {
  pharmacy: 'ماجد حميد', area: 'شارع فلسطين', warehouses: ['طريق السلام'],
  items: [{ name: 'Pantactive 20mg', quantity: 10, bonus: 0 }, { name: 'Pantactive 40mg', quantity: 10, bonus: 3 }],
  notes: [], needsAi: false,
});

const o4 = `ص الشفاء
Devit 50
مذخر اوزون`;
check('سطر ملتبس ⇒ needsAi', parseViberOrder(o4).needsAi, true);
check('مذاخر في سطر واحد بفواصل', parseViberOrder('ص الامل\nPandev 40(10)\nمذاخر اوزون/شغف').warehouses, ['اوزون', 'شغف']);

console.log('\n── البصمة والتقسيم ──');
const f1 = orderFingerprint(parseViberOrder(o1));
const f1b = orderFingerprint(parseViberOrder(o1.replace('عن طريق مذاخر', 'مذخر اوزون').replace('@Ahmed Sajad', '')));
check('نفس الطلبية بمذاخر/منشن مختلف ⇒ نفس البصمة', f1 === f1b, true);
check('بصمة مختلفة لطلبية أخرى', f1 === orderFingerprint(parseViberOrder(o2)), false);
check('لصقة فيها 3 طلبيات ⇒ 3 كتل', splitPasteIntoOrders(`${o1}\n\n${o2}\n\n${o3}`).length, 3);
check('لصقة رسالة واحدة بأسطر فارغة ⇒ كتلة واحدة', splitPasteIntoOrders(o3).length, 1);

console.log(failed ? `\n✗ فشل ${failed}` : '\n✓ كلها نجحت');
process.exit(failed ? 1 : 0);
