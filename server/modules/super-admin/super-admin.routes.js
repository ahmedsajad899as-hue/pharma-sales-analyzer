import express from 'express';
import {
  loginSuperAdmin,
  getSuperAdminProfile,
  listSuperAdmins,
  createSuperAdmin,
  updateSuperAdmin,
  deleteSuperAdmin,
  impersonateUser,
} from './super-admin.controller.js';
import { requireSuperAdmin, requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

// Public
router.post('/login', loginSuperAdmin);

// Protected — any super admin
router.get('/me', requireSuperAdmin, getSuperAdminProfile);

// Protected — master only
router.get('/admins',        requireMasterAdmin, listSuperAdmins);
router.post('/admins',       requireMasterAdmin, createSuperAdmin);
router.put('/admins/:id',    requireMasterAdmin, updateSuperAdmin);
router.delete('/admins/:id', requireMasterAdmin, deleteSuperAdmin);

// Any super admin can impersonate a user
router.post('/impersonate/:userId', requireSuperAdmin, impersonateUser);

export default router;
