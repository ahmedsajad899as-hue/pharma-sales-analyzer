/**
 * Representatives Service
 * Business logic for managing medical representatives and generating reports.
 * Applies the "no assignments = all" rule for areas and items.
 */

import * as repRepo  from './representatives.repository.js';
import * as salesRepo from '../sales/sales.repository.js';
import { findOrCreateArea } from '../sales/sales.repository.js';
import { AppError }  from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';
import { resolveEffectiveAreaIds } from '../../lib/areaScope.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';

// ─── CRUD ────────────────────────────────────────────────────

/**
 * Create a new representative.
 * @param {{ name, phone?, email? }} dto
 */
export async function createRepresentative(dto) {
  return repRepo.createRepresentative(dto);
}

/**
 * Get a representative by ID with full area/item assignments.
 * @param {number} id
 */
export async function getRepresentativeById(id) {
  const rep = await repRepo.findRepresentativeById(id);
  if (!rep) throw new AppError(`Representative with id ${id} not found.`, 404, 'NOT_FOUND');

  // Flatten nested relations
  return formatRepresentative(rep);
}

/**
 * List all representatives with assignment counts.
 * @param {{ isActive?: boolean }} filters
 */
export async function listRepresentatives(filters = {}, fileIds = null, userId = null) {
  // MedicalRepresentative records belong to the file OWNER's userId — filtering
  // directly by the CALLER's own userId returns nothing for anyone viewing files
  // shared with them (office_manager/company_manager viewing an office_employee's
  // broadcast, or a rep viewing a manager's transferred file) — this was exactly
  // why the "اكتب اسم مندوب تجاري…" autocomplete came back empty for those accounts.
  // Fix: resolve every file the caller can access (owned OR shared via
  // FileUserShare) and scope by THOSE files' sales instead of raw ownership.
  let effectiveFileIds = fileIds;
  if (userId != null) {
    const accessible = await prisma.uploadedFile.findMany({
      where: { OR: [{ userId }, { fileShares: { some: { userId } } } ] },
      select: { id: true },
    });
    const accessibleIds = accessible.map(f => f.id);
    effectiveFileIds = (fileIds && fileIds.length > 0)
      ? fileIds.filter(id => accessibleIds.includes(id))
      : accessibleIds;
  }
  const reps = await repRepo.listRepresentatives(filters, effectiveFileIds);
  return reps.map(r => ({
    ...r,
    areasCount: r._count?.areas ?? 0,
    itemsCount: r._count?.items ?? 0,
    salesCount: r._count?.sales ?? 0,
    _count: undefined,
  }));
}

/**
 * Update a representative.
 * @param {number} id
 * @param {object} dto
 */
export async function updateRepresentative(id, dto) {
  await assertExists(id);
  return repRepo.updateRepresentative(id, dto);
}

/**
 * Delete a representative.
 * @param {number} id
 */
export async function deleteRepresentative(id) {
  await assertExists(id);
  return repRepo.deleteRepresentative(id);
}

/**
 * Return all reps with distinct areas from their actual sales.
 */
export async function getRepsWithSalesAreas(userId = null) {
  const rows = await repRepo.getRepsWithSalesAreas(userId);
  return rows.map(r => ({
    id:    r.id,
    name:  r.name,
    areas: r.sales.map(s => s.area).filter(Boolean),
  }));
}

// ─── Assignments ─────────────────────────────────────────────

/**
 * Assign specific areas to a representative (replaces existing).
 * @param {number}   repId
 * @param {number[]} areaIds
 */
export async function assignAreas(repId, areaIds) {
  await assertExists(repId);
  await repRepo.setRepresentativeAreas(repId, areaIds);
  return getRepresentativeById(repId);
}

/**
 * Find-or-create areas by name, then assign them to the rep.
 * @param {number}   repId
 * @param {string[]} areaNames
 */
export async function assignAreasByName(repId, areaNames, userId = null) {
  await assertExists(repId);
  // resolve each name to an area ID (creates if missing)
  const areas = await Promise.all(areaNames.map(name => findOrCreateArea(name, userId)));
  const areaIds = areas.map(a => a.id);
  await repRepo.setRepresentativeAreas(repId, areaIds);
  return getRepresentativeById(repId);
}

/**
 * Assign specific items to a representative (replaces existing).
 * @param {number}   repId
 * @param {number[]} itemIds
 */
export async function assignItems(repId, itemIds) {
  await assertExists(repId);
  await repRepo.setRepresentativeItems(repId, itemIds);
  return getRepresentativeById(repId);
}

/**
 * Remove all area restrictions (rep covers ALL areas).
 * @param {number} repId
 */
export async function clearAreas(repId) {
  await assertExists(repId);
  await repRepo.clearRepresentativeAreas(repId);
  return { repId, message: 'All area restrictions removed. Rep now covers all areas.' };
}

/**
 * Remove all item restrictions (rep covers ALL items).
 * @param {number} repId
 */
export async function clearItems(repId) {
  await assertExists(repId);
  await repRepo.clearRepresentativeItems(repId);
  return { repId, message: 'All item restrictions removed. Rep now covers all items.' };
}

// ─── Reporting ───────────────────────────────────────────────

/**
 * Generate a sales report for a representative.
 *
 * Isolation Rule (shared-area fix):
 *   Sales are always filtered STRICTLY by representativeId only.
 *   Assigned areas/items are returned as metadata but are NOT used
 *   to filter the query — this ensures each rep's data is isolated
 *   even when multiple reps share the same area.
 *
 *   The only time an area/item filter is applied to the query is when
 *   the caller explicitly passes areaId/itemId query params.
 *
 * @param {number} repId
 * @param {{ startDate?, endDate?, areaId?, itemId? }} query
 */
export async function getRepresentativeReport(repId, query = {}, viewerId = null) {
  // ── 1. Validate rep exists ──────────────────────────────
  const rep = await repRepo.findRepresentativeById(repId);
  if (!rep) throw new AppError(`Representative with id ${repId} not found.`, 404, 'NOT_FOUND');

  // ── 2. Load assigned areas/items for metadata only ──────
  //  These are NOT used to filter the sales query (see Isolation Rule above).
  const [assignedAreaIds, assignedItemIds] = await Promise.all([
    repRepo.getAssignedAreaIds(repId),   // null or [1,2,...]
    repRepo.getAssignedItemIds(repId),   // null or [1,2,...]
  ]);

  // ── 3. Build query-level filters ────────────────────────
  //  Only apply area/item filter if the caller explicitly requested one.
  const queryAreaIds = query.areaId ? [+query.areaId] : null;
  const queryItemIds = query.itemId ? [+query.itemId] : null;

  // ── 3ب. تحقّق من ملكية/مشاركة الملفات + نطاق المُشاهِد على الملفات المُشارَكة
  // (نفس منطق resolveSciRepSales و reports.routes.js) — بدونه: أي fileId
  // يُمرَّر يُقبَل بلا تحقق، وأي ملف مُشارَك يظهر بلا فلترة مناطق/ايتمات
  // (كانت هذه الفجوة الفعلية في تبويب «تجاري»).
  // ملاحظة: خاصية الحجب مُستثناة عمداً من هذا التقرير (وكذلك من «التحليل
  // الشامل») — الحجب يخصّ تقرير «علمي» فقط (resolveSciRepSales)، بطلب صريح.
  let effectiveFileIds = query.fileIds ?? null;
  let scopeAreaIds = queryAreaIds;
  let scopeItemIds = queryItemIds;

  if (viewerId && effectiveFileIds && effectiveFileIds.length > 0) {
    const [files, shares] = await Promise.all([
      prisma.uploadedFile.findMany({
        where: { id: { in: effectiveFileIds } },
        select: { id: true, userId: true },
      }),
      prisma.fileUserShare.findMany({
        where: { userId: viewerId, fileId: { in: effectiveFileIds } },
        select: { fileId: true },
      }),
    ]);
    const sharedIds = new Set(shares.map(s => s.fileId));
    const accessibleFiles = files.filter(f => f.userId === viewerId || sharedIds.has(f.id));
    effectiveFileIds = accessibleFiles.map(f => f.id);

    const sharedNotOwned = accessibleFiles.filter(f => f.userId !== viewerId);
    if (sharedNotOwned.length > 0) {
      const [effAreaIds, effItemIds] = await Promise.all([
        resolveEffectiveAreaIds(viewerId),
        resolveEffectiveItemIds(viewerId),
      ]);
      if (effAreaIds.length > 0) {
        scopeAreaIds = queryAreaIds ? queryAreaIds.filter(id => effAreaIds.includes(id)) : effAreaIds;
      }
      if (effItemIds) {
        scopeItemIds = queryItemIds ? queryItemIds.filter(id => effItemIds.includes(id)) : effItemIds;
      }
    }
  }

  // ── 4. Run aggregation — strict rep isolation ────────────
  //  Primary filter: representativeId = repId  (source of truth for who made the sale)
  //  Optional narrow: areaId / itemId from query params only (or the viewer's
  //  own scope/blocks when the requested files were shared, not owned).
  const { totals, byArea, byItem } = await salesRepo.getSalesAggregates(
    repId,
    scopeAreaIds,
    scopeItemIds,
    { startDate: query.startDate, endDate: query.endDate },
    effectiveFileIds,
    query.recordType || null,
  );

  // ── 5. Shape response ───────────────────────────────────
  return {
    representative: {
      id:       rep.id,
      name:     rep.name,
      isActive: rep.isActive,
    },
    filters: {
      areasFilter:   queryAreaIds ? 'specific' : 'all',
      itemsFilter:   queryItemIds ? 'specific' : 'all',
      assignedAreas: assignedAreaIds ?? 'all',
      assignedItems: assignedItemIds ?? 'all',
      dateRange: {
        startDate: query.startDate ?? null,
        endDate:   query.endDate   ?? null,
      },
    },
    summary: {
      totalQuantity: totals.totalQuantity,
      totalValue:    totals.totalValue,
    },
    byArea,
    byItem,
  };
}

// ─── Private Helpers ─────────────────────────────────────────

async function assertExists(id) {
  const rep = await repRepo.findRepresentativeById(id);
  if (!rep) throw new AppError(`Representative with id ${id} not found.`, 404, 'NOT_FOUND');
  return rep;
}

function formatRepresentative(rep) {
  return {
    ...rep,
    areas: rep.areas?.map(a => a.area) ?? [],
    items: rep.items?.map(i => i.item) ?? [],
    hasAllAreas: (rep.areas?.length ?? 0) === 0,
    hasAllItems: (rep.items?.length ?? 0) === 0,
  };
}
