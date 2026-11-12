// ════════════════════════════════════════════════════════════════════════════
// wa-campaigns.routes.js — مساران بنفس المعالجات:
//  • /api/wa-campaigns      — موظفو المكتب (صفحة اشتراك wa_campaigns). يرون حملات مكتبهم.
//  • /api/sa/wa-campaigns   — الماستر أدمن (لوحة السوبر أدمن). يرى كل الحملات.
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';
import multer from 'multer';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';
import { userFeatureOn } from '../../lib/userFeatures.js';
import { normalizeWaId } from '../../lib/waId.js';
import * as svc from './wa-campaigns.service.js';

export const FEATURE_KEY = 'wa_campaigns';
export const CAMPAIGN_ROLES = new Set(['office_employee', 'office_manager', 'office_hr', 'admin']);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

/** actor = { id, name, officeId, all } */
async function appActor(req) {
  const u = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, role: true, officeId: true, permissions: true, isActive: true, displayName: true, username: true },
  });
  if (!u || !u.isActive || !CAMPAIGN_ROLES.has(u.role) || !userFeatureOn(u, FEATURE_KEY, { optIn: true })) {
    throw new AppError('صفحة حملات واتساب غير مفعّلة لحسابك', 403);
  }
  return { id: u.id, name: u.displayName || u.username, officeId: u.officeId ?? null, all: u.role === 'admin' };
}

function saActor(req) {
  const sa = req.superAdmin || {};
  return { id: -Math.abs(Number(sa.id) || 1), name: sa.username || sa.name || 'الإدارة', officeId: null, all: true };
}

/** شرط رؤية الحملات: الكل، أو حملات المكتب، أو (بلا مكتب) حملاته فقط. */
const scopeWhere = (a) => (a.all ? {} : a.officeId ? { officeId: a.officeId } : { createdById: a.id });

async function loadCampaign(a, id) {
  const c = await prisma.waCampaign.findFirst({ where: { id: Number(id), ...scopeWhere(a) } });
  if (!c) throw new AppError('الحملة غير موجودة', 404);
  return c;
}

const publicCampaign = (c, counts) => {
  const { templateSnapshot, varMap, ...rest } = c;
  let template = null; let vars = [];
  try { template = JSON.parse(templateSnapshot); } catch {}
  try { vars = JSON.parse(varMap); } catch {}
  return { ...rest, template, varMap: vars, counts: counts || null };
};

function buildRouter(getActor) {
  const r = express.Router();

  // القوالب + حدّ الرقم + عدد الموقوفين + السعر التقديري
  r.get('/meta', wrap(async (req, res) => {
    await getActor(req);
    let templates = []; let templatesError = null;
    try { templates = await svc.listTemplates({ fresh: req.query.fresh === '1' }); } catch (e) { templatesError = e.message; }
    const [phone, optOuts, cfg, marketingPrice] = await Promise.all([
      svc.phoneInfo(),
      prisma.waOptOut.count(),
      prisma.waBotConfig.findUnique({ where: { id: 1 }, select: { campaignMsgPrice: true } }),
      svc.marketingPrice(),
    ]);
    res.json({ success: true, templates, templatesError, phone, optOuts, price: cfg?.campaignMsgPrice ?? null, marketingPrice, maxRecipients: svc.MAX_RECIPIENTS });
  }));

  // إنشاء قالب في Meta من التطبيق (multipart: image اختيارية + data JSON)
  r.post('/templates', upload.single('image'), wrap(async (req, res) => {
    await getActor(req);
    let data = {};
    try { data = JSON.parse(req.body?.data || '{}'); } catch { throw new AppError('بيانات القالب تالفة', 400); }
    res.json({ success: true, ...(await svc.createTemplate(data, req.file || null)) });
  }));
  r.delete('/templates/:name', wrap(async (req, res) => {
    await getActor(req);
    await svc.deleteTemplate(req.params.name);
    res.json({ success: true });
  }));

  // الكلفة الفعلية كما تحسبها Meta (فواتير الحساب)
  r.get('/cost', wrap(async (req, res) => {
    await getActor(req);
    res.json({ success: true, ...(await svc.costReport(req.query.days)), rates: { marketing: svc.IQ_MARKETING_RATE, utility: svc.IQ_UTILITY_RATE } });
  }));

  r.put('/price', wrap(async (req, res) => {
    await getActor(req);
    const v = req.body?.price === '' || req.body?.price == null ? null : Number(req.body.price);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 5)) throw new AppError('سعر غير صالح', 400);
    await prisma.waBotConfig.upsert({ where: { id: 1 }, create: { id: 1, campaignMsgPrice: v }, update: { campaignMsgPrice: v } });
    res.json({ success: true, price: v });
  }));

  // ايتمات للاختيار: المكتب ⇒ ايتمات شركات مكتبه؛ السوبر أدمن ⇒ الكل
  r.get('/items', wrap(async (req, res) => {
    const a = await getActor(req);
    const q = String(req.query.q || '').trim();
    const where = { isTemp: false, scientificCompanyId: { not: null } };
    if (q) where.name = { contains: q, mode: 'insensitive' };
    if (!a.all) {
      if (!a.officeId) return res.json({ success: true, items: [] });
      where.scientificCompany = { is: { officeId: a.officeId } };
    }
    const items = await prisma.item.findMany({
      where, take: 40, orderBy: { name: 'asc' },
      select: { id: true, name: true, price: true, warehousePrice: true, imageUrl: true, scientificCompany: { select: { name: true } } },
    });
    res.json({ success: true, items: items.map(i => ({ id: i.id, name: i.name, price: i.price, warehousePrice: i.warehousePrice, hasImage: Boolean(i.imageUrl), company: i.scientificCompany?.name || null })) });
  }));

  // صورة رأس القالب ⇒ media id في واتساب
  r.post('/media', upload.single('image'), wrap(async (req, res) => {
    await getActor(req);
    if (!req.file) throw new AppError('لا يوجد ملف صورة', 400);
    res.json({ success: true, mediaId: await svc.uploadMedia(req.file.buffer, req.file.mimetype) });
  }));
  r.post('/media/item/:itemId', wrap(async (req, res) => {
    await getActor(req);
    res.json({ success: true, mediaId: await svc.uploadItemImage(req.params.itemId) });
  }));

  r.post('/optouts/check', wrap(async (req, res) => {
    await getActor(req);
    const ids = [...new Set((req.body?.waIds || []).map(normalizeWaId).filter(Boolean))].slice(0, 20000);
    const rows = ids.length ? await prisma.waOptOut.findMany({ where: { waId: { in: ids } }, select: { waId: true } }) : [];
    res.json({ success: true, optedOut: rows.map(x => x.waId) });
  }));
  r.get('/optouts', wrap(async (req, res) => {
    await getActor(req);
    const rows = await prisma.waOptOut.findMany({ orderBy: { createdAt: 'desc' }, take: 2000 });
    res.json({ success: true, optOuts: rows });
  }));
  r.post('/optouts', wrap(async (req, res) => {
    await getActor(req);
    const id = normalizeWaId(req.body?.waId);
    if (!/^\d{10,15}$/.test(id)) throw new AppError('رقم غير صالح', 400);
    await svc.addOptOut(id, 'manual');
    res.json({ success: true });
  }));
  r.delete('/optouts/:waId', wrap(async (req, res) => {
    await getActor(req);
    await prisma.waOptOut.deleteMany({ where: { waId: normalizeWaId(req.params.waId) } });
    res.json({ success: true });
  }));

  r.post('/test', wrap(async (req, res) => {
    const a = await getActor(req);
    res.json({ success: true, ...(await svc.sendTest(req.body || {}, { id: a.id, name: `${a.name} (تجربة حملة)` })) });
  }));

  r.get('/campaigns', wrap(async (req, res) => {
    const a = await getActor(req);
    const rows = await prisma.waCampaign.findMany({ where: scopeWhere(a), orderBy: { id: 'desc' }, take: 200 });
    const counts = await svc.campaignCounts(rows.map(c => c.id));
    res.json({ success: true, campaigns: rows.map(c => publicCampaign(c, counts.get(c.id))) });
  }));

  r.post('/campaigns', wrap(async (req, res) => {
    const a = await getActor(req);
    const recipients = svc.cleanRecipients(req.body?.recipients);
    if (!recipients.length) throw new AppError('لا توجد أرقام صالحة في القائمة', 400);
    if (recipients.length > svc.MAX_RECIPIENTS) throw new AppError(`الحد ${svc.MAX_RECIPIENTS} رقم للحملة الواحدة`, 400);
    const { data } = await svc.prepareCampaign(req.body || {});
    const opted = new Set((await prisma.waOptOut.findMany({ where: { waId: { in: recipients.map(x => x.waId) } }, select: { waId: true } })).map(x => x.waId));

    const c = await prisma.waCampaign.create({
      data: { ...data, total: recipients.length, createdById: a.id, createdByName: a.name, officeId: a.officeId },
    });
    for (let i = 0; i < recipients.length; i += 1000) {
      await prisma.waCampaignRecipient.createMany({
        data: recipients.slice(i, i + 1000).map(x => ({
          campaignId: c.id, ...x,
          ...(opted.has(x.waId) ? { status: 'skipped', error: 'طلب إيقاف العروض' } : {}),
        })),
        skipDuplicates: true,
      });
    }
    if (req.body?.start) {
      await prisma.waCampaign.update({ where: { id: c.id }, data: { status: 'sending', startedAt: new Date() } });
      svc.kickCampaign(c.id);
    }
    res.json({ success: true, id: c.id });
  }));

  r.get('/campaigns/:id', wrap(async (req, res) => {
    const a = await getActor(req);
    const c = await loadCampaign(a, req.params.id);
    const where = { campaignId: c.id };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.reply === 'any') where.reply = { not: null };
    else if (req.query.reply) where.reply = String(req.query.reply);
    const [recipients, counts] = await Promise.all([
      prisma.waCampaignRecipient.findMany({ where, orderBy: [{ repliedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], take: 1000 }),
      svc.campaignCounts([c.id]),
    ]);
    res.json({ success: true, campaign: publicCampaign(c, counts.get(c.id)), recipients: recipients.map(x => ({ ...x, extra: undefined })) });
  }));

  r.get('/campaigns/:id/image', wrap(async (req, res) => {
    const a = await getActor(req);
    const buf = await svc.campaignImage(await loadCampaign(a, req.params.id));
    res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(buf);
  }));

  r.post('/campaigns/:id/:action(start|pause|cancel)', wrap(async (req, res) => {
    const a = await getActor(req);
    const c = await loadCampaign(a, req.params.id);
    const action = req.params.action;
    if (action === 'start') {
      if (!['draft', 'paused'].includes(c.status)) throw new AppError('لا يمكن تشغيل هذه الحملة', 400);
      await prisma.waCampaign.update({ where: { id: c.id }, data: { status: 'sending', lastError: null, startedAt: c.startedAt || new Date() } });
      svc.kickCampaign(c.id);
    } else if (action === 'pause') {
      if (c.status !== 'sending') throw new AppError('الحملة ليست قيد الإرسال', 400);
      await prisma.waCampaign.update({ where: { id: c.id }, data: { status: 'paused' } });
    } else {
      if (!['draft', 'sending', 'paused'].includes(c.status)) throw new AppError('الحملة منتهية', 400);
      await prisma.waCampaign.update({ where: { id: c.id }, data: { status: 'cancelled', finishedAt: new Date() } });
      await prisma.waCampaignRecipient.updateMany({ where: { campaignId: c.id, status: 'pending' }, data: { status: 'skipped', error: 'أُلغيت الحملة' } });
    }
    res.json({ success: true });
  }));

  r.delete('/campaigns/:id', wrap(async (req, res) => {
    const a = await getActor(req);
    const c = await loadCampaign(a, req.params.id);
    if (c.status === 'sending') throw new AppError('أوقف الحملة أولاً', 400);
    await prisma.waCampaign.delete({ where: { id: c.id } });
    res.json({ success: true });
  }));

  return r;
}

export const appRouter = express.Router();
appRouter.use(requireAuth);
appRouter.use(buildRouter(appActor));

export const saRouter = express.Router();
saRouter.use(requireMasterAdmin);
saRouter.use(buildRouter(async (req) => saActor(req)));
