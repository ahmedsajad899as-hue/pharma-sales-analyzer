/**
 * reset-office-visits.mjs — تصفير كل زيارات الأطباء والصيدليات لحسابات مكتب علمي
 * معيّن (officeId) دفعة واحدة، تمهيداً لبدء الاستيراد من إكسل من جديد ببيانات نظيفة.
 *
 * الخلفية: طلب المستخدم مسح كل زيارات "مكتب النسق العلمي" لأن البيانات الحالية
 * غير صحيحة، على أن يبدأ الاعتماد بالكامل على ملفات إكسل تُرفع من جديد. هذا حذف
 * نهائي (hard delete) — لا تراجع عنه.
 *
 * النطاق: كل User بحقل officeId = المكتب المطلوب (كل من مدير الشركة إلى المندوب
 * الفرد — officeId يُضبط مباشرة عند إنشاء أي حساب تحت هذا المكتب، راجع
 * admin-users.controller.js createUser). يُحذف:
 *   - VisitImportFile حيث userId أو ownerUserId ضمن هذه الحسابات (يسحب معه تلقائياً
 *     DoctorVisit/PharmacyVisit المرتبطة بـ onDelete:Cascade، وهذه بدورها تسحب
 *     VisitLike/VisitComment/PharmacyVisitLike/PharmacyVisitItem).
 *   - أي DoctorVisit/PharmacyVisit متبقٍّ بلا ملف استيراد (زيارة أُدخلت يدوياً من
 *     التطبيق) وuserId ضمن نفس الحسابات.
 *
 * لا يمس: Doctor / MasterSurveyDoctor / Pharmacy / Area / DoctorArchiveEntry
 * (تأشيرات "زايرته/يكتبوله" اليدوية في تبويب الأرشيف — جدول مستقل، خارج نطاق هذا
 * التصفير عمداً؛ يُذكر عدده فقط للعلم).
 *
 * الاستعمال:
 *   node scripts/reset-office-visits.mjs --office="مكتب النسق العلمي"   # تحليل فقط
 *   node scripts/reset-office-visits.mjs --office="مكتب النسق العلمي" --apply
 */

import prisma from '../server/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const officeArg = process.argv.find(a => a.startsWith('--office='));
const officeName = officeArg ? officeArg.slice('--office='.length) : null;

async function main() {
  if (!officeName) {
    console.log('استعمال: node scripts/reset-office-visits.mjs --office="اسم المكتب" [--apply]');
    const offices = await prisma.scientificOffice.findMany({ select: { id: true, name: true } });
    console.log('\nالمكاتب المتاحة:');
    for (const o of offices) console.log(`  #${o.id} — ${o.name}`);
    return;
  }

  const office = await prisma.scientificOffice.findFirst({ where: { name: officeName } });
  if (!office) {
    console.log(`لا يوجد مكتب باسم "${officeName}" بالضبط. المكاتب المتاحة:`);
    const offices = await prisma.scientificOffice.findMany({ select: { id: true, name: true } });
    for (const o of offices) console.log(`  #${o.id} — ${o.name}`);
    return;
  }

  const users = await prisma.user.findMany({
    where: { officeId: office.id },
    select: { id: true, username: true, displayName: true, role: true },
  });
  const userIds = users.map(u => u.id);

  console.log(`المكتب: ${office.name} (#${office.id})`);
  console.log(`عدد الحسابات تحته: ${users.length}`);
  for (const u of users) console.log(`  #${u.id} ${u.username} (${u.displayName ?? '-'}) — ${u.role}`);

  if (!userIds.length) {
    console.log('\nلا توجد حسابات تحت هذا المكتب — لا شيء ليُحذف.');
    return;
  }

  const importFiles = await prisma.visitImportFile.findMany({
    where: { OR: [{ userId: { in: userIds } }, { ownerUserId: { in: userIds } }] },
    select: { id: true },
  });
  const importFileIds = importFiles.map(f => f.id);

  const [doctorVisitCount, pharmacyVisitCount, archiveEntryCount] = await Promise.all([
    prisma.doctorVisit.count({ where: { userId: { in: userIds } } }),
    prisma.pharmacyVisit.count({ where: { userId: { in: userIds } } }),
    prisma.doctorArchiveEntry.count({ where: { userId: { in: userIds } } }),
  ]);

  console.log(`\nزيارات أطباء (DoctorVisit) لهذه الحسابات: ${doctorVisitCount}`);
  console.log(`زيارات صيدليات (PharmacyVisit) لهذه الحسابات: ${pharmacyVisitCount}`);
  console.log(`ملفات استيراد زيارات مرتبطة: ${importFileIds.length}`);
  console.log(`(للعلم فقط — لن يُمس) تأشيرات أرشيف الأطباء (DoctorArchiveEntry): ${archiveEntryCount}`);

  console.log(`\nالوضع: ${APPLY ? '⚠️ تنفيذ فعلي — حذف نهائي' : 'تحليل فقط (dry-run)'}`);
  if (!APPLY) {
    console.log('\nلم يُحذف شيء. أعد التشغيل بنفس --office مع --apply للتنفيذ الفعلي.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (importFileIds.length) {
      await tx.visitImportFile.deleteMany({ where: { id: { in: importFileIds } } });
    }
    await tx.doctorVisit.deleteMany({ where: { userId: { in: userIds } } });
    await tx.pharmacyVisit.deleteMany({ where: { userId: { in: userIds } } });
  });

  const [remainingDoctorVisits, remainingPharmacyVisits] = await Promise.all([
    prisma.doctorVisit.count({ where: { userId: { in: userIds } } }),
    prisma.pharmacyVisit.count({ where: { userId: { in: userIds } } }),
  ]);
  console.log(`\nتم الحذف. المتبقي — أطباء: ${remainingDoctorVisits}, صيدليات: ${remainingPharmacyVisits}`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
