import prisma from '../../lib/prisma.js';
import { list, getReport, getGroupReport, resolveMyRepId } from '../scientific-reps/scientific-reps.service.js';
import { provinceMemberUserIds } from '../../lib/provinceScope.js';
import { loadManagerSeat, repIdsInManagerTeam } from '../../lib/provinceSeats.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { PHARMACY_KIND } from '../../lib/pharmacyRep.js';
import { buildTargetComparison } from '../../lib/targetCompare.js';

// ── أعمدة الأشخاص في جدول التارگت ───────────────────────────────────────────
// المندوب وقائد الفريق يُعرَّفان بسجل ScientificRepresentative (id موجب). مدير الشركة
// لا سجل مندوب له عادةً، وensureLinkedRepId تربط حسابه بأول مندوب يملكه (rep.userId =
// مالك السجل)، فلا تصلح له. لذا تُخزَّن أهدافه بـ repType='manager' + repId=معرّف حسابه،
// ويُمثَّل في الواجهة بمعرّف سالب منعاً لتصادمه مع معرّفات المندوبين.
export const MANAGER_REP_TYPE = 'manager';

/** @returns {{repType:string, repId:number}} مفتاح RepItemTarget لمعرّف عمود في الجدول */
export function targetKeyOf(repType, columnId) {
  return columnId < 0
    ? { repType: MANAGER_REP_TYPE, repId: -columnId }
    : { repType, repId: columnId };
}

const OFFICE_VIEW_ROLES = new Set(['office_manager', 'office_hr', 'office_employee', 'product_manager', 'supervisor']);

function managerColumn(u) {
  const primary = u.companyAssignments.find(a => a.isPrimary) ?? u.companyAssignments[0];
  return {
    id: -u.id,
    userId: u.id,
    name: u.displayName || u.username,
    company: primary?.company?.name ?? null,
    companyId: primary?.company?.id ?? null,
    role: 'company_manager',
    repKind: u.linkedRep?.repKind ?? 'scientific',
    isProvinceMember: false,
    items: [],
  };
}

const MANAGER_SELECT = {
  id: true, displayName: true, username: true,
  linkedRep: { select: { repKind: true } },
  companyAssignments: { select: { isPrimary: true, company: { select: { id: true, name: true } } } },
};

/**
 * كل من يُعيَّن له تارگت في نظر هذا المستخدم: قائمة المندوبين المعتادة (علمي، مسوق،
 * قائد فريق، بغداد ومحافظات) + مدراء الشركات لإدارة المكتب + المدير/قائد الفريق نفسه.
 * /api/scientific-reps لا تُمسّ: صفحات كثيرة تعتمد عليها ولا تتوقع المدراء فيها.
 */
export async function listTargetPeople(user) {
  const reps = await list({}, user);
  if (user.role === 'team_leader') {
    const repId = await resolveMyRepId(user.id);
    if (!repId || reps.some(r => r.id === repId)) return reps;
    const [me, province] = await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: MANAGER_SELECT }),
      provinceMemberUserIds(),
    ]);
    if (!me) return reps;
    return [{ ...managerColumn(me), id: repId, role: 'team_leader', isProvinceMember: province.has(user.id) }, ...reps];
  }
  if (user.role === 'company_manager') {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: MANAGER_SELECT });
    return me ? [managerColumn(me), ...reps] : reps;
  }
  if (OFFICE_VIEW_ROLES.has(user.role)) {
    const viewer = await prisma.user.findUnique({
      where: { id: user.id },
      select: { officeId: true, companyAssignments: { select: { companyId: true } } },
    });
    const companyIds = new Set(viewer?.companyAssignments.map(a => a.companyId) ?? []);
    if (user.role === 'product_manager' && viewer?.officeId) {
      const office = await prisma.scientificCompany.findMany({ where: { officeId: viewer.officeId }, select: { id: true } });
      office.forEach(c => companyIds.add(c.id));
    }
    if (companyIds.size === 0) return reps;
    const managers = await prisma.user.findMany({
      where: { role: 'company_manager', isActive: true, companyAssignments: { some: { companyId: { in: [...companyIds] }, isPrimary: true } } },
      select: MANAGER_SELECT,
    });
    return [...managers.map(managerColumn), ...reps];
  }
  return reps;
}

// ── المبيع النت لشخص ─────────────────────────────────────────────────────────

/** فريق المدير: مندوبو قائمته من نوعه (علمي أو مسوق)، ومقيَّدون بمقعده في فرق المحافظات. */
async function managerTeamRepIds(managerUserId) {
  const mgr = await prisma.user.findUnique({
    where: { id: managerUserId },
    select: { role: true, linkedRep: { select: { repKind: true } } },
  });
  if (mgr?.role !== 'company_manager') return [];
  const marketers = mgr.linkedRep?.repKind === PHARMACY_KIND;
  const team = await list({}, { id: managerUserId, role: 'company_manager' });
  const ids = team
    .filter(r => r.role !== 'commercial_rep' && (r.repKind === PHARMACY_KIND) === marketers)
    .map(r => r.id);
  const seat = ids.length ? await loadManagerSeat(managerUserId) : null;
  return seat ? repIdsInManagerTeam(seat, ids) : ids;
}

/**
 * byItem بنفس دالة التقرير تماماً (getReport / getGroupReport) فتطابق أرقام التقارير:
 * صافٍ (مبيع − مرتجع)، نفس الملفات والحظر ونطاق الايتمات. مدير الشركة = صفوف فريقه بلا
 * تكرار، كتقرير مجموعة الشركة، ومقيَّدة بايتماته («الشركة» = ايتمات المدير).
 */
async function computeSoldItems(columnId, query, viewerId) {
  if (columnId > 0) return (await getReport(columnId, query, viewerId)).byItem ?? [];
  const managerUserId = -columnId;
  const repIds = await managerTeamRepIds(managerUserId);
  if (!repIds.length) return [];
  const report = await getGroupReport(repIds, '', query, viewerId);
  const allowed = await resolveEffectiveItemIds(managerUserId);
  if (!allowed) return report.byItem ?? [];
  const ids = new Set(allowed);
  return (report.byItem ?? []).filter(i => ids.has(i.itemId));
}

// الخادم بمعالج واحد والتقرير ثقيل: تُخزَّن النتيجة 3 دقائق وتُلغى بتغيّر صفوف الملفات.
// التارگتات لا تُخزَّن، فيظهر أثر الحفظ فوراً. راجع resolvePharmacyOfficeSaleIds.
const SOLD_TTL_MS = 3 * 60 * 1000;
const soldCache = new Map(); // key → { at, fp, promise }

async function soldItemsCached(columnId, query, viewerId, cacheKey) {
  const agg = await prisma.sale.aggregate({ where: { uploadedFileId: { in: query.fileIds } }, _count: { _all: true }, _max: { id: true } });
  const fp = `${agg._count._all}|${agg._max.id ?? 0}`;
  const key = `${viewerId ?? ''}|${columnId}|${cacheKey}`;
  const hit = soldCache.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < SOLD_TTL_MS) return hit.promise;
  const promise = computeSoldItems(columnId, query, viewerId)
    .then(rows => rows.map(r => ({ itemId: r.itemId, itemName: r.itemName, totalQuantity: r.totalQuantity })));
  soldCache.set(key, { at: Date.now(), fp, promise });
  promise.catch(() => soldCache.delete(key));
  if (soldCache.size > 300) soldCache.delete(soldCache.keys().next().value);
  return promise;
}

/**
 * مقارنة تارگت شهر بالمبيع النت لشخص واحد.
 * @param {number} columnId معرّف العمود (سالب = مدير شركة)
 * @param {{month:number, year:number, fileIds:number[]|null, range:{startDate:Date,endDate:Date}|null}} period
 */
export async function getTargetActuals(columnId, { month, year, fileIds, range }, viewerId) {
  const { repType, repId } = targetKeyOf('scientific', columnId);
  const targets = await prisma.repItemTarget.findMany({
    where: { repType, repId, month, year, target: { gt: 0 } },
    select: { itemId: true, target: true, item: { select: { name: true } } },
  });
  const hasFiles = !!fileIds?.length && !!range;
  const sold = hasFiles
    ? await soldItemsCached(columnId, { fileIds, startDate: range.startDate, endDate: range.endDate }, viewerId,
        `${[...fileIds].sort((a, b) => a - b).join(',')}|${year}-${month}`)
    : [];
  return { hasFiles, ...buildTargetComparison(targets, sold) };
}
