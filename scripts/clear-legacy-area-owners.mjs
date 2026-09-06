/**
 * clear-legacy-area-owners.mjs — تصفير Area.userId لكل الصفوف المتبقية.
 *
 * الخلفية: المنطقة صارت كتالوج مشترك (راجع findOrCreateArea في
 * server/modules/sales/sales.repository.js) — لا مطابقة ولا إنشاء يعتمد على
 * Area.userId بعد الآن، والتعيين الفعلي لحساب مستخدم يتم عبر UserAreaAssignment
 * فقط. لكن صفوف قديمة أُنشئت قبل هذا التغيير ولم تكن جزءاً من أي مجموعة مكررة
 * (فلم يلمسها scripts/merge-duplicate-areas.mjs) لا تزال تحمل قيمة Area.userId
 * القديمة، فتظهر شارة "👤 اسم المستخدم" في صفحة المناطق رغم أن المنطقة أصلاً
 * صارت قابلة للتعيين لعدة حسابات — وهذا مضلّل، ليس بيانات حقيقية عن الملكية.
 *
 * التصفير آمن تماماً: عمود عرض فقط، بلا أي قيد فريد أو منطق يعتمد عليه (تحقّق
 * شامل عبر الكود قبل كتابة هذا السكربت). لا يمس UserAreaAssignment ولا أي بيانات
 * مبيعات/أطباء.
 *
 * الاستعمال:
 *   node scripts/clear-legacy-area-owners.mjs           # تحليل فقط
 *   node scripts/clear-legacy-area-owners.mjs --apply   # تنفيذ
 */

import prisma from '../server/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const count = await prisma.area.count({ where: { userId: { not: null } } });
  console.log(`مناطق لا تزال بملكية حساب محدد: ${count}`);
  console.log(`الوضع: ${APPLY ? '⚠️ تنفيذ فعلي' : 'تحليل فقط (dry-run)'}`);

  if (!APPLY) {
    console.log('\nلم يُكتب شيء. أعد التشغيل مع --apply للتنفيذ.');
    return;
  }

  const { count: updated } = await prisma.area.updateMany({
    where: { userId: { not: null } },
    data:  { userId: null },
  });
  console.log(`\nتم تصفير الملكية عن ${updated} منطقة.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
