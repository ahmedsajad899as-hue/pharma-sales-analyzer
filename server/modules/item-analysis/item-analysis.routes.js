import { Router } from 'express';
import * as ctrl from './item-analysis.controller.js';

const router = Router();

// GET /api/item-analysis/items?search=&fileIds=  — items selector list
router.get('/items', ctrl.listItems);

// POST /api/item-analysis/survey/ai-analyze-all  — analyze ALL active drug_price surveys
router.post('/survey/ai-analyze-all', ctrl.analyzeAllSurveysWithAI);

// POST /api/item-analysis/survey/:surveyId/ai-analyze  — AI analyze a specific survey
router.post('/survey/:surveyId/ai-analyze', ctrl.analyzeSurveyWithAI);

// GET /api/item-analysis/:itemId/reps?fileIds=&days=  — list of reps linked to this item
router.get('/:itemId/reps', ctrl.listReps);

// GET /api/item-analysis/:itemId?fileIds=&days=&repName=  — aggregated analytics
router.get('/:itemId', ctrl.getItemAnalytics);

// GET /api/item-analysis/:itemId/market-prices  — drug price survey data for competitor comparison
router.get('/:itemId/market-prices', ctrl.getMarketPrices);

// POST /api/item-analysis/:itemId/ai-insight  — Gemini insight (body may include repName)
router.post('/:itemId/ai-insight', ctrl.getAIInsight);

export default router;
