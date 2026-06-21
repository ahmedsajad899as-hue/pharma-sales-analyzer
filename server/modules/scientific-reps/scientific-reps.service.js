import * as repo from './scientific-reps.repository.js';
import { findOrCreateArea, findOrCreateItem, aggregateSalesWithReps, getSalesForScientificRep, getReturnsForSciRepScope, normalizeArabic } from '../sales/sales.repository.js';
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
  let whereFilters = { ...filters };

  if (user && COMPANY_SCOPED_ROLES.has(user.role)) {
    // ── COMPANY-SCOPED MODE: return user-linked reps ──────────────────────
    // Get this manager's company assignments
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { userId: user.id },
      select: { companyId: true, company: { select: { id: true, name: true } } },
    });
    const companyIds = assignments.map(a => a.companyId);

    if (companyIds.length === 0) return [];

    // Scope visible reps based on role:
    // - scientific_rep: only themselves
    // - company_manager / team_leader: their explicitly assigned subordinates
    // - other roles (supervisor, product_manager, etc.): all company reps
    let allowedUserIds = null; // null = no restriction
    if (user.role === 'scientific_rep') {
      // A rep can only see their own record — never other reps from the same company.
      allowedUserIds = new Set([user.id]);
    } else if (['company_manager', 'team_leader'].includes(user.role)) {
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

    return repsWithIds;
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
 * Re-derive each scientific rep's commercial reps from the data of the ACTIVE
 * file(s): a commercial rep is linked to a sci-rep iff they have at least one
 * sale OR return in any of the sci-rep's assigned areas within those files
 * (quantity-agnostic). Areas are matched by normalised name so spelling variants
 * collapse. Fully replaces the stored assignment — this is intentionally
 * data-driven (no manual override) per product requirement. Sci-reps with no
 * assigned areas are left untouched.
 *
 * @param {number[]} fileIds - active uploaded file ids
 * @returns {{ updated: number }}
 */
export async function syncCommercialsByActiveFiles(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return { updated: 0, reason: 'no-files' };

  const reps = await prisma.scientificRepresentative.findMany({
    select: { id: true, areas: { select: { area: { select: { name: true } } } } },
  });

  // normalized area name → [areaId, …]
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const normToAreaIds = new Map();
  for (const a of allAreas) {
    const k = normalizeArabic(a.name);
    if (!k) continue;
    if (!normToAreaIds.has(k)) normToAreaIds.set(k, []);
    normToAreaIds.get(k).push(a.id);
  }

  // distinct (areaId, representativeId) appearing in the active files (sales + returns)
  const pairs = await prisma.sale.findMany({
    where: { uploadedFileId: { in: fileIds } }, // Sale.areaId is required → no null filter
    select: { areaId: true, representativeId: true },
    distinct: ['areaId', 'representativeId'],
  });
  const areaToReps = new Map(); // areaId → Set(repId)
  for (const p of pairs) {
    if (p.representativeId == null) continue;
    if (!areaToReps.has(p.areaId)) areaToReps.set(p.areaId, new Set());
    areaToReps.get(p.areaId).add(p.representativeId);
  }

  let updated = 0;
  for (const r of reps) {
    const assignedNorms = new Set(r.areas.map(a => normalizeArabic(a.area?.name)).filter(Boolean));
    if (assignedNorms.size === 0) continue; // can't derive without areas

    const repIds = new Set();
    for (const nrm of assignedNorms) {
      for (const aid of (normToAreaIds.get(nrm) || [])) {
        const set = areaToReps.get(aid);
        if (set) for (const rid of set) repIds.add(rid);
      }
    }

    await prisma.$transaction([
      prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId: r.id } }),
      ...(repIds.size ? [prisma.scientificRepCommercial.createMany({
        data: [...repIds].map(commercialRepId => ({ scientificRepId: r.id, commercialRepId })),
        skipDuplicates: true,
      })] : []),
    ]);
    updated++;
  }

  return { updated };
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

  // Expand commercial rep IDs by name to catch the same rep appearing in multiple
  // uploaded files (each upload can create a separate MedicalRepresentative record
  // for the same real person, but with a different DB id).
  let expandedCommRepIds = [...explicitCommRepIds];
  if (explicitCommRepIds.length > 0) {
    const commRepNames = commercialLinks.map(l => _normalizeAr(l.commercialRep.name));
    const allMedRepsForExpand = await prisma.medicalRepresentative.findMany({ select: { id: true, name: true } });
    const extraIds = allMedRepsForExpand
      .filter(r => commRepNames.includes(_normalizeAr(r.name)))
      .map(r => r.id);
    expandedCommRepIds = [...new Set([...explicitCommRepIds, ...extraIds])];
  }

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
    // Always keep the directly-linked area IDs; also expand by NORMALISED name to
    // catch duplicate area records that spell the same place differently
    // (الشعب/شعب, الحسينية/حسينيه, شارع المغرب/شارع مغرب…). Without this, sales
    // stored under one spelling are missed when the rep is assigned another.
    const directAreaIds = areaLinks.map(l => l.areaId);
    const assignedNorms = new Set(areaLinks.map(l => normalizeArabic(l.area.name)));
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
    const matchingIds = allAreas.filter(a => assignedNorms.has(normalizeArabic(a.name))).map(a => a.id);
    areaIds = [...new Set([...directAreaIds, ...matchingIds])];
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

  const hasAreas = areaIds && areaIds.length > 0;
  const hasItems = itemIds && itemIds.length > 0;
  const hasCommReps = expandedCommRepIds.length > 0;

  const nameMatchSet = new Set(nameMatchIds);
  const explicitSet  = new Set(explicitCommRepIds);
  const allRepIds    = [...new Set([...nameMatchIds, ...expandedCommRepIds])];

  // ── Helper: build the sales-row WHERE filter ──────────────────────────────
  // RULE: always restrict to assigned commercial reps (or name-match) FIRST,
  // then intersect with area/item filters using AND.
  // Areas and items both narrow the scope — never expand it with OR.
  // This ensures a commercial rep's sales in areas NOT assigned to the
  // scientific rep are never included, even if the item matches.
  const buildSalesWhere = () => {
    const repFilter = hasCommReps
      ? { representativeId: { in: expandedCommRepIds } }
      : nameMatchIds.length > 0
        ? { representativeId: { in: nameMatchIds } }
        : null;

    if (!repFilter) return null; // no rep info → return nothing

    const conditions = [repFilter];
    if (hasAreas) conditions.push({ areaId: { in: areaIds } });
    if (hasItems) conditions.push({ itemId: { in: itemIds } });
    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  };

  console.log('[SciRep.getReport] DEBUG', JSON.stringify({
    repId: id, repName: rep.name, fileIds,
    nameMatchCandidates: nameMatchCandidates.length,
    nameMatchIds,
    explicitCommRepIds,
    expandedCommRepIds,
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
      areaId: true, itemId: true, customerId: true,
      saleDate: true, recordType: true, uploadedFileId: true,
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
    };

    // Always restrict to assigned commercial reps first, then area/item.
    const sharedWhere = buildSalesWhere();

    if (sharedWhere) {
      const sharedSales = await prisma.sale.findMany({
        where: { ...sharedBase, ...sharedWhere },
        select: salesSelect,
      });
      rawSales = rawSales.concat(sharedSales);
    }
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
      areaId: true, itemId: true, customerId: true,
      saleDate: true, recordType: true, uploadedFileId: true,
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      representative: { select: { id: true, name: true } },
    };

    // Always restrict to assigned commercial reps first, then area/item.
    const nonSharedWhere = buildSalesWhere();

    if (nonSharedWhere) {
      const nonSharedSales = await prisma.sale.findMany({
        where: { ...nonSharedBase, ...nonSharedWhere },
        select: nonSharedSalesSelect,
      });
      rawSales = rawSales.concat(nonSharedSales);
    }
  }

  // ── Deduplicate ONLY across overlapping files ──────────────────────────────
  // When two active files carry the same rows (e.g. a «كل العراق» file and a
  // per-region file), a logical sale must not be counted twice. BUT genuine
  // duplicate orders WITHIN a single file (two real orders to the same pharmacy,
  // same day/item/qty) MUST both count.
  // Approach: group rows by composite key (rep+area+item+customer+date+qty+type),
  // then for each key keep the rows from the single file that contains the MOST
  // occurrences. This collapses cross-file overlap while preserving every
  // genuine intra-file duplicate.
  {
    const keyToFileRows = new Map(); // key → Map(uploadedFileId → rows[])
    for (const s of rawSales) {
      const dayKey = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : 'nodate';
      const key = `${s.representative.id}|${s.areaId}|${s.itemId}|${s.customerId ?? 'no-customer'}|${dayKey}|${s.quantity}|${s.recordType || 'sale'}`;
      let fileMap = keyToFileRows.get(key);
      if (!fileMap) { fileMap = new Map(); keyToFileRows.set(key, fileMap); }
      const fid = s.uploadedFileId ?? 0;
      const arr = fileMap.get(fid);
      if (arr) arr.push(s); else fileMap.set(fid, [s]);
    }
    const deduped = [];
    for (const fileMap of keyToFileRows.values()) {
      let best = null;
      for (const rows of fileMap.values()) {
        if (!best || rows.length > best.length) best = rows;
      }
      if (best) deduped.push(...best);
    }
    rawSales = deduped;
  }

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
      expandedCommRepIds,
      areaIds,
      itemIds,
      rawRowCount: rawSales.length,
      totals,
    },
  };
}
