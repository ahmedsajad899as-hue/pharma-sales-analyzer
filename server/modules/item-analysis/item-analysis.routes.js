import { Router } from 'express';
import * as ctrl from './item-analysis.controller.js';

const router = Router();

// GET /api/item-analysis/items?search=&fileIds=  — items selector list
router.get('/items', ctrl.listItems);

// GET /api/item-analysis/:itemId?fileIds=&days=  — aggregated analytics
router.get('/:itemId', ctrl.getItemAnalytics);

// POST /api/item-analysis/:itemId/ai-insight  — Gemini insight
router.post('/:itemId/ai-insight', ctrl.getAIInsight);

export default router;
