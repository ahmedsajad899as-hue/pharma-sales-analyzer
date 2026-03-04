/**
 * Representatives Controller
 * Handles HTTP request/response for the representatives module.
 */

import * as service from './representatives.service.js';
import { AppError } from '../../middleware/errorHandler.js';

/** Parse fileIds from query string: '1,2,3' → [1,2,3], '5' → [5], null → null */
const parseFileIds = (raw) => {
  if (!raw) return null;
  const ids = String(raw).split(',').map(Number).filter(n => n > 0);
  return ids.length > 0 ? ids : null;
};

// ─── CRUD Handlers ────────────────────────────────────────────

/**
 * POST /api/representatives
 */
export async function createRepresentative(req, res, next) {
  try {
    const rep = await service.createRepresentative({ ...req.body, userId: req.user?.id ?? null });
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * GET /api/representatives
 */
export async function listRepresentatives(req, res, next) {
  try {
    const isActive = req.query.isActive !== undefined
      ? req.query.isActive === 'true'
      : undefined;
    // Support fileIds=1,2,3 (multi) or fileId=1 (legacy single)
    const fileIds = parseFileIds(req.query.fileIds || req.query.fileId);
    const reps = await service.listRepresentatives({ isActive }, fileIds, req.user?.id ?? null);
    res.json({ success: true, data: reps, total: reps.length });
  } catch (err) { next(err); }
}

/**
 * GET /api/representatives/:id
 */
export async function getRepresentative(req, res, next) {
  try {
    const rep = await service.getRepresentativeById(+req.params.id);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/representatives/:id
 */
export async function updateRepresentative(req, res, next) {
  try {
    const rep = await service.updateRepresentative(+req.params.id, req.body);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/representatives/:id
 */
export async function deleteRepresentative(req, res, next) {
  try {
    await service.deleteRepresentative(+req.params.id);
    res.json({ success: true, message: 'Representative deleted successfully.' });
  } catch (err) { next(err); }
}

/**
 * GET /api/representatives/with-sales-areas
 */
export async function getRepsWithSalesAreas(req, res, next) {
  try {
    const data = await service.getRepsWithSalesAreas(req.user?.id ?? null);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Assignment Handlers ──────────────────────────────────────

/**
 * PUT /api/representatives/:id/areas/by-name
 * Body: { areaNames: ['Riyadh', 'Jeddah'] }
 * Creates areas that don't exist yet, then assigns them.
 */
export async function assignAreasByName(req, res, next) {
  try {
    const names = (req.body.areaNames || []).map(n => String(n).trim()).filter(Boolean);
    const rep = await service.assignAreasByName(+req.params.id, names, req.user?.id ?? null);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * PUT /api/representatives/:id/areas
 * Body: { areaIds: [1, 2, 3] }
 */
export async function assignAreas(req, res, next) {
  try {
    const rep = await service.assignAreas(+req.params.id, req.body.areaIds);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/representatives/:id/areas
 * Removes all area restrictions (rep now covers all areas).
 */
export async function clearAreas(req, res, next) {
  try {
    const result = await service.clearAreas(+req.params.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

/**
 * PUT /api/representatives/:id/items
 * Body: { itemIds: [1, 2, 3] }
 */
export async function assignItems(req, res, next) {
  try {
    const rep = await service.assignItems(+req.params.id, req.body.itemIds);
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/representatives/:id/items
 * Removes all item restrictions (rep now covers all items).
 */
export async function clearItems(req, res, next) {
  try {
    const result = await service.clearItems(+req.params.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ─── Report Handler ───────────────────────────────────────────

/**
 * GET /api/reports/representative/:id
 *
 * Query params (all optional):
 *   startDate  - ISO date string
 *   endDate    - ISO date string
 *   areaId     - number
 *   itemId     - number
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     representative: { id, name, isActive },
 *     filters: { areasFilter, itemsFilter, assignedAreas, assignedItems, dateRange },
 *     summary: { totalQuantity, totalValue },
 *     byArea:  [{ areaId, areaName, totalQuantity, totalValue }],
 *     byItem:  [{ itemId, itemName, totalQuantity, totalValue }]
 *   }
 * }
 */
export async function getRepresentativeReport(req, res, next) {
  try {
    const repId = +req.params.id;
    if (!repId || isNaN(repId)) {
      throw new AppError('Invalid representative ID.', 400, 'INVALID_ID');
    }

    const query = {
      startDate:  req.query.startDate || undefined,
      endDate:    req.query.endDate   || undefined,
      areaId:     req.query.areaId    ? +req.query.areaId : undefined,
      itemId:     req.query.itemId    ? +req.query.itemId : undefined,
      fileIds:    parseFileIds(req.query.fileIds || req.query.fileId),
      recordType: req.query.recordType || null,
    };

    const report = await service.getRepresentativeReport(repId, query);
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
}
