import express from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { getAiUsageSummary } from '../../lib/aiUsage.js';
import { listAiModelSettings, setAiModelSetting } from '../../lib/aiModelSettings.js';

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

// نموذج الذكاء لكل ميزة (strong | lite | auto)
router.get('/models', async (req, res) => {
  try {
    res.json({ success: true, data: await listAiModelSettings() });
  } catch (e) {
    console.error('[ai-usage/models]', e);
    res.status(500).json({ error: 'تعذّر جلب إعدادات النماذج' });
  }
});

router.put('/models', async (req, res) => {
  const { feature, mode } = req.body || {};
  try {
    if (!(await setAiModelSetting(String(feature || ''), String(mode || '')))) {
      return res.status(400).json({ error: 'ميزة أو وضع غير صالح' });
    }
    res.json({ success: true, data: await listAiModelSettings() });
  } catch (e) {
    console.error('[ai-usage/models]', e);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

export default router;
