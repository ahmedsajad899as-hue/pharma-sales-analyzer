// ════════════════════════════════════════════════════════════════════════════
// orders.controller.js — واجهة HTTP لطابور طلبيات البوت. كل معالج مقيَّد بـ
// req.user.id؛ لا نقطة هنا تقبل userId من العميل.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import prisma from '../../lib/prisma.js';
import { recordLessons, recordCorrectionCase } from '../../lib/orderLearning.js';
import {
  listPendingOrders, getPendingOrder, deletePendingOrder,
  countVisiblePendingOrders, getPendingOrderImagePath, listOfficeScientificReps,
  refreshReviewRow, catalogSuggestions,
} from './orders.service.js';

// ── POST /api/orders/refresh-row — إعادة تخمين صفّ بعد تغيير مادته/منطقته ────
export async function refreshRow(req, res, next) {
  try {
    const changed = req.body?.changed === 'item' ? 'item' : 'area';
    res.json({ success: true, data: await refreshReviewRow(req.user.id, { row: req.body?.row || {}, changed }) });
  } catch (e) { next(e); }
}

// ── GET /api/orders/catalog-suggest — اقتراحات المادة/الشركة/المنطقة ─────────
export async function catalogSuggest(req, res, next) {
  try {
    res.json({ success: true, data: await catalogSuggestions(req.user.id) });
  } catch (e) { next(e); }
}

// ── GET /api/orders/pending — قائمة خفيفة للشريط (بلا صفوف الطلبية) ─────────
export async function listPending(req, res, next) {
  try {
    res.json({ success: true, data: await listPendingOrders(req.user.id) });
  } catch (e) { next(e); }
}

// ── GET /api/orders/pending/count — نداء count وحده، هذا ما يستجوبه الاستقصاء ──
export async function getPendingCount(req, res, next) {
  try {
    res.json({ success: true, data: { count: await countVisiblePendingOrders(req.user.id) } });
  } catch (e) { next(e); }
}

// ── GET /api/orders/pending/:id — طلبية واحدة مُسطَّحة لشبكة المراجعة ────────
export async function getPending(req, res, next) {
  try {
    res.json({ success: true, data: await getPendingOrder(req.user.id, req.params.id) });
  } catch (e) { next(e); }
}

// ── GET /api/orders/pending/:id/image/:idx ──────────────────────────────────
// بثّ من القرص بعد فحص الملكية. عمداً ليس عبر مسار /uploads الساكن: ذاك مُركَّب
// فوق بوابة JWT في server/index.js فيجعل كل صورة فاتورة مقروءة للعالم بالرابط.
export async function getPendingImage(req, res, next) {
  try {
    const filePath = await getPendingOrderImagePath(req.user.id, req.params.id, req.params.idx);
    res.type(filePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ success: false, error: 'الصورة غير موجودة.' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (e) { next(e); }
}

// ── DELETE /api/orders/pending/:id — إلغاء بلا حفظ ──────────────────────────
export async function deletePending(req, res, next) {
  try {
    await deletePendingOrder(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── GET /api/orders/scientific-reps — خيارات خانة المندوب العلمي في المراجعة ──
export async function listScientificReps(req, res, next) {
  try {
    res.json({ success: true, data: await listOfficeScientificReps(req.user.id) });
  } catch (e) { next(e); }
}

// ── POST /api/orders/learn — ذاكرة التصحيحات بعد حفظ طلبية بوت ────────────────
// best-effort من الواجهة بعد نجاح الحفظ: الدروس (منطقة/صيدلية/مذخر/مندوب) +
// «رسالة صحّحها المراجعون» حين تغيّرت الأسطر أو الكميات. راجع lib/orderLearning.js.
export async function learnFromReview(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, username: true, displayName: true } });
    if (!user) return res.status(401).json({ success: false, error: 'غير مصرّح' });
    const lessons = await recordLessons(user, req.body?.corrections);
    const kase = await recordCorrectionCase(user, req.body?.case);
    res.json({ success: true, data: { ...lessons, caseId: kase?.id ?? null } });
  } catch (e) { next(e); }
}
