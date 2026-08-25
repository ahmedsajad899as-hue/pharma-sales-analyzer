/**
 * Sales Controller
 * Handles HTTP request/response for the sales upload endpoint.
 * Delegates all business logic to the service layer.
 */

import { processUploadedFile, extractInvoiceRows, filterRowsToAssignedItems, insertManualSales } from './sales.service.js';
import { AppError } from '../../middleware/errorHandler.js';

/**
 * POST /api/upload-sales
 * Accepts a multipart Excel file and optional metadata.
 *
 * Request (multipart/form-data):
 *   - file:         Excel file (required)
 *   - uploadedBy:   string (optional)
 *   - repNameCol:   Excel column header for rep name (optional)
 *   - areaCol:      Excel column header for area (optional)
 *   - itemCol:      Excel column header for item (optional)
 *   - quantityCol:  Excel column header for quantity (optional)
 *   - totalValueCol: Excel column header for total value (optional)
 *
 * Response 201:
 *   { success, data: { rowCount, skipped, uploadedFile } }
 */
export async function uploadSales(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError('No file uploaded. Send a multipart/form-data request with key "file".', 400, 'NO_FILE');
    }

    // Build optional column mapping from request body
    const columnMapping = {
      repName:    req.body.repNameCol    || undefined,
      area:       req.body.areaCol       || undefined,
      item:       req.body.itemCol       || undefined,
      quantity:   req.body.quantityCol   || undefined,
      totalValue: req.body.totalValueCol || undefined,
    };

    const result = await processUploadedFile(req.file, {
      uploadedBy:     req.body.uploadedBy || req.user?.username || null,
      columnMapping,
      userId:         req.user?.id ?? null,
      fileType:       req.body.fileType || 'sales',
      sourceCurrency: req.body.sourceCurrency || null,  // user-specified: 'IQD' | 'USD' | null
    });

    return res.status(201).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/extract-invoice
 * Accepts one or more invoice IMAGES (multipart, field "images") and returns
 * AI-extracted sale rows for review. Does NOT save anything.
 *
 * Body field "onlyAssignedItems" (optional, string 'true'/'1'): when set, rows
 * whose item doesn't confidently match one of the user's assigned items
 * (UserItemAssignment) are dropped, and kept rows' item names are rewritten to
 * the assigned item's canonical name.
 *
 * Response 200: { success, data: { rows: [...], droppedCount } }
 */
export async function extractInvoice(req, res, next) {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw new AppError('لم يتم إرسال أي صورة. أرسل ملفات الصور في الحقل "images".', 400, 'NO_IMAGES');
    }
    const images = files.map(f => ({ mimeType: f.mimetype, base64: f.buffer.toString('base64') }));
    let rows = await extractInvoiceRows(images);
    let droppedCount = 0;
    const onlyAssigned = req.body?.onlyAssignedItems === 'true' || req.body?.onlyAssignedItems === '1';
    if (onlyAssigned) {
      ({ rows, droppedCount } = await filterRowsToAssignedItems(rows, req.user?.id ?? null));
    }
    return res.json({ success: true, data: { rows, droppedCount } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/manual
 * Persist manually-entered / invoice-extracted sale rows as Sale records,
 * merged into an existing file or into a new one.
 *
 * Body (application/json):
 *   rows:   [{ repName, item, company?, quantity, totalValue, unitPrice?, pharmacy?, warehouse?, area?, date?, invoiceNumber?, bonus? }]
 *   target: { fileId } | { newFileName, sourceCurrency? }
 *
 * Response 201: { success, data: { addedCount, merged, unknownItems, uploadedFile } }
 */
export async function addManualSales(req, res, next) {
  try {
    const { rows, target } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError('لا توجد صفوف للحفظ.', 400, 'NO_ROWS');
    }
    const result = await insertManualSales({
      rows,
      target:     target || {},
      userId:     req.user?.id ?? null,
      uploadedBy: req.user?.username || null,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
