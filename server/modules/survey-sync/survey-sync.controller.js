// ════════════════════════════════════════════════════════════════════════════
// survey-sync.controller.js — واجهات HTTP لدورة تحديث السيرفي
// ────────────────────────────────────────────────────────────────────────────
// مجموعتان فوق نفس الخدمة:
//   sa*  — لوحة السوبر أدمن (خلف requireMasterAdmin في survey-admin.routes.js)
//   rep* — المندوب/المدير (خلف requireAuth في master-survey.routes.js)
// المندوب يصدّر نطاقه ويرفع ملفه فقط؛ لا يملك أي مسار يكتب على السيرفي —
// المراجعة والاعتماد والتطبيق كلها للسوبر أدمن وحده.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { isSyncType } from '../../lib/surveySync.js';
import * as svc from './survey-sync.service.js';

function fail(res, e) {
  const status = e?.status ?? 500;
  return res.status(status).json({ success: false, error: e?.message || 'خطأ غير متوقع' });
}
function readType(req) {
  const t = req.params.entryType ?? req.body?.entryType ?? req.query?.entryType;
  return isSyncType(t) ? t : null;
}

// ════════════════════════════ السوبر أدمن ════════════════════════════

// GET /:id/:entryType/export?userId=&areaNames=أ,ب
export async function saExport(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryType = readType(req);
    if (!entryType) return res.status(400).json({ success: false, error: 'نوع غير معروف' });

    let forUser = null;
    if (req.query.userId) {
      forUser = await prisma.user.findUnique({
        where: { id: parseInt(req.query.userId) },
        select: { id: true, role: true, username: true, displayName: true },
      });
      if (!forUser) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }
    const areaNames = req.query.areaNames
      ? String(req.query.areaNames).split(',').map(s => s.trim()).filter(Boolean)
      : null;

    const out = await svc.createExport({ surveyId, entryType, forUser, areaNames, createdById: null });
    svc.pruneOldExports().catch(() => {}); // تنظيف بالخلفية — لا يؤخّر التصدير
    res.json({ success: true, data: { ...out, forUser } });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// POST /:id/sync/analyze  { entryType, fileName, token, rows }
export async function saAnalyze(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryType = readType(req);
    if (!entryType) return res.status(400).json({ success: false, error: 'نوع غير معروف' });
    const { fileName, token, rows } = req.body;
    const out = await svc.analyzeUpload({
      surveyId, entryType, fileName, token, rows,
      uploadedById: req.body.uploadedById ? parseInt(req.body.uploadedById) : null,
    });
    res.status(201).json({ success: true, data: out });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// GET /:id/sync/batches
export async function saListBatches(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const data = await svc.listBatches({
      surveyId,
      status: req.query.status || null,
      limit: req.query.limit ? parseInt(req.query.limit) : 50,
    });
    res.json({ success: true, data });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// GET /sync/batches/:batchId
export async function saGetBatch(req, res, next) {
  try {
    const data = await svc.getBatch(parseInt(req.params.batchId), {
      changeType: req.query.changeType || null,
      page: req.query.page ? parseInt(req.query.page) : 1,
      limit: req.query.limit ? parseInt(req.query.limit) : 200,
    });
    if (!data) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    res.json({ success: true, data });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// PATCH /sync/rows/:rowId  { decision, targetEntryId? }
export async function saDecideRow(req, res, next) {
  try {
    const { decision, targetEntryId } = req.body;
    const row = await svc.decideRow(parseInt(req.params.rowId), {
      decision, targetEntryId, decidedById: null,
    });
    if (!row) return res.status(404).json({ success: false, error: 'الصف غير موجود' });
    res.json({ success: true, data: row });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// POST /sync/batches/:batchId/decide-bulk  { changeType, decision }
export async function saDecideBulk(req, res, next) {
  try {
    const { changeType, decision } = req.body;
    const out = await svc.decideBulk(parseInt(req.params.batchId), { changeType, decision, decidedById: null });
    if (!out) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    res.json({ success: true, data: out });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// POST /sync/batches/:batchId/apply
export async function saApply(req, res, next) {
  try {
    const out = await svc.applyBatch(parseInt(req.params.batchId), { decidedById: null });
    if (!out) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    res.json({ success: true, data: out });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// DELETE /sync/batches/:batchId
export async function saDiscard(req, res, next) {
  try {
    const out = await svc.discardBatch(parseInt(req.params.batchId));
    if (!out) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    res.json({ success: true });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// ════════════════════════════ المندوب / المدير ════════════════════════════

// GET /:id/sync/:entryType/export — نطاق المستخدم وحده
export async function repExport(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryType = readType(req);
    if (!entryType) return res.status(400).json({ success: false, error: 'نوع غير معروف' });

    const out = await svc.createExport({
      surveyId, entryType,
      forUser: { id: req.user.id, role: req.user.role },
      createdById: req.user.id,
    });
    res.json({ success: true, data: out });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// POST /:id/sync/upload  { entryType, fileName, token, rows }
// لا يكتب على السيرفي إطلاقاً — ينشئ دفعة بانتظار مراجعة السوبر أدمن.
export async function repUpload(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const entryType = readType(req);
    if (!entryType) return res.status(400).json({ success: false, error: 'نوع غير معروف' });
    const { fileName, token, rows } = req.body;
    const out = await svc.analyzeUpload({
      surveyId, entryType, fileName, token, rows, uploadedById: req.user.id,
    });
    res.status(201).json({ success: true, data: out });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}

// GET /:id/sync/my-batches — حالة ما رفعه هذا المستخدم
export async function repMyBatches(req, res, next) {
  try {
    const surveyId = parseInt(req.params.id);
    const data = await svc.listBatches({ surveyId, uploadedById: req.user.id, limit: 20 });
    res.json({ success: true, data });
  } catch (e) { if (e.status) return fail(res, e); next(e); }
}
