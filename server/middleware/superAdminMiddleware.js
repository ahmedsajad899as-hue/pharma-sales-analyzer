import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_admin_secret_change_in_prod';

export function requireSuperAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.type !== 'super_admin')
      return res.status(403).json({ error: 'Access denied' });
    req.superAdmin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireMasterAdmin(req, res, next) {
  requireSuperAdmin(req, res, () => {
    if (!req.superAdmin.isMaster)
      return res.status(403).json({ error: 'Master admin access required' });
    next();
  });
}
