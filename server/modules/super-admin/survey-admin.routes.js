import { Router } from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import {
  listSurveys, getSurvey, createSurvey, updateSurvey, deleteSurvey,
  addDoctor, updateDoctor, deleteDoctor, restoreDoctor, extractDoctorImport, commitDoctorImport,
  addPharmacy, updatePharmacy, deletePharmacy, restorePharmacy, bulkImportPharmacies, mergePharmacies, getPharmacyMergeSuggestions,
  previewPharmacyNameCleanupCtrl, applyPharmacyNameCleanupCtrl,
  getVisibility, hideUser, showUser, hideOffice, showOffice,
  getSurveyLogs, coverageCheck,
  listDrugEntries, addDrugEntry, updateDrugEntry, deleteDrugEntry, bulkImportDrugEntries,
} from './survey-admin.controller.js';
import {
  saExport, saAnalyze, saListBatches, saGetBatch, saDecideRow, saDecideBulk, saApply, saDiscard,
} from '../survey-sync/survey-sync.controller.js';

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
router.delete('/:id/doctors/:docId',     deleteDoctor); // = تعطيل، لا حذف فعلي
router.post('/:id/doctors/:docId/restore', restoreDoctor);

// Pharmacies
router.post('/:id/pharmacies',              addPharmacy);
router.post('/:id/pharmacies/bulk',         bulkImportPharmacies);
router.post('/:id/pharmacies/merge',        mergePharmacies);
router.get('/:id/pharmacies/merge-suggestions', getPharmacyMergeSuggestions);
router.get('/:id/pharmacies/cleanup-names/preview', previewPharmacyNameCleanupCtrl);
router.post('/:id/pharmacies/cleanup-names/apply',  applyPharmacyNameCleanupCtrl);
router.put('/:id/pharmacies/:pharmaId',     updatePharmacy);
router.delete('/:id/pharmacies/:pharmaId',  deletePharmacy); // = تعطيل، لا حذف فعلي
router.post('/:id/pharmacies/:pharmaId/restore', restorePharmacy);

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

// ── دورة تحديث السيرفي عبر إكسل مُرمَّز ─────────────────────
// التصدير يُنشئ لقطة ببصمات الصفوف؛ الرفع يُنشئ دفعة مصنَّفة بلا أي كتابة على
// السيرفي؛ ولا شيء يُطبَّق قبل اعتماد صريح لكل صف يحتاج قراراً.
// ملاحظة ترتيب: مسارا sync/batches و sync/rows بلا :id عمداً (الدفعة تعرف
// سيرفيها)، ويجب أن يسبقا أي مسار عام قد يبتلعهما.
router.get('/sync/batches/:batchId',            saGetBatch);
router.patch('/sync/rows/:rowId',               saDecideRow);
router.post('/sync/batches/:batchId/decide-bulk', saDecideBulk);
router.post('/sync/batches/:batchId/apply',     saApply);
router.delete('/sync/batches/:batchId',         saDiscard);

router.get('/:id/sync/batches',                 saListBatches);
router.post('/:id/sync/analyze',                saAnalyze);
router.get('/:id/:entryType/export',            saExport);

export default router;
