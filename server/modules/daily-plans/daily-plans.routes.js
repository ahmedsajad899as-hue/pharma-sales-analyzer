/**
 * Daily Plans Routes (البلان اليومي)
 *
 *   GET    /api/daily-plans?date=YYYY-MM-DD[&repUserId=]   plan view + achievement
 *   POST   /api/daily-plans                                get-or-create a day's plan
 *   GET    /api/daily-plans/suggest?mode=new|carryover     doctor suggestions
 *   GET    /api/daily-plans/repeats                        repeated-doctor report
 *   GET    /api/daily-plans/postpone-stats                 postpone-reason analytics
 *   GET    /api/daily-plans/settings                       company-manager settings
 *   PUT    /api/daily-plans/settings
 *   PATCH  /api/daily-plans/entries/:entryId               update status / postpone
 *   DELETE /api/daily-plans/entries/:entryId
 *   POST   /api/daily-plans/:id/entries                    add a doctor/pharmacy
 *   POST   /api/daily-plans/:id/entries/:entryId/record-visit   quick-record a call
 *   POST   /api/daily-plans/:id/comments                   manager comment
 *
 * Auth (valid JWT) is applied globally in server/index.js for all /api routes.
 */

import { Router } from 'express';
import * as ctrl from './daily-plans.controller.js';

const router = Router();

// ── Static sub-paths (must precede /:id routes) ─────────────
router.get('/suggest',         ctrl.suggest);
router.get('/repeats',         ctrl.repeats);
router.get('/postpone-stats',  ctrl.postponeStats);
router.get('/settings',        ctrl.getSettings);
router.put('/settings',        ctrl.putSettings);

router.patch('/entries/:entryId',  ctrl.updateEntry);
router.delete('/entries/:entryId', ctrl.removeEntry);

// ── Plan-level ──────────────────────────────────────────────
router.get('/',  ctrl.getPlan);
router.post('/', ctrl.createPlan);

router.post('/:id/entries/:entryId/record-visit', ctrl.recordVisit);
router.post('/:id/entries',  ctrl.addEntry);
router.post('/:id/comments', ctrl.addComment);

export default router;
