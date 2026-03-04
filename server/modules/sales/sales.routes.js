/**
 * Sales Routes
 * POST /api/upload-sales
 */

import { Router } from 'express';
import multer from 'multer';
import { uploadSales } from './sales.controller.js';

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

export default router;
