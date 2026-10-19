// ════════════════════════════════════════════════════════════════════════════
// itemDocs.js — مرفقات الايتم: صور إضافية للمنتج وكتب الفحص والتسجيل.
//
// بلا جدول في القاعدة (لا migration): لكل ايتم مجلد في uploads/item-docs/<مفتاح>/
// فيه الملفات + index.json بالبيانات الوصفية. المفتاح = اسم الايتم المطبَّع
// (normalizeItemKey) مُجزَّأ — لأن نفس الدواء له عدة صفوف Item، فالمرفق يتبع الدواء
// لا صفاً بعينه. أسماء الملفات عشوائية (غير قابلة للتخمين) لأن /uploads يُخدَم علناً.
//
// الصور تُصغَّر في المتصفح قبل الرفع (القرص شبه ممتلئ — راجع server_capacity).
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { normalizeItemKey } from '../../lib/itemResolver.js';

// <جذر المشروع>/uploads لا server/uploads: Nginx يخدم /uploads/ مباشرةً من جذر
// المشروع (alias)، فالملفات تحت server/uploads كانت ترجع 404 ولا تنفتح.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'uploads', 'item-docs');
// pitch = تسجيل صوتي لطريقة شرح الايتم للطبيب.
const KINDS = new Set(['photo', 'test', 'registration', 'other', 'pitch']);
const AUDIO_EXT = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/amr': '.amr', 'audio/3gpp': '.3gp' };
const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const ADMIN_ROLES = new Set(['admin', 'manager', 'office_manager']);
const MAX_PER_ITEM = 40;

const dirFor = (name) => {
  const key = normalizeItemKey(String(name || ''));
  if (!key) return null;
  return path.join(ROOT, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20));
};
const readIndex = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return []; }
};
const writeIndex = (dir, list) => fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(list));
const publicUrl = (dir, file) => `/uploads/item-docs/${path.basename(dir)}/${file}`;

export const itemDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(ROOT, { recursive: true }); cb(null, ROOT); },
    filename: (req, file, cb) => {
      const mime = baseMime(file.mimetype);
      const ext = mime === 'application/pdf' ? '.pdf'
        : AUDIO_EXT[mime] ?? (path.extname(file.originalname).toLowerCase() || (mime.startsWith('audio/') ? '.webm' : '.jpg'));
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = baseMime(file.mimetype);
    if (mime.startsWith('image/') || mime.startsWith('audio/') || mime === 'application/pdf') cb(null, true);
    else cb(new Error('الصور أو PDF أو التسجيلات الصوتية فقط'), false);
  },
});

/** GET /api/reports/item-docs?name=… */
export function listItemDocs(req, res) {
  const dir = dirFor(req.query.name);
  if (!dir) return res.status(400).json({ error: 'اسم الايتم مطلوب' });
  const list = readIndex(dir).map(d => ({ ...d, url: publicUrl(dir, d.file) }));
  res.json({ success: true, data: list.sort((a, b) => b.at - a.at) });
}

/** POST /api/reports/item-docs (multipart: file, name, kind, title?) */
export function addItemDoc(req, res) {
  const tmp = req.file?.path;
  const fail = (code, msg) => { if (tmp) fs.rm(tmp, () => {}); res.status(code).json({ error: msg }); };
  try {
    if (!req.file) return fail(400, 'لا يوجد ملف');
    const dir = dirFor(req.body?.name);
    if (!dir) return fail(400, 'اسم الايتم مطلوب');
    fs.mkdirSync(dir, { recursive: true });
    const list = readIndex(dir);
    if (list.length >= MAX_PER_ITEM) return fail(400, `الحد الأقصى ${MAX_PER_ITEM} مرفقاً لكل ايتم`);
    fs.renameSync(tmp, path.join(dir, req.file.filename));
    const doc = {
      id: crypto.randomBytes(6).toString('hex'),
      file: req.file.filename,
      kind: baseMime(req.file.mimetype).startsWith('audio/') ? 'pitch' : (KINDS.has(req.body?.kind) ? req.body.kind : 'other'),
      title: String(req.body?.title ?? '').slice(0, 80),
      mime: baseMime(req.file.mimetype),
      size: req.file.size,
      at: Date.now(),
      by: req.user?.id ?? null,
      byName: req.user?.displayName || req.user?.username || null,
    };
    writeIndex(dir, [...list, doc]);
    res.json({ success: true, data: { ...doc, url: publicUrl(dir, doc.file) } });
  } catch (err) { fail(500, err.message); }
}

/** DELETE /api/reports/item-docs/:id?name=… — الرافع نفسه أو الإدارة */
export function deleteItemDoc(req, res) {
  try {
    const dir = dirFor(req.query.name);
    if (!dir) return res.status(400).json({ error: 'اسم الايتم مطلوب' });
    const list = readIndex(dir);
    const doc = list.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'غير موجود' });
    if (doc.by !== req.user?.id && !ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'لا تملك صلاحية الحذف' });
    fs.rm(path.join(dir, doc.file), () => {});
    writeIndex(dir, list.filter(d => d.id !== doc.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── بطاقة معلومات الايتم: شرح + الأطباء المستهدفون + نقاط القوة ────────────────
// في نفس مجلد الايتم (info.json) — تتبع الدواء لا صفاً بعينه، مثل المرفقات.
const INFO_FIELDS = ['description', 'targetDoctors', 'strengths'];
const INFO_MAX = 4000;

/** GET /api/reports/item-docs/info?name=… */
export function getItemInfo(req, res) {
  const dir = dirFor(req.query.name);
  if (!dir) return res.status(400).json({ error: 'اسم الايتم مطلوب' });
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8')); } catch {}
  res.json({ success: true, data: info });
}

/** PUT /api/reports/item-docs/info  { name, description, targetDoctors, strengths } */
export function saveItemInfo(req, res) {
  try {
    const dir = dirFor(req.body?.name);
    if (!dir) return res.status(400).json({ error: 'اسم الايتم مطلوب' });
    fs.mkdirSync(dir, { recursive: true });
    const info = { updatedAt: Date.now(), by: req.user?.id ?? null, byName: req.user?.displayName || req.user?.username || null };
    for (const f of INFO_FIELDS) info[f] = String(req.body?.[f] ?? '').slice(0, INFO_MAX);
    fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify(info));
    res.json({ success: true, data: info });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
