// ════════════════════════════════════════════════════════════════════════════
// showcase.routes.js — «العرض ثلاثي الأبعاد»: معرض صور حرّ (ايتمات، أشخاص، أماكن…)
// يُعرض بنفس دوّار المجسّمات ثلاثية الأبعاد في الرئيسية.
//
// بلا جدول في القاعدة (لا migration) — نفس نمط itemDocs.js: لكل مستخدم مجلد
// uploads/showcase/<مفتاح>/ فيه الصور + index.json. أسماء الملفات عشوائية لأن
// /uploads يُخدَم علناً. الصور تُصغَّر في المتصفح قبل الرفع (القرص شبه ممتلئ).
// ════════════════════════════════════════════════════════════════════════════

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';

// <جذر المشروع>/uploads — Nginx يخدم /uploads/ من جذر المشروع (راجع itemDocs.js)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'uploads', 'showcase');
const FACES = ['front', 'left', 'right', 'top', 'back', 'bottom'];
const SHAPES = new Set(['box', 'frame']);
const MAX_PER_USER = 60;

const dirFor = (userId) => path.join(ROOT, crypto.createHash('sha1').update(`u${userId}`).digest('hex').slice(0, 20));
const readIndex = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return []; }
};
const writeIndex = (dir, list) => fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(list));
const withUrls = (dir, e) => {
  const base = `/uploads/showcase/${path.basename(dir)}/`;
  const faces = {};
  for (const f of FACES) if (e.files?.[f]) faces[f] = base + e.files[f];
  return { ...e, faces };
};
const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
// الحقول القابلة للتعديل — تُنقّى هنا في الإضافة والتعديل معاً
const pickMeta = (body, prev = {}) => ({
  title:   body.title   !== undefined ? String(body.title).slice(0, 80)    : (prev.title ?? ''),
  caption: body.caption !== undefined ? String(body.caption).slice(0, 120) : (prev.caption ?? ''),
  shape:   SHAPES.has(body.shape) ? body.shape : (prev.shape ?? 'box'),
  depth:   body.depth !== undefined ? clampNum(body.depth, 0.01, 1.2, 0.33) : (prev.depth ?? 0.33),
  scale:   body.scale !== undefined ? clampNum(body.scale, 0.5, 1.6, 1)    : (prev.scale ?? 1),
  spin:    body.spin  !== undefined ? body.spin === true || body.spin === 'true' : (prev.spin ?? false),
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(ROOT, { recursive: true }); cb(null, ROOT); },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/) ?? ['.jpg'])[0];
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: FACES.length },
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype).startsWith('image/')) cb(null, true);
    else cb(new Error('الصور فقط'), false);
  },
});
const uploadFaces = (req, res, next) =>
  upload.fields(FACES.map(name => ({ name, maxCount: 1 })))(req, res, err => err ? res.status(400).json({ error: err.message }) : next());

const router = Router();

/** GET /api/showcase — عناصر المستخدم بترتيب العرض */
router.get('/', (req, res) => {
  const dir = dirFor(req.user.id);
  res.json({ success: true, data: readIndex(dir).map(e => withUrls(dir, e)) });
});

/** POST /api/showcase (multipart: front + left/right/top/back/bottom اختيارية، title, caption, shape, depth, scale, spin) */
router.post('/', uploadFaces, (req, res) => {
  const tmp = Object.values(req.files ?? {}).flat();
  const fail = (code, msg) => { for (const f of tmp) fs.rm(f.path, () => {}); res.status(code).json({ error: msg }); };
  try {
    if (!req.files?.front?.[0]) return fail(400, 'الصورة الأمامية مطلوبة');
    const dir = dirFor(req.user.id);
    fs.mkdirSync(dir, { recursive: true });
    const list = readIndex(dir);
    if (list.length >= MAX_PER_USER) return fail(400, `الحد الأقصى ${MAX_PER_USER} عنصراً`);
    const files = {};
    for (const f of FACES) {
      const file = req.files[f]?.[0];
      if (!file) continue;
      fs.renameSync(file.path, path.join(dir, file.filename));
      files[f] = file.filename;
    }
    const entry = { id: crypto.randomBytes(6).toString('hex'), ...pickMeta(req.body ?? {}), files, at: Date.now() };
    writeIndex(dir, [...list, entry]);
    res.json({ success: true, data: withUrls(dir, entry) });
  } catch (err) { fail(500, err.message); }
});

/** PUT /api/showcase/order { ids } — ترتيب العرض */
router.put('/order', (req, res) => {
  try {
    const dir = dirFor(req.user.id);
    const list = readIndex(dir);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const pos = new Map(ids.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    writeIndex(dir, list);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PATCH /api/showcase/:id { title?, caption?, shape?, depth?, scale?, spin? } */
router.patch('/:id', (req, res) => {
  try {
    const dir = dirFor(req.user.id);
    const list = readIndex(dir);
    const i = list.findIndex(e => e.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'غير موجود' });
    list[i] = { ...list[i], ...pickMeta(req.body ?? {}, list[i]) };
    writeIndex(dir, list);
    res.json({ success: true, data: withUrls(dir, list[i]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/showcase/:id */
router.delete('/:id', (req, res) => {
  try {
    const dir = dirFor(req.user.id);
    const list = readIndex(dir);
    const e = list.find(x => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: 'غير موجود' });
    for (const f of Object.values(e.files ?? {})) fs.rm(path.join(dir, f), () => {});
    writeIndex(dir, list.filter(x => x.id !== e.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
