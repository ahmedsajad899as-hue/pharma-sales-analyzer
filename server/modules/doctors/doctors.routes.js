import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './doctors.controller.js';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.get('/',                       ctrl.list);
router.get('/specialties',            ctrl.specialtySuggestions);
router.get('/pharmacy-names',         ctrl.pharmacyNameSuggestions);
router.get('/visits-by-area',         ctrl.visitsByArea);
router.patch('/visits/:id/item',      ctrl.updateVisitItem);
router.patch('/visits/:id/pharmacy-name', ctrl.renameVisitPharmacy);
router.get('/visits-latest-month',    ctrl.visitsLatestMonth);
router.get('/pharmacy-visits-by-area', ctrl.pharmacyVisitsByArea);
router.get('/pharmacy-visits-latest-month', ctrl.pharmacyVisitsLatestMonth);
router.get('/visits/all-reps-summary', ctrl.allRepsVisitsSummary);
router.get('/sub-reps',               ctrl.getManagerSubReps);
router.get('/wishlist',               ctrl.getWishlist);
router.get('/wishlist/debug',          ctrl.debugWishlist);
router.get('/wishlist/teams',          ctrl.getTeamWishlists);
router.get('/wishlist/rep/:repUserId', ctrl.getRepWishlist);
router.post('/wishlist',              ctrl.upsertWishlist);
router.delete('/wishlist/:doctorId',  ctrl.removeWishlist);
router.get('/:id',               ctrl.getOne);
router.post('/',            ctrl.create);
router.post('/import',      upload.single('file'), ctrl.importExcel);
router.post('/visits/import-extract', upload.single('file'), ctrl.extractVisitsImport);
router.post('/visits/import-commit',  ctrl.commitVisitsImport);
router.post('/visits/import-ensure-reps', ctrl.ensureVisitsImportReps);
// استيراد الكولات من دوفايد بضغطة زر (ميزة اشتراك visits_dofied_pull). استيراد كسول:
// dofied.pull يستورد doctor-visits-import الذي يستورد هذا الموديول — يُتفادى الدوران.
const dofiedPull = () => import('../dofied/dofied.pull.js');
router.get('/visits/dofied-pull', async (req, res, next) => {
  try { res.json({ success: true, data: await (await dofiedPull()).pullInfo(req.user.id) }); } catch (e) { next(e); }
});
router.post('/visits/dofied-pull', async (req, res, next) => {
  try {
    res.json({ success: true, data: await (await dofiedPull()).startPull(req.user.id) });
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ success: false, error: e.message });
    next(e);
  }
});
router.get('/visits/pending-import',    ctrl.getPendingVisitsImport);
router.delete('/visits/pending-import', ctrl.deletePendingVisitsImport);
router.get('/visits/import-files',      ctrl.listVisitImportFiles);
router.patch('/visits/import-files/:id', ctrl.setVisitImportFileActive);
router.post('/visits/import-files/merge', ctrl.mergeVisitImportFiles);
router.delete('/visits/import-files/:id', ctrl.deleteVisitImportFile);
router.patch('/visits/import-batches/:batchId', ctrl.setVisitImportBatchActive);
router.delete('/visits/import-batches/:batchId', ctrl.deleteVisitImportBatch);
router.put('/:id',          ctrl.update);
router.delete('/all',       ctrl.deleteAll);
router.delete('/:id',       ctrl.remove);

export default router;
