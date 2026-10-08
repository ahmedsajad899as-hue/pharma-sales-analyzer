// ════════════════════════════════════════════════════════════════════════════
// تجربة برومبت استخراج الطلبيات النصية (قراءة فقط — لا يكتب شيئاً في DB)
// ────────────────────────────────────────────────────────────────────────────
// تشغيل:  node scripts/try-order-prompt.mjs
//         node scripts/try-order-prompt.mjs "طلبية صيدلية النور 5 بانادول"
//
// يُنادي Gemini فعلاً (يستهلك حصة) فهو ليس ضمن اختبارات npm test:*. غرضه ضبط
// البرومبت قبل توصيله بالبوت: الطلبيات الحقيقية يجب أن تُقرأ، و**كل** الدردشات
// يجب أن تُعيد [] — لأن أي دردشة تمرّ تصبح صفاً معلَّقاً يدوياً في طابور المستخدم.
// ════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { extractOrderRowsFromText } from '../server/modules/orders/order-extract.js';

const ORDERS = [
  // صيدلية + منطقة بشرطة، أسعار جزئية، أرقام عادية
  'طلبية صيدلية النور - الكرخ\nزنتاك 20 علبة 9500\nبانادول 5 علبة',
  // أرقام هندية، بلا أسعار، اسم صيدلية بكنية
  'اوردر\nابو احمد / الدورة\n٥ علبة بانادول\n٣ فيتامين سي',
  // بونص بصيغة 10+1، كل شيء في سطر واحد
  'طلبية الهدى الجامعة: دافلون 10+1 ، كونكور 6 علبة',
  // كميات بالكلمات + صنف بلا كمية (يجب أن يظهر بـquantity: null لا أن يُحذف)
  'طلبية صيدلية الشفاء\nاوغمنتين علبتين\nبروفين درزن\nفولتارين جل',
  // أسماء لاتينية داخل عربي + تاريخ نسبي
  'طلبية لصيدلية الرحمة بغداد الجديدة اليوم\nAMOXIL 500MG 10 علبة\nNEXIUM 40MG 4 علبة',
];

const CHATTER = [
  'صباح الخير شباب',
  'شكرا دكتور وصلت الطلبية تمام',
  'رقمي 07701234567 راسلني ضروري',
  'اني بالطريق اوصل بعد ساعة تقريبا',
  'بانادول وزنتاك ودافلون', // أسماء أدوية بلا كميات — ليست طلبية
];

const show = (rows) => rows.map(r =>
  `      ${r.item} | كمية=${r.quantity} | بونص=${r.bonus} | سعر=${r.unitPrice} | صيدلية=${r.pharmacy} | منطقة=${r.area} | مذخر=${r.warehouse} | تاريخ=${r.date}`
).join('\n');

const arg = process.argv.slice(2).join(' ').trim();

if (arg) {
  const rows = await extractOrderRowsFromText(arg);
  console.log(`\n«${arg}»\n  → ${rows.length} صف`);
  if (rows.length) console.log(show(rows));
  process.exit(0);
}

let ordersOk = 0, chatterOk = 0;

console.log('\n══ طلبيات حقيقية (يجب أن تُقرأ) ══');
for (const t of ORDERS) {
  const rows = await extractOrderRowsFromText(t);
  const ok = rows.length > 0;
  if (ok) ordersOk++;
  console.log(`\n${ok ? '✓' : '✗'} «${t.replace(/\n/g, ' ⏎ ').slice(0, 70)}»  → ${rows.length} صف`);
  if (rows.length) console.log(show(rows));
}

console.log('\n══ دردشة (يجب أن تُعيد كلها صفراً) ══');
for (const t of CHATTER) {
  const rows = await extractOrderRowsFromText(t);
  const ok = rows.length === 0;
  if (ok) chatterOk++;
  console.log(`${ok ? '✓' : '✗'} «${t}»  → ${rows.length} صف`);
  if (!ok) console.log(show(rows));
}

console.log(`\nالنتيجة: طلبيات ${ordersOk}/${ORDERS.length} — دردشة ${chatterOk}/${CHATTER.length}`);
process.exit(ordersOk === ORDERS.length && chatterOk === CHATTER.length ? 0 : 1);
