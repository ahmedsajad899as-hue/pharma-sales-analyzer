import express from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { getAiUsageSummary } from '../../lib/aiUsage.js';

const router = express.Router();
router.use(requireMasterAdmin);

router.get('/', async (req, res) => {
  try {
    res.json({ success: true, data: await getAiUsageSummary(req.query.days) });
  } catch (e) {
    console.error('[ai-usage]', e);
    res.status(500).json({ error: 'تعذّر جلب الاستهلاك' });
  }
});

export default router;
