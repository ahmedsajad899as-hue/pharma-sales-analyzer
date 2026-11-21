import { Router } from 'express';
import { listCompanyMembers, getMemberAreas, setMemberAreas, getRepAreas, setRepAreas, updateMember } from './company-members.controller.js';
import { newUserOptions, newUserCompanyItems, createMemberUser } from './company-members.create.js';
import { requireAuth } from '../../middleware/authMiddleware.js';

const router = Router();

// Only company_manager (and admins/managers as fallback) can access these
function requireCompanyManagerOrAdmin(req, res, next) {
  const allowed = new Set(['company_manager', 'office_hr', 'office_manager', 'office_employee', 'admin', 'manager']);
  if (!allowed.has(req.user?.role)) {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات مدير الشركة.' });
  }
  next();
}

router.use(requireAuth, requireCompanyManagerOrAdmin);

router.get('/',                     listCompanyMembers);
// Specific routes BEFORE parameterized routes to avoid conflicts
// إضافة مستخدم من إدارة المكتب (company-members.create.js — يتحقق من الدور والميزة بنفسه)
router.get('/new-user/options',       newUserOptions);
router.get('/new-user/company-items', newUserCompanyItems);
router.post('/new-user',              createMemberUser);
router.get('/by-rep/:repId/areas',  getRepAreas);
router.put('/by-rep/:repId/areas',  setRepAreas);
router.get('/:userId/areas',        getMemberAreas);
router.put('/:userId/areas',        setMemberAreas);
router.patch('/:userId',            updateMember);

export default router;
