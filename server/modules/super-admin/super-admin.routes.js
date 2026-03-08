import express from 'express';
import {
  loginSuperAdmin,
  getSuperAdminProfile,
  listSuperAdmins,
  createSuperAdmin,
  updateSuperAdmin,
  deleteSuperAdmin,
} from './super-admin.controller.js';
import { requireSuperAdmin, requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

// Public
router.post('/login', loginSuperAdmin);

// Protected — any super admin
router.get('/me', requireSuperAdmin, getSuperAdminProfile);

// Protected — master only
router.get('/',        requireMasterAdmin, listSuperAdmins);
router.post('/',       requireMasterAdmin, createSuperAdmin);
router.put('/:id',     requireMasterAdmin, updateSuperAdmin);
router.delete('/:id',  requireMasterAdmin, deleteSuperAdmin);

export default router;
