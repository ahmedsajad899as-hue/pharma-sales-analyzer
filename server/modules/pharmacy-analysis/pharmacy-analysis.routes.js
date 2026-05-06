import { Router } from 'express';
import * as ctrl from './pharmacy-analysis.controller.js';

const router = Router();

// GET /api/pharmacy-analysis/pharmacies  — list all pharmacies with summary
router.get('/pharmacies', ctrl.listPharmacies);

// GET /api/pharmacy-analysis/pharmacy/:name — all orders for a pharmacy (optionally filter by item)
router.get('/pharmacy/:name', ctrl.pharmacyDetail);

// GET /api/pharmacy-analysis/items — list all items with pharmacy-level breakdown
router.get('/items', ctrl.listItems);

// GET /api/pharmacy-analysis/item/:name — all pharmacies that bought this item
router.get('/item/:name', ctrl.itemDetail);

// GET /api/pharmacy-analysis/alerts — pharmacies × items overdue for an order
router.get('/alerts', ctrl.getAlerts);

export default router;
