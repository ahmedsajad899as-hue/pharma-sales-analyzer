import prisma from '../../lib/prisma.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { provinceMemberUserIds } from '../../lib/provinceScope.js';
import {
  resolveEffectiveAreas, resolveEffectiveAreaIds, userHasAllAreas, saveUserAreaAssignments,
} from '../../lib/areaScope.js';

/** أدوار تشرف على شركات مكتبها كلها (رئيسية وثانوية بالتساوي)، لا على شركتها الرئيسية فقط. */
const OFFICE_WIDE_ROLES = new Set(['office_manager', 'office_hr', 'office_employee']);
/** أدوار ترى القائمة فقط بلا تعديل (مناطق/اسم/تفعيل). */
const READ_ONLY_ROLES = new Set(['office_employee']);
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

/**
 * مدير الشركة يرى فقط من تحته في التسلسل الإداري (UserManagerAssignment) —
 * مباشرةً أو عبر تيم ليدر/مشرف تحته — لا كل من شركته الرئيسية شركتُه (كان
 * يُظهر مدير المكتب وموظفي الشركات الأخرى المرتبطين بالشركة).
 */
async function hierarchySubordinateIds(managerId) {
  const seen = new Set();
  let frontier = [managerId];
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const rows = await prisma.userManagerAssignment.findMany({
      where:  { managerId: { in: frontier } },
      select: { userId: true },
    });
    frontier = [];
    for (const r of rows) {
      if (r.userId === managerId || seen.has(r.userId)) continue;
      seen.add(r.userId);
      frontier.push(r.userId);
    }
  }
  return seen;
}

async function canManage(manager, targetUserId) {
  if (!targetUserId || targetUserId === manager.id) return false;
  if (READ_ONLY_ROLES.has(manager.role)) return false;
  if (manager.role === 'company_manager') {
    return (await hierarchySubordinateIds(manager.id)).has(targetUserId);
  }
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

/**
 * المحافظة والقسم (الكرخ/الرصافة) لكل اسم منطقة مطبَّع — من أي صف Area بنفس
 * الاسم يحملهما (صفوف الحسابات الموازية كثيراً ما تكون بلا provinceId، والصف
 * القانوني يحملها). القسم يُفضَّل من أول صف يحمله حتى لو سبقه صف بمحافظة فقط.
 */
async function provinceByAreaName() {
  const rows = await prisma.area.findMany({
    where:  { provinceId: { not: null } },
    select: {
      name: true,
      province:    { select: { name: true } },
      subProvince: { select: { name: true, sortOrder: true } },
    },
    orderBy: { id: 'asc' },
  });
  const map = new Map();
  for (const r of rows) {
    if (!r.province?.name) continue;
    const k = normalizeAreaName(r.name);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, {
        province: r.province.name,
        subProvince: r.subProvince?.name ?? null,
        subProvinceOrder: r.subProvince?.sortOrder ?? null,
      });
    } else if (!cur.subProvince && r.subProvince && r.province.name === cur.province) {
      cur.subProvince = r.subProvince.name;
      cur.subProvinceOrder = r.subProvince.sortOrder;
    }
  }
  return map;
}

const withProvince = (areas, provMap) =>
  areas.map(a => {
    const p = provMap.get(normalizeAreaName(a.name));
    return {
      ...a,
      province: p?.province ?? null,
      subProvince: p?.subProvince ?? null,
      subProvinceOrder: p?.subProvinceOrder ?? null,
    };
  });

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
  const [options, explicit, effectiveIds, provMap] = await Promise.all([
    scopeOptions(scope),
    prisma.userAreaAssignment.findMany({
      where:  { userId: targetUserId },
      select: { area: { select: { id: true, name: true } } },
    }),
    resolveEffectiveAreaIds(targetUserId, { includeRepAreas: false }),
    provinceByAreaName(),
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
  // مناطق داخلة عبر تعيين محافظة/قسم من السوبر أدمن: ما يقع منها داخل نطاق المدير
  // يظهر محدَّداً وقابلاً للتعديل (كان مقفلاً — فتيم ليدر معيَّن على محافظة كاملة
  // لا يمكن تعديل أي منطقة له)؛ ما يقع خارج نطاقه يبقى للعلم فقط.
  // إلغاء أي منها يُحوِّل تعيين المحافظة إلى مناطق صريحة عند الحفظ (applyManagerAreas).
  const provinceAreaIds = new Set();
  const derivedIds = effectiveIds.filter(id => !explicitIdSet.has(id));
  if (derivedIds.length) {
    const derived = await prisma.area.findMany({ where: { id: { in: derivedIds } }, select: { name: true } });
    for (const a of derived) {
      const k = normalizeAreaName(a.name);
      const id = optionByNorm.get(k);
      if (id) {
        if (!assigned.has(id)) provinceAreaIds.add(id);
        assigned.add(id);
        continue;
      }
      if (!locked.has(k)) locked.set(k, { name: a.name, reason: 'province' });
    }
  }

  return {
    allAreas: withProvince(options, provMap),
    assignedAreaIds: [...assigned],
    provinceAreaIds: [...provinceAreaIds],
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

  if (await userHasAllAreas(targetUserId)) {
    throw httpError(409, 'مناطق هذا الحساب مُدارة تلقائياً («كل المناطق») — تُعدَّل من السوبر أدمن فقط.');
  }

  const before = (await prisma.userAreaAssignment.findMany({
    where:  { userId: targetUserId },
    select: { area: { select: { id: true, name: true } } },
  })).map(b => b.area);
  // ما أعطاه السوبر أدمن (أو مدير آخر) خارج نطاق هذا المدير يبقى كما هو.
  const preserved = before.filter(a => !inScope(scope, a.name));

  // المناطق الآتية من تعيين محافظة/قسم (لا من صفوف صريحة).
  const explicitIdSet = new Set(before.map(a => a.id));
  const derivedIdList = (await resolveEffectiveAreaIds(targetUserId, { includeRepAreas: false }))
    .filter(id => !explicitIdSet.has(id));
  const derivedRows = derivedIdList.length
    ? await prisma.area.findMany({ where: { id: { in: derivedIdList } }, select: { id: true, name: true } })
    : [];
  const requestedNorms = new Set(requestedRows.map(a => normalizeAreaName(a.name)));
  const droppedDerived = derivedRows.filter(a => inScope(scope, a.name) && !requestedNorms.has(normalizeAreaName(a.name)));

  let provinceMaterialized = false;
  if (droppedDerived.length === 0) {
    // لم يُلغَ شيء من مناطق المحافظة ⇒ تعيين المحافظة يبقى كما هو (يصل المندوبَ
    // تلقائياً أي منطقة تُضاف لها لاحقاً)، ولا تُكرَّر مناطقه كصفوف صريحة.
    const derivedNorms = new Set(derivedRows.map(a => normalizeAreaName(a.name)));
    const extra = requestedRows.filter(a => !derivedNorms.has(normalizeAreaName(a.name))).map(a => a.id);
    await saveUserAreaAssignments(targetUserId, [...preserved.map(a => a.id), ...extra]);
  } else {
    // إلغاء منطقة من محافظة مُعيَّنة كاملةً لا يتم إلا بتحويل التعيين إلى مناطق
    // صريحة: كل ما كان عنده (بما فيه ما خارج نطاق هذا المدير) ناقص ما أُلغي.
    // يُحذف تعيين المحافظة/القسم أولاً كي تُزامِن saveUserAreaAssignments
    // ScientificRepArea على النطاق الجديد لا القديم؛ ويُعاد إن فشل الحفظ.
    const [provRows, subRows] = await Promise.all([
      prisma.userProvinceAssignment.findMany({ where: { userId: targetUserId } }),
      prisma.userSubProvinceAssignment.findMany({ where: { userId: targetUserId } }),
    ]);
    const derivedOutside = derivedRows.filter(a => !inScope(scope, a.name)).map(a => a.id);
    await prisma.$transaction([
      prisma.userProvinceAssignment.deleteMany({ where: { userId: targetUserId } }),
      prisma.userSubProvinceAssignment.deleteMany({ where: { userId: targetUserId } }),
    ]);
    try {
      await saveUserAreaAssignments(targetUserId, [...preserved.map(a => a.id), ...derivedOutside, ...requested]);
    } catch (e) {
      await prisma.$transaction([
        prisma.userProvinceAssignment.createMany({ data: provRows, skipDuplicates: true }),
        prisma.userSubProvinceAssignment.createMany({ data: subRows, skipDuplicates: true }),
      ]).catch(re => console.error('[company-members] province restore failed:', re.message));
      throw e;
    }
    provinceMaterialized = true;
  }

  // النتيجة = النطاق الفعلي (صريح + محافظة) كما تعرضه قائمة الأعضاء.
  const afterIds = await resolveEffectiveAreaIds(targetUserId, { includeRepAreas: false });
  const after = afterIds.length
    ? await prisma.area.findMany({ where: { id: { in: afterIds } }, select: { id: true, name: true } })
    : [];
  before.push(...derivedRows);
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
          details: JSON.stringify({ targetUserId, added, removed, provinceMaterialized }),
        },
      });
    } catch (e) { console.warn('[company-members] activity log failed (non-fatal):', e.message); }
  }

  return withProvince(dedupeByName(after), await provinceByAreaName());
}

/**
 * مناطق كل عضو الفعلية — نفس مصادر resolveEffectiveAreaIds (includeRepAreas:false)
 * لكن دفعةً واحدة لكل الأعضاء. كانت القائمة تقرأ UserAreaAssignment وحده، فالمندوب
 * المعيَّن من السوبر أدمن على قسم كامل («الرصافة») أو محافظة يظهر للمدير بمنطقتين
 * بدل 65 — بينما السوبر أدمن يراها كاملة.
 */
async function effectiveAreasByMember(members) {
  const ids = members.map(m => m.id);
  const out = new Map(members.map(m => [m.id, m.areaAssignments.map(a => a.area)]));
  if (!ids.length) return out;

  const [provAssign, subAssign, allFlags] = await Promise.all([
    prisma.userProvinceAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, provinceId: true } }),
    prisma.userSubProvinceAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, subProvinceId: true } }),
    Promise.all(ids.map(id => userHasAllAreas(id))),
  ]);
  const allAreaUsers = new Set(ids.filter((_, i) => allFlags[i]));
  const provIds = [...new Set(provAssign.map(r => r.provinceId))];
  const subIds  = [...new Set(subAssign.map(r => r.subProvinceId))];
  if (!allAreaUsers.size && !provIds.length && !subIds.length) return out;

  const areaRows = await prisma.area.findMany({
    where: allAreaUsers.size ? {} : {
      OR: [
        ...(provIds.length ? [{ provinceId: { in: provIds } }] : []),
        ...(subIds.length  ? [{ subProvinceId: { in: subIds } }] : []),
      ],
    },
    select: { id: true, name: true, provinceId: true, subProvinceId: true },
    orderBy: { id: 'asc' },
  });

  for (const m of members) {
    const byId = new Map(out.get(m.id).map(a => [a.id, a]));
    if (allAreaUsers.has(m.id)) {
      for (const a of areaRows) byId.set(a.id, { id: a.id, name: a.name });
    } else {
      const myProv = new Set(provAssign.filter(r => r.userId === m.id).map(r => r.provinceId));
      const mySub  = new Set(subAssign.filter(r => r.userId === m.id).map(r => r.subProvinceId));
      if (!myProv.size && !mySub.size) continue;
      for (const a of areaRows) {
        if ((a.provinceId != null && myProv.has(a.provinceId)) || (a.subProvinceId != null && mySub.has(a.subProvinceId))) {
          if (!byId.has(a.id)) byId.set(a.id, { id: a.id, name: a.name });
        }
      }
    }
    out.set(m.id, [...byId.values()]);
  }
  return out;
}

/** GET /api/company-members — list all users in the manager's companies */
export async function listCompanyMembers(req, res, next) {
  try {
    const managerId = req.user.id;
    const officeWide = isOfficeWide(req.user.role);

    let where;
    if (req.user.role === 'company_manager') {
      // فقط من تحته في التسلسل الإداري
      const subIds = [...(await hierarchySubordinateIds(managerId))];
      if (subIds.length === 0) return res.json({ success: true, data: [] });
      where = { id: { in: subIds } };
    } else {
      const companyIds = await getManagerCompanyIds(managerId, req.user.role);
      if (companyIds.length === 0) return res.json({ success: true, data: [] });
      // Users (excluding self) whose PRIMARY company is one of the manager's companies
      // (or any company, primary or secondary, for an office-wide role)
      where = {
        id: { not: managerId },
        companyAssignments: { some: officeWide ? { companyId: { in: companyIds } } : { companyId: { in: companyIds }, isPrimary: true } },
      };
    }

    const [members, provMap] = await Promise.all([prisma.user.findMany({
      where,
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
          select: { isPrimary: true, company: { select: { id: true, name: true } } },
        },
        managersOfUser: { select: { managerId: true } },
      },
      orderBy: { username: 'asc' },
    }), provinceByAreaName()]);

    const [effective, provinceMembers] = await Promise.all([effectiveAreasByMember(members), provinceMemberUserIds()]);
    const data = members.map(m => ({
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      role: m.role,
      isActive: m.isActive,
      linkedRepId: m.linkedRepId,
      linkedRep: m.linkedRep,
      areas: withProvince(dedupeByName(effective.get(m.id)), provMap),
      companies: m.companyAssignments.map(a => ({ ...a.company, isPrimary: a.isPrimary })),
      managerIds: m.managersOfUser.map(a => a.managerId),
      isProvinceMember: provinceMembers.has(m.id),
    }));

    res.json({ success: true, data, canEdit: !READ_ONLY_ROLES.has(req.user.role) });
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

/**
 * PATCH /api/company-members/:userId — المدير يعدّل اسم مندوبه و/أو يفعّل/يعطّل حسابه.
 * نفس كتابة السوبر أدمن (updateUser): User.displayName + اسم سجلات المندوب العلمي
 * المرتبطة (التقارير والتصديرات تقرأ ScientificRepresentative.name مباشرةً)، فيظهر
 * التغيير عند السوبر أدمن وكل الحسابات. يُسجَّل في ActivityLog (rep_profile_update)
 * فيظهر في «تغييرات المناطق» لدى السوبر أدمن.
 */
export async function updateMember(req, res, next) {
  try {
    const targetUserId = +req.params.userId;
    if (!(await canManage(req.user, targetUserId))) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتعديل هذا المستخدم.' });
    }
    const { displayName, isActive } = req.body ?? {};
    const before = await prisma.user.findUnique({
      where:  { id: targetUserId },
      select: { id: true, username: true, displayName: true, isActive: true },
    });
    if (!before) return res.status(404).json({ error: 'المستخدم غير موجود.' });

    const data = {};
    if (displayName !== undefined) {
      const name = String(displayName ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return res.status(400).json({ error: 'الاسم لا يمكن أن يكون فارغاً.' });
      if (name.length > 120) return res.status(400).json({ error: 'الاسم طويل جداً.' });
      if (name !== (before.displayName ?? '')) data.displayName = name;
    }
    if (isActive !== undefined && Boolean(isActive) !== before.isActive) data.isActive = Boolean(isActive);
    if (!Object.keys(data).length) return res.json({ success: true, data: before });

    const user = await prisma.user.update({
      where: { id: targetUserId }, data,
      select: { id: true, username: true, displayName: true, isActive: true },
    });
    if (data.displayName !== undefined) {
      await prisma.scientificRepresentative.updateMany({
        where: { userId: targetUserId },
        data:  { name: data.displayName },
      });
    }

    try {
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: 'rep_profile_update',
          module: 'company-members',
          details: JSON.stringify({
            targetUserId,
            ...(data.displayName !== undefined ? { oldName: before.displayName || before.username, newName: data.displayName } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          }),
        },
      });
    } catch (e) { console.warn('[company-members] activity log failed (non-fatal):', e.message); }

    res.json({ success: true, data: user });
  } catch (err) { next(err); }
}
