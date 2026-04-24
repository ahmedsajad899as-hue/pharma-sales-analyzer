import { Router } from 'express';
import multer from 'multer';
import { handleCommand, testKey } from './ai-assistant.controller.js';

const upload = multer({ dest: 'uploads/' });
const router = Router();

router.post('/command', upload.single('audio'), handleCommand);
router.get('/test-key', testKey);

export default router;
