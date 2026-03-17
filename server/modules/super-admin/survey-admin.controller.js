import prisma from '../../lib/prisma.js';

// ── Helpers ──────────────────────────────────────────────────
function logEntry(surveyId, entryType, entryId, action, oldData, newData, editedById) {
  return prisma.masterSurveyEditLog.create({
    data: {
      surveyId,
      entryType,
      entryId,
      action,
      oldData:  oldData  ? JSON.stringify(oldData)  : null,
      newData:  newData  ? JSON.stringify(newData)  : null,
      editedById: editedById ?? null,
    },
  });
}

// ── Survey CRUD ──────────────────────────────────────────────
export async function listSurveys(req, res, next) {
  try {
    const surveys = await prisma.masterSurvey.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { doctors: true, pharmacies: true } },
        createdBy: { select: { username: true, displayName: true } },
      },
    });
    res.json({ success: true, data: surveys });
  } catch (e) { next(e); }
}

export async function getSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    const survey = await prisma.masterSurvey.findUnique({
      where: { id },
      include: {
        doctors:    { orderBy: { createdAt: 'asc' }, include: { lastEditedBy: { select: { username: true, displayName: true } } } },
        pharmacies: { orderBy: { createdAt: 'asc' }, include: { lastEditedBy: { select: { username: true, displayName: true } } } },
        _count: { select: { hiddenUsers: true, hiddenOffices: true } },
      },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي' });
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function createSurvey(req, res, next) {
  try {
    const { name, description, isActive } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'الاسم مطلوب' });
    const survey = await prisma.masterSurvey.create({
      data: {
        name: name.trim(),
        description: description?.trim() ?? null,
        isActive: isActive !== false,
        createdById: req.superAdmin?.id ?? null,
      },
    });
    res.status(201).json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function updateSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    const { name, description, isActive } = req.body;
    const data = {};
    if (name       !== undefined) data.name        = name.trim();
    if (description !== undefined) data.description = description?.trim() ?? null;
    if (isActive   !== undefined) data.isActive    = !!isActive;
    const survey = await prisma.masterSurvey.update({ where: { id }, data });
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function deleteSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    await prisma.masterSurvey.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Survey Doctors ───────────────────────────────────────────
export async function addDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });
    const doc = await prisma.masterSurveyDoctor.create({
      data: { surveyId, name: name.trim(), specialty, areaName, pharmacyName, className, zoneName, phone, notes },
    });
    await logEntry(surveyId, 'doctor', doc.id, 'create', null, doc, req.superAdmin?.id ? null : null);
    res.status(201).json({ success: true, data: doc });
  } catch (e) { next(e); }
}

export async function updateDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { name, specialty, areaName, pharmacyName, className, zoneName, phone, notes } = req.body;
    const data = {};
    if (name         !== undefined) data.name         = name.trim();
    if (specialty    !== undefined) data.specialty    = specialty;
    if (areaName     !== undefined) data.areaName     = areaName;
    if (pharmacyName !== undefined) data.pharmacyName = pharmacyName;
    if (className    !== undefined) data.className    = className;
    if (zoneName     !== undefined) data.zoneName     = zoneName;
    if (phone        !== undefined) data.phone        = phone;
    if (notes        !== undefined) data.notes        = notes;
    const updated = await prisma.masterSurveyDoctor.update({ where: { id: docId }, data });
    await logEntry(surveyId, 'doctor', docId, 'update', old, updated, null);
    res.json({ success: true, data: updated });
  } catch (e) { next(e); }
}

export async function deleteDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    await prisma.masterSurveyDoctor.delete({ where: { id: docId } });
    await logEntry(surveyId, 'doctor', docId, 'delete', old, null, null);
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function bulkImportDoctors(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { doctors } = req.body;
    if (!Array.isArray(doctors) || doctors.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });
    const records = await prisma.$transaction(
      doctors
        .filter(d => d.name?.trim())
        .map(d => prisma.masterSurveyDoctor.create({
          data: {
            surveyId,
            name: d.name.trim(),
            specialty: d.specialty || null,
            areaName: d.areaName || null,
            pharmacyName: d.pharmacyName || null,
            className: d.className || null,
            zoneName: d.zoneName || null,
            phone: d.phone || null,
            notes: d.notes || null,
          },
        }))
    );
    res.status(201).json({ success: true, count: records.length });
  } catch (e) { next(e); }
}

// ── Survey Pharmacies ────────────────────────────────────────
export async function addPharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { name, ownerName, phone, address, areaName, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الصيدلية مطلوب' });
    const ph = await prisma.masterSurveyPharmacy.create({
      data: { surveyId, name: name.trim(), ownerName, phone, address, areaName, notes },
    });
    await logEntry(surveyId, 'pharmacy', ph.id, 'create', null, ph, null);
    res.status(201).json({ success: true, data: ph });
  } catch (e) { next(e); }
}

export async function updatePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    const old = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { name, ownerName, phone, address, areaName, notes } = req.body;
    const data = {};
    if (name      !== undefined) data.name      = name.trim();
    if (ownerName !== undefined) data.ownerName = ownerName;
    if (phone     !== undefined) data.phone     = phone;
    if (address   !== undefined) data.address   = address;
    if (areaName  !== undefined) data.areaName  = areaName;
    if (notes     !== undefined) data.notes     = notes;
    const updated = await prisma.masterSurveyPharmacy.update({ where: { id: pharmaId }, data });
    await logEntry(surveyId, 'pharmacy', pharmaId, 'update', old, updated, null);
    res.json({ success: true, data: updated });
  } catch (e) { next(e); }
}

export async function deletePharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const pharmaId = parseInt(req.params.pharmaId);
    const old = await prisma.masterSurveyPharmacy.findUnique({ where: { id: pharmaId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    await prisma.masterSurveyPharmacy.delete({ where: { id: pharmaId } });
    await logEntry(surveyId, 'pharmacy', pharmaId, 'delete', old, null, null);
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function bulkImportPharmacies(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { pharmacies } = req.body;
    if (!Array.isArray(pharmacies) || pharmacies.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });
    const records = await prisma.$transaction(
      pharmacies
        .filter(p => p.name?.trim())
        .map(p => prisma.masterSurveyPharmacy.create({
          data: {
            surveyId,
            name: p.name.trim(),
            ownerName: p.ownerName || null,
            phone: p.phone || null,
            address: p.address || null,
            areaName: p.areaName || null,
            notes: p.notes || null,
          },
        }))
    );
    res.status(201).json({ success: true, count: records.length });
  } catch (e) { next(e); }
}

// ── Visibility Management ────────────────────────────────────
export async function getVisibility(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const [users, offices, hiddenUsers, hiddenOffices] = await Promise.all([
      prisma.user.findMany({ select: { id: true, username: true, displayName: true, role: true, officeId: true }, orderBy: { displayName: 'asc' } }),
      prisma.scientificOffice.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.masterSurveyHiddenUser.findMany({ where: { surveyId }, select: { userId: true } }),
      prisma.masterSurveyHiddenOffice.findMany({ where: { surveyId }, select: { officeId: true } }),
    ]);
    const hiddenUserIds   = new Set(hiddenUsers.map(h => h.userId));
    const hiddenOfficeIds = new Set(hiddenOffices.map(h => h.officeId));
    res.json({
      success: true,
      data: {
        users:   users.map(u => ({ ...u, hidden: hiddenUserIds.has(u.id) })),
        offices: offices.map(o => ({ ...o, hidden: hiddenOfficeIds.has(o.id) })),
      },
    });
  } catch (e) { next(e); }
}

export async function hideUser(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const userId   = parseInt(req.params.userId);
    await prisma.masterSurveyHiddenUser.upsert({
      where: { surveyId_userId: { surveyId, userId } },
      create: { surveyId, userId },
      update: {},
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function showUser(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const userId   = parseInt(req.params.userId);
    await prisma.masterSurveyHiddenUser.deleteMany({ where: { surveyId, userId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function hideOffice(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const officeId = parseInt(req.params.officeId);
    await prisma.masterSurveyHiddenOffice.upsert({
      where: { surveyId_officeId: { surveyId, officeId } },
      create: { surveyId, officeId },
      update: {},
    });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function showOffice(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const officeId = parseInt(req.params.officeId);
    await prisma.masterSurveyHiddenOffice.deleteMany({ where: { surveyId, officeId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── Audit Log ────────────────────────────────────────────────
export async function getSurveyLogs(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const page  = Math.max(1, parseInt(req.query.page  ?? '1'));
    const limit = Math.min(100, parseInt(req.query.limit ?? '50'));
    const skip  = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      prisma.masterSurveyEditLog.findMany({
        where: { surveyId },
        orderBy: { editedAt: 'desc' },
        skip, take: limit,
        include: { editedBy: { select: { id: true, username: true, displayName: true } } },
      }),
      prisma.masterSurveyEditLog.count({ where: { surveyId } }),
    ]);
    res.json({ success: true, data: logs, total, page, limit });
  } catch (e) { next(e); }
}
