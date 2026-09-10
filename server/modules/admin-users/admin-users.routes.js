import express from 'express';
import multer from 'multer';
import {
  listAllUsers, getUser, createUser, updateUser,
  setUserCompanies, setUserAreas, setUserProvinces, setUserSubProvinces, setUserItems, setUserLines,
  setUserManagers, setUserSubordinates, setUserInteractions, setUserFeatures, setUserAllAreas,
  setUserStockCompanies, setUserStockItems,
  getUserRepInfo, getUserCompanyItems,
  deleteUser,
} from './admin-users.controller.js';
import { previewUsersImport, commitUsersImport } from './admin-users-import.js';
import { requireSuperAdmin } from '../../middleware/superAdminMiddleware.js';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.use(requireSuperAdmin);

router.get('/',            listAllUsers);
router.get('/:id/rep-info',      getUserRepInfo);
router.get('/:id/company-items', getUserCompanyItems);
router.post('/import/preview', upload.single('file'), previewUsersImport);
router.post('/import/commit',  commitUsersImport);
router.get('/:id',         getUser);
router.post('/',           createUser);
router.put('/:id',         updateUser);
router.delete('/:id',      deleteUser);

// Assignment endpoints
router.put('/:id/companies',    setUserCompanies);
router.put('/:id/areas',        setUserAreas);
router.put('/:id/provinces',    setUserProvinces);
router.put('/:id/sub-provinces', setUserSubProvinces);
// راية «كل المناطق والمحافظات تلقائياً» — تُغني عن التعيين اليدوي لحسابات الإدارة
router.put('/:id/all-areas',    setUserAllAreas);
router.put('/:id/items',        setUserItems);
// نطاق ستوك مستقل — راجع server/lib/stockScope.js
router.put('/:id/stock-companies', setUserStockCompanies);
router.put('/:id/stock-items',     setUserStockItems);
router.put('/:id/lines',        setUserLines);
router.put('/:id/managers',     setUserManagers);
router.put('/:id/subordinates', setUserSubordinates);
router.put('/:id/interactions', setUserInteractions);
router.put('/:id/features',     setUserFeatures);

export default router;
