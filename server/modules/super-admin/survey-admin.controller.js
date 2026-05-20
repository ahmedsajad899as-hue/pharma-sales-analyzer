import prisma from '../../lib/prisma.js';

// ── Shared helpers ────────────────────────────────────────────
// Find or create an Area by name for a given user
async function resolveAreaId(areaName, userId) {
  if (!areaName?.trim()) return null;
  const nameNorm = areaName.trim().toLowerCase();
  const userAreas = await prisma.area.findMany({ where: { userId }, select: { id: true, name: true } });
  const found = userAreas.find(a => a.name.trim().toLowerCase() === nameNorm);
  if (found) return found.id;
  const created = await prisma.area.create({ data: { name: areaName.trim(), userId } });
  return created.id;
}

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
        _count: { select: { hiddenUsers: true, hiddenOffices: true, drugEntries: true } },
      },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'لم يُعثر على السيرفي' });
    res.json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function createSurvey(req, res, next) {
  try {
    const { name, description, isActive, surveyType } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'الاسم مطلوب' });
    const survey = await prisma.masterSurvey.create({
      data: {
        name: name.trim(),
        description: description?.trim() ?? null,
        isActive: isActive !== false,
        surveyType: surveyType === 'drug_prices' ? 'drug_prices' : 'general',
        createdById: req.superAdmin?.id ?? null,
      },
    });
    res.status(201).json({ success: true, data: survey });
  } catch (e) { next(e); }
}

export async function updateSurvey(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    const { name, description, isActive, surveyType } = req.body;
    const data = {};
    if (name       !== undefined) data.name        = name.trim();
    if (description !== undefined) data.description = description?.trim() ?? null;
    if (isActive   !== undefined) data.isActive    = !!isActive;
    if (surveyType !== undefined) data.surveyType  = surveyType === 'drug_prices' ? 'drug_prices' : 'general';
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

export async function deleteDoctor(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const docId    = parseInt(req.params.docId);
    const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    await prisma.masterSurveyDoctor.delete({ where: { id: docId } });
    await logEntry(surveyId, 'doctor', docId, 'delete', old, null, null);

    // Cascade: soft-delete all Doctor records imported from this survey doctor
    // (preserves visit history; removes them from active lists and analysis)
    await prisma.doctor.updateMany({
      where: { masterSurveyDoctorId: docId },
      data:  { isActive: false },
    });

    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function bulkImportDoctors(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { doctors } = req.body;
    if (!Array.isArray(doctors) || doctors.length === 0)
      return res.status(400).json({ success: false, error: 'لا يوجد بيانات' });
    const data = doctors
      .filter(d => d.name?.trim())
      .map(d => ({
        surveyId,
        name:         d.name.trim(),
        specialty:    d.specialty    || null,
        areaName:     d.areaName     || null,
        pharmacyName: d.pharmacyName || null,
        className:    d.className    || null,
        zoneName:     d.zoneName     || null,
        phone:        d.phone        || null,
        notes:        d.notes        || null,
      }));
    const result = await prisma.masterSurveyDoctor.createMany({ data });
    res.status(201).json({ success: true, count: result.count });
  } catch (e) { console.error('[bulkImportDoctors]', e.message, e.code); next(e); }
}

// ── Survey Pharmacies ────────────────────────────────────────
export async function addPharmacy(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الصيدلية مطلوب' });
    const ph = await prisma.masterSurveyPharmacy.create({
      data: { surveyId, name: name.trim(), ownerName, pharmacyName, phone, address, areaName, notes },
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
    const { name, ownerName, pharmacyName, phone, address, areaName, notes } = req.body;
    const data = {};
    if (name         !== undefined) data.name         = name.trim();
    if (ownerName    !== undefined) data.ownerName    = ownerName;
    if (pharmacyName !== undefined) data.pharmacyName = pharmacyName;
    if (phone        !== undefined) data.phone        = phone;
    if (address      !== undefined) data.address      = address;
    if (areaName     !== undefined) data.areaName     = areaName;
    if (notes        !== undefined) data.notes        = notes;
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
    const data = pharmacies
      .filter(p => p.name?.trim())
      .map(p => ({
        surveyId,
        name:         p.name.trim(),
        ownerName:    p.ownerName    || null,
        pharmacyName: p.pharmacyName || null,
        phone:        p.phone        || null,
        address:      p.address      || null,
        areaName:     p.areaName     || null,
        notes:        p.notes        || null,
      }));
    const result = await prisma.masterSurveyPharmacy.createMany({ data });
    res.status(201).json({ success: true, count: result.count });
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

// ── Drug Price Survey Entries ─────────────────────────────────

export async function listDrugEntries(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const search = (req.query.search || '').trim();
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || '100')));
    const skip  = (page - 1) * limit;
    const where = {
      surveyId,
      ...(search ? {
        OR: [
          { brandName:     { contains: search, mode: 'insensitive' } },
          { scientificName:{ contains: search, mode: 'insensitive' } },
          { company:       { contains: search, mode: 'insensitive' } },
          { dosageForm:    { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [entries, total] = await Promise.all([
      prisma.drugPriceSurveyEntry.findMany({
        where,
        orderBy: [{ brandName: 'asc' }, { company: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.drugPriceSurveyEntry.count({ where }),
    ]);
    res.json({ success: true, data: entries, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) { next(e); }
}

export async function addDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { brandName, scientificName, company, dosageForm, packaging, priceOfficeToWholesaler, priceWholesalerToPharmacy, pricePharmacyToPatient, notes } = req.body;
    if (!brandName?.trim()) return res.status(400).json({ success: false, error: '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u062a\u062c\u0627\u0631\u064a \u0645\u0637\u0644\u0648\u0628' });
    const entry = await prisma.drugPriceSurveyEntry.create({
      data: {
        surveyId,
        brandName: brandName.trim(),
        scientificName: scientificName?.trim() || null,
        company: company?.trim() || null,
        dosageForm: dosageForm?.trim() || null,
        packaging: packaging?.trim() || null,
        priceOfficeToWholesaler: priceOfficeToWholesaler != null ? Number(priceOfficeToWholesaler) : null,
        priceWholesalerToPharmacy: priceWholesalerToPharmacy != null ? Number(priceWholesalerToPharmacy) : null,
        pricePharmacyToPatient: pricePharmacyToPatient != null ? Number(pricePharmacyToPatient) : null,
        notes: notes?.trim() || null,
      },
    });
    res.status(201).json({ success: true, data: entry });
  } catch (e) { next(e); }
}

export async function updateDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);
    const old = await prisma.drugPriceSurveyEntry.findUnique({ where: { id: entryId } });
    if (!old || old.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    const { brandName, scientificName, company, dosageForm, packaging, priceOfficeToWholesaler, priceWholesalerToPharmacy, pricePharmacyToPatient, notes } = req.body;
    const data = {};
    if (brandName      !== undefined) data.brandName      = brandName.trim();
    if (scientificName !== undefined) data.scientificName = scientificName?.trim() || null;
    if (company        !== undefined) data.company        = company?.trim() || null;
    if (dosageForm     !== undefined) data.dosageForm     = dosageForm?.trim() || null;
    if (packaging      !== undefined) data.packaging      = packaging?.trim() || null;
    if (priceOfficeToWholesaler   !== undefined) data.priceOfficeToWholesaler   = priceOfficeToWholesaler   != null ? Number(priceOfficeToWholesaler)   : null;
    if (priceWholesalerToPharmacy !== undefined) data.priceWholesalerToPharmacy = priceWholesalerToPharmacy != null ? Number(priceWholesalerToPharmacy) : null;
    if (pricePharmacyToPatient    !== undefined) data.pricePharmacyToPatient    = pricePharmacyToPatient    != null ? Number(pricePharmacyToPatient)    : null;
    if (notes          !== undefined) data.notes          = notes?.trim() || null;
    const entry = await prisma.drugPriceSurveyEntry.update({ where: { id: entryId }, data });
    res.json({ success: true, data: entry });
  } catch (e) { next(e); }
}

export async function deleteDrugEntry(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryId  = parseInt(req.params.entryId);
    const entry = await prisma.drugPriceSurveyEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.surveyId !== surveyId) return res.status(404).json({ success: false, error: 'غير موجود' });
    await prisma.drugPriceSurveyEntry.delete({ where: { id: entryId } });
    res.json({ success: true });
  } catch (e) { next(e); }
}

export async function bulkImportDrugEntries(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const { entries, mode } = req.body;  // mode: 'insert' (default) | 'upsert' (update prices of existing entries)
    if (!Array.isArray(entries) || !entries.length)
      return res.status(400).json({ success: false, error: 'لا توجد بيانات' });
    const rows = entries
      .filter(e => e.brandName?.trim())
      .map(e => ({
        surveyId,
        brandName:     String(e.brandName).trim(),
        scientificName: e.scientificName?.trim() || null,
        company:        e.company?.trim() || null,
        dosageForm:     e.dosageForm?.trim() || null,
        packaging:      e.packaging?.trim() || null,
        priceOfficeToWholesaler:   e.priceOfficeToWholesaler   != null ? Number(e.priceOfficeToWholesaler)   : null,
        priceWholesalerToPharmacy: e.priceWholesalerToPharmacy != null ? Number(e.priceWholesalerToPharmacy) : null,
        pricePharmacyToPatient:    e.pricePharmacyToPatient    != null ? Number(e.pricePharmacyToPatient)    : null,
        notes:          e.notes?.trim() || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    if (mode === 'upsert') {
      // Update prices on existing entries matched by brandName (case-insensitive) within same survey
      let updated = 0;
      for (const row of rows) {
        const result = await prisma.drugPriceSurveyEntry.updateMany({
          where: {
            surveyId,
            brandName: { equals: row.brandName, mode: 'insensitive' },
          },
          data: {
            ...(row.scientificName !== null ? { scientificName: row.scientificName } : {}),
            priceOfficeToWholesaler:   row.priceOfficeToWholesaler,
            priceWholesalerToPharmacy: row.priceWholesalerToPharmacy,
            pricePharmacyToPatient:    row.pricePharmacyToPatient,
            updatedAt: new Date(),
          },
        });
        updated += result.count;
      }
      return res.json({ success: true, count: updated, mode: 'upsert' });
    }

    await prisma.drugPriceSurveyEntry.createMany({ data: rows, skipDuplicates: false });
    res.json({ success: true, count: rows.length });
  } catch (e) { next(e); }
}
