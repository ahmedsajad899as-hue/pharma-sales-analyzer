/**
 * reset-user-item-assignments.mjs
 * تصفير جميع تعييات الايتمات للمستخدمين (UserItemAssignment) لمرة واحدة.
 *
 * السبب (قرار المستخدم "صفّرها ثم انشر"): تغيّر معنى تبويب «الايتمات» في صفحة المستخدم
 * من «إضافي» (يعرض كل الايتمات العامة، والاختيار يُضيف) إلى «فلتر» على كتالوج الشركة
 * (بلا اختيار = كل ايتمات الشركة). أي تعييات قديمة كانت تحمل المعنى الإضافي، ولو بقيت
 * ستُعامل الآن كفلتر وقد تُخفي ايتمات عن المستخدم. التصفير يعيد الجميع إلى «بلا اختيار =
 * الكل» (لا يفقد أحد رؤية أي ايتم)، ثم يعيد المشرف الاختيار بالمعنى الجديد عمداً.
 *
 * غير هدّام على الرؤية (التصفير يوسّع ما يراه المستخدم، لا يقلّصه) وقابل لإعادة التشغيل.
 *
 * التشغيل على الخادم بعد النشر:
 *   node scripts/reset-user-item-assignments.mjs            # تشغيل فعلي
 *   node scripts/reset-user-item-assignments.mjs --dry-run  # عرض العدد فقط بلا حذف
 */

import prisma from '../server/lib/prisma.js';

const DRY = process.argv.includes('--dry-run');

async function main() {
  const total = await prisma.userItemAssignment.count();
  const users = (await prisma.userItemAssignment.findMany({
    select: { userId: true }, distinct: ['userId'],
  })).length;
  console.log(`reset-user-item-assignments ${DRY ? '(DRY-RUN)' : ''}`);
  console.log(`تعييات موجودة: ${total} صف · لدى ${users} مستخدم`);

  if (DRY) { console.log('DRY-RUN — لم يُحذف شيء.'); return; }
  if (total === 0) { console.log('لا توجد تعييات — لا شيء لتصفيره.'); return; }

  const del = await prisma.userItemAssignment.deleteMany({});
  console.log(`تم التصفير: حُذف ${del.count} صف. الجميع الآن «بلا اختيار = كل ايتمات الشركة».`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
