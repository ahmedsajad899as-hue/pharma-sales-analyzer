// ════════════════════════════════════════════════════════════════════════════
// managerRoster.js — فريق المدير (مندوبوه) مُجمّعين بشركاتهم الرئيسية.
// نفس منطق getManagerSubReps في doctors.controller.js (مصدر «الشركة الرئيسية
// ← المندوب» في تحليل الكولات)، مُستخرَج هنا ليُعاد استخدامه من أي صفحة تحتاج
// نفس الشريطين دون تكرار المنطق أو الانجراف عنه بمرور الوقت (Pharmacy Net مثلاً).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { OFFICE_SCOPED_ROLES } from './officeScope.js';

const MANAGEMENT_ROLES = new Set(['company_manager', 'team_leader', ...OFFICE_SCOPED_ROLES]);

/**
 * @param {{id:number, role:string}} user
 * @param {{includeTeamLead?: boolean}} [opts]
 * @returns {Promise<{
 *   reps: Array<{userId:number, name:string, linkedRepId:number|null, company:{id:number,name:string}|null}>,
 *   companies: Array<{id:number, name:string}>,
 * }>}
 */
export async function getManagerRoster(user, { includeTeamLead = false } = {}) {
  const managerId = user.id;
  let subUsers; // { id, displayName, username, linkedRepId, role }[]

  if (OFFICE_SCOPED_ROLES.has(user.role)) {
    // الأدوار المكتبية تشرف على مكتبها كله دفعة واحدة (officeScope.js يمنحها كل
    // شركات المكتب تلقائياً)، لا على مرؤوسين مُعيَّنين لها شخصياً.
    const myCompanies = await prisma.userCompanyAssignment.findMany({
      where: { userId: managerId },
      select: { companyId: true },
    });
    const companyIds = myCompanies.map(c => c.companyId);
    subUsers = companyIds.length ? await prisma.user.findMany({
      where: {
        isActive: true,
        companyAssignments: { some: { companyId: { in: companyIds } } },
        role: { notIn: [...MANAGEMENT_ROLES] },
      },
      select: { id: true, displayName: true, username: true, linkedRepId: true, role: true },
    }) : [];
  } else {
    const allSubs = await prisma.userManagerAssignment.findMany({
      where: { managerId },
      include: {
        user: { select: { id: true, displayName: true, username: true, linkedRepId: true, role: true } },
      },
      orderBy: { assignedAt: 'asc' },
    });
    subUsers = allSubs
      .map(s => s.user)
      .filter(u => includeTeamLead && u.role === 'team_leader' ? true : !MANAGEMENT_ROLES.has(u.role));
  }

  // «الشركة الرئيسية» لكل عضو فريق — للأدوار المكتبية كلها (تشرف على شركات
  // المكتب دفعة واحدة فتحتاج التجميع)؛ باقي أدوار المدراء مُقيَّدة بشركة واحدة.
  let companyByUserId = new Map();
  if (OFFICE_SCOPED_ROLES.has(user.role) && subUsers.length) {
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { userId: { in: subUsers.map(u => u.id) }, isPrimary: true },
      select: { userId: true, company: { select: { id: true, name: true } } },
    });
    companyByUserId = new Map(assignments.map(a => [a.userId, a.company]));
  }

  const reps = subUsers.map(u => ({
    userId:      u.id,
    name:        u.displayName || u.username,
    linkedRepId: u.linkedRepId,
    company:     companyByUserId.get(u.id) ?? null,
  }));

  const companiesMap = new Map();
  for (const r of reps) if (r.company) companiesMap.set(r.company.id, r.company);
  const companies = [...companiesMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  return { reps, companies };
}
