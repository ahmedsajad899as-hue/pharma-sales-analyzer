import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';
import fs from 'fs';

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

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let doctors;

    if (isFieldRep) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      const linkedRepId = userRow?.linkedRepId;

      // جلب المناطق من كلا المصدرين: UserAreaAssignment (الأدمن) + ScientificRepArea (مدير المناطق)
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
      console.log('[visitsByArea] userId:', userId, 'linkedRepId:', linkedRepId, 'repAreaIds:', repAreaIds);

      // جلب الزيارات المفلترة بالشهر — فقط للأطباء في مناطق المندوب
      const allVisits = await prisma.doctorVisit.findMany({
        where: {
          scientificRepId: linkedRepId ?? -1,
          ...(dateFilter ? { visitDate: dateFilter } : {}),
        },
        select: {
          id: true, visitDate: true, feedback: true, notes: true,
          doctorId: true,
          item: { select: { id: true, name: true } },
        },
        orderBy: { visitDate: 'desc' },
      });

      // تجميع الزيارات حسب doctorId
      const visitsByDoc = new Map();
      for (const v of allVisits) {
        if (!visitsByDoc.has(v.doctorId)) visitsByDoc.set(v.doctorId, []);
        visitsByDoc.get(v.doctorId).push(v);
      }

      // جلب أطباء المناطق المُعيَّنة للمندوب فقط — بدون OR إضافية
      const doctorWhere = repAreaIds.length > 0
        ? { areaId: { in: repAreaIds } }          // المناطق المحددة فقط
        : { id: { in: [...new Set(allVisits.map(v => v.doctorId))] } }; // fallback: من زارهم

      const allDoctors = await prisma.doctor.findMany({
        where: doctorWhere,
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      });

      // دمج: الزيارات المفلترة للشهر المحدد فقط
      doctors = allDoctors.map(d => ({ ...d, visits: visitsByDoc.get(d.id) ?? [] }));
      console.log('[visitsByArea] total doctors:', allDoctors.length);

    } else {
      // للمدير: جلب أطباءه جميعاً دائماً، وفلتر الزيارات فقط حسب الشهر
      doctors = await prisma.doctor.findMany({
        where: { userId },
        include: {
          area:       { select: { id: true, name: true } },
          targetItem: { select: { id: true, name: true } },
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
    }

    const areaMap = new Map();
    const noAreaDocs = [];

    // Arabic normalization for name matching (handles ة/ه, أإآ/ا, ى/ي, diacritics, extra spaces)
    const normName = s => String(s || '').trim().toLowerCase()
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ');

    // For null-area doctors: fetch ALL active survey doctors and build a normalized name→area map
    const nullAreaDoctors = doctors.filter(d => !d.area && !d.planEntries?.[0]?.plan?.planAreas?.[0]?.area);
    const surveyAreaByNormName = new Map();
    if (nullAreaDoctors.length > 0) {
      const activeSurvey = await prisma.masterSurvey.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'desc' },
      });
      if (activeSurvey) {
        const allSurveyDoctors = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: activeSurvey.id, areaName: { not: null } },
          select: { name: true, areaName: true },
        });
        // Build normalized-name → areaName map (last writer wins for duplicate names)
        for (const s of allSurveyDoctors) {
          if (s.areaName?.trim()) surveyAreaByNormName.set(normName(s.name), s.areaName.trim());
        }
      }
    }

    for (const d of doctors) {
      const visited   = d.visits.length > 0;
      const isWriting = d.visits.some(v => v.feedback === 'writing');
      // Use Doctor.area, then plan-area, then normalized survey name lookup as final fallback
      const effectiveArea = d.area ?? d.planEntries?.[0]?.plan?.planAreas?.[0]?.area ?? null;
      const surveyArea    = !effectiveArea ? surveyAreaByNormName.get(normName(d.name)) : null;
      const doc = {
        id: d.id, name: d.name, specialty: d.specialty,
        pharmacyName: d.pharmacyName ?? null,
        area: effectiveArea,
        targetItem: d.targetItem, isActive: d.isActive,
        visited, isWriting, visits: d.visits,
      };
      if (effectiveArea) {
        if (!areaMap.has(effectiveArea.id))
          areaMap.set(effectiveArea.id, { id: effectiveArea.id, name: effectiveArea.name, doctors: [] });
        areaMap.get(effectiveArea.id).doctors.push(doc);
      } else if (surveyArea) {
        const mapKey = `survey:${surveyArea}`;
        if (!areaMap.has(mapKey))
          areaMap.set(mapKey, { id: mapKey, name: surveyArea, doctors: [] });
        areaMap.get(mapKey).doctors.push(doc);
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

    const areas = [...areaMap.values()].map(toStats)
      .sort((a, b) => b.visitedCount - a.visitedCount);

    if (noAreaDocs.length > 0)
      areas.push(toStats({ id: null, name: 'بدون منطقة', doctors: noAreaDocs }));

    res.json({ areas });
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

    const FIELD_ROLES = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'];
    const isFieldRep  = FIELD_ROLES.includes(role);

    let linkedRepId = null;
    if (isFieldRep) {
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
      linkedRepId = userRow?.linkedRepId;
    }

    const visitWhere = isFieldRep
      ? { scientificRepId: linkedRepId ?? -1, ...(dateFilter ? { visitDate: dateFilter } : {}) }
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
        // ── عند البحث بالاسم: استخدام userId لمدير الشركة بدلاً من فلتر المناطق ──
        let managerUserId = userId; // fallback
        if (linkedRepId) {
          const repRecord = await prisma.scientificRepresentative.findUnique({
            where: { id: linkedRepId },
            select: { userId: true },
          });
          if (repRecord?.userId) managerUserId = repRecord.userId;
        }
        where = { userId: managerUserId, name: { contains: q.trim() } };

        // ── Apply area filter for field reps (restrict to assigned areas) ──
        if (filterByArea) {
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
          if (repAreaIds.length > 0) {
            // Include assigned areas + null-area doctors (will be post-filtered by survey areaName)
            const areaFilter = { OR: [{ areaId: { in: repAreaIds } }, { areaId: null }] };
            where = { AND: [where, areaFilter] };
            // Store for post-filtering null-area doctors by survey areaName
            var _filterRepAreaIds = repAreaIds;
          }
        }

        if (areaId)                 where.areaId   = parseInt(areaId);
        if (isActive !== undefined) where.isActive = (isActive === 'true');
      } else {
        // ── عند التصفح (بدون q): استخدام فلتر المناطق ──
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

        const baseWhere = repAreaIds.length > 0
          ? { areaId: { in: repAreaIds } }
          : { userId }; // fallback إذا لم تُحدَّد مناطق

        const andFilters = [];
        if (areaId)                 andFilters.push({ areaId: parseInt(areaId) });
        if (isActive !== undefined) andFilters.push({ isActive: isActive === 'true' });

        where = andFilters.length > 0
          ? { AND: [baseWhere, ...andFilters] }
          : baseWhere;
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
      if (isFieldRep && userRecord?.linkedRepId) {
        const repRow = await prisma.scientificRepresentative.findUnique({
          where: { id: userRecord.linkedRepId }, select: { userId: true },
        });
        if (repRow?.userId) ownerUserId = repRow.userId;
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
          // Uses Arabic normalization: ة→ه, أإآ→ا, ى→ي so "الحارثية" matches "الحارثيه"
          const normAreaKey = s => String(s ?? '').trim().toLowerCase()
            .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
            .replace(/[ًٌٍَُِّْ]/g, '');
          const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
          const areaNameMap = new Map();
          for (const a of allAreas) {
            const key = normAreaKey(a.name);
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
              ? (areaNameMap.get(normAreaKey(sd.areaName)) || null)
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

    const doctor = await prisma.doctor.create({
      data: {
        name, specialty, pharmacyName, notes,
        areaId:       resolvedAreaId ?? null,
        targetItemId: targetItemId ? parseInt(targetItemId) : null,
        userId,
      },
      include: {
        area:       { select: { id: true, name: true } },
        targetItem: { select: { id: true, name: true } },
      },
    });
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

    await prisma.doctor.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function deleteAll(req, res, next) {
  try {
    const userId = req.user.id;
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
export async function pharmacyNameSuggestions(req, res, next) {
  try {
    const userId = req.user.id;
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const docs = await prisma.doctor.findMany({
      where: { userId, pharmacyName: { not: null } },
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
