import prisma from './prisma.js';

/**
 * يعمّم ملفات "Stock" (SalesDataFile) القديمة التي رفعها موظف مكتب قبل أن
 * يشمل autoSync في POST /api/sales-data-files زملاءه (موظفي المكتب الآخرين)
 * لا مدير المكتب/الشركة فقط. idempotent: يتحقق من وجود نسخة (syncedFromFileId)
 * لكل هدف قبل الإنشاء، فتشغيله عند كل إقلاع بعد أول مرة يصبح بلا كتابة.
 * يُستدعى عند إقلاع الخادم لمعالجة البيانات القديمة، تماماً مثل ensurePrimaryCompanies.
 * @returns {Promise<number>} عدد النسخ التي أُنشئت في هذا التشغيل
 */
export async function backfillSalesDataFileOfficeSync() {
  const originals = await prisma.salesDataFile.findMany({
    where: { syncedFromFileId: null },
    select: {
      id: true, userId: true, name: true, uploadedAt: true,
      fixedCols: true, areaCols: true, rows: true, regions: true, sourceFileIds: true,
    },
  });
  if (!originals.length) return 0;

  const uploaderIds = [...new Set(originals.map(o => o.userId))];
  const uploaders = await prisma.user.findMany({
    where: { id: { in: uploaderIds }, role: 'office_employee' },
    select: { id: true, officeId: true },
  });
  const officeByUploader = new Map(uploaders.map(u => [u.id, u.officeId]));

  let created = 0;
  for (const { id: originalId, userId: uploaderId, ...fileData } of originals) {
    const officeId = officeByUploader.get(uploaderId);
    if (!officeId) continue; // ليس موظف مكتب، أو بلا مكتب — لا أهداف (يطابق منطق الرفع الحي)

    const targets = await prisma.user.findMany({
      where: {
        isActive: true,
        id: { not: uploaderId },
        role: { in: ['office_manager', 'office_hr', 'company_manager', 'office_employee'] },
        officeId,
      },
      select: { id: true },
    });
    if (!targets.length) continue;

    const existingCopies = await prisma.salesDataFile.findMany({
      where: { syncedFromFileId: originalId, userId: { in: targets.map(t => t.id) } },
      select: { userId: true },
    });
    const covered = new Set(existingCopies.map(c => c.userId));

    for (const target of targets) {
      if (covered.has(target.id)) continue;
      await prisma.salesDataFile.create({ data: { userId: target.id, ...fileData, syncedFromFileId: originalId } })
        .then(() => { created++; })
        .catch(err => console.error('[backfillSalesDataFileOfficeSync]', target.id, err.message));
    }
  }
  return created;
}
