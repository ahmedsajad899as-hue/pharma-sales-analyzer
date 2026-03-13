import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';

const userSelect = {
  id: true, username: true, displayName: true, role: true,
  isActive: true, phone: true, permissions: true, officeId: true,
  createdAt: true,
  office: { select: { id: true, name: true } },
  companyAssignments: { include: { company: { select: { id: true, name: true } } } },
  lineAssignments:    { include: { line:    { select: { id: true, name: true, companyId: true } } } },
  itemAssignments:    { include: { item:    { select: { id: true, name: true } } } },
  areaAssignments:    { include: { area:    { select: { id: true, name: true } } } },
  managersOfUser:     { include: { manager: { select: { id: true, username: true, displayName: true } } } },
  subordinatesOfUser: { include: { user:    { select: { id: true, username: true, displayName: true } } } },
  interactionAsActor: { include: { target:  { select: { id: true, username: true, displayName: true } } } },
};

// ── List all users ────────────────────────────────────────────────────────
export async function listAllUsers(req, res) {
  const { officeId, role, isActive } = req.query;
  const where = {};
  if (officeId) where.officeId = parseInt(officeId);
  if (role)     where.role     = role;
  if (isActive !== undefined) where.isActive = isActive === 'true';

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, username: true, displayName: true, role: true,
      isActive: true, phone: true, officeId: true, linkedRepId: true,
      office: { select: { id: true, name: true } },
      _count: { select: { companyAssignments: true, doctorVisits: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: users });
}

// ── Get single user with full details ─────────────────────────────────────
export async function getUser(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, data: user });
}

// ── Create user ───────────────────────────────────────────────────────────
export async function createUser(req, res) {
  const { username, password, displayName, role = 'scientific_rep', officeId, phone, permissions } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const exists = await prisma.user.findUnique({ where: { username } });
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      displayName,
      role,
      phone,
      officeId: officeId ? parseInt(officeId) : null,
      permissions: permissions ? JSON.stringify(permissions) : null,
    },
    select: userSelect,
  });
  res.status(201).json({ success: true, data: user });
}

// ── Update user ───────────────────────────────────────────────────────────
export async function updateUser(req, res) {
  const id = parseInt(req.params.id);
  const { displayName, role, isActive, phone, officeId, permissions, password } = req.body;

  const data = {};
  if (displayName  !== undefined) data.displayName = displayName;
  if (role         !== undefined) data.role        = role;
  if (isActive     !== undefined) data.isActive    = Boolean(isActive);
  if (phone        !== undefined) data.phone       = phone;
  if (officeId     !== undefined) data.officeId    = officeId ? parseInt(officeId) : null;
  if (permissions  !== undefined) data.permissions = JSON.stringify(permissions);
  if (password)                   data.passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.update({ where: { id }, data, select: userSelect });
  res.json({ success: true, data: user });
}

// ── Delete user ───────────────────────────────────────────────────────────
export async function deleteUser(req, res) {
  const id = parseInt(req.params.id);
  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
}

// ── Set user companies (replace all) ─────────────────────────────────────
export async function setUserCompanies(req, res) {
  const userId = parseInt(req.params.id);
  const { companyIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userCompanyAssignment.deleteMany({ where: { userId } }),
    prisma.userCompanyAssignment.createMany({
      data: companyIds.map(id => ({ userId, companyId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user areas ────────────────────────────────────────────────────────
export async function setUserAreas(req, res) {
  const userId = parseInt(req.params.id);
  const { areaIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userAreaAssignment.deleteMany({ where: { userId } }),
    prisma.userAreaAssignment.createMany({
      data: areaIds.map(id => ({ userId, areaId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user items ────────────────────────────────────────────────────────
export async function setUserItems(req, res) {
  const userId = parseInt(req.params.id);
  const { itemIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userItemAssignment.deleteMany({ where: { userId } }),
    prisma.userItemAssignment.createMany({
      data: itemIds.map(id => ({ userId, itemId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user lines ────────────────────────────────────────────────────────
export async function setUserLines(req, res) {
  const userId = parseInt(req.params.id);
  const { lineIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userLineAssignment.deleteMany({ where: { userId } }),
    prisma.userLineAssignment.createMany({
      data: lineIds.map(id => ({ userId, lineId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user managers ─────────────────────────────────────────────────────
export async function setUserManagers(req, res) {
  const userId = parseInt(req.params.id);
  const { managerIds = [] } = req.body;

  await prisma.$transaction([
    prisma.userManagerAssignment.deleteMany({ where: { userId } }),
    prisma.userManagerAssignment.createMany({
      data: managerIds.map(id => ({ userId, managerId: parseInt(id) })),
    }),
  ]);
  res.json({ success: true });
}

// ── Set user features (enable/disable per-user features) ────────────────────
export async function setUserFeatures(req, res) {
  const id = parseInt(req.params.id);
  const { disabledFeatures = [] } = req.body;

  const existing = await prisma.user.findUnique({ where: { id }, select: { permissions: true } });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  let perms = {};
  try { perms = JSON.parse(existing.permissions || '{}'); } catch {}
  perms.disabledFeatures = disabledFeatures;

  const user = await prisma.user.update({
    where: { id },
    data: { permissions: JSON.stringify(perms) },
    select: { id: true, permissions: true },
  });
  res.json({ success: true, data: user });
}

// ── Set interaction permissions ───────────────────────────────────────────
// actorId = req.params.id, targetIds = who they can interact with
export async function setUserInteractions(req, res) {
  const actorId = parseInt(req.params.id);
  const { targets = [] } = req.body;
  // targets: [{ targetId, canTypes: ["orders","reports",...] }, ...]

  await prisma.userInteractionPermission.deleteMany({ where: { actorId } });

  if (targets.length > 0) {
    await prisma.userInteractionPermission.createMany({
      data: targets.map(t => ({
        actorId,
        targetId: parseInt(t.targetId),
        canTypes: JSON.stringify(t.canTypes || []),
      })),
    });
  }
  res.json({ success: true });
}
