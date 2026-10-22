import { Router } from 'express';
import multer from 'multer';
import { handleCommand } from './ai-assistant.controller.js';

const router = Router();

// الواجهة ترسل الأمر النصي كـ FormData — نحلّل الحقول النصية فقط (أُلغي إدخال الصوت).
router.post('/command', multer().none(), handleCommand);

export default router;
