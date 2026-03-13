import { Router } from 'express';
import multer   from 'multer';
import * as ctrl from './commercial.controller.js';

const router = Router();
const upload = multer({ dest: 'uploads/' });

// ── Stats & helpers ───────────────────────────────────────────
router.get('/stats',            ctrl.getStats);
router.get('/reps',             ctrl.listCommercialReps);

// ── Invoices ──────────────────────────────────────────────────
router.get   ('/invoices',              ctrl.listInvoices);
router.post  ('/invoices',              ctrl.createInvoice);
router.post  ('/invoices/import',       upload.single('file'), ctrl.importInvoices);
router.get   ('/invoices/:id',          ctrl.getInvoice);
router.patch ('/invoices/:id',          ctrl.updateInvoice);
router.delete('/invoices/:id',          ctrl.deleteInvoice);
router.post  ('/invoices/:id/collect',  ctrl.collect);

// ── API Integration (Webhook push + ERP pull) ─────────────────
// Webhook: external ERP pushes invoices (API key auth, no JWT)
router.post('/invoices/webhook',  ctrl.apiKeyAuth, ctrl.webhookImport);
// Fetch from external URL (JWT-protected, manager only)
router.post('/fetch-from-url',    ctrl.fetchFromUrl);
// API key management (JWT-protected, manager only)
router.get ('/api-key',           ctrl.generateApiKey);   // GET returns current key
router.post('/api-key/generate',  ctrl.generateApiKey);   // POST creates new key

// ── Pharmacies ────────────────────────────────────────────────
router.get   ('/pharmacies',      ctrl.listPharmacies);
router.post  ('/pharmacies',      ctrl.createPharmacy);
router.patch ('/pharmacies/:id',  ctrl.updatePharmacy);

// ── Visits ────────────────────────────────────────────────────
router.get  ('/visits',   ctrl.listVisits);
router.post ('/visits',   ctrl.createVisit);

// ── Notifications ─────────────────────────────────────────────
router.get   ('/notifications',              ctrl.listNotifications);
router.patch ('/notifications/:id/read',     ctrl.markReadNotification);
router.patch ('/notifications/all/read',     ctrl.markReadNotification);   // id=0 handled in ctrl

export default router;
