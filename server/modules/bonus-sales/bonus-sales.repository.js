/**
 * Bonus Sales Repository
 * All DB operations via Prisma.
 */

import prisma from '../../lib/prisma.js';

// ─── Sales Upload ─────────────────────────────────────────────
export async function createSalesUpload({ originalName, rowCount, userId }) {
  return prisma.bonusSalesUpload.create({
    data: { originalName, rowCount, userId },
  });
}

export async function bulkInsertSalesRows(uploadId, rows) {
  if (!rows.length) return;
  await prisma.bonusSalesRow.createMany({
    data: rows.map(r => ({ ...r, uploadId })),
    skipDuplicates: false,
  });
}

export async function getSalesUploads(userId) {
  return prisma.bonusSalesUpload.findMany({
    where: { userId },
    orderBy: { uploadedAt: 'desc' },
    include: {
      _count: { select: { rows: true } },
      compUploads: { select: { id: true, originalName: true, uploadedAt: true, rowCount: true } },
    },
  });
}

export async function getSalesUploadById(id, userId) {
  return prisma.bonusSalesUpload.findFirst({
    where: { id: Number(id), userId },
  });
}

export async function deleteSalesUploadById(id) {
  return prisma.bonusSalesUpload.delete({ where: { id: Number(id) } });
}

export async function getSalesRowsPage({ uploadId, page, pageSize, filters }) {
  const where = { uploadId: Number(uploadId) };

  // Smart search: OR across pharmacy, item, area, rep, warehouse
  if (filters.search) {
    where.OR = [
      { pharmacyName: { contains: filters.search, mode: 'insensitive' } },
      { itemName:     { contains: filters.search, mode: 'insensitive' } },
      { areaName:     { contains: filters.search, mode: 'insensitive' } },
      { repName:      { contains: filters.search, mode: 'insensitive' } },
      { warehouse:    { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  if (filters.pharmacyName) where.pharmacyName = { contains: filters.pharmacyName, mode: 'insensitive' };
  if (filters.repName)      where.repName      = { contains: filters.repName,      mode: 'insensitive' };
  if (filters.itemName)     where.itemName     = { contains: filters.itemName,     mode: 'insensitive' };
  if (filters.hasBonus      !== undefined) where.hasBonus      = filters.hasBonus;
  if (filters.isCompensated !== undefined) where.isCompensated = filters.isCompensated;
  if (filters.bonusDelivered !== undefined) where.bonusDelivered = filters.bonusDelivered;

  const skip = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    prisma.bonusSalesRow.findMany({
      where,
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
      include: {
        deliveredByUser: { select: { id: true, displayName: true, username: true } },
        assignments: {
          include: { user: { select: { id: true, displayName: true, username: true } } },
        },
      },
    }),
    prisma.bonusSalesRow.count({ where }),
  ]);
  return { rows, total };
}

// ─── Rep's assigned rows (paginated) ─────────────────────────
export async function getMyBonusRows({ userId, page, pageSize, filters = {} }) {
  const where = {
    assignments: { some: { userId: Number(userId) } },
  };

  if (filters.search) {
    where.OR = [
      { pharmacyName: { contains: filters.search, mode: 'insensitive' } },
      { itemName:     { contains: filters.search, mode: 'insensitive' } },
      { areaName:     { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  if (filters.bonusDelivered !== undefined) where.bonusDelivered = filters.bonusDelivered;
  if (filters.hasBonus !== undefined) where.hasBonus = filters.hasBonus;

  const skip = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    prisma.bonusSalesRow.findMany({
      where,
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
      include: {
        deliveredByUser: { select: { id: true, displayName: true, username: true } },
      },
    }),
    prisma.bonusSalesRow.count({ where }),
  ]);
  return { rows, total };
}

// ─── Compensation Upload ──────────────────────────────────────
export async function createCompUpload({ originalName, rowCount, userId, salesUploadId }) {
  return prisma.bonusCompUpload.create({
    data: { originalName, rowCount, userId, salesUploadId },
  });
}

export async function bulkInsertCompRows(uploadId, rows) {
  if (!rows.length) return;
  // Strip fields that belong only to BonusSalesRow (hasBonus is computed by parseFile but not in BonusCompRow schema)
  await prisma.bonusCompRow.createMany({
    data: rows.map(({ hasBonus: _h, ...r }) => ({ ...r, uploadId })),
    skipDuplicates: false,
  });
}

export async function getCompRowsByUpload(uploadId) {
  return prisma.bonusCompRow.findMany({ where: { uploadId: Number(uploadId) } });
}

export async function getSalesRowsByUpload(uploadId) {
  return prisma.bonusSalesRow.findMany({ where: { uploadId: Number(uploadId) } });
}

// Update matched sales rows to isCompensated = true
export async function markRowsCompensated(matchedIds, compRowIdMap) {
  // matchedIds: salesRowId[] ; compRowIdMap: salesRowId -> compRowId
  for (const salesId of matchedIds) {
    await prisma.bonusSalesRow.update({
      where: { id: salesId },
      data: { isCompensated: true, compRowId: compRowIdMap[salesId] ?? null },
    });
  }
}

export async function getCompUploads(userId) {
  return prisma.bonusCompUpload.findMany({
    where: { userId },
    orderBy: { uploadedAt: 'desc' },
    include: { _count: { select: { rows: true } } },
  });
}

export async function getCompUploadById(id, userId) {
  return prisma.bonusCompUpload.findFirst({ where: { id: Number(id), userId } });
}

export async function deleteCompUploadById(id) {
  return prisma.bonusCompUpload.delete({ where: { id: Number(id) } });
}

// ─── Delivery ─────────────────────────────────────────────────
export async function setSalesRowDelivery(id, { delivered, userId, note }) {
  return prisma.bonusSalesRow.update({
    where: { id: Number(id) },
    data: {
      bonusDelivered:    delivered,
      deliveredAt:       delivered ? new Date() : null,
      deliveredByUserId: delivered ? userId : null,
      deliveryNote:      note ?? null,
    },
  });
}
