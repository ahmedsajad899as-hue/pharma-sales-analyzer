import { Router } from 'express';
import { getTargets, getAllTargetsForRep, upsertTargets, deleteTarget, getMyTargets, getTargetsMatrix } from './targets.controller.js';

const router = Router();

router.get('/mine',   getMyTargets);
router.get('/matrix', getTargetsMatrix);
router.get('/',     getTargets);
router.get('/all',  getAllTargetsForRep);
router.put('/',     upsertTargets);
router.delete('/:id', deleteTarget);

export default router;
