import { Router } from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import {
  listSurveys, getSurvey, createSurvey, updateSurvey, deleteSurvey,
  addDoctor, updateDoctor, deleteDoctor, extractDoctorImport, commitDoctorImport,
  addPharmacy, updatePharmacy, deletePharmacy, bulkImportPharmacies, mergePharmacies,
  getVisibility, hideUser, showUser, hideOffice, showOffice,
  getSurveyLogs, coverageCheck,
  listDrugEntries, addDrugEntry, updateDrugEntry, deleteDrugEntry, bulkImportDrugEntries,
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
router.post('/:id/doctors',              addDoctor);
router.post('/:id/doctors/bulk/extract', extractDoctorImport);
router.post('/:id/doctors/bulk/commit',  commitDoctorImport);
router.put('/:id/doctors/:docId',        updateDoctor);
router.delete('/:id/doctors/:docId',     deleteDoctor);

// Pharmacies
router.post('/:id/pharmacies',              addPharmacy);
router.post('/:id/pharmacies/bulk',         bulkImportPharmacies);
router.post('/:id/pharmacies/merge',        mergePharmacies);
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

// فحص الظهور: لماذا يقلّ عدد الأطباء عند المستخدمين عن العدد هنا
router.get('/:id/coverage', coverageCheck);

// Drug price entries
router.get('/:id/drug-entries',               listDrugEntries);
router.post('/:id/drug-entries',              addDrugEntry);
router.post('/:id/drug-entries/bulk',         bulkImportDrugEntries);
router.put('/:id/drug-entries/:entryId',      updateDrugEntry);
router.delete('/:id/drug-entries/:entryId',   deleteDrugEntry);

export default router;
