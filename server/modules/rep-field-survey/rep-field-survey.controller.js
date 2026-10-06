import * as svc from './rep-field-survey.service.js';

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
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

// POST /api/rep-field-survey/pharmacies
export async function createPharmacy(req, res, next) {
  try {
    const data = await svc.createPharmacyEntry(req.user, req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}
