import express from 'express';
import multer from 'multer';
import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  listLines, createLine, updateLine, deleteLine,
  setLineItems, getAllLines,
  createCompanyItem, deleteCompanyItem,
  importCompanyItems, importCompanyItemsJson,
  getCompanyOrg,
} from './companies.controller.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();
const memUpload = multer({ storage: multer.memoryStorage() });

router.use(requireSuperAdmin);

// Static routes first (must be before /:id)
router.get('/all-lines',  getAllLines);

// Companies
router.get('/',           listCompanies);
router.get('/:id/org',    getCompanyOrg);
router.get('/:id',        getCompany);
router.post('/',          createCompany);
router.put('/:id',        updateCompany);
router.delete('/:id',     deleteCompany);

// Items within a company
router.post('/:id/items',                  createCompanyItem);
router.post('/:id/items/bulk',             importCompanyItemsJson);
router.post('/:id/items/import',           memUpload.single('file'), importCompanyItems);
router.delete('/:id/items/:itemId',        deleteCompanyItem);

// Lines within a company
router.get('/:id/lines',               listLines);
router.post('/:id/lines',              createLine);
router.put('/:id/lines/:lineId',       updateLine);
router.delete('/:id/lines/:lineId',    deleteLine);
router.put('/:id/lines/:lineId/items', setLineItems);

export default router;
