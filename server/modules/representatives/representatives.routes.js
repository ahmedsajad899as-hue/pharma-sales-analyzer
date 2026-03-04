/**
 * Representatives Routes
 *
 * CRUD:
 *   POST   /api/representatives
 *   GET    /api/representatives
 *   GET    /api/representatives/:id
 *   PATCH  /api/representatives/:id
 *   DELETE /api/representatives/:id
 *
 * Assignments:
 *   PUT    /api/representatives/:id/areas
 *   DELETE /api/representatives/:id/areas
 *   PUT    /api/representatives/:id/items
 *   DELETE /api/representatives/:id/items
 *
 * Reports:
 *   GET    /api/reports/representative/:id
 */

import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import {
  CreateRepresentativeDTO,
  UpdateRepresentativeDTO,
  AssignAreasDTO,
  AssignItemsDTO,
} from './representatives.dto.js';
import * as ctrl from './representatives.controller.js';

const router = Router();

// ── CRUD ────────────────────────────────────────────────────
router.post('/',    validate(CreateRepresentativeDTO), ctrl.createRepresentative);
router.get('/',                                        ctrl.listRepresentatives);
router.get('/with-sales-areas',                        ctrl.getRepsWithSalesAreas);
router.get('/:id',                                     ctrl.getRepresentative);
router.patch('/:id', validate(UpdateRepresentativeDTO), ctrl.updateRepresentative);
router.delete('/:id',                                  ctrl.deleteRepresentative);

// ── Area assignments ────────────────────────────────────────
router.put('/:id/areas',                              ctrl.assignAreas);
router.put('/:id/areas/by-name',                      ctrl.assignAreasByName);
router.delete('/:id/areas',                           ctrl.clearAreas);

// ── Item assignments ────────────────────────────────────────
router.put('/:id/items',    validate(AssignItemsDTO), ctrl.assignItems);
router.delete('/:id/items',                           ctrl.clearItems);

export default router;
