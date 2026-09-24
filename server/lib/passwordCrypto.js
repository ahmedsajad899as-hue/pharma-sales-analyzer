// تشفير/فك تشفير عكسي لكلمة مرور المستخدم — يُستخدم فقط لعرضها لاحقاً للماستر
// أدمن (GET /api/sa/users/:id/password). المفتاح مشتق من JWT_SECRET (نفس مفتاح
// إصدار التوكن — راجع super-admin.controller.js) عبر sha256 كي لا نحتاج متغيّر
// بيئة جديد على السيرفر. هذا منفصل تماماً عن passwordHash (bcrypt) المستخدم
// فعلياً في المصادقة — تعطّل فك التشفير هنا لا يكسر تسجيل الدخول أبداً.
import crypto from 'crypto';

const FALLBACK_SECRET = 'pharma-sales-secret-key-2026';

function getKey() {
  const secret = process.env.JWT_SECRET || FALLBACK_SECRET;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptPassword(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map(b => b.toString('base64')).join('.');
}

export function decryptPassword(stored) {
  if (!stored) return null;
  try {
    const [ivB64, tagB64, dataB64] = stored.split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
