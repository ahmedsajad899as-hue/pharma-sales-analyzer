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
    res.json({ success: true, data: surveys });
  } catch (e) { next(e); }
}

// ── GET /api/master-surveys/:id ──────────────────────────────
export async function getSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
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
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

// ── POST /api/master-surveys/:id/doctors ─────────────────────
export async function addDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    await assertVisible(surveyId, req.user, res);
    const { name, specialty, areaName, pharmacyName, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });
    const doc = await prisma.masterSurveyDoctor.create({
      data: {
        surveyId,
        name: name.trim(), specialty, areaName, pharmacyName, phone, notes,
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
    const { name, specialty, areaName, pharmacyName, phone, notes } = req.body;
    const data = { lastEditedById: req.user.id, lastEditedAt: new Date() };
    if (name         !== undefined) data.name         = name.trim();
    if (specialty    !== undefined) data.specialty    = specialty;
    if (areaName     !== undefined) data.areaName     = areaName;
    if (pharmacyName !== undefined) data.pharmacyName = pharmacyName;
    if (phone        !== undefined) data.phone        = phone;
    if (notes        !== undefined) data.notes        = notes;
    const updated = await prisma.masterSurveyDoctor.update({ where: { id: docId }, data });
    await logEntry(surveyId, 'doctor', docId, 'update', old, updated, req.user.id);
    res.json({ success: true, data: updated });
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
    const newDoc = await prisma.doctor.create({
      data: {
        name:         src.name,
        specialty:    src.specialty ?? null,
        pharmacyName: src.pharmacyName ?? null,
        phone:        src.phone ?? null,
        notes:        src.notes ?? null,
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
    const { name, ownerName, phone, address, areaName, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الصيدلية مطلوب' });
    const ph = await prisma.masterSurveyPharmacy.create({
      data: {
        surveyId,
        name: name.trim(), ownerName, phone, address, areaName, notes,
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
    const { name, ownerName, phone, address, areaName, notes } = req.body;
    const data = { lastEditedById: req.user.id, lastEditedAt: new Date() };
    if (name      !== undefined) data.name      = name.trim();
    if (ownerName !== undefined) data.ownerName = ownerName;
    if (phone     !== undefined) data.phone     = phone;
    if (address   !== undefined) data.address   = address;
    if (areaName  !== undefined) data.areaName  = areaName;
    if (notes     !== undefined) data.notes     = notes;
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
    if (!src || src.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const newPh = await prisma.pharmacy.create({
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
