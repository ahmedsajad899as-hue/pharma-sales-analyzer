import { Router } from 'express';
import { login, me, changePassword } from './auth.controller.js';
import { requireAuth } from '../../middleware/authMiddleware.js';

const router = Router();

router.post('/login',           login);
router.get('/me',               requireAuth, me);
router.post('/change-password', requireAuth, changePassword);

export default router;
