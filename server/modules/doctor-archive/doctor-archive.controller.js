import prisma from '../../lib/prisma.js';

const normKey = s => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ًٌٍَُِّْ]/g, '');

const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep']);

// Visible surveys for this user (same logic as master-survey module)
function visibleWhere(user) {
  return {
    isActive: true,
    hiddenUsers:   { none: { userId: user.id } },
    hiddenOffices: user.officeId ? { none: { officeId: user.officeId } } : undefined,
  };
}

// Get area names assigned to this user
async function getUserAreaNames(userId) {
  const rows = await prisma.userAreaAssignment.findMany({
    where: { userId },
    include: { area: { select: { name: true } } },
  });
  return rows.map(r => r.area.name.trim());
}

// ── GET /api/doctor-archive ──────────────────────────────────
// Returns archive entries for current user with survey doctor data,
// grouped by area.
// Managers can pass ?repUserId=<id> to view ALL survey doctors in the rep's
// assigned areas (with archive status overlay), like the visits analysis page.
export async function getArchive(req, res, next) {
  try {
    const requestingUser = req.user;
    const isManager = !FIELD_ROLES.has(requestingUser.role);

    // ── Manager viewing a specific rep ──────────────────────────────────────
    if (isManager && req.query.repUserId) {
      const repId = parseInt(req.query.repUserId, 10);
      if (isNaN(repId)) return res.status(400).json({ success: false, error: 'Invalid repUserId' });

      // Get rep's assigned area names (from UserAreaAssignment)
      const areaRows = await prisma.userAreaAssignment.findMany({
        where: { userId: repId },
        include: { area: { select: { name: true } } },
      });
      // Also try scientificRepArea via linkedRepId
      const repUser = await prisma.user.findUnique({ where: { id: repId }, select: { linkedRepId: true } });
      const linkedRepId = repUser?.linkedRepId ?? null;
      let saAreaIds = [];
      if (linkedRepId) {
        const saRows = await prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } });
        const extraAreas = await prisma.area.findMany({ where: { id: { in: saRows.map(r => r.areaId) } }, select: { name: true } });
        saAreaIds = extraAreas.map(a => a.name.trim());
      }
      const repAreaNames = [...new Set([...areaRows.map(r => r.area.name.trim()), ...saAreaIds])];
      const normAreaNames = repAreaNames.map(normKey);

      // Get active surveys
      const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
      const surveyIds = surveys.map(s => s.id);

      // Get all survey doctors in rep's areas (MasterSurveyDoctor — same source archive entries use)
      let surveyDoctors = [];
      if (surveyIds.length > 0) {
        const allDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: { in: surveyIds } },
          select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true, className: true },
          orderBy: { name: 'asc' },
        });
        surveyDoctors = normAreaNames.length > 0
          ? allDocs.filter(d => d.areaName?.trim() && normAreaNames.includes(normKey(d.areaName)))
          : allDocs;
      }

      // Get rep's archive entries keyed by masterSurveyDoctorId
      const entries = await prisma.doctorArchiveEntry.findMany({
        where: { userId: repId },
        select: { id: true, masterSurveyDoctorId: true, isVisited: true, isWriting: true, visitItems: true, writingItems: true, notes: true },
      });
      const entryMap = new Map(entries.map(e => [e.masterSurveyDoctorId, e]));

      // Group by areaName
      const areaMap = new Map();
      for (const doc of surveyDoctors) {
        const areaKey = doc.areaName?.trim() || 'بدون منطقة';
        if (!areaMap.has(areaKey)) areaMap.set(areaKey, { name: areaKey, doctors: [] });
        const entry = entryMap.get(doc.id);
        areaMap.get(areaKey).doctors.push({
          entryId:        entry?.id ?? null,
          surveyDoctorId: doc.id,
          doctorId:       null,
          name:           doc.name,
          specialty:      doc.specialty ?? null,
          areaName:       doc.areaName ?? null,
          pharmacyName:   doc.pharmacyName ?? null,
          className:      doc.className ?? null,
          isVisited:      entry?.isVisited ?? false,
          isWriting:      entry?.isWriting ?? false,
          visitItems:     entry?.visitItems  ? JSON.parse(entry.visitItems)  : [],
          writingItems:   entry?.writingItems ? JSON.parse(entry.writingItems) : [],
          notes:          entry?.notes ?? null,
        });
      }

      const areas = [...areaMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
      const totalVisited = entries.filter(e => e.isVisited).length;
      const totalWriting = entries.filter(e => e.isWriting).length;

      return res.json({ success: true, areas, total: surveyDoctors.length, totalVisited, totalWriting });
    }

    // ── Regular user (or manager viewing own archive) ────────────────────────
    const userId = requestingUser.id;
    const entries = await prisma.doctorArchiveEntry.findMany({
      where: { userId },
      include: {
        masterSurveyDoctor: {
          select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true, className: true, zoneName: true, phone: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by areaName
    const areaMap = new Map(); // areaName → { name, doctors[] }
    for (const e of entries) {
      const doc = e.masterSurveyDoctor;
      const areaKey = doc?.areaName?.trim() || 'بدون منطقة';
      if (!areaMap.has(areaKey)) areaMap.set(areaKey, { name: areaKey, doctors: [] });
      areaMap.get(areaKey).doctors.push({
        entryId:             e.id,
        surveyDoctorId:      e.masterSurveyDoctorId,
        name:                doc?.name ?? '—',
        specialty:           doc?.specialty ?? null,
        areaName:            doc?.areaName ?? null,
        pharmacyName:        doc?.pharmacyName ?? null,
        className:           doc?.className ?? null,
        isVisited:           e.isVisited,
        isWriting:           e.isWriting,
        visitItems:          e.visitItems  ? JSON.parse(e.visitItems)  : [],
        writingItems:        e.writingItems ? JSON.parse(e.writingItems) : [],
        notes:               e.notes ?? null,
      });
    }

    // Sort areas alphabetically
    const areas = [...areaMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    const totalVisited = entries.filter(e => e.isVisited).length;
    const totalWriting = entries.filter(e => e.isWriting).length;

    res.json({ success: true, areas, total: entries.length, totalVisited, totalWriting });
  } catch (e) { next(e); }
}

// ── GET /api/doctor-archive/survey-doctors ───────────────────
// Returns survey doctors NOT yet in this user's archive.
// Respects area assignment and survey visibility.
export async function getSurveyDoctors(req, res, next) {
  try {
    const userId = req.user.id;
    const { q, areaFilter } = req.query;

    // Already archived doctor ids
    const archived = await prisma.doctorArchiveEntry.findMany({
      where: { userId },
      select: { masterSurveyDoctorId: true },
    });
    const archivedIds = new Set(archived.map(e => e.masterSurveyDoctorId));

    // Visible surveys
    const surveys = await prisma.masterSurvey.findMany({
      where: visibleWhere(req.user),
      select: { id: true },
    });
    const surveyIds = surveys.map(s => s.id);
    if (surveyIds.length === 0) return res.json({ success: true, doctors: [] });

    // Area restriction for field roles
    let areaNames = null;
    if (FIELD_ROLES.has(req.user.role)) {
      const assigned = await getUserAreaNames(userId);
      if (assigned.length > 0) areaNames = new Set(assigned.map(normKey));
    }

    // Fetch all doctors from visible surveys
    const doctors = await prisma.masterSurveyDoctor.findMany({
      where: { surveyId: { in: surveyIds } },
      select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true, className: true },
      orderBy: { name: 'asc' },
    });

    let result = doctors.filter(d => !archivedIds.has(d.id));

    // Apply area restriction
    if (areaNames) {
      result = result.filter(d => !d.areaName?.trim() || areaNames.has(normKey(d.areaName)));
    }

    // Apply search filter
    if (q?.trim()) {
      const qn = normKey(q.trim());
      result = result.filter(d =>
        normKey(d.name).includes(qn) ||
        normKey(d.specialty ?? '').includes(qn) ||
        normKey(d.areaName ?? '').includes(qn) ||
        normKey(d.pharmacyName ?? '').includes(qn)
      );
    }

    // Apply area filter
    if (areaFilter && areaFilter !== 'all') {
      const af = normKey(areaFilter);
      result = result.filter(d => normKey(d.areaName ?? '') === af);
    }

    res.json({ success: true, doctors: result });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/:surveyDoctorId ─────────────────
// Add a survey doctor to the current user's archive.
// Managers can pass ?forUserId=<id> to add to a specific rep's archive.
export async function addToArchive(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }
    const surveyDoctorId   = parseInt(req.params.surveyDoctorId);
    if (isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'معرّف غير صحيح' });

    // Verify doctor exists
    const doc = await prisma.masterSurveyDoctor.findUnique({ where: { id: surveyDoctorId } });
    if (!doc) return res.status(404).json({ success: false, error: 'الطبيب غير موجود في السيرفي' });

    const entry = await prisma.doctorArchiveEntry.upsert({
      where:  { userId_masterSurveyDoctorId: { userId, masterSurveyDoctorId: surveyDoctorId } },
      create: { userId, masterSurveyDoctorId: surveyDoctorId },
      update: {}, // do nothing if already exists
    });

    res.json({ success: true, entry });
  } catch (e) { next(e); }
}

// ── PATCH /api/doctor-archive/:surveyDoctorId ────────────────
// Update isVisited, isWriting, writingItems, notes for an archive entry.
// Auto-creates the entry if it doesn't exist (upsert).
// Managers can pass ?forUserId=<id> to update a specific rep's entry.
// :surveyDoctorId can be 0 — in that case pass ?doctorId=<id> in query to
// resolve the masterSurveyDoctorId from the Doctor record.
export async function updateArchiveEntry(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }

    let surveyDoctorId = parseInt(req.params.surveyDoctorId);

    // If no surveyDoctorId (0 or NaN), try resolving via doctorId query param
    if (!surveyDoctorId && req.query.doctorId) {
      const dId = parseInt(req.query.doctorId, 10);
      if (!isNaN(dId)) {
        const doc = await prisma.doctor.findUnique({ where: { id: dId }, select: { masterSurveyDoctorId: true } });
        if (doc?.masterSurveyDoctorId) surveyDoctorId = doc.masterSurveyDoctorId;
      }
    }

    if (!surveyDoctorId || isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'هذا الطبيب غير مرتبط بسجل سيرفي، لا يمكن حفظ الزيارة' });

    const data = {};
    if (req.body.isVisited   !== undefined) data.isVisited   = Boolean(req.body.isVisited);
    if (req.body.isWriting   !== undefined) data.isWriting   = Boolean(req.body.isWriting);
    if (req.body.visitItems !== undefined) {
      const items = Array.isArray(req.body.visitItems) ? req.body.visitItems : [];
      data.visitItems = JSON.stringify(items.map(String).filter(Boolean));
    }
    if (req.body.writingItems !== undefined) {
      const items = Array.isArray(req.body.writingItems) ? req.body.writingItems : [];
      data.writingItems = JSON.stringify(items.map(String).filter(Boolean));
    }
    if (req.body.notes !== undefined) data.notes = req.body.notes || null;

    // Upsert: create entry if it doesn't exist yet, then apply data
    const updated = await prisma.doctorArchiveEntry.upsert({
      where:  { userId_masterSurveyDoctorId: { userId, masterSurveyDoctorId: surveyDoctorId } },
      create: { userId, masterSurveyDoctorId: surveyDoctorId, ...data },
      update: data,
    });

    res.json({ success: true, entry: updated });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/custom-doctor ───────────────────
// Create a brand-new doctor (not from survey) and add to archive.
export async function addCustomDoctor(req, res, next) {
  try {
    const userId = req.user.id;
    const { name, specialty, areaName, pharmacyName, className } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });

    // Find first visible survey for this user to host the doctor
    const survey = await prisma.masterSurvey.findFirst({
      where: {
        isActive: true,
        hiddenUsers:   { none: { userId } },
        ...(req.user.officeId ? { hiddenOffices: { none: { officeId: req.user.officeId } } } : {}),
      },
      orderBy: { id: 'asc' },
    });
    if (!survey) return res.status(400).json({ success: false, error: 'لا توجد قائمة سيرفي متاحة لإضافة الطبيب' });

    // Create the doctor inside the survey
    const doctor = await prisma.masterSurveyDoctor.create({
      data: {
        surveyId:     survey.id,
        name:         name.trim(),
        specialty:    specialty?.trim()    || null,
        areaName:     areaName?.trim()     || null,
        pharmacyName: pharmacyName?.trim() || null,
        className:    className?.trim()    || null,
        lastEditedById: userId,
        lastEditedAt:   new Date(),
      },
    });

    // Archive the new doctor for this user
    const entry = await prisma.doctorArchiveEntry.create({
      data: { userId, masterSurveyDoctorId: doctor.id },
    });

    res.json({ success: true, entry, doctor });
  } catch (e) { next(e); }
}

// ── DELETE /api/doctor-archive/:surveyDoctorId ───────────────
// Remove a doctor from the current user's archive.
// Managers can pass ?forUserId=<id> to remove from a specific rep's archive.
export async function removeFromArchive(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }
    const surveyDoctorId = parseInt(req.params.surveyDoctorId);
    if (isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'معرّف غير صحيح' });

    await prisma.doctorArchiveEntry.deleteMany({
      where: { userId, masterSurveyDoctorId: surveyDoctorId },
    });

    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/import-from-visits ──────────────
// Bulk-import all survey doctors visible in the rep's "تحليل الزيارات"
// into the archive. Managers can pass ?repUserId=<id> to import for a rep.
// Already-archived doctors are skipped (upsert-like, idempotent).
export async function importFromVisits(req, res, next) {
  try {
    const requestingUser = req.user;
    const isManager = !FIELD_ROLES.has(requestingUser.role);

    // Decide target user (the rep whose archive we populate)
    let targetUserId = requestingUser.id;
    if (isManager && req.body.repUserId) {
      const rid = parseInt(req.body.repUserId, 10);
      if (!isNaN(rid)) targetUserId = rid;
    }

    // Resolve area names for targetUser (same logic as visitsByArea)
    const normArea = s => String(s || '').trim()
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ')
      .toLowerCase().trim();

    const userRow = await prisma.user.findUnique({ where: { id: targetUserId }, select: { linkedRepId: true } });
    const linkedRepId = userRow?.linkedRepId ?? null;

    const [uaRows, saRows] = await Promise.all([
      prisma.userAreaAssignment.findMany({ where: { userId: targetUserId }, select: { areaId: true } }),
      linkedRepId
        ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
        : Promise.resolve([]),
    ]);
    const repAreaIds = [...new Set([...uaRows.map(r => r.areaId), ...saRows.map(r => r.areaId)])];

    let surveyDoctorIds = [];

    if (repAreaIds.length > 0) {
      // Get area names for normalization
      const areaRecords = await prisma.area.findMany({
        where: { id: { in: repAreaIds } },
        select: { name: true },
      });
      const normAreaNames = new Set(areaRecords.map(a => normArea(a.name)));

      // Get active survey doctors in those areas
      const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
      const surveyIds = surveys.map(s => s.id);
      if (surveyIds.length > 0) {
        const allDocs = await prisma.masterSurveyDoctor.findMany({
          where: { surveyId: { in: surveyIds } },
          select: { id: true, areaName: true },
        });
        surveyDoctorIds = allDocs
          .filter(d => d.areaName?.trim() && normAreaNames.has(normArea(d.areaName)))
          .map(d => d.id);
      }
    }

    if (surveyDoctorIds.length === 0) {
      return res.json({ success: true, imported: 0, alreadyExists: 0, total: 0 });
    }

    // Find already-archived ones to skip
    const existing = await prisma.doctorArchiveEntry.findMany({
      where: { userId: targetUserId, masterSurveyDoctorId: { in: surveyDoctorIds } },
      select: { masterSurveyDoctorId: true },
    });
    const existingSet = new Set(existing.map(e => e.masterSurveyDoctorId));
    const toCreate = surveyDoctorIds.filter(id => !existingSet.has(id));

    if (toCreate.length > 0) {
      await prisma.doctorArchiveEntry.createMany({
        data: toCreate.map(id => ({ userId: targetUserId, masterSurveyDoctorId: id })),
        skipDuplicates: true,
      });
    }

    res.json({
      success: true,
      imported: toCreate.length,
      alreadyExists: existingSet.size,
      total: surveyDoctorIds.length,
    });
  } catch (e) { next(e); }
}
