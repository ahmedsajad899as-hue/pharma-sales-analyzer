import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';
import { normalizeAreaName } from '../../lib/itemResolver.js';

// Field reps never own Doctor rows under their own userId — doctors belong to
// the rep's manager (via ScientificRepresentative.userId) or, failing that, the
// rep's UserManagerAssignment.managerId. Mirrors the inline resolution used in
// list() (browseManagerId) so any endpoint reading a rep's doctors/pharmacies
// resolves the same owner. Non-field roles own their own data (returns userId).
export async function resolveDocOwnerUserId(userId) {
  const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
  const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, linkedRepId: true } });
  if (!userRecord || !FIELD_ROLES.includes(userRecord.role)) return userId;
  let ownerId = userId;
  if (userRecord.linkedRepId) {
    const repRecord = await prisma.scientificRepresentative.findUnique({
      where: { id: userRecord.linkedRepId }, select: { userId: true },
    });
    if (repRecord?.userId) ownerId = repRecord.userId;
  }
  if (ownerId === userId) {
    const managerAssign = await prisma.userManagerAssignment.findFirst({
      where: { userId }, select: { managerId: true },
    });
    if (managerAssign?.managerId) ownerId = managerAssign.managerId;
  }
  return ownerId;
}

export async function visitsByArea(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;

    // Optional month/year filter
    const filterMonth = req.query.month ? parseInt(req.query.month) : null;
    const filterYear  = req.query.year  ? parseInt(req.query.year)  : null;
    const dateFilter  = (filterMonth && filterYear) ? {
      gte: new Date(filterYear, filterMonth - 1, 1),
      lt:  new Date(filterYear, filterMonth, 1),
    } : undefined;

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    // ── Arabic normalization (used in both branches) ──────────
    const normArea = normalizeAreaName;

    let doctors;
    let fieldRepAssignedNormSet = null; // used later to filter final areas
    let fieldRepAssignedAreas   = null;

    if (isFieldRep) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const linkedRepId = userRow?.linkedRepId;
      // Also resolve via ScientificRepresentative.userId (same logic as visit creation)
      let ownRepId = linkedRepId;
      if (!ownRepId) {
        const ownRep = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
        ownRepId = ownRep?.id ?? null;
      }

      // ── 1. Get rep's assigned area IDs ────────────────────────
      // Union of both sources using raw areaId column (same as list endpoint)
      const [uaRows, saRows] = await Promise.all([
        prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
        ownRepId
          ? prisma.scientificRepArea.findMany({ where: { scientificRepId: ownRepId }, select: { areaId: true } })
          : Promise.resolve([]),
      ]);
      const repAreaIds = [...new Set([...uaRows.map(r => r.areaId), ...saRows.map(r => r.areaId)])];

      console.log('[visitsByArea] userId:', userId, 'repAreaIds:', repAreaIds);

      if (repAreaIds.length === 0) return res.json({ areas: [] });

      // ── 2. Get area names from IDs (for survey matching) ──────
      const areaRecords = await prisma.area.findMany({
        where: { id: { in: repAreaIds } },
        select: { id: true, name: true },
      });
      const normToArea = new Map(areaRecords.map(a => [normArea(a.name), a]));
      const normAreaNames = [...normToArea.keys()];

      // ── 3. Get active survey doctors in rep's areas ───────────
      const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
      const surveyIds = surveys.map(s => s.id);
      let surveyDoctors = [];
      if (surveyIds.length > 0) {
        const allSurveyDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: { in: surveyIds } },
          select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true },
          orderBy: { name: 'asc' },
        });
        surveyDoctors = normAreaNames.length > 0
          ? allSurveyDocs.filter(d => d.areaName?.trim() && normAreaNames.includes(normArea(d.areaName)))
          : allSurveyDocs;
      }

      // ── 4. Get rep's visits and map by masterSurveyDoctorId + name fallback ───
      // OR: visits stored with scientificRepId OR directly with userId (covers all recording paths)
      const visitOrClauses = [];
      if (ownRepId) visitOrClauses.push({ scientificRepId: ownRepId });
      visitOrClauses.push({ userId });
      const allVisits = await prisma.doctorVisit.findMany({
        where: {
          OR: visitOrClauses,
          ...(dateFilter ? { visitDate: dateFilter } : {}),
        },
        select: {
          id: true, visitDate: true, feedback: true, notes: true,
          item: { select: { id: true, name: true } },
          doctor: { select: { masterSurveyDoctorId: true, name: true } },
        },
        orderBy: { visitDate: 'desc' },
      });
      const visitsBySurveyDocId = new Map();
      const visitsByDoctorName  = new Map();
      for (const v of allVisits) {
        const vEntry = { id: v.id, visitDate: v.visitDate, feedback: v.feedback, notes: v.notes, item: v.item };
        const msId = v.doctor?.masterSurveyDoctorId;
        if (msId != null) {
          if (!visitsBySurveyDocId.has(msId)) visitsBySurveyDocId.set(msId, []);
          visitsBySurveyDocId.get(msId).push(vEntry);
        }
        if (v.doctor?.name) {
          const nk = normArea(v.doctor.name);
          if (!visitsByDoctorName.has(nk)) visitsByDoctorName.set(nk, []);
          visitsByDoctorName.get(nk).push(vEntry);
        }
      }

      // ── 5. Build doctors array from survey ────────────────────
      doctors = surveyDoctors.map(d => {
        const resolvedArea = normToArea.get(normArea(d.areaName ?? '')) ?? (d.areaName?.trim() ? { id: null, name: d.areaName.trim() } : null);
        const visits = visitsBySurveyDocId.get(d.id) ?? visitsByDoctorName.get(normArea(d.name)) ?? [];
        return {
          id: d.id, name: d.name, specialty: d.specialty ?? null,
          pharmacyName: d.pharmacyName ?? null,
          area: resolvedArea, targetItem: null, isActive: true, planEntries: [],
          visits,
        };
      }).filter(d => d.area !== null);
      console.log('[visitsByArea] repAreaIds count:', repAreaIds.length, 'surveyDoctors:', doctors.length);

    } else {
      // للمدير: فلترة حسب مندوب محدد أو جميع الأطباء
      const repUserId = req.query.repUserId ? parseInt(req.query.repUserId) : null;

      if (repUserId) {
        // جلب معلومات المندوب المحدد
        const subUser = await prisma.user.findUnique({
          where: { id: repUserId },
          select: { linkedRepId: true },
        });
        const subLinkedRepId = subUser?.linkedRepId ?? null;
        // Also resolve via ScientificRepresentative.userId
        let subOwnRepId = subLinkedRepId;
        if (!subOwnRepId) {
          const subOwnRep = await prisma.scientificRepresentative.findFirst({ where: { userId: repUserId }, select: { id: true } });
          subOwnRepId = subOwnRep?.id ?? null;
        }

        // مناطق المندوب
        const [uaRows, saRows] = await Promise.all([
          prisma.userAreaAssignment.findMany({ where: { userId: repUserId }, select: { areaId: true } }),
          subOwnRepId
            ? prisma.scientificRepArea.findMany({ where: { scientificRepId: subOwnRepId }, select: { areaId: true } })
            : Promise.resolve([]),
        ]);
        const repAreaIds = [...new Set([...uaRows.map(r => r.areaId), ...saRows.map(r => r.areaId)])];

        // زيارات المندوب المحدد — OR: scientificRepId OR userId (يشمل جميع مسارات التسجيل)
        const subOrClauses = [];
        if (subOwnRepId) subOrClauses.push({ scientificRepId: subOwnRepId });
        subOrClauses.push({ userId: repUserId });
        const repVisits = await prisma.doctorVisit.findMany({
          where: {
            OR: subOrClauses,
            ...(dateFilter ? { visitDate: dateFilter } : {}),
          },
          select: {
            id: true, visitDate: true, feedback: true, notes: true,
            item: { select: { id: true, name: true } },
            doctor: { select: { masterSurveyDoctorId: true, name: true } },
          },
          orderBy: { visitDate: 'desc' },
        });

        // Get area names for survey matching
        const areaRecords = await prisma.area.findMany({
          where: repAreaIds.length > 0 ? { id: { in: repAreaIds } } : { id: -1 },
          select: { id: true, name: true },
        });
        const normToArea = new Map(areaRecords.map(a => [normArea(a.name), a]));
        const normAreaNames = [...normToArea.keys()];

        // Get active survey doctors in rep's areas
        const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
        const surveyIds = surveys.map(s => s.id);
        let surveyDoctors = [];
        if (surveyIds.length > 0) {
          const allSurveyDocs = await prisma.masterSurveyDoctor.findMany({
            where: { surveyId: { in: surveyIds } },
            select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true },
            orderBy: { name: 'asc' },
          });
          surveyDoctors = normAreaNames.length > 0
            ? allSurveyDocs.filter(d => d.areaName?.trim() && normAreaNames.includes(normArea(d.areaName)))
            : allSurveyDocs;
        }

        // Map visits by masterSurveyDoctorId (primary) and doctor name (fallback)
        const visitsBySurveyDocId = new Map();
        const visitsByDoctorName  = new Map();
        for (const v of repVisits) {
          const vEntry = { id: v.id, visitDate: v.visitDate, feedback: v.feedback, notes: v.notes, item: v.item };
          const msId = v.doctor?.masterSurveyDoctorId;
          if (msId != null) {
            if (!visitsBySurveyDocId.has(msId)) visitsBySurveyDocId.set(msId, []);
            visitsBySurveyDocId.get(msId).push(vEntry);
          }
          if (v.doctor?.name) {
            const nk = normArea(v.doctor.name);
            if (!visitsByDoctorName.has(nk)) visitsByDoctorName.set(nk, []);
            visitsByDoctorName.get(nk).push(vEntry);
          }
        }

        doctors = surveyDoctors.map(d => {
          const resolvedArea = normToArea.get(normArea(d.areaName ?? '')) ?? (d.areaName?.trim() ? { id: null, name: d.areaName.trim() } : null);
          const visits = visitsBySurveyDocId.get(d.id) ?? visitsByDoctorName.get(normArea(d.name)) ?? [];
          return {
            id: d.id, name: d.name, specialty: d.specialty ?? null,
            pharmacyName: d.pharmacyName ?? null,
            area: resolvedArea, targetItem: null, isActive: true, planEntries: [],
            visits,
          };
        }).filter(d => d.area !== null);
      } else {
      // الكل: جلب أطباءه جميعاً دائماً، وفلتر الزيارات فقط حسب الشهر
      doctors = await prisma.doctor.findMany({
        where: { userId },
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
          masterSurveyDoctor: { select: { areaName: true } },
          visits: {
            where: dateFilter ? { visitDate: dateFilter } : undefined,
            orderBy: { visitDate: 'desc' },
            select: {
              id: true, visitDate: true, feedback: true, notes: true,
              item: { select: { id: true, name: true } },
            },
          },
          // Infer area from plan entries when Doctor.areaId is null
          planEntries: {
            take: 1,
            select: {
              plan: {
                select: {
                  planAreas: {
                    take: 1,
                    select: { area: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      });

      // Resolve area for doctors with no areaId
      const allAreasForLookup = await prisma.area.findMany({ select: { id: true, name: true } });
      const areaByNormLookup = new Map(allAreasForLookup.map(a => [normArea(a.name), a]));

      // Build name→areaName map from active survey for fallback matching by doctor name
      const activeSurveyForLookup = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, orderBy: { createdAt: 'desc' }, select: { id: true },
      });
      const surveyNameToArea = new Map(); // normName(doctorName) → { id, name }
      if (activeSurveyForLookup) {
        const surveyDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: activeSurveyForLookup.id, areaName: { not: null } },
          select: { name: true, areaName: true },
        });
        for (const sd of surveyDocs) {
          if (!sd.areaName?.trim()) continue;
          const area = areaByNormLookup.get(normArea(sd.areaName)) ?? { id: null, name: sd.areaName.trim() };
          surveyNameToArea.set(normArea(sd.name), area);
        }
      }

      doctors = doctors.map(d => {
        if (d.area) return d;
        // 1. Try via masterSurveyDoctor.areaName
        const surveyAreaName = d.masterSurveyDoctor?.areaName?.trim();
        if (surveyAreaName) {
          const resolved = areaByNormLookup.get(normArea(surveyAreaName)) ?? { id: null, name: surveyAreaName };
          return { ...d, area: resolved };
        }
        // 2. Try matching doctor name against active survey
        const surveyMatch = surveyNameToArea.get(normArea(d.name));
        if (surveyMatch) return { ...d, area: surveyMatch };
        return d;
      });
      } // end else (all reps)
    }

    const areaMap = new Map();   // key = normName(areaName)
    const noAreaDocs = [];

    const normName = normalizeAreaName;

    const canonicalName = new Map();

    for (const d of doctors) {
      const visited   = d.visits.length > 0;
      const isWriting = d.visits.some(v => v.feedback === 'writing');
      const effectiveArea = d.area ?? d.planEntries?.[0]?.plan?.planAreas?.[0]?.area ?? null;
      const doc = {
        id: d.id, name: d.name, specialty: d.specialty,
        pharmacyName: d.pharmacyName ?? null,
        area: effectiveArea,
        targetItem: d.targetItem ?? null, isActive: d.isActive,
        visited, isWriting, visits: d.visits,
      };
      if (effectiveArea) {
        const key = normName(effectiveArea.name);
        if (!canonicalName.has(key)) canonicalName.set(key, effectiveArea.name);
        if (!areaMap.has(key))
          areaMap.set(key, { id: effectiveArea.id, name: canonicalName.get(key), doctors: [] });
        areaMap.get(key).doctors.push(doc);
      } else {
        noAreaDocs.push(doc);
      }
    }

    const toStats = g => ({
      ...g,
      totalDoctors: g.doctors.length,
      visitedCount: g.doctors.filter(d => d.visited).length,
      writingCount: g.doctors.filter(d => d.isWriting).length,
    });

    // For field reps: all doctors were already fetched by exact areaId - no extra filtering needed
    const filteredAreaEntries = [...areaMap.entries()];

    const areas = filteredAreaEntries.map(([, g]) => toStats(g))
      .sort((a, b) => b.visitedCount - a.visitedCount);

    const noAreaStats = {
      total:   noAreaDocs.length,
      visited: noAreaDocs.filter(d => d.visited).length,
      writing: noAreaDocs.filter(d => d.isWriting).length,
    };

    res.json({ areas, noAreaStats });
  } catch (e) { next(e); }
}

// ─── Pharmacy Visits by Area (for visits analysis toggle) ──────
export async function pharmacyVisitsByArea(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;

    const filterMonth = req.query.month ? parseInt(req.query.month) : null;
    const filterYear  = req.query.year  ? parseInt(req.query.year)  : null;
    const dateFilter  = (filterMonth && filterYear) ? {
      gte: new Date(filterYear, filterMonth - 1, 1),
      lt:  new Date(filterYear, filterMonth, 1),
    } : undefined;

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let linkedRepId = null;
    if (isFieldRep) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      linkedRepId = userRow?.linkedRepId;
    }

    // اختياري: فلترة حسب مندوب محدد (للمدير فقط)
    const repUserIdPharma = (!isFieldRep && req.query.repUserId) ? parseInt(req.query.repUserId) : null;
    let subLinkedRepIdPharma = null;
    if (repUserIdPharma) {
      const subUserPharma = await prisma.user.findUnique({
        where: { id: repUserIdPharma },
        select: { linkedRepId: true },
      });
      subLinkedRepIdPharma = subUserPharma?.linkedRepId ?? null;
    }

    const visitWhere = isFieldRep
      ? { scientificRepId: linkedRepId ?? -1, ...(dateFilter ? { visitDate: dateFilter } : {}) }
      : repUserIdPharma
        ? subLinkedRepIdPharma
          ? { scientificRepId: subLinkedRepIdPharma, ...(dateFilter ? { visitDate: dateFilter } : {}) }
          : { userId: repUserIdPharma, ...(dateFilter ? { visitDate: dateFilter } : {}) }
        : { userId, ...(dateFilter ? { visitDate: dateFilter } : {}) };

    const visits = await prisma.pharmacyVisit.findMany({
      where: visitWhere,
      include: {
        area:  { select: { id: true, name: true } },
        items: { include: { item: { select: { id: true, name: true } } } },
      },
      orderBy: { visitDate: 'desc' },
    });

    // Group by area
    const areaMap = new Map();
    const noAreaVisits = [];

    for (const v of visits) {
      const areaKey = v.areaId ?? v.areaName ?? '__none__';
      const areaLabel = v.area?.name ?? v.areaName ?? 'بدون منطقة';
      const areaId    = v.area?.id ?? null;
      if (!areaMap.has(areaKey))
        areaMap.set(areaKey, { id: areaId, name: areaLabel, pharmacies: new Map() });
      const areaEntry = areaMap.get(areaKey);
      if (!areaEntry.pharmacies.has(v.pharmacyName))
        areaEntry.pharmacies.set(v.pharmacyName, { name: v.pharmacyName, visits: [] });
      areaEntry.pharmacies.get(v.pharmacyName).visits.push({
        id: v.id,
        visitDate: v.visitDate,
        notes: v.notes,
        items: v.items.map(i => ({ id: i.id, name: i.item?.name ?? i.itemName ?? '—' })),
      });
    }

    const areas = [...areaMap.values()].map(a => ({
      id: a.id,
      name: a.name,
      pharmacies: [...a.pharmacies.values()],
      totalPharmacies: a.pharmacies.size,
      totalVisits: [...a.pharmacies.values()].reduce((s, p) => s + p.visits.length, 0),
    })).sort((a, b) => b.totalVisits - a.totalVisits);

    res.json({ areas });
  } catch (e) { next(e); }
}

export async function list(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const { areaId, isActive, q } = req.query;

    // ── Parse user doctor-search-filter settings from permissions ──
    const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { permissions: true, linkedRepId: true } });
    let perms = {};
    try { perms = JSON.parse(userRecord?.permissions || '{}'); } catch {}
    const filterByArea     = perms.doctorFilterByArea !== false;   // default true
    const filterPlanMode   = perms.doctorFilterPlanMode || 'plan_and_all';
    const filterSurveyOnly = perms.doctorFilterSurveyOnly === true;

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let where;

    if (isFieldRep) {
      // جلب المناطق من كلا المصدرين: UserAreaAssignment (الأدمن) + ScientificRepArea (مدير المناطق)
      const linkedRepId = userRecord?.linkedRepId;

      if (q?.trim()) {
        // ── جلب مناطق المندوب أولاً (مصدر رئيسي لفلترة البحث) ──
        const [userAreaRows, repAreaRows] = await Promise.all([
          prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
          linkedRepId
            ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
            : Promise.resolve([]),
        ]);
        const repAreaIds = [...new Set([
          ...userAreaRows.map(a => a.areaId),
          ...repAreaRows.map(a => a.areaId),
        ])];

        const nameFilter = { name: { contains: q.trim() } };

        if (filterByArea && repAreaIds.length > 0) {
          // ── الأولوية: فلتر المناطق (لا يحتاج لمعرفة userId المدير) ──
          const areaFilter = { OR: [{ areaId: { in: repAreaIds } }, { areaId: null }] };
          where = { AND: [nameFilter, areaFilter] };
          // Store for post-filtering null-area doctors by survey areaName
          var _filterRepAreaIds = repAreaIds;
        } else {
          // ── احتياطي: استخدام userId المدير (عندما لا توجد مناطق أو filterByArea=false) ──
          let managerUserId = userId; // fallback
          if (linkedRepId) {
            const repRecord = await prisma.scientificRepresentative.findUnique({
              where: { id: linkedRepId },
              select: { userId: true },
            });
            if (repRecord?.userId) managerUserId = repRecord.userId;
          }
          // إذا لم ينجح linkedRepId (userId=null أو غير محدد)، نحاول UserManagerAssignment
          if (managerUserId === userId) {
            const managerAssign = await prisma.userManagerAssignment.findFirst({
              where: { userId },
              select: { managerId: true },
            });
            if (managerAssign?.managerId) managerUserId = managerAssign.managerId;
          }
          where = { userId: managerUserId, ...nameFilter };
        }

        if (areaId)                 where.areaId   = parseInt(areaId);
        if (isActive !== undefined) where.isActive = (isActive === 'true');
      } else {
        // ── عند التصفح (بدون q): استخدام فلتر المناطق + null-area docs من المدير ──
        const [userAreaRows, repAreaRows] = await Promise.all([
          prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
          linkedRepId
            ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
            : Promise.resolve([]),
        ]);
        const repAreaIds = [...new Set([
          ...userAreaRows.map(a => a.areaId),
          ...repAreaRows.map(a => a.areaId),
        ])];

        // نحتاج userId المدير لتضمين الأطباء الذين areaId = null (مسجلين تحت المدير)
        let browseManagerId = userId;
        if (linkedRepId) {
          const repRecord = await prisma.scientificRepresentative.findUnique({
            where: { id: linkedRepId }, select: { userId: true },
          });
          if (repRecord?.userId) browseManagerId = repRecord.userId;
        }
        if (browseManagerId === userId) {
          const managerAssign = await prisma.userManagerAssignment.findFirst({
            where: { userId }, select: { managerId: true },
          });
          if (managerAssign?.managerId) browseManagerId = managerAssign.managerId;
        }

        const baseWhere = repAreaIds.length > 0
          // فقط أطباء المدير في مناطق المندوب المحددة
          ? { userId: browseManagerId, areaId: { in: repAreaIds } }
          : { userId: browseManagerId };

        const andFilters = [];
        if (areaId)                 andFilters.push({ areaId: parseInt(areaId) });
        if (isActive !== undefined) andFilters.push({ isActive: isActive === 'true' });

        where = andFilters.length > 0
          ? { AND: [baseWhere, ...andFilters] }
          : baseWhere;

        // ── Auto-import: استيراد كل أطباء السيرفي في مناطق المندوب دفعة واحدة ──
        if (repAreaIds.length > 0) {
          try {
            // أسماء مناطق المندوب
            const repAreaRecords = await prisma.area.findMany({
              where: { id: { in: repAreaIds } },
              select: { id: true, name: true },
            });
            const repAreaNameToId = new Map(repAreaRecords.map(a => [normalizeAreaName(a.name), a.id]));
            const repAreaNormNames = [...repAreaNameToId.keys()];

            const activeSurvey = await prisma.masterSurvey.findFirst({
              where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
            });
            if (activeSurvey && repAreaNormNames.length > 0) {
              // كل أطباء السيرفي في مناطق المندوب
              const allSurveyDocs = await prisma.masterSurveyDoctor.findMany({
                where: { surveyId: activeSurvey.id, areaName: { not: null } },
                select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true },
              });
              const surveyDocsInAreas = allSurveyDocs.filter(d =>
                d.areaName?.trim() && repAreaNormNames.includes(normalizeAreaName(d.areaName))
              );

              if (surveyDocsInAreas.length > 0) {
                // الأطباء الموجودون فعلاً تحت المدير
                const existing = await prisma.doctor.findMany({
                  where: {
                    userId: browseManagerId,
                    name: { in: surveyDocsInAreas.map(d => d.name.trim()) },
                  },
                  select: { id: true, name: true, areaId: true },
                });
                const existingByName = new Map(
                  existing.map(d => [d.name.trim().toLowerCase(), d])
                );

                const toCreate = [];
                const toFix = [];
                for (const sd of surveyDocsInAreas) {
                  const nameKey = sd.name.trim().toLowerCase();
                  const resolvedAreaId = repAreaNameToId.get(normalizeAreaName(sd.areaName)) || null;
                  const ex = existingByName.get(nameKey);
                  if (ex) {
                    if (!ex.areaId && resolvedAreaId) toFix.push({ id: ex.id, areaId: resolvedAreaId });
                  } else {
                    toCreate.push({
                      name: sd.name.trim(),
                      specialty: sd.specialty || null,
                      pharmacyName: sd.pharmacyName || null,
                      areaId: resolvedAreaId,
                      userId: browseManagerId,
                    });
                  }
                }

                if (toCreate.length > 0) {
                  await prisma.doctor.createMany({ data: toCreate, skipDuplicates: true });
                }
                for (const fix of toFix) {
                  await prisma.doctor.update({ where: { id: fix.id }, data: { areaId: fix.areaId } });
                }
              }
            }
          } catch (err) {
            console.error('[doctors.list] auto-import failed:', err?.message);
          }
        }
      }

    } else {
      // مدير: كل أطبائه
      where = { userId };
      if (areaId)                 where.areaId   = parseInt(areaId);
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (q?.trim())              where.name     = { contains: q.trim() };
    }

    // ── Step 1: Auto-import survey doctors into Doctor table (before any filters) ──
    if (q?.trim().length >= 2) {
      // Resolve owner userId for new Doctor creation
      let ownerUserId = userId;
      if (isFieldRep) {
        if (userRecord?.linkedRepId) {
          const repRow = await prisma.scientificRepresentative.findUnique({
            where: { id: userRecord.linkedRepId }, select: { userId: true },
          });
          if (repRow?.userId) ownerUserId = repRow.userId;
        }
        // إذا لم ينجح linkedRepId (userId=null)، نحاول UserManagerAssignment
        if (ownerUserId === userId) {
          const managerAssign = await prisma.userManagerAssignment.findFirst({
            where: { userId }, select: { managerId: true },
          });
          if (managerAssign?.managerId) ownerUserId = managerAssign.managerId;
        }
      }

      const activeSurvey = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
      });
      if (activeSurvey) {
        const surveyMatches = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: activeSurvey.id, name: { contains: q.trim() } },
          select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true },
          take: 30,
        });
        if (surveyMatches.length > 0) {
          // Build area-name → areaId map from ALL areas (not just ownerUserId)
          // Areas may belong to another userId but be assigned via UserAreaAssignment
          // Uses Arabic normalization: ة→ه, أإآ→ا, ى→ي, "ال" so "الحارثية" matches "الحارثيه"/"حارثية"
          const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
          const areaNameMap = new Map();
          for (const a of allAreas) {
            const key = normalizeAreaName(a.name);
            if (!areaNameMap.has(key)) areaNameMap.set(key, a.id);
          }

          // Check which survey doctors already exist in Doctor table (by name + owner)
          const existingDocs = await prisma.doctor.findMany({
            where: { userId: ownerUserId, name: { in: surveyMatches.map(s => s.name.trim()) } },
            select: { id: true, name: true, areaId: true },
          });
          const existingByName = new Map(existingDocs.map(d => [d.name.trim().toLowerCase(), d]));

          for (const sd of surveyMatches) {
            const nameKey = sd.name.trim().toLowerCase();
            const resolvedAreaId = sd.areaName?.trim()
              ? (areaNameMap.get(normalizeAreaName(sd.areaName)) || null)
              : null;

            const existing = existingByName.get(nameKey);
            if (existing) {
              // Fix null areaId on already-imported doctors if we can resolve it now
              if (!existing.areaId && resolvedAreaId) {
                await prisma.doctor.update({
                  where: { id: existing.id },
                  data: { areaId: resolvedAreaId },
                });
              }
              continue;
            }
            await prisma.doctor.create({
              data: {
                name: sd.name.trim(),
                specialty: sd.specialty || null,
                pharmacyName: sd.pharmacyName || null,
                areaId: resolvedAreaId,
                userId: ownerUserId,
              },
            });
            existingByName.set(nameKey, { id: 0, name: sd.name.trim(), areaId: resolvedAreaId });
          }
        }
      }
    }

    // ── Step 2: Apply plan filter (plan_only mode) ──
    if (filterPlanMode === 'plan_only' && q?.trim()) {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear  = now.getFullYear();
      const plan = await prisma.monthlyPlan.findFirst({
        where: {
          OR: [{ userId }, { assignedUserId: userId }],
          month: currentMonth, year: currentYear,
        },
        select: { id: true },
      });
      if (plan) {
        const planEntries = await prisma.planEntry.findMany({
          where: { planId: plan.id }, select: { doctorId: true },
        });
        where = { AND: [where, { id: { in: planEntries.map(e => e.doctorId) } }] };
      } else {
        where = { AND: [where, { id: { in: [] } }] };
      }
    }

    // ── Step 3: Fetch from Doctor table (with all where filters applied) ──
    const isSearch = Boolean(q?.trim());
    const doctors = await prisma.doctor.findMany({
      where,
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
      },
      take: isSearch ? 50 : undefined,
      orderBy: { name: 'asc' },
    });

    // ── Step 3b: Enrich null-area doctors with survey areaName + post-filter by rep areas ──
    if (isSearch) {
      const noAreaDocs = doctors.filter(d => !d.area);
      if (noAreaDocs.length > 0) {
        const activeSurveyForArea = await prisma.masterSurvey.findFirst({
          where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
        });
        if (activeSurveyForArea) {
          const surveyRows = await prisma.masterSurveyDoctor.findMany({
            where: { surveyId: activeSurveyForArea.id, name: { in: noAreaDocs.map(d => d.name.trim()) } },
            select: { name: true, areaName: true },
          });
          const surveyAreaMap = new Map();
          for (const s of surveyRows) {
            if (s.areaName?.trim()) surveyAreaMap.set(s.name.trim().toLowerCase(), s.areaName.trim());
          }
          for (const d of noAreaDocs) {
            const sArea = surveyAreaMap.get(d.name.trim().toLowerCase());
            if (sArea) d.area = { id: null, name: sArea };
          }
        }
      }

      // Post-filter: if area filter active, remove null-area doctors whose survey area doesn't match rep's areas
      if (_filterRepAreaIds && _filterRepAreaIds.length > 0) {
        const repAreaNames = await prisma.area.findMany({
          where: { id: { in: _filterRepAreaIds } }, select: { name: true },
        });
        const allowedAreaNames = new Set(repAreaNames.map(a => a.name.trim().toLowerCase()));
        const toRemove = new Set();
        for (const d of doctors) {
          if (d.areaId) continue; // already matched by areaId filter
          const areaName = d.area?.name;
          if (!areaName || !allowedAreaNames.has(areaName.trim().toLowerCase())) {
            toRemove.add(d.id);
          }
        }
        if (toRemove.size > 0) {
          doctors.splice(0, doctors.length, ...doctors.filter(d => !toRemove.has(d.id)));
        }
      }
    }

    // ── Step 4: Apply survey filter (post-query, name matching) ──
    let finalDoctors = doctors;
    if (filterSurveyOnly && isSearch) {
      const activeSurvey = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
      });
      if (activeSurvey) {
        const surveyDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: activeSurvey.id }, select: { name: true },
        });
        const surveyNamesSet = new Set(surveyDocs.map(d =>
          d.name.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        ));
        finalDoctors = doctors.filter(d => {
          const norm = d.name.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
          return surveyNamesSet.has(norm);
        });
      }
    }

    // Sort: names that START with the query come first, then the rest (autocomplete only)
    if (isSearch) {
      const qNorm = q.trim().toLowerCase()
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
      finalDoctors.sort((a, b) => {
        const aN = a.name.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
        const bN = b.name.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
        const aStarts = aN.startsWith(qNorm) ? 0 : 1;
        const bStarts = bN.startsWith(qNorm) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return aN.localeCompare(bN, 'ar');
      });
      res.json(finalDoctors.slice(0, 10));
    } else {
      res.json(finalDoctors);
    }
  } catch (e) { next(e); }
}

export async function getOne(req, res, next) {
  try {
    const doctor = await prisma.doctor.findFirst({
      where: { id: parseInt(req.params.id), userId: req.user.id },
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
        visits: {
          orderBy: { visitDate: 'desc' },
          take: 10,
        },
      },
    });
    if (!doctor) return res.status(404).json({ error: 'Not found' });
    res.json(doctor);
  } catch (e) { next(e); }
}

export async function create(req, res, next) {
  try {
    const userId = req.user.id;
    const { name, specialty, areaId, areaName, pharmacyName, targetItemId, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    // Resolve areaId from areaName if only text was provided (create new area if not found)
    let resolvedAreaId = areaId ? parseInt(areaId) : null;
    if (!resolvedAreaId && areaName?.trim()) {
      const nameNorm = areaName.trim().toLowerCase();
      const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
      const found = allAreas.find(a => a.name.trim().toLowerCase() === nameNorm);
      if (found) {
        resolvedAreaId = found.id;
      } else {
        const newArea = await prisma.area.create({ data: { name: areaName.trim(), userId } });
        resolvedAreaId = newArea.id;
      }
    }

    // ── Sync Doctor → MasterSurvey ────────────────────────────
    // Find active survey; upsert this doctor by name (normalized)
    const normN = s => String(s ?? '').trim().toLowerCase()
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْ]/g, '');
    let masterSurveyDoctorId = null;
    try {
      const activeSurvey = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
      });
      if (activeSurvey) {
        // Resolve area name from areaId
        const areaRow = resolvedAreaId
          ? await prisma.area.findUnique({ where: { id: resolvedAreaId }, select: { name: true } })
          : null;
        const areaNameStr = areaRow?.name ?? areaName ?? null;
        // Find existing survey doctor by normalized name
        const allSurveyDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: activeSurvey.id }, select: { id: true, name: true },
        });
        const existing = allSurveyDocs.find(d => normN(d.name) === normN(name));
        if (existing) {
          masterSurveyDoctorId = existing.id;
          // Update survey doctor if we have new info
          await prisma.masterSurveyDoctor.update({
            where: { id: existing.id },
            data: {
              ...(specialty    ? { specialty }    : {}),
              ...(pharmacyName ? { pharmacyName } : {}),
              ...(areaNameStr  ? { areaName: areaNameStr } : {}),
            },
          });
        } else {
          const created = await prisma.masterSurveyDoctor.create({
            data: {
              surveyId: activeSurvey.id,
              name: name.trim(),
              specialty: specialty ?? null,
              pharmacyName: pharmacyName ?? null,
              areaName: areaNameStr ?? null,
            },
          });
          masterSurveyDoctorId = created.id;
          // Log this as a new entry added externally (not via SA panel)
          await prisma.masterSurveyEditLog.create({
            data: {
              surveyId: activeSurvey.id,
              entryType: 'doctor',
              entryId: created.id,
              action: 'create_external',
              oldData: null,
              newData: JSON.stringify({ name: created.name, specialty: created.specialty, pharmacyName: created.pharmacyName, areaName: created.areaName }),
              editedById: req.user?.id ?? null,
            },
          });
        }
      }
    } catch (_) { /* sync failure should not block doctor creation */ }

    const doctor = await prisma.doctor.create({
      data: {
        name, specialty, pharmacyName, notes,
        areaId:       resolvedAreaId ?? null,
        targetItemId: targetItemId ? parseInt(targetItemId) : null,
        userId,
        ...(masterSurveyDoctorId ? { masterSurveyDoctorId } : {}),
      },
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
      },
    });
    req._skipActivity = true;
    req._activityDetails = `إضافة طبيب: ${name}${specialty ? ' (' + specialty + ')' : ''}${doctor.area ? ' — ' + doctor.area.name : ''}`;
    res.status(201).json(doctor);
  } catch (e) { next(e); }
}

export async function update(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const id = parseInt(req.params.id);
    const { name, specialty, areaId, areaName, pharmacyName, targetItemId, notes, isActive } = req.body;
    let resolvedAreaId = areaId !== undefined ? (areaId ? parseInt(areaId) : null) : undefined;
    if (resolvedAreaId === undefined && areaName?.trim()) {
      const nameNorm = areaName.trim().toLowerCase();
      const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
      const found = allAreas.find(a => a.name.trim().toLowerCase() === nameNorm);
      if (found) {
        resolvedAreaId = found.id;
      } else {
        const newArea = await prisma.area.create({ data: { name: areaName.trim(), userId } });
        resolvedAreaId = newArea.id;
      }
    }

    // التحقق من وجود الطبيب أولاً (يمكن أن يكون مسجّلاً بحساب آخر لكن زاره المندوب)
    const existing = await prisma.doctor.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    // المندوب يمكنه تعديل أي طبيب زاره؛ المدير يعدّل أطباءه فقط
    if (!isFieldRep && existing.userId !== userId) {
      return res.status(403).json({ error: 'غير مصرح' });
    }

    await prisma.doctor.update({
      where: { id },
      data: {
        ...(name         !== undefined && { name }),
        ...(specialty    !== undefined && { specialty }),
        ...(pharmacyName !== undefined && { pharmacyName }),
        ...(notes        !== undefined && { notes }),
        ...(isActive     !== undefined && { isActive }),
        ...(resolvedAreaId !== undefined && { areaId: resolvedAreaId }),
        ...(targetItemId !== undefined && { targetItemId: targetItemId ? parseInt(targetItemId) : null }),
      },
    });

    // ── Sync Doctor update → MasterSurvey ──────────────────────
    try {
      const normN = s => String(s ?? '').trim().toLowerCase()
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/[ًٌٍَُِّْ]/g, '');
      const updatedDoc = await prisma.doctor.findUnique({
        where: { id },
        include: { area: { select: { name: true } } },
      });
      const activeSurvey = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
      });
      if (activeSurvey && updatedDoc) {
        const surveyUpdateData = {};
        if (name         !== undefined) surveyUpdateData.name         = updatedDoc.name;
        if (specialty    !== undefined) surveyUpdateData.specialty    = updatedDoc.specialty;
        if (pharmacyName !== undefined) surveyUpdateData.pharmacyName = updatedDoc.pharmacyName;
        if (resolvedAreaId !== undefined) surveyUpdateData.areaName   = updatedDoc.area?.name ?? null;
        if (Object.keys(surveyUpdateData).length > 0) {
          if (updatedDoc.masterSurveyDoctorId) {
            await prisma.masterSurveyDoctor.update({
              where: { id: updatedDoc.masterSurveyDoctorId },
              data: surveyUpdateData,
            });
          } else {
            // Find by normalized name and link
            const allSurveyDocs = await prisma.masterSurveyDoctor.findMany({
              where: { surveyId: activeSurvey.id }, select: { id: true, name: true },
            });
            const match = allSurveyDocs.find(d => normN(d.name) === normN(updatedDoc.name));
            if (match) {
              await prisma.masterSurveyDoctor.update({ where: { id: match.id }, data: surveyUpdateData });
              await prisma.doctor.update({ where: { id }, data: { masterSurveyDoctorId: match.id } });
            } else {
              // Not in survey yet — add it
              const created = await prisma.masterSurveyDoctor.create({
                data: {
                  surveyId: activeSurvey.id,
                  name:         updatedDoc.name,
                  specialty:    updatedDoc.specialty    ?? null,
                  pharmacyName: updatedDoc.pharmacyName ?? null,
                  areaName:     updatedDoc.area?.name   ?? null,
                },
              });
              await prisma.doctor.update({ where: { id }, data: { masterSurveyDoctorId: created.id } });
            }
          }
        }
      }
    } catch (_) { /* sync failure should not block doctor update */ }

    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function remove(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const id = parseInt(req.params.id);

    const existing = await prisma.doctor.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    // المندوب يحذف فقط أطباءه المسجّلين بحسابه؛ الأطباء من حسابات أخرى لا يحذفها
    if (!['admin', 'manager', 'company_manager'].includes(role) && existing.userId !== userId) {
      return res.status(403).json({ error: 'لا يمكنك حذف هذا الطبيب' });
    }

    const deletedDoc = await prisma.doctor.findUnique({ where: { id }, select: { name: true, specialty: true } });
    await prisma.doctor.delete({ where: { id } });
    if (deletedDoc) {
      req._skipActivity = true;
      req._activityDetails = `حذف طبيب: ${deletedDoc.name}${deletedDoc.specialty ? ' (' + deletedDoc.specialty + ')' : ''}`;
    }
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function deleteAll(req, res, next) {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    // Only allow super_admin or admin to bulk-delete all doctors
    const ALLOWED_ROLES = ['admin', 'super_admin'];
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(403).json({ error: 'عملية حذف كل الأطباء غير مسموحة إلا للمدير العام. تواصل مع مدير التطبيق للمساعدة.' });
    }
    const result = await prisma.doctor.deleteMany({ where: { userId } });
    res.json({ deleted: result.count });
  } catch (e) { next(e); }
}

// ── Import doctors from Excel ────────────────────────────────
// Auto-detects column names by fuzzy matching Arabic/English keywords.
// Returns detected columns so frontend can show them.
export async function importExcel(req, res, next) {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرسال ملف' });

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    fs.unlink(req.file.path, () => {});

    if (rows.length === 0) return res.status(400).json({ error: 'الملف فارغ' });

    // ── Auto-detect column mapping ───────────────────────────
    const allCols = Object.keys(rows[0]);
    const detectedCols = allCols; // return to frontend for debugging

    // keywords per field — order matters (more specific first)
    const COL_KEYWORDS = {
      name:     ['doctor name','اسم الطبيب','اسم الدكتور','اسم د','الاسم','name','doctor'],
      specialty:['speciality','specialty','التخصص','تخصص','spec','speciali'],
      area:     ['area (zone)','area zone','المنطقة','منطقه','منطقة','area','region','zone'],
      pharmacy: ['الصيدلية','صيدليه','صيدلية','pharmacy','clinic','عياده','عيادة'],
      item:     ['target drug','target item','الايتم المستهدف','الدواء المستهدف','الايتم','الايتيم',
                 'الدواء','medicine','drug','item','product','المنتج','brand','الحبه','الكبسوله'],
      notes:    ['ملاحظات','ملاحظة','notes','note','تعليق','comment'],
    };

    const findCol = (keywords) => {
      for (const kw of keywords) {
        const col = allCols.find(c =>
          c.trim().toLowerCase() === kw.toLowerCase() ||
          c.trim().toLowerCase().includes(kw.toLowerCase()) ||
          kw.toLowerCase().includes(c.trim().toLowerCase())
        );
        if (col) return col;
      }
      return null;
    };

    const colMap = {
      name:     findCol(COL_KEYWORDS.name),
      specialty:findCol(COL_KEYWORDS.specialty),
      area:     findCol(COL_KEYWORDS.area),
      pharmacy: findCol(COL_KEYWORDS.pharmacy),
      item:     findCol(COL_KEYWORDS.item),
      notes:    findCol(COL_KEYWORDS.notes),
    };

    // Fallback: assign any undetected column that hasn't been claimed to item or notes
    const usedCols = new Set(Object.values(colMap).filter(Boolean));
    const unusedCols = allCols.filter(c => !usedCols.has(c));
    if (!colMap.item && unusedCols.length > 0) {
      // pick the last unused column (most likely to be item/drug in typical survey files)
      colMap.item = unusedCols[unusedCols.length - 1];
    }
    if (!colMap.notes && unusedCols.length > 1) {
      colMap.notes = unusedCols.find(c => c !== colMap.item) ?? null;
    }

    // If name column not found, return error with detected columns for user
    if (!colMap.name) {
      return res.status(422).json({
        error: 'تعذّر إيجاد عمود اسم الطبيب في الملف',
        detectedCols,
        colMap,
        hint: 'يرجى التأكد أن الملف يحتوي على عمود باسم "اسم الطبيب" أو "الاسم"',
      });
    }

    // Pre-load areas and items for matching
    const [allAreas, allItems] = await Promise.all([
      prisma.area.findMany({ where: { userId }, select: { id: true, name: true } }),
      prisma.item.findMany({ where: { userId }, select: { id: true, name: true } }),
    ]);

    const findId = (list, val) => {
      if (!val || !String(val).trim()) return null;
      const v = String(val).trim().toLowerCase();
      // exact match first
      let found = list.find(x => x.name.toLowerCase() === v);
      if (!found) found = list.find(x => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()));
      return found?.id ?? null;
    };

    const getVal = (row, col) => col ? String(row[col] ?? '').trim() : '';

    let imported = 0;
    let skipped  = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const name = getVal(row, colMap.name);
      if (!name) { skipped++; continue; }

      const specialty    = getVal(row, colMap.specialty)    || null;
      const pharmacyName = getVal(row, colMap.pharmacy)     || null;
      const notes        = getVal(row, colMap.notes)        || null;
      const areaVal      = getVal(row, colMap.area);
      const itemVal      = getVal(row, colMap.item);

      const areaId = findId(allAreas, areaVal);

      // Find item by fuzzy match; if not found but value exists → create it
      let targetItemId = findId(allItems, itemVal);
      if (!targetItemId && itemVal) {
        try {
          const newItem = await prisma.item.upsert({
            where: { name_userId: { name: itemVal, userId } },
            update: {},
            create: { name: itemVal, userId },
            select: { id: true },
          });
          targetItemId = newItem.id;
          // Add to local cache so later rows reuse the same item
          allItems.push({ id: newItem.id, name: itemVal });
        } catch (_) { /* leave null if upsert fails */ }
      }

      try {
        const existing = await prisma.doctor.findFirst({ where: { name, userId } });
        if (existing) {
          await prisma.doctor.update({
            where: { id: existing.id },
            data: { specialty, pharmacyName, notes, areaId, targetItemId },
          });
        } else {
          await prisma.doctor.create({
            data: { name, specialty, pharmacyName, notes, areaId, targetItemId, userId },
          });
        }
        imported++;
      } catch (e) {
        errors.push({ row: i + 2, name, error: e.message });
      }
    }

    res.json({ imported, skipped, errors, total: rows.length, colMap, detectedCols });
  } catch (e) { next(e); }
}

// ── GET /specialties?q= — autocomplete distinct specialty values ─
export async function specialtySuggestions(req, res, next) {
  try {
    const userId = req.user.id;
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const docs = await prisma.doctor.findMany({
      where: { userId, specialty: { not: null } },
      select: { specialty: true },
      distinct: ['specialty'],
      orderBy: { name: 'asc' },
      take: 100,
    });
    let names = docs.map(d => d.specialty).filter(Boolean);
    if (q) names = names.filter(n => n.toLowerCase().includes(q));
    names.sort((a, b) => {
      const as = a.toLowerCase().startsWith(q), bs = b.toLowerCase().startsWith(q);
      if (as && !bs) return -1;
      if (!as && bs) return 1;
      return a.localeCompare(b);
    });
    res.json(names.slice(0, 10));
  } catch (e) { next(e); }
}

// ── GET /pharmacy-names?q= — autocomplete pharmacy names from doctors ─
// ─── Get subordinate reps of the current manager ─────────────────────────────
export async function getManagerSubReps(req, res, next) {
  try {
    const managerId = req.user.id;
    const subs = await prisma.userManagerAssignment.findMany({
      where: { managerId },
      include: {
        user: {
          select: { id: true, displayName: true, username: true, linkedRepId: true },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });
    const reps = subs.map(s => ({
      userId:      s.user.id,
      name:        s.user.displayName || s.user.username,
      linkedRepId: s.user.linkedRepId,
    }));
    res.json({ reps });
  } catch (e) { next(e); }
}

export async function pharmacyNameSuggestions(req, res, next) {
  try {
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const docs = await prisma.doctor.findMany({
      where: { userId: ownerUserId, pharmacyName: { not: null } },
      select: { pharmacyName: true },
      distinct: ['pharmacyName'],
      orderBy: { name: 'asc' },
      take: 100,
    });
    let names = docs.map(d => d.pharmacyName).filter(Boolean);
    if (q) names = names.filter(n => n.toLowerCase().includes(q));
    names.sort((a, b) => {
      const as = a.toLowerCase().startsWith(q), bs = b.toLowerCase().startsWith(q);
      if (as && !bs) return -1;
      if (!as && bs) return 1;
      return a.localeCompare(b);
    });
    res.json(names.slice(0, 10));
  } catch (e) { next(e); }
}

// ─── Wishlist (قائمة الطلبات) ──────────────────────────────

export async function getWishlist(req, res, next) {
  try {
    const userId = req.user.id;
    const items = await prisma.doctorWishlist.findMany({
      where: { userId },
      include: {
        doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(items.map(w => ({
      doctorId:    w.doctorId,
      doctorName:  w.doctor.name,
      specialty:   w.specialty ?? w.doctor.specialty,
      pharmacyName:w.pharmacyName ?? w.doctor.pharmacyName,
      areaName:    w.areaName ?? w.doctor.area?.name,
      itemName:    w.itemName,
      createdAt:   w.createdAt,
    })));
  } catch (e) { next(e); }
}

// GET /api/doctors/wishlist/teams — returns all reps (in same office or sub-assigned) who have wishlists
export async function getTeamWishlists(req, res, next) {
  try {
    const managerId = req.user.id;
    const role      = req.user.role;

    // Only use direct UserManagerAssignment — no fallback to all office users
    const assignments = await prisma.userManagerAssignment.findMany({
      where: { managerId },
      select: { userId: true },
    });
    let candidateIds = assignments.map(a => a.userId);

    // For admin with no assignments: show all users who have wishlists
    if (candidateIds.length === 0 && role === 'admin') {
      const allWithWish = await prisma.doctorWishlist.findMany({
        where: { userId: { not: managerId } },
        select: { userId: true },
        distinct: ['userId'],
      });
      candidateIds = allWithWish.map(w => w.userId);
    }

    if (candidateIds.length === 0) return res.json({ teams: [] });

    // Fetch wishlists grouped by userId
    const allWishes = await prisma.doctorWishlist.findMany({
      where: { userId: { in: candidateIds } },
      include: {
        doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { id: true, name: true } } } },
        user:   { select: { id: true, displayName: true, username: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by userId
    const byUser = new Map();
    for (const w of allWishes) {
      if (!byUser.has(w.userId)) {
        byUser.set(w.userId, { rep: { id: w.user.id, name: w.user.displayName || w.user.username }, wishlist: [] });
      }
      byUser.get(w.userId).wishlist.push({
        doctorId:    w.doctorId,
        doctorName:  w.doctor.name,
        specialty:   w.specialty ?? w.doctor.specialty,
        pharmacyName:w.pharmacyName ?? w.doctor.pharmacyName,
        areaName:    w.areaName ?? w.doctor.area?.name,
        itemName:    w.itemName,
        createdAt:   w.createdAt,
      });
    }

    // Also add users who are candidates but have empty wishlists (they show as 0 count)
    const usersWithData = new Set([...byUser.keys()]);
    const emptyUsers = candidateIds.filter(id => !usersWithData.has(id));
    if (emptyUsers.length > 0) {
      const emptyUserRecords = await prisma.user.findMany({
        where: { id: { in: emptyUsers } },
        select: { id: true, displayName: true, username: true },
      });
      for (const u of emptyUserRecords) {
        byUser.set(u.id, { rep: { id: u.id, name: u.displayName || u.username }, wishlist: [] });
      }
    }

    res.json({ teams: [...byUser.values()] });
  } catch (e) { next(e); }
}

export async function getRepWishlist(req, res, next) {
  try {
    const managerId = req.user.id;
    const role      = req.user.role;
    const repUserId = parseInt(req.params.repUserId);
    if (isNaN(repUserId)) return res.status(400).json({ error: 'repUserId غير صالح' });

    const ALLOWED = ['admin', 'manager', 'supervisor', 'team_leader', 'commercial_team_leader',
                     'company_manager', 'office_manager'];
    if (!ALLOWED.includes(role)) {
      const assignment = await prisma.userManagerAssignment.findFirst({
        where: { managerId, userId: repUserId },
      });
      if (!assignment) return res.status(403).json({ error: 'غير مصرح' });
    }

    const items = await prisma.doctorWishlist.findMany({
      where: { userId: repUserId },
      include: {
        doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true, area: { select: { id: true, name: true } } } },
        user:   { select: { id: true, displayName: true, username: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const repUser = items[0]?.user ?? await prisma.user.findUnique({
      where: { id: repUserId },
      select: { id: true, displayName: true, username: true },
    });

    res.json({
      rep: repUser ? { id: repUser.id, name: repUser.displayName || repUser.username } : { id: repUserId, name: '—' },
      wishlist: items.map(w => ({
        doctorId:    w.doctorId,
        doctorName:  w.doctor.name,
        specialty:   w.specialty ?? w.doctor.specialty,
        pharmacyName:w.pharmacyName ?? w.doctor.pharmacyName,
        areaName:    w.areaName ?? w.doctor.area?.name,
        itemName:    w.itemName,
        createdAt:   w.createdAt,
      })),
    });
  } catch (e) { next(e); }
}

export async function upsertWishlist(req, res, next) {
  try {
    const userId = req.user.id;
    const { doctorId, itemName, specialty, pharmacyName, areaName } = req.body;
    if (!doctorId) return res.status(400).json({ error: 'doctorId مطلوب' });

    const docId = parseInt(doctorId);
    // Build update object — only include fields that were explicitly sent
    const updateData = { updatedAt: new Date() };
    if (itemName    !== undefined) updateData.itemName    = itemName    ?? null;
    if (specialty   !== undefined) updateData.specialty   = specialty   ?? null;
    if (pharmacyName !== undefined) updateData.pharmacyName = pharmacyName ?? null;
    if (areaName    !== undefined) updateData.areaName    = areaName    ?? null;

    const entry = await prisma.doctorWishlist.upsert({
      where:  { userId_doctorId: { userId, doctorId: docId } },
      create: { userId, doctorId: docId, itemName: itemName ?? null, specialty: specialty ?? null, pharmacyName: pharmacyName ?? null, areaName: areaName ?? null },
      update: updateData,
    });
    res.json({ ok: true, id: entry.id });
  } catch (e) {
    console.error('[upsertWishlist] FAILED userId=%s doctorId=%s err=%s', req.user?.id, req.body?.doctorId, e.message);
    next(e);
  }
}

// GET /api/doctors/wishlist/debug — diagnostic count
export async function debugWishlist(req, res, next) {
  try {
    const total = await prisma.doctorWishlist.count();
    const mine  = await prisma.doctorWishlist.count({ where: { userId: req.user.id } });
    res.json({ total, mine, userId: req.user.id });
  } catch (e) {
    console.error('[debugWishlist]', e.message);
    res.json({ error: e.message });
  }
}

export async function removeWishlist(req, res, next) {
  try {
    const userId   = req.user.id;
    const doctorId = parseInt(req.params.doctorId);
    if (isNaN(doctorId)) return res.status(400).json({ error: 'doctorId غير صالح' });
    await prisma.doctorWishlist.deleteMany({ where: { userId, doctorId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
}
