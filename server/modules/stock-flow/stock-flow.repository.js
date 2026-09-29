/**
 * Stock Flow Repository — كل عمليات قاعدة البيانات لصفحة «تحريك المذاخر».
 * كل صف (ستوك أو مبيع فريق) مفتاحه (مذخر × ايتم) — نفس تفصيل «رصيد المذاخر».
 */

import prisma from '../../lib/prisma.js';

const ownerWhere = (userIds) => Array.isArray(userIds) ? { userId: { in: userIds } } : { userId: userIds };

// ─── نقاط العدّ (الستوك الافتتاحي/الثانوي) ──────────────────────
export async function getCounts(warehouseIds) {
  return prisma.stockCount.findMany({
    where: { warehouseId: { in: warehouseIds } },
    orderBy: [{ warehouseId: 'asc' }, { itemKey: 'asc' }, { countDate: 'asc' }],
  });
}

export async function upsertCount({ userId, warehouseId, itemKey, itemName, companyName, itemId, countDate, qty, note }) {
  return prisma.stockCount.upsert({
    where: { warehouseId_itemKey_countDate: { warehouseId, itemKey, countDate } },
    update: { qty, itemName, companyName: companyName ?? null, itemId: itemId ?? null, note: note ?? null },
    create: { userId, warehouseId, itemKey, itemName, companyName: companyName ?? null, itemId: itemId ?? null, countDate, qty, note: note ?? null },
  });
}

export async function findCount(id, userIds) {
  return prisma.stockCount.findFirst({ where: { id, ...ownerWhere(userIds) } });
}

export async function deleteCount(id) {
  return prisma.stockCount.delete({ where: { id } });
}

// ─── التعزيز — قراءة فقط من StockMovement الحالي (direction='in') ─
export async function getInMovements(warehouseIds) {
  return prisma.stockMovement.findMany({
    where: { warehouseId: { in: warehouseIds }, direction: 'in' },
    select: { warehouseId: true, itemKey: true, qty: true, movementDate: true },
  });
}

// ─── مبيعات الفرق (تجاري/علمي) ───────────────────────────────────
export async function getTeamSales(warehouseIds) {
  return prisma.warehouseTeamSale.findMany({
    where: { warehouseId: { in: warehouseIds } },
    orderBy: [{ asOfDate: 'desc' }],
  });
}

export async function upsertTeamSale({ userId, warehouseId, itemKey, itemName, companyName, itemId, asOfDate, team, qty, sourceLabel }) {
  return prisma.warehouseTeamSale.upsert({
    where: { warehouseId_itemKey_asOfDate_team: { warehouseId, itemKey, asOfDate, team } },
    update: { qty, itemName, companyName: companyName ?? null, itemId: itemId ?? null, sourceLabel: sourceLabel ?? null, uploadedAt: new Date() },
    create: { userId, warehouseId, itemKey, itemName, companyName: companyName ?? null, itemId: itemId ?? null, asOfDate, team, qty, sourceLabel: sourceLabel ?? null },
  });
}

export async function findTeamSale(id, userIds) {
  return prisma.warehouseTeamSale.findFirst({ where: { id, ...ownerWhere(userIds) } });
}

export async function deleteTeamSale(id) {
  return prisma.warehouseTeamSale.delete({ where: { id } });
}

export { prisma };
