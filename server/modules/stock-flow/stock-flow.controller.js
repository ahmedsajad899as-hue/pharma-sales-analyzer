/**
 * Stock Flow Controller — طبقة HTTP رفيعة لصفحة «تحريك المذاخر».
 * المصادقة موروثة من بوابة app.use('/api', requireAuth) في server/index.js.
 * نطاق القراءة/الكتابة (دفتر المكتب المشترك) من نفس lib/stockLedgerScope.js
 * المستخدم في «رصيد المذاخر» — هوية مذخر/ايتم واحدة، دفتر واحد، بلا نسخ متباعدة.
 */

import { resolveLedgerScope } from '../../lib/stockLedgerScope.js';
import { saveWarehouseNameLinks, saveItemLinks, saveStockCompanyNameLinks } from '../stock-ledger/stock-ledger.service.js';
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

const saveNameChoices = (userId, body) => Promise.all([
  saveWarehouseNameLinks(userId, body?.warehouseChoices),
  saveItemLinks(userId, body?.itemChoices),
  saveStockCompanyNameLinks(userId, body?.companyChoices),
]);

// ─── الدورات ──────────────────────────────────────────────────
export async function listCycles(req, res) {
  try {
    const { readIds } = await resolveLedgerScope(req.user);
    const data = await service.buildCycles(readIds);
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
}

// ─── نقاط العدّ (الستوك الافتتاحي/الثانوي) ────────────────────
export async function listCounts(req, res) {
  try {
    const warehouseId = parseInt(req.query?.warehouseId, 10);
    if (!Number.isInteger(warehouseId)) return res.status(400).json({ success: false, error: 'اختر مذخر' });
    const { readIds } = await resolveLedgerScope(req.user);
    const rows = await service.listCountsForWarehouse(readIds, warehouseId);
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
}

/** معاينة تطابق ملف Excel طولي (مذخر/ايتم/كمية) مرفوع للستوك — قبل الحفظ */
export async function extractCountsUpload(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع ملف' });
    const countDate = toDate(req.body?.countDate);
    const { rows, skipped } = service.parseLongFormatFile(req.file.buffer, countDate);
    if (!rows.length) return res.status(422).json({ success: false, error: 'لا توجد صفوف صالحة — تأكد من وجود أعمدة المذخر والايتم والكمية' });
    const { writeId } = await resolveLedgerScope(req.user);
    const { pending, mercato } = await service.classifyRows(rows, writeId);
    const lean = rows.map(({ rawRow, ...r }) => r);
    res.json({ success: true, data: { rows: lean, pending, mercato, skipped, fileName: utf8Name(req.file) } });
  } catch (err) { fail(res, err, 400); }
}

/** حفظ ستوك مرفوع كملف Excel طولي بعد تأكيد الأسماء المشكوك فيها */
export async function commitCountsUpload(req, res) {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'لا توجد صفوف' });
    const { writeId } = await resolveLedgerScope(req.user);
    await saveNameChoices(writeId, req.body);
    const countDate = toDate(req.body?.countDate);
    const result = await service.ingestStockCountRows({ writeId, countDate, rows });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

/** معاينة تطابق ستوك مُشتق من ملف Stock محفوظ سلفاً (صفحة «ستوك المذاخر») */
export async function extractCountsFromStockFile(req, res) {
  try {
    const salesDataFileId = parseInt(req.body?.salesDataFileId, 10);
    if (!Number.isInteger(salesDataFileId)) return res.status(400).json({ success: false, error: 'اختر ملف ستوك' });
    const { rows } = await service.readExistingStockFile(req.user.id, salesDataFileId);
    const { writeId } = await resolveLedgerScope(req.user);
    const { pending, mercato } = await service.classifyRows(rows, writeId);
    res.json({ success: true, data: { pending, mercato } });
  } catch (err) { fail(res, err, 400); }
}

/** حفظ ستوك مُشتق من ملف Stock محفوظ سلفاً بعد تأكيد الأسماء المشكوك فيها */
export async function commitCountsFromStockFile(req, res) {
  try {
    const salesDataFileId = parseInt(req.body?.salesDataFileId, 10);
    if (!Number.isInteger(salesDataFileId)) return res.status(400).json({ success: false, error: 'اختر ملف ستوك' });
    const { writeId } = await resolveLedgerScope(req.user);
    await saveNameChoices(writeId, req.body);
    const { rows } = await service.readExistingStockFile(req.user.id, salesDataFileId);
    const countDate = toDate(req.body?.countDate);
    const result = await service.ingestStockCountRows({ writeId, countDate, rows });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

/** إدخال يدوي سريع لزوج واحد (مذخر + ايتم) بلا ملف */
export async function manualCountHandler(req, res) {
  try {
    const warehouseId = parseInt(req.body?.warehouseId, 10);
    const qty = Number(req.body?.qty);
    if (!Number.isInteger(warehouseId)) return res.status(400).json({ success: false, error: 'اختر مذخر' });
    if (!(qty >= 0)) return res.status(400).json({ success: false, error: 'كمية غير صالحة' });
    const { writeId } = await resolveLedgerScope(req.user);
    const countDate = toDate(req.body?.countDate);
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const row = await service.manualCount({ writeId, warehouseId, itemName: req.body?.itemName, countDate, qty, note });
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

    const asOfDate = toDate(req.body?.asOfDate);
    const { rows, skipped } = service.parseLongFormatFile(req.file.buffer, asOfDate);
    if (!rows.length) {
      return res.status(422).json({ success: false, error: 'لا توجد صفوف صالحة — تأكد من وجود أعمدة المذخر والايتم والكمية' });
    }
    const { writeId } = await resolveLedgerScope(req.user);
    const { pending, mercato } = await service.classifyRows(rows, writeId);
    const lean = rows.map(({ rawRow, ...r }) => r);
    res.json({ success: true, data: { rows: lean, pending, mercato, skipped, fileName: utf8Name(req.file) } });
  } catch (err) { fail(res, err, 400); }
}

/** حفظ ملف مبيعات فريق بعد تأكيد أسماء المذاخر/الايتمات المشكوك فيها (أو مباشرة إن لم توجد) */
export async function commitTeamSalesHandler(req, res) {
  try {
    const team = String(req.body?.team || '');
    if (!service.TEAMS.has(team)) return res.status(400).json({ success: false, error: 'اختر الفريق' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'لا توجد صفوف' });

    const { writeId } = await resolveLedgerScope(req.user);
    await saveNameChoices(writeId, req.body);
    const asOfDate = toDate(req.body?.asOfDate);
    const fileName = String(req.body?.fileName || '').trim() || null;
    const result = await service.ingestTeamSaleRows({ writeId, team, asOfDate, rows, sourceLabel: fileName });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

/** إدخال يدوي لزوج واحد (مذخر + ايتم) بلا ملف — تصحيح سريع */
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
    const row = await service.manualTeamSale({ writeId, warehouseId, itemName: req.body?.itemName, asOfDate, team, qty });
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
