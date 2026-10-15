/**
 * Quiz Assist (تجريبي) — يقرأ سؤالاً بخياراته من لقطة شاشة أو نص ويقترح الجواب.
 * POST /api/quiz-assist/answer  (multipart: images[] اختياري، text اختياري)
 */
import { Router } from 'express';
import multer from 'multer';
import { callGeminiSmart } from '../ai-assistant/ai-assistant.controller.js';

const router = Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 12 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => (/^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files are allowed.'))),
});

const QUIZ_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];

const QUIZ_PROMPT = `أنت مساعد يقرأ أسئلة الاختيار من متعدد (من لقطة شاشة و/أو نص) ويقترح الجواب الأصح.
قد تحتوي الصورة على أكثر من سؤال — عالجها كلها بالترتيب الذي تظهر به.
لكل سؤال أعد عنصراً في مصفوفة JSON بالشكل:
{"question":"نص السؤال","options":["الخيار 1","الخيار 2"],"answerIndex":0,"answer":"نص الجواب المقترح","confidence":0.0-1.0,"explanation":"تعليل في جملة أو جملتين"}
- answerIndex يبدأ من 0 ويشير إلى موضع الخيار في options؛ اجعله -1 إن كان السؤال بلا خيارات.
- اكتب بلغة السؤال نفسها. confidence تقدير صادق: اخفضه إن كان السؤال غامضاً أو يحتاج معلومة غير موجودة.
- أعد JSON فقط (مصفوفة) بلا أي شرح خارجه ولا علامات markdown.`;

function parseJsonArray(text = '') {
  const cleaned = String(text).replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

router.post('/answer', imageUpload.array('images', 5), async (req, res, next) => {
  try {
    const files = req.files || [];
    const text  = String(req.body?.text || '').trim().slice(0, 8000);
    if (files.length === 0 && !text) {
      return res.status(400).json({ success: false, message: 'أرسل لقطة شاشة أو نص السؤال.' });
    }
    const parts = [text ? `${QUIZ_PROMPT}\n\nنص السؤال:\n${text}` : QUIZ_PROMPT];
    for (const f of files) {
      parts.push({ inlineData: { mimeType: f.mimetype, data: f.buffer.toString('base64') } });
    }
    const raw = await callGeminiSmart(parts, {
      timeoutMs: 60_000, maxTotalMs: 150_000, thinkingBudget: 1024,
      models: QUIZ_MODELS, feature: 'quiz-assist',
    });
    const items = parseJsonArray(raw).map(q => ({
      question:    String(q?.question ?? ''),
      options:     Array.isArray(q?.options) ? q.options.map(String) : [],
      answerIndex: Number.isInteger(q?.answerIndex) ? q.answerIndex : -1,
      answer:      String(q?.answer ?? ''),
      confidence:  Math.max(0, Math.min(1, Number(q?.confidence) || 0)),
      explanation: String(q?.explanation ?? ''),
    }));
    if (items.length === 0) {
      return res.status(422).json({ success: false, message: 'لم أتمكن من قراءة سؤال واضح. جرّب لقطة أوضح.' });
    }
    return res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
});

export default router;
