import prisma from './prisma.js';

/**
 * يضمن أن لكل مستخدم لديه تعيينات شركات، شركةً رئيسية واحدة (isPrimary=true).
 * القاعدة: أقدم تعيين (assignedAt الأصغر، ثم companyId الأصغر) يصبح رئيسياً.
 * idempotent + رخيص: بعد أول تشغيل يصبح استعلاماً واحداً بلا كتابة.
 * يُستدعى عند إقلاع الخادم لمعالجة البيانات القديمة قبل إضافة عمود isPrimary.
 * @returns {Promise<number>} عدد المستخدمين الذين عُيّنت لهم رئيسية في هذا التشغيل
 */
export async function ensurePrimaryCompanies() {
  const all = await prisma.userCompanyAssignment.findMany({
    select: { userId: true, companyId: true, isPrimary: true, assignedAt: true },
  });

  const byUser = new Map();
  for (const a of all) {
    if (!byUser.has(a.userId)) byUser.set(a.userId, []);
    byUser.get(a.userId).push(a);
  }

  let fixed = 0;
  for (const [userId, rows] of byUser) {
    if (rows.some(r => r.isPrimary)) continue; // لديه رئيسية أصلاً
    rows.sort((x, y) =>
      (x.assignedAt?.getTime?.() ?? 0) - (y.assignedAt?.getTime?.() ?? 0) || x.companyId - y.companyId
    );
    const primary = rows[0];
    await prisma.userCompanyAssignment.update({
      where: { userId_companyId: { userId, companyId: primary.companyId } },
      data: { isPrimary: true },
    });
    fixed++;
  }
  return fixed;
}
