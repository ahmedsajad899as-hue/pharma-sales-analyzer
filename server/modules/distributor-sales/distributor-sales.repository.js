/**
 * Distributor Sales Repository
 * All DB operations for distributor sales uploads and analysis.
 */

import prisma from '../../lib/prisma.js';

// ─── Upload CRUD ──────────────────────────────────────────────

export async function createUpload({ originalName, filename, rowCount, userId }) {
  return prisma.distributorSalesUpload.create({
    data: { originalName, filename, rowCount, userId },
  });
}

export async function bulkInsertRecords(uploadId, records, userId) {
  if (!records.length) return;
  await prisma.distributorSaleRecord.createMany({
    data: records.map(r => ({ ...r, uploadId, userId })),
  });
}

export async function getUploads(userId) {
  return prisma.distributorSalesUpload.findMany({
    where: { userId },
    orderBy: { uploadedAt: 'desc' },
    select: {
      id: true,
      originalName: true,
      rowCount: true,
      uploadedAt: true,
    },
  });
}

export async function getUploadById(id, userId) {
  return prisma.distributorSalesUpload.findFirst({
    where: { id: parseInt(id), userId },
  });
}

export async function deleteUploadById(id, userId) {
  // Cascade deletes records too (onDelete: Cascade in schema)
  return prisma.distributorSalesUpload.deleteMany({
    where: { id: parseInt(id), userId },
  });
}

// ─── Analysis Queries ─────────────────────────────────────────

function buildWhere(userId, uploadId) {
  const where = { userId };
  if (uploadId) where.uploadId = parseInt(uploadId);
  return where;
}

/** KPI summary */
export async function getKPIs(userId, uploadId) {
  const where = buildWhere(userId, uploadId);

  const agg = await prisma.distributorSaleRecord.aggregate({
    where,
    _count: { id: true },
    _sum: {
      month3Qty: true,
      month4Qty: true,
      totalQtySold: true,
      reinvoicingCount: true,
    },
  });

  const reinvoicingItems = await prisma.distributorSaleRecord.count({
    where: { ...where, reinvoicingCount: { gt: 0 } },
  });

  const zeroMovement = await prisma.distributorSaleRecord.count({
    where: { ...where, month3Qty: { gt: 0 }, month4Qty: 0 },
  });

  const staleThreshold = new Date();
  staleThreshold.setDate(staleThreshold.getDate() - 90);
  const staleItems = await prisma.distributorSaleRecord.count({
    where: {
      ...where,
      saleDate: { lt: staleThreshold, not: null },
    },
  });

  const m3 = agg._sum.month3Qty || 0;
  const m4 = agg._sum.month4Qty || 0;
  const growthPct = m3 > 0 ? ((m4 - m3) / m3) * 100 : null;

  return {
    totalRecords: agg._count.id,
    totalMonth3: m3,
    totalMonth4: m4,
    totalSold: agg._sum.totalQtySold || 0,
    totalReinvoicing: agg._sum.reinvoicingCount || 0,
    growthPct: growthPct !== null ? Math.round(growthPct * 10) / 10 : null,
    reinvoicingItems,
    zeroMovement,
    staleItems,
  };
}

/** By-team aggregation */
export async function getByTeam(userId, uploadId) {
  const where = buildWhere(userId, uploadId);

  const rows = await prisma.distributorSaleRecord.groupBy({
    by: ['teamName'],
    where,
    _sum: { month3Qty: true, month4Qty: true, totalQtySold: true, reinvoicingCount: true },
    _count: { id: true },
    orderBy: { _sum: { totalQtySold: 'desc' } },
  });

  return rows.map(r => {
    const m3 = r._sum.month3Qty || 0;
    const m4 = r._sum.month4Qty || 0;
    const growth = m3 > 0 ? Math.round(((m4 - m3) / m3) * 1000) / 10 : null;
    return {
      teamName: r.teamName || 'Unknown',
      month3: m3,
      month4: m4,
      totalSold: r._sum.totalQtySold || 0,
      reinvoicing: r._sum.reinvoicingCount || 0,
      itemCount: r._count.id,
      growthPct: growth,
    };
  });
}

/** By-distributor aggregation */
export async function getByDistributor(userId, uploadId) {
  const where = buildWhere(userId, uploadId);

  const rows = await prisma.distributorSaleRecord.groupBy({
    by: ['distributorName', 'teamName'],
    where,
    _sum: { month3Qty: true, month4Qty: true, totalQtySold: true, reinvoicingCount: true },
    _count: { id: true },
    orderBy: { _sum: { totalQtySold: 'desc' } },
  });

  const totalSoldAll = rows.reduce((s, r) => s + (r._sum.totalQtySold || 0), 0);

  return rows.map(r => {
    const m3 = r._sum.month3Qty || 0;
    const m4 = r._sum.month4Qty || 0;
    const growth = m3 > 0 ? Math.round(((m4 - m3) / m3) * 1000) / 10 : null;
    const totalSold = r._sum.totalQtySold || 0;
    return {
      distributorName: r.distributorName,
      teamName: r.teamName || 'Unknown',
      month3: m3,
      month4: m4,
      totalSold,
      reinvoicing: r._sum.reinvoicingCount || 0,
      itemCount: r._count.id,
      growthPct: growth,
      sharePct: totalSoldAll > 0 ? Math.round((totalSold / totalSoldAll) * 1000) / 10 : 0,
    };
  });
}

/** By-item aggregation (for ranking + growth) */
export async function getByItem(userId, uploadId) {
  const where = buildWhere(userId, uploadId);

  const rows = await prisma.distributorSaleRecord.groupBy({
    by: ['itemName'],
    where,
    _sum: { month3Qty: true, month4Qty: true, totalQtySold: true, reinvoicingCount: true },
    _count: { id: true },
    orderBy: { _sum: { totalQtySold: 'desc' } },
  });

  return rows.map(r => {
    const m3 = r._sum.month3Qty || 0;
    const m4 = r._sum.month4Qty || 0;
    const growth = m3 > 0 ? Math.round(((m4 - m3) / m3) * 1000) / 10 : null;
    const status =
      m4 === 0 && m3 > 0 ? 'stopped' :
      growth === null ? 'new' :
      growth > 0 ? 'growing' :
      growth === 0 ? 'stable' : 'declining';

    return {
      itemName: r.itemName,
      month3: m3,
      month4: m4,
      totalSold: r._sum.totalQtySold || 0,
      reinvoicing: r._sum.reinvoicingCount || 0,
      distributorCount: r._count.id,
      growthPct: growth,
      status, // growing | stable | declining | stopped | new
    };
  });
}

/** Items needing reinvoicing */
export async function getReinvoicing(userId, uploadId) {
  const where = { ...buildWhere(userId, uploadId), reinvoicingCount: { gt: 0 } };

  const rows = await prisma.distributorSaleRecord.findMany({
    where,
    orderBy: { reinvoicingCount: 'desc' },
    select: {
      id: true,
      teamName: true,
      distributorName: true,
      itemName: true,
      month3Qty: true,
      month4Qty: true,
      saleDate: true,
      totalQtySold: true,
      reinvoicingCount: true,
    },
  });

  return rows;
}
