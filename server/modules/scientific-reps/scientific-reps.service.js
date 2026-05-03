import * as repo from './scientific-reps.repository.js';
import { findOrCreateArea, findOrCreateItem, aggregateSalesWithReps, getSalesForScientificRep, getReturnsForSciRepScope } from '../sales/sales.repository.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';

// ─── Helpers ─────────────────────────────────────────────────

async function assertExists(id) {
  const r = await repo.findById(id);
  if (!r) throw new AppError(`Scientific rep ${id} not found.`, 404, 'NOT_FOUND');
  return r;
}

// ─── CRUD ────────────────────────────────────────────────────

export async function create(dto, user = null) {
  // dto already has userId = user.id (set by controller).
  // For company-scoped roles we keep that userId so the rep is scoped to
  // this manager and appears in their list via the userId filter below.
  // We intentionally do NOT try to link via ScientificRepCompany because
  // that junction table references the old Company model, while
  // UserCompanyAssignment references the newer ScientificCompany model.
  const rep = await repo.createScientificRep(dto);
  return getById(rep.id);
}

// Roles that see only their assigned-company reps (not all reps)
const COMPANY_SCOPED_ROLES = new Set([
  'scientific_rep',
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
        linkedRep:          true,
      },
    });

    // For each user, ensure they have a linked ScientificRepresentative record
    const repsWithIds = await Promise.all(repUsers.map(async u => {
      let repId = u.linkedRepId;
      if (!repId) {
        // Find-or-create: avoid duplicate ScientificRepresentative for same userId
        let rep = await prisma.scientificRepresentative.findFirst({ where: { userId: u.id } });
        if (!rep) {
          rep = await prisma.scientificRepresentative.create({
            data: {
              name: u.displayName || u.username,
              phone: u.phone || null,
              userId: u.id,
            },
          });
        }
        await prisma.user.update({ where: { id: u.id }, data: { linkedRepId: rep.id } });
        repId = rep.id;
      }
      // Load areas, items, companies, and commercial reps from the ScientificRepresentative's
      // OWN assignment tables — fully independent from the User's SA-managed assignments.
      const sciRepData = await prisma.scientificRepresentative.findUnique({
        where: { id: repId },
        select: {
          areas:          { select: { area:          { select: { id: true, name: true } } } },
          items:          { select: { item:          { select: { id: true, name: true } } } },
          companies:      { select: { company:       { select: { id: true, name: true } } } },
          commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
        },
      });

      return {
        id: repId,
        name: u.displayName || u.username,
        phone: u.phone || null,
        email: null,
        company: u.companyAssignments[0]?.company?.name || null,
        notes: null,
        isActive: u.isActive,
        areas:          sciRepData?.areas?.map(a => a.area)          ?? [],
        items:          sciRepData?.items?.map(i => i.item)          ?? [],
        companies:      sciRepData?.companies?.map(c => c.company)   ?? [],
        commercialReps: sciRepData?.commercialReps?.map(l => l.commercialRep) ?? [],
        _isUser: true,
        role: u.role,
      };
    }));

    // Also include standalone ScientificRepresentative records created by this user
    // (added manually by the company manager — scoped via userId, not ScientificRepCompany,
    //  because UserCompanyAssignment → ScientificCompany while ScientificRepCompany → Company).
    const userRepIds = new Set(repsWithIds.map(r => r.id));
    const standaloneReps = await prisma.scientificRepresentative.findMany({
      where: {
        userId: user.id,
        ...(userRepIds.size > 0 ? { id: { notIn: [...userRepIds] } } : {}),
      },
      select: {
        id: true, name: true, phone: true, email: true, company: true,
        isActive: true, notes: true,
        areas:          { select: { area:          { select: { id: true, name: true } } } },
        items:          { select: { item:          { select: { id: true, name: true } } } },
        companies:      { select: { company:       { select: { id: true, name: true } } } },
        commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
      },
    });
    const standaloneFormatted = standaloneReps.map(r => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      company: r.company,
      notes: r.notes,
      isActive: r.isActive,
      areas:          r.areas?.map(a => a.area)          ?? [],
      items:          r.items?.map(i => i.item)          ?? [],
      companies:      r.companies?.map(c => c.company)   ?? [],
      commercialReps: r.commercialReps?.map(l => l.commercialRep) ?? [],
    }));

    return [...repsWithIds, ...standaloneFormatted];
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

  // ── Arabic normalizer (unify alef variants, teh marbuta, remove diacritics) ──
  const _normalizeAr = s => String(s).trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ── 1. Load explicit commercial-rep assignments ───────────────────────────
  const commercialLinks = await prisma.scientificRepCommercial.findMany({
    where: { scientificRepId: id },
    select: { commercialRepId: true, commercialRep: { select: { id: true, name: true } } },
  });
  const explicitCommRepIds = commercialLinks.map(l => l.commercialRepId);

  // ── 2. Find MedicalRepresentative records whose name matches the sci rep ──
  // IMPORTANT: scope to only reps that actually have sales in the active files.
  // This prevents data leakage from old/unrelated uploads that share the same rep name.
  const normalizedSciRepName = _normalizeAr(rep.name);

  // Parse fileIds early — needed for the name-match scoping below.
  const fileIds = query.fileIds ?? null;

  const allMedReps = await prisma.medicalRepresentative.findMany({ select: { id: true, name: true } });
  const nameMatchCandidates = allMedReps
    .filter(r => _normalizeAr(r.name) === normalizedSciRepName)
    .map(r => r.id);

  let nameMatchIds = [];
  if (nameMatchCandidates.length > 0 && fileIds && fileIds.length > 0) {
    const fileFilter0 = fileIds.length === 1
      ? { uploadedFileId: fileIds[0] }
      : { uploadedFileId: { in: fileIds } };
    // Only keep rep IDs that actually appear in the active files
    const repsInFiles = await prisma.sale.findMany({
      where: { representativeId: { in: nameMatchCandidates }, ...fileFilter0 },
      select: { representativeId: true },
      distinct: ['representativeId'],
    });
    nameMatchIds = repsInFiles.map(r => r.representativeId);
  }

  // ── 3. Load area/item assignments (used only for explicit commercial reps) ─
  const areaLinks = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: id },
    select: { areaId: true, area: { select: { id: true, name: true } } },
  });
  let areaIds = null;
  if (areaLinks.length) {
    const areaNames = areaLinks.map(l => l.area.name);
    const allMatchingAreas = await prisma.area.findMany({
      where: { name: { in: areaNames } },
      select: { id: true },
    });
    areaIds = allMatchingAreas.map(a => a.id);
  }

  const itemLinks = await prisma.scientificRepItem.findMany({
    where: { scientificRepId: id },
    select: { itemId: true, item: { select: { id: true, name: true } } },
  });
  let itemIds = null;
  if (itemLinks.length) {
    const itemNames = itemLinks.map(l => l.item.name);
    const allMatchingItems = await prisma.item.findMany({
      where: { name: { in: itemNames } },
      select: { id: true },
    });
    itemIds = allMatchingItems.map(i => i.id);
  }

  // ── 4. Two separate queries — proven approach, no OR-query interference ──
  const hasAreas = areaIds && areaIds.length > 0;
  const hasItems = itemIds && itemIds.length > 0;

  // Exclude name-match IDs from explicit list to prevent double-counting.
  const nameMatchSet = new Set(nameMatchIds);
  const filteredExplicitIds = explicitCommRepIds.filter(rid => !nameMatchSet.has(rid));

  console.log('[SciRep.getReport] DEBUG', JSON.stringify({
    repId: id, repName: rep.name, fileIds,
    nameMatchCandidates: nameMatchCandidates.length,
    nameMatchIds,
    explicitCommRepIds,
    filteredExplicitIds,
    areaIds,
    itemIds,
  }));

  const emptyResult = {
    scientificRep: { id: rep.id, name: rep.name, isActive: rep.isActive },
    assignedCommercialReps: commercialLinks.map(l => l.commercialRep),
    assignedAreas: areaLinks.map(l => l.area),
    assignedItems: itemLinks.map(l => l.item),
    dateRange: { startDate: query.startDate ?? null, endDate: query.endDate ?? null },
    summary: { totalQuantity: 0, totalValue: 0 },
    byArea: [], byItem: [], byRep: [],
  };

  if (!fileIds || (Array.isArray(fileIds) && fileIds.length === 0)) return emptyResult;

  const dateRange = { startDate: query.startDate, endDate: query.endDate };
  const isReturn  = query.recordType === 'return';

  // Query A: name-matched reps → no area/item filter (all their sales in active files)
  let resultA = null;
  if (nameMatchIds.length > 0) {
    if (isReturn) {
      resultA = await getReturnsForSciRepScope(null, null, dateRange, fileIds, nameMatchIds);
    } else {
      resultA = await getSalesForScientificRep(nameMatchIds, null, null, dateRange, fileIds, query.recordType || null);
    }
  }
  console.log('[SciRep.getReport] resultA totals:', JSON.stringify(resultA?.totals ?? null));

  // Query B: explicit commercial rep assignments → WITH area/item filter
  let resultB = null;
  if (filteredExplicitIds.length > 0) {
    if (isReturn) {
      resultB = await getReturnsForSciRepScope(areaIds, itemIds, dateRange, fileIds, filteredExplicitIds);
    } else {
      resultB = await getSalesForScientificRep(filteredExplicitIds, areaIds, itemIds, dateRange, fileIds, query.recordType || null);
    }
  }
  console.log('[SciRep.getReport] resultB totals:', JSON.stringify(resultB?.totals ?? null));

  // Fallback: no rep assignments at all → area/item only (legacy mode)
  if (!resultA && !resultB) {
    if (isReturn) {
      resultB = await getReturnsForSciRepScope(areaIds, itemIds, dateRange, fileIds, null);
    } else {
      resultB = await getSalesForScientificRep([], areaIds, itemIds, dateRange, fileIds, query.recordType || null);
    }
  }

  // Merge A + B: repIds are disjoint (nameMatchIds ∩ filteredExplicitIds = ∅)
  // byArea keys = areaId-repId → no collision. byItem keys = itemId → merge by sum.
  const mergeTwo = (a, b) => {
    if (!a) return b;
    if (!b) return a;

    const areaMap = new Map();
    for (const row of [...a.byArea, ...b.byArea]) {
      const k = `${row.areaId ?? row.areaName}-${row.repId ?? row.repName}`;
      if (!areaMap.has(k)) areaMap.set(k, { ...row });
      else { areaMap.get(k).totalQuantity += row.totalQuantity; areaMap.get(k).totalValue += row.totalValue; }
    }
    const itemMap = new Map();
    for (const row of [...a.byItem, ...b.byItem]) {
      const k = row.itemId ?? row.itemName;
      if (!itemMap.has(k)) itemMap.set(k, { ...row });
      else { itemMap.get(k).totalQuantity += row.totalQuantity; itemMap.get(k).totalValue += row.totalValue; }
    }
    const repMap = new Map();
    for (const row of [...a.byRep, ...b.byRep]) {
      const k = row.repId ?? row.repName;
      if (!repMap.has(k)) repMap.set(k, { ...row });
      else { repMap.get(k).totalQuantity += row.totalQuantity; repMap.get(k).totalValue += row.totalValue; }
    }
    return {
      totals: {
        totalQuantity: a.totals.totalQuantity + b.totals.totalQuantity,
        totalValue:    +(a.totals.totalValue  + b.totals.totalValue).toFixed(2),
      },
      byArea: [...areaMap.values()].sort((x, y) => y.totalValue - x.totalValue),
      byItem: [...itemMap.values()].sort((x, y) => y.totalValue - x.totalValue),
      byRep:  [...repMap.values()].sort((x, y) => y.totalValue - x.totalValue),
    };
  };

  const salesResult = mergeTwo(resultA, resultB)
    ?? { totals: { totalQuantity: 0, totalValue: 0 }, byArea: [], byItem: [], byRep: [] };
  const { totals, byArea, byItem, byRep } = salesResult;

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
    _debug: {
      fileIds,
      nameMatchCandidatesCount: nameMatchCandidates.length,
      nameMatchIds,
      explicitCommRepIds,
      filteredExplicitIds,
      areaIds,
      itemIds,
      resultA_totals: resultA?.totals ?? null,
      resultA_byRep: resultA?.byRep ?? null,
      resultB_totals: resultB?.totals ?? null,
      resultB_byRep: resultB?.byRep ?? null,
    },
  };
}
