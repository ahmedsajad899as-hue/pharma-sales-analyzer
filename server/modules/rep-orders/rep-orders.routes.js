import { Router } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import * as ctrl from './rep-orders.controller.js';
import { INVOICE_DIR } from './rep-orders.service.js';

// صورة الفاتورة: تُضغط في المتصفح قبل الرفع (~200KB)، والحدّ هنا حارس فقط —
// القرص ضيّق على السيرفر. الاسم عشوائي لأن /uploads يُخدم بلا مصادقة.
const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(INVOICE_DIR, { recursive: true }); cb(null, INVOICE_DIR); },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}.jpg`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// صورة فاتورة للقراءة والمطابقة — تبقى pending-* حتى يؤكّد المستخدم ربطها (applyInvoice)
const readUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(INVOICE_DIR, { recursive: true }); cb(null, INVOICE_DIR); },
    filename: (_req, _file, cb) => cb(null, `pending-${crypto.randomBytes(16).toString('hex')}.jpg`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const router = Router();

router.get('/warehouses', ctrl.listWarehouses);
router.post('/warehouses', ctrl.createWarehouse);
router.put('/warehouses/:id', ctrl.updateWarehouse);
router.delete('/warehouses/:id', ctrl.deleteWarehouse);

router.get('/suggestions', ctrl.suggestions);
router.post('/invoice/read', readUpload.single('image'), ctrl.readInvoice);
router.post('/status', ctrl.setStatus);
router.post('/mark-sent', ctrl.markSent);

router.get('/', ctrl.listOrders);
router.post('/', ctrl.createOrder);
router.put('/:id', ctrl.updateOrder);
router.delete('/:id', ctrl.deleteOrder);
// :kind = invoice (فاتورة المذخر) | prepared (صورة ما بعد التجهيز ← تُعلِّم الطلبية مجهّزة)
router.post('/:id/image/:kind', invoiceUpload.single('image'), ctrl.attachImage);
router.delete('/:id/image/:kind', ctrl.removeImage);
router.post('/:id/apply-invoice', ctrl.applyInvoice);

export default router;
