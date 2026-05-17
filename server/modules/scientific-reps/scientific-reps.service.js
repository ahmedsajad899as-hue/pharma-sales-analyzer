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

export async function list(filters, user = null, options = {}) {
  const { standalone = false, excludeStandalone = false } = options;
  let whereFilters = { ...filters };

  if (user && COMPANY_SCOPED_ROLES.has(user.role)) {
    // ── STANDALONE MODE (ScientificRepsPage) ──────────────────────────────
    // Return ONLY ScientificRepresentative records manually created by this
    // user (userId = user.id). SA-managed system users are never included.
    // Data is fully scoped per account — no cross-account sharing.
    if (standalone) {
      const myReps = await prisma.scientificRepresentative.findMany({
        where: { managerId: user.id },
        select: {
          id: true, name: true, phone: true, email: true, company: true,
          isActive: true, notes: true,
          areas:          { select: { area:          { select: { id: true, name: true } } } },
          items:          { select: { item:          { select: { id: true, name: true } } } },
          companies:      { select: { company:       { select: { id: true, name: true } } } },
          commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
        },
        orderBy: { id: 'asc' },
      });
      return myReps.map(r => ({
        id: r.id, name: r.name, phone: r.phone, email: r.email,
        company: r.company, notes: r.notes, isActive: r.isActive,
        areas:          r.areas?.map(a => a.area)          ?? [],
        items:          r.items?.map(i => i.item)          ?? [],
        companies:      r.companies?.map(c => c.company)   ?? [],
        commercialReps: r.commercialReps?.map(l => l.commercialRep) ?? [],
      }));
    }

    // ── NON-STANDALONE MODE (DashboardPage rep dropdown / visits system) ──
    // Get this manager's company assignments
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { userId: user.id },
      select: { companyId: true, company: { select: { id: true, name: true } } },
    });
    const companyIds = assignments.map(a => a.companyId);

    if (companyIds.length === 0) return [];

    // For company_manager and team_leader: scope to explicitly assigned subordinates only.
    // For other roles (supervisor, product_manager, etc.): show all company reps.
    let allowedUserIds = null; // null = no restriction
    if (['company_manager', 'team_leader'].includes(user.role)) {
      const subordinateRows = await prisma.userManagerAssignment.findMany({
        where: { managerId: user.id },
        select: { userId: true },
      });
      if (subordinateRows.length > 0) {
        // Only show reps that are explicitly assigned under this manager
        allowedUserIds = new Set(subordinateRows.map(r => r.userId));
      }
      // If no subordinates: team_leader sees nobody (rep mode), company_manager falls back to all company reps
      if (subordinateRows.length === 0 && user.role === 'team_leader') {
        return []; // team_leader with no assigned reps sees empty list
      }
    }

    // Return Users with scientific_rep / team_leader roles assigned to same companies
    const repUsers = await prisma.user.findMany({
      where: {
        role: { in: ['scientific_rep', 'team_leader', 'commercial_rep'] },
        isActive: true,
        companyAssignments: { some: { companyId: { in: companyIds } } },
        // If allowedUserIds is set, restrict to those users only
        ...(allowedUserIds ? { id: { in: [...allowedUserIds] } } : {}),
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
    // Skipped when excludeStandalone=true (e.g. TargetsPage wants only system users).
    if (excludeStandalone) {
      return repsWithIds;
    }

    const userRepIds = new Set(repsWithIds.map(r => r.id));
    const standaloneReps = await prisma.scientificRepresentative.findMany({
      where: {
        managerId: user.id,
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

// Returns areas for the currently logged-in scientific rep (by userId)
export async function getMyAreas(userId) {
  if (!userId) return [];
  // Try linkedRepId first via User lookup, then fall back to findFirst
  const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
  let repId = userRow?.linkedRepId ?? null;
  if (!repId) {
    const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
    repId = rep?.id ?? null;
  }
  if (!repId) return [];
  const rows = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: repId },
    select: { area: { select: { id: true, name: true } } },
    orderBy: { area: { name: 'asc' } },
  });
  return rows.map(r => r.area);
}

export async function getMyCommercialReps(userId) {
  if (!userId) return [];
  const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
  let repId = userRow?.linkedRepId ?? null;
  if (!repId) {
    const rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
    repId = rep?.id ?? null;
  }
  if (!repId) return [];
  const rows = await prisma.scientificRepCommercial.findMany({
    where: { scientificRepId: repId },
    select: {
      commercialRep: {
        select: {
          id: true, name: true, phone: true, email: true, isActive: true,
          areas: { select: { area: { select: { id: true, name: true } } } },
          items: { select: { item: { select: { id: true, name: true } } } },
        },
      },
    },
    orderBy: { commercialRep: { name: 'asc' } },
  });
  return rows.map(r => r.commercialRep);
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

  // ── 3. Load area/item assignments ─────────────────────────────────────────
  const areaLinks = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: id },
    select: { areaId: true, area: { select: { id: true, name: true } } },
  });
  let areaIds = null;
  if (areaLinks.length) {
    // Always keep the directly-linked area IDs; also expand by name to catch
    // duplicate area records created from different file uploads.
    const directAreaIds = areaLinks.map(l => l.areaId);
    const areaNames = areaLinks.map(l => l.area.name);
    const allMatchingAreas = await prisma.area.findMany({
      where: { name: { in: areaNames } },
      select: { id: true },
    });
    areaIds = [...new Set([...directAreaIds, ...allMatchingAreas.map(a => a.id)])];
  }

  const itemLinks = await prisma.scientificRepItem.findMany({
    where: { scientificRepId: id },
    select: { itemId: true, item: { select: { id: true, name: true } } },
  });
  let itemIds = null;
  if (itemLinks.length) {
    // Always keep the directly-linked item IDs; also expand by name.
    const directItemIds = itemLinks.map(l => l.itemId);
    const itemNames = itemLinks.map(l => l.item.name);
    const allMatchingItems = await prisma.item.findMany({
      where: { name: { in: itemNames } },
      select: { id: true },
    });
    itemIds = [...new Set([...directItemIds, ...allMatchingItems.map(i => i.id)])];
  }

  // ── 4. Row-level approach: fetch all relevant sales once, filter in memory ──
  // This avoids any Prisma OR-query weirdness and makes filtering bulletproof.
  const hasAreas = areaIds && areaIds.length > 0;
  const hasItems = itemIds && itemIds.length > 0;

  const nameMatchSet = new Set(nameMatchIds);
  const explicitSet  = new Set(explicitCommRepIds);
  const allRepIds    = [...new Set([...nameMatchIds, ...explicitCommRepIds])];

  console.log('[SciRep.getReport] DEBUG', JSON.stringify({
    repId: id, repName: rep.name, fileIds,
    nameMatchCandidates: nameMatchCandidates.length,
    nameMatchIds,
    explicitCommRepIds,
    allRepIds,
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

  const dateRange  = { startDate: query.startDate, endDate: query.endDate };
  const startDate  = query.startDate ? new Date(query.startDate) : null;
  const endDate    = query.endDate   ? new Date(query.endDate)   : null;
  const recordType = query.recordType || null;

  // ── 4b. Detect files directly shared with this sci rep's linked user account ──
  // When a manager explicitly shares a file with the rep's user account, every row
  // in that file belongs to the rep by definition — no name/area filtering needed.
  // This matches the logic used by /api/reports/overall for the rep's own view.
  let sharedFileIds = [];
  const linkedUser = await prisma.user.findFirst({
    where: { linkedRepId: rep.id },
    select: { id: true },
  });
  if (linkedUser && fileIds && fileIds.length > 0) {
    const sharedFiles = await prisma.uploadedFile.findMany({
      where: { id: { in: fileIds }, fileShares: { some: { userId: linkedUser.id } } },
      select: { id: true },
    });
    sharedFileIds = sharedFiles.map(f => f.id);
  }
  // Files NOT shared directly with the rep → use normal name/area filter
  const nonSharedFileIds = fileIds ? fileIds.filter(fid => !sharedFileIds.includes(fid)) : [];

  console.log('[SciRep.getReport] linkedUser:', linkedUser?.id ?? null, '| sharedFileIds:', sharedFileIds, '| nonSharedFileIds:', nonSharedFileIds);

  let rawSales = [];

  // ── A. Shared files ────────────────────────────────────────────────────────
  // If the rep has commercial-rep or area/item assignments, apply the same
  // filter as non-shared files so only the rep's relevant data is shown.
  // If the rep has NO assignments, skip — we can't identify their data.
  if (sharedFileIds.length > 0) {
    const sharedBase = {
      ...(sharedFileIds.length === 1 ? { uploadedFileId: sharedFileIds[0] } : { uploadedFileId: { in: sharedFileIds } }),
      ...(startDate || endDate ? { saleDate: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } } : {}),
      ...(recordType ? { recordType } : {}),
    };
    const salesSelect = {
      quantity: true, totalValue: true,
      areaId: true, itemId: true,
      saleDate: true, recordType: true,
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
    };

    if (allRepIds.length > 0) {
      // Has commercial-rep assignments → fetch ALL their sales without area/item filter.
      // Explicit commercial-rep assignment means the manager has designated that rep
      // as fully belonging to this sci rep — ALL their sales should be counted.
      // Name-match reps are similarly unrestricted.
      const sharedSales = await prisma.sale.findMany({
        where: { ...sharedBase, representativeId: { in: allRepIds } },
        select: salesSelect,
      });
      rawSales = rawSales.concat(sharedSales);
      // ALSO include rows from other reps in the file that fall within this rep's
      // area OR item scope (OR logic — matches either condition).
      if (hasAreas || hasItems) {
        const extraWhere = hasAreas && hasItems
          ? { OR: [{ areaId: { in: areaIds } }, { itemId: { in: itemIds } }] }
          : hasAreas ? { areaId: { in: areaIds } } : { itemId: { in: itemIds } };
        const extraSales = await prisma.sale.findMany({
          where: { ...sharedBase, NOT: { representativeId: { in: allRepIds } }, ...extraWhere },
          select: salesSelect,
        });
        rawSales = rawSales.concat(extraSales);
      }
    } else if (hasAreas || hasItems) {
      // No commercial-rep assignments — use area OR item scope (OR logic)
      const areaItemWhere = hasAreas && hasItems
        ? { OR: [{ areaId: { in: areaIds } }, { itemId: { in: itemIds } }] }
        : hasAreas ? { areaId: { in: areaIds } } : { itemId: { in: itemIds } };
      const sharedSales = await prisma.sale.findMany({
        where: { ...sharedBase, ...areaItemWhere },
        select: salesSelect,
      });
      rawSales = rawSales.concat(sharedSales);
    }
    // If no rep IDs, areas, or items → cannot identify the rep's data → skip.
    // The old "include all rows" fallback was incorrect for multi-rep files.
  }

  // ── B. Non-shared files: use name-match + explicit-rep + area/item filter ─
  if (nonSharedFileIds.length > 0) {
    const nonSharedBase = {
      ...(nonSharedFileIds.length === 1 ? { uploadedFileId: nonSharedFileIds[0] } : { uploadedFileId: { in: nonSharedFileIds } }),
      ...(startDate || endDate ? { saleDate: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } } : {}),
      ...(recordType ? { recordType } : {}),
    };

    const nonSharedSalesSelect = {
      quantity: true, totalValue: true,
      areaId: true, itemId: true,
      saleDate: true, recordType: true,
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
    };

    if (allRepIds.length > 0) {
      // Fetch ALL sales for involved reps — explicit + name-match — no area/item filter.
      // Explicit assignment means the manager designated this commercial rep as fully
      // belonging to the sci rep, so all their rows should be counted.
      const nonSharedSales = await prisma.sale.findMany({
        where: { ...nonSharedBase, representativeId: { in: allRepIds } },
        select: nonSharedSalesSelect,
      });
      rawSales = rawSales.concat(nonSharedSales);
      // ALSO pull rows from other reps whose area OR item falls in scope
      if (hasAreas || hasItems) {
        const extraWhere = hasAreas && hasItems
          ? { OR: [{ areaId: { in: areaIds } }, { itemId: { in: itemIds } }] }
          : hasAreas ? { areaId: { in: areaIds } } : { itemId: { in: itemIds } };
        const extraSales = await prisma.sale.findMany({
          where: { ...nonSharedBase, NOT: { representativeId: { in: allRepIds } }, ...extraWhere },
          select: nonSharedSalesSelect,
        });
        rawSales = rawSales.concat(extraSales);
      }
    } else if (hasAreas || hasItems) {
      // No rep assignments — area OR item scope (OR logic)
      const areaItemWhere = hasAreas && hasItems
        ? { OR: [{ areaId: { in: areaIds } }, { itemId: { in: itemIds } }] }
        : hasAreas ? { areaId: { in: areaIds } } : { itemId: { in: itemIds } };
      const legacySales = await prisma.sale.findMany({
        where: { ...nonSharedBase, ...areaItemWhere },
        select: nonSharedSalesSelect,
      });
      rawSales = rawSales.concat(legacySales);
    }
  }

  // ── Deduplicate across files: same rep+area+item+date+qty+recordType ──────
  // When two active files contain overlapping data (e.g. a «كل العراق» file and
  // a per-region file both carrying the same rows), each row would otherwise be
  // counted twice.  We drop the second occurrence using a composite key.
  const _seenSales = new Set();
  rawSales = rawSales.filter(s => {
    const dayKey = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : 'nodate';
    const key = `${s.representative.id}|${s.areaId}|${s.itemId}|${dayKey}|${s.quantity}|${s.recordType || 'sale'}`;
    if (_seenSales.has(key)) return false;
    _seenSales.add(key);
    return true;
  });

  const aggregated = aggregateSalesWithReps(rawSales);
  console.log('[SciRep.getReport] aggregated totals:', JSON.stringify(aggregated.totals), 'rows:', rawSales.length);
  const { totals, byArea, byItem, byRep } = aggregated;

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
      sharedFileIds,
      nonSharedFileIds,
      linkedUserId: linkedUser?.id ?? null,
      nameMatchIds,
      explicitCommRepIds,
      areaIds,
      itemIds,
      rawRowCount: rawSales.length,
      totals,
    },
  };
}
