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

/**
 * كل من ينتمي لفريق محافظة فعّال (تيم ليدر أو مندوب) — تُعلِّم به الواجهة
 * `isProvinceMember` فتفصل مندوبي المحافظات عن مندوبي بغداد في قوائم الاختيار.
 * @returns {Promise<Set<number>>} معرّفات users
 */
export async function provinceMemberUserIds() {
  const [teams, assign] = await Promise.all([
    prisma.provinceTeam.findMany({ where: { isActive: true, leaderUserId: { not: null } }, select: { leaderUserId: true } }),
    prisma.provinceRepAssignment.findMany({ where: { isActive: true, team: { isActive: true } }, select: { repUserId: true } }),
  ]);
  return new Set([...teams.map(t => t.leaderUserId), ...assign.map(r => r.repUserId)]);
}

export async function isProvinceLeader(userId) {
  return (await prisma.provinceTeam.count({ where: { isActive: true, leaderUserId: userId } })) > 0;
}

/**
 * قائد محافظة جديد (بلا أي شركات) يُمنح كل شركات مكتبه كنقطة بداية، جميعها غير
 * رئيسية؛ أما من له تعيينات فلا تُمسّ — الشركات تُعدَّل يدوياً حسب التعيين
 * (ليس شرطاً كل الشركات).
 * @returns {Promise<number[]>}
 */
export async function syncProvinceLeaderCompanies(userId, officeId) {
  const existing = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
  if (existing.length) return existing.map(a => a.companyId);
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

/** شركة جديدة في المكتب: لم تعد تصل قادة المحافظات تلقائياً (التعيين يدوي). */
export async function syncProvinceLeadersForOffice(_officeId) {
  // مقصود: لا شيء. يبقى الاستيراد قائماً لأن companies.controller يستدعيه.
}
