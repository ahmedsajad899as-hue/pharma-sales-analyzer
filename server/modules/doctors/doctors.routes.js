import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './doctors.controller.js';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.get('/',                       ctrl.list);
router.get('/specialties',            ctrl.specialtySuggestions);
router.get('/pharmacy-names',         ctrl.pharmacyNameSuggestions);
router.get('/visits-by-area',         ctrl.visitsByArea);
router.get('/pharmacy-visits-by-area', ctrl.pharmacyVisitsByArea);
router.get('/sub-reps',               ctrl.getManagerSubReps);
router.get('/:id',               ctrl.getOne);
router.post('/',            ctrl.create);
router.post('/import',      upload.single('file'), ctrl.importExcel);
router.put('/:id',          ctrl.update);
router.delete('/all',       ctrl.deleteAll);
router.delete('/:id',       ctrl.remove);

export default router;
