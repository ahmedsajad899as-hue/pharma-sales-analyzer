import { Router } from 'express';
import * as ctrl from './scientific-reps.controller.js';

const router = Router();

// CRUD
router.post('/',     ctrl.createRep);
router.get('/',      ctrl.listReps);
router.get('/:id',   ctrl.getRep);
router.patch('/:id', ctrl.updateRep);
router.delete('/:id', ctrl.deleteRep);

// Assignments
router.put('/:id/areas',           ctrl.assignAreas);
router.put('/:id/items',           ctrl.assignItems);
router.put('/:id/companies',       ctrl.assignCompanies);
router.put('/:id/commercial-reps', ctrl.assignCommercialReps);

// Report
router.get('/:id/report', ctrl.getRepReport);

export default router;
