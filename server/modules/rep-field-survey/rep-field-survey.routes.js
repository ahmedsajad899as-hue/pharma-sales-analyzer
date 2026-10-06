import { Router } from 'express';
import * as ctrl from './rep-field-survey.controller.js';

const router = Router();

router.get('/entries',     ctrl.listEntries);
router.post('/doctors',    ctrl.createDoctor);
router.post('/pharmacies', ctrl.createPharmacy);
router.patch('/entries/:id', ctrl.updateEntry);

export default router;
