import express from 'express';
import {
  loginSuperAdmin,
  getSuperAdminProfile,
  listSuperAdmins,
  createSuperAdmin,
  updateSuperAdmin,
  deleteSuperAdmin,
  impersonateUser,
  listVisits,
  updateVisit,
  deleteVisit,
  bulkDeleteVisits,
  listPharmacyVisits,
  updatePharmacyVisit,
  deletePharmacyVisit,
  bulkDeletePharmacyVisits,
  listOfficesForFilter,
  listCompaniesForFilter,
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

// Doctor Visits management (master only)
router.get('/visits',              requireMasterAdmin, listVisits);
router.patch('/visits/:id',        requireMasterAdmin, updateVisit);
router.delete('/visits/:id',       requireMasterAdmin, deleteVisit);
router.delete('/visits',           requireMasterAdmin, bulkDeleteVisits);

// Pharmacy Visits management (master only)
router.get('/pharmacy-visits',              requireMasterAdmin, listPharmacyVisits);
router.patch('/pharmacy-visits/:id',        requireMasterAdmin, updatePharmacyVisit);
router.delete('/pharmacy-visits/:id',       requireMasterAdmin, deletePharmacyVisit);
router.delete('/pharmacy-visits',           requireMasterAdmin, bulkDeletePharmacyVisits);

// Filter option lists (master only)
router.get('/offices-for-filter',   requireMasterAdmin, listOfficesForFilter);
router.get('/companies-for-filter', requireMasterAdmin, listCompaniesForFilter);

// Any super admin can impersonate a user
router.post('/impersonate/:userId', requireSuperAdmin, impersonateUser);

export default router;
