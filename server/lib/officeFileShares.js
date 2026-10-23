import prisma from './prisma.js';

// نفس أهداف autoSyncIfOfficeEmployee (sales.controller.js): ما يرفعه موظف المكتب يُعمَّم
// على هذه الأدوار. تلك تعمل لحظة الرفع فقط — فالحساب الذي يُنشأ بعد الرفع لا يرى الملفات
// القائمة (شكوى «ملف الكوديشن لا يظهر عند مدير المسوقين»: حسابه أحدث من آخر رفعة عليه).
const OFFICE_SYNC_ROLES = ['office_manager', 'office_hr', 'company_manager', 'office_employee', 'product_manager'];

/**
 * حساب جديد بدور مكتبي/مدير شركة: يُشارَك معه كل ما رفعه موظفو مكتبه سابقاً
 * (عدا filter_page — أداة شخصية). مقيّد بنفس المكتب. idempotent.
 * @returns {Promise<number>} عدد المشاركات المنشأة
 */
export async function shareOfficeFilesWithNewUser(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, officeId: true, isActive: true } });
  if (!u?.isActive || u.officeId == null || !OFFICE_SYNC_ROLES.includes(u.role)) return 0;
  const files = await prisma.uploadedFile.findMany({
    where: {
      fileType: { not: 'filter_page' },
      userId: { not: userId },
      user: { role: 'office_employee', officeId: u.officeId },
      fileShares: { none: { userId } },
    },
    select: { id: true },
  });
  if (!files.length) return 0;
  const res = await prisma.fileUserShare.createMany({
    data: files.map(f => ({ fileId: f.id, userId })),
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * ملف الكوديشن (mergeGroup بلاحقة '|condition') يخصّ كل المعنيين في مكتب صاحبه، ونطاق
 * كل مستخدم يبقى يفلتر صفوفه داخل الملف (conditionFile.js). يُشارَك مع من فاتته المشاركة
 * من الأدوار المكتبية ومدراء الشركات في نفس المكتب. idempotent — عند كل إقلاع.
 * @returns {Promise<number>}
 */
export async function backfillConditionFileShares() {
  const files = await prisma.uploadedFile.findMany({
    where: { mergeGroup: { endsWith: '|condition' } },
    select: { id: true, userId: true, user: { select: { officeId: true } }, fileShares: { select: { userId: true } } },
  });
  let created = 0;
  for (const f of files) {
    const officeId = f.user?.officeId;
    if (officeId == null) continue;
    const have = new Set(f.fileShares.map(s => s.userId));
    const targets = await prisma.user.findMany({
      where: { officeId, isActive: true, role: { in: OFFICE_SYNC_ROLES }, id: { not: f.userId } },
      select: { id: true },
    });
    const missing = targets.map(t => t.id).filter(id => !have.has(id));
    if (!missing.length) continue;
    const res = await prisma.fileUserShare.createMany({
      data: missing.map(userId => ({ fileId: f.id, userId })),
      skipDuplicates: true,
    });
    created += res.count;
  }
  return created;
}
