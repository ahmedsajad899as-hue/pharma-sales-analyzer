import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './monthly-plans.controller.js';

const router  = Router();
const upload  = multer({ dest: 'uploads/' });

router.get('/',                        ctrl.list);
router.get('/suggest',                 ctrl.suggest);
router.get('/:id',                     ctrl.getOne);
router.post('/',                       ctrl.create);
router.put('/:id',                     ctrl.update);
router.delete('/:id',                  ctrl.remove);

// Pharmacy visits for a plan (same rep + month)
router.get('/:id/pharmacy-visits',     ctrl.getPharmacyVisits);

// Plan transfer (manager → rep user)
router.get('/:id/transfer-targets',    ctrl.getTransferTargets);
router.get('/:id/available-doctors',   ctrl.availableDoctors);
router.post('/:id/transfer',           ctrl.transferPlan);
router.delete('/:id/transfer',         ctrl.revokePlanTransfer);

// Entries (doctors in plan)
router.post('/:id/entries',                                  ctrl.addEntry);
router.patch('/:id/entries/:entryId',                        ctrl.patchEntry);
router.delete('/:id/entries/:entryId',                       ctrl.removeEntry);
router.post('/:id/entries/bulk-delete',                      ctrl.bulkRemoveEntries);

// Entry items (ايتمات لكل طبيب في البلان)
router.post('/:id/entries/:entryId/items',                   ctrl.addEntryItem);
router.delete('/:id/entries/:entryId/items/:itemId',         ctrl.removeEntryItem);

// Manual visits (تسجيل زيارة يدوياً)
router.post('/:id/entries/:entryId/visits',                  ctrl.addVisit);
router.delete('/visits/:visitId',                            ctrl.deleteVisit);

// Import visits from Excel — linked to specific plan
router.post('/:id/import-visits', upload.single('file'), ctrl.importPlanVisits);

// Import plan entries (doctors list) from JSON
router.post('/:id/import-entries', ctrl.importPlanEntries);

// Upload visits Excel
router.post('/visits/upload', upload.single('file'), ctrl.uploadVisits);

// Update visit item
router.patch('/visits/:visitId/item', ctrl.patchVisitItem);

// Visit likes & comments
router.post('/visits/:visitId/like',                     ctrl.toggleVisitLike);
router.post('/visits/:visitId/comments',                 ctrl.addVisitComment);
router.delete('/visits/:visitId/comments/:commentId',    ctrl.deleteVisitComment);

// Voice-to-visits: parse spoken text
router.post('/:id/voice-parse', ctrl.parseVoice);

// Voice-to-visits: upload audio blob (MediaRecorder) → Gemini transcribe + parse
router.post('/:id/voice-record', upload.single('audio'), ctrl.parseVoiceAudio);

export default router;
