import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './doctors.controller.js';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.get('/',                  ctrl.list);
router.get('/visits-by-area',    ctrl.visitsByArea);
router.get('/:id',               ctrl.getOne);
router.post('/',            ctrl.create);
router.post('/import',      upload.single('file'), ctrl.importExcel);
router.put('/:id',          ctrl.update);
router.delete('/all',       ctrl.deleteAll);
router.delete('/:id',       ctrl.remove);

export default router;
