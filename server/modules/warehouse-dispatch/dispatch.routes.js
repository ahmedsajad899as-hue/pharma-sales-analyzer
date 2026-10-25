import { Router } from 'express';
import * as ctrl from './dispatch.controller.js';

const router = Router();

// JWT مطلوب لكل ما تحت /api (بوابة server/index.js). المسارات الثابتة قبل /:id.
router.get('/warehouses', ctrl.listWarehouses);
router.put('/warehouses/:id', ctrl.updateWarehouse);
router.get('/settings', ctrl.getSettings);
router.put('/settings/config', ctrl.setConfig);
router.put('/settings/user/:userId', ctrl.setUserMode);
router.get('/groups', ctrl.listGroups);
router.post('/rep-order/:repOrderId', ctrl.sendRepOrder);

router.get('/', ctrl.list);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.post('/:id/send', ctrl.send);
router.post('/:id/forward', ctrl.forward);
router.post('/:id/status', ctrl.setStatus);

export default router;
