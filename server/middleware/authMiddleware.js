import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';

const JWT_SECRET = process.env.JWT_SECRET || 'pharma-sales-secret-key-2026';

/**
 * Middleware: verify JWT Bearer token, attach req.user = { id, username, role }
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'غير مصرح. يرجى تسجيل الدخول.' });
  }
  const token = header.slice(7);
  try {
    // لا انتهاء للجلسة أبداً (طلب المستخدم 2026-11-15): توكنات قديمة صدرت بمدة 7 أيام
    // ما زالت محفوظة في «تبديل الحساب» وكانت تُرجع 401 فتُخرج المستخدم. التوقيع يكفي؛
    // الحساب المعطَّل يُرفض في /api/auth/me.
    const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    req.user = payload; // { id, username, role }
    // التوكن لا ينتهي، فالدور المختوم فيه يبقى قديماً بعد تغيير دور الحساب من السوبر أدمن
    // (موظف مكتب بتوكن «مدير شركة» رأى قائمة مستخدمين فارغة). الدور الحالي من القاعدة.
    if (payload?.role && Number.isInteger(payload.id)) {
      return currentRole(payload.id).then(role => {
        if (role && role !== payload.role) req.user = { ...payload, role };
        next();
      }, () => next());
    }
    next();
  } catch {
    return res.status(401).json({ error: 'الجلسة منتهية. يرجى تسجيل الدخول مجدداً.' });
  }
}

const ROLE_TTL_MS = 60_000;
const roleCache = new Map(); // userId → { role, at }
async function currentRole(userId) {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const role = row?.role ?? null;
  roleCache.set(userId, { role, at: Date.now() });
  return role;
}

/**
 * Middleware: require admin role (must come after requireAuth)
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات المدير.' });
  }
  next();
}

/**
 * Middleware: require admin OR manager role (must come after requireAuth)
 */
export const MANAGER_ROLES = new Set([
  'admin', 'manager', 'company_manager', 'supervisor',
  'product_manager', 'team_leader', 'office_manager',
  'commercial_supervisor', 'commercial_team_leader',
]);

export function requireManagerOrAdmin(req, res, next) {
  if (!MANAGER_ROLES.has(req.user?.role)) {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات المدير.' });
  }
  next();
}
