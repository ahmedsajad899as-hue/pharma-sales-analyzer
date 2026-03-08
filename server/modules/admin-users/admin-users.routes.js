import express from 'express';
import {
  listAllUsers, getUser, createUser, updateUser,
  setUserCompanies, setUserAreas, setUserItems, setUserLines,
  setUserManagers, setUserInteractions,
  deleteUser,
} from './admin-users.controller.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

router.use(requireSuperAdmin);

router.get('/',       listAllUsers);
router.get('/:id',    getUser);
router.post('/',      createUser);
router.put('/:id',    updateUser);
router.delete('/:id', deleteUser);

// Assignment endpoints
router.put('/:id/companies',    setUserCompanies);
router.put('/:id/areas',        setUserAreas);
router.put('/:id/items',        setUserItems);
router.put('/:id/lines',        setUserLines);
router.put('/:id/managers',     setUserManagers);
router.put('/:id/interactions', setUserInteractions);

export default router;
