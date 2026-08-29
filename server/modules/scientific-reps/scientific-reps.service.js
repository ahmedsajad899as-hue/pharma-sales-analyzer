import * as repo from './scientific-reps.repository.js';
import { findOrCreateArea, findOrCreateItem, aggregateSalesWithReps, getSalesForScientificRep, getReturnsForSciRepScope, normalizeArabic } from '../sales/sales.repository.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';
import { areaIdsOfProvinces } from '../../lib/areaScope.js';
import { resolveEffectiveItemIds } from '../../lib/itemScope.js';

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
    // Get this manager's company assignments — التيم على أساس الشركة الرئيسية
    const assignments = await prisma.userCompanyAssignment.findMany({
      where: { userId: user.id },
      select: { companyId: true, isPrimary: true, company: { select: { id: true, name: true } } },
    });
    const primaryAssignments = assignments.filter(a => a.isPrimary);
    const companyIds = (primaryAssignments.length ? primaryAssignments : assignments).map(a => a.companyId);

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
        companyAssignments: { some: { companyId: { in: companyIds }, isPrimary: true } },
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

// Resolve (and auto-create if missing) the ScientificRepresentative linked to a
// logged-in user account. The company-scoped branch of list() above does this
// find-or-create lazily whenever a manager browses the reps list — but a rep's
// very first login, before any manager has opened that page, would otherwise
// see empty targets/areas/items because no linked record exists yet.
export async function resolveMyRepId(userId) {
  if (!userId) return null;
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { linkedRepId: true, displayName: true, username: true, phone: true },
  });
  if (!userRow) return null;
  if (userRow.linkedRepId) return userRow.linkedRepId;

  let rep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
  if (!rep) {
    rep = await prisma.scientificRepresentative.create({
      data: { name: userRow.displayName || userRow.username, phone: userRow.phone || null, userId },
      select: { id: true },
    });
  }
  await prisma.user.update({ where: { id: userId }, data: { linkedRepId: rep.id } });
  return rep.id;
}

// Returns areas for the currently logged-in scientific rep (by userId)
export async function getMyAreas(userId) {
  const repId = await resolveMyRepId(userId);
  if (!repId) return [];
  const rows = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: repId },
    select: { area: { select: { id: true, name: true } } },
    orderBy: { area: { name: 'asc' } },
  });
  return rows.map(r => r.area);
}

export async function getMyCommercialReps(userId) {
  const repId = await resolveMyRepId(userId);
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

// Items found in sales rows of files shared with the currently logged-in
// scientific rep — either directly (UploadedFile.sharedWithRepId, the legacy
// per-rep share) or via the file-sharing UI used today (FileUserShare junction,
// keyed by the user's own account id) — what the rep should see in their
// read-only "الايتمات" tab, as opposed to the full company-wide item catalog.
// Full item projection so the rep's «الايتمات» cards can show catalog details
// (scientific name, dosage, price, message, image) and group by company — not
// just a bare id/name like the old shared-file-only listing did.
const REP_ITEM_SELECT = {
  id: true, name: true, scientificName: true, dosage: true, form: true,
  price: true, scientificMessage: true, imageUrl: true,
  companyId: true, company: { select: { id: true, name: true } },
  scientificCompanyId: true, scientificCompany: { select: { id: true, name: true } },
};

export async function getMySharedItems(userId) {
  const repId = await resolveMyRepId(userId);
  const [byRep, byUser, userCompanies, whitelistRows] = await Promise.all([
    repId ? prisma.uploadedFile.findMany({ where: { sharedWithRepId: repId }, select: { id: true } }) : [],
    prisma.fileUserShare.findMany({ where: { userId }, select: { fileId: true } }),
    // الشركة/الشركات العلمية المعيّنة للمندوب (UserCompanyAssignment) — نعرض كتالوجها
    userId ? prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } }) : [],
    // القائمة البيضاء التي حدّدها المشرف من تبويب «الايتمات» (UserItemAssignment):
    // إن وُجدت، يُقيَّد كتالوج الشركة بها؛ إن كانت فارغة يظهر كامل الكتالوج.
    userId ? prisma.userItemAssignment.findMany({ where: { userId }, select: { itemId: true } }) : [],
  ]);
  const fileIds       = [...new Set([...byRep.map(f => f.id), ...byUser.map(s => s.fileId)])];
  const sciCompanyIds = userCompanies.map(c => c.companyId);
  const itemWhitelist = new Set(whitelistRows.map(r => r.itemId));

  const [sharedRows, catalogItems] = await Promise.all([
    // (1) ايتمات ملفات المبيعات المشتركة معه
    fileIds.length ? prisma.sale.findMany({
      where: { uploadedFileId: { in: fileIds } },
      select: { item: { select: REP_ITEM_SELECT } },
      distinct: ['itemId'],
    }) : [],
    // (2) كتالوج الشركة المعيّنة له (isTemp=false) — يظهر حتى لو لم تُشارَك ملفات
    sciCompanyIds.length ? prisma.item.findMany({
      where: { scientificCompanyId: { in: sciCompanyIds }, isTemp: false },
      select: REP_ITEM_SELECT,
    }) : [],
  ]);

  // قصْر كتالوج الشركة على القائمة البيضاء إن وُجدت (وإلا الكتالوج كامل)
  const scopedCatalog = itemWhitelist.size ? catalogItems.filter(i => itemWhitelist.has(i.id)) : catalogItems;

  // موحَّد مع /api/items: القائمة = كتالوج الشركة (مقيّداً بالقائمة البيضاء) ∪ ايتمات
  // ملفات المبيعات المشتركة معه (كل ما يعمل عليه فعلاً — حتى المؤقتة). الكتالوج فقط
  // يُقيَّد بالقائمة البيضاء، أما الملفات المشتركة فتُضاف كما هي.
  const seen = new Set();
  return [...scopedCatalog, ...sharedRows.map(r => r.item)]
    .filter(i => i && !seen.has(i.id) && (seen.add(i.id), true))
    .sort((a, b) => a.name.localeCompare(b.name));
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
 * collapse. Fully replaces the stored assignment with the area-derived set,
 * MINUS any commercial reps the company manager has manually excluded for that
 * sci-rep (see ScientificRepCommercialExclusion) — a manual removal stays in
 * effect across resyncs. Sci-reps with no assigned areas are left untouched.
 *
 * @param {number[]} fileIds - active uploaded file ids
 * @returns {{ updated: number }}
 */
export async function syncCommercialsByActiveFiles(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return { updated: 0, reason: 'no-files' };

  // ملفات ميركاتو مستثناة من الاشتقاق: «اسم المندوب» فيها مندوب علمي لا تجاري،
  // فاشتقاق روابط تجارية منها كان يربط المندوبين العلميين ببعضهم عبر تقاطع
  // المناطق — وهو تحديداً ما يجعل مبيعات مندوب تُحتسب لزميله في نفس المنطقة.
  const activeFiles = await prisma.uploadedFile.findMany({
    where:  { id: { in: fileIds } },
    select: { id: true, sourceSystem: true },
  });
  const derivableFileIds = activeFiles.filter(f => f.sourceSystem !== 'mercato').map(f => f.id);
  if (derivableFileIds.length === 0) return { updated: 0, reason: 'mercato-only' };

  const reps = await prisma.scientificRepresentative.findMany({
    select: { id: true, areas: { select: { area: { select: { name: true } } } } },
  });

  // scientificRepId → Set(commercialRepId) manually excluded by a company manager
  const exclusionRows = await prisma.scientificRepCommercialExclusion.findMany({
    select: { scientificRepId: true, commercialRepId: true },
  });
  const exclusionsByRep = new Map();
  for (const e of exclusionRows) {
    if (!exclusionsByRep.has(e.scientificRepId)) exclusionsByRep.set(e.scientificRepId, new Set());
    exclusionsByRep.get(e.scientificRepId).add(e.commercialRepId);
  }

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
    where: { uploadedFileId: { in: derivableFileIds } }, // Sale.areaId is required → no null filter
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

    const excluded = exclusionsByRep.get(r.id);
    if (excluded) for (const cid of excluded) repIds.delete(cid);

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
 * إضافة روابط مندوب-تجاري↔مندوب-علمي الناتجة عن صفوف مبيعات جديدة — بلا حذف
 * أي رابط قائم (خلافاً لـ syncCommercialsByActiveFiles الذي يعيد الحساب من
 * الصفر لقائمة ملفات بعينها).
 *
 * لماذا لا نستدعي syncCommercialsByActiveFiles مباشرة: «الملفات المفعّلة»
 * مفهوم في متصفح المستخدم فقط (localStorage)، لا يملك الخادم رؤية عليه. لو
 * أعدنا الحساب من صفر بملف واحد فقط لضاعت الروابط المشتقة من ملفات أخرى
 * مفعّلة حالياً في المتصفح. الإضافة فقط آمنة أياً كانت تلك المجموعة: كل
 * رابط نضيفه هنا صحيح بذاته (تقاطع منطقة فعلي)، فلا يمكن أن يُفسِد شيئاً.
 *
 * تُستدعى بعد إضافة مبيعات يدوية/فاتورة إلى ملف قد يكون مفعّلاً أصلاً — وهي
 * الحالة التي كانت تُفلِت من المزامنة تماماً لأن toggleFileActive (الذي
 * يُطلق المزامنة الكاملة في App.tsx) لا يتغيّر عند مجرّد إضافة صفوف لملف
 * نشط أصلاً.
 *
 * @param {{areaId:number, representativeId:number}[]} pairs
 * @returns {Promise<{added:number}>}
 */
export async function syncCommercialsForNewSales(pairs) {
  const clean = (pairs || []).filter(p => p?.areaId && p?.representativeId);
  if (clean.length === 0) return { added: 0 };

  const areaIds = [...new Set(clean.map(p => p.areaId))];
  const areas = await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } });
  const areaNormById = new Map(areas.map(a => [a.id, normalizeArabic(a.name)]));

  const reps = await prisma.scientificRepresentative.findMany({
    select: { id: true, areas: { select: { area: { select: { name: true } } } } },
  });

  const exclusionRows = await prisma.scientificRepCommercialExclusion.findMany({
    select: { scientificRepId: true, commercialRepId: true },
  });
  const exclusionsByRep = new Map();
  for (const e of exclusionRows) {
    if (!exclusionsByRep.has(e.scientificRepId)) exclusionsByRep.set(e.scientificRepId, new Set());
    exclusionsByRep.get(e.scientificRepId).add(e.commercialRepId);
  }

  const toCreate = [];
  for (const sr of reps) {
    const assignedNorms = new Set(sr.areas.map(a => normalizeArabic(a.area?.name)).filter(Boolean));
    if (assignedNorms.size === 0) continue;
    const excluded = exclusionsByRep.get(sr.id);
    for (const pair of clean) {
      const norm = areaNormById.get(pair.areaId);
      if (!norm || !assignedNorms.has(norm)) continue;
      if (excluded?.has(pair.representativeId)) continue;
      toCreate.push({ scientificRepId: sr.id, commercialRepId: pair.representativeId });
    }
  }
  if (toCreate.length === 0) return { added: 0 };
  const result = await prisma.scientificRepCommercial.createMany({ data: toCreate, skipDuplicates: true });
  return { added: result.count };
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
 *
 * ربط المندوبين التجاريين تلقائي بالكامل: يُشتق من تقاطع مناطق المندوب العلمي
 * مع مبيعات الملف/الملفات المفعّلة (syncCommercialsByActiveFiles).
 *
 * لا نسجّل استثناءات دائمة عند إلغاء تأشير مندوب هنا. كان إلغاء التأشير يكتب
 * صفاً في ScientificRepCommercialExclusion يمنع إعادة ربطه إلى الأبد — بلا أي
 * واجهة لعرض تلك الاستثناءات أو إلغائها، فتختفي مبيعات مندوب تجاري من التقرير
 * بلا سبب ظاهر. لإخفاء مندوب نهائياً تُستعمل قائمة «الحجب» وهي ظاهرة وقابلة
 * للتراجع. أي إلغاء تأشير هنا يبقى سارياً حتى إعادة الاشتقاق التالية فقط.
 */
export async function assignCommercialReps(id, commercialRepIds) {
  await assertExists(id);
  const uniqueNew = [...new Set(commercialRepIds)];
  // نمسح أي استثناء قديم لهؤلاء كي لا تبقى بقايا تمنع الاشتقاق التلقائي
  await repo.setCommercialReps(id, uniqueNew, { newlyExcludedIds: [], reincludedIds: uniqueNew });
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

// ─── Globally-blocked commercial reps ────────────────────────
// A manager blocks commercial reps by name; their sales/returns are then hidden
// from every scientific-rep report (applied in resolveSciRepSales) while staying
// visible in the overall analysis. Scoped to the manager's own userId.

export async function listBlockedCommercials(userId) {
  return prisma.blockedCommercialRep.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, enabled: true, createdAt: true },
  });
}

export async function addBlockedCommercial(userId, name) {
  // Idempotent: @@unique([userId, name]) — return the existing row if already blocked.
  // Re-adding a paused (enabled=false) name re-enables it, matching "أضِف هذا الاسم"
  // intent rather than silently no-op-ing on an invisible paused row.
  return prisma.blockedCommercialRep.upsert({
    where: { userId_name: { userId, name } },
    update: { enabled: true },
    create: { userId, name },
    select: { id: true, name: true, enabled: true, createdAt: true },
  });
}

export async function removeBlockedCommercial(userId, blockId) {
  // Scope the delete to the owner so one manager can't remove another's block.
  await prisma.blockedCommercialRep.deleteMany({ where: { id: blockId, userId } });
  return { ok: true };
}

// تعليق/استئناف حجب اسم مؤقتاً بلا حذفه من القائمة — يبقى محفوظاً ويمكن إعادة
// تفعيله لاحقاً بضغطة، بدل حذفه وكتابته من جديد إن احتاجه المستخدم لاحقاً في
// ملف آخر بينما يريد إظهاره الآن.
export async function setBlockedCommercialEnabled(userId, blockId, enabled) {
  await prisma.blockedCommercialRep.updateMany({ where: { id: blockId, userId }, data: { enabled: !!enabled } });
  return { ok: true };
}

// ─── Master on/off switch for a manager's whole block feature ─────────────────
// When disabled, the block lists are kept but not applied (every consumer filters
// blocked rows only for owners whose `blockingEnabled` is true).
export async function getBlockingEnabled(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { blockingEnabled: true } });
  return u?.blockingEnabled ?? true;
}

export async function setBlockingEnabled(userId, enabled) {
  await prisma.user.update({ where: { id: userId }, data: { blockingEnabled: !!enabled } });
  return { enabled: !!enabled };
}

// ─── Globally-blocked areas / items ───────────────────────────
// Same idea as blocked commercial reps, but for whole areas or items: any sale/
// return in a blocked area (or of a blocked item) is hidden from every
// scientific-rep report, regardless of which commercial rep made it.
const BLOCK_MODELS = {
  area: prisma.blockedArea,
  item: prisma.blockedItem,
  pharmacy: prisma.blockedPharmacy,
};

function blockModel(kind) {
  const model = BLOCK_MODELS[kind];
  if (!model) throw new AppError(`Unknown block kind: ${kind}`, 400, 'BAD_REQUEST');
  return model;
}

export async function listBlockedEntities(kind, userId) {
  return blockModel(kind).findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, enabled: true, createdAt: true },
  });
}

export async function addBlockedEntity(kind, userId, name) {
  // إعادة إضافة اسم مُعلَّق (enabled=false) تُعيد تفعيله بدل تجاهل الطلب صامتاً.
  return blockModel(kind).upsert({
    where: { userId_name: { userId, name } },
    update: { enabled: true },
    create: { userId, name },
    select: { id: true, name: true, enabled: true, createdAt: true },
  });
}

export async function removeBlockedEntity(kind, userId, blockId) {
  await blockModel(kind).deleteMany({ where: { id: blockId, userId } });
  return { ok: true };
}

// تعليق/استئناف مؤقت بلا حذف — راجع setBlockedCommercialEnabled أعلاه لنفس المنطق.
export async function setBlockedEntityEnabled(kind, userId, blockId, enabled) {
  await blockModel(kind).updateMany({ where: { id: blockId, userId }, data: { enabled: !!enabled } });
  return { ok: true };
}

// ─── حجب جزئي: منطقة محددة لمندوب تجاري محدد ───────────────────────────────
// نموذج مختلف عن BLOCK_MODELS (مفتاحان لا واحد)، فدوال مستقلة بدل توسيع
// blockModel(). commercialRepName/areaName نص حر يُطابَق بالاسم المطبَّع وقت
// التطبيق (resolveSciRepSales)، تماماً كبقية أنواع الحجب.
export async function listBlockedRepAreas(userId) {
  return prisma.blockedRepArea.findMany({
    where: { userId },
    orderBy: [{ commercialRepName: 'asc' }, { areaName: 'asc' }],
    select: { id: true, commercialRepName: true, areaName: true, enabled: true, createdAt: true },
  });
}

export async function addBlockedRepArea(userId, commercialRepName, areaName) {
  return prisma.blockedRepArea.upsert({
    where: { userId_commercialRepName_areaName: { userId, commercialRepName, areaName } },
    update: { enabled: true },
    create: { userId, commercialRepName, areaName },
    select: { id: true, commercialRepName: true, areaName: true, enabled: true, createdAt: true },
  });
}

export async function removeBlockedRepArea(userId, blockId) {
  await prisma.blockedRepArea.deleteMany({ where: { id: blockId, userId } });
  return { ok: true };
}

export async function setBlockedRepAreaEnabled(userId, blockId, enabled) {
  await prisma.blockedRepArea.updateMany({ where: { id: blockId, userId }, data: { enabled: !!enabled } });
  return { ok: true };
}

// ─── Report ──────────────────────────────────────────────────

/**
 * Resolve which raw Sale rows belong to a scientific rep: commercial-rep
 * expansion, area/item assignment, shared-file detection, and cross-file
 * dedup. `select` lets callers fetch only the Prisma fields they need.
 *
 * Shared by getReport() (aggregated summary) and getRawSalesForExport()
 * (full-row export) so the two can never drift out of sync — the export
 * endpoint used to re-implement a simplified version of this filter
 * (missing the commercial-rep name expansion, the name-match fallback, and
 * Arabic-normalized area matching), which made its totals come out lower
 * than the report's.
 */
/**
 * نطاق ايتمات مندوب علمي — مصدر واحد يخدم تقرير المبيعات وصفحة التارگت.
 *
 * كان التارگت يقرأ ScientificRepItem وحده، فإن كان فارغاً يعرض كل ايتمات
 * المكتب — بينما التقرير يحسب على ايتمات المستخدم المعيّنة. فتظهر أهداف
 * لايتمات لا تُحتسب مبيعاتها أصلاً ويبقى إنجازها صفراً أبداً.
 *
 * القاعدة: ScientificRepItem ∩ ايتمات المستخدم المرتبط. أيّهما فارغ يحكم
 * الآخر وحده، وإن كانا فارغين فلا تقييد (null = كل الايتمات).
 *
 * @returns {Promise<{ itemIds: number[]|null, itemLinks: Array }>} itemIds=null → بلا تقييد
 */
export async function resolveSciRepItemIds(id, repUsersArg = null) {
  const repUsers = repUsersArg ?? await prisma.user.findMany({
    where: { linkedRepId: id }, select: { id: true },
  });

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

  if (repUsers.length) {
    const perUserIds = await Promise.all(repUsers.map(u => resolveEffectiveItemIds(u.id)));
    const union = perUserIds.some(x => x === null) ? null : [...new Set(perUserIds.flat())];
    if (union) {
      const allowed = new Set(union);
      itemIds = itemIds ? itemIds.filter(id => allowed.has(id)) : union;
    }
  }
  return { itemIds, itemLinks };
}
/**
 * سجلات الايتمات ضمن نطاق المندوب — لصفحة التارگت الشهري.
 * الايتمات المؤقتة مستبعدة: ليست ايتمات كتالوج ولا يُوضع لها هدف.
 */
export async function getSciRepEffectiveItems(id) {
  const { itemIds } = await resolveSciRepItemIds(id);
  const where = itemIds ? { id: { in: itemIds }, isTemp: false } : { isTemp: false };
  const items = await prisma.item.findMany({
    where, select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  return { items, restricted: itemIds !== null };
}
/**
 * تطبيع اسم شخص للمطابقة: توحيد الألف والتاء المربوطة، حذف التطويل والتشكيل،
 * وطيّ المسافات. مصدر واحد للحقيقة يستعمله كل من مطابقة الأسماء المخزَّنة
 * (SciRepNameLink.fromKey) ومطابقة صفوف المبيعات، فلا ينفرط المفتاحان.
 * مطابق حرفياً لِما كان مضمَّناً داخل resolveSciRepSales قبلاً — لا تغيّره وحده.
 */
export const normalizeRepName = s => String(s ?? '').trim()
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ـ/g, '')
  .replace(/[ً-ٟ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * درجة تشابه اسمَي شخص (0..1) على أساس الكلمات المشتركة لا الحروف:
 * «محمد باقر» ⊂ «محمد باقر مرتضى» → احتواء تام. نشترط كلمتين مشتركتين على
 * الأقل، وإلا لطابق كل «محمد» كل «محمد» آخر.
 * @returns {number} 0 = لا تشابه يُعتد به
 */
export function repNameScore(a, b) {
  const na = normalizeRepName(a), nb = normalizeRepName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const setB = new Set(tb);
  const shared = ta.filter(t => setB.has(t)).length;
  if (shared < 2) return 0; // كلمة واحدة مشتركة (اسم أول شائع) ليست دليلاً
  const containment = shared / Math.min(ta.length, tb.length); // 1 = الأقصر داخل الأطول
  const overall     = shared / Math.max(ta.length, tb.length);
  return containment * 0.7 + overall * 0.3;
}

/**
 * يفحص أسماء المندوبين الواردة في ملفات ميركاتو المفعّلة ويصنّفها مقابل سجلات
 * المندوبين العلميين. قراءة فقط — لا يُنشئ ولا يربط شيئاً.
 *
 * النطاق: مندوبو هذا المدير فقط (نفس ما تُرجعه list لهذا المستخدم). الأسماء التي
 * لا تشبه أياً منهم تُعدّ خارج نطاقه ولا يُسأل عنها إطلاقاً — ملف ميركاتو يضمّ
 * مندوبي السوق كلهم لا مندوبي مكتب واحد.
 *
 * التصنيف:
 *   linked → سبق أن أكّده المستخدم (أو استبعده) فلا يُسأل عنه
 *   exact  → تطابق تام بعد التطبيع → يُربط تلقائياً بلا سؤال
 *   ask    → مرشّحون متشابهون لكن بلا قطع → يُعرض للتأكيد (هذا وحده ما يُسأل عنه)
 *   none   → لا يشبه أياً من مندوبي المدير → خارج النطاق، للعلم فقط
 *
 * @param {{ fileIds:number[]|null, user:object }} opts
 */
export async function checkMercatoRepNames({ fileIds = null, user = null } = {}) {
  const EMPTY = { pending: [], resolved: [], unrelated: [], mercatoFileCount: 0, reps: [] };
  const ids = Array.isArray(fileIds) ? fileIds.filter(Number.isInteger) : [];
  if (ids.length === 0) return EMPTY;

  // نقتصر على ملفات ميركاتو: في ملفات المكتب «اسم المندوب» مندوب تجاري لا علمي.
  const files = await prisma.uploadedFile.findMany({
    where:  { id: { in: ids } },
    select: { id: true, sourceSystem: true },
  });
  const mercatoIds = files.filter(f => f.sourceSystem === 'mercato').map(f => f.id);
  if (mercatoIds.length === 0) return EMPTY;

  // أسماء المندوبين الفعلية داخل تلك الملفات
  const rows = await prisma.sale.findMany({
    where:    { uploadedFileId: { in: mercatoIds } },
    select:   { representative: { select: { name: true } } },
    distinct: ['representativeId'],
  });
  const fileNames = [...new Set(rows.map(r => r.representative?.name).filter(Boolean))];

  // سجلات المندوبين العلميين كما يراها هذا المستخدم (نفس نطاق صفحة المندوبين)
  const repList = await list({}, user ?? null, {});
  const reps = repList
    .map(r => ({ id: r.id, name: r.name }))
    .filter(r => Number.isInteger(r.id) && r.name);

  const userId = user?.id ?? null;
  const linkRows = userId
    ? await prisma.sciRepNameLink.findMany({
        where:  { userId },
        select: { fromKey: true, scientificRepId: true, scientificRep: { select: { id: true, name: true } } },
      })
    : [];
  const linkByKey = new Map(linkRows.map(l => [l.fromKey, l]));
  const repByKey  = new Map();
  for (const r of reps) {
    const k = normalizeRepName(r.name);
    if (k && !repByKey.has(k)) repByKey.set(k, r);
  }

  const entries = fileNames.map(raw => {
    const key = normalizeRepName(raw);
    const link = linkByKey.get(key);
    if (link) {
      return {
        raw, key, status: 'linked',
        rep: link.scientificRep ? { id: link.scientificRep.id, name: link.scientificRep.name } : null,
        suggestions: [],
      };
    }
    const exact = repByKey.get(key);
    if (exact) return { raw, key, status: 'exact', rep: exact, suggestions: [] };

    const suggestions = reps
      .map(r => ({ id: r.id, name: r.name, score: repNameScore(raw, r.name) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return { raw, key, status: suggestions.length > 0 ? 'ask' : 'none', rep: null, suggestions };
  });

  const byName = (a, b) => a.raw.localeCompare(b.raw, 'ar');
  return {
    // ما يحتاج قرار المستخدم فعلاً — وهو وحده ما تعرضه النافذة للسؤال
    pending:   entries.filter(e => e.status === 'ask').sort(byName),
    // محسوم مسبقاً: تطابق تام أو قرار محفوظ
    resolved:  entries.filter(e => e.status === 'linked' || e.status === 'exact').sort(byName),
    // خارج نطاق مندوبي هذا المدير — تُعرض كعدد فقط، بلا سؤال
    unrelated: entries.filter(e => e.status === 'none').map(e => ({ raw: e.raw, key: e.key })).sort(byName),
    mercatoFileCount: mercatoIds.length,
    reps,
  };
}

/**
 * يحفظ قرارات المستخدم في مطابقة الأسماء. scientificRepId = null يعني «ليس
 * أحد مندوبينا» ويُحفظ أيضاً كي لا يتكرّر السؤال عنه.
 * @param {number} userId
 * @param {{fromName:string, scientificRepId:number|null}[]} links
 */
export async function saveRepNameLinks(userId, links) {
  if (!userId) throw new AppError('غير مصرح', 401, 'UNAUTHORIZED');
  let saved = 0;
  for (const l of (Array.isArray(links) ? links : [])) {
    const fromName = String(l?.fromName ?? '').trim();
    const fromKey  = normalizeRepName(fromName);
    if (!fromKey) continue;
    const repId = Number.isInteger(l?.scientificRepId) ? l.scientificRepId : null;
    await prisma.sciRepNameLink.upsert({
      where:  { userId_fromKey: { userId, fromKey } },
      update: { fromName, scientificRepId: repId },
      create: { userId, fromKey, fromName, scientificRepId: repId },
    });
    saved++;
  }
  return { saved };
}

/** يحذف ربط اسم محفوظاً — يعود الاسم ليُسأل عنه من جديد. */
export async function removeRepNameLink(userId, fromKey) {
  await prisma.sciRepNameLink.deleteMany({ where: { userId, fromKey: String(fromKey ?? '') } });
  return { ok: true };
}

async function resolveSciRepSales(id, query = {}, select) {
  const rep = await assertExists(id);

  // ── Arabic normalizer (unify alef variants, teh marbuta, remove diacritics) ──
  const _normalizeAr = normalizeRepName;

  // ── 1. Load explicit commercial-rep assignments ───────────────────────────
  let commercialLinks = await prisma.scientificRepCommercial.findMany({
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

  // ── ملفات ميركاتو مقابل ملفات سستم المكتب ────────────────────────────────
  // في ملف ميركاتو «اسم المندوب» هو المندوب العلمي نفسه (هو من أرسل الطلبية إلى
  // المذخر)، فتُنسب صفوفه بمطابقة اسمه مباشرةً — بلا توسيع بالمندوبين التجاريين
  // وبلا تقييد بالمناطق. هذا ما يمنع احتساب مبيعات نفس المنطقة المسجّلة باسم
  // مندوب علمي آخر ضمن الملف. أما ملفات المكتب فتبقى على منطقها القائم.
  // التقسيم في JS لا في الاستعلام: شرط Prisma `NOT: {sourceSystem:'mercato'}`
  // يستبعد الصفوف ذات القيمة NULL أيضاً (SQL `<> ` لا يطابق NULL) — وهي الغالبية.
  let mercatoFileIds = [];
  let officeFileIds  = [];
  if (fileIds && fileIds.length > 0) {
    const fileRows = await prisma.uploadedFile.findMany({
      where:  { id: { in: fileIds } },
      select: { id: true, sourceSystem: true },
    });
    for (const f of fileRows) {
      if (f.sourceSystem === 'mercato') mercatoFileIds.push(f.id);
      else officeFileIds.push(f.id);
    }
  }

  // أسماء بديلة أكّدها المستخدم لهذا المندوب («محمد باقر» ← «محمد باقر مرتضى»).
  // بدونها تُسقط المطابقةُ الحرفية مبيعاتِه كلها حين يُكتب اسمه مختصراً في الملف.
  const nameLinkRows = await prisma.sciRepNameLink.findMany({
    where:  { scientificRepId: id },
    select: { fromKey: true },
  });
  const acceptedNameKeys = new Set([normalizedSciRepName, ...nameLinkRows.map(l => l.fromKey)]);

  const allMedReps = await prisma.medicalRepresentative.findMany({ select: { id: true, name: true } });
  const nameMatchCandidates = allMedReps
    .filter(r => acceptedNameKeys.has(_normalizeAr(r.name)))
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

  // ── Globally-blocked commercial reps / areas / items ────────────────────────
  // A company manager can globally block commercial reps, areas, or items (from
  // ScientificRepsPage). The matching sales/returns must be hidden from EVERY
  // scientific-rep report. NOT applied to the manager's own comprehensive-analysis
  // view of their own files — but IS applied to the comprehensive analysis when
  // viewed by a user a file was transferred to (see the mirrored block-resolution
  // logic in reports.routes.js's /overall handler, which reuses the same lists
  // for shared-file viewers). The block lists here are scoped to the OWNER(s) of
  // the active files, so they apply both to the manager's own sci-rep-report view
  // and to the scientific reps the files are shared with. Matched by normalized
  // Arabic name so spelling/id variants across uploads all collapse.
  let blockedAreaIds = [];
  let blockedItemIds = [];
  let blockedCustomerIds = [];
  // حجب جزئي: [{representativeId:{in:[...]}, areaId:{in:[...]}}, ...] — كل عنصر
  // يمثّل مندوباً تجارياً محجوباً في مجموعة مناطق محددة له فقط، لا كل المناطق.
  let blockedRepAreaConds = [];
  if (fileIds && fileIds.length > 0) {
    const fileOwners = await prisma.uploadedFile.findMany({
      where: { id: { in: fileIds } },
      select: { userId: true },
    });
    const ownerIds = [...new Set(fileOwners.map(f => f.userId).filter(Boolean))];
    if (ownerIds.length > 0) {
      // Only apply block lists of owners who have blocking ENABLED (master switch)
      // AND the block row itself isn't temporarily paused (enabled=false).
      const blockWhere = { userId: { in: ownerIds }, user: { blockingEnabled: true }, enabled: true };
      const [blockedRepRows, blockedAreaRows, blockedItemRows, blockedPharmRows, blockedRepAreaRows] = await Promise.all([
        prisma.blockedCommercialRep.findMany({ where: blockWhere, select: { name: true } }),
        prisma.blockedArea.findMany({ where: blockWhere, select: { name: true } }),
        prisma.blockedItem.findMany({ where: blockWhere, select: { name: true } }),
        prisma.blockedPharmacy.findMany({ where: blockWhere, select: { name: true } }),
        prisma.blockedRepArea.findMany({ where: blockWhere, select: { commercialRepName: true, areaName: true } }),
      ]);

      const blockedNorms = new Set(blockedRepRows.map(b => _normalizeAr(b.name)).filter(Boolean));
      if (blockedNorms.size > 0) {
        const isBlocked = repId => {
          const rep = allMedReps.find(r => r.id === repId);
          return rep ? blockedNorms.has(_normalizeAr(rep.name)) : false;
        };
        expandedCommRepIds = expandedCommRepIds.filter(rid => !isBlocked(rid));
        nameMatchIds       = nameMatchIds.filter(rid => !isBlocked(rid));
        // Also drop blocked reps from the displayed «assigned commercial reps» list.
        commercialLinks = commercialLinks.filter(l => !blockedNorms.has(_normalizeAr(l.commercialRep.name)));
      }

      const blockedAreaNorms = new Set(blockedAreaRows.map(b => normalizeArabic(b.name)).filter(Boolean));
      if (blockedAreaNorms.size > 0) {
        const allAreasForBlock = await prisma.area.findMany({ select: { id: true, name: true } });
        blockedAreaIds = allAreasForBlock.filter(a => blockedAreaNorms.has(normalizeArabic(a.name))).map(a => a.id);
      }

      const blockedItemNorms = new Set(blockedItemRows.map(b => normalizeArabic(b.name)).filter(Boolean));
      if (blockedItemNorms.size > 0) {
        const allItemsForBlock = await prisma.item.findMany({ select: { id: true, name: true } });
        blockedItemIds = allItemsForBlock.filter(i => blockedItemNorms.has(normalizeArabic(i.name))).map(i => i.id);
      }

      // الصيدلية = Customer على صف المبيعة. نطابق بالاسم المطبَّع لأن نفس
      // الصيدلية تتكرر كصفوف Customer متعددة عبر الملفات والحسابات.
      const blockedPharmNorms = new Set(blockedPharmRows.map(b => normalizeArabic(b.name)).filter(Boolean));
      if (blockedPharmNorms.size > 0) {
        const allCustomers = await prisma.customer.findMany({ select: { id: true, name: true } });
        blockedCustomerIds = allCustomers.filter(c => blockedPharmNorms.has(normalizeArabic(c.name))).map(c => c.id);
      }

      // حجب جزئي (مندوب × منطقة): نجمع مناطق كل مندوب محجوب جزئياً معاً، فتصير
      // شرطاً واحداً لكل مندوب بدل شرط منفصل لكل زوج (مندوب، منطقة).
      if (blockedRepAreaRows.length > 0) {
        const allAreasForRepBlock = await prisma.area.findMany({ select: { id: true, name: true } });
        const areasByRepNorm = new Map(); // اسم المندوب المطبَّع → Set(اسم المنطقة المطبَّع)
        for (const row of blockedRepAreaRows) {
          const rk = _normalizeAr(row.commercialRepName);
          if (!areasByRepNorm.has(rk)) areasByRepNorm.set(rk, new Set());
          areasByRepNorm.get(rk).add(normalizeArabic(row.areaName));
        }
        for (const [repNorm, areaNormsSet] of areasByRepNorm) {
          const repIdsForBlock = allMedReps.filter(r => _normalizeAr(r.name) === repNorm).map(r => r.id);
          const areaIdsForBlock = allAreasForRepBlock.filter(a => areaNormsSet.has(normalizeArabic(a.name))).map(a => a.id);
          if (repIdsForBlock.length > 0 && areaIdsForBlock.length > 0) {
            blockedRepAreaConds.push({ representativeId: { in: repIdsForBlock }, areaId: { in: areaIdsForBlock } });
          }
        }
      }
    }
  }

  // ── 3. Load area/item assignments ─────────────────────────────────────────
  const areaLinks = await prisma.scientificRepArea.findMany({
    where: { scientificRepId: id },
    select: { areaId: true, area: { select: { id: true, name: true } } },
  });
  // مناطق المحافظات المعيّنة لحسابات هذا المندوب — التوسيع الديناميكي.
  // ScientificRepArea لقطة تُبنى عند الحفظ، فلا تعرف المناطق التي دخلت المحافظة
  // لاحقاً. نضمّها هنا قبل التوسيع بالاسم كي تشملها مطابقة التهجئة أيضاً.
  // حسابات الدخول المرتبطة بهذا المندوب فقط (User.linkedRepId). ننتبه ألّا
  // نستعمل rep.userId — هو مالك السجل (المدير) بحكم @@unique([name, userId])،
  // وضمّه كان سيمنح المندوب نطاق محافظات مديره كاملاً.
  const repUsers = await prisma.user.findMany({
    where:  { linkedRepId: id },
    select: { id: true },
  });
  let provinceAreaIds = [];
  if (repUsers.length) {
    const provRows = await prisma.userProvinceAssignment.findMany({
      where:  { userId: { in: repUsers.map(u => u.id) } },
      select: { provinceId: true },
    });
    provinceAreaIds = await areaIdsOfProvinces([...new Set(provRows.map(r => r.provinceId))]);
  }

  let areaIds = null;
  if (areaLinks.length || provinceAreaIds.length) {
    // Always keep the directly-linked area IDs; also expand by NORMALISED name to
    // catch duplicate area records that spell the same place differently
    // (الشعب/شعب, الحسينية/حسينيه, شارع المغرب/شارع مغرب…). Without this, sales
    // stored under one spelling are missed when the rep is assigned another.
    const directAreaIds = [...areaLinks.map(l => l.areaId), ...provinceAreaIds];
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
    const directSet = new Set(directAreaIds);
    const assignedNorms = new Set(
      allAreas.filter(a => directSet.has(a.id)).map(a => normalizeArabic(a.name)),
    );
    const matchingIds = allAreas.filter(a => assignedNorms.has(normalizeArabic(a.name))).map(a => a.id);
    areaIds = [...new Set([...directAreaIds, ...matchingIds])];
  }

  const { itemIds, itemLinks } = await resolveSciRepItemIds(id, repUsers);

  const hasAreas = areaIds && areaIds.length > 0;
  const hasItems = itemIds && itemIds.length > 0;
  const hasCommReps = expandedCommRepIds.length > 0;

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

    // مصدر النسب: فرعان يُجمعان بـ OR حسب نوع الملف.
    const sourceConds = [];

    // (أ) ملفات سستم المكتب — المنطق القائم: مندوبون تجاريون ∩ المناطق.
    if (repFilter && (mercatoFileIds.length === 0 || officeFileIds.length > 0)) {
      const office = [repFilter];
      if (hasAreas) office.push({ areaId: { in: areaIds } });
      // لا نضيف قيد الملف إلا عند وجود ملف ميركاتو فعلاً، حفاظاً على السلوك
      // السابق حرفياً حين تكون كل الملفات من المكتب.
      if (mercatoFileIds.length > 0) office.push({ uploadedFileId: { in: officeFileIds } });
      sourceConds.push(office.length === 1 ? office[0] : { AND: office });
    }

    // (ب) ملفات ميركاتو — مطابقة اسم المندوب العلمي وحدها.
    if (mercatoFileIds.length > 0 && nameMatchIds.length > 0) {
      sourceConds.push({ uploadedFileId: { in: mercatoFileIds }, representativeId: { in: nameMatchIds } });
    }

    if (sourceConds.length === 0) return null; // no rep info → return nothing

    const conditions = [sourceConds.length === 1 ? sourceConds[0] : { OR: sourceConds }];
    if (hasItems) conditions.push({ itemId: { in: itemIds } });
    // Globally-blocked areas/items narrow the scope further — excluded regardless
    // of which commercial rep the sale/return belongs to.
    if (blockedAreaIds.length) conditions.push({ NOT: { areaId: { in: blockedAreaIds } } });
    if (blockedItemIds.length) conditions.push({ NOT: { itemId: { in: blockedItemIds } } });
    if (blockedCustomerIds.length) conditions.push({ NOT: { customerId: { in: blockedCustomerIds } } });
    // حجب جزئي: يستبعد فقط صفوف (هذا المندوب AND إحدى مناطقه المحجوبة) معاً —
    // بقية مناطقه، وبقية المندوبين في نفس المناطق، يبقون ظاهرين.
    if (blockedRepAreaConds.length) conditions.push({ NOT: { OR: blockedRepAreaConds } });
    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  };

  const meta = {
    rep, commercialLinks, areaLinks, itemLinks,
    explicitCommRepIds, expandedCommRepIds, nameMatchIds, areaIds, itemIds, fileIds,
  };

  if (!fileIds || fileIds.length === 0) {
    return { ...meta, rawSales: [], sharedFileIds: [], nonSharedFileIds: [], linkedUserId: null };
  }

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
  if (linkedUser) {
    const sharedFiles = await prisma.uploadedFile.findMany({
      where: { id: { in: fileIds }, fileShares: { some: { userId: linkedUser.id } } },
      select: { id: true },
    });
    sharedFileIds = sharedFiles.map(f => f.id);
  }
  // Files NOT shared directly with the rep → use normal name/area filter
  const nonSharedFileIds = fileIds.filter(fid => !sharedFileIds.includes(fid));

  let rawSales = [];
  const salesWhere = buildSalesWhere();

  if (salesWhere) {
    const dateFilter = (startDate || endDate)
      ? { saleDate: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } }
      : {};

    // ── A. Shared files ────────────────────────────────────────────────────
    if (sharedFileIds.length > 0) {
      const sharedSales = await prisma.sale.findMany({
        where: {
          ...(sharedFileIds.length === 1 ? { uploadedFileId: sharedFileIds[0] } : { uploadedFileId: { in: sharedFileIds } }),
          ...dateFilter,
          ...(recordType ? { recordType } : {}),
          ...salesWhere,
        },
        select,
      });
      rawSales = rawSales.concat(sharedSales);
    }

    // ── B. Non-shared files: name-match + explicit-rep + area/item filter ──
    if (nonSharedFileIds.length > 0) {
      const nonSharedSales = await prisma.sale.findMany({
        where: {
          ...(nonSharedFileIds.length === 1 ? { uploadedFileId: nonSharedFileIds[0] } : { uploadedFileId: { in: nonSharedFileIds } }),
          ...dateFilter,
          ...(recordType ? { recordType } : {}),
          ...salesWhere,
        },
        select,
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

  return { ...meta, rawSales: deduped, sharedFileIds, nonSharedFileIds, linkedUserId: linkedUser?.id ?? null };
}

const REPORT_SALES_SELECT = {
  quantity: true, totalValue: true,
  areaId: true, itemId: true, customerId: true,
  saleDate: true, recordType: true, uploadedFileId: true,
  area: { select: { id: true, name: true } },
  item: { select: { id: true, name: true } },
  representative: { select: { id: true, name: true } },
  // Per-file currency so aggregateSalesWithReps can normalize each row to USD
  // before summing (files may mix USD/IQD — raw sums across them are wrong).
  uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
};

/**
 * Generate a sales report for a scientific representative.
 * Aggregates across all assigned commercial reps,
 * filtered by assigned areas + items.
 */
export async function getReport(id, query = {}) {
  const resolved = await resolveSciRepSales(id, query, REPORT_SALES_SELECT);
  const { rep, commercialLinks, areaLinks, itemLinks, rawSales, fileIds } = resolved;

  // Reports/exports must show the rep's CURRENT name, not the static `name` column
  // (which is only set once at auto-creation and can drift — e.g. a Super Admin
  // renaming the linked User's displayName doesn't retroactively touch this row).
  // ScientificRepsPage already resolves the live name the same way for user-linked
  // reps; mirror that here so exports can never lag behind a rename.
  let displayName = rep.name;
  if (rep.userId) {
    const linkedUserRow = await prisma.user.findUnique({ where: { id: rep.userId }, select: { displayName: true, username: true } });
    if (linkedUserRow) displayName = linkedUserRow.displayName || linkedUserRow.username;
  }

  if (!fileIds || fileIds.length === 0) {
    return {
      scientificRep: { id: rep.id, name: displayName, isActive: rep.isActive },
      assignedCommercialReps: commercialLinks.map(l => l.commercialRep),
      assignedAreas: areaLinks.map(l => l.area),
      assignedItems: itemLinks.map(l => l.item),
      dateRange: { startDate: query.startDate ?? null, endDate: query.endDate ?? null },
      summary: { totalQuantity: 0, totalValue: 0 },
      byArea: [], byItem: [], byRep: [],
    };
  }

  const aggregated = aggregateSalesWithReps(rawSales);
  console.log('[SciRep.getReport] aggregated totals:', JSON.stringify(aggregated.totals), 'rows:', rawSales.length);
  const { totals, byArea, byItem, byRep } = aggregated;

  return {
    scientificRep: { id: rep.id, name: displayName, isActive: rep.isActive },
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
      sharedFileIds: resolved.sharedFileIds,
      nonSharedFileIds: resolved.nonSharedFileIds,
      linkedUserId: resolved.linkedUserId,
      nameMatchIds: resolved.nameMatchIds,
      explicitCommRepIds: resolved.explicitCommRepIds,
      expandedCommRepIds: resolved.expandedCommRepIds,
      areaIds: resolved.areaIds,
      itemIds: resolved.itemIds,
      rawRowCount: rawSales.length,
      totals,
    },
  };
}

const EXPORT_SALES_SELECT = {
  quantity: true, totalValue: true, recordType: true, saleDate: true, rawData: true,
  areaId: true, itemId: true, customerId: true, uploadedFileId: true,
  // province احتياط للتصدير: يملأ خلية «محافظة» الفارغة (ملف بلا العمود، أو
  // خانات فارغة فيه) من مطابقة اسم المنطقة نفسها — «الفلوجة» → «الأنبار» مثلاً
  // عبر aliases في provinces.js — بدل تركها فارغة كما وردت حرفياً في الملف.
  area: { select: { id: true, name: true, province: { select: { name: true } } } },
  item: { select: { id: true, name: true } },
  representative: { select: { id: true, name: true } },
  uploadedFile: { select: { detectedCurrency: true, exchangeRate: true } },
};

/**
 * Raw (non-aggregated) Sale rows for a scientific rep's Excel export.
 * Uses the EXACT same filter as getReport() via resolveSciRepSales(), so
 * export totals always match the on-screen report's totals.
 */
export async function getRawSalesForExport(id, query = {}) {
  const { rawSales } = await resolveSciRepSales(id, query, EXPORT_SALES_SELECT);
  return rawSales;
}
