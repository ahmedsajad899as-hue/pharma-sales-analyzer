import { Router } from 'express';
import * as ctrl from './orders.controller.js';

const router = Router();

// JWT مطلوب لكل ما تحت /api (بوابة server/index.js) — لا تخطّي هنا.
// ترتيب حسّاس: '/pending/count' قبل '/pending/:id' وإلا التقط :id القيمة 'count'.
router.get   ('/pending/count',          ctrl.getPendingCount);
router.get   ('/pending',                ctrl.listPending);
router.get   ('/pending/:id',            ctrl.getPending);
router.get   ('/pending/:id/image/:idx', ctrl.getPendingImage);
router.delete('/pending/:id',            ctrl.deletePending);

export default router;
