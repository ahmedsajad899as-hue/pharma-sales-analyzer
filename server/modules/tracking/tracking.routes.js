import { Router } from 'express';
import { saveLocation, getLocations, deleteLocations } from './tracking.controller.js';

const router = Router();

router.post('/location',    saveLocation);
router.get('/locations',    getLocations);
router.delete('/locations', deleteLocations);

export default router;
