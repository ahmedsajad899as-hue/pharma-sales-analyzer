// ════════════════════════════════════════════════════════════════════════════
// provinceScope.js — تيم ليدر المحافظة يعمل على كل شركات المكتب.
//
// خلافاً لمدير الشركة (شركة رئيسية + ثانويات)، قائد المحافظة مشترك بين كل
// الشركات ولا يُحسب لواحدة بعينها: تُعيَّن له كل شركات مكتبه **كلها ثانوية**
// (isPrimary=false) — فلا يُنسب لأي تيم شركة في التحليل الشامل، ولا يرث
// «رئيسية» من ensurePrimaryCompanies. أي شركة تُضاف لاحقاً تصله تلقائياً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { PHARMACY_KIND, BAGHDAD_PROVINCE } from './pharmacyRep.js';

/**
 * مسوق محافظة: فارمسي مُسند إلى محافظة غير بغداد. هذا الإسناد هو انتماؤه كله، وفرق
 * المحافظات (ProvinceTeam / ProvinceRepAssignment) للعلميين فقط ولا تربطه بها شيء.
 */
export const PROVINCE_MARKETER_WHERE = {
  role: { in: ['scientific_rep', 'team_leader'] },
  linkedRep: { is: { repKind: PHARMACY_KIND } },
  provinceAssignments: { some: { province: { name: { not: BAGHDAD_PROVINCE } } } },
};

/** معرّفات من يقود فريق محافظة فعّالاً (اختيارياً ضمن مكتب). */
export async function provinceLeaderIds(officeId = null) {
  const rows = await prisma.provinceTeam.findMany({
    where: { isActive: true, leaderUserId: { not: null }, ...(officeId ? { officeId } : {}) },
    select: { leaderUserId: true },
  });
  return new Set(rows.map(r => r.leaderUserId));
}

/**
 * كل من ينتمي لفريق محافظة فعّال (تيم ليدر أو مندوب) ومسوقو المحافظات — تُعلِّم به الواجهة
 * `isProvinceMember` فتفصل مندوبي المحافظات عن مندوبي بغداد في قوائم الاختيار.
 * @returns {Promise<Set<number>>} معرّفات users
 */
export async function provinceMemberUserIds() {
  const [teams, assign, marketers] = await Promise.all([
    prisma.provinceTeam.findMany({ where: { isActive: true, leaderUserId: { not: null } }, select: { leaderUserId: true } }),
    prisma.provinceRepAssignment.findMany({ where: { isActive: true, team: { isActive: true } }, select: { repUserId: true } }),
    prisma.user.findMany({ where: PROVINCE_MARKETER_WHERE, select: { id: true } }),
  ]);
  return new Set([...teams.map(t => t.leaderUserId), ...assign.map(r => r.repUserId), ...marketers.map(m => m.id)]);
}

/**
 * محافظات كل عضو في فرق المحافظات ومسوقيها (بلا بغداد).
 * @returns {Promise<Map<number, Set<number>>>} userId → معرّفات المحافظات
 */
export async function provinceIdsByMember() {
  const notBaghdad = { name: { not: BAGHDAD_PROVINCE } };
  const [teams, assign, marketers] = await Promise.all([
    prisma.provinceTeam.findMany({
      where: { isActive: true, leaderUserId: { not: null }, province: notBaghdad },
      select: { leaderUserId: true, provinceId: true },
    }),
    prisma.provinceRepAssignment.findMany({
      where: { isActive: true, team: { isActive: true, province: notBaghdad } },
      select: { repUserId: true, team: { select: { provinceId: true } } },
    }),
    prisma.user.findMany({
      where: PROVINCE_MARKETER_WHERE,
      select: { id: true, provinceAssignments: { where: { province: notBaghdad }, select: { provinceId: true } } },
    }),
  ]);
  const out = new Map();
  const add = (userId, provinceId) => {
    if (!out.has(userId)) out.set(userId, new Set());
    out.get(userId).add(provinceId);
  };
  for (const t of teams) add(t.leaderUserId, t.provinceId);
  for (const a of assign) add(a.repUserId, a.team.provinceId);
  for (const m of marketers) for (const p of m.provinceAssignments) add(m.id, p.provinceId);
  return out;
}

/**
 * كل مناطق محافظات هؤلاء المستخدمين. سيرفي المحافظة يُبنى من الزيارات، فمندوبها لا
 * يملك قائمة مناطق محدَّدة مسبقاً؛ يُوسَّع هذا وقت قراءة الكولات فقط لا في
 * UserAreaAssignment كي لا يتغيّر نطاق مبيعاته في التقارير.
 * @returns {Promise<Map<number, number[]>>} userId → معرّفات المناطق
 */
export async function provinceAreaIdsByUser(userIds) {
  const out = new Map();
  if (!userIds?.length) return out;
  const members = await provinceIdsByMember();
  const wanted = userIds.filter(id => members.has(id));
  if (!wanted.length) return out;
  const provinceIds = [...new Set(wanted.flatMap(id => [...members.get(id)]))];
  const areas = await prisma.area.findMany({ where: { provinceId: { in: provinceIds } }, select: { id: true, provinceId: true } });
  for (const id of wanted) {
    const own = members.get(id);
    out.set(id, areas.filter(a => own.has(a.provinceId)).map(a => a.id));
  }
  return out;
}

/**
 * هل لمدير الشركة تابعون غير مندوبي المحافظات؟ مدير بلا تابعين يرجع لـ«كل مندوبي شركته»؛
 * ومندوب مقعد محافظة صار يتبعه لا يجوز أن يُسقط هذا الرجوع فيختفي مندوبو بغداد.
 * @param {{userId:number}[]} subordinateRows
 */
export async function hasNonProvinceSubordinates(subordinateRows) {
  if (!subordinateRows.length) return false;
  const members = await provinceMemberUserIds();
  return subordinateRows.some(r => !members.has(r.userId));
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
