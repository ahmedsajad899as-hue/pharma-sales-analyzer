import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';

const JWT_SECRET = process.env.JWT_SECRET || 'super_admin_secret_change_in_prod';

// ── Login ─────────────────────────────────────────────────────────────────
export async function loginSuperAdmin(req, res) {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const admin = await prisma.superAdmin.findUnique({ where: { username } });
  if (!admin || !admin.isActive)
    return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: admin.id, isMaster: admin.isMaster, type: 'super_admin' },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    success: true,
    token,
    admin: {
      id: admin.id,
      username: admin.username,
      displayName: admin.displayName,
      isMaster: admin.isMaster,
    },
  });
}

// ── Get profile ───────────────────────────────────────────────────────────
export async function getSuperAdminProfile(req, res) {
  const admin = await prisma.superAdmin.findUnique({
    where: { id: req.superAdmin.id },
    select: { id: true, username: true, displayName: true, isMaster: true, createdAt: true },
  });
  res.json({ success: true, data: admin });
}

// ── List all super admins (master only) ───────────────────────────────────
export async function listSuperAdmins(req, res) {
  const admins = await prisma.superAdmin.findMany({
    select: { id: true, username: true, displayName: true, isMaster: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: admins });
}

// ── Create super admin (master only) ─────────────────────────────────────
export async function createSuperAdmin(req, res) {
  const { username, password, displayName, isMaster = false } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const exists = await prisma.superAdmin.findUnique({ where: { username } });
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.superAdmin.create({
    data: {
      username,
      passwordHash,
      displayName,
      isMaster: Boolean(isMaster),
      createdById: req.superAdmin.id,
    },
    select: { id: true, username: true, displayName: true, isMaster: true, isActive: true, createdAt: true },
  });

  res.status(201).json({ success: true, data: admin });
}

// ── Update super admin ────────────────────────────────────────────────────
export async function updateSuperAdmin(req, res) {
  const id = parseInt(req.params.id);
  const { displayName, password, isActive, isMaster } = req.body;

  const data = {};
  if (displayName !== undefined) data.displayName = displayName;
  if (isActive !== undefined)    data.isActive = Boolean(isActive);
  if (isMaster !== undefined)    data.isMaster = Boolean(isMaster);
  if (password)                  data.passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.superAdmin.update({
    where: { id },
    data,
    select: { id: true, username: true, displayName: true, isMaster: true, isActive: true },
  });

  res.json({ success: true, data: admin });
}

// ── Delete super admin ────────────────────────────────────────────────────
export async function deleteSuperAdmin(req, res) {
  const id = parseInt(req.params.id);
  if (id === req.superAdmin.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });

  await prisma.superAdmin.delete({ where: { id } });
  res.json({ success: true });
}

// ── Impersonate user (view as) ────────────────────────────────────────────
const USER_JWT_SECRET = process.env.JWT_SECRET || 'pharma-sales-secret-key-2026';

export async function impersonateUser(req, res) {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid userId' });

    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, username: true, role: true, isActive: true, linkedRepId: true },
    });
    if (!user)           return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (!user.isActive)  return res.status(403).json({ error: 'المستخدم غير نشط' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      USER_JWT_SECRET,
      { expiresIn: '3h' }
    );

    res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
