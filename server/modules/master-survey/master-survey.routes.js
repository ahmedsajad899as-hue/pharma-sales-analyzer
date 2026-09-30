import { Router } from 'express';
import {
  listSurveys, getSurvey, listDrugEntries,
  addDoctor, updateDoctor, importAllDoctors, importDoctor,
  addPharmacy, updatePharmacy, importAllPharmacies, importPharmacy,
} from './master-survey.controller.js';
import { repExport, repUpload, repMyBatches } from '../survey-sync/survey-sync.controller.js';

const router = Router();

// All routes require requireAuth (applied in server/index.js before /api/master-surveys)

router.get('/',                     listSurveys);
router.get('/:id/drug-entries',     listDrugEntries);
router.get('/:id',                  getSurvey);

// Doctors
router.post('/:id/doctors',                      addDoctor);
router.put('/:id/doctors/:docId',                updateDoctor);
router.post('/:id/doctors/import-all',           importAllDoctors);
router.post('/:id/doctors/:docId/import',        importDoctor);

// Pharmacies
router.post('/:id/pharmacies',                       addPharmacy);
router.put('/:id/pharmacies/:pharmaId',              updatePharmacy);
router.post('/:id/pharmacies/import-all',            importAllPharmacies);
router.post('/:id/pharmacies/:pharmaId/import',      importPharmacy);

// ── دورة تحديث السيرفي (جانب المندوب) ───────────────────────
// تنزيل ملف مناطقه وحدها، ورفعه بعد التعديل. الرفع لا يكتب على السيرفي —
// ينشئ دفعة تنتظر مراجعة السوبر أدمن، ومن هنا يتابع حالتها.
router.get('/:id/sync/my-batches',        repMyBatches);
router.post('/:id/sync/upload',           repUpload);
router.get('/:id/sync/:entryType/export', repExport);

export default router;
