import * as svc from './rep-field-survey.service.js';

// الاسم المكرر لا يُحفظ تلقائياً: يُرجَع 409 مع السجلات المطابقة ليقرر المستخدم
function duplicateResponse(res, data) {
  return res.status(409).json({
    success: false,
    code: 'DUPLICATE_NAME',
    message: 'الاسم موجود بالفعل. اختر: دمج الصيدليات مع الموجود، أو حفظه كسجل جديد.',
    matches: data.matches,
  });
}

// GET /api/rep-field-survey/entries?repUserId=&kind=doctor|pharmacy
export async function listEntries(req, res, next) {
  try {
    const repUserId = req.query.repUserId ? Number(req.query.repUserId) : null;
    const kind      = req.query.kind === 'doctor' || req.query.kind === 'pharmacy' ? req.query.kind : null;
    const data = await svc.listEntries(req.user, { repUserId, kind });
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// POST /api/rep-field-survey/doctors
export async function createDoctor(req, res, next) {
  try {
    const data = await svc.createDoctorEntry(req.user, req.body);
    if (data.duplicate) return duplicateResponse(res, data);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

// POST /api/rep-field-survey/pharmacies
export async function createPharmacy(req, res, next) {
  try {
    const data = await svc.createPharmacyEntry(req.user, req.body);
    if (data.duplicate) return duplicateResponse(res, data);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

// PATCH /api/rep-field-survey/entries/:id — تعديل سجل يملكه المندوب
export async function updateEntry(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'معرّف غير صالح' });
    const data = await svc.updateEntry(req.user, id, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}
