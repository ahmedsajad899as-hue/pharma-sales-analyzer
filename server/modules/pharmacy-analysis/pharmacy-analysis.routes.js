import { Router } from 'express';
import * as ctrl from './pharmacy-analysis.controller.js';
import prisma from '../../lib/prisma.js';
import { runAlertsForOwner } from './pharmacy-alerts.scheduler.js';

const router = Router();

// GET /api/pharmacy-analysis/pharmacies  — list all pharmacies with summary
router.get('/pharmacies', ctrl.listPharmacies);

// GET /api/pharmacy-analysis/pharmacy/:name — all orders for a pharmacy (optionally filter by item)
router.get('/pharmacy/:name', ctrl.pharmacyDetail);

// GET /api/pharmacy-analysis/items — list all items with pharmacy-level breakdown
router.get('/items', ctrl.listItems);

// GET /api/pharmacy-analysis/item/:name — all pharmacies that bought this item
router.get('/item/:name', ctrl.itemDetail);

// GET /api/pharmacy-analysis/alerts — pharmacies × items overdue for an order
router.get('/alerts', ctrl.getAlerts);


// ─── تنبيهات الصيدليات التلقائية: الإعدادات + التشغيل اليدوي ────────────────

// GET /api/pharmacy-analysis/alert-settings
router.get('/alert-settings', async (req, res, next) => {
  try {
    const userId = req.user.id;
    let s = await prisma.pharmacyAlertSettings.findUnique({ where: { userId } });
    if (!s) s = { userId, enabled: false, frequency: 'daily', weekday: 0, hour: 8, thresholdDays: 30, cooldownDays: 14, notifyReps: true, notifyManager: true, lastRunAt: null };
    res.json({ success: true, data: s });
  } catch (e) { next(e); }
});

// PUT /api/pharmacy-analysis/alert-settings
router.put('/alert-settings', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const b = req.body || {};
    const clampInt = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
    };
    const data = {
      enabled:       b.enabled === true,
      frequency:     b.frequency === 'weekly' ? 'weekly' : 'daily',
      weekday:       clampInt(b.weekday, 0, 6, 0),
      hour:          clampInt(b.hour, 0, 23, 8),
      thresholdDays: clampInt(b.thresholdDays, 1, 365, 30),
      cooldownDays:  clampInt(b.cooldownDays, 1, 180, 14),
      notifyReps:    b.notifyReps !== false,
      notifyManager: b.notifyManager !== false,
    };
    const saved = await prisma.pharmacyAlertSettings.upsert({
      where: { userId }, update: data, create: { userId, ...data },
    });
    res.json({ success: true, data: saved });
  } catch (e) { next(e); }
});

// POST /api/pharmacy-analysis/alert-settings/run-now — إرسال فوري للتجربة.
// يتجاهل الجدولة لكن يحترم فترة الهدوء، فلا يُغرق أحداً بتكرار الضغط.
router.post('/alert-settings/run-now', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const s = await prisma.pharmacyAlertSettings.findUnique({ where: { userId } });
    if (!s) return res.status(400).json({ success: false, error: 'احفظ الإعدادات أولاً' });
    const result = await runAlertsForOwner(s);
    res.json({ success: true, result });
  } catch (e) { next(e); }
});

export default router;
