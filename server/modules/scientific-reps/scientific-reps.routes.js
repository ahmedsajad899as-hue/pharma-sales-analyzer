import { Router } from 'express';
import * as ctrl from './scientific-reps.controller.js';

const router = Router();

// CRUD
router.post('/',          ctrl.createRep);
router.get('/',           ctrl.listReps);
router.get('/my-areas',            ctrl.getMyAreas);            // must be before /:id
router.get('/my-commercial-reps',  ctrl.getMyCommercialReps);    // must be before /:id
router.get('/my-shared-items',     ctrl.getMySharedItems);       // must be before /:id
router.post('/sync-commercials-by-file', ctrl.syncCommercialsByFile); // must be before /:id

// Globally-blocked commercial reps / areas / items (hidden from sci-rep reports
// only) — before /:id
router.get('/blocked-commercials',        ctrl.listBlockedCommercials);
router.post('/blocked-commercials',       ctrl.addBlockedCommercial);
router.delete('/blocked-commercials/:blockId', ctrl.removeBlockedCommercial);

router.get('/blocked/:kind',        ctrl.listBlockedEntities);   // kind: area | item
router.post('/blocked/:kind',       ctrl.addBlockedEntity);
router.delete('/blocked/:kind/:blockId', ctrl.removeBlockedEntity);

router.get('/:id',        ctrl.getRep);
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
