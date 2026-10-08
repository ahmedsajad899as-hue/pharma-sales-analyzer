import express from 'express';
import { listLinks, createLink, updateLink, deleteLink } from './viber-links.controller.js';
import { requireMasterAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();

// ماستر أدمن فقط — ربط محادثة بحساب يمنحها صلاحية "إدخال بيانات باسم هذا
// المستخدم"، حساس بما يكفي لتقييده دون بقية السوبر أدمن (نفس منطق روابط تلكرام).
router.use(requireMasterAdmin);

router.get('/',       listLinks);
router.post('/',      createLink);
router.put('/:id',    updateLink);
router.delete('/:id', deleteLink);

export default router;
