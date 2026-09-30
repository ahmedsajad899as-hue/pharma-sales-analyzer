import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as ctrl from './smart-monthly-plans.controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, '../../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const router = Router();
const upload = multer({ dest: uploadsDir });

router.get('/',                 ctrl.list);
router.post('/',                ctrl.create);
router.get('/:id',               ctrl.getOne);
router.patch('/:id',             ctrl.update);
router.delete('/:id',            ctrl.remove);

router.get('/:id/area-doctors',       ctrl.getAreaDoctors);
router.put('/:id/doctor-selection',   ctrl.saveDoctorSelection);
router.post('/:id/pharmacy-links',    ctrl.savePharmacyLink);
router.delete('/:id/pharmacy-links',  ctrl.removePharmacyLink);
router.get('/:id/pharmacy-lookup',    ctrl.lookupPharmacy);
router.post('/:id/pharmacies/rename', ctrl.renamePharmacy);
router.post('/:id/pharmacies/merge',  ctrl.mergePharmacies);

router.post('/:id/uploads/:kind',   upload.single('file'), ctrl.uploadFile);
router.delete('/:id/uploads/:kind', ctrl.clearUpload);

router.post('/:id/resolve',         ctrl.resolve);
router.get('/:id/ambiguous',        ctrl.getAmbiguous);
router.post('/:id/resolve/ai',      ctrl.resolveAi);
router.post('/:id/resolve/confirm', ctrl.confirmMatches);

router.post('/:id/compute',         ctrl.compute);
router.patch('/:id/candidates/:candidateId', ctrl.updateCandidate);

router.post('/:id/mark-exported',   ctrl.markExported);

export default router;
