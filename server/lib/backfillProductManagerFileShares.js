import prisma from './prisma.js';

/**
 * يشارك ملفات موظفي المكتب القديمة مع مديري المنتج في نفس المكتب (autoSync
 * لم يكن يشملهم). idempotent: skipDuplicates على (fileId, userId) فتشغيله عند
 * كل إقلاع بلا أثر بعد أول مرة. يستثني filter_page كما في autoSyncIfOfficeEmployee.
 * @returns {Promise<number>} عدد المشاركات المنشأة
 */
export async function backfillProductManagerFileShares() {
  const pms = await prisma.user.findMany({
    where: { role: 'product_manager', isActive: true, officeId: { not: null } },
    select: { id: true, officeId: true },
  });
  let created = 0;
  for (const pm of pms) {
    const files = await prisma.uploadedFile.findMany({
      where: {
        fileType: { not: 'filter_page' },
        user: { role: 'office_employee', officeId: pm.officeId },
        fileShares: { none: { userId: pm.id } },
      },
      select: { id: true },
    });
    if (!files.length) continue;
    const res = await prisma.fileUserShare.createMany({
      data: files.map(f => ({ fileId: f.id, userId: pm.id })),
      skipDuplicates: true,
    });
    created += res.count;
  }
  return created;
}
