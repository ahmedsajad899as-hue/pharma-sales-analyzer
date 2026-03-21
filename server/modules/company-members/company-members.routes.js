import { Router } from 'express';
import { listCompanyMembers, getMemberAreas, setMemberAreas, getRepAreas, setRepAreas } from './company-members.controller.js';
import { requireAuth } from '../../middleware/authMiddleware.js';

const router = Router();

// Only company_manager (and admins/managers as fallback) can access these
function requireCompanyManagerOrAdmin(req, res, next) {
  const allowed = new Set(['company_manager', 'admin', 'manager']);
  if (!allowed.has(req.user?.role)) {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات مدير الشركة.' });
  }
  next();
}

router.use(requireAuth, requireCompanyManagerOrAdmin);

router.get('/',                     listCompanyMembers);
// Specific routes BEFORE parameterized routes to avoid conflicts
router.get('/by-rep/:repId/areas',  getRepAreas);
router.put('/by-rep/:repId/areas',  setRepAreas);
router.get('/:userId/areas',        getMemberAreas);
router.put('/:userId/areas',        setMemberAreas);

export default router;
