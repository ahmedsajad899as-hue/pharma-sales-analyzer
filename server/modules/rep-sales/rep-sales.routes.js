import { Router } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import * as ctrl from './rep-sales.controller.js';
import { SALE_IMAGE_DIR } from './rep-sales.service.js';

// الصورة تُضغط في المتصفح قبل الرفع، والحدّ هنا حارس فقط. الاسم عشوائي لأن /uploads بلا مصادقة.
const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(SALE_IMAGE_DIR, { recursive: true }); cb(null, SALE_IMAGE_DIR); },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}.jpg`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const router = Router();

router.get('/suggestions', ctrl.suggestions);
router.get('/province-summary', ctrl.provinceSummary);
router.get('/', ctrl.listSales);
router.post('/', invoiceUpload.single('image'), ctrl.createSale);
router.put('/:id', ctrl.updateSale);
router.delete('/:id', ctrl.deleteSale);
router.post('/:id/confirm', invoiceUpload.single('image'), ctrl.confirmSale);
router.post('/:id/status', ctrl.setStatus);
router.post('/:id/image', invoiceUpload.single('image'), ctrl.attachImage);
router.delete('/:id/image', ctrl.removeImage);

export default router;
