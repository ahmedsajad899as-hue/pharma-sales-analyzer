/**
 * Sales Repository
 * Responsible for all database operations related to sales data.
 * Uses Prisma for type-safe queries.
 */

import prisma from '../../lib/prisma.js';
import { resolveItemName, loadResolutionContext } from '../../lib/itemResolver.js';

/**
 * Normalize Arabic text to a canonical form:
 * - Unify all Alef variants (أ إ آ ٱ) → ا
 * - Unify Teh Marbuta (ة) → ه
 * - Remove Tatweel (ـ)
 * - Remove diacritics (تشكيل)
 * - Trim and collapse whitespace
 */
export function normalizeArabic(str) {
  return String(str)
    .trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')  // أ إ آ ٱ → ا
    .replace(/\u0629/g, '\u0647')                        // ة → ه
    .replace(/\u0649/g, '\u064A')                        // ى (alef maqsura) → ي
    .replace(/\u0640/g, '')                              // ـ Tatweel
    .replace(/[\u064B-\u065F]/g, '')                    // diacritics
    .replace(/[-–—,،/\\]+/g, ' ')        // separators (dash/comma/slash/backslash) -> space
    .replace(/(^|\s)\u0627\u0644/g, '$1')               // remove ال (definite article) at word start
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a Prisma uploadedFileId filter from a fileIds value.
 * Accepts: null (no filter), a single number, or an array of numbers.
 */
function buildFileIdsFilter(fileIds) {
  if (!fileIds) return {};
  const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
  if (ids.length === 0) return {};
  if (ids.length === 1) return { uploadedFileId: ids[0] };
  return { uploadedFileId: { in: ids } };
}

/**
 * Prisma select fragment to pull each sale's own file currency so values can be
 * normalized before aggregation. Add this to any findMany feeding aggregateSales
 * / aggregateSalesWithReps.
 */
export const FILE_CURRENCY_SELECT = {
  uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
};

/**
 * Normalize a sale's stored totalValue to a common base currency (USD) using its
 * OWN file's detectedCurrency + exchangeRate.
 *
 * Why: different uploaded files may store their values in different currencies
 * (one file in USD, another in IQD). When a report aggregates across several
 * files, summing the raw values directly is meaningless — a large IQD number and
 * a small USD number can't be added. Converting every row to USD first makes the
 * sum correct no matter how many files (or which currencies) are combined. The
 * frontend then converts the USD total to whatever display currency it wants.
 *
 * IQD file → value / exchangeRate.  USD file (or unknown) → value unchanged.
 */
export function saleValueUSD(sale) {
  const raw = Number(sale.totalValue) || 0;
  const f = sale.uploadedFile;
  if (!f) return raw;                       // unknown file → don't distort
  const rate = f.exchangeRate || 1470;
  return f.detectedCurrency === 'IQD' ? raw / rate : raw;
}

/**
 * Upsert an Area by name scoped to userId. Returns the area record.
 * @param {string} name
 * @param {number} userId
 */
export async function findOrCreateArea(name, userId) {
  const normalized = normalizeArabic(name);
  // Pull all areas for this user and find one whose normalized name matches.
  // This handles variants like ا/أ/إ/آ, ه/ة, with/without diacritics etc.
  const userAreas = await prisma.area.findMany({
    where: { userId: userId ?? null },
    select: { id: true, name: true },
  });
  const existing = userAreas.find(r => normalizeArabic(r.name) === normalized);
  if (existing) return existing;

  // Create using the normalized name so future lookups stay consistent.
  return prisma.area.create({ data: { name: normalized, userId: userId ?? null } });
}

/**
 * Upsert a Company by name scoped to userId. Returns the company record.
 * @param {string} name
 * @param {number} userId
 */
export async function findOrCreateCompany(name, userId) {
  return prisma.company.upsert({
    where:  { name_userId: { name, userId } },
    update: {},
    create: { name, userId },
  });
}

/**
 * Upsert an Item by name scoped to userId. Returns the item record.
 * @param {string} name
 * @param {number} userId
 */
/**
 * Find or create an Item by name — عبر محرّك التوحيد (itemResolver).
 *
 * مسار الشركة (sciCompanyIds مُمرّرة): مطابقة ذكية —
 *   alias/exact/high → ايتم الكتالوج القانوني (توحيد تلقائي، حارس الجرعة يحمي 100/500).
 *   medium/none      → ايتم مؤقت (isTemp) يظهر في unknownItems لمعالجته لاحقاً.
 * مسار "لا شركة" (مثل scientific-reps): السلوك القديم تماماً — تطابق تام لايتمات
 *   المستخدم غير المؤقتة، وإلا ايتم مؤقت. (لا تغيير على هذا المسار.)
 *
 * @param {string} name
 * @param {number|null} userId
 * @param {number[]|null} sciCompanyIds  - IDs of scientific companies the uploader belongs to
 * @param {{catalog,catalogById,aliasMap}|null} ctx - سياق مُحمّل مسبقاً (وضع الدُّفعة)
 */
export async function findOrCreateItem(name, userId, sciCompanyIds = null, ctx = null) {
  const normalized = normalizeArabic(name);
  const ids = (sciCompanyIds || []).filter(Boolean);

  if (ids.length > 0) {
    // مسار الشركة — مطابقة ذكية
    const resolveCtx = ctx || await loadResolutionContext({ scientificCompanyIds: ids, userId });
    const r = await resolveItemName(name, resolveCtx);
    if (r.canonicalItem && (r.confidence === 'alias' || r.confidence === 'exact' || r.confidence === 'high')) {
      return r.canonicalItem;
    }
    // medium/none → يسقط إلى إنشاء ايتم مؤقت أدناه
  } else if (userId) {
    // مسار "لا شركة" — تطابق تام لايتمات المستخدم غير المؤقتة (كما في السابق)
    const userItems = await prisma.item.findMany({
      where: { userId, isTemp: false },
      select: { id: true, name: true },
    });
    const found = userItems.find(i => normalizeArabic(i.name) === normalized);
    if (found) return found;
  }

  // إنشاء ايتم مؤقت (غير موجود في الكتالوج) — مطابق للسلوك القديم
  return prisma.item.upsert({
    where:  { name_userId: { name: normalized, userId } },
    update: {},
    create: { name: normalized, userId, isTemp: true },
  });
}

/**
 * Upsert a Customer by name scoped to userId. Returns the customer record.
 * @param {string} name
 * @param {number} userId
 */
export async function findOrCreateCustomer(name, userId) {
  return prisma.customer.upsert({
    where:  { name_userId: { name, userId } },
    update: {},
    create: { name, userId },
  });
}

// ─── Bulk-read helpers (for fuzzy-dedup at upload time) ──────────────────────

/**
 * Return all Item names + ids for a given user.
 * @param {number} userId
 */
export async function getAllItems(userId) {
  return prisma.item.findMany({ where: { userId }, select: { id: true, name: true } });
}

/**
 * Return all catalog item names (from scientific companies) for the uploader's companies.
 */
export async function getCatalogItems(sciCompanyIds) {
  if (!sciCompanyIds || sciCompanyIds.length === 0) return [];
  return prisma.item.findMany({
    where: { scientificCompanyId: { in: sciCompanyIds }, isTemp: false },
    select: { id: true, name: true },
  });
}

/**
 * Return all MedicalRepresentative names + ids for a user.
 * @param {number} userId
 */
export async function getAllReps(userId) {
  return prisma.medicalRepresentative.findMany({ where: { userId }, select: { id: true, name: true } });
}

/**
 * Return all Company names + ids for a user.
 * @param {number} userId
 */
export async function getAllCompanies(userId) {
  return prisma.company.findMany({ where: { userId }, select: { id: true, name: true } });
}

/**
 * Return all Area names + ids for a user.
 * @param {number} userId
 */
export async function getAllAreas(userId) {
  return prisma.area.findMany({ where: { userId }, select: { id: true, name: true } });
}

// ─── Merge-duplicate helpers ──────────────────────────────────────────────────

/**
 * Merge a duplicate item INTO a canonical item, within an existing Prisma
 * transaction `tx`. Re-points EVERY relation that references the item BEFORE
 * deleting the source, so nothing is lost to the schema's `onDelete: Cascade`
 * FKs (which would otherwise silently delete the source item's targets,
 * rep/plan/user assignments, etc. when the row is removed).
 *
 * - Composite-unique relations (one row per other-entity + item) are moved,
 *   de-duplicated against any row the target already has.
 * - RepItemTarget is merged on its unique (repType, repId, itemId, month, year);
 *   on conflict the LARGER target value is kept so a manager's target is never
 *   silently dropped or double-counted.
 * - Plain FK relations are bulk re-pointed.
 *
 * This is the single source of truth for item merges — both the manual
 * /api/items/:id/merge endpoint and the bulk /api/dedup-names path use it, so
 * the two can never diverge.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {number} sourceId  – duplicate item id (deleted)
 * @param {number} targetId  – canonical (kept) item id
 * @returns {Promise<Record<string, any>>} counters per relation
 */
export async function mergeItemInto(tx, sourceId, targetId) {
  const counters = {};

  // ── Composite-unique relations: (otherKey, itemId) ──
  const compositeRels = [
    { table: 'representativeItem', key: 'representativeId' },
    { table: 'scientificRepItem',  key: 'scientificRepId'  },
    { table: 'planEntryItem',      key: 'planEntryId'      },
    { table: 'productLineItem',    key: 'lineId'           },
    { table: 'userItemAssignment', key: 'userId'           },
  ];
  for (const { table, key } of compositeRels) {
    const sourceRows = await tx[table].findMany({ where: { itemId: sourceId } });
    if (sourceRows.length === 0) continue;
    const targetRows = await tx[table].findMany({
      where: { itemId: targetId, [key]: { in: sourceRows.map(r => r[key]) } },
      select: { [key]: true },
    });
    const existing = new Set(targetRows.map(r => r[key]));
    const toMove   = sourceRows.filter(r => !existing.has(r[key]));
    const toDelete = sourceRows.filter(r =>  existing.has(r[key]));
    for (const row of toMove) {
      await tx[table].update({ where: { [`${key}_itemId`]: { [key]: row[key], itemId: sourceId } }, data: { itemId: targetId } });
    }
    for (const row of toDelete) {
      await tx[table].delete({ where: { [`${key}_itemId`]: { [key]: row[key], itemId: sourceId } } });
    }
    counters[table] = { moved: toMove.length, removed: toDelete.length };
  }

  // ── RepItemTarget — unique (repType, repId, itemId, month, year); operate by id ──
  const srcTargets = await tx.repItemTarget.findMany({ where: { itemId: sourceId } });
  let tMoved = 0, tMerged = 0;
  for (const st of srcTargets) {
    const dup = await tx.repItemTarget.findFirst({
      where: { repType: st.repType, repId: st.repId, itemId: targetId, month: st.month, year: st.year },
    });
    if (!dup) {
      await tx.repItemTarget.update({ where: { id: st.id }, data: { itemId: targetId } });
      tMoved++;
    } else {
      if (st.target > dup.target) await tx.repItemTarget.update({ where: { id: dup.id }, data: { target: st.target } });
      await tx.repItemTarget.delete({ where: { id: st.id } });
      tMerged++;
    }
  }
  counters.repTargets = { moved: tMoved, merged: tMerged };

  // ── Plain FK relations (no composite unique on itemId) ──
  const [sales, doctorsTarget, visits, pharmVisitItems, commInvItems, fmsItems] = await Promise.all([
    tx.sale.updateMany({                 where: { itemId: sourceId }, data: { itemId: targetId } }),
    tx.doctor.updateMany({               where: { targetItemId: sourceId }, data: { targetItemId: targetId } }),
    tx.doctorVisit.updateMany({          where: { itemId: sourceId }, data: { itemId: targetId } }),
    tx.pharmacyVisitItem.updateMany({    where: { itemId: sourceId }, data: { itemId: targetId } }),
    tx.commercialInvoiceItem.updateMany({ where: { itemId: sourceId }, data: { itemId: targetId } }),
    tx.fmsPlanItem.updateMany({          where: { itemId: sourceId }, data: { itemId: targetId } }),
  ]);
  counters.sales                  = sales.count;
  counters.doctorsTarget          = doctorsTarget.count;
  counters.doctorVisits           = visits.count;
  counters.pharmacyVisitItems     = pharmVisitItems.count;
  counters.commercialInvoiceItems = commInvItems.count;
  counters.fmsPlanItems           = fmsItems.count;

  await tx.item.delete({ where: { id: sourceId } });
  return counters;
}

/**
 * Merge a duplicate item into a canonical item (own transaction wrapper around
 * mergeItemInto). Used by the bulk /api/dedup-names path.
 * @param {number} fromId  – duplicate item id
 * @param {number} toId    – canonical (kept) item id
 */
export async function mergeItems(fromId, toId) {
  if (fromId === toId) return;
  await prisma.$transaction(tx => mergeItemInto(tx, fromId, toId), { timeout: 30000 });
}

/**
 * Merge a duplicate rep into a canonical rep.
 * @param {number} fromId
 * @param {number} toId
 */
export async function mergeReps(fromId, toId) {
  if (fromId === toId) return;
  await prisma.$transaction([
    prisma.sale.updateMany({ where: { representativeId: fromId }, data: { representativeId: toId } }),
    prisma.representativeArea.deleteMany({ where: { representativeId: fromId } }),
    prisma.representativeItem.deleteMany({ where: { representativeId: fromId } }),
    prisma.medicalRepresentative.delete({ where: { id: fromId } }),
  ]);
}

/**
 * Merge a duplicate company into a canonical company.
 * @param {number} fromId
 * @param {number} toId
 */
export async function mergeCompanies(fromId, toId) {
  if (fromId === toId) return;
  await prisma.$transaction([
    prisma.item.updateMany({ where: { companyId: fromId }, data: { companyId: toId } }),
    prisma.scientificRepCompany.deleteMany({ where: { companyId: fromId } }),
    prisma.company.delete({ where: { id: fromId } }),
  ]);
}

/**
 * Find a representative by name scoped to userId.
 * @param {string} name
 * @param {number} userId
 */
export async function findRepByName(name, userId) {
  return prisma.medicalRepresentative.findFirst({
    where: { name: { equals: name }, userId },
  });
}

/**
 * Bulk-create sales records inside a transaction.
 * @param {Array} rows - Validated sale rows
 * @param {number} uploadedFileId
 * @param {number} [userId]
 * @returns {Prisma.BatchPayload}
 */
export async function bulkCreateSales(rows, uploadedFileId, userId = null, recordType = 'sale') {
  return prisma.sale.createMany({
    data: rows.map(r => ({
      representativeId: r.representativeId,
      areaId:           r.areaId,
      itemId:           r.itemId,
      customerId:       r.customerId ?? null,
      quantity:         r.quantity,
      totalValue:       r.totalValue,
      saleDate:         r.saleDate ?? undefined,
      uploadedFileId,
      rawData:          r.rawData ?? null,
      userId,
      recordType,
    })),
  });
}

/**
 * Create an UploadedFile record.
 * @param {{ filename, originalName, rowCount, uploadedBy? }} data
 */
export async function createUploadedFile(data) {
  return prisma.uploadedFile.create({ data });
}

/**
 * Optimized sales query for a representative report.
 * Avoids N+1 by aggregating at DB level.
 *
 * @param {number}   repId
 * @param {number[]|null} areaIds  - null = all areas
 * @param {number[]|null} itemIds  - null = all items
 * @param {{ startDate?, endDate? }} dateRange
 * @returns {{ byArea, byItem, totals }}
 */
export async function getSalesAggregates(repId, areaIds, itemIds, dateRange = {}, fileIds = null, recordType = null) {
  const dateFilter = buildDateFilter(dateRange);

  // Build WHERE clause
  const where = {
    representativeId: repId,
    ...dateFilter,
    ...(areaIds ? { areaId: { in: areaIds } } : {}),
    ...(itemIds ? { itemId: { in: itemIds } } : {}),
    ...buildFileIdsFilter(fileIds),
    ...(recordType ? { recordType } : {}),
  };

  // Single query: fetch all matching sales with area + item names
  // Prisma groupBy does not support cross-joins, so we use raw aggregation
  // via findMany + in-memory grouping to keep it clean and type-safe.
  // For very large datasets, swap with prisma.$queryRaw below.
  const sales = await prisma.sale.findMany({
    where,
    select: {
      quantity:   true,
      totalValue: true,
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      ...FILE_CURRENCY_SELECT,
    },
  });

  return aggregateSales(sales);
}

/**
 * Raw SQL version of getSalesAggregates for large datasets.
 * Returns the same shape as aggregateSales().
 *
 * @param {number}   repId
 * @param {number[]|null} areaIds
 * @param {number[]|null} itemIds
 */
export async function getSalesAggregatesRaw(repId, areaIds, itemIds) {
  const areaClause = areaIds ? `AND s.area_id = ANY(ARRAY[${areaIds.join(',')}])` : '';
  const itemClause = itemIds ? `AND s.item_id = ANY(ARRAY[${itemIds.join(',')}])` : '';

  const [byArea, byItem] = await Promise.all([
    // Breakdown by area
    prisma.$queryRawUnsafe(`
      SELECT
        a.id          AS "areaId",
        a.name        AS "areaName",
        SUM(s.quantity)::int        AS "totalQuantity",
        SUM(s.total_value)::float   AS "totalValue"
      FROM sales s
      INNER JOIN areas a ON a.id = s.area_id
      WHERE s.representative_id = $1
        ${areaClause}
        ${itemClause}
      GROUP BY a.id, a.name
      ORDER BY "totalValue" DESC
    `, repId),

    // Breakdown by item
    prisma.$queryRawUnsafe(`
      SELECT
        i.id          AS "itemId",
        i.name        AS "itemName",
        SUM(s.quantity)::int        AS "totalQuantity",
        SUM(s.total_value)::float   AS "totalValue"
      FROM sales s
      INNER JOIN items i ON i.id = s.item_id
      WHERE s.representative_id = $1
        ${areaClause}
        ${itemClause}
      GROUP BY i.id, i.name
      ORDER BY "totalValue" DESC
    `, repId),
  ]);

  const totals = {
    totalQuantity: byArea.reduce((s, r) => s + r.totalQuantity, 0),
    totalValue:    byArea.reduce((s, r) => s + r.totalValue, 0),
  };

  return { byArea, byItem, totals };
}

// ─── Helpers ─────────────────────────────────────────────────

function buildDateFilter({ startDate, endDate }) {
  if (!startDate && !endDate) return {};
  const filter = {};
  if (startDate) filter.gte = new Date(startDate);
  if (endDate)   filter.lte = new Date(endDate);
  return { saleDate: filter };
}

/**
 * Aggregation for a scientific representative report.
 * Filters by multiple commercial-rep IDs + optional area/item lists.
 *
 * @param {number[]}      commRepIds  - commercial rep IDs assigned to this sci-rep
 * @param {number[]|null} areaIds     - null = all areas
 * @param {number[]|null} itemIds     - null = all items
 * @param {{ startDate?, endDate? }}  dateRange
 * @returns {{ totals, byArea, byItem, byRep }}
 */
export async function getSalesForScientificRep(commRepIds, areaIds, itemIds, dateRange = {}, fileIds = null, recordType = null) {
  const hasCommReps = commRepIds && commRepIds.length > 0;
  const hasAreas    = areaIds    && areaIds.length > 0;
  const hasItems    = itemIds    && itemIds.length > 0;

  // If no commercial reps assigned, fall back to area/item scope (requires at least fileIds or areas)
  if (!hasCommReps) {
    if (!fileIds && !hasAreas && !hasItems) {
      return { totals: { totalQuantity: 0, totalValue: 0 }, byArea: [], byItem: [], byRep: [] };
    }
  }

  const dateFilter = buildDateFilter(dateRange);
  const where = {
    ...(hasCommReps ? { representativeId: { in: commRepIds } } : {}),
    ...dateFilter,
    ...(hasAreas ? { areaId: { in: areaIds } } : {}),
    ...(hasItems ? { itemId: { in: itemIds } } : {}),
    ...buildFileIdsFilter(fileIds),
    ...(recordType ? { recordType } : {}),
  };

  const sales = await prisma.sale.findMany({
    where,
    select: {
      quantity:   true,
      totalValue: true,
      area:           { select: { id: true, name: true } },
      item:           { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
      ...FILE_CURRENCY_SELECT,
    },
  });

  return aggregateSalesWithReps(sales);
}

/**
 * Query returns for a scientific rep using only area/item scoping
 * (without restricting by commRepIds). This handles cases where return rows
 * in a mixed file are attributed to reps not directly assigned to the sci rep.
 *
 * @param {number[]|null} areaIds   - null = all areas
 * @param {number[]|null} itemIds   - null = all items
 * @param {{ startDate?, endDate? }} dateRange
 * @param {number[]|null} fileIds
 * @param {number|null}   userId    - scope to this user's data
 * @returns {{ totals, byArea, byItem, byRep }}
 */
export async function getReturnsForSciRepScope(areaIds, itemIds, dateRange = {}, fileIds = null, commRepIds = null) {
  // Safety guard: require fileIds to avoid returning all returns in the system
  if (!fileIds || (Array.isArray(fileIds) && fileIds.length === 0)) {
    return { totals: { totalQuantity: 0, totalValue: 0 }, byArea: [], byItem: [], byRep: [] };
  }

  const hasCommReps = commRepIds && commRepIds.length > 0;

  // areaIds/itemIds are already resolved cross-user (all IDs matching the assigned names),
  // so we can safely filter by them here.
  const dateFilter = buildDateFilter(dateRange);
  const where = {
    recordType: 'return',
    ...dateFilter,
    // Always restrict to assigned commercial reps when they are specified.
    // This prevents returns from unassigned reps that share the same area from leaking in.
    ...(hasCommReps ? { representativeId: { in: commRepIds } } : {}),
    ...(areaIds && areaIds.length ? { areaId: { in: areaIds } } : {}),
    ...(itemIds && itemIds.length ? { itemId: { in: itemIds } } : {}),
    ...buildFileIdsFilter(fileIds),
  };

  const sales = await prisma.sale.findMany({
    where,
    select: {
      quantity:   true,
      totalValue: true,
      area:           { select: { id: true, name: true } },
      item:           { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
      ...FILE_CURRENCY_SELECT,
    },
  });

  return aggregateSalesWithReps(sales);
}

/**
 * In-memory aggregation of Prisma sale records.
 * Groups by area and item, accumulates quantity + value.
 */
function aggregateSales(sales) {
  const areaMap = new Map();
  const itemMap = new Map();
  let totalQuantity = 0;
  let totalValue    = 0;

  for (const sale of sales) {
    const qty = sale.quantity;
    const val = saleValueUSD(sale);

    totalQuantity += qty;
    totalValue    += val;

    // By area
    if (!areaMap.has(sale.area.id)) {
      areaMap.set(sale.area.id, { areaId: sale.area.id, areaName: sale.area.name, totalQuantity: 0, totalValue: 0 });
    }
    areaMap.get(sale.area.id).totalQuantity += qty;
    areaMap.get(sale.area.id).totalValue    += val;

    // By item
    if (!itemMap.has(sale.item.id)) {
      itemMap.set(sale.item.id, { itemId: sale.item.id, itemName: sale.item.name, totalQuantity: 0, totalValue: 0 });
    }
    itemMap.get(sale.item.id).totalQuantity += qty;
    itemMap.get(sale.item.id).totalValue    += val;
  }

  const byArea = [...areaMap.values()].sort((a, b) => b.totalValue - a.totalValue);
  const byItem = [...itemMap.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));

  return {
    totals: { totalQuantity, totalValue: +totalValue.toFixed(2) },
    byArea,
    byItem,
  };
}

/**
 * Same as aggregateSales but also groups by commercial representative,
 * and groups byArea by (area + rep) so each row shows area + its commercial rep.
 */
export function aggregateSalesWithReps(sales) {
  const areaRepMap = new Map(); // key = "areaId-repId"
  const itemMap    = new Map();
  const repMap     = new Map();
  let totalQuantity = 0;
  let totalValue    = 0;

  for (const sale of sales) {
    const qty = sale.quantity;
    const val = saleValueUSD(sale);
    totalQuantity += qty;
    totalValue    += val;

    // By (area + commercial rep) combination
    const arKey = `${sale.area.id}-${sale.representative.id}`;
    if (!areaRepMap.has(arKey)) {
      areaRepMap.set(arKey, {
        areaId:    sale.area.id,
        areaName:  sale.area.name,
        repId:     sale.representative.id,
        repName:   sale.representative.name,
        totalQuantity: 0,
        totalValue:    0,
      });
    }
    areaRepMap.get(arKey).totalQuantity += qty;
    areaRepMap.get(arKey).totalValue    += val;

    // By item
    if (!itemMap.has(sale.item.id)) {
      itemMap.set(sale.item.id, { itemId: sale.item.id, itemName: sale.item.name, totalQuantity: 0, totalValue: 0 });
    }
    itemMap.get(sale.item.id).totalQuantity += qty;
    itemMap.get(sale.item.id).totalValue    += val;

    // By commercial rep
    if (!repMap.has(sale.representative.id)) {
      repMap.set(sale.representative.id, { repId: sale.representative.id, repName: sale.representative.name, totalQuantity: 0, totalValue: 0 });
    }
    repMap.get(sale.representative.id).totalQuantity += qty;
    repMap.get(sale.representative.id).totalValue    += val;
  }

  return {
    totals: { totalQuantity, totalValue: +totalValue.toFixed(2) },
    byArea: [...areaRepMap.values()].sort((a, b) => b.totalValue - a.totalValue),
    byItem: [...itemMap.values()].sort((a, b) => a.itemName.localeCompare(b.itemName)),
    byRep:  [...repMap.values()].sort((a, b) => b.totalValue - a.totalValue),
  };
}
