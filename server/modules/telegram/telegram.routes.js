import express from 'express';
import { webhook } from './telegram.controller.js';

const router = express.Router();

// عام بالكامل — بلا requireAuth/requireSuperAdmin، موثَّق بهيدر السر بدلاً منه.
router.post('/webhook', webhook);

export default router;
