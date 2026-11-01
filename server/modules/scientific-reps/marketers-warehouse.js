// ════════════════════════════════════════════════════════════════════════════
// مبيع المسوقين (الفارمسي لاين) الكلي — للمقارنة في جدول «علمي / تجاري / فارمسي».
// ────────────────────────────────────────────────────────────────────────────
// عمود «فارمسي» في تقرير العلميين = صفوف مكتب مصنّفة فارمسي داخل نطاق العلميين (مندوبوهم
// التجاريون ∩ مناطقهم) فقط، ومبيع المسوقين عبر المذاخر (ميركاتو/لكوديشن، بالاسم) لا يدخله
// أصلاً — فيظهر أقل من تقرير مدير المسوقين. هنا: اتحاد ما يُنسب لكل مسوّق نشط
// (resolveSciRepSales عبر تقرير المجموعة، بلا تكرار بمعرّف الصف) — مكتب + مذاخر + ترانزيت —
// مقيّداً بايتمات مدير الشركة. الواجهة تستبدل به عمود فارمسي. للعرض فقط — لا يغيّر صافي التقرير.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { PHARMACY_KIND, isPharmacyRep } from '../../lib/pharmacyRep.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';
import { aggregateSalesWithReps, normalizeArabic } from '../sales/sales.repository.js';
import { getGroupRawSalesForExport } from './scientific-reps.service.js';

const TTL_MS = 3 * 60_000;
const cache = new Map(); // key → { at, fp, promise }

/**
 * مدير الشركة صاحب الايتمات: المُشاهِد نفسه إن كان مدير شركة، وإلا (إدارة المكتب) مدير
 * الشركة في مكتبه الذي شركته الرئيسية = اسم مجموعة التقرير.
 */
async function companyManagerIds(viewerId, company) {
  const me = viewerId ? await prisma.user.findUnique({
    where: { id: viewerId }, select: { id: true, role: true, officeId: true, linkedRep: { select: { repKind: true } } },
  }) : null;
  if (me?.role === 'company_manager' && !isPharmacyRep(me.linkedRep)) return [me.id];
  const key = normalizeArabic(company || '');
  if (!key) return [];
  const rows = await prisma.userCompanyAssignment.findMany({
    where: { isPrimary: true, user: { role: 'company_manager', isActive: true, ...(me?.officeId != null ? { officeId: me.officeId } : {}), NOT: { linkedRep: { is: { repKind: PHARMACY_KIND } } } } },
    select: { userId: true, company: { select: { name: true } } },
  });
  return [...new Set(rows.filter(r => normalizeArabic(r.company.name) === key).map(r => r.userId))];
}

/**
 * ايتمات الشركة = ما أُسنِد لمديرها في «الايتمات» (UserItemAssignment)، موسَّعاً بالاسم —
 * لا كل ايتمات المسوّق ولا كل ايتمات الشركة العلمية. مدير بلا ايتمات مُسنَدة لا يملك شيئاً.
 */
async function companyItemIds(viewerId, company) {
  const ids = new Set();
  for (const mgrId of await companyManagerIds(viewerId, company)) {
    for (const id of (await resolveEffectiveItemIds(mgrId)) ?? []) ids.add(id);
  }
  return ids;
}

async function compute(company, query, viewerId) {
  const marketers = await prisma.user.findMany({
    where: { isActive: true, linkedRepId: { not: null }, role: { in: ['scientific_rep', 'team_leader'] }, linkedRep: { is: { repKind: PHARMACY_KIND } } },
    select: { linkedRepId: true },
  });
  const marketerRepIds = [...new Set(marketers.map(u => u.linkedRepId))];
  const itemIds = await companyItemIds(viewerId, company);
  const zero = { totalQuantity: 0, totalValue: 0 };
  const empty = { ...zero, byArea: [], byItem: [], byRep: [], office: zero, warehouse: zero, marketerCount: marketerRepIds.length, rowCount: 0, noCompanyItems: !itemIds.size };
  if (!marketerRepIds.length || !itemIds.size) return empty;

  // skipItemTiers: ايتمات الشركة تُحسب كلها هنا وإن كانت «ثانوية» عند المسوّق.
  const rows = await getGroupRawSalesForExport(marketerRepIds, { ...query, recordType: null, skipItemTiers: true }, viewerId);
  // كل ما يُنسب للمسوقين (مكتب بتسمياتهم ومناطقهم + ميركاتو/لكوديشن + ترانزيت) — نفس حساب
  // تقرير المسوقين، لا صفوف «فارمسي» داخل نطاق العلميين. صافٍ: الإرجاع بإشارة سالبة.
  // الصف مقيّد أصلاً بايتمات المسوّق (resolveSciRepSales)، فالناتج = المشترك بينه وبين الشركة.
  const all = rows
    .filter(s => itemIds.has(s.itemId))
    .map(({ rawData, ...s }) => (String(s.recordType ?? '').trim().toLowerCase() === 'return'
      ? { ...s, quantity: -s.quantity, totalValue: -s.totalValue }
      : s));
  if (!all.length) return empty;

  // مذاخر = ملفات ميركاتو (ومعها ملف اللكوديشن) + الترانزيت (يُعدّ لكوديشن في تقرير العلميين).
  const isWarehouse = s => s.uploadedFile?.sourceSystem === 'mercato' || !!s.transit;
  const part = list => { const t = aggregateSalesWithReps(list).totals; return { totalQuantity: t.totalQuantity, totalValue: t.totalValue }; };
  const a = aggregateSalesWithReps(all);
  const slim = (list, nameKey) => list.map(r => ({ name: r[nameKey], totalQuantity: r.totalQuantity, totalValue: r.totalValue }));
  return {
    totalQuantity: a.totals.totalQuantity,
    totalValue: a.totals.totalValue,
    byArea: slim(a.byArea, 'areaName'),
    byItem: slim(a.byItem, 'itemName'),
    byRep: slim(a.byRep, 'repName'),
    office: part(all.filter(s => !isWarehouse(s))),
    warehouse: part(all.filter(isWarehouse)),
    marketerCount: marketerRepIds.length,
    rowCount: all.length,
    noCompanyItems: false,
  };
}

/**
 * @param {string} company اسم مجموعة التقرير (الشركة) — يحدّد مديرها لإدارة المكتب
 * @param {{ fileIds: number[]|null, startDate?: string, endDate?: string }} query
 */
export async function getMarketersWarehouseShare(company, query, viewerId = null) {
  const fileIds = query.fileIds ?? [];
  if (!fileIds.length) return null;
  // ثقيل (resolveSciRepSales لكل مسوّق) — مخزَّن 3 دقائق مع بصمة الصفوف كحساب فريق المسوقين.
  const key = [viewerId ?? '', normalizeArabic(company || ''), [...fileIds].sort((a, b) => a - b).join(','), query.startDate ?? '', query.endDate ?? ''].join('|');
  const agg = await prisma.sale.aggregate({ where: { uploadedFileId: { in: fileIds } }, _count: { _all: true }, _max: { id: true } });
  const fp = `${agg._count._all}|${agg._max.id ?? 0}`;
  const hit = cache.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = compute(company, query, viewerId);
  cache.set(key, { at: Date.now(), fp, promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return promise;
}
