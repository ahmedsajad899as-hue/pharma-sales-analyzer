import express from 'express';
import { listLinks, createLink, updateLink, deleteLink } from './telegram-links.controller.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

// ماستر أدمن فقط — ربط كروب بحساب يمنح ذلك الكروب صلاحية "رفع بيانات باسم هذا
// المستخدم"، حساس بما يكفي لتقييده دون بقية السوبر أدمن.
router.use(requireMasterAdmin);

router.get('/',       listLinks);
router.post('/',      createLink);
router.put('/:id',    updateLink);
router.delete('/:id', deleteLink);

export default router;
