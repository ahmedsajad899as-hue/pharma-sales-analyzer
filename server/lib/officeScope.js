// ════════════════════════════════════════════════════════════════════════════
// officeScope.js — تعيين شركات تلقائي للأدوار المكتبية (office_manager/office_hr/
// office_employee). هذه الأدوار تخدم المكتب كله لا شركة بعينها، فيجب أن تتفاعل
// مع كل بيانات المكتب — بلا اختيار يدوي، وبلا حاجة لتحديثه كل مرة تُضاف شركة جديدة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

export const OFFICE_SCOPED_ROLES = new Set(['office_manager', 'office_hr', 'office_employee']);

export function isOfficeScopedRole(role) {
  return OFFICE_SCOPED_ROLES.has(role);
}

/**
 * يستبدل UserCompanyAssignment الخاص بمستخدم بكل شركات مكتبه الحالية (isPrimary
 * للجميع — نفس اصطلاح مدير المكتب في setUserCompanies: لا فرق بين رئيسية
 * وثانوية لهذه الأدوار، كل شركات المكتب تابعة له بالتساوي).
 * @returns {Promise<number[]>} معرّفات الشركات المُعيَّنة فعلاً
 */
export async function syncOfficeScopedCompanies(userId, officeId) {
  const companies = officeId
    ? await prisma.scientificCompany.findMany({ where: { officeId }, select: { id: true } })
    : [];
  const ids = companies.map(c => c.id);

  await prisma.$transaction([
    prisma.userCompanyAssignment.deleteMany({ where: { userId } }),
    ...(ids.length ? [prisma.userCompanyAssignment.createMany({
      data: ids.map(companyId => ({ userId, companyId, isPrimary: true })),
      skipDuplicates: true,
    })] : []),
  ]);

  return ids;
}

/**
 * عند إنشاء شركة جديدة داخل مكتب: كل مستخدمي المكتب بالأدوار المكتبية يحصلون
 * عليها فوراً بلا انتظار تعديل يدوي.
 */
export async function syncOfficeScopedUsersForOffice(officeId) {
  if (!officeId) return;
  const users = await prisma.user.findMany({
    where: { officeId, role: { in: [...OFFICE_SCOPED_ROLES] } },
    select: { id: true },
  });
  for (const u of users) await syncOfficeScopedCompanies(u.id, officeId);
}
