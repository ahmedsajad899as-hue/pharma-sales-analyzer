/**
 * Distributor Sales Routes
 * Handles upload and analysis of distributor-format Excel files.
 *
 * Format: امازون | Item | شهر3 | شهر4 | ... | تاريخ البيع | كمية المباعة | اعادة الفوترة
 * With team header rows (e.g. "Team Iraqis", "Team Osel", "Team Deva")
 */

import { Router } from 'express';
import multer from 'multer';
import {
  uploadDistributorFile,
  listUploads,
  deleteUpload,
  getAnalysis,
  getTeamAnalysis,
  getDistributorAnalysis,
  getItemAnalysis,
  getReinvoicingList,
} from './distributor-sales.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls|csv|pdf)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls), CSV, and PDF files are allowed.'));
    }
  },
});

// ─── Upload ───────────────────────────────────────────────────
router.post('/upload', upload.single('file'), uploadDistributorFile);

// ─── Uploads list / delete ────────────────────────────────────
router.get('/uploads', listUploads);
router.delete('/uploads/:id', deleteUpload);

// ─── Analysis ─────────────────────────────────────────────────
router.get('/analysis', getAnalysis);
router.get('/analysis/teams', getTeamAnalysis);
router.get('/analysis/distributors', getDistributorAnalysis);
router.get('/analysis/items', getItemAnalysis);
router.get('/analysis/reinvoicing', getReinvoicingList);

export default router;
