/**
 * Stock Ledger Controller — طبقة HTTP رفيعة لدفتر رصيد المذاخر.
 */

import {
  parseMovementFile, ingestRows, ingestBaselineFromStockFile,
  buildAlerts, removeBatch, recomputeBalances,
  classifyMovementRows, classifyBaselineFromStockFile,
  saveWarehouseNameLinks, saveItemLinks, saveStockCompanyNameLinks,
} from './stock-ledger.service.js';
import {
  getWarehouses, getBatches, getBalances, getPairHistory, prisma,
} from './stock-ledger.repository.js';

const utf8Name = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

/** تاريخ سريان الدفعة — يقبل ISO أو yyyy-mm-dd، وإلا اليوم */
function toDate(v) {
  if (!v) return new Date();
  const d = new Date(v);
  return isFinite(d.getTime()) ? d : new Date();
}

const fail = (res, err, code = 500) => {
  console.error('[stock-ledger]', err);
  res.status(code).json({ success: false, error: err.message || String(err) });
};

// ─── المذاخر والدفعات ─────────────────────────────────────────
export async function listWarehouses(req, res) {
  try {
    const warehouses = await getWarehouses(req.user.id);
    const regions = [...new Set(warehouses.map(w => w.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
    res.json({ success: true, data: { warehouses, regions } });
  } catch (err) { fail(res, err); }
}

export async function listBatches(req, res) {
  try {
    const batches = await getBatches(req.user.id);
    res.json({
      success: true,
      data: batches.map(b => ({
        ...b,
        unmatched: b.unmatched ? JSON.parse(b.unmatched) : null,
      })),
    });
  } catch (err) { fail(res, err); }
}

export async function deleteBatchHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'معرّف غير صالح' });
    await removeBatch(req.user.id, id);
    res.json({ success: true });
  } catch (err) { fail(res, err, /غير موجودة/.test(err.message) ? 404 : 500); }
}

// ─── الأرصدة ──────────────────────────────────────────────────
export async function listBalances(req, res) {
  try {
    const rows = await getBalances(req.user.id);
    res.json({
      success: true,
      data: rows.map(b => ({
        warehouseId: b.warehouseId,
        warehouse: b.warehouse.name,
        region: b.warehouse.region,
        itemKey: b.itemKey,
        itemName: b.itemName,
        companyName: b.companyName,
        opening: b.opening,
        openingAt: b.openingAt,
        inQty: b.inQty,
        outQty: b.outQty,
        remaining: b.remaining,
        pctLeft: b.opening > 0 ? Math.round((b.remaining / b.opening) * 100) : null,
        lastMovementAt: b.lastMovementAt,
      })),
    });
  } catch (err) { fail(res, err); }
}

export async function listAlerts(req, res) {
  try {
    const pct = Math.max(0, Math.min(100, Number(req.query.pct ?? 20)));
    const qty = Math.max(0, Number(req.query.qty ?? 10));
    const region = req.query.region || null;
    const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null;
    const data = await buildAlerts(req.user.id, { pct, qty, region, warehouseId });
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
}

export async function pairHistory(req, res) {
  try {
    const warehouseId = parseInt(req.params.id, 10);
    const itemKey = String(req.query.itemKey || '');
    if (!Number.isInteger(warehouseId) || !itemKey) {
      return res.status(400).json({ success: false, error: 'معطيات ناقصة' });
    }
    const rows = await getPairHistory({ userId: req.user.id, warehouseId, itemKey });
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
}

// ─── الستوك الافتتاحي ─────────────────────────────────────────
/** قائمة ملفات Stock المتاحة للاستيراد منها (SalesDataFile) */
export async function listStockFiles(req, res) {
  try {
    const files = await prisma.salesDataFile.findMany({
      where: { userId: req.user.id },
      select: { id: true, name: true, uploadedAt: true },
      orderBy: { uploadedAt: 'desc' },
    });
    res.json({ success: true, data: files });
  } catch (err) { fail(res, err); }
}

/** معاينة تطابق الستوك الافتتاحي من ملف Stock موجود — قبل الحفظ */
export async function extractBaselineFromStockFile(req, res) {
  try {
    const salesDataFileId = parseInt(req.body?.salesDataFileId, 10);
    if (!Number.isInteger(salesDataFileId)) {
      return res.status(400).json({ success: false, error: 'اختر ملف ستوك' });
    }
    const result = await classifyBaselineFromStockFile({ userId: req.user.id, salesDataFileId });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

const saveNameChoices = (userId, body) => Promise.all([
  saveWarehouseNameLinks(userId, body?.warehouseChoices),
  saveItemLinks(userId, body?.itemChoices),
  saveStockCompanyNameLinks(userId, body?.companyChoices),
]);

export async function baselineFromStockFile(req, res) {
  try {
    const salesDataFileId = parseInt(req.body?.salesDataFileId, 10);
    if (!Number.isInteger(salesDataFileId)) {
      return res.status(400).json({ success: false, error: 'اختر ملف ستوك' });
    }
    await saveNameChoices(req.user.id, req.body);
    const result = await ingestBaselineFromStockFile({
      userId: req.user.id,
      salesDataFileId,
      movementDate: toDate(req.body?.movementDate),
    });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

// ─── رفع ملفات الحركات (وكذلك ستوك افتتاحي بصيغة طولية) ────────
/** معاينة تطابق ملف حركة/ستوك افتتاحي مرفوع — قبل الحفظ، لا يُنشئ أي شيء */
export async function extractMovements(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع ملف' });
    const kind = String(req.body?.kind || 'out');
    if (!['baseline', 'in', 'out'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'نوع الدفعة غير صالح' });
    }
    const movementDate = toDate(req.body?.movementDate);
    const originalName = utf8Name(req.file);
    const { rows, colMap, skipped } = parseMovementFile(req.file.buffer, movementDate);
    if (!rows.length) {
      return res.status(422).json({
        success: false,
        error: 'لا توجد صفوف صالحة — تأكد من وجود أعمدة المذخر والايتم والكمية',
        colMap,
      });
    }
    const { pending } = await classifyMovementRows({ rows, userId: req.user.id });
    // rawRow غير مُستعمل في أي شاشة — يُسقَط من صفوف الذهاب والإياب بين الاستخراج
    // والحفظ لتخفيف حِمل الشبكة (قد تبلغ الملفات آلاف الأسطر).
    const lean = rows.map(({ rawRow, ...r }) => r);
    res.json({ success: true, data: { rows: lean, colMap, skipped, pending, kind, fileName: originalName } });
  } catch (err) { fail(res, err, 400); }
}

/** حفظ ملف حركة/ستوك افتتاحي بعد تأكيد المستخدم للأسماء المشكوك فيها (أو مباشرة إن لم توجد) */
export async function commitMovements(req, res) {
  try {
    const kind = String(req.body?.kind || 'out');
    if (!['baseline', 'in', 'out'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'نوع الدفعة غير صالح' });
    }
    const rows = (Array.isArray(req.body?.rows) ? req.body.rows : [])
      .map(r => ({ ...r, movementDate: r?.movementDate ? toDate(r.movementDate) : undefined }));
    if (!rows.length) return res.status(400).json({ success: false, error: 'لا توجد صفوف' });

    await saveNameChoices(req.user.id, req.body);

    const label = { baseline: 'ستوك افتتاحي', in: 'تعزيز', out: 'مبيع من المذاخر' }[kind];
    const fileName = String(req.body?.fileName || '').trim();
    const result = await ingestRows({
      userId: req.user.id,
      kind,
      name: label + (fileName ? ': ' + fileName : ''),
      movementDate: toDate(req.body?.movementDate),
      rows,
    });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

// ─── رفع مباشر (بلا معاينة) — يبقى للتوافق مع أي مسار برمجي آخر ────
export async function uploadMovements(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع ملف' });
    const kind = String(req.body?.kind || 'out');
    if (!['baseline', 'in', 'out'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'نوع الدفعة غير صالح' });
    }
    const movementDate = toDate(req.body?.movementDate);
    const originalName = utf8Name(req.file);
    const { rows, colMap, skipped } = parseMovementFile(req.file.buffer, movementDate);
    if (!rows.length) {
      return res.status(422).json({
        success: false,
        error: 'لا توجد صفوف صالحة — تأكد من وجود أعمدة المذخر والايتم والكمية',
        colMap,
      });
    }
    const label = { baseline: 'ستوك افتتاحي', in: 'تعزيز', out: 'مبيع من المذاخر' }[kind];
    const result = await ingestRows({
      userId: req.user.id,
      kind,
      name: label + ': ' + originalName,
      movementDate,
      rows,
    });
    res.json({ success: true, data: { ...result, skipped, colMap } });
  } catch (err) { fail(res, err, 400); }
}

// ─── إدخال حركة يدوية ─────────────────────────────────────────
export async function manualMovements(req, res) {
  try {
    const kind = String(req.body?.kind || 'out');
    if (!['baseline', 'in', 'out'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'نوع الحركة غير صالح' });
    }
    const movementDate = toDate(req.body?.movementDate);
    const rows = (Array.isArray(req.body?.rows) ? req.body.rows : [])
      .map(r => ({
        warehouse: String(r.warehouse ?? '').trim(),
        region: String(r.region ?? '').trim(),
        itemName: String(r.itemName ?? '').trim(),
        companyName: String(r.companyName ?? '').trim() || null,
        qty: Math.abs(Number(r.qty) || 0),
        movementDate: r.movementDate ? toDate(r.movementDate) : movementDate,
        rawRow: { source: 'manual' },
      }))
      .filter(r => r.warehouse && r.itemName && r.qty > 0);

    if (!rows.length) return res.status(400).json({ success: false, error: 'لا توجد أسطر صالحة' });

    const label = { baseline: 'ستوك افتتاحي', in: 'تعزيز', out: 'مبيع من المذاخر' }[kind];
    const result = await ingestRows({
      userId: req.user.id,
      kind,
      name: label + ' (إدخال يدوي)',
      movementDate,
      rows,
    });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

// ─── إعادة حساب يدوية (زر صيانة) ──────────────────────────────
export async function recompute(req, res) {
  try {
    const count = await recomputeBalances(req.user.id);
    res.json({ success: true, data: { pairs: count } });
  } catch (err) { fail(res, err); }
}
