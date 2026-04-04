import prisma from '../../lib/prisma.js';

// ── Arabic normalization helper ───────────────────────────────
// Normalizes Arabic text: hamza variants → ا, ة → ه, ى → ي, strip diacritics
const normAreaKey = s => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ًٌٍَُِّْ]/g, '');

// Field roles restricted to assigned areas in the survey (managers see all)
const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep']);

// ── Visibility helper ────────────────────────────────────────
// Returns a Prisma `where` clause that filters surveys visible to this user
function visibleWhere(user) {
  return {
    isActive: true,
    hiddenUsers:   { none: { userId: user.id } },
    hiddenOffices: user.officeId
      ? { none: { officeId: user.officeId } }
      : undefined,
  };
}

// ── Area filter helper ──────────────────────────────────────
// Returns the area names assigned to a user via UserAreaAssignment.
// Returns empty array if no areas assigned (→ no filtering applied).
async function getUserAssignedAreaNames(userId) {
  const assignments = await prisma.userAreaAssignment.findMany({
    where: { userId },
    include: { area: { select: { name: true } } },
  });
  return assignments.map(a => a.area.name.trim());
}

// ── Log helper ───────────────────────────────────────────────
function logEntry(surveyId, entryType, entryId, action, oldData, newData, editedById) {
  return prisma.masterSurveyEditLog.create({
    data: {
      surveyId,
      entryType,
      entryId,
      action,
      oldData:    oldData  ? JSON.stringify(oldData)  : null,
      newData:    newData  ? JSON.stringify(newData)  : null,
      editedById: editedById ?? null,
    },
  });
}

// ── GET /api/master-surveys ──────────────────────────────────
export async function listSurveys(req, res, next) {
  try {
    const surveys = await prisma.masterSurvey.findMany({
      where: visibleWhere(req.user),
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { doctors: true, pharmacies: true } },
      },
    });

    // Area filter only for field roles; managers see full survey
    const isFieldRole   = FIELD_ROLES.has(req.user.role);
    const userAreaNames = isFieldRole ? await getUserAssignedAreaNames(req.user.id) : [];
    if (userAreaNames.length > 0) {
      const normAreaSet = new Set(userAreaNames.map(normAreaKey));
      await Promise.all(surveys.map(async survey => {
        const [allDocs, allPharmas] = await Promise.all([
          prisma.masterSurveyDoctor.findMany({ where: { surveyId: survey.id }, select: { areaName: true } }),
          prisma.masterSurveyPharmacy.findMany({ where: { surveyId: survey.id }, select: { areaName: true } }),
        ]);
        // Include docs with no areaName (they're not area-specific, show to all)
        survey._count.doctors    = allDocs.filter(d => !d.areaName?.trim() || normAreaSet.has(normAreaKey(d.areaName))).length;
        survey._count.pharmacies = allPharmas.filter(p => !p.areaName?.trim() || normAreaSet.has(normAreaKey(p.areaName))).length;
      }));
    }

    res.json({ success: true, data: surveys });
  } catch (e) { next(e); }
}

// ── GET /api/master-surveys/:id ──────────────────────────────
export async function getSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);

    // If repId provided (company_manager viewing for a rep), filter by rep's areas
    let userAreaNames = [];
    if (req.query.repId) {
      // manager viewing as a specific rep: filter by rep's areas
      const repUserId = await getRepLinkedUserId(req.query.repId);
      if (repUserId) userAreaNames = await getUserAssignedAreaNames(repUserId);
    } else if (FIELD_ROLES.has(req.user.role)) {
      // field role: restrict to own assigned areas
      userAreaNames = await getUserAssignedAreaNames(req.user.id);
    }
    // else: manager viewing own survey -> no area filter (sees all doctors)
    const normAreaSet = userAreaNames.length > 0 ? new Set(userAreaNames.map(normAreaKey)) : null;

    const survey = await prisma.masterSurvey.findFirst({
      where: { id, ...visibleWhere(req.user) },
      include: {
        doctors: {
          orderBy: { createdAt: 'asc' },
          include: { lastEditedBy: { select: { id: true, username: true, displayName: true } } },
        },
        pharmacies: {
          orderBy: { createdAt: 'asc' },
          include: { lastEditedBy: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي أو غير مسموح' });

    // Post-filter by assigned areas using normalized Arabic comparison
    // Docs/pharmacies with no areaName are not area-specific → show to all
    if (normAreaSet) {
      survey.doctors    = survey.doctors.filter(d => !d.areaName?.trim() || normAreaSet.has(normAreaKey(d.areaName)));
      survey.pharmacies = survey.pharmacies.filter(p => !p.areaName?.trim() || normAreaSet.has(normAreaKey(p.areaName)));
    }

    res.json({ success: true, data: { ...survey, userAreaNames } });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/doctors ─────────────────────
export async function addDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    await assertVisible(surveyId, req.user, res);
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });
    const doc = await prisma.masterSurveyDoctor.create({
      data: {
        surveyId,
        name: name.trim(), specialty, areaName, pharmacyName, className, zoneName, phone, notes,
        lastEditedById: req.user.id,
        lastEditedAt:   new Date(),
      },
    });
    await logEntry(surveyId, 'doctor', doc.id, 'create', null, doc, req.user.id);
    res.status(201).json({ success: true, data: doc });
  } catch (e) { next(e); }
}

// ── PUT /api/master-surveys/:id/doctors/:docId ───────────────
export async function updateDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    await assertVisible(surveyId, req.user, res);
    const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    const data = { lastEditedById: req.user.id, lastEditedAt: new Date() };
    if (name         !== undefined) data.name         = name.trim();
    if (specialty    !== undefined) data.specialty    = specialty;
    if (areaName     !== undefined) data.areaName     = areaName;
    if (pharmacyName !== undefined) data.pharmacyName = pharmacyName;
    if (className    !== undefined) data.className    = className;
    if (zoneName     !== undefined) data.zoneName     = zoneName;
    if (phone        !== undefined) data.phone        = phone;
    if (notes        !== undefined) data.notes        = notes;
    const updated = await prisma.masterSurveyDoctor.update({ where: { id: docId }, data });
    await logEntry(surveyId, 'doctor', docId, 'update', old, updated, req.user.id);

    // Cascade: propagate changes to all Doctor records imported from this survey doctor
    const cascadeData = {};
    if (data.name         !== undefined) cascadeData.name         = data.name;
    if (data.specialty    !== undefined) cascadeData.specialty    = data.specialty;
    if (data.pharmacyName !== undefined) cascadeData.pharmacyName = data.pharmacyName;
    if (data.notes        !== undefined) cascadeData.notes        = data.notes;
    if (Object.keys(cascadeData).length > 0 || data.areaName !== undefined) {
      if (data.areaName !== undefined) {
        const linkedDoctors = await prisma.doctor.findMany({
          where: { masterSurveyDoctorId: docId },
          select: { id: true, userId: true },
        });
        const userGroups = new Map();
        for (const d of linkedDoctors) {
          const key = d.userId ?? null;
          if (!userGroups.has(key)) userGroups.set(key, []);
          userGroups.get(key).push(d.id);
        }
        for (const [uid, ids] of userGroups) {
          const resolvedAreaId = uid ? await resolveAreaId(data.areaName, uid) : null;
          await prisma.doctor.updateMany({
            where: { id: { in: ids } },
            data: { ...cascadeData, areaId: resolvedAreaId },
          });
        }
      } else {
        await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: docId }, data: cascadeData });
      }
    }

    res.json({ success: true, data: updated });
  } catch (e) { next(e); }
}

// ── Helper: find or create Area by name for a user ──────────
async function resolveAreaId(areaName, userId) {
  if (!areaName?.trim()) return null;
  const nameNorm = areaName.trim().toLowerCase();
  // Find existing area by name for this user (case-insensitive JS comparison)
  const userAreas = await prisma.area.findMany({ where: { userId }, select: { id: true, name: true } });
  const found = userAreas.find(a => a.name.trim().toLowerCase() === nameNorm);
  if (found) return found.id;
  const created = await prisma.area.create({ data: { name: areaName.trim(), userId } });
  return created.id;
}

// ── Helper: get linked userId for a rep ──────────────────────
async function getRepLinkedUserId(repId) {
  const rep = await prisma.scientificRepresentative.findUnique({
    where: { id: parseInt(repId) },
    select: { userId: true },
  });
  return rep?.userId ?? null;
}

// ── POST /api/master-surveys/:id/doctors/import-all ──────────
export async function importAllDoctors(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    await assertVisible(surveyId, req.user, res);

    // If repId provided (company_manager importing for a rep), use rep's userId
    let userId = req.user.id;
    if (req.query.repId) {
      const repUserId = await getRepLinkedUserId(req.query.repId);
      if (repUserId) userId = repUserId;
    }

    // Only import doctors from the user's assigned areas (field roles only)
    // Managers import all survey doctors (no area restriction)
    const userAreaNames = FIELD_ROLES.has(req.user.role) ? await getUserAssignedAreaNames(userId) : [];
    const normAreaSet   = userAreaNames.length > 0 ? new Set(userAreaNames.map(normAreaKey)) : null;

    const allSurveyDoctors = await prisma.masterSurveyDoctor.findMany({ where: { surveyId } });
    const surveyDoctors = normAreaSet
      ? allSurveyDoctors.filter(d => !d.areaName?.trim() || normAreaSet.has(normAreaKey(d.areaName)))
      : allSurveyDoctors;
    const existingNames = new Set(
      (await prisma.doctor.findMany({ where: { userId }, select: { name: true } }))
        .map(d => d.name.toLowerCase().trim())
    );

    const newDoctors = surveyDoctors.filter(d => d.name?.trim() && !existingNames.has(d.name.toLowerCase().trim()));
    if (newDoctors.length === 0)
      return res.json({ success: true, count: 0, message: 'جميع الأطباء موجودون مسبقاً في قائمتك' });

    // Resolve unique area names → area IDs
    const uniqueAreaNames = [...new Set(newDoctors.map(d => d.areaName?.trim()).filter(Boolean))];
    const areaIdMap = new Map();
    for (const an of uniqueAreaNames) {
      const id = await resolveAreaId(an, userId);
      if (id) areaIdMap.set(an.toLowerCase(), id);
    }

    const data = newDoctors.map(d => ({
      name:                d.name.trim(),
      specialty:           d.specialty    ?? null,
      pharmacyName:        d.pharmacyName ?? null,
      notes:               d.notes        ?? null,
      areaId:              d.areaName?.trim() ? (areaIdMap.get(d.areaName.trim().toLowerCase()) ?? null) : null,
      userId,
      masterSurveyDoctorId: d.id,
    }));

    const result = await prisma.doctor.createMany({ data });
    res.json({ success: true, count: result.count, message: `تم استيراد ${result.count} طبيب بنجاح` });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/doctors/:docId/import ───────
export async function importDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    await assertVisible(surveyId, req.user, res);

    // If repId provided (company_manager importing for a rep), use rep's userId
    let targetUserId = req.user.id;
    if (req.query.repId) {
      const repUserId = await getRepLinkedUserId(req.query.repId);
      if (repUserId) targetUserId = repUserId;
    }

    const src = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!src || src.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    // Check duplicate
    const existing = await prisma.doctor.findFirst({
      where: { name: src.name, userId: targetUserId },
    });
    if (existing) {
      // Backfill masterSurveyDoctorId if not linked yet
      if (!existing.masterSurveyDoctorId) {
        await prisma.doctor.update({ where: { id: existing.id }, data: { masterSurveyDoctorId: src.id } });
      }
      return res.json({ success: true, data: existing, message: 'الطبيب موجود مسبقاً في قائمتك' });
    }
    const resolvedAreaId = await resolveAreaId(src.areaName, targetUserId);
    const newDoc = await prisma.doctor.create({
      data: {
        name:                src.name,
        specialty:           src.specialty    ?? null,
        pharmacyName:        src.pharmacyName ?? null,
        notes:               src.notes        ?? null,
        areaId:              resolvedAreaId,
        userId:              targetUserId,
        masterSurveyDoctorId: src.id,
      },
    });
    res.status(201).json({ success: true, data: newDoc, message: 'تمت الإضافة لقائمة أطبائك' });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/pharmacies ──────────────────
export async function addPharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    await assertVisible(surveyId, req.user, res);
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الصيدلية مطلوب' });
    const ph = await prisma.masterSurveyPharmacy.create({
      data: {
        surveyId,
        name: name.trim(), ownerName, pharmacyName, phone, address, areaName, notes,
        lastEditedById: req.user.id,
        lastEditedAt:   new Date(),
      },
    });
    await logEntry(surveyId, 'pharmacy', ph.id, 'create', null, ph, req.user.id);
    res.status(201).json({ success: true, data: ph });
  } catch (e) { next(e); }
}

// ── PUT /api/master-surveys/:id/pharmacies/:pharmaId ─────────
export async function updatePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    await assertVisible(surveyId, req.user, res);
    const old = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    const data = { lastEditedById: req.user.id, lastEditedAt: new Date() };
    if (name         !== undefined) data.name         = name.trim();
    if (ownerName    !== undefined) data.ownerName    = ownerName;
    if (pharmacyName !== undefined) data.pharmacyName = pharmacyName;
    if (phone        !== undefined) data.phone        = phone;
    if (address      !== undefined) data.address      = address;
    if (areaName     !== undefined) data.areaName     = areaName;
    if (notes        !== undefined) data.notes        = notes;
    const updated = await prisma.masterSurveyPharmacy.update({ where: { id: pharmaId }, data });
    await logEntry(surveyId, 'pharmacy', pharmaId, 'update', old, updated, req.user.id);
    res.json({ success: true, data: updated });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/pharmacies/:pharmaId/import ─
export async function importPharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    await assertVisible(surveyId, req.user, res);
    const src = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
    if (!src || src.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });    // Upsert to handle duplicates gracefully
    const existing = await prisma.pharmacy.findFirst({
      where: { name: src.name, userId: req.user.id },
    });
    if (existing) return res.json({ success: true, data: existing, message: 'الصيدلية موجودة مسبقاً في قائمتك' });    const newPh = await prisma.pharmacy.create({
      data: {
        name:      src.name,
        ownerName: src.ownerName ?? null,
        phone:     src.phone    ?? null,
        address:   src.address  ?? null,
        areaName:  src.areaName ?? null,
        notes:     src.notes    ?? null,
        userId:    req.user.id,
      },
    });
    res.status(201).json({ success: true, data: newPh, message: 'تمت الإضافة لقائمة صيدلياتك' });
  } catch (e) { next(e); }
}

// ── Internal: check survey is visible to user ────────────────
async function assertVisible(surveyId, user, res) {
  const survey = await prisma.masterSurvey.findFirst({
    where: { id: surveyId, ...visibleWhere(user) },
    select: { id: true },
  });
  if (!survey) {
    res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي أو غير مسموح' });
    throw new Error('ALREADY_RESPONDED');
  }
}
