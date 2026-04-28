import { Router } from 'express';
import { requireAuth } from '../../middleware/authMiddleware.js';
import {
  getArchive,
  getSurveyDoctors,
  addToArchive,
  addCustomDoctor,
  updateArchiveEntry,
  removeFromArchive,
} from './doctor-archive.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/',                     getArchive);
router.get('/survey-doctors',       getSurveyDoctors);
router.post('/custom-doctor',       addCustomDoctor);
router.post('/:surveyDoctorId',     addToArchive);
router.patch('/:surveyDoctorId',    updateArchiveEntry);
router.delete('/:surveyDoctorId',   removeFromArchive);

export default router;
