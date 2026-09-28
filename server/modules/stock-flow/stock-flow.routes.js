/**
 * Stock Flow Routes — «تحريك المذاخر»
 * المصادقة موروثة من بوابة app.use('/api', requireAuth) في server/index.js
 */

import { Router } from 'express';
import multer from 'multer';
import {
  listCycles,
  listCounts, addCount, deleteCountHandler,
  extractTeamSales, commitTeamSalesHandler, manualTeamSalesHandler, deleteTeamSaleHandler,
} from './stock-flow.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls|csv)$/i)) cb(null, true);
    else cb(new Error('يُسمح بملفات Excel (.xlsx, .xls) وCSV فقط'));
  },
});

// ─── الدورات (محسوبة بالكامل من نقاط العدّ + التعزيز + مبيعات الفرق) ──
router.get('/cycles', listCycles);

// ─── نقاط العدّ (الستوك الافتتاحي/الثانوي) ────────────────────
router.get('/counts', listCounts); // ?warehouseId=
router.post('/counts', addCount);
router.delete('/counts/:id', deleteCountHandler);

// ─── مبيعات الفرق (تجاري/علمي) ─────────────────────────────────
router.post('/team-sales/extract', upload.single('file'), extractTeamSales);
router.post('/team-sales/commit', commitTeamSalesHandler);
router.post('/team-sales/manual', manualTeamSalesHandler);
router.delete('/team-sales/:id', deleteTeamSaleHandler);

export default router;
