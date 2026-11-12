import express from 'express';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { getAiUsageSummary } from '../../lib/aiUsage.js';
import { listAiModelSettings, setAiModelSetting } from '../../lib/aiModelSettings.js';
import { listInvoiceReadLogs, invoiceReadImagePath } from '../../lib/invoiceReadLog.js';
import { listCardsWithSamples, maybeGenerateCard } from '../../lib/invoiceCardAuto.js';
import { invalidateInvoiceCards } from '../../lib/invoiceCards.js';
import prisma from '../../lib/prisma.js';

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

// بطاقات المذاخر (يدوية + مولَّدة تلقائياً من صور كروباتها — lib/invoiceCardAuto.js)
router.get('/cards', async (_req, res) => {
  try {
    res.json({ success: true, data: await listCardsWithSamples() });
  } catch (e) {
    console.error('[ai-usage/cards]', e);
    res.status(500).json({ error: 'تعذّر جلب البطاقات' });
  }
});

router.patch('/cards/:id', async (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'قيمة غير صالحة' });
    await prisma.warehouseInvoiceCard.update({ where: { id: Number(req.params.id) }, data: { enabled } });
    invalidateInvoiceCards();
    res.json({ success: true, data: await listCardsWithSamples() });
  } catch (e) {
    console.error('[ai-usage/cards]', e);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

// إعادة توليد بطاقة من عيّناتها الآن (يعمل في الخلفية ~30-60 ث)
router.post('/cards/regenerate', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم المذخر مطلوب' });
  maybeGenerateCard(name, { force: true }).catch(e => console.error('[ai-usage/cards/regenerate]', e?.message));
  res.json({ success: true });
});

// الصور المحلَّلة: صورة لكل سطر مع المرسل والتاريخ والتوكنز والكلفة (lib/invoiceReadLog.js)
router.get('/invoices', async (req, res) => {
  try {
    res.json({ success: true, data: await listInvoiceReadLogs({ days: req.query.days, page: req.query.page, kind: req.query.kind }) });
  } catch (e) {
    console.error('[ai-usage/invoices]', e);
    res.status(500).json({ error: 'تعذّر جلب الصور المحلَّلة' });
  }
});

router.get('/invoices/:id/image', async (req, res) => {
  try {
    const p = await invoiceReadImagePath(req.params.id);
    if (!p) return res.status(404).json({ error: 'الصورة غير محفوظة' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(p);
  } catch (e) {
    console.error('[ai-usage/invoices/image]', e);
    res.status(500).json({ error: 'تعذّر جلب الصورة' });
  }
});

export default router;
