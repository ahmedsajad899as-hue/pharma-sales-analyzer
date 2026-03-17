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

// ── List all doctor visits (master only) ──────────────────────────────────
export async function listVisits(req, res) {
  try {
    const { page = 1, limit = 50, repId, userId, doctorId, search, dateFrom, dateTo, officeId, companyId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (repId)    where.scientificRepId = parseInt(repId);
    if (userId)   where.userId          = parseInt(userId);
    if (doctorId) where.doctorId        = parseInt(doctorId);
    if (officeId || companyId) {
      where.user = {};
      if (officeId)  where.user.officeId            = parseInt(officeId);
      if (companyId) where.user.companyAssignments  = { some: { companyId: parseInt(companyId) } };
    }
    if (dateFrom || dateTo) {
      where.visitDate = {};
      if (dateFrom) where.visitDate.gte = new Date(dateFrom);
      if (dateTo)   where.visitDate.lte = new Date(dateTo + 'T23:59:59');
    }
    if (search) {
      where.OR = [
        { doctor:        { name: { contains: search } } },
        { scientificRep: { name: { contains: search } } },
        { user:          { username: { contains: search } } },
        { notes:         { contains: search } },
      ];
    }

    const [visits, total] = await Promise.all([
      prisma.doctorVisit.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { visitDate: 'desc' },
        include: {
          doctor:        { select: { id: true, name: true } },
          scientificRep: { select: { id: true, name: true } },
          user:          { select: { id: true, username: true, displayName: true, office: { select: { id: true, name: true } }, companyAssignments: { select: { company: { select: { id: true, name: true } } } } } },
          item:          { select: { id: true, name: true } },
        },
      }),
      prisma.doctorVisit.count({ where }),
    ]);

    res.json({ success: true, data: visits, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Update a doctor visit (master only) ───────────────────────────────────
export async function updateVisit(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { visitDate, feedback, notes, itemId, isDoubleVisit } = req.body;

    const data = {};
    if (visitDate      !== undefined) data.visitDate      = new Date(visitDate);
    if (feedback       !== undefined) data.feedback       = feedback;
    if (notes          !== undefined) data.notes          = notes;
    if (isDoubleVisit  !== undefined) data.isDoubleVisit  = Boolean(isDoubleVisit);
    if (itemId         !== undefined) data.itemId         = itemId ? parseInt(itemId) : null;

    const visit = await prisma.doctorVisit.update({
      where: { id },
      data,
      include: {
        doctor:        { select: { id: true, name: true } },
        scientificRep: { select: { id: true, name: true } },
        user:          { select: { id: true, username: true, displayName: true } },
        item:          { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, data: visit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Delete a doctor visit (master only) ───────────────────────────────────
export async function deleteVisit(req, res) {
  try {
    const id = parseInt(req.params.id);
    await prisma.doctorVisit.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── List scientific offices for filter dropdowns ───────────────────────────
export async function listOfficesForFilter(req, res) {
  try {
    const offices = await prisma.scientificOffice.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: offices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── List scientific companies for filter dropdowns ─────────────────────────
export async function listCompaniesForFilter(req, res) {
  try {
    const companies = await prisma.scientificCompany.findMany({
      select: { id: true, name: true, office: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: companies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Bulk delete doctor visits ──────────────────────────────────────────────
export async function bulkDeleteVisits(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids required' });

    await prisma.doctorVisit.deleteMany({ where: { id: { in: ids.map(Number) } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── List pharmacy visits (master only) ────────────────────────────────────
export async function listPharmacyVisits(req, res) {
  try {
    const { page = 1, limit = 50, search, dateFrom, dateTo, officeId, companyId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (officeId || companyId) {
      where.user = {};
      if (officeId)  where.user.officeId           = parseInt(officeId);
      if (companyId) where.user.companyAssignments  = { some: { companyId: parseInt(companyId) } };
    }
    if (dateFrom || dateTo) {
      where.visitDate = {};
      if (dateFrom) where.visitDate.gte = new Date(dateFrom);
      if (dateTo)   where.visitDate.lte = new Date(dateTo + 'T23:59:59');
    }
    if (search) {
      where.OR = [
        { pharmacyName:  { contains: search } },
        { areaName:      { contains: search } },
        { scientificRep: { name: { contains: search } } },
        { user:          { username: { contains: search } } },
        { notes:         { contains: search } },
        { area:          { name: { contains: search } } },
      ];
    }

    const [visits, total] = await Promise.all([
      prisma.pharmacyVisit.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { visitDate: 'desc' },
        include: {
          area:          { select: { id: true, name: true } },
          scientificRep: { select: { id: true, name: true } },
          user:          { select: { id: true, username: true, displayName: true, office: { select: { id: true, name: true } }, companyAssignments: { select: { company: { select: { id: true, name: true } } } } } },
          items:         { include: { item: { select: { id: true, name: true } } } },
        },
      }),
      prisma.pharmacyVisit.count({ where }),
    ]);

    res.json({ success: true, data: visits, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Update a pharmacy visit (master only) ─────────────────────────────────
export async function updatePharmacyVisit(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { visitDate, notes, isDoubleVisit, pharmacyName } = req.body;

    const data = {};
    if (visitDate     !== undefined) data.visitDate     = new Date(visitDate);
    if (notes         !== undefined) data.notes         = notes;
    if (isDoubleVisit !== undefined) data.isDoubleVisit = Boolean(isDoubleVisit);
    if (pharmacyName  !== undefined) data.pharmacyName  = pharmacyName;

    const visit = await prisma.pharmacyVisit.update({
      where: { id },
      data,
      include: {
        area:          { select: { id: true, name: true } },
        scientificRep: { select: { id: true, name: true } },
        user:          { select: { id: true, username: true, displayName: true } },
        items:         { include: { item: { select: { id: true, name: true } } } },
      },
    });
    res.json({ success: true, data: visit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Delete a pharmacy visit (master only) ─────────────────────────────────
export async function deletePharmacyVisit(req, res) {
  try {
    const id = parseInt(req.params.id);
    await prisma.pharmacyVisit.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Bulk delete pharmacy visits ────────────────────────────────────────────
export async function bulkDeletePharmacyVisits(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids required' });

    await prisma.pharmacyVisit.deleteMany({ where: { id: { in: ids.map(Number) } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
