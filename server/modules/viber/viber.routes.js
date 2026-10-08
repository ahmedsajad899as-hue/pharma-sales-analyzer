import express from 'express';
import { webhook } from './viber.controller.js';

const router = express.Router();

// عام بالكامل — بلا requireAuth، موثَّق بتوقيع X-Viber-Content-Signature بدلاً
// منه، ويُعيد 404 ما دام VIBER_AUTH_TOKEN غير مضبوط.
router.post('/webhook', webhook);

export default router;
