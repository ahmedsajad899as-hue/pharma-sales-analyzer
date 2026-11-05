// ════════════════════════════════════════════════════════════════════════════
// provinceSeats.js — مقاعد فريق المحافظة: تيم ليدر + مقعد مندوب لكل مدير شركة.
//
// الشركات والايتمات تؤخذ من مدراء الشركات. مدير المسوقين خارج المقاعد: المسوقون
// قسم مستقل له فرقه (راجع pharmacyRep.js).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { PHARMACY_KIND, managesProvinceMarketers } from './pharmacyRep.js';
import { resolveEffectiveItemIds } from './itemScope.js';
import { ownerSeatOfItem, repBelongsToSeat, repSeatIds } from '../modules/province-teams/province-teams.rules.js';

/**
 * مدراء الشركات النشطون كمقاعد، مرتبين باسم الشركة.
 * @param {number[]|null} officeIds
 * @param {number[]|null} userIds
 * @returns {Promise<Array<{userId:number, name:string, officeId:number, companyId:number,
 *   companyName:string, companyIds:number[], items:{id:number, companyId:number|null}[]}>>}
 */
export async function loadSeatManagers(officeIds = null, userIds = null) {
  const rows = await prisma.user.findMany({
    where: {
      role: 'company_manager', isActive: true, officeId: officeIds ? { in: officeIds } : { not: null },
      ...(userIds ? { id: { in: userIds } } : {}),
    },
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
 * مدراء المسوقين النشطون: منهم يأخذ مسوق المحافظة الجديد شركاته وايتماته.
 * handlesProvinces يميّز مدير مسوقي المحافظات عن مدير مسوقي بغداد.
 * @param {number[]} officeIds
 */
export async function loadMarketerManagers(officeIds = null) {
  const rows = await prisma.user.findMany({
    where: {
      role: 'company_manager', isActive: true, officeId: officeIds ? { in: officeIds } : { not: null },
      linkedRep: { is: { repKind: PHARMACY_KIND } },
    },
    select: {
      id: true, displayName: true, username: true, officeId: true,
      companyAssignments: { select: { companyId: true } },
      itemAssignments: { select: { itemId: true } },
      provinceAssignments: { select: { province: { select: { name: true } } } },
    },
    orderBy: { id: 'asc' },
  });
  return rows.map(m => ({
    userId: m.id,
    name: m.displayName || m.username,
    officeId: m.officeId,
    companyIds: m.companyAssignments.map(c => c.companyId),
    itemIds: m.itemAssignments.map(i => i.itemId),
    handlesProvinces: managesProvinceMarketers(m.provinceAssignments.map(p => p.province.name)),
  }));
}

/** مقعد المُشاهِد إن كان مدير شركة؛ null لغيره (ومنهم مدير المسوقين): لا تقييد عليهم هنا. */
export async function loadManagerSeat(viewerId) {
  if (!viewerId) return null;
  const [seat] = await loadSeatManagers(null, [viewerId]);
  return seat ?? null;
}

async function activeAssignmentsOf(userIds) {
  const rows = userIds.length
    ? await prisma.provinceRepAssignment.findMany({
        where: { repUserId: { in: userIds }, isActive: true, team: { isActive: true } },
        select: { repUserId: true, companyId: true, allItems: true, items: { select: { itemId: true } } },
      })
    : [];
  return rows.map(r => ({ repUserId: r.repUserId, companyId: r.companyId, allItems: r.allItems, itemIds: r.items.map(i => i.itemId) }));
}

/**
 * من repIds (ScientificRepresentative) ما يخص فريق هذا المدير في عرض المحافظات.
 * المسوقون بلا شركة رئيسية وليسوا مقاعد شركات، فيبقون كما هم. ومندوب بلا حساب يبقى كذلك.
 */
export async function repIdsInManagerTeam(seat, repIds) {
  const [users, marketers, officeSeats] = await Promise.all([
    prisma.user.findMany({
      where: { linkedRepId: { in: repIds } },
      select: {
        id: true, linkedRepId: true,
        managersOfUser: { select: { managerId: true } },
        companyAssignments: { where: { isPrimary: true }, select: { companyId: true } },
      },
    }),
    prisma.scientificRepresentative.findMany({ where: { id: { in: repIds }, repKind: PHARMACY_KIND }, select: { id: true } }),
    loadSeatManagers([seat.officeId]),
  ]);
  const marketerIds = new Set(marketers.map(m => m.id));
  const assignments = await activeAssignmentsOf(users.map(u => u.id));
  return repIds.filter(repId => {
    const own = users.filter(u => u.linkedRepId === repId);
    if (!own.length || marketerIds.has(repId)) return true;
    return own.some(u => {
      const managerIds = u.managersOfUser.map(m => m.managerId);
      return repBelongsToSeat({
        assignments: assignments.filter(a => a.repUserId === u.id),
        isSubordinate: managerIds.includes(seat.userId),
        primaryCompanyId: u.companyAssignments[0]?.companyId ?? null,
        managerIds,
      }, seat, officeSeats);
    });
  });
}

/** ايتمات المقعد: المسندة لمديره، أو كل شركته الرئيسية إن لم يُسنَد له شيء. */
export async function seatItemsWithCatalog(seat) {
  if (seat.items.length) return seat.items;
  const rows = await prisma.item.findMany({
    where: { scientificCompanyId: seat.companyId, isTemp: false },
    select: { id: true },
  });
  return rows.map(r => ({ id: r.id, companyId: seat.companyId }));
}

/**
 * المندوبون المشتركون التابعون لهذا المدير، ولكلٍّ الايتمات التي يملكها هذا المدير بين مقاعده.
 * الايتم المسند لمديريه معاً يظهر عند مالكه فقط، فلا يتكرر مبيعه عند الاثنين.
 * غير المشترك لا يرد هنا: مدير الشركة يرى مندوبه الخاص كما كان.
 * @param {number} viewerId
 * @returns {Promise<{byUser:Map<number,Set<number>>, byRep:Map<number,Set<number>>}>}
 */
export async function loadSharedRepScopes(viewerId) {
  const empty = { byUser: new Map(), byRep: new Map() };
  const seat = await loadManagerSeat(viewerId);
  if (!seat) return empty;
  const rows = await prisma.provinceRepAssignment.findMany({
    where: { isActive: true, team: { isActive: true, officeId: seat.officeId }, rep: { managersOfUser: { some: { managerId: viewerId } } } },
    select: {
      repUserId: true, companyId: true, allItems: true,
      items: { select: { itemId: true } },
      rep: { select: { linkedRepId: true, managersOfUser: { select: { managerId: true } } } },
    },
  });
  if (!rows.length) return empty;

  const officeSeats = await loadSeatManagers([seat.officeId]);
  const mine = await seatItemsWithCatalog(seat);
  const out = { byUser: new Map(), byRep: new Map() };
  for (const repUserId of new Set(rows.map(r => r.repUserId))) {
    const own = rows.filter(r => r.repUserId === repUserId);
    const seatIds = repSeatIds(
      own.map(r => ({ companyId: r.companyId, allItems: r.allItems, itemIds: r.items.map(i => i.itemId) })),
      own[0].rep.managersOfUser.map(m => m.managerId),
      officeSeats,
    );
    if (seatIds.length < 2 || !seatIds.includes(viewerId)) continue;
    const repSeats = officeSeats.filter(s => seatIds.includes(s.userId));
    const allowed = new Set(mine.filter(i => ownerSeatOfItem(i.id, i.companyId, repSeats) === viewerId).map(i => i.id));
    out.byUser.set(repUserId, allowed);
    if (own[0].rep.linkedRepId) out.byRep.set(own[0].rep.linkedRepId, allowed);
  }
  return out;
}

/**
 * ايتمات مندوب مشترك المسموحة لمديره هذا، أو null لغير المشترك. الفحص الأول استعلام واحد صغير:
 * يُستدعى لكل تقرير، ومعظم المندوبين يتبعون مدير شركة واحداً.
 * @returns {Promise<Set<number>|null>}
 */
export async function sharedRepItemsForViewer(repId, viewerId) {
  if (!viewerId) return null;
  const accounts = await prisma.user.findMany({
    where: { linkedRepId: repId },
    select: { id: true, managersOfUser: { select: { managerId: true, manager: { select: { role: true } } } } },
  });
  const account = accounts.find(u => u.managersOfUser.some(m => m.managerId === viewerId)
    && u.managersOfUser.filter(m => m.manager.role === 'company_manager').length >= 2);
  if (!account) return null;
  return (await loadSharedRepScopes(viewerId)).byUser.get(account.id) ?? null;
}

/**
 * أسطر طلبية مندوب مشترك الظاهرة لمديره. ايتم مكتوب بلا كتالوج لا مالك له، فيظهر للمديرين معاً.
 * @param {Array<{itemId:number|null}>} lines
 * @param {Set<number>} allowed
 */
export const visibleSharedLines = (lines, allowed) => lines.filter(l => l.itemId == null || allowed.has(l.itemId));

/**
 * مدير الشركة يفتح تقرير مندوب فريق محافظة: مندوب مشترك يعرض ايتمات هذا المدير فقط.
 * @returns {Promise<Set<number>|null>} null = بلا تقييد (مندوب بغداد والمسوق كما هما)
 */
export async function managerItemsForProvinceRep(repId, viewerId) {
  const shared = await sharedRepItemsForViewer(repId, viewerId);
  if (shared) return shared;
  const seat = await loadManagerSeat(viewerId);
  if (!seat?.items.length) return null;
  const rep = await prisma.scientificRepresentative.findUnique({ where: { id: repId }, select: { repKind: true } });
  if (!rep || rep.repKind === PHARMACY_KIND) return null;
  const users = await prisma.user.findMany({ where: { linkedRepId: repId }, select: { id: true } });
  if (!(await activeAssignmentsOf(users.map(u => u.id))).length) return null;
  return new Set(await resolveEffectiveItemIds(seat.userId));
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
