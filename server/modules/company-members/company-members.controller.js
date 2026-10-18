import prisma from '../../lib/prisma.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import {
  resolveEffectiveAreas, resolveEffectiveAreaIds, userHasAllAreas, saveUserAreaAssignments,
} from '../../lib/areaScope.js';

/** أدوار تشرف على شركات مكتبها كلها (رئيسية وثانوية بالتساوي)، لا على شركتها الرئيسية فقط. */
const OFFICE_WIDE_ROLES = new Set(['office_manager', 'office_hr']);
const isOfficeWide = role => OFFICE_WIDE_ROLES.has(role);

/** Helper: get the PRIMARY company IDs of the requesting manager.
 *  التيم يُبنى على أساس الشركة الرئيسية؛ إن لم تُحدَّد رئيسية بعد نرجع كل الشركات (سلوك قديم آمن).
 *  استثناء: مدير المكتب / HR لا فرق عندهما بين رئيسية وثانوية — كل شركاتهما تابعة لهما بالتساوي. */
async function getManagerCompanyIds(userId, role) {
  const assignments = await prisma.userCompanyAssignment.findMany({
    where: { userId },
    select: { companyId: true, isPrimary: true },
  });
  if (isOfficeWide(role)) return assignments.map(a => a.companyId);
  const primary = assignments.filter(a => a.isPrimary).map(a => a.companyId);
  return primary.length ? primary : assignments.map(a => a.companyId);
}

/** Helper: verify a target user's company (PRIMARY, or any company for an office-wide role) is one of the manager's companies */
async function verifyInSameCompany(managerCompanyIds, targetUserId, officeWide = false) {
  if (managerCompanyIds.length === 0) return false;
  const match = await prisma.userCompanyAssignment.findFirst({
    where: officeWide
      ? { userId: targetUserId, companyId: { in: managerCompanyIds } }
      : { userId: targetUserId, companyId: { in: managerCompanyIds }, isPrimary: true },
  });
  return match !== null;
}

async function canManage(manager, targetUserId) {
  if (!targetUserId || targetUserId === manager.id) return false;
  const companyIds = await getManagerCompanyIds(manager.id, manager.role);
  return verifyInSameCompany(companyIds, targetUserId, isOfficeWide(manager.role));
}

/** صفوف Area بلا تكرار اسم (نفس الاسم بعد التطبيع = منطقة واحدة) للعرض. */
function dedupeByName(areas) {
  const seen = new Map();
  for (const a of areas) {
    const k = normalizeAreaName(a.name);
    if (!seen.has(k)) seen.set(k, a);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

// ════════════════════════════════════════════════════════════════════════════
// تعديل المدير لمناطق مندوبه
// ────────────────────────────────────────────────────────────────────────────
// قبل هذا كانت هذه المسارات تمسح UserAreaAssignment وتكتب اختيار المدير كما هو:
// (أ) تحذف مناطق أعطاها السوبر أدمن للمندوب خارج نطاق هذا المدير؛ (ب) لا تُزامن
// ScientificRepArea فيبقى تقرير المندوب العلمي على المناطق القديمة؛ (ج) تعرض كل
// صفوف Area بلا قيد. الآن:
//   • الخيارات = مناطق المدير نفسه فقط (بالاسم المطبَّع — Area لكل حساب صفّه)،
//     ممثَّلة بالصف القانوني (أقدم id للاسم) — نفس الصف الذي يختاره السوبر أدمن.
//   • الحفظ يدمج: مناطق المندوب خارج نطاق المدير تبقى كما هي، وداخله تُستبدل.
//   • الكتابة عبر saveUserAreaAssignments — نفس مسار السوبر أدمن حرفياً، فيرى
//     الجميع (والسوبر أدمن) التعديل فوراً، ولا تُنشأ منطقة جديدة أبداً.
// ════════════════════════════════════════════════════════════════════════════

/** نطاق المدير: { all: bool, names: Set<norm>|null } */
async function managerScope(managerId) {
  if (await userHasAllAreas(managerId)) return { all: true, names: null };
  const areas = await resolveEffectiveAreas(managerId);
  return { all: false, names: new Set(areas.map(a => normalizeAreaName(a.name))) };
}

const inScope = (scope, name) => scope.all || scope.names.has(normalizeAreaName(name));

/** المنطقة القانونية لكل اسم داخل النطاق (أقدم id) — خيارات القائمة. */
async function scopeOptions(scope) {
  const rows = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  return dedupeByName(rows.filter(a => inScope(scope, a.name)));
}

async function buildAreaState(managerId, targetUserId) {
  const scope = await managerScope(managerId);
  const [options, explicit, effectiveIds] = await Promise.all([
    scopeOptions(scope),
    prisma.userAreaAssignment.findMany({
      where:  { userId: targetUserId },
      select: { area: { select: { id: true, name: true } } },
    }),
    resolveEffectiveAreaIds(targetUserId, { includeRepAreas: false }),
  ]);
  const explicitAreas = explicit.map(e => e.area);
  const explicitIdSet = new Set(explicitAreas.map(a => a.id));
  const optionByNorm  = new Map(options.map(o => [normalizeAreaName(o.name), o.id]));

  const assigned = new Set();
  const locked = new Map(); // norm -> { name, reason }
  for (const a of explicitAreas) {
    const id = optionByNorm.get(normalizeAreaName(a.name));
    if (id) assigned.add(id);
    else locked.set(normalizeAreaName(a.name), { name: a.name, reason: 'outside' });
  }
  // مناطق داخلة عبر تعيين محافظة/قسم من السوبر أدمن — تُعرض للعلم ولا تُعدَّل هنا.
  const derivedIds = effectiveIds.filter(id => !explicitIdSet.has(id));
  if (derivedIds.length) {
    const derived = await prisma.area.findMany({ where: { id: { in: derivedIds } }, select: { name: true } });
    for (const a of derived) {
      const k = normalizeAreaName(a.name);
      const id = optionByNorm.get(k);
      if (id && assigned.has(id)) continue;
      if (!locked.has(k)) locked.set(k, { name: a.name, reason: 'province' });
    }
  }

  return {
    allAreas: options,
    assignedAreaIds: [...assigned],
    lockedAreas: [...locked.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    scopeIsEmpty: !scope.all && scope.names.size === 0,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function applyManagerAreas(manager, targetUserId, areaIds) {
  const scope = await managerScope(manager.id);
  const requested = [...new Set(areaIds.map(Number).filter(Number.isInteger))];
  const requestedRows = requested.length
    ? await prisma.area.findMany({ where: { id: { in: requested } }, select: { id: true, name: true } })
    : [];
  if (requestedRows.length !== requested.length) {
    throw httpError(400, 'بعض المناطق المحددة لم تعد موجودة — حدّث الصفحة وحاول مرة أخرى.');
  }
  const outside = requestedRows.filter(a => !inScope(scope, a.name));
  if (outside.length) {
    throw httpError(400, `مناطق خارج نطاقك: ${outside.map(a => a.name).join('، ')}`);
  }

  const before = (await prisma.userAreaAssignment.findMany({
    where:  { userId: targetUserId },
    select: { area: { select: { id: true, name: true } } },
  })).map(b => b.area);
  // ما أعطاه السوبر أدمن (أو مدير آخر) خارج نطاق هذا المدير يبقى كما هو.
  const preserved = before.filter(a => !inScope(scope, a.name));
  const result = await saveUserAreaAssignments(targetUserId, [...preserved.map(a => a.id), ...requested]);
  if (result.autoManaged) {
    throw httpError(409, 'مناطق هذا الحساب مُدارة تلقائياً («كل المناطق») — تُعدَّل من السوبر أدمن فقط.');
  }

  const after = (await prisma.userAreaAssignment.findMany({
    where:  { userId: targetUserId },
    select: { area: { select: { id: true, name: true } } },
  })).map(r => r.area);
  const beforeNames = new Set(before.map(a => normalizeAreaName(a.name)));
  const afterNames  = new Set(after.map(a => normalizeAreaName(a.name)));
  const added   = dedupeByName(after.filter(a => !beforeNames.has(normalizeAreaName(a.name)))).map(a => a.name);
  const removed = dedupeByName(before.filter(a => !afterNames.has(normalizeAreaName(a.name)))).map(a => a.name);

  if (added.length || removed.length) {
    try {
      await prisma.activityLog.create({
        data: {
          userId: manager.id,
          action: 'rep_areas_update',
          module: 'company-members',
          details: JSON.stringify({ targetUserId, added, removed }),
        },
      });
    } catch (e) { console.warn('[company-members] activity log failed (non-fatal):', e.message); }
  }

  return dedupeByName(after);
}

/** GET /api/company-members — list all users in the manager's companies */
export async function listCompanyMembers(req, res, next) {
  try {
    const managerId = req.user.id;
    const officeWide = isOfficeWide(req.user.role);
    const companyIds = await getManagerCompanyIds(managerId, req.user.role);

    if (companyIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Find all users (excluding self) whose PRIMARY company is one of the manager's companies
    // (or any company, primary or secondary, for an office-wide role)
    const members = await prisma.user.findMany({
      where: {
        id: { not: managerId },
        companyAssignments: { some: officeWide ? { companyId: { in: companyIds } } : { companyId: { in: companyIds }, isPrimary: true } },
      },
      select: {
        id: true,
        username: true,
        displayName: true,
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
      displayName: m.displayName,
      role: m.role,
      isActive: m.isActive,
      linkedRepId: m.linkedRepId,
      linkedRep: m.linkedRep,
      areas: dedupeByName(m.areaAssignments.map(a => a.area)),
      companies: m.companyAssignments.map(a => a.company),
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
}

/** GET /api/company-members/:userId/areas — مناطق نطاق المدير + المحدَّد منها للعضو */
export async function getMemberAreas(req, res, next) {
  try {
    const targetUserId = +req.params.userId;
    if (!(await canManage(req.user, targetUserId))) {
      return res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذا المستخدم.' });
    }
    res.json({ success: true, ...(await buildAreaState(req.user.id, targetUserId)) });
  } catch (err) { next(err); }
}

/** PUT /api/company-members/:userId/areas — تعديل مناطق العضو ضمن نطاق المدير */
export async function setMemberAreas(req, res, next) {
  try {
    const targetUserId = +req.params.userId;
    const { areaIds = [] } = req.body;
    if (!Array.isArray(areaIds)) {
      return res.status(400).json({ error: 'areaIds يجب أن تكون مصفوفة.' });
    }
    if (!(await canManage(req.user, targetUserId))) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتعديل هذا المستخدم.' });
    }
    const areas = await applyManagerAreas(req.user, targetUserId, areaIds);
    res.json({ success: true, areas });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

/** المستخدم المرتبط بسجل مندوب علمي (للمسارين by-rep). */
async function repUserId(repId) {
  const rep = await prisma.scientificRepresentative.findUnique({
    where:  { id: repId },
    select: { userId: true },
  });
  return rep?.userId ?? null;
}

/**
 * GET /api/company-members/by-rep/:repId/areas
 * Get areas for the user linked to a scientific rep (lookup by rep ID)
 */
export async function getRepAreas(req, res, next) {
  try {
    const userId = await repUserId(+req.params.repId);
    if (!userId) {
      return res.json({ success: true, allAreas: [], assignedAreaIds: [], lockedAreas: [], userId: null });
    }
    if (!(await canManage(req.user, userId))) {
      return res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذا المندوب.' });
    }
    res.json({ success: true, ...(await buildAreaState(req.user.id, userId)), userId });
  } catch (err) { next(err); }
}

/**
 * PUT /api/company-members/by-rep/:repId/areas
 * Set area restriction for the user linked to a scientific rep
 */
export async function setRepAreas(req, res, next) {
  try {
    const { areaIds = [] } = req.body;
    if (!Array.isArray(areaIds)) {
      return res.status(400).json({ error: 'areaIds يجب أن تكون مصفوفة.' });
    }
    const userId = await repUserId(+req.params.repId);
    if (!userId) {
      return res.status(404).json({ error: 'المندوب غير مرتبط بحساب مستخدم.' });
    }
    if (!(await canManage(req.user, userId))) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتعديل هذا المندوب.' });
    }
    const areas = await applyManagerAreas(req.user, userId, areaIds);
    res.json({ success: true, areas });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}
