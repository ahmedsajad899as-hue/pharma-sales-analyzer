// ════════════════════════════════════════════════════════════════════════════
// itemOwnerManager.js — «مدير الشركة صاحب الايتم» داخل مكتب واحد.
//
// نفس قاعدة loadOfficeTeams في reports.routes.js (التحليل الشامل) حرفياً كي لا
// يختلف «صاحب الايتم» بين التقرير وتحويل طلبيات البوت:
//   • المالك = مدير شركة (company_manager) في نفس المكتب أُسنِد له الايتم عبر
//     «الايتمات» في السوبر أدمن (UserItemAssignment).
//   • ايتم مُسنَد لأكثر من مدير: يفوز من شركةُ الايتم العلمية شركتُه الرئيسية
//     (isPrimary)، وإلا أصغر id — قرار ثابت لا يتبدّل بالترتيب.
//   • ايتم غير مُسنَد لأي مدير لا مالك له.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/**
 * @param {number|null} officeId
 * @returns {Promise<Map<number, {managerId:number, managerName:string, companyName:string|null}>>}
 *          itemId → المدير المالك
 */
export async function loadItemOwnerManagers(officeId) {
  const out = new Map();
  if (officeId == null) return out;

  const managers = await prisma.user.findMany({
    where: { officeId, role: 'company_manager', isActive: true },
    select: { id: true, displayName: true, username: true },
    orderBy: { id: 'asc' },
  });
  if (!managers.length) return out;
  const managerIds = managers.map(m => m.id);

  const [assignments, itemAssignments] = await Promise.all([
    prisma.userCompanyAssignment.findMany({
      where: { userId: { in: managerIds } },
      select: { userId: true, isPrimary: true, company: { select: { id: true, name: true } } },
    }),
    prisma.userItemAssignment.findMany({
      where: { userId: { in: managerIds } },
      select: { userId: true, item: { select: { id: true, scientificCompanyId: true } } },
    }),
  ]);

  const ownerByCompany = new Map();
  const primaryName = new Map();
  for (const a of assignments) {
    const prev = ownerByCompany.get(a.company.id);
    if (prev == null || (a.isPrimary && prev !== a.userId)) ownerByCompany.set(a.company.id, a.userId);
    if (a.isPrimary || !primaryName.has(a.userId)) primaryName.set(a.userId, a.company.name);
  }

  const claimsByItem = new Map();
  for (const a of itemAssignments) {
    if (!claimsByItem.has(a.item.id)) claimsByItem.set(a.item.id, []);
    claimsByItem.get(a.item.id).push(a);
  }
  const managerById = new Map(managers.map(m => [m.id, m]));
  for (const [itemId, claims] of claimsByItem) {
    const ordered = [...claims].sort((x, y) => x.userId - y.userId);
    const companyOwnerId = ownerByCompany.get(ordered[0].item.scientificCompanyId);
    const owner = ordered.find(r => r.userId === companyOwnerId) ?? ordered[0];
    const m = managerById.get(owner.userId);
    out.set(itemId, {
      managerId: owner.userId,
      managerName: m?.displayName?.trim() || m?.username || `#${owner.userId}`,
      companyName: primaryName.get(owner.userId) ?? null,
    });
  }
  return out;
}

