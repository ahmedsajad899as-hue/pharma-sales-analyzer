// ════════════════════════════════════════════════════════════════════════════
// provinceSeats.js — مقاعد فريق المحافظة: تيم ليدر + مقعد مندوب لكل مدير شركة.
//
// الشركات والايتمات تؤخذ من مدراء الشركات. مدير المسوقين خارج المقاعد: المسوقون
// قسم مستقل له فرقه (راجع pharmacyRep.js).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { PHARMACY_KIND } from './pharmacyRep.js';

/**
 * مدراء الشركات النشطون كمقاعد، مرتبين باسم الشركة.
 * @param {number[]|null} officeIds
 * @returns {Promise<Array<{userId:number, name:string, officeId:number, companyId:number,
 *   companyName:string, companyIds:number[], items:{id:number, companyId:number|null}[]}>>}
 */
export async function loadSeatManagers(officeIds = null) {
  const rows = await prisma.user.findMany({
    where: { role: 'company_manager', isActive: true, officeId: officeIds ? { in: officeIds } : { not: null } },
    select: {
      id: true, displayName: true, username: true, officeId: true,
      linkedRep: { select: { repKind: true } },
      companyAssignments: { select: { companyId: true, isPrimary: true, company: { select: { id: true, name: true } } } },
      itemAssignments: { select: { itemId: true, item: { select: { scientificCompanyId: true, scientificCompany: { select: { officeId: true } } } } } },
    },
  });
  const seats = [];
  for (const m of rows) {
    if (m.linkedRep?.repKind === PHARMACY_KIND) continue;
    const primary = m.companyAssignments.find(c => c.isPrimary) ?? m.companyAssignments[0];
    if (!primary) continue;
    seats.push({
      userId: m.id,
      name: m.displayName || m.username,
      officeId: m.officeId,
      companyId: primary.companyId,
      companyName: primary.company.name,
      companyIds: m.companyAssignments.map(c => c.companyId),
      items: m.itemAssignments.map(a => ({
        id: a.itemId,
        companyId: a.item.scientificCompany?.officeId === m.officeId ? a.item.scientificCompanyId : null,
      })),
    });
  }
  return seats.sort((a, b) => a.companyName.localeCompare(b.companyName));
}

/**
 * نطاق تيم ليدر المحافظة: كل شركات وايتمات كل المدراء. مدير بلا ايتمات مسندة يعني كل
 * ايتمات شركته، فتُوسَّع صراحةً: القائمة غير الفارغة قائمة بيضاء وإلا سقطت شركته كلها.
 * @returns {Promise<{companyIds:number[], itemIds:number[]}>}
 */
export async function leaderScopeFromManagers(seats) {
  const companyIds = new Set(seats.flatMap(s => s.companyIds));
  const itemIds = new Set();
  for (const s of seats) {
    for (const i of s.items) {
      itemIds.add(i.id);
      if (i.companyId != null) companyIds.add(i.companyId);
    }
  }
  const whole = seats.filter(s => !s.items.length).map(s => s.companyId);
  if (whole.length) {
    const catalog = await prisma.item.findMany({
      where: { scientificCompanyId: { in: whole }, isTemp: false }, select: { id: true },
    });
    for (const i of catalog) itemIds.add(i.id);
  }
  return { companyIds: [...companyIds], itemIds: [...itemIds] };
}
