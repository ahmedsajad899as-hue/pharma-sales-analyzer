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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'uploads', 'item-docs');
const KINDS = new Set(['photo', 'test', 'registration', 'other']);
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
      const ext = file.mimetype === 'application/pdf' ? '.pdf' : (path.extname(file.originalname).toLowerCase() || '.jpg');
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('الصور أو PDF فقط'), false);
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
      kind: KINDS.has(req.body?.kind) ? req.body.kind : 'other',
      title: String(req.body?.title ?? '').slice(0, 80),
      mime: req.file.mimetype,
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
