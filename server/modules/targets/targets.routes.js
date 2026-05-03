import { Router } from 'express';
import { getTargets, getAllTargetsForRep, upsertTargets, deleteTarget } from './targets.controller.js';

const router = Router();

router.get('/',     getTargets);
router.get('/all',  getAllTargetsForRep);
router.put('/',     upsertTargets);
router.delete('/:id', deleteTarget);

export default router;
