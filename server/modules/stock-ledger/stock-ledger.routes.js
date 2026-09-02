/**
 * Stock Ledger Routes — دفتر رصيد المذاخر
 *   1. استيراد الستوك الافتتاحي (من ملف Stock موجود أو بملف طولي)
 *   2. رفع حركات المبيع من المذاخر (out) والتعزيزات إليها (in)
 *   3. عرض الأرصدة الجارية وتنبيهات إعادة الطلبية
 *
 * المصادقة موروثة من بوابة app.use('/api', requireAuth) في server/index.js
 */

import { Router } from 'express';
import multer from 'multer';
import {
  listWarehouses, listBatches, deleteBatchHandler,
  listBalances, listAlerts, pairHistory,
  listStockFiles, baselineFromStockFile, extractBaselineFromStockFile,
  uploadMovements, extractMovements, commitMovements, manualMovements, recompute,
} from './stock-ledger.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls|csv)$/i)) cb(null, true);
    else cb(new Error('يُسمح بملفات Excel (.xlsx, .xls) وCSV فقط'));
  },
});

// ─── قراءة ────────────────────────────────────────────────────
router.get('/balances',   listBalances);
router.get('/alerts',     listAlerts);      // ?pct=20&qty=10&region=&warehouseId=
router.get('/warehouses', listWarehouses);
router.get('/batches',    listBatches);
router.get('/stock-files', listStockFiles); // ملفات Stock المتاحة كمصدر للستوك الافتتاحي
router.get('/warehouse/:id/history', pairHistory); // ?itemKey=

// ─── الستوك الافتتاحي ─────────────────────────────────────────
router.post('/baseline/from-stock-file/extract', extractBaselineFromStockFile); // { salesDataFileId } → { pending }
router.post('/baseline/from-stock-file', baselineFromStockFile); // { salesDataFileId, movementDate, *Choices? }
router.post('/baseline/upload', upload.single('file'), (req, res, next) => {
  req.body.kind = 'baseline';
  uploadMovements(req, res, next);
});
router.post('/baseline/upload/extract', upload.single('file'), (req, res, next) => {
  req.body.kind = 'baseline';
  extractMovements(req, res, next);
});
router.post('/baseline/upload/commit', (req, res, next) => {
  req.body.kind = 'baseline';
  commitMovements(req, res, next);
});

// ─── الحركات ──────────────────────────────────────────────────
router.post('/movements/upload', upload.single('file'), uploadMovements); // kind='in'|'out' — بلا معاينة (توافقي)
router.post('/movements/extract', upload.single('file'), extractMovements); // kind='in'|'out'|'baseline' → { rows, pending }
router.post('/movements/commit', commitMovements); // { kind, movementDate, rows, *Choices?, fileName? }
router.post('/movements/manual', manualMovements);

// ─── صيانة ────────────────────────────────────────────────────
router.delete('/batches/:id', deleteBatchHandler);
router.post('/recompute',     recompute);

export default router;
