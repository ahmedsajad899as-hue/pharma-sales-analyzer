import { Router } from 'express';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { handleCommand } from './ai-assistant.controller.js';

const upload = multer({ dest: 'uploads/' });
const router = Router();

router.post('/command', upload.single('audio'), handleCommand);

// Diagnostic endpoint — test each configured Gemini key
router.get('/test-key', async (_req, res) => {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ].filter(Boolean);
  const results = [];
  for (const key of keys) {
    try {
      const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.0-flash' });
      const r = await model.generateContent('say hi in one word');
      results.push({ prefix: key.slice(0, 12), status: 'ok', response: r.response.text().slice(0, 40) });
    } catch (err) {
      results.push({ prefix: key.slice(0, 12), status: 'error', error: String(err?.message || err).slice(0, 300) });
    }
  }
  res.json({ keyCount: keys.length, results });
});

export default router;
