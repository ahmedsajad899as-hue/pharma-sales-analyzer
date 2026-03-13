import { Router } from 'express';
import multer from 'multer';
import { handleCommand } from './ai-assistant.controller.js';

const upload = multer({ dest: 'uploads/' });
const router = Router();

router.post('/command', upload.single('audio'), handleCommand);

export default router;
