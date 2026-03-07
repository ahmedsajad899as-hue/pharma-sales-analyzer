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

// Upload visits Excel
router.post('/visits/upload', upload.single('file'), ctrl.uploadVisits);

// Update visit item
router.patch('/visits/:visitId/item', ctrl.patchVisitItem);

// Voice-to-visits: parse spoken text
router.post('/:id/voice-parse', ctrl.parseVoice);

// Voice-to-visits: upload audio blob (MediaRecorder) → Gemini transcribe + parse
router.post('/:id/voice-record', upload.single('audio'), ctrl.parseVoiceAudio);

export default router;
