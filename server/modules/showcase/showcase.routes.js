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
import { callAI, friendlyAiError } from '../../lib/claudeAi.js';

// <جذر المشروع>/uploads — Nginx يخدم /uploads/ من جذر المشروع (راجع itemDocs.js)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'uploads', 'showcase');
// أوجه الصندوق الستة + wrap (بانوراما ملصق الأسطوانة) + cutFront/cutBack (قصّات بشفافية للمجسّم المقصوص)
const FACES = ['front', 'left', 'right', 'top', 'back', 'bottom', 'wrap', 'cutFront', 'cutBack', 'model'];
// box = صندوق، frame = لوحة رقيقة، cylinder = أسطوانة، standee = مجسّم مقصوص (شخص/ملابس/غرض)،
// mesh = مجسّم ثلاثي الأبعاد جاهز (GLB) من المسح بالتصوير (photogrammetry) أو أي مصدر
const SHAPES = new Set(['box', 'frame', 'cylinder', 'standee', 'mesh']);
/** الصورة الإلزامية لكل شكل */
const MAIN_FACE = { box: 'front', frame: 'front', cylinder: 'wrap', standee: 'cutFront', mesh: 'model' };
/** حجم المجسّم الجاهز الأقصى — يُضغط قبل الرفع (القرص شبه ممتلئ) */
const MAX_MODEL_MB = 20;
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
  // الأبعاد الحقيقية بالسنتيمتر من الاستوديو (w/h/d للصندوق، dia/h للأسطوانة)
  dims:    body.dims !== undefined ? pickDims(body.dims) : (prev.dims ?? null),
  cap:     body.cap !== undefined ? (/^#[0-9a-f]{6}$/i.test(String(body.cap)) ? String(body.cap) : null) : (prev.cap ?? null),
  thick:   body.thick !== undefined ? clampNum(body.thick, 0.005, 0.3, 0.06) : (prev.thick ?? null),
  round:   body.round !== undefined ? clampNum(body.round, 0, 0.1, 0.01) : (prev.round ?? null),
});
function pickDims(v) {
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of ['w', 'h', 'd', 'dia']) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = clampNum(o[k], 0.1, 1000, null);
  return Object.keys(out).length ? out : null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(ROOT, { recursive: true }); cb(null, ROOT); },
    filename: (req, file, cb) => {
      const ext = file.fieldname === 'model' ? '.glb'
        : (path.extname(file.originalname).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/) ?? ['.jpg'])[0];
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_MODEL_MB * 1024 * 1024, files: FACES.length },
  fileFilter: (req, file, cb) => {
    // المجسّم GLB: المتصفحات ترسله غالباً octet-stream — يُتحقق من توقيعه بعد الرفع
    if (file.fieldname === 'model') cb(null, /\.glb$/i.test(file.originalname));
    else if (String(file.mimetype).startsWith('image/')) cb(null, true);
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

/** POST /api/showcase (multipart: الصورة الأساسية حسب الشكل + الباقي اختياري، title, caption, shape, depth, scale, spin, dims, cap, thick, round) */
router.post('/', uploadFaces, (req, res) => {
  const tmp = Object.values(req.files ?? {}).flat();
  const fail = (code, msg) => { for (const f of tmp) fs.rm(f.path, () => {}); res.status(code).json({ error: msg }); };
  try {
    const main = MAIN_FACE[SHAPES.has(req.body?.shape) ? req.body.shape : 'box'];
    if (!req.files?.[main]?.[0]) return fail(400, 'الصورة الأساسية للمجسّم مطلوبة');
    // ملف GLB حقيقي يبدأ بالتوقيع «glTF»
    const mf = req.files.model?.[0];
    if (mf) {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(mf.path, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
      if (head.toString('latin1') !== 'glTF') return fail(400, 'الملف ليس مجسّم GLB صالحاً');
    }
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

// ── ذكاء اصطناعي لاستوديو المجسّم (Claude برؤية الصور) ───────────────────────────
// يقترح فقط — المستخدم يرى الاقتراح على الصورة ويعدّله بالسحب قبل أي حفظ.
const firstJson = (txt) => {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('رد غير مفهوم من الذكاء الاصطناعي');
  return JSON.parse(m[0]);
};
const FACE_AR = { front: 'الوجه الأمامي', back: 'الوجه الخلفي', left: 'الجانب الأيسر', right: 'الجانب الأيمن', top: 'السقف (الوجه العلوي)', bottom: 'القاعدة (الوجه السفلي)' };

/** POST /api/showcase/ai/corners { image(base64 jpeg), width, height, kind: 'box'|'cylinder', face? } */
router.post('/ai/corners', async (req, res) => {
  try {
    const { image, width, height, kind, face } = req.body ?? {};
    if (!image || !width || !height) return res.status(400).json({ error: 'الصورة مطلوبة' });
    const target = kind === 'cylinder'
      ? 'the cylindrical product body (bottle / jar / tube / can). Return the 4 corners of the quadrilateral that tightly bounds the visible BODY: its left and right silhouette edges and the top and bottom of the cylindrical part. Exclude the cap/lid/neck/pump, the background and shadows.'
      : `ONE flat rectangular face of a product box - the face that is photographed most frontally (largest and least foreshortened)${face ? ` (the user says it is the box's ${face} face)` : ''}. Return its 4 outer corners exactly on the printed carton edges. Exclude: background, table, shadows, any OTHER face of the box that is visible at an angle, tuck flaps, lids, hands/fingers.`;
    const prompt = `You are a precise computer-vision assistant for building 3D product models from photos.
The image is ${width}x${height} pixels (x to the right, y downward, origin top-left).
Find ${target}
Be precise to a few pixels: place each corner where the two edges of that face meet. If a corner is hidden (e.g. by a finger), extrapolate it from the straight edges.
Reply with ONLY a JSON object, no prose:
{"corners":[[x,y],[x,y],[x,y],[x,y]],"confidence":0.0-1.0,"rotate":0|90|180|270,"note":"short Arabic note"}
Order the corners as they appear in the image: top-left, top-right, bottom-right, bottom-left.
"rotate" = clockwise rotation (degrees) needed so the printed text/design of this face reads upright.`;
    const txt = await callAI([prompt, { inlineData: { mimeType: 'image/jpeg', data: image } }], { feature: 'showcase-studio', timeoutMs: 90_000 });
    const j = firstJson(txt);
    const corners = Array.isArray(j.corners) && j.corners.length === 4
      ? j.corners.map(p => [clampNum(p?.[0], 0, width, 0), clampNum(p?.[1], 0, height, 0)]) : null;
    if (!corners) throw new Error('لم يُحدّد الذكاء الاصطناعي الزوايا');
    res.json({ success: true, data: { corners, confidence: clampNum(j.confidence, 0, 1, 0.5), rotate: [0, 90, 180, 270].includes(j.rotate) ? j.rotate : 0, note: String(j.note ?? '').slice(0, 200) } });
  } catch (err) { res.status(500).json({ error: friendlyAiError(err) }); }
});

/**
 * POST /api/showcase/ai/dims { kind: 'box'|'cylinder', faces: [{ face, image(base64), ratio }] }
 * تقدير الأبعاد الحقيقية بالسنتيمتر من الأوجه المصحَّحة (ratio = عرض/ارتفاع الوجه كما قُصّ) + أي
 * معلومات مطبوعة (عدد الحبات/الأكياس، الحجم بالمل). تقدير فقط — القياس بالمسطرة أدق ويُنصح به.
 */
router.post('/ai/dims', async (req, res) => {
  try {
    const { kind, faces } = req.body ?? {};
    const list = Array.isArray(faces) ? faces.filter(f => f?.image).slice(0, 6) : [];
    if (!list.length) return res.status(400).json({ error: 'أضف صورة وجه واحد على الأقل' });
    const parts = [];
    const shape = kind === 'cylinder'
      ? 'a cylindrical product (bottle/jar/tube/can). Estimate its body diameter "dia" and body height "h"'
      : 'a rectangular product box. Estimate width "w" (horizontal size of the FRONT face), height "h" (vertical size of the FRONT face) and depth "d" (the third dimension = width of the side faces)';
    parts.push(`You are measuring ${shape} in centimeters, as precisely as possible, from perspective-corrected photos of its faces.
Each image below is labelled with its face name and the width/height ratio at which the user cropped it (crops can be slightly off; cross-check the ratios between faces: e.g. front.w = top.w, front.h = side.h, side.w = top.h = depth).
Also use printed information (pack size like "30 sachets"/"10 tablets", volume in ml, standard pharmaceutical carton sizes, an EAN-13 barcode is about 3.73 cm wide at 100%) to fix the absolute scale.
Reply with ONLY JSON: ${kind === 'cylinder' ? '{"dia":cm,"h":cm' : '{"w":cm,"h":cm,"d":cm'},"confidence":0.0-1.0,"note":"short Arabic explanation of how you estimated"}`);
    for (const f of list) {
      parts.push(`Face: ${f.face} (${FACE_AR[f.face] ?? f.face}), cropped ratio w/h = ${Number(f.ratio).toFixed(3)}`);
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.image } });
    }
    const j = firstJson(await callAI(parts, { feature: 'showcase-studio', timeoutMs: 120_000 }));
    const dims = pickDims(j);
    if (!dims) throw new Error('لم يُقدّر الذكاء الاصطناعي الأبعاد');
    res.json({ success: true, data: { dims, confidence: clampNum(j.confidence, 0, 1, 0.5), note: String(j.note ?? '').slice(0, 300) } });
  } catch (err) { res.status(500).json({ error: friendlyAiError(err) }); }
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
