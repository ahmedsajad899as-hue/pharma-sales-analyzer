import { Router } from 'express';
import { pingActivity, getTeamEngagement } from './engagement.controller.js';

const router = Router();

router.post('/ping', pingActivity);
router.get('/team', getTeamEngagement);

export default router;
