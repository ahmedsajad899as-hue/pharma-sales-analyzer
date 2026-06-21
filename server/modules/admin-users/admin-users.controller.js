import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';

const userSelect = {
  id: true, username: true, displayName: true, role: true,
  isActive: true, phone: true, permissions: true, officeId: true,
  linkedRepId: true,
  createdAt: true,
  office: { select: { id: true, name: true } },
  linkedRep: { select: { id: true, name: true } },
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
      companyAssignments: { include: { company: { select: { id: true, name: true } } } },
      managersOfUser:     { include: { manager: { select: { id: true, username: true, displayName: true } } } },
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
// Features disabled by default for every new user — master admin can re-enable them
const DEFAULT_DISABLED_FEATURES = ['rep_analysis', 'sales_data', 'distributor_sales', 'users_list'];

export async function createUser(req, res) {
  const { username, password, displayName, role = 'scientific_rep', officeId, phone, permissions } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const exists = await prisma.user.findUnique({ where: { username } });
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  // Build default permissions — merge caller-supplied with defaults
  const defaultPerms = { disabledFeatures: DEFAULT_DISABLED_FEATURES, requireGps: true };
  const mergedPerms = permissions
    ? { ...defaultPerms, ...permissions }
    : defaultPerms;

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      displayName,
      role,
      phone,
      officeId: officeId ? parseInt(officeId) : null,
      permissions: JSON.stringify(mergedPerms),
    },
    select: userSelect,
  });
  res.status(201).json({ success: true, data: user });
}

// ── Update user ───────────────────────────────────────────────────────────
export async function updateUser(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { username, displayName, role, isActive, phone, officeId, permissions, password, linkedRepId } = req.body;

    const data = {};
    if (username     !== undefined) data.username    = username;
    if (displayName  !== undefined) data.displayName = displayName;
    if (role         !== undefined) data.role        = role;
    if (isActive     !== undefined) data.isActive    = Boolean(isActive);
    if (phone        !== undefined) data.phone       = phone;
    if (officeId     !== undefined) data.officeId    = officeId ? parseInt(officeId) : null;
    if (permissions  !== undefined) data.permissions = JSON.stringify(permissions);
    if (password)                   data.passwordHash = await bcrypt.hash(password, 12);
    if (linkedRepId !== undefined)  data.linkedRepId  = linkedRepId ? parseInt(linkedRepId) : null;

    const user = await prisma.user.update({ where: { id }, data, select: userSelect });
    res.json({ success: true, data: user });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل.' });
    res.status(500).json({ error: err.message });
  }
}

// ── Rep diagnostic: show all ScientificRepresentative records for a user ─
export async function getUserRepInfo(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, displayName: true, linkedRepId: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // All ScientificRepresentative records with userId = this user
  const repsByUserId = await prisma.scientificRepresentative.findMany({
    where: { userId: id },
    select: {
      id: true, name: true, isActive: true, createdAt: true,
      _count: { select: { doctorVisits: true, pharmacyVisits: true } },
    },
  });

  // The currently linked rep (via linkedRepId)
  let linkedRep = null;
  if (user.linkedRepId) {
    linkedRep = await prisma.scientificRepresentative.findUnique({
      where: { id: user.linkedRepId },
      select: {
        id: true, name: true, isActive: true, userId: true,
        _count: { select: { doctorVisits: true, pharmacyVisits: true } },
      },
    });
  }

  res.json({ success: true, data: { user, linkedRep, repsByUserId } });
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
  const parsedAreaIds = areaIds.map(id => parseInt(id));

  // Resolve area IDs: if this user has a manager, also include the equivalent areas
  // from the manager's account using fuzzy Arabic name matching (handles ة/ه, حي prefix, etc.)
  let finalAreaIds = [...parsedAreaIds];
  try {
    const managerRows = await prisma.userManagerAssignment.findMany({
      where: { userId },
      select: { managerId: true },
    });
    const managerIds = managerRows.map(r => r.managerId);
    if (managerIds.length > 0 && parsedAreaIds.length > 0) {
      const normA = s => String(s || '').trim()
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ')
        .replace(/^(حي |محله |قضاء |ناحيه |ناحية )/, '')
        .toLowerCase().trim();

      const chosenAreas = await prisma.area.findMany({
        where: { id: { in: parsedAreaIds } },
        select: { id: true, name: true },
      });
      const allManagerAreas = await prisma.area.findMany({
        where: { userId: { in: managerIds } },
        select: { id: true, name: true },
      });
      const extraIds = [];
      for (const chosen of chosenAreas) {
        const cN = normA(chosen.name);
        // Inherit the manager's equivalent area ONLY on an exact normalised match.
        // Substring matching (includes) was too loose — e.g. «الحسينية» (norm: الحسينيه)
        // matched «حي الحسين» (norm: الحسين), so the manager's «حي الحسين» kept getting
        // re-added on every save even after the admin explicitly removed it.
        const match = allManagerAreas.find(m => normA(m.name) === cN);
        if (match) extraIds.push(match.id);
      }
      finalAreaIds = [...new Set([...parsedAreaIds, ...extraIds])];
    }
  } catch (e) {
    console.warn('[setUserAreas] manager area resolution failed (non-fatal):', e.message);
    finalAreaIds = parsedAreaIds;
  }

  // Save user area assignments
  await prisma.$transaction([
    prisma.userAreaAssignment.deleteMany({ where: { userId } }),
    ...(finalAreaIds.length ? [prisma.userAreaAssignment.createMany({
      data: finalAreaIds.map(areaId => ({ userId, areaId })),
    })] : []),
  ]);

  // Sync to ScientificRepArea + auto-assign commercial reps if this user is a scientific rep
  try {
    const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } });
    if (userRow?.linkedRepId) {
      const repId = userRow.linkedRepId;

      // 1. Sync ScientificRepArea
      await prisma.$transaction([
        prisma.scientificRepArea.deleteMany({ where: { scientificRepId: repId } }),
        ...(finalAreaIds.length ? [prisma.scientificRepArea.createMany({
          data: finalAreaIds.map(areaId => ({ scientificRepId: repId, areaId })),
          skipDuplicates: true,
        })] : []),
      ]);

      // 2. Auto-assign commercial reps based on area name matching
      if (finalAreaIds.length > 0) {
        const normA = s => String(s || '').trim()
          .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
          .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ')
          .replace(/^(حي |محله |قضاء |ناحيه |ناحية )/, '')
          .toLowerCase().trim();

        // Get the names of the assigned areas
        const assignedAreas = await prisma.area.findMany({
          where: { id: { in: finalAreaIds } },
          select: { id: true, name: true },
        });
        const assignedNormSet = new Set(assignedAreas.map(a => normA(a.name)));

        // Find all Area records (any scope) that are the SAME place as an assigned
        // area — exact normalised match only. Substring matching (includes) was too
        // loose: short norms like «الحسين» matched «الحسينيه», «اور»/«مغرب» matched
        // many unrelated areas, which pulled in commercial reps from places the rep
        // doesn't actually cover. normA already collapses ة/ه, the «حي/محله/...»
        // prefix and diacritics, so genuine cross-file duplicates still match.
        const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
        const matchingAreaIds = allAreas
          .filter(a => assignedNormSet.has(normA(a.name)))
          .map(a => a.id);

        // Find MedicalRepresentative records that cover those areas
        const commercialReps = await prisma.medicalRepresentative.findMany({
          where: { areas: { some: { areaId: { in: matchingAreaIds } } } },
          select: { id: true, name: true },
          orderBy: { id: 'asc' },
        });

        // Deduplicate by normalized name — keep only the first record per unique name
        // (same real person can exist as multiple DB records from different uploaded files)
        const normName = s => String(s || '').trim()
          .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
          .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
        const seenNames = new Set();
        const uniqueReps = commercialReps.filter(r => {
          const n = normName(r.name);
          if (seenNames.has(n)) return false;
          seenNames.add(n);
          return true;
        });

        // Full-replace ScientificRepCommercial based on area-derived reps
        await prisma.$transaction([
          prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId: repId } }),
          ...(uniqueReps.length ? [prisma.scientificRepCommercial.createMany({
            data: uniqueReps.map(r => ({ scientificRepId: repId, commercialRepId: r.id })),
            skipDuplicates: true,
          })] : []),
        ]);
      } else {
        // No areas → clear commercial reps too
        await prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId: repId } });
      }
    }
  } catch (e) {
    console.warn('[setUserAreas] ScientificRepArea/commercial sync failed (non-fatal):', e.message);
  }

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
  const { disabledFeatures = [], requireGps, disableActivityLog, doctorFilterByArea, doctorFilterPlanMode, doctorFilterSurveyOnly } = req.body;

  const existing = await prisma.user.findUnique({ where: { id }, select: { permissions: true } });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  let perms = {};
  try { perms = JSON.parse(existing.permissions || '{}'); } catch {}
  perms.disabledFeatures = disabledFeatures;
  if (requireGps !== undefined) perms.requireGps = Boolean(requireGps);
  if (disableActivityLog !== undefined) perms.disableActivityLog = Boolean(disableActivityLog);
  if (doctorFilterByArea !== undefined)     perms.doctorFilterByArea     = Boolean(doctorFilterByArea);
  if (doctorFilterPlanMode !== undefined)   perms.doctorFilterPlanMode   = String(doctorFilterPlanMode);
  if (doctorFilterSurveyOnly !== undefined) perms.doctorFilterSurveyOnly = Boolean(doctorFilterSurveyOnly);

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
