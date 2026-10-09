import { Router } from 'express';
import {
  getStandardsHandler, putStandardsHandler,
  putOverrideHandler, deleteOverrideHandler,
  getScorecardsHandler, recomputeHandler, getMyScorecardHandler,
  previewDigestHandler, sendTestDigestHandler, telegramStatusHandler,
} from './rep-followup.controller.js';

const router = Router();

// المعايير (الأرقام التي يُحاسَب عليها المندوب)
router.get('/standards', getStandardsHandler);
router.put('/standards', putStandardsHandler);
router.put('/standards/override/:repId', putOverrideHandler);
router.delete('/standards/override/:repId', deleteOverrideHandler);

// الملخّص اليومي: معاينة قبل الإرسال، تجربة فورية، ومَن مربوط بتلكرام
router.get('/digest/preview', previewDigestHandler);
router.post('/digest/send-test', sendTestDigestHandler);
router.get('/digest/telegram-status', telegramStatusHandler);

// اللقطات
router.get('/scorecards', getScorecardsHandler);
router.post('/recompute', recomputeHandler);
router.get('/me', getMyScorecardHandler);

export default router;
