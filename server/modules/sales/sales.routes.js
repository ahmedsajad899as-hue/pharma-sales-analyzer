/**
 * Sales Routes
 * POST /api/upload-sales
 */

import { Router } from 'express';
import multer from 'multer';
import { uploadSales, extractInvoice, addManualSales } from './sales.controller.js';
import { getFileRows, saveFileRows, restoreFileRows } from './file-editor.controller.js';

const router = Router();

// Store file in memory for direct buffer access (no temp files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel',                                           // .xls
      'text/csv',                                                            // .csv
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed.'));
    }
  },
});

// Image uploader for invoice extraction (memory, images only)
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 12 * 1024 * 1024, files: 10 }, // 12 MB each, up to 10 images
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

/**
 * POST /api/upload-sales
 * Upload an Excel file with sales data.
 *
 * Form fields:
 *   file         (required) - Excel/CSV file
 *   uploadedBy   (optional) - user identifier
 *   repNameCol   (optional) - override column name for rep
 *   areaCol      (optional) - override column name for area
 *   itemCol      (optional) - override column name for item
 *   quantityCol  (optional) - override column name for quantity
 *   totalValueCol (optional) - override column name for total value
 */
router.post('/upload-sales', upload.single('file'), uploadSales);

/**
 * POST /api/sales/extract-invoice
 * Multipart: images[] (one or more invoice photos). Returns AI-extracted rows for review.
 */
router.post('/sales/extract-invoice', imageUpload.array('images', 10), extractInvoice);

/**
 * POST /api/sales/manual
 * JSON: { rows: [...], target: { fileId } | { newFileName, sourceCurrency? } }.
 * Persists reviewed rows as Sale records.
 */
router.post('/sales/manual', addManualSales);

/**
 * محرّر الملف المرفوع — تعديل صفوف الإكسل بعد رفعه.
 * التعديلات تُطبَّق على صفوف Sale مباشرةً فتنعكس في التقارير والتصدير فوراً.
 */
router.get('/files/:id/rows',     getFileRows);
router.put('/files/:id/rows',     saveFileRows);
router.post('/files/:id/restore', restoreFileRows);

export default router;
