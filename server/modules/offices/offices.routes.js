import express from 'express';
import {
  listOffices, getOffice, createOffice, updateOffice, deleteOffice,
  listOfficeUsers, assignUserToOffice,
} from './offices.controller.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

router.use(requireSuperAdmin);

router.get('/',          listOffices);
router.get('/:id',       getOffice);
router.post('/',         createOffice);
router.put('/:id',       updateOffice);
router.delete('/:id',    deleteOffice);

router.get('/:id/users',        listOfficeUsers);
router.post('/:id/users/assign', assignUserToOffice);

export default router;
