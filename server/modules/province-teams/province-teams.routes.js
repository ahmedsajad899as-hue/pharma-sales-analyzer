import { Router } from 'express';
import * as ctrl from './province-teams.controller.js';

const router = Router();

// العرض: تغطية المحافظة + الجهد الشخصي جنباً إلى جنب
router.get('/overview', ctrl.overview);
router.get('/months', ctrl.months);
router.get('/directory', ctrl.directory);

// الهيكلية (إدارة المكتب)
router.get('/options', ctrl.options);
router.get('/companies/:id/items', ctrl.companyItems);
router.post('/teams', ctrl.createTeam);
router.patch('/teams/:id', ctrl.updateTeam);
router.delete('/teams/:id', ctrl.archiveTeam);
router.post('/teams/:id/assignments', ctrl.saveAssignment);
router.delete('/assignments/:id', ctrl.removeAssignment);

// الجهد الشخصي (إدخال → اعتماد التيم ليدر)
router.get('/rep-items', ctrl.repItems);
router.get('/personal-sales/pending-count', ctrl.pendingCount);
router.get('/personal-sales', ctrl.listPersonal);
router.post('/personal-sales', ctrl.createPersonal);
router.post('/personal-sales/review', ctrl.reviewPersonal);
router.patch('/personal-sales/:id', ctrl.updatePersonal);
router.delete('/personal-sales/:id', ctrl.deletePersonal);

export default router;
