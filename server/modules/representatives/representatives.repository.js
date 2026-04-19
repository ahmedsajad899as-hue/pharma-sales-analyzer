/**
 * Representatives Repository
 * All database operations for the representatives module.
 */

import prisma from '../../lib/prisma.js';

/**
 * Create a new medical representative.
 * @param {{ name, phone?, email? }} data
 */
export async function createRepresentative(data) {
  return prisma.medicalRepresentative.create({
    data,
    select: representativeSelect(),
  });
}

/**
 * Find representative by ID with assigned areas and items.
 * @param {number} id
 */
export async function findRepresentativeById(id) {
  return prisma.medicalRepresentative.findUnique({
    where: { id },
    select: {
      ...representativeSelect(),
      areas: { select: { area: { select: { id: true, name: true } } } },
      items: { select: { item: { select: { id: true, name: true } } } },
    },
  });
}

/**
 * List all active representatives with area/item counts.
 * @param {{ isActive?: boolean }} filters
 * @param {number[]|null} fileIds  - if provided, only reps with sales in those files
 */
export async function listRepresentatives(filters = {}, fileIds = null) {
  const fileIdsArr = fileIds ? (Array.isArray(fileIds) ? fileIds : [fileIds]) : null;
  return prisma.medicalRepresentative.findMany({
    where: {
      ...filters,
      // Exclude placeholder reps created by matrix imports (name = 'غير محدد')
      NOT: { name: { in: ['غير محدد', 'غير محده'] } },
      ...(fileIdsArr && fileIdsArr.length
        ? { sales: { some: { uploadedFileId: fileIdsArr.length === 1 ? fileIdsArr[0] : { in: fileIdsArr } } } }
        : {}),
    },
    select: {
      ...representativeSelect(),
      areas: { select: { area: { select: { id: true, name: true } } } },
      items: { select: { item: { select: { id: true, name: true } } } },
      _count: { select: { areas: true, items: true, sales: true } },
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Update a representative's core fields.
 * @param {number} id
 * @param {{ name?, phone?, email?, isActive? }} data
 */
export async function updateRepresentative(id, data) {
  return prisma.medicalRepresentative.update({
    where: { id },
    data,
    select: representativeSelect(),
  });
}

/**
 * Delete a representative (hard delete).
 * @param {number} id
 */
export async function deleteRepresentative(id) {
  return prisma.medicalRepresentative.delete({ where: { id } });
}

/**
 * Replace the area assignments of a representative.
 * Uses a transaction to delete old + create new in one round-trip.
 * @param {number} repId
 * @param {number[]} areaIds
 */
export async function setRepresentativeAreas(repId, areaIds) {
  return prisma.$transaction([
    prisma.representativeArea.deleteMany({ where: { representativeId: repId } }),
    prisma.representativeArea.createMany({
      data: areaIds.map(areaId => ({ representativeId: repId, areaId })),
    }),
  ]);
}

/**
 * Replace the item assignments of a representative.
 * @param {number} repId
 * @param {number[]} itemIds
 */
export async function setRepresentativeItems(repId, itemIds) {
  return prisma.$transaction([
    prisma.representativeItem.deleteMany({ where: { representativeId: repId } }),
    prisma.representativeItem.createMany({
      data: itemIds.map(itemId => ({ representativeId: repId, itemId })),
    }),
  ]);
}

/**
 * Remove all area assignments (rep now covers ALL areas).
 * @param {number} repId
 */
export async function clearRepresentativeAreas(repId) {
  return prisma.representativeArea.deleteMany({ where: { representativeId: repId } });
}

/**
 * Remove all item assignments (rep now covers ALL items).
 * @param {number} repId
 */
export async function clearRepresentativeItems(repId) {
  return prisma.representativeItem.deleteMany({ where: { representativeId: repId } });
}

/**
 * Get just the assigned area IDs for a representative.
 * Returns null if no areas assigned (= all areas).
 * @param {number} repId
 * @returns {number[]|null}
 */
export async function getAssignedAreaIds(repId) {
  const rows = await prisma.representativeArea.findMany({
    where:  { representativeId: repId },
    select: { areaId: true },
  });
  return rows.length > 0 ? rows.map(r => r.areaId) : null;
}

/**
 * Get just the assigned item IDs for a representative.
 * Returns null if no items assigned (= all items).
 * @param {number} repId
 * @returns {number[]|null}
 */
export async function getAssignedItemIds(repId) {
  const rows = await prisma.representativeItem.findMany({
    where:  { representativeId: repId },
    select: { itemId: true },
  });
  return rows.length > 0 ? rows.map(r => r.itemId) : null;
}

/**
 * Get all reps with their distinct areas derived from actual sales records.
 * Used by the scientific-rep assignment UI.
 */
export async function getRepsWithSalesAreas(userId = null) {
  return prisma.medicalRepresentative.findMany({
    where: userId ? { userId } : {},
    select: {
      id:   true,
      name: true,
      sales: {
        select: { area: { select: { id: true, name: true } } },
        distinct: ['areaId'],
        orderBy: { area: { name: 'asc' } },
      },
    },
    orderBy: { name: 'asc' },
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function representativeSelect() {
  return {
    id:        true,
    name:      true,
    phone:     true,
    email:     true,
    isActive:  true,
    createdAt: true,
    updatedAt: true,
  };
}
