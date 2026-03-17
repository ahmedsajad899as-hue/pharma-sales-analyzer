import { Router } from 'express';
import {
  listSurveys, getSurvey,
  addDoctor, updateDoctor, importAllDoctors, importDoctor,
  addPharmacy, updatePharmacy, importPharmacy,
} from './master-survey.controller.js';

const router = Router();

// All routes require requireAuth (applied in server/index.js before /api/master-surveys)

router.get('/',    listSurveys);
router.get('/:id', getSurvey);

// Doctors
router.post('/:id/doctors',                      addDoctor);
router.put('/:id/doctors/:docId',                updateDoctor);
router.post('/:id/doctors/import-all',           importAllDoctors);
router.post('/:id/doctors/:docId/import',        importDoctor);

// Pharmacies
router.post('/:id/pharmacies',                       addPharmacy);
router.put('/:id/pharmacies/:pharmaId',              updatePharmacy);
router.post('/:id/pharmacies/:pharmaId/import',      importPharmacy);

export default router;
