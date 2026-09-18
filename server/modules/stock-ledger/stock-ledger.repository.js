/**
 * Stock Ledger Repository — كل عمليات قاعدة البيانات لدفتر رصيد المذاخر.
 */

import prisma from '../../lib/prisma.js';

// القراءة تقبل دفتراً واحداً (رقم) أو اتحاد دفاتر (مصفوفة) — المدير يقرأ دفاتر
// موظفي مكتبه مع دفتره (راجع lib/stockLedgerScope.js)؛ الاستيعاب يبقى بدفتر واحد.
const ownerWhere = (userIds) => Array.isArray(userIds) ? { userId: { in: userIds } } : { userId: userIds };

// ─── المذاخر ──────────────────────────────────────────────────
export async function getWarehouses(userIds) {
  return prisma.stockWarehouse.findMany({
    where: ownerWhere(userIds),
    orderBy: [{ region: 'asc' }, { name: 'asc' }],
  });
}

export async function createWarehouse({ userId, name, nameKey, region, regionKey }) {
  return prisma.stockWarehouse.create({ data: { userId, name, nameKey, region, regionKey } });
}

// ─── الدفعات ──────────────────────────────────────────────────
export async function createBatch({ userId, kind, name, sourceFileId, movementDate }) {
  return prisma.stockMovementBatch.create({
    data: { userId, kind, name, sourceFileId: sourceFileId ?? null, movementDate, rowCount: 0 },
  });
}

export async function finalizeBatch(batchId, { rowCount, unmatched }) {
  return prisma.stockMovementBatch.update({
    where: { id: batchId },
    data: { rowCount, unmatched: unmatched ? JSON.stringify(unmatched) : null },
  });
}

export async function getBatches(userIds) {
  return prisma.stockMovementBatch.findMany({
    where: ownerWhere(userIds),
    orderBy: [{ movementDate: 'desc' }, { uploadedAt: 'desc' }],
  });
}

export async function getBatchById(id, userIds) {
  return prisma.stockMovementBatch.findFirst({ where: { id, ...ownerWhere(userIds) } });
}

/** معرّفات المذاخر المتأثرة بدفعة — تُقرأ قبل الحذف لتحديد نطاق إعادة الحساب */
export async function getBatchWarehouseIds(batchId) {
  const rows = await prisma.stockMovement.findMany({
    where: { batchId },
    select: { warehouseId: true },
    distinct: ['warehouseId'],
  });
  return rows.map(r => r.warehouseId);
}

export async function deleteBatch(id, userId) {
  return prisma.stockMovementBatch.deleteMany({ where: { id, userId } });
}

/** دفعات الستوك الافتتاحي المشتقة من ملف Stock (SalesDataFile) محدَّد، لحساب واحد */
export async function getBatchIdsBySourceFile(userId, sourceFileId) {
  const rows = await prisma.stockMovementBatch.findMany({
    where: { userId, sourceFileId },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

export async function deleteBatchesByIds(ids, userId) {
  return prisma.stockMovementBatch.deleteMany({ where: { id: { in: ids }, userId } });
}

// ─── الحركات ──────────────────────────────────────────────────
export async function bulkInsertMovements(movements) {
  if (!movements.length) return;
  const CHUNK = 2000;
  for (let i = 0; i < movements.length; i += CHUNK) {
    await prisma.stockMovement.createMany({ data: movements.slice(i, i + CHUNK) });
  }
}

export async function getPairHistory({ userIds, warehouseId, itemKey }) {
  return prisma.stockMovement.findMany({
    where: { ...ownerWhere(userIds), warehouseId, itemKey },
    orderBy: [{ movementDate: 'desc' }, { id: 'desc' }],
    include: { batch: { select: { id: true, name: true, kind: true, uploadedAt: true } } },
    take: 500,
  });
}

// ─── الأرصدة ──────────────────────────────────────────────────
export async function getBalances(userIds, { warehouseIds = null, scopeWhere = {} } = {}) {
  return prisma.stockBalance.findMany({
    where: { ...ownerWhere(userIds), ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}), ...scopeWhere },
    include: { warehouse: { select: { id: true, name: true, region: true } } },
    orderBy: [{ remaining: 'asc' }],
  });
}

export { prisma };
