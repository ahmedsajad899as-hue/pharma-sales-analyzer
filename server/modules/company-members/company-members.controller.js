import prisma from '../../lib/prisma.js';

/** Helper: get company IDs that the requesting user (company_manager) is assigned to */
async function getManagerCompanyIds(userId) {
  const assignments = await prisma.userCompanyAssignment.findMany({
    where: { userId },
    select: { companyId: true },
  });
  return assignments.map(a => a.companyId);
}

/** Helper: verify a target userId is in the same companies as the manager */
async function verifyInSameCompany(managerCompanyIds, targetUserId) {
  if (managerCompanyIds.length === 0) return false;
  const match = await prisma.userCompanyAssignment.findFirst({
    where: { userId: targetUserId, companyId: { in: managerCompanyIds } },
  });
  return match !== null;
}

/** GET /api/company-members — list all users in the manager's companies */
export async function listCompanyMembers(req, res, next) {
  try {
    const managerId = req.user.id;
    const companyIds = await getManagerCompanyIds(managerId);

    if (companyIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Find all users (excluding self) in those companies
    const members = await prisma.user.findMany({
      where: {
        id: { not: managerId },
        companyAssignments: { some: { companyId: { in: companyIds } } },
      },
      select: {
        id: true,
        username: true,
        role: true,
        isActive: true,
        linkedRepId: true,
        linkedRep: { select: { id: true, name: true } },
        areaAssignments: {
          select: { area: { select: { id: true, name: true } } },
        },
        companyAssignments: {
          select: { company: { select: { id: true, name: true } } },
        },
      },
      orderBy: { username: 'asc' },
    });

    const data = members.map(m => ({
      id: m.id,
      username: m.username,
      role: m.role,
      isActive: m.isActive,
      linkedRepId: m.linkedRepId,
      linkedRep: m.linkedRep,
      areas: m.areaAssignments.map(a => a.area),
      companies: m.companyAssignments.map(a => a.company),
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

/** GET /api/company-members/:userId/areas — get all areas + user's assigned areas */
export async function getMemberAreas(req, res, next) {
  try {
    const managerId = req.user.id;
    const targetUserId = +req.params.userId;

    const companyIds = await getManagerCompanyIds(managerId);
    const allowed = await verifyInSameCompany(companyIds, targetUserId);
    if (!allowed) {
      return res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذا المستخدم.' });
    }

    const [allAreas, assigned] = await Promise.all([
      prisma.area.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.userAreaAssignment.findMany({
        where: { userId: targetUserId },
        select: { areaId: true },
      }),
    ]);

    res.json({
      success: true,
      allAreas,
      assignedAreaIds: assigned.map(a => a.areaId),
    });
  } catch (err) { next(err); }
}

/** PUT /api/company-members/:userId/areas — set area restriction for a company member */
export async function setMemberAreas(req, res, next) {
  try {
    const managerId = req.user.id;
    const targetUserId = +req.params.userId;
    const { areaIds = [] } = req.body;

    if (!Array.isArray(areaIds)) {
      return res.status(400).json({ error: 'areaIds يجب أن تكون مصفوفة.' });
    }

    const companyIds = await getManagerCompanyIds(managerId);
    const allowed = await verifyInSameCompany(companyIds, targetUserId);
    if (!allowed) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتعديل هذا المستخدم.' });
    }

    // Replace all area assignments for this user
    await prisma.$transaction([
      prisma.userAreaAssignment.deleteMany({ where: { userId: targetUserId } }),
      ...(areaIds.length > 0
        ? [prisma.userAreaAssignment.createMany({
            data: areaIds.map(areaId => ({ userId: targetUserId, areaId: +areaId })),
          })]
        : []),
    ]);

    const updated = await prisma.userAreaAssignment.findMany({
      where: { userId: targetUserId },
      select: { area: { select: { id: true, name: true } } },
    });

    res.json({ success: true, areas: updated.map(a => a.area) });
  } catch (err) { next(err); }
}

/**
 * GET /api/company-members/by-rep/:repId/areas
 * Get areas for the user linked to a scientific rep (lookup by rep ID)
 */
export async function getRepAreas(req, res, next) {
  try {
    const managerId = req.user.id;
    const repId = +req.params.repId;

    // Find the user linked to this rep
    const rep = await prisma.scientificRepresentative.findUnique({
      where: { id: repId },
      select: { userId: true },
    });
    if (!rep?.userId) {
      // No linked user — return all areas with no assignments
      const allAreas = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
      return res.json({ success: true, allAreas, assignedAreaIds: [], userId: null });
    }

    const companyIds = await getManagerCompanyIds(managerId);
    const allowed = await verifyInSameCompany(companyIds, rep.userId);
    if (!allowed) {
      return res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذا المندوب.' });
    }

    const [allAreas, assigned] = await Promise.all([
      prisma.area.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.userAreaAssignment.findMany({
        where: { userId: rep.userId },
        select: { areaId: true },
      }),
    ]);

    res.json({
      success: true,
      allAreas,
      assignedAreaIds: assigned.map(a => a.areaId),
      userId: rep.userId,
    });
  } catch (err) { next(err); }
}

/**
 * PUT /api/company-members/by-rep/:repId/areas
 * Set area restriction for the user linked to a scientific rep
 */
export async function setRepAreas(req, res, next) {
  try {
    const managerId = req.user.id;
    const repId = +req.params.repId;
    const { areaIds = [] } = req.body;

    if (!Array.isArray(areaIds)) {
      return res.status(400).json({ error: 'areaIds يجب أن تكون مصفوفة.' });
    }

    const rep = await prisma.scientificRepresentative.findUnique({
      where: { id: repId },
      select: { userId: true },
    });
    if (!rep?.userId) {
      return res.status(404).json({ error: 'المندوب غير مرتبط بحساب مستخدم.' });
    }

    const companyIds = await getManagerCompanyIds(managerId);
    const allowed = await verifyInSameCompany(companyIds, rep.userId);
    if (!allowed) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتعديل هذا المندوب.' });
    }

    await prisma.$transaction([
      prisma.userAreaAssignment.deleteMany({ where: { userId: rep.userId } }),
      ...(areaIds.length > 0
        ? [prisma.userAreaAssignment.createMany({
            data: areaIds.map(areaId => ({ userId: rep.userId, areaId: +areaId })),
          })]
        : []),
    ]);

    const updated = await prisma.userAreaAssignment.findMany({
      where: { userId: rep.userId },
      select: { area: { select: { id: true, name: true } } },
    });

    res.json({ success: true, areas: updated.map(a => a.area) });
  } catch (err) { next(err); }
}
