// ════════════════════════════════════════════════════════════════════════════
// مبيع المسوقين (الفارمسي لاين) من المذاخر — للمقارنة في جدول «علمي / تجاري / فارمسي».
// ────────────────────────────────────────────────────────────────────────────
// عمود «فارمسي» في تقرير العلميين = صفوف ملف المكتب المصنّفة فارمسي فقط. مبيع المسوقين
// عبر المذاخر (ملفات ميركاتو، ومعها ملف اللكوديشن) يُنسب لهم بالاسم ولا يدخل تقرير
// العلميين أصلاً. هنا: اتحاد ما يُنسب لكل مسوّق نشط (resolveSciRepSales عبر تقرير
// المجموعة، بلا تكرار بمعرّف الصف)، صفوف ميركاتو فقط، مقيّدة بايتمات مندوبي التقرير
// المعروض. للعرض فقط — لا يُضاف لإجمالي التقرير.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { PHARMACY_KIND } from '../../lib/pharmacyRep.js';
import { aggregateSalesWithReps, normalizeArabic } from '../sales/sales.repository.js';
import { getGroupRawSalesForExport, resolveSciRepItemIds } from './scientific-reps.service.js';

const TTL_MS = 3 * 60_000;
const cache = new Map(); // key → { at, fp, promise }

/** أسماء ايتمات مندوبي التقرير مطبَّعة؛ null = بلا تقييد (مندوب واحد على الأقل بلا قائمة). */
async function reportItemNames(repIds) {
  const ids = new Set();
  for (const repId of repIds) {
    const { itemIds } = await resolveSciRepItemIds(repId);
    if (!itemIds) return null;
    for (const id of itemIds) ids.add(id);
  }
  if (!ids.size) return new Set();
  const items = await prisma.item.findMany({ where: { id: { in: [...ids] } }, select: { name: true } });
  return new Set(items.map(i => normalizeArabic(i.name)));
}

async function compute(repIds, query, viewerId) {
  const marketers = await prisma.user.findMany({
    where: { isActive: true, linkedRepId: { not: null }, role: { in: ['scientific_rep', 'team_leader'] }, linkedRep: { is: { repKind: PHARMACY_KIND } } },
    select: { linkedRepId: true },
  });
  const marketerRepIds = [...new Set(marketers.map(u => u.linkedRepId))];
  const names = await reportItemNames(repIds);
  const empty = { totalQuantity: 0, totalValue: 0, byArea: [], byItem: [], byRep: [], marketerCount: marketerRepIds.length, rowCount: 0 };
  if (!marketerRepIds.length || (names && !names.size)) return empty;

  // skipItemTiers: ايتمات الشركة تُحسب كلها هنا وإن كانت «ثانوية» عند المسوّق.
  const rows = await getGroupRawSalesForExport(marketerRepIds, { ...query, recordType: null, skipItemTiers: true }, viewerId);
  // صافٍ: الإرجاع بإشارة سالبة، كما يفعل buildReport بلا recordType.
  const wh = rows
    .filter(s => s.uploadedFile?.sourceSystem === 'mercato' && (!names || names.has(normalizeArabic(s.item?.name ?? ''))))
    .map(({ rawData, ...s }) => (String(s.recordType ?? '').trim().toLowerCase() === 'return'
      ? { ...s, quantity: -s.quantity, totalValue: -s.totalValue }
      : s));
  if (!wh.length) return empty;

  const a = aggregateSalesWithReps(wh);
  const slim = (list, nameKey) => list.map(r => ({ name: r[nameKey], totalQuantity: r.totalQuantity, totalValue: r.totalValue }));
  return {
    totalQuantity: a.totals.totalQuantity,
    totalValue: a.totals.totalValue,
    byArea: slim(a.byArea, 'areaName'),
    byItem: slim(a.byItem, 'itemName'),
    byRep: slim(a.byRep, 'repName'),
    marketerCount: marketerRepIds.length,
    rowCount: wh.length,
  };
}

/**
 * @param {number[]} repIds مندوبو التقرير المعروض (مجموعة الشركة) — يحدّدون الايتمات
 * @param {{ fileIds: number[]|null, startDate?: string, endDate?: string }} query
 */
export async function getMarketersWarehouseShare(repIds, query, viewerId = null) {
  const fileIds = query.fileIds ?? [];
  if (!repIds.length || !fileIds.length) return null;
  // ثقيل (resolveSciRepSales لكل مسوّق) — مخزَّن 3 دقائق مع بصمة الصفوف كحساب فريق المسوقين.
  const key = [viewerId ?? '', [...repIds].sort((a, b) => a - b).join(','), [...fileIds].sort((a, b) => a - b).join(','), query.startDate ?? '', query.endDate ?? ''].join('|');
  const agg = await prisma.sale.aggregate({ where: { uploadedFileId: { in: fileIds } }, _count: { _all: true }, _max: { id: true } });
  const fp = `${agg._count._all}|${agg._max.id ?? 0}`;
  const hit = cache.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = compute(repIds, query, viewerId);
  cache.set(key, { at: Date.now(), fp, promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return promise;
}
