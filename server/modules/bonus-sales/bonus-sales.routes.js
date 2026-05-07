/**
 * Bonus Sales Routes
 * Handles:
 *   1. Uploading sales file (with/without bonus column)
 *   2. Uploading compensation file and auto-matching
 *   3. Listing uploads and rows
 *   4. Marking bonus as delivered by rep
 */

import { Router } from 'express';
import multer from 'multer';
import {
  uploadSalesFile,
  uploadCompFile,
  listSalesUploads,
  deleteSalesUpload,
  getSalesRows,
  markDelivered,
  unmarkDelivered,
  listCompUploads,
  deleteCompUpload,
} from './bonus-sales.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls|csv)$/i)) cb(null, true);
    else cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed.'));
  },
});

// ─── Sales file (الملف الأساسي) ──────────────────────────────
router.post('/sales/upload',   upload.single('file'), uploadSalesFile);
router.get('/sales/uploads',   listSalesUploads);
router.delete('/sales/uploads/:id', deleteSalesUpload);
router.get('/sales/rows',      getSalesRows);      // ?uploadId=&page=&pageSize=&pharmacyName=&repName=&hasBonus=&isCompensated=&bonusDelivered=

// ─── Compensation file (ملف التعويضات) ───────────────────────
router.post('/comp/upload',    upload.single('file'), uploadCompFile);
router.get('/comp/uploads',    listCompUploads);
router.delete('/comp/uploads/:id', deleteCompUpload);

// ─── Delivery marking (تأشير التسليم) ────────────────────────
router.patch('/rows/:id/deliver',   markDelivered);
router.patch('/rows/:id/undeliver', unmarkDelivered);

export default router;
