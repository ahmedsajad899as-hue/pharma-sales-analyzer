/**
 * استيراد الكتالوج الشامل — راوتر مستقل عن /api/sa/companies لأن العملية
 * تعبر عدة شركات دفعة واحدة (تُنشئ شركات وتنقل ايتمات بينها)، بعكس بقية
 * نقاط الشركات المُنطاقة بـ :id واحد.
 */

import express from 'express';
import { previewCatalogImport, commitCatalogImport } from './catalog-import.controller.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();
router.use(requireSuperAdmin);

router.post('/preview', previewCatalogImport);
router.post('/commit',  commitCatalogImport);

export default router;
