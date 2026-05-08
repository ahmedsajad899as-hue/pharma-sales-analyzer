/**
 * Bonus Sales Controller
 * Thin HTTP layer — validates, delegates to service/repository.
 */

import { parseFile, buildMatchKey } from './bonus-sales.service.js';
import {
  createSalesUpload,
  bulkInsertSalesRows,
  getSalesUploads,
  getSalesUploadById,
  deleteSalesUploadById,
  getSalesRowsPage,
  createCompUpload,
  bulkInsertCompRows,
  getCompRowsByUpload,
  getSalesRowsByUpload,
  markRowsCompensated,
  getCompUploads,
  getCompUploadById,
  deleteCompUploadById,
  setSalesRowDelivery,
} from './bonus-sales.repository.js';

const utf8Name = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

// ─── Upload sales file ────────────────────────────────────────
export async function uploadSalesFile(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    const userId = req.user?.id ?? null;
    const originalName = utf8Name(req.file);
    const { rows, warnings } = parseFile(req.file.buffer, originalName);
    if (!rows.length) return res.status(422).json({ error: 'لا توجد بيانات في الملف', warnings });

    const upload = await createSalesUpload({ originalName, rowCount: rows.length, userId });
    await bulkInsertSalesRows(upload.id, rows);

    return res.json({ success: true, uploadId: upload.id, rowCount: rows.length, warnings });
  } catch (err) {
    console.error('[bonus-sales] uploadSalesFile:', err);
    return res.status(500).json({ error: err.message || 'فشل رفع الملف' });
  }
}

// ─── List sales uploads ───────────────────────────────────────
export async function listSalesUploads(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const uploads = await getSalesUploads(userId);
    return res.json({ success: true, data: uploads });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Delete sales upload ──────────────────────────────────────
export async function deleteSalesUpload(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const existing = await getSalesUploadById(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'غير موجود' });
    await deleteSalesUploadById(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Get paginated sales rows ─────────────────────────────────
export async function getSalesRows(req, res) {
  try {
    const { uploadId, page = 1, pageSize = 50, search, pharmacyName, repName, itemName, hasBonus, isCompensated, bonusDelivered } = req.query;
    if (!uploadId) return res.status(400).json({ error: 'uploadId مطلوب' });

    const filters = {};
    if (search)       filters.search       = search;
    if (pharmacyName) filters.pharmacyName = pharmacyName;
    if (repName)      filters.repName      = repName;
    if (itemName)     filters.itemName     = itemName;
    if (hasBonus      !== undefined && hasBonus      !== '') filters.hasBonus      = hasBonus      === 'true';
    if (isCompensated !== undefined && isCompensated !== '') filters.isCompensated = isCompensated === 'true';
    if (bonusDelivered !== undefined && bonusDelivered !== '') filters.bonusDelivered = bonusDelivered === 'true';

    const result = await getSalesRowsPage({
      uploadId,
      page: Number(page),
      pageSize: Math.min(Number(pageSize), 200),
      filters,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Upload compensation file ─────────────────────────────────
export async function uploadCompFile(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    const userId = req.user?.id ?? null;
    const originalName = utf8Name(req.file);
    const { salesUploadId } = req.body;
    if (!salesUploadId) return res.status(400).json({ error: 'salesUploadId مطلوب' });

    const { rows: compRows, warnings } = parseFile(req.file.buffer, originalName);
    if (!compRows.length) return res.status(422).json({ error: 'لا توجد بيانات في ملف التعويضات', warnings });

    const compUpload = await createCompUpload({
      originalName,
      rowCount: compRows.length,
      userId,
      salesUploadId: Number(salesUploadId),
    });
    await bulkInsertCompRows(compUpload.id, compRows);

    // ── Auto-match: find sales rows without bonus that match comp rows ──
    const salesRows  = await getSalesRowsByUpload(salesUploadId);
    const compDbRows = await getCompRowsByUpload(compUpload.id);

    // Build lookup map from comp rows: key -> compRowId
    const compMap = new Map();
    for (const cr of compDbRows) {
      const key = buildMatchKey(cr);
      if (key && !compMap.has(key)) compMap.set(key, cr.id);
    }

    const matchedIds = [];
    const compRowIdMap = {};
    for (const sr of salesRows) {
      if (sr.hasBonus) continue; // already has bonus — skip
      const key = buildMatchKey(sr);
      if (compMap.has(key)) {
        matchedIds.push(sr.id);
        compRowIdMap[sr.id] = compMap.get(key);
      }
    }

    if (matchedIds.length) {
      await markRowsCompensated(matchedIds, compRowIdMap);
    }

    return res.json({
      success: true,
      uploadId: compUpload.id,
      compRowCount: compRows.length,
      matchedCount: matchedIds.length,
      warnings,
    });
  } catch (err) {
    console.error('[bonus-sales] uploadCompFile:', err);
    return res.status(500).json({ error: err.message || 'فشل رفع ملف التعويضات' });
  }
}

// ─── List comp uploads ────────────────────────────────────────
export async function listCompUploads(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const uploads = await getCompUploads(userId);
    return res.json({ success: true, data: uploads });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Delete comp upload ───────────────────────────────────────
export async function deleteCompUpload(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const existing = await getCompUploadById(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'غير موجود' });
    await deleteCompUploadById(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Mark delivery ────────────────────────────────────────────
export async function markDelivered(req, res) {
  try {
    const userId = req.user?.id ?? null;
    const { note } = req.body;
    const row = await setSalesRowDelivery(req.params.id, { delivered: true, userId, note });
    return res.json({ success: true, row });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export async function unmarkDelivered(req, res) {
  try {
    const row = await setSalesRowDelivery(req.params.id, { delivered: false, userId: null, note: null });
    return res.json({ success: true, row });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
