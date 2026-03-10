import * as repo from './scientific-reps.repository.js';
import { findOrCreateArea, findOrCreateItem, getSalesForScientificRep } from '../sales/sales.repository.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';

// ─── Helpers ─────────────────────────────────────────────────

async function assertExists(id) {
  const r = await repo.findById(id);
  if (!r) throw new AppError(`Scientific rep ${id} not found.`, 404, 'NOT_FOUND');
  return r;
}

// ─── CRUD ────────────────────────────────────────────────────

export async function create(dto) {
  return repo.createScientificRep(dto);
}

// Roles that see only their assigned-company reps (not all reps)
const COMPANY_SCOPED_ROLES = new Set([
  'company_manager', 'supervisor', 'product_manager', 'team_leader',
  'office_manager', 'commercial_supervisor', 'commercial_team_leader',
]);

export async function list(filters, user = null) {
  let whereFilters = { ...filters };

  if (user && COMPANY_SCOPED_ROLES.has(user.role)) {
    // Get this manager's company assignments
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { userId: user.id },
      select: { companyId: true, company: { select: { id: true, name: true } } },
    });
    const companyIds = assignments.map(a => a.companyId);

    if (companyIds.length === 0) return [];

    // Return Users with scientific_rep / team_leader roles assigned to same companies
    const repUsers = await prisma.user.findMany({
      where: {
        role: { in: ['scientific_rep', 'team_leader', 'commercial_rep'] },
        isActive: true,
        companyAssignments: { some: { companyId: { in: companyIds } } },
      },
      include: {
        companyAssignments: { include: { company: { select: { id: true, name: true } } } },
        areaAssignments:    { include: { area:    { select: { id: true, name: true } } } },
        itemAssignments:    { include: { item:    { select: { id: true, name: true } } } },
      },
    });

    // Shape to match ScientificRep interface
    return repUsers.map(u => ({
      id: u.id,
      name: u.displayName || u.username,
      phone: u.phone || null,
      email: null,
      company: u.companyAssignments[0]?.company?.name || null,
      notes: null,
      isActive: u.isActive,
      areas:         u.areaAssignments.map(a => a.area),
      items:         u.itemAssignments.map(a => a.item),
      companies:     u.companyAssignments.map(a => a.company),
      commercialReps: [],
      _isUser: true,
      role: u.role,
    }));
  }

  const reps = await repo.listAll(whereFilters);
  return reps.map(r => ({
    ...r,
    areas:           r.areas?.map(a => a.area) ?? [],
    items:           r.items?.map(i => i.item) ?? [],
    companies:       r.companies?.map(c => c.company) ?? [],
    commercialReps:  r.commercialReps?.map(c => c.commercialRep) ?? [],
    areasCount:      r._count?.areas ?? 0,
    itemsCount:      r._count?.items ?? 0,
    companiesCount:  r._count?.companies ?? 0,
    commercialCount: r._count?.commercialReps ?? 0,
    _count: undefined,
  }));
}

export async function getById(id) {
  const r = await assertExists(id);
  return {
    ...r,
    areas:          r.areas?.map(a => a.area) ?? [],
    items:          r.items?.map(i => i.item) ?? [],
    companies:      r.companies?.map(c => c.company) ?? [],
    commercialReps: r.commercialReps?.map(c => c.commercialRep) ?? [],
  };
}

export async function update(id, dto) {
  await assertExists(id);
  return repo.updateScientificRep(id, dto);
}

export async function remove(id) {
  await assertExists(id);
  return repo.deleteScientificRep(id);
}

// ─── Assignments ─────────────────────────────────────────────

/**
 * Assign areas by NAME (creates if missing), then set.
 */
export async function assignAreasByName(id, areaNames, userId = null) {
  await assertExists(id);
  const areas = await Promise.all(areaNames.map(name => findOrCreateArea(name, userId)));
  await repo.setAreas(id, areas.map(a => a.id));
  return getById(id);
}

/**
 * Assign items by NAME (creates if missing), then set.
 */
export async function assignItemsByName(id, itemNames, userId = null) {
  await assertExists(id);
  const items = await Promise.all(itemNames.map(name => findOrCreateItem(name, userId)));
  await repo.setItems(id, items.map(i => i.id));
  return getById(id);
}

/**
 * Assign companies by ID array.
 */
export async function assignCompanies(id, companyIds) {
  await assertExists(id);
  await repo.setCompanies(id, companyIds);
  return getById(id);
}

/**
 * Assign commercial reps by ID array.
 */
export async function assignCommercialReps(id, commercialRepIds) {
  await assertExists(id);
  await repo.setCommercialReps(id, commercialRepIds);
  return getById(id);
}

/**
 * Get the area IDs assigned to this scientific rep.
 * Returns null if none (= all areas).
 */
export async function getAssignedAreaIds(id) {
  const areas = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: id },
    select: { areaId: true },
  });
  return areas.length ? areas.map(a => a.areaId) : null;
}

// ─── Report ──────────────────────────────────────────────────

/**
 * Generate a sales report for a scientific representative.
 * Aggregates across all assigned commercial reps,
 * filtered by assigned areas + items.
 */
export async function getReport(id, query = {}) {
  const rep = await assertExists(id);

  // Load assigned commercial-rep IDs
  const commercialLinks = await prisma.scientificRepCommercial.findMany({
    where: { scientificRepId: id },
    select: { commercialRepId: true, commercialRep: { select: { id: true, name: true } } },
  });
  const commRepIds = commercialLinks.map(l => l.commercialRepId);

  // Load assigned area IDs (null = no restriction)
  const areaLinks = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: id },
    select: { areaId: true, area: { select: { id: true, name: true } } },
  });
  const areaIds = areaLinks.length ? areaLinks.map(l => l.areaId) : null;

  // Load assigned item IDs (null = no restriction)
  const itemLinks = await prisma.scientificRepItem.findMany({
    where: { scientificRepId: id },
    select: { itemId: true, item: { select: { id: true, name: true } } },
  });
  const itemIds = itemLinks.length ? itemLinks.map(l => l.itemId) : null;

  const { totals, byArea, byItem, byRep } = await getSalesForScientificRep(
    commRepIds,
    areaIds,
    itemIds,
    { startDate: query.startDate, endDate: query.endDate },
    query.fileIds ?? null,
    query.recordType || null,
  );

  return {
    scientificRep: { id: rep.id, name: rep.name, isActive: rep.isActive },
    assignedCommercialReps: commercialLinks.map(l => l.commercialRep),
    assignedAreas: areaLinks.map(l => l.area),
    assignedItems: itemLinks.map(l => l.item),
    dateRange: { startDate: query.startDate ?? null, endDate: query.endDate ?? null },
    summary: { totalQuantity: totals.totalQuantity, totalValue: totals.totalValue },
    byArea,
    byItem,
    byRep,
  };
}
