import express from 'express';
import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  listLines, createLine, updateLine, deleteLine,
  setLineItems, getAllLines,
} from './companies.controller.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

router.use(requireSuperAdmin);

// Static routes first (must be before /:id)
router.get('/all-lines',  getAllLines);

// Companies
router.get('/',           listCompanies);
router.get('/:id',        getCompany);
router.post('/',          createCompany);
router.put('/:id',        updateCompany);
router.delete('/:id',     deleteCompany);

// Lines within a company
router.get('/:id/lines',          listLines);
router.post('/:id/lines',         createLine);
router.put('/:id/lines/:lineId',  updateLine);
router.delete('/:id/lines/:lineId', deleteLine);
router.put('/:id/lines/:lineId/items', setLineItems);

export default router;
