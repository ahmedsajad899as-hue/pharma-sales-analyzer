/**
 * Stock Flow Controller — طبقة HTTP رفيعة لصفحة «تحريك المذاخر».
 * المصادقة موروثة من بوابة app.use('/api', requireAuth) في server/index.js.
 * نطاق القراءة/الكتابة (دفتر المكتب المشترك) من نفس lib/stockLedgerScope.js
 * المستخدم في «رصيد المذاخر» — هوية مذخر واحدة، دفتر واحد، بلا نسخ متباعدة.
 */

import { resolveLedgerScope } from '../../lib/stockLedgerScope.js';
import { saveWarehouseNameLinks } from '../stock-ledger/stock-ledger.service.js';
import * as service from './stock-flow.service.js';

const utf8Name = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

const fail = (res, err, code = 500) => {
  console.error('[stock-flow]', err);
  res.status(code).json({ success: false, error: err.message || String(err) });
};

function toDate(v) {
  if (!v) return new Date();
  const d = new Date(v);
  return isFinite(d.getTime()) ? d : new Date();
}

// ─── الدورات ──────────────────────────────────────────────────
export async function listCycles(req, res) {
  try {
    const { readIds } = await resolveLedgerScope(req.user);
    const data = await service.buildCycles(readIds);
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
}

// ─── نقاط العدّ ───────────────────────────────────────────────
export async function listCounts(req, res) {
  try {
    const warehouseId = parseInt(req.query?.warehouseId, 10);
    if (!Number.isInteger(warehouseId)) return res.status(400).json({ success: false, error: 'اختر مذخر' });
    const { readIds } = await resolveLedgerScope(req.user);
    const rows = await service.listCountsForWarehouse(readIds, warehouseId);
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
}

export async function addCount(req, res) {
  try {
    const warehouseId = parseInt(req.body?.warehouseId, 10);
    const qty = Number(req.body?.qty);
    if (!Number.isInteger(warehouseId)) return res.status(400).json({ success: false, error: 'اختر مذخر' });
    if (!(qty >= 0)) return res.status(400).json({ success: false, error: 'كمية غير صالحة' });
    const { writeId } = await resolveLedgerScope(req.user);
    const countDate = toDate(req.body?.countDate);
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const row = await service.upsertCount({ writeId, warehouseId, countDate, qty, note });
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err, 400); }
}

export async function deleteCountHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'معرّف غير صالح' });
    const { readIds } = await resolveLedgerScope(req.user);
    await service.removeCount(id, readIds);
    res.json({ success: true });
  } catch (err) { fail(res, err, /غير موجود/.test(err.message) ? 404 : 500); }
}

// ─── مبيعات الفرق ─────────────────────────────────────────────
/** معاينة تطابق ملف مبيعات فريق مرفوع — قبل الحفظ، لا يُنشئ أي شيء */
export async function extractTeamSales(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع ملف' });
    const team = String(req.body?.team || '');
    if (!service.TEAMS.has(team)) return res.status(400).json({ success: false, error: 'اختر الفريق' });

    const { rows, warnings, skipped } = service.parseTeamSalesFile(req.file.buffer);
    if (!rows.length) {
      return res.status(422).json({ success: false, error: warnings?.[0] || 'لا توجد صفوف صالحة — تأكد من عمودي المذخر والكمية' });
    }
    const { writeId } = await resolveLedgerScope(req.user);
    const { pending } = await service.classifyTeamSalesRows(rows, writeId);
    // شكل PendingMatches نفسه المستعمَل في StockMovementImportModal (رصيد المذاخر) —
    // إعادة استعمال المكوّن نفسه بلا أي تعديل عليه؛ لا ايتمات ولا شركات في ملف الفرق.
    const pendingMatches = { warehouses: pending, items: [], companies: [] };
    res.json({ success: true, data: { rows, pending: pendingMatches, skipped, fileName: utf8Name(req.file) } });
  } catch (err) { fail(res, err, 400); }
}

/** حفظ ملف مبيعات فريق بعد تأكيد أسماء المذاخر المشكوك فيها (أو مباشرة إن لم توجد) */
export async function commitTeamSalesHandler(req, res) {
  try {
    const team = String(req.body?.team || '');
    if (!service.TEAMS.has(team)) return res.status(400).json({ success: false, error: 'اختر الفريق' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'لا توجد صفوف' });

    const { writeId } = await resolveLedgerScope(req.user);
    if (Array.isArray(req.body?.warehouseChoices) && req.body.warehouseChoices.length) {
      await saveWarehouseNameLinks(writeId, req.body.warehouseChoices);
    }
    const asOfDate = toDate(req.body?.asOfDate);
    const fileName = String(req.body?.fileName || '').trim() || null;
    const result = await service.commitTeamSales({ writeId, team, asOfDate, rows, sourceLabel: fileName });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

/** إدخال يدوي لمذخر واحد بلا ملف — تصحيح سريع */
export async function manualTeamSalesHandler(req, res) {
  try {
    const team = String(req.body?.team || '');
    if (!service.TEAMS.has(team)) return res.status(400).json({ success: false, error: 'اختر الفريق' });
    const warehouseId = parseInt(req.body?.warehouseId, 10);
    const qty = Number(req.body?.qty);
    if (!Number.isInteger(warehouseId)) return res.status(400).json({ success: false, error: 'اختر مذخر' });
    if (!(qty >= 0)) return res.status(400).json({ success: false, error: 'كمية غير صالحة' });

    const { writeId } = await resolveLedgerScope(req.user);
    const asOfDate = toDate(req.body?.asOfDate);
    const row = await service.upsertTeamSale({ writeId, warehouseId, asOfDate, team, qty });
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err, 400); }
}

export async function deleteTeamSaleHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'معرّف غير صالح' });
    const { readIds } = await resolveLedgerScope(req.user);
    await service.removeTeamSale(id, readIds);
    res.json({ success: true });
  } catch (err) { fail(res, err, /غير موجود/.test(err.message) ? 404 : 500); }
}
