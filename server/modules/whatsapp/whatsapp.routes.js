import express from 'express';
import { verify, webhook } from './whatsapp.controller.js';

const router = express.Router();

// عام بالكامل — بلا requireAuth. GET مصافحة تسجيل Meta (hub.verify_token)، وPOST
// موثَّق بتوقيع X-Hub-Signature-256. كلاهما 404 ما دام البوت خامداً.
router.get('/webhook', verify);
router.post('/webhook', webhook);

export default router;
