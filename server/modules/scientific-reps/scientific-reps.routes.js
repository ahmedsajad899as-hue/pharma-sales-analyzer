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
// Master on/off switch for the whole block feature (kept lists apply only when on)
router.get('/blocking-enabled',           ctrl.getBlockingEnabled);
router.patch('/blocking-enabled',         ctrl.setBlockingEnabled);

router.get('/blocked-commercials',        ctrl.listBlockedCommercials);
router.post('/blocked-commercials',       ctrl.addBlockedCommercial);
router.patch('/blocked-commercials/:blockId',  ctrl.setBlockedCommercialEnabled); // {enabled} — تعليق/استئناف بلا حذف
router.delete('/blocked-commercials/:blockId', ctrl.removeBlockedCommercial);

// مطابقة أسماء المندوبين في ملفات ميركاتو مع سجلات المندوبين العلميين — قبل /:id
router.get('/rep-names/check',          ctrl.checkRepNames);   // ?fileIds=1,2
router.post('/rep-names',               ctrl.saveRepNames);    // { links:[{fromName, scientificRepId|null}] }
router.delete('/rep-names/:fromKey',    ctrl.deleteRepNameLink);

// حجب جزئي: مناطق محددة لمندوب تجاري محدد — قبل /:id
router.get('/blocked-rep-areas',        ctrl.listBlockedRepAreas);
router.post('/blocked-rep-areas',       ctrl.addBlockedRepArea);       // { repName, areaName }
router.patch('/blocked-rep-areas/:blockId',  ctrl.setBlockedRepAreaEnabled); // {enabled}
router.delete('/blocked-rep-areas/:blockId', ctrl.removeBlockedRepArea);

router.get('/:id/effective-items',  ctrl.getEffectiveItems);
router.get('/blocked/:kind',        ctrl.listBlockedEntities);   // kind: area | item | pharmacy
router.post('/blocked/:kind',       ctrl.addBlockedEntity);
router.patch('/blocked/:kind/:blockId',  ctrl.setBlockedEntityEnabled); // {enabled} — تعليق/استئناف بلا حذف
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
