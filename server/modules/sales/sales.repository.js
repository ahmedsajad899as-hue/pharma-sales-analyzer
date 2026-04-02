/**
 * Sales Repository
 * Responsible for all database operations related to sales data.
 * Uses Prisma for type-safe queries.
 */

import prisma from '../../lib/prisma.js';

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
 * Upsert an Area by name scoped to userId. Returns the area record.
 * @param {string} name
 * @param {number} userId
 */
export async function findOrCreateArea(name, userId) {
  return prisma.area.upsert({
    where:  { name_userId: { name, userId } },
    update: {},
    create: { name, userId },
  });
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
export async function findOrCreateItem(name, userId) {
  return prisma.item.upsert({
    where:  { name_userId: { name, userId } },
    update: {},
    create: { name, userId },
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
 * Merge a duplicate item into a canonical item:
 *  - Re-point all Sales that reference `fromId` → `toId`
 *  - Re-point all RepresentativeItem rows that reference `fromId` → `toId`
 *    (skip if the canonical already has that rep-item pair)
 *  - Delete the duplicate item record.
 * @param {number} fromId  – duplicate item id
 * @param {number} toId    – canonical (kept) item id
 */
export async function mergeItems(fromId, toId) {
  if (fromId === toId) return;
  await prisma.$transaction([
    // Update sales
    prisma.sale.updateMany({ where: { itemId: fromId }, data: { itemId: toId } }),
    // Delete old rep-item pairs for fromId (canonical will already have or get them)
    prisma.representativeItem.deleteMany({ where: { itemId: fromId } }),
    // Delete the duplicate item
    prisma.item.delete({ where: { id: fromId } }),
  ]);
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
  if (!commRepIds || commRepIds.length === 0) {
    return { totals: { totalQuantity: 0, totalValue: 0 }, byArea: [], byItem: [], byRep: [] };
  }

  const dateFilter = buildDateFilter(dateRange);
  const where = {
    representativeId: { in: commRepIds },
    ...dateFilter,
    ...(areaIds && areaIds.length ? { areaId: { in: areaIds } } : {}),
    ...(itemIds && itemIds.length ? { itemId: { in: itemIds } } : {}),
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
export async function getReturnsForSciRepScope(areaIds, itemIds, dateRange = {}, fileIds = null, userId = null) {
  // Safety guard: require at least a fileIds scope to avoid returning everything
  if (!fileIds || (Array.isArray(fileIds) && fileIds.length === 0)) {
    return { totals: { totalQuantity: 0, totalValue: 0 }, byArea: [], byItem: [], byRep: [] };
  }

  // NOTE: We intentionally do NOT filter by areaIds or itemIds here.
  // Return rows in a mixed file may be saved under different area records than
  // what the sci rep has assigned (due to fuzzy-matching differences during upload),
  // so restricting by area IDs would silently exclude valid returns.
  // Scoping by fileIds (active uploaded files) + optional userId is sufficient.
  const dateFilter = buildDateFilter(dateRange);
  const where = {
    recordType: 'return',
    ...dateFilter,
    ...buildFileIdsFilter(fileIds),
    ...(userId ? { userId } : {}),
  };

  const sales = await prisma.sale.findMany({
    where,
    select: {
      quantity:   true,
      totalValue: true,
      area:           { select: { id: true, name: true } },
      item:           { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
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
    const val = Number(sale.totalValue);

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
  const byItem = [...itemMap.values()].sort((a, b) => b.totalValue - a.totalValue);

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
function aggregateSalesWithReps(sales) {
  const areaRepMap = new Map(); // key = "areaId-repId"
  const itemMap    = new Map();
  const repMap     = new Map();
  let totalQuantity = 0;
  let totalValue    = 0;

  for (const sale of sales) {
    const qty = sale.quantity;
    const val = Number(sale.totalValue);
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
    byItem: [...itemMap.values()].sort((a, b) => b.totalValue - a.totalValue),
    byRep:  [...repMap.values()].sort((a, b) => b.totalValue - a.totalValue),
  };
}
