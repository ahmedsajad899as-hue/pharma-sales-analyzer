import { Router } from 'express';
import {
  getStandardsHandler, putStandardsHandler,
  putOverrideHandler, deleteOverrideHandler,
  getScorecardsHandler, recomputeHandler, getMyScorecardHandler,
} from './rep-followup.controller.js';

const router = Router();

// المعايير (الأرقام التي يُحاسَب عليها المندوب)
router.get('/standards', getStandardsHandler);
router.put('/standards', putStandardsHandler);
router.put('/standards/override/:repId', putOverrideHandler);
router.delete('/standards/override/:repId', deleteOverrideHandler);

// اللقطات
router.get('/scorecards', getScorecardsHandler);
router.post('/recompute', recomputeHandler);
router.get('/me', getMyScorecardHandler);

export default router;
