/**
 * Stock Ledger Controller — طبقة HTTP رفيعة لدفتر رصيد المذاخر.
 */

import {
  parseMovementFile, ingestRows, ingestBaselineFromStockFile,
  buildAlerts, removeBatch, recomputeBalances, resolveBalanceTeams,
  classifyMovementRows, classifyBaselineFromStockFile,
  saveWarehouseNameLinks, saveItemLinks, saveStockCompanyNameLinks,
} from './stock-ledger.service.js';
import {
  getWarehouses, getBatches, getBatchById, getBalances, getPairHistory, prisma,
} from './stock-ledger.repository.js';
import { resolveStockScope, makeBalanceScopeFilter } from '../../lib/stockScope.js';
import { resolveLedgerScope } from '../../lib/stockLedgerScope.js';

const utf8Name = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

// دفتر واحد للمكتب: مدير المكتب / HR / مدير الشركة يقرؤون دفتر موظف المكتب
// مباشرةً ويكتبون فيه (writeId) — لا نسخ لكل حساب. كان الرفع يُعمَّم بإعادة
// الاستيعاب في حساب كل مدير (نسخة مستقلة لكل حساب) فتباعدت النسخ وظهرت أرقام
// مختلفة لنفس المذاخر بين الحسابات — راجع lib/stockLedgerScope.js لتفصيل السبب.
// كل ما يخصّ المطابقة عند الاستيعاب (مذاخر، روابط أسماء المذاخر/الشركات، كتالوج
// الشركات، تكرار طلبيات ميركاتو) يُقرأ ويُحفظ بدفتر الكتابة لا بحساب الرافع.

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
    const { readIds } = await resolveLedgerScope(req.user);
    const warehouses = await getWarehouses(readIds);
    const regions = [...new Set(warehouses.map(w => w.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
    res.json({ success: true, data: { warehouses, regions } });
  } catch (err) { fail(res, err); }
}

export async function listBatches(req, res) {
  try {
    const { readIds, viewer, ownerName } = await resolveLedgerScope(req.user);
    const batches = await getBatches(readIds);
    res.json({
      success: true,
      data: batches.map(b => ({
        ...b,
        unmatched: b.unmatched ? JSON.parse(b.unmatched) : null,
        own: b.userId === req.user.id,
        // اسم صاحب الدفتر — للناظر على دفتر غيره فقط (موظف المكتب يرى دفعاته هو وحدها)
        ownerName: viewer ? (ownerName.get(b.userId) ?? null) : null,
      })),
    });
  } catch (err) { fail(res, err); }
}

/** حذف دفعة — من أي دفتر يقرؤه المستخدم (المدير يحذف رفعة خاطئة من دفتر المكتب) */
export async function deleteBatchHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'معرّف غير صالح' });
    const { readIds } = await resolveLedgerScope(req.user);
    const batch = await getBatchById(id, readIds);
    if (!batch) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    await removeBatch(batch.userId, id);
    res.json({ success: true });
  } catch (err) { fail(res, err, /غير موجودة/.test(err.message) ? 404 : 500); }
}

// ─── الأرصدة ──────────────────────────────────────────────────
export async function listBalances(req, res) {
  try {
    const [scope, ledger] = await Promise.all([resolveStockScope(req.user.id), resolveLedgerScope(req.user)]);
    const all = await getBalances(ledger.readIds);
    const rows = all.filter(makeBalanceScopeFilter(scope));
    // تشخيص الفراغ: الصفحة كانت تقول «لا توجد أرصدة بعد — ابدأ بالاستيراد» في كل
    // حالة فراغ، حتى حين تكون الأرصدة محسوبة فعلاً لكن نطاق السوبر أدمن يحجبها،
    // فيُعاد الاستيراد بلا فائدة. هذه العدادات تجعل الصفحة تشرح سبب فراغها.
    const movements = all.length ? 0 : await prisma.stockMovement.count({ where: { userId: { in: ledger.readIds } } });
    // «الشركة الرئيسية» — تيمات المكتب (حسابات مدراء الشركات) كشرائح تصفية
    // للأدوار المكتبية، نفس تعريف /api/reports/overall-teams (قائمة فارغة لغيرها)
    const tag = await resolveBalanceTeams(rows, req.user);
    let unclassified = 0;
    const data = rows.map(b => {
      const teamId = tag.teamIdOf(b);
      if (tag.teams.length && teamId == null) unclassified++;
      return {
        warehouseId: b.warehouseId,
        warehouse: b.warehouse.name,
        region: b.warehouse.region,
        ownerId: b.userId,
        itemKey: b.itemKey,
        itemName: b.itemName,
        companyName: b.companyName,
        teamId,
        opening: b.opening,
        openingAt: b.openingAt,
        inQty: b.inQty,
        outQty: b.outQty,
        remaining: b.remaining,
        pctLeft: b.opening > 0 ? Math.round((b.remaining / b.opening) * 100) : null,
        lastMovementAt: b.lastMovementAt,
      };
    });
    res.json({
      success: true,
      meta: {
        total: all.length, hiddenByScope: all.length - rows.length, movements,
        // دفتر المكتب (لا دفتر المستخدم) — أسماء أصحابه تُعرض كتلميح في الصفحة
        sharedLedger: ledger.viewer,
        ledgerOwners: ledger.viewer ? [...ledger.ownerName.values()] : [],
        teams: tag.teams, unclassified,
      },
      data,
    });
  } catch (err) { fail(res, err); }
}

export async function listAlerts(req, res) {
  try {
    const pct = Math.max(0, Math.min(100, Number(req.query.pct ?? 20)));
    const qty = Math.max(0, Number(req.query.qty ?? 10));
    const region = req.query.region || null;
    const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null;
    const { readIds } = await resolveLedgerScope(req.user);
    const data = await buildAlerts({ userIds: readIds, viewer: req.user }, { pct, qty, region, warehouseId });
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
    const { readIds } = await resolveLedgerScope(req.user);
    const rows = await getPairHistory({ userIds: readIds, warehouseId, itemKey });
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
    // الملف (SalesDataFile) ملك الرافع — نسخته هو؛ المطابقة بدفتر الكتابة
    const { writeId } = await resolveLedgerScope(req.user);
    const result = await classifyBaselineFromStockFile({ fileOwnerId: req.user.id, ledgerId: writeId, salesDataFileId });
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
    const { writeId } = await resolveLedgerScope(req.user);
    await saveNameChoices(writeId, req.body);
    const movementDate = toDate(req.body?.movementDate);
    const result = await ingestBaselineFromStockFile({
      fileOwnerId: req.user.id,
      ledgerId: writeId,
      salesDataFileId,
      movementDate,
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
    const { writeId } = await resolveLedgerScope(req.user);
    const { pending, mercato } = await classifyMovementRows({ rows, userId: writeId });
    // rawRow غير مُستعمل في أي شاشة — يُسقَط من صفوف الذهاب والإياب بين الاستخراج
    // والحفظ لتخفيف حِمل الشبكة (قد تبلغ الملفات آلاف الأسطر).
    const lean = rows.map(({ rawRow, ...r }) => r);
    res.json({ success: true, data: { rows: lean, colMap, skipped, pending, mercato, kind, fileName: originalName } });
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

    const { writeId } = await resolveLedgerScope(req.user);
    await saveNameChoices(writeId, req.body);

    const label = { baseline: 'ستوك افتتاحي', in: 'تعزيز', out: 'مبيع من المذاخر' }[kind];
    const fileName = String(req.body?.fileName || '').trim();
    const name = label + (fileName ? ': ' + fileName : '');
    const movementDate = toDate(req.body?.movementDate);
    const result = await ingestRows({ userId: writeId, kind, name, movementDate, rows });
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
    const name = label + ': ' + originalName;
    const { writeId } = await resolveLedgerScope(req.user);
    const result = await ingestRows({ userId: writeId, kind, name, movementDate, rows });
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
    const name = label + ' (إدخال يدوي)';
    const { writeId } = await resolveLedgerScope(req.user);
    const result = await ingestRows({ userId: writeId, kind, name, movementDate, rows });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err, 400); }
}

// ─── إعادة حساب يدوية (زر صيانة) ──────────────────────────────
export async function recompute(req, res) {
  try {
    const { readIds } = await resolveLedgerScope(req.user);
    let count = 0;
    for (const id of readIds) count += await recomputeBalances(id);
    res.json({ success: true, data: { pairs: count } });
  } catch (err) { fail(res, err); }
}
