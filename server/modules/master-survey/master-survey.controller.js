import prisma from '../../lib/prisma.js';

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

    // If user has assigned areas, replace counts with area-filtered counts
    const userAreaNames = await getUserAssignedAreaNames(req.user.id);
    if (userAreaNames.length > 0) {
      await Promise.all(surveys.map(async survey => {
        const [dc, pc] = await Promise.all([
          prisma.masterSurveyDoctor.count({
            where: { surveyId: survey.id, areaName: { in: userAreaNames } },
          }),
          prisma.masterSurveyPharmacy.count({
            where: { surveyId: survey.id, areaName: { in: userAreaNames } },
          }),
        ]);
        survey._count.doctors    = dc;
        survey._count.pharmacies = pc;
      }));
    }

    res.json({ success: true, data: surveys });
  } catch (e) { next(e); }
}

// ── GET /api/master-surveys/:id ──────────────────────────────
export async function getSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);

    // Build area filter: only return doctors/pharmacies in the user's assigned areas
    const userAreaNames = await getUserAssignedAreaNames(req.user.id);
    const areaFilter = userAreaNames.length > 0
      ? { areaName: { in: userAreaNames } }
      : undefined; // no filter → user has no area restrictions (admin/manager)

    const survey = await prisma.masterSurvey.findFirst({
      where: { id, ...visibleWhere(req.user) },
      include: {
        doctors: {
          where: areaFilter,
          orderBy: { createdAt: 'asc' },
          include: { lastEditedBy: { select: { id: true, username: true, displayName: true } } },
        },
        pharmacies: {
          where: areaFilter,
          orderBy: { createdAt: 'asc' },
          include: { lastEditedBy: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي أو غير مسموح' });
    res.json({ success: true, data: survey });
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
    res.json({ success: true, data: updated });
  } catch (e) { next(e); }
}

// ── Helper: find or create Area by name for a user ──────────
async function resolveAreaId(areaName, userId) {
  if (!areaName?.trim()) return null;
  const found = await prisma.area.findFirst({
    where: { name: { equals: areaName.trim(), mode: 'insensitive' } },
    select: { id: true },
  });
  if (found) return found.id;
  const created = await prisma.area.create({ data: { name: areaName.trim(), userId } });
  return created.id;
}

// ── POST /api/master-surveys/:id/doctors/import-all ──────────
export async function importAllDoctors(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    await assertVisible(surveyId, req.user, res);
    const userId = req.user.id;

    // Only import doctors from the user's assigned areas
    const userAreaNames = await getUserAssignedAreaNames(userId);
    const areaWhere = userAreaNames.length > 0
      ? { surveyId, areaName: { in: userAreaNames } }
      : { surveyId };

    const surveyDoctors = await prisma.masterSurveyDoctor.findMany({ where: areaWhere });
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
      name:         d.name.trim(),
      specialty:    d.specialty    ?? null,
      pharmacyName: d.pharmacyName ?? null,
      notes:        d.notes        ?? null,
      areaId:       d.areaName?.trim() ? (areaIdMap.get(d.areaName.trim().toLowerCase()) ?? null) : null,
      userId,
    }));

    const result = await prisma.doctor.createMany({ data, skipDuplicates: true });
    res.json({ success: true, count: result.count, message: `تم استيراد ${result.count} طبيب بنجاح` });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/doctors/:docId/import ───────
export async function importDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    await assertVisible(surveyId, req.user, res);
    const src = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!src || src.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    // Check duplicate
    const existing = await prisma.doctor.findFirst({
      where: { name: src.name, userId: req.user.id },
    });
    if (existing) return res.json({ success: true, data: existing, message: 'الطبيب موجود مسبقاً في قائمتك' });
    const resolvedAreaId = await resolveAreaId(src.areaName, req.user.id);
    const newDoc = await prisma.doctor.create({
      data: {
        name:         src.name,
        specialty:    src.specialty    ?? null,
        pharmacyName: src.pharmacyName ?? null,
        notes:        src.notes        ?? null,
        areaId:       resolvedAreaId,
        userId:       req.user.id,
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
