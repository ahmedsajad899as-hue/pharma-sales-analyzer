import { Router } from 'express';
import { listUsers, createUser, updateUser, deleteUser } from './users.controller.js';
import { requireAuth, requireAdmin } from '../../middleware/authMiddleware.js';

const router = Router();

// All admin-users routes require authentication + admin role
router.use(requireAuth, requireAdmin);

router.get('/',       listUsers);
router.post('/',      createUser);
router.patch('/:id',  updateUser);
router.delete('/:id', deleteUser);

export default router;
