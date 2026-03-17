import { Router } from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import {
  listSurveys, getSurvey, createSurvey, updateSurvey, deleteSurvey,
  addDoctor, updateDoctor, deleteDoctor,
  addPharmacy, updatePharmacy, deletePharmacy,
  getVisibility, hideUser, showUser, hideOffice, showOffice,
  getSurveyLogs,
} from './survey-admin.controller.js';

const router = Router();

// All routes require Master Admin
router.use(requireMasterAdmin);

// Surveys CRUD
router.get('/',    listSurveys);
router.post('/',   createSurvey);
router.get('/:id', getSurvey);
router.put('/:id', updateSurvey);
router.delete('/:id', deleteSurvey);

// Doctors
router.post('/:id/doctors',           addDoctor);
router.put('/:id/doctors/:docId',     updateDoctor);
router.delete('/:id/doctors/:docId',  deleteDoctor);

// Pharmacies
router.post('/:id/pharmacies',              addPharmacy);
router.put('/:id/pharmacies/:pharmaId',     updatePharmacy);
router.delete('/:id/pharmacies/:pharmaId',  deletePharmacy);

// Visibility
router.get('/:id/visibility',                          getVisibility);
router.post('/:id/visibility/hide-user/:userId',       hideUser);
router.delete('/:id/visibility/hide-user/:userId',     showUser);
router.post('/:id/visibility/hide-office/:officeId',   hideOffice);
router.delete('/:id/visibility/hide-office/:officeId', showOffice);

// Audit log
router.get('/:id/logs', getSurveyLogs);

export default router;
