/**
 * Reports Routes
 * GET /api/reports/representative/:id
 */

import { Router } from 'express';
import { getRepresentativeReport } from '../representatives/representatives.controller.js';

const router = Router();

/**
 * GET /api/reports/representative/:id
 *
 * Query params (all optional):
 *   startDate  - ISO datetime  e.g. 2026-01-01T00:00:00.000Z
 *   endDate    - ISO datetime  e.g. 2026-03-01T23:59:59.999Z
 *   areaId     - number        filter to a single area
 *   itemId     - number        filter to a single item
 *
 * Example:
 *   GET /api/reports/representative/5?startDate=2026-01-01T00:00:00Z
 */
router.get('/representative/:id', getRepresentativeReport);

export default router;
