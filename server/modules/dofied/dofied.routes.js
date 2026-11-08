// /api/sa/dofied — إعداد ربط دوفايد (ماستر أدمن فقط).
import { Router } from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { publicConfig, saveConfig, testConnection, runSync, sendTestAlert } from './dofied.sync.js';

const router = Router();
router.use(requireMasterAdmin);

router.get('/', async (_req, res, next) => {
  try { res.json({ success: true, data: await publicConfig() }); } catch (e) { next(e); }
});

router.put('/', async (req, res, next) => {
  try {
    const { username, password, userId, enabled, runHour, lastSyncedDate, notifyChatId } = req.body || {};
    res.json({ success: true, data: await saveConfig({ username, password, userId, enabled, runHour, lastSyncedDate, notifyChatId }) });
  } catch (e) { next(e); }
});

router.post('/test-alert', async (_req, res) => {
  const r = await sendTestAlert();
  if (r.ok) res.json({ success: true, message: 'أُرسل التنبيه التجريبي — تحقّق من تلكرام' });
  else res.status(400).json({ success: false, error: `لم يُرسل التنبيه: ${r.error}` });
});

router.post('/test', async (_req, res) => {
  try {
    await testConnection();
    res.json({ success: true, message: 'تم تسجيل الدخول إلى دوفايد بنجاح' });
  } catch (e) {
    res.status(400).json({ success: false, error: e?.message || 'فشل الاتصال' });
  }
});

router.post('/run', async (_req, res, next) => {
  try {
    const r = await runSync({ trigger: 'manual' });
    res.json({ success: r.status !== 'error', ...r, data: await publicConfig() });
  } catch (e) { next(e); }
});

export default router;
