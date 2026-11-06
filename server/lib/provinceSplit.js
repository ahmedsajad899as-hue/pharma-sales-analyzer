// ════════════════════════════════════════════════════════════════════════════
// provinceSplit.js — خطة تقسيم مبيع مقاعد الشركات بين مندوبيها داخل فريق محافظة.
//
// الافتراضي: كل سطر لمن أرسله (ميركاتو واللكوديشن باسمه + مبيعاته المؤكدة)، ولا يحتاج شيئاً من هنا.
// الماستر أدمن قد يجعل مقعداً بالايتمات أو المناطق أو الزبائن (ProvinceSeatSplit)؛ والقاعدة
// نفسها في attributeLine (province-teams.rules.js).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { loadItemOwnerManagers } from './itemOwnerManager.js';
import { loadSeatManagers } from './provinceSeats.js';
import { normalizeAreaName } from './itemResolver.js';
import { matchHelpers } from './manualDuplicateCheck.js';
import { DEFAULT_SPLIT_MODE, repSeatIds, resolveAssignmentItemIds } from '../modules/province-teams/province-teams.rules.js';

export const sameSplitArea = (a, b) => normalizeAreaName(a) === normalizeAreaName(b);
export const sameSplitCustomer = (a, b) => matchHelpers.namesMatch(matchHelpers.pharmKey(a), matchHelpers.pharmKey(b)) === true;

const TEAM_SELECT = {
  id: true, officeId: true,
  province: { select: { name: true } },
  seatSplits: { select: { managerUserId: true, mode: true, scopes: true } },
  assignments: {
    where: { isActive: true },
    select: {
      repUserId: true, companyId: true, allItems: true,
      items: { select: { itemId: true } },
      rep: { select: { linkedRepId: true, managersOfUser: { select: { managerId: true } } } },
    },
  },
};

function buildPlan(team, seats, owners, companyItems, itemCompany) {
  const seatRepIds = new Map(seats.map(s => [s.userId, []]));
  const repRows = new Map();
  for (const a of team.assignments) {
    if (!repRows.has(a.repUserId)) repRows.set(a.repUserId, { managerIds: a.rep.managersOfUser.map(m => m.managerId), linkedRepId: a.rep.linkedRepId, rows: [] });
    repRows.get(a.repUserId).rows.push({ companyId: a.companyId, allItems: a.allItems, itemIds: a.items.map(i => i.itemId) });
  }
  for (const [repUserId, r] of repRows) {
    for (const seatId of repSeatIds(r.rows, r.managerIds, seats)) seatRepIds.get(seatId)?.push(repUserId);
  }

  const splits = new Map();
  for (const row of team.seatSplits) {
    if (row.mode === DEFAULT_SPLIT_MODE || !seatRepIds.has(row.managerUserId)) continue;
    const scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
    splits.set(row.managerUserId, {
      mode: row.mode,
      reps: seatRepIds.get(row.managerUserId).map(repUserId => ({
        repUserId,
        itemIds: new Set(repRows.get(repUserId).rows.flatMap(a => resolveAssignmentItemIds(a, companyItems))),
        areas: scopes[repUserId]?.areas ?? [],
        customers: scopes[repUserId]?.customers ?? [],
      })),
    });
  }
  if (!splits.size) return null;

  const wholeCompany = new Map(seats.filter(s => !s.items.length).map(s => [s.companyId, s.userId]));
  // ايتم بلا مالك لا مقعد له، فيبقى لمن أرسله.
  const seatOfItem = (itemId) => (itemId == null ? null : owners.get(itemId)?.managerId ?? wholeCompany.get(itemCompany.get(itemId)) ?? null);
  return {
    teamId: team.id,
    provinceName: team.province.name,
    splits,
    seatOfItem,
    modeOfItem: (itemId) => splits.get(seatOfItem(itemId))?.mode ?? DEFAULT_SPLIT_MODE,
    sameArea: sameSplitArea,
    sameCustomer: sameSplitCustomer,
    repUserIds: [...repRows.keys()],
    linkedRepOf: new Map([...repRows].map(([id, r]) => [id, r.linkedRepId])),
  };
}

/**
 * خطط الفرق التي فيها مقعد ليس على الوضع الافتراضي، وهي الأقل. بلا مثلها لا تكلفة غير استعلام واحد.
 * @param {object} teamWhere شرط على ProvinceTeam
 * @returns {Promise<Array>} خطة لكل فريق
 */
async function loadPlans(teamWhere) {
  const teams = await prisma.provinceTeam.findMany({
    where: { AND: [teamWhere, { isActive: true, seatSplits: { some: { mode: { not: DEFAULT_SPLIT_MODE } } } }] },
    select: TEAM_SELECT,
  });
  if (!teams.length) return [];

  const plans = [];
  const companyIds = [...new Set(teams.flatMap(t => t.assignments.map(a => a.companyId)))];
  const catalog = await prisma.item.findMany({
    where: { scientificCompanyId: { in: companyIds }, isTemp: false },
    select: { id: true, scientificCompanyId: true },
  });
  const companyItems = new Map(companyIds.map(id => [id, []]));
  const itemCompany = new Map();
  for (const i of catalog) {
    companyItems.get(i.scientificCompanyId)?.push(i.id);
    itemCompany.set(i.id, i.scientificCompanyId);
  }
  for (const officeId of new Set(teams.map(t => t.officeId))) {
    const [seats, owners] = await Promise.all([loadSeatManagers([officeId]), loadItemOwnerManagers(officeId)]);
    for (const t of teams.filter(x => x.officeId === officeId)) {
      const plan = buildPlan(t, seats, owners, companyItems, itemCompany);
      if (plan) plans.push(plan);
    }
  }
  return plans;
}

/** خطط فرق هذه الحسابات، بمفتاح اسم المحافظة كما يحسبه تقرير اللكوديشن. */
export async function loadSplitPlansForReps(repUserIds) {
  if (!repUserIds?.length) return new Map();
  const plans = await loadPlans({ assignments: { some: { repUserId: { in: repUserIds }, isActive: true } } });
  return new Map(plans.map(p => [p.provinceName, p]));
}

/** خطط هذه الفرق بمفتاح معرّف الفريق — لتغطية المحافظة. */
export async function loadSplitPlansForTeams(teamIds) {
  if (!teamIds?.length) return new Map();
  const plans = await loadPlans({ id: { in: teamIds } });
  return new Map(plans.map(p => [p.teamId, p]));
}
