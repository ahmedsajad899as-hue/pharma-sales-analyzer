// ════════════════════════════════════════════════════════════════════════════
// اختبار قراءة طلبيات كروب الفايبر (server/modules/rep-orders/viber-order-parse.js)
// تشغيل:  npm run test:viber-order
//
// الحالات من كروب «مبيعات فارماكتف مذاخر» (سكرين شوت صاحب المشروع 2026-11-13).
// ════════════════════════════════════════════════════════════════════════════

import { parseViberOrder, parseViberItemLine, splitHeaderLine, orderFingerprint, splitPasteIntoOrders, splitWhatsAppMessages } from '../server/modules/rep-orders/viber-order-parse.js';

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


console.log('\n── حالات 2026-11-13 (سكرين شوت الكروب الثاني) ──');
const areaOf = (t) => ({ 'يوسفية': 'اليوسفيه', 'اليوسفية': 'اليوسفيه', 'شهداء البياع': 'شهداء البياع', 'المنصور': 'المنصور' }[t] ?? null);
const q1 = `ص / هدير حمادي سلوم / يوسفية

Potafast (20+2
Potafast (30+3

كل قائمة وحد تجهز


ترانزيت مذخر الضامن

@Ahmed Sajad`;
const r1 = parseViberOrder(q1, { areaOf });
check('«ص» وحدها بين فاصلين ← الصيدلية الجزء التالي', [r1.pharmacy, r1.area, r1.headerSure], ['هدير حمادي سلوم', 'اليوسفيه', true]);
check('«ترانزيت مذخر الضامن» ← المذخر + ملاحظة ترانزيت', [r1.warehouses, r1.notes], [['الضامن'], ['ترانزيت', 'كل قائمة وحد تجهز']]);
check('قوس غير مغلق مع بونص', r1.items, [{ name: 'Potafast', quantity: 20, bonus: 2 }, { name: 'Potafast', quantity: 30, bonus: 3 }]);
check('اللصقة لا تُقطع عند سطر فارغ قبل الملاحظة والمذخر', splitPasteIntoOrders(q1).length, 1);

const q2 = `ص النور / المنصور
Potafast        10+1
🟢م. صلالة، ناقوس
@Ahmed Sajad`;
const r2 = parseViberOrder(q2, { areaOf });
check('«م. صلالة، ناقوس» ← مذخران (والإيموجي يُحذف)', r2.warehouses, ['صلالة', 'الناقوس']);
check('مسافات كثيرة بين الصنف والكمية', r2.items, [{ name: 'Potafast', quantity: 10, bonus: 1 }]);

const r3 = parseViberOrder('ص الياقوت الابيض /شهداء البياع\nPotafast 10+1\nمذخر الناقوس', { areaOf });
check('«ص الياقوت الابيض /شهداء البياع»', [r3.pharmacy, r3.area, r3.warehouses], ['الياقوت الابيض', 'شهداء البياع', ['الناقوس']]);

const known = (t) => t === 'هدير حمادي سلوم';
const r4 = parseViberOrder('اليوسفية - هدير حمادي سلوم\nPotafast 10+1\nاوزون', { areaOf, isKnownPharmacy: known });
check('بلا «ص»: صيدلية معروفة من طلبيات سابقة + منطقة مسجّلة + مذخر بلا كلمة مذخر', [r4.pharmacy, r4.area, r4.headerSure, r4.warehouses], ['هدير حمادي سلوم', 'اليوسفيه', true, ['اوزون']]);

const r5 = parseViberOrder('المنصور\nص. الشفاء\nPandev 40(10)\nتجهز من مذخر اسبرين بسبب عدم التوفر', { areaOf });
check('ترويسة سطرين + «تجهز من مذخر X بسبب…»', [r5.pharmacy, r5.area, r5.warehouses], ['الشفاء', 'المنصور', ['اسبرين']]);
check('«بالمذخر» داخل جملة ليس سطر مذخر', parseViberOrder('ص الامل\nPandev 40(10)\nاذا ما متوفر بالمذخر الاول').warehouses, []);
check('سطر مذاخر معروفة بلا كلمة مذخر: «سنايا، اسبرين»', parseViberOrder('ص الامل\nPandev 40(10)\nسنايا، اسبرين').warehouses, ['سنايا', 'اسبرين']);
check('لصقتان في نص واحد تبقيان طلبيتين', splitPasteIntoOrders(`${q1}\n\n${q2}`).length, 2);

const r6 = parseViberOrder('ص/جبل علي | الواثق\nUricodrop 80mg       20+4\n🟢د.قاسم محمد | Cardio\nPotafast         10+1\n@Zaher');
check('«د.قاسم محمد | Cardio» ملاحظة طبيب لا صنف', [r6.pharmacy, r6.area, r6.items.length, r6.notes, r6.unparsed], ['جبل علي', 'الواثق', 2, ['د.قاسم محمد | Cardio'], []]);


console.log('\n── لصق من واتساب (2026-11-14) ──');
const wa = splitWhatsAppMessages(`[11/13, 4:52 PM] اوردين: صيدلية ماجد حميد - شارع فلسطين
PANTACTIVE 20MG 28TAB 10
PANTACTIVE 40MG 28TAB 10 + 3
[11/13, 8:22 PM] اوردين: صيدلية نور عبدالله الزلزلي - المشتل
Potafast 50 mg 20`);
check('رسالتا واتساب ← طلبيتان بمرسلهما', wa.map(x => x.sender), ['اوردين', 'اوردين']);
const w1 = parseViberOrder(wa[0].text), w2 = parseViberOrder(wa[1].text);
check('الأولى: صيدلية ومنطقة وأصناف', [w1.pharmacy, w1.area, w1.items], ['ماجد حميد', 'شارع فلسطين', [{ name: 'PANTACTIVE 20MG 28TAB', quantity: 10, bonus: 0 }, { name: 'PANTACTIVE 40MG 28TAB', quantity: 10, bonus: 3 }]]);
check('الثانية', [w2.pharmacy, w2.area, w2.items], ['نور عبدالله الزلزلي', 'المشتل', [{ name: 'Potafast 50 mg', quantity: 20, bonus: 0 }]]);
check('صيغة تصدير واتساب «التاريخ - المرسل:»', splitWhatsAppMessages('11/13/26, 4:52 PM - Ali Hassan: ص الامل / المنصور\nPandev 40(10)'), [{ sender: 'Ali Hassan', text: 'ص الامل / المنصور\nPandev 40(10)' }]);
check('نص فايبر بلا ترويسات ← null', splitWhatsAppMessages('ص الامل\nPandev 40(10)'), null);


console.log('\n── الطلبية تبدأ بالأصناف (2026-11-14) ──');
const it1 = parseViberOrder('potafast 10 p\nصيدلية الرتاج\nمذخر الشامل');
check('«صيدلية الرتاج» بعد الصنف ← الصيدلية', [it1.pharmacy, it1.items, it1.warehouses], ['الرتاج', [{ name: 'potafast', quantity: 10, bonus: 0 }], ['الشامل']]);
check('سطر ملاحظة بعد الصنف بلا دليل لا يصير صيدلية', parseViberOrder('Pandev 40(10)\nكل قائمة وحد تجهز').pharmacy, null);

console.log('\n── ملاحظات لاتينية + طلبية جملةً (2026-11-18) ──');
const n1 = parseViberOrder('القادسية/صيدلية المركز الاستشاري\nتم سحب\nAmoklavin 1000mg *10(+2)\nمن قبل مذخر الناقوس الفضي\nReorder\nلوصفات الدكتورة ذرى محمود اخصائية النسائية و التوليد');
check('«Reorder» و«تم سحب» ملاحظات لا أصناف', [n1.pharmacy, n1.area, n1.items, n1.unparsed, n1.warehouses],
  ['المركز الاستشاري', 'القادسية', [{ name: 'Amoklavin 1000mg', quantity: 10, bonus: 2 }], [], ['الناقوس']]);
check('«Test order» سطراً وحده ملاحظة', parseViberOrder('ص / الامنية / الحارثية\nAmoklavin bid 457mg *20(+2)\nTest order').unparsed, []);
const s1 = parseViberOrder('انوار دبي\nتم سحب amoklavine 1g 30 قطعة عن طريق مذخر ادوية ارض البنفسج');
check('«انوار دبي» ثم جملة «تم سحب … قطعة عن طريق مذخر»', [s1.pharmacy, s1.items, s1.warehouses.length > 0, s1.needsAi],
  ['انوار دبي', [{ name: 'amoklavine 1g', quantity: 30, bonus: 0 }], true, false]);
const s2 = parseViberOrder('انوار دبي\namoklavine 1g 30 تم سحب\nقطعة عن طريق مذخر ادوية ارض البنفسج');
check('نفس الرسالة ملتفّة على سطرين', [s2.pharmacy, s2.items, s2.warehouses.length > 0], ['انوار دبي', [{ name: 'amoklavine 1g', quantity: 30, bonus: 0 }], true]);
const s3 = parseViberOrder('تم بيع Amoklavin 1g 10 قطع ل صيدليه سر الدواء من مذخر مصدر الدواء');
check('«تم بيع X 10 قطع ل صيدلية Y من مذخر Z»', [s3.pharmacy, s3.items, s3.warehouses], ['سر الدواء', [{ name: 'Amoklavin 1g', quantity: 10, bonus: 0 }], ['مصدر الدواء']]);
const s4 = parseViberOrder('Amoklavin 1g\n10 قطع ل صيدليه سر الدواء من مذخر مصدر الدواء');
check('الصنف سطر ثم «10 قطع لصيدلية … من مذخر …»', [s4.pharmacy, s4.items, s4.warehouses], ['سر الدواء', [{ name: 'Amoklavin 1g', quantity: 10, bonus: 0 }], ['مصدر الدواء']]);
check('ترويسة «صيدلية الرتاج» تبقى ترويسة', parseViberOrder('صيدلية الرتاج / المنصور\nPandev 40(10)').pharmacy, 'الرتاج');

console.log('\n── المنطقة قبل المذخر في الترويسة (2026-11-19) ──');
{
  const areaOf2 = (t) => ({ 'المنصور': 'المنصور', 'الحارثية': 'الحارثية' })[t] ?? null;
  const isKnownWarehouse = (t) => ['المنصور', 'عادي', 'سنايا'].includes(t);
  const h1 = parseViberOrder('ص/ نور بكه / المنصور\nPotafast 10 + 1\nمذخر عادي', { areaOf: areaOf2, isKnownWarehouse });
  check('«المنصور» بالترويسة منطقة لا مذخر؛ «مذخر عادي» ملاحظة', [h1.pharmacy, h1.area, h1.warehouses, h1.notes], ['نور بكه', 'المنصور', [], ['مذخر عادي']]);
  const h2 = parseViberOrder('ص الامل / الحارثية\nPotafast 10 + 1\nمذخر المنصور', { areaOf: areaOf2, isKnownWarehouse });
  check('سطر «مذخر المنصور» يبقى مذخراً', [h2.area, h2.warehouses], ['الحارثية', ['المنصور']]);
}

console.log('\n── سبب بعد اسم المذخر + منطقة بين قوسين (2026-11-20) ──');
{
  const r1 = parseViberOrder('الحارثية/ص.القرية الطبية\nAmoklavin 625mg *10(+1)\nعن طريق مذخر بلاتين لعدم توفر المادة');
  check('«مذخر بلاتين لعدم توفر المادة» ← المذخر «بلاتين» والسبب ملاحظة',
    [r1.pharmacy, r1.area, r1.warehousesWritten, r1.notes], ['القرية الطبية', 'الحارثية', ['بلاتين'], ['لعدم توفر المادة']]);
  const r2 = parseViberOrder('صيدلية ياسمين ريسان كاظم (مدينة الصدر)\nPotafast 10+1\nمذخر شبر او ابراج الحارثيه او مصدر الدواء');
  check('«صيدلية X (مدينة الصدر)» ← المنطقة ما بين القوسين',
    [r2.pharmacy, r2.area, r2.warehousesWritten], ['ياسمين ريسان كاظم', 'مدينة الصدر', ['شبر', 'ابراج الحارثيه', 'مصدر الدواء']]);
  const areaOf3 = (t) => (t === 'الكرادة' ? 'الكرادة' : null);
  const r3 = parseViberOrder('ص الشفاء (قرب المستشفى) / الكرادة\nPotafast 10+1', { areaOf: areaOf3 });
  check('ما بين القوسين لا يسرق منطقة مكتوبة خارجها', [r3.pharmacy, r3.area, r3.notes], ['الشفاء', 'الكرادة', ['قرب المستشفى']]);
  const r4 = parseViberOrder('ص الشفاء / المنصور\nPotafast 10+1\nعن طريق مذاخر\nاوزون بسبب النقص');
  check('سطر قائمة المذاخر بسبب', [r4.warehousesWritten, r4.notes], [['اوزون'], ['بسبب النقص']]);
}

console.log(failed ? `\n✗ فشل ${failed}` : '\n✓ كلها نجحت');
process.exit(failed ? 1 : 0);
