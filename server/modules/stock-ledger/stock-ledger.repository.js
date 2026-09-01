/**
 * Stock Ledger Repository — كل عمليات قاعدة البيانات لدفتر رصيد المذاخر.
 */

import prisma from '../../lib/prisma.js';

// ─── المذاخر ──────────────────────────────────────────────────
export async function getWarehouses(userId) {
  return prisma.stockWarehouse.findMany({
    where: { userId },
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

export async function getBatches(userId) {
  return prisma.stockMovementBatch.findMany({
    where: { userId },
    orderBy: [{ movementDate: 'desc' }, { uploadedAt: 'desc' }],
  });
}

export async function getBatchById(id, userId) {
  return prisma.stockMovementBatch.findFirst({ where: { id, userId } });
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

// ─── الحركات ──────────────────────────────────────────────────
export async function bulkInsertMovements(movements) {
  if (!movements.length) return;
  const CHUNK = 2000;
  for (let i = 0; i < movements.length; i += CHUNK) {
    await prisma.stockMovement.createMany({ data: movements.slice(i, i + CHUNK) });
  }
}

export async function getPairHistory({ userId, warehouseId, itemKey }) {
  return prisma.stockMovement.findMany({
    where: { userId, warehouseId, itemKey },
    orderBy: [{ movementDate: 'desc' }, { id: 'desc' }],
    include: { batch: { select: { id: true, name: true, kind: true, uploadedAt: true } } },
    take: 500,
  });
}

// ─── الأرصدة ──────────────────────────────────────────────────
export async function getBalances(userId, { warehouseIds = null } = {}) {
  return prisma.stockBalance.findMany({
    where: { userId, ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}) },
    include: { warehouse: { select: { id: true, name: true, region: true } } },
    orderBy: [{ remaining: 'asc' }],
  });
}

export { prisma };
