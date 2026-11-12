import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import { listCatalog, updateItem, createItem } from './items-catalog.controller.js';

// صفحة «الايتمات والأسعار» — الدور والميزة (items_catalog) يُتحقَّق منهما داخل
// كل معالج (loadEditor) لأن صلاحيات الميزات تُقرأ من قاعدة البيانات لا من التوكن.
const router = Router();
router.use(requireAuth);

router.get('/',                listCatalog);
router.post('/items',          createItem);
router.patch('/items/:itemId', updateItem);

export default router;
