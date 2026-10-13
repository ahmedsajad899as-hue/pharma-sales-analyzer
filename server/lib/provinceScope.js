// ════════════════════════════════════════════════════════════════════════════
// provinceScope.js — تيم ليدر المحافظة يعمل على كل شركات المكتب.
//
// خلافاً لمدير الشركة (شركة رئيسية + ثانويات)، قائد المحافظة مشترك بين كل
// الشركات ولا يُحسب لواحدة بعينها: تُعيَّن له كل شركات مكتبه **كلها ثانوية**
// (isPrimary=false) — فلا يُنسب لأي تيم شركة في التحليل الشامل، ولا يرث
// «رئيسية» من ensurePrimaryCompanies. أي شركة تُضاف لاحقاً تصله تلقائياً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/** معرّفات من يقود فريق محافظة فعّالاً (اختيارياً ضمن مكتب). */
export async function provinceLeaderIds(officeId = null) {
  const rows = await prisma.provinceTeam.findMany({
    where: { isActive: true, leaderUserId: { not: null }, ...(officeId ? { officeId } : {}) },
    select: { leaderUserId: true },
  });
  return new Set(rows.map(r => r.leaderUserId));
}

export async function isProvinceLeader(userId) {
  return (await prisma.provinceTeam.count({ where: { isActive: true, leaderUserId: userId } })) > 0;
}

/**
 * يستبدل شركات القائد بكل شركات مكتبه، جميعها غير رئيسية.
 * @returns {Promise<number[]>}
 */
export async function syncProvinceLeaderCompanies(userId, officeId) {
  const companies = officeId
    ? await prisma.scientificCompany.findMany({ where: { officeId }, select: { id: true } })
    : [];
  const ids = companies.map(c => c.id);
  await prisma.$transaction([
    prisma.userCompanyAssignment.deleteMany({ where: { userId } }),
    ...(ids.length ? [prisma.userCompanyAssignment.createMany({
      data: ids.map(companyId => ({ userId, companyId, isPrimary: false })),
      skipDuplicates: true,
    })] : []),
  ]);
  return ids;
}

/** شركة جديدة في المكتب ← تصل كل قادة المحافظات فوراً. */
export async function syncProvinceLeadersForOffice(officeId) {
  if (!officeId) return;
  for (const uid of await provinceLeaderIds(officeId)) await syncProvinceLeaderCompanies(uid, officeId);
}
