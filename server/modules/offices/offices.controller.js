import prisma from '../../lib/prisma.js';

// ── List all offices ──────────────────────────────────────────────────────
export async function listOffices(req, res) {
  const offices = await prisma.scientificOffice.findMany({
    include: {
      _count: { select: { companies: true, users: true } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: offices });
}

// ── Get single office with companies and users ────────────────────────────
export async function getOffice(req, res) {
  const id = parseInt(req.params.id);
  const office = await prisma.scientificOffice.findUnique({
    where: { id },
    include: {
      companies: {
        include: { _count: { select: { items: true, lines: true } } },
        orderBy: { name: 'asc' },
      },
      users: {
        select: { id: true, username: true, displayName: true, role: true, isActive: true, phone: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!office) return res.status(404).json({ error: 'Office not found' });
  res.json({ success: true, data: office });
}

// ── Create office ─────────────────────────────────────────────────────────
export async function createOffice(req, res) {
  const { name, phone, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const office = await prisma.scientificOffice.create({
    data: { name, phone, address, notes },
  });
  res.status(201).json({ success: true, data: office });
}

// ── Update office ─────────────────────────────────────────────────────────
export async function updateOffice(req, res) {
  const id = parseInt(req.params.id);
  const { name, phone, address, notes, isActive } = req.body;

  const data = {};
  if (name      !== undefined) data.name     = name;
  if (phone     !== undefined) data.phone    = phone;
  if (address   !== undefined) data.address  = address;
  if (notes     !== undefined) data.notes    = notes;
  if (isActive  !== undefined) data.isActive = Boolean(isActive);

  const office = await prisma.scientificOffice.update({ where: { id }, data });
  res.json({ success: true, data: office });
}

// ── Delete office ─────────────────────────────────────────────────────────
export async function deleteOffice(req, res) {
  const id = parseInt(req.params.id);
  await prisma.scientificOffice.delete({ where: { id } });
  res.json({ success: true });
}

// ── List users of an office ───────────────────────────────────────────────
export async function listOfficeUsers(req, res) {
  const officeId = parseInt(req.params.id);
  const users = await prisma.user.findMany({
    where: { officeId },
    select: {
      id: true, username: true, displayName: true, role: true,
      isActive: true, phone: true, permissions: true,
      companyAssignments: { include: { company: { select: { id: true, name: true } } } },
      areaAssignments:    { include: { area:    { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: users });
}

// ── Assign existing user to office ───────────────────────────────────────
export async function assignUserToOffice(req, res) {
  const officeId = parseInt(req.params.id);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = await prisma.user.update({
    where: { id: parseInt(userId) },
    data: { officeId },
    select: { id: true, username: true, displayName: true, role: true },
  });
  res.json({ success: true, data: user });
}
