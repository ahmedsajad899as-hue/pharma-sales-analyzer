import { Router } from 'express';
import { login, me, changePassword, logout } from './auth.controller.js';
import { requireAuth } from '../../middleware/authMiddleware.js';

const router = Router();

router.post('/login',           login);
router.post('/logout',          requireAuth, logout);
router.get('/me',               requireAuth, me);
router.post('/change-password', requireAuth, changePassword);

export default router;
