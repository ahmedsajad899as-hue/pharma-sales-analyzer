import jwt from 'jsonwebtoken';

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
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, username, role }
    next();
  } catch {
    return res.status(401).json({ error: 'الجلسة منتهية. يرجى تسجيل الدخول مجدداً.' });
  }
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
export function requireManagerOrAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'manager') {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات المدير.' });
  }
  next();
}
