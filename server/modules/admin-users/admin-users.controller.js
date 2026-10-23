import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma.js';
import { encryptPassword, decryptPassword } from '../../lib/passwordCrypto.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import {
  syncUserAreaDerivedLinks, resolveEffectiveAreaIds, saveUserAreaAssignments,
  ALL_AREAS_ROLES, isAllAreasRole, readAutoAllAreas, userHasAllAreas,
  invalidateAllAreasFlag, ensureLinkedRepId,
} from '../../lib/areaScope.js';
import { PHARMACY_KIND, repSideOf } from '../../lib/pharmacyRep.js';
import { syncUserItemDerivedLinks } from '../../lib/itemScope.js';
import { isOfficeScopedRole, syncOfficeScopedCompanies } from '../../lib/officeScope.js';
import { isProvinceLeader, provinceLeaderIds, syncProvinceLeaderCompanies } from '../../lib/provinceScope.js';
import * as provinceTeamsService from '../province-teams/province-teams.service.js';

const userSelect = {
  id: true, username: true, displayName: true, role: true,
  isActive: true, phone: true, permissions: true, officeId: true,
  linkedRepId: true,
  createdAt: true,
  office: { select: { id: true, name: true } },
  linkedRep: { select: { id: true, name: true, repKind: true } },
  companyAssignments: { include: { company: { select: { id: true, name: true } } } },
  lineAssignments:    { include: { line:    { select: { id: true, name: true, companyId: true } } } },
  itemAssignments:    { include: { item:    { select: { id: true, name: true } } } },
  stockCompanyAssignments: { include: { company: { select: { id: true, name: true } } } },
  stockItemAssignments:    { include: { item:    { select: { id: true, name: true } } } },
  areaAssignments:    { include: { area:    { select: { id: true, name: true } } } },
  provinceAssignments: { include: { province: { select: { id: true, name: true } } } },
  subProvinceAssignments: { include: { subProvince: { select: { id: true, name: true, provinceId: true } } } },
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
      linkedRep: { select: { repKind: true } },
      office: { select: { id: true, name: true } },
      _count: { select: { companyAssignments: true, doctorVisits: true } },
      companyAssignments: { include: { company: { select: { id: true, name: true } } } },
      managersOfUser:     { include: { manager: { select: { id: true, username: true, displayName: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  // المسوقون (فارمسي لاين): قسمهم الكرخ/الرصافة — لترتيب قسم «مسوقين بغداد».
  const marketers = users.filter(u => u.linkedRep?.repKind === PHARMACY_KIND);
  if (marketers.length) {
    const [subRows, areaRows] = await Promise.all([
      prisma.userSubProvinceAssignment.findMany({
        where: { userId: { in: marketers.map(u => u.id) } },
        select: { userId: true, subProvince: { select: { name: true } } },
      }),
      prisma.scientificRepArea.findMany({
        where: { scientificRepId: { in: marketers.map(u => u.linkedRepId).filter(Boolean) } },
        select: { scientificRepId: true, area: { select: { subProvince: { select: { name: true } } } } },
      }),
    ]);
    for (const u of marketers) {
      u.side = repSideOf(
        subRows.filter(r => r.userId === u.id).map(r => r.subProvince.name),
        areaRows.filter(r => r.scientificRepId === u.linkedRepId).map(r => r.area.subProvince?.name),
      );
    }
  }
  res.json({ success: true, data: users });
}

// ── هيكلية المحافظات (للماستر أدمن): فريق لكل محافظة، معزولة عن الشركات ─────
// قائد المحافظة ومندوبوها يظهرون تحت «المحافظات» لا تحت شركة؛ المندوب المشترك
// بين شركتين يُرجَع مرة واحدة بقائمة شركاته.
export async function listProvinceStructure(req, res) {
  const teams = await prisma.provinceTeam.findMany({
    where: { isActive: true },
    orderBy: [{ province: { sortOrder: 'asc' } }, { province: { name: 'asc' } }],
    select: {
      id: true, officeId: true, leaderUserId: true,
      province: { select: { id: true, name: true } },
      assignments: {
        where: { isActive: true },
        orderBy: { id: 'asc' },
        select: {
          repUserId: true, allItems: true,
          company: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      },
    },
  });
  const data = teams.map(t => {
    const reps = new Map();
    for (const a of t.assignments) {
      if (!reps.has(a.repUserId)) reps.set(a.repUserId, { userId: a.repUserId, companies: [] });
      reps.get(a.repUserId).companies.push({
        id: a.company.id, name: a.company.name, allItems: a.allItems, itemCount: a._count.items,
      });
    }
    return {
      id: t.id, officeId: t.officeId, provinceId: t.province.id, provinceName: t.province.name,
      leaderUserId: t.leaderUserId, reps: [...reps.values()],
    };
  });
  const provinces = await prisma.province.findMany({
    select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({ success: true, data, provinces });
}

// ── تعيين/إزالة تيم ليدر محافظة من الماستر أدمن (ينشئ الفريق إن لم يوجد) ─────
// body: { officeId, provinceId, leaderUserId|null }. القائد يصير على كل شركات
// المكتب بلا رئيسية (راجع provinceScope.js)، ويُربط به مندوبو الفريق.
export async function setProvinceLeader(req, res, next) {
  try {
    const officeId = parseInt(req.body?.officeId);
    const provinceId = parseInt(req.body?.provinceId);
    const leaderUserId = req.body?.leaderUserId ? parseInt(req.body.leaderUserId) : null;
    if (!Number.isInteger(officeId) || !Number.isInteger(provinceId)) {
      return res.status(400).json({ error: 'المكتب والمحافظة مطلوبان' });
    }
    const asOffice = { officeId, canEditStructure: true };
    const existing = await prisma.provinceTeam.findUnique({
      where: { officeId_provinceId: { officeId, provinceId } }, select: { id: true, isActive: true },
    });
    if (existing?.isActive) {
      await provinceTeamsService.updateTeam(asOffice, existing.id, { leaderUserId });
    } else {
      await provinceTeamsService.createTeam(asOffice, { provinceId, leaderUserId });
    }
    res.json({ success: true });
  } catch (e) {
    if (e?.isOperational) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
}

// ── Get single user with full details ─────────────────────────────────────
export async function getUser(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!user) return res.status(404).json({ error: 'User not found' });
  // راية «كل المناطق تلقائياً» + العدد الكلي: الواجهة تعرض العدد الفعلي لا عدد
  // صفوف UserAreaAssignment المحفوظة (التي لا تُقرأ أصلاً وقت تفعيل الراية).
  const autoAllAreas = readAutoAllAreas(user.permissions);
  const totalAreaCount = await prisma.area.count();
  res.json({
    success: true,
    data: { ...user, autoAllAreas, autoAllAreasEligible: isAllAreasRole(user.role), totalAreaCount },
  });
}

// ── Get current password (super admin only — راجع passwordCrypto.js) ──────
export async function getUserPassword(req, res) {
  const id = parseInt(req.params.id);
  const user = await prisma.user.findUnique({ where: { id }, select: { passwordEncrypted: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = decryptPassword(user.passwordEncrypted);
  if (password === null) {
    return res.status(404).json({
      error: 'كلمة المرور غير متاحة لهذا الحساب (أُنشئ أو عُدِّل قبل تفعيل هذه الميزة). أعد تعيين كلمة مرور جديدة له لتتمكن من عرضها لاحقاً.',
    });
  }
  res.json({ success: true, password });
}

// ── Create user ───────────────────────────────────────────────────────────
// Features disabled by default for every new user — master admin can re-enable them
export const DEFAULT_DISABLED_FEATURES = ['rep_analysis', 'sales_data', 'distributor_sales', 'users_list'];

// Shared with the bulk-import path (admin-users-import.js) so both single-create
// and bulk-create apply the exact same default permission set.
export function buildDefaultPermissions(customPermissions) {
  const defaultPerms = { disabledFeatures: DEFAULT_DISABLED_FEATURES, requireGps: true };
  return customPermissions ? { ...defaultPerms, ...customPermissions } : defaultPerms;
}

// اسم المستخدم فريد على مستوى النظام كله (كل المكاتب والشركات). عند رفض الاسم
// لا تكفي رسالة «مستخدم بالفعل»: الحساب المالك للاسم قد يكون في مكتب آخر أو
// معطّلاً، فلا يلمحه الأدمن في القائمة أمامه ويظن أنه حذفه سابقاً. لذلك نُرجع
// هوية ذلك الحساب (اسمه الظاهر/مكتبه/حالته/رقمه) لتعرضها الواجهة وتنقل إليه.
async function findUsernameConflict(username, excludeId = null) {
  const existing = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true, username: true, displayName: true, role: true,
      isActive: true, officeId: true, office: { select: { name: true } },
    },
  });
  if (!existing || existing.id === excludeId) return null;
  const where = existing.office?.name ? `المكتب: ${existing.office.name}` : 'بدون مكتب';
  const state = existing.isActive ? 'نشط' : 'معطّل';
  const who = existing.displayName ? `${existing.displayName} · ` : '';
  return {
    error: `اسم المستخدم «${username}» محجوز لحساب موجود فعلاً (${who}${where} · ${state} · رقم الحساب ${existing.id}). `
         + `إن كنت قد حذفت حساباً بهذا الاسم سابقاً فإن الحذف لم يكتمل أو أن هذا حساب آخر يحمل نفس الاسم — `
         + `ابحث عن الاسم في قائمة المستخدمين واحذف الحساب القديم أولاً، أو استخدم اسماً مختلفاً.`,
    code: 'USERNAME_TAKEN',
    existing: {
      id: existing.id, username: existing.username, displayName: existing.displayName,
      role: existing.role, isActive: existing.isActive,
      officeId: existing.officeId, officeName: existing.office?.name ?? null,
    },
  };
}

export async function createUser(req, res) {
  const { password, displayName, role = 'scientific_rep', officeId, phone, permissions } = req.body;
  // trim: مسافة زائدة في الطرف تُنشئ اسماً مختلفاً عن نظيره بصرياً فيتعذّر لاحقاً
  // تسجيل الدخول به ويبدو الاسم «محجوزاً» بلا سبب ظاهر.
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : req.body.username;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const conflict = await findUsernameConflict(username);
  if (conflict) return res.status(409).json(conflict);

  const mergedPerms = buildDefaultPermissions(permissions);

  const passwordHash = await bcrypt.hash(password, 12);
  const passwordEncrypted = encryptPassword(password);
  const parsedOfficeId = officeId ? parseInt(officeId) : null;
  let user;
  try {
    user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        passwordEncrypted,
        displayName,
        role,
        phone,
        officeId: parsedOfficeId,
        permissions: JSON.stringify(mergedPerms),
      },
      select: userSelect,
    });
  } catch (err) {
    // P2002 = خرق قيد التفرّد؛ يحدث لو أُنشئ نفس الاسم بين الفحص أعلاه والكتابة.
    if (err.code === 'P2002') {
      const raced = await findUsernameConflict(username);
      return res.status(409).json(raced ?? { error: 'اسم المستخدم مستخدم بالفعل.', code: 'USERNAME_TAKEN' });
    }
    console.error('[createUser] failed:', err);
    return res.status(500).json({ error: 'حدث خطأ أثناء إنشاء المستخدم.' });
  }

  // الأدوار المكتبية (مدير مكتب/HR/موظف مكتب) لا تُربط بشركة معيّنة — تحصل
  // تلقائياً على كل شركات مكتبها لتتفاعل مع كل بيانات المكتب لا شركة بعينها.
  if (isOfficeScopedRole(role) && parsedOfficeId) {
    await syncOfficeScopedCompanies(user.id, parsedOfficeId);
    user = await prisma.user.findUnique({ where: { id: user.id }, select: userSelect });
  }

  if (req.body.repKind === PHARMACY_KIND && REP_KIND_ROLES.has(role)) {
    await applyRepKind(user.id, role, req.body.repKind);
    user = await prisma.user.findUnique({ where: { id: user.id }, select: userSelect });
  }

  res.status(201).json({ success: true, data: user });
}

// «مندوب فارمسي لاين» / «قائد فريق فارمسي» في نموذج الحساب = scientific_rep /
// team_leader + repKind على سجل المندوب المرتبط (lib/pharmacyRep.js) — لا دور جديد.
const REP_KIND_ROLES = new Set(['scientific_rep', 'team_leader', 'company_manager']); // company_manager = «مدير المسوقين»
async function applyRepKind(userId, role, repKind) {
  if (repKind === undefined || !REP_KIND_ROLES.has(role)) return;
  const kind = repKind === PHARMACY_KIND ? PHARMACY_KIND : 'scientific';
  // لا ننشئ سجل مندوب لمجرد «علمي» — الافتراضي علمي أصلاً.
  const repId = kind === PHARMACY_KIND
    ? await ensureLinkedRepId(userId)
    : (await prisma.user.findUnique({ where: { id: userId }, select: { linkedRepId: true } }))?.linkedRepId;
  if (repId) await prisma.scientificRepresentative.update({ where: { id: repId }, data: { repKind: kind } });
  // المسوق بلا شركة رئيسية: كل شركاته متساوية (راجع setUserCompanies).
  if (kind === PHARMACY_KIND) await prisma.userCompanyAssignment.updateMany({ where: { userId }, data: { isPrimary: true } });
}

// ── Update user ───────────────────────────────────────────────────────────
export async function updateUser(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { username, displayName, role, isActive, phone, officeId, permissions, password, linkedRepId } = req.body;

    const data = {};
    if (username     !== undefined) data.username    = typeof username === 'string' ? username.trim() : username;
    if (displayName  !== undefined) data.displayName = displayName;
    if (role         !== undefined) data.role        = role;
    if (isActive     !== undefined) data.isActive    = Boolean(isActive);
    if (phone        !== undefined) data.phone       = phone;
    if (officeId     !== undefined) data.officeId    = officeId ? parseInt(officeId) : null;
    if (permissions  !== undefined) data.permissions = JSON.stringify(permissions);
    if (password) {
      data.passwordHash = await bcrypt.hash(password, 12);
      data.passwordEncrypted = encryptPassword(password);
    }
    if (linkedRepId !== undefined)  data.linkedRepId  = linkedRepId ? parseInt(linkedRepId) : null;

    if (data.username) {
      const conflict = await findUsernameConflict(data.username, id);
      if (conflict) return res.status(409).json(conflict);
    }

    let user = await prisma.user.update({ where: { id }, data, select: userSelect });

    // تغيّر الدور إلى/داخل الأدوار المكتبية، أو تغيّر المكتب نفسه لمستخدم مكتبي
    // أصلاً: أعد مزامنة شركاته على كل شركات مكتبه الحالي (راجع createUser أعلاه).
    if (isOfficeScopedRole(user.role) && (role !== undefined || officeId !== undefined)) {
      await syncOfficeScopedCompanies(user.id, user.officeId);
      user = await prisma.user.findUnique({ where: { id }, select: userSelect });
    }

    // Keep the linked ScientificRepresentative record(s) in sync. That row's `name`
    // is only set ONCE at auto-creation (from displayName/username) — reports/exports
    // read it directly and never re-derive it from User.displayName afterwards, so a
    // rename here would otherwise silently go stale in every report/Excel export.
    if (displayName !== undefined) {
      await prisma.scientificRepresentative.updateMany({
        where: { userId: id },
        data: { name: displayName || user.username },
      });
    }

    if (req.body.repKind !== undefined) {
      await applyRepKind(id, user.role, req.body.repKind);
      user = await prisma.user.findUnique({ where: { id }, select: userSelect });
    }

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

// ── Items of the user's assigned scientific companies ──────────────────────
// يغذّي تبويب «الايتمات» في صفحة المستخدم: كل ايتمات كتالوج الشركات المعيّنة له
// (Item.scientificCompanyId ∈ شركات المستخدم، isTemp=false)، مجمّعة بمعلومة الشركة.
// المشرف يختار منها القائمة البيضاء (UserItemAssignment)؛ إن لم يختر شيئاً يعمل
// المستخدم على كل هذه الايتمات (السلوك الافتراضي — يُطبَّق في /api/items و getMySharedItems).
export async function getUserCompanyItems(req, res) {
  const userId = parseInt(req.params.id);

  // ?companyIds=1,2,3 ← معاينة فورية لايتمات اختيارٍ لم يُحفظ بعد في تبويب «الشركات».
  // بدونه يعود لسلوكه الأصلي: ايتمات الشركات المحفوظة فعلاً للمستخدم.
  const rawQ = req.query.companyIds;
  const override = typeof rawQ === 'string' && rawQ.trim().length > 0
    ? [...new Set(rawQ.split(',').map(n => parseInt(n)).filter(Number.isInteger))]
    : null;

  let companyIds;
  if (override) {
    companyIds = override;
  } else {
    const companies = await prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { companyId: true },
    });
    companyIds = companies.map(c => c.companyId);
  }
  if (companyIds.length === 0) return res.json({ success: true, data: [] });

  const items = await prisma.item.findMany({
    where: { scientificCompanyId: { in: companyIds }, isTemp: false },
    select: {
      id: true, name: true, scientificCompanyId: true,
      scientificCompany: { select: { id: true, name: true } },
    },
    orderBy: [{ scientificCompanyId: 'asc' }, { name: 'asc' }],
  });
  const data = items.map(i => ({
    id: i.id,
    name: i.name,
    companyId: i.scientificCompanyId,
    companyName: i.scientificCompany?.name ?? '—',
  }));
  res.json({ success: true, data });
}

// ── Delete user ───────────────────────────────────────────────────────────
export async function deleteUser(req, res) {
  const id = parseInt(req.params.id);
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    if (force) {
      // Force delete: remove the user's activity data that blocks deletion at the DB
      // level (the RESTRICT relations named in the error below), then the user.
      // Their CASCADE children (plan entries/comments, invoice items, collections,
      // visit likes/comments…) go automatically. SET NULL relations (sales, uploaded
      // files, and shared/reference entities like items/doctors/pharmacies/areas) are
      // auto-nulled by the DB — kept intact so other users' reports aren't broken.
      // Order matters: rows that point AT the user directly first, then the parents
      // the user owns (whose remaining cascade-children then clear).
      await prisma.$transaction([
        prisma.visitLike.deleteMany({ where: { userId: id } }),
        prisma.visitComment.deleteMany({ where: { userId: id } }),
        prisma.pharmacyVisitLike.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanComment.deleteMany({ where: { userId: id } }),
        prisma.dailyPlanSettings.deleteMany({ where: { userId: id } }),
        prisma.collectionRecord.deleteMany({ where: { collectedById: id } }),
        prisma.commercialInvoice.deleteMany({ where: { OR: [{ createdByUserId: id }, { assignedRepId: id }] } }),
        prisma.invoiceSheet.deleteMany({ where: { repId: id } }),
        prisma.dailyPlan.deleteMany({ where: { userId: id } }),
        prisma.user.delete({ where: { id } }),
      ]);
      return res.json({ success: true, forced: true });
    }
    await prisma.user.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'المستخدم غير موجود أو تم حذفه بالفعل.' });
    }
    // Postgres FK RESTRICT violation (bubbles up from onDelete-default relations
    // like DailyPlan, InvoiceSheet, CommercialInvoice, CollectionRecord, VisitLike/
    // VisitComment): the user has activity data that blocks deletion at the DB level.
    if (err.code === 'P2003' || err.code === 'P2014' || /foreign key constraint/i.test(err.message || '')) {
      return res.status(409).json({
        error: 'لا يمكن حذف هذا المستخدم لأن لديه بيانات مرتبطة (بلان يومي، فواتير تجارية، كشوفات استحصال، أو إعجابات/تعليقات على زيارات). عطّل الحساب بدلاً من حذفه إذا أردت إيقافه دون فقدان هذه البيانات.',
        code: 'HAS_DEPENDENCIES',
      });
    }
    console.error('[deleteUser] failed:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء حذف المستخدم.' });
  }
}

// ── Set user companies (replace all) ─────────────────────────────────────
// primaryCompanyId يحدد الشركة الرئيسية (تكوين التيم/الهيكل على أساسها). رئيسية
// واحدة فقط؛ إن لم تُرسَل أو لم تكن ضمن القائمة → الأولى تصبح رئيسية.
export async function setUserCompanies(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.companyIds) ? req.body.companyIds : [];
  // تطهير المدخلات: أي تكرار في companyIds كان يضرب المفتاح المركّب (userId, companyId)
  // فيُلغي الـtransaction كاملاً ويضيع الحفظ دون رسالة خطأ واضحة.
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, officeId: true, linkedRep: { select: { repKind: true } } } });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    // الأدوار المكتبية مُدارة تلقائياً (كل شركات المكتب) — أي محاولة اختيار
    // يدوي هنا تُتجاهل وتُعاد المزامنة على كل شركات المكتب الحالية بدلاً منها.
    if (isOfficeScopedRole(user.role)) {
      const ids = await syncOfficeScopedCompanies(userId, user.officeId);
      return res.json({
        success: true,
        autoManaged: true,
        data: ids.map(companyId => ({ companyId, isPrimary: true })),
        primaryCompanyId: null,
        dropped: [],
      });
    }

    // تيم ليدر محافظة: بلا شركة رئيسية، شركاته تُختار يدوياً (ليس شرطاً كلها).
    const isProvLeader = await isProvinceLeader(userId);

    // تجاهل أي شركة محذوفة بدل إسقاط الحفظ كله بخطأ مفتاح أجنبي
    const found = requested.length
      ? await prisma.scientificCompany.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(c => c.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    // مدير المكتب: لا فرق بين شركة رئيسية وثانوية — كل شركاته تابعة له بالتساوي، فتُحفظ
    // جميعها isPrimary=true (كل مدراء ومندوبي هذه الشركات يُعتبرون تحت إدارته).
    // مدير المنتج كذلك: بلا شركة رئيسية، شركاته المختارة يدوياً متساوية.
    // المسوق (فارمسي لاين) كذلك: متعدد الشركات بلا رئيسية — كلها متساوية، فيراه مدير كل منها.
    const isOfficeManager = user.role === 'office_manager' || user.role === 'product_manager'
      || user.linkedRep?.repKind === PHARMACY_KIND;
    let primaryId = req.body?.primaryCompanyId != null ? parseInt(req.body.primaryCompanyId) : null;
    if (!Number.isInteger(primaryId) || !ids.includes(primaryId)) primaryId = ids[0] ?? null; // fallback: الأولى

    await prisma.$transaction([
      prisma.userCompanyAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userCompanyAssignment.createMany({
        data: ids.map(id => ({ userId, companyId: id, isPrimary: isProvLeader ? false : (isOfficeManager ? true : id === primaryId) })),
        skipDuplicates: true,
      })] : []),
    ]);

    // مندوب له محافظات ثم أُضيفت له شركات: يُسجَّل في فرق محافظاته الآن.
    try { await provinceTeamsService.autoEnrollRep(userId); }
    catch (e) { console.warn('[setUserCompanies] autoEnrollRep failed (non-fatal):', e.message); }

    // نقرأ المحفوظ فعلاً ونُرجعه للواجهة لتتحقق من النتيجة (لا تكتفي بـ success)
    const saved = await prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { companyId: true, isPrimary: true },
    });
    res.json({
      success: true,
      data: saved.map(a => ({ companyId: a.companyId, isPrimary: a.isPrimary })),
      primaryCompanyId: saved.find(a => a.isPrimary)?.companyId ?? null,
      dropped,
    });
  } catch (err) {
    console.error('[setUserCompanies] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ الشركات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user areas ────────────────────────────────────────────────────────
export async function setUserAreas(req, res) {
  const userId = parseInt(req.params.id);
  const { areaIds = [] } = req.body;
  // المنطق كله في areaScope.js::saveUserAreaAssignments — مشترك مع حفظ المدير
  // لمناطق مندوبيه (company-members) كي يبقى للمناطق مسار كتابة واحد.
  const result = await saveUserAreaAssignments(userId, areaIds);
  if (result.autoManaged) return res.json({ success: true, ...result });
  res.json({ success: true });
}

// ── Set user provinces (المحافظات) ────────────────────────────────────────
// تعيين محافظة = كل مناطقها ضمنياً، الآن ومستقبلاً. لا نُسطِّحها إلى صفوف
// UserAreaAssignment: التسطيح يجمّد القائمة عند لحظة الحفظ، فتغيب أي منطقة
// تدخل المحافظة لاحقاً. التوسيع يحدث وقت الاستعلام في areaScope.js.
export async function setUserProvinces(req, res) {
  const userId = parseInt(req.params.id);
  const { provinceIds = [] } = req.body;
  const ids = [...new Set(provinceIds.map(Number).filter(Number.isInteger))];

  if (await userHasAllAreas(userId)) {
    const effective = await resolveEffectiveAreaIds(userId);
    return res.json({ success: true, autoManaged: true, effectiveAreaCount: effective.length });
  }

  const existing = ids.length
    ? await prisma.province.findMany({ where: { id: { in: ids } }, select: { id: true } })
    : [];
  const validIds = existing.map(p => p.id);

  await prisma.$transaction([
    prisma.userProvinceAssignment.deleteMany({ where: { userId } }),
    ...(validIds.length ? [prisma.userProvinceAssignment.createMany({
      data: validIds.map(provinceId => ({ userId, provinceId })),
      skipDuplicates: true,
    })] : []),
  ]);

  // الروابط المشتقة لقطات — يجب إعادة بنائها لأن نطاق المناطق تغيّر
  try {
    await syncUserAreaDerivedLinks(userId);
  } catch (e) {
    console.warn('[setUserProvinces] derived-link sync failed (non-fatal):', e.message);
  }

  const effectiveAreaIds = await resolveEffectiveAreaIds(userId);
  // تعيين المحافظة لمندوب علمي = تسجيله في فريق تلك المحافظة (غير حابس للحفظ).
  let enrollment = null;
  try { enrollment = await provinceTeamsService.autoEnrollRep(userId); }
  catch (e) { console.warn('[setUserProvinces] autoEnrollRep failed (non-fatal):', e.message); }
  res.json({ success: true, provinceIds: validIds, effectiveAreaCount: effectiveAreaIds.length, enrollment });
}

// ── Set user sub-provinces (أقسام المحافظة: الكرخ/الرصافة) ────────────────
// نفس منطق المحافظات: تعيين قسم = كل مناطقه ضمنياً الآن ومستقبلاً، والتوسيع
// وقت الاستعلام في areaScope.js — فلا نُسطّحه إلى صفوف UserAreaAssignment.
export async function setUserSubProvinces(req, res) {
  const userId = parseInt(req.params.id);
  const { subProvinceIds = [] } = req.body;
  const ids = [...new Set(subProvinceIds.map(Number).filter(Number.isInteger))];

  if (await userHasAllAreas(userId)) {
    const effective = await resolveEffectiveAreaIds(userId);
    return res.json({ success: true, autoManaged: true, effectiveAreaCount: effective.length });
  }

  const existing = ids.length
    ? await prisma.subProvince.findMany({ where: { id: { in: ids } }, select: { id: true } })
    : [];
  const validIds = existing.map(s => s.id);

  await prisma.$transaction([
    prisma.userSubProvinceAssignment.deleteMany({ where: { userId } }),
    ...(validIds.length ? [prisma.userSubProvinceAssignment.createMany({
      data: validIds.map(subProvinceId => ({ userId, subProvinceId })),
      skipDuplicates: true,
    })] : []),
  ]);

  try {
    await syncUserAreaDerivedLinks(userId);
  } catch (e) {
    console.warn('[setUserSubProvinces] derived-link sync failed (non-fatal):', e.message);
  }

  const effectiveAreaIds = await resolveEffectiveAreaIds(userId);
  res.json({ success: true, subProvinceIds: validIds, effectiveAreaCount: effectiveAreaIds.length });
}

// ── Set user items ────────────────────────────────────────────────────────
export async function setUserItems(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    // ايتم محذوف في القائمة كان يُسقط عملية الحفظ بأكملها (FK)
    const found = requested.length
      ? await prisma.item.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(i => i.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userItemAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userItemAssignment.createMany({
        data: ids.map(id => ({ userId, itemId: id })),
        skipDuplicates: true,
      })] : []),
    ]);

    try {
      await syncUserItemDerivedLinks(userId);
    } catch (e) {
      console.warn('[setUserItems] ScientificRepItem sync failed (non-fatal):', e.message);
    }

    const saved = await prisma.userItemAssignment.findMany({ where: { userId }, select: { itemId: true } });
    res.json({ success: true, data: saved.map(a => a.itemId), dropped });
  } catch (err) {
    console.error('[setUserItems] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ الايتمات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user stock scope (UserStockCompanyAssignment / UserStockItemAssignment) ────
// مستقل تماماً عن companyAssignments/itemAssignments أعلاه — نطاق خاص بصفحتي
// «Stock» و«رصيد المذاخر» فقط (راجع server/lib/stockScope.js). فارغ = بلا تقييد،
// متاح لأي دور بما فيها الأدوار المكتبية (بعكس تبويب «الشركات» العادي).
export async function setUserStockCompanies(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.companyIds) ? req.body.companyIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const found = requested.length
      ? await prisma.scientificCompany.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(c => c.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userStockCompanyAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userStockCompanyAssignment.createMany({
        data: ids.map(companyId => ({ userId, companyId })),
        skipDuplicates: true,
      })] : []),
    ]);

    const saved = await prisma.userStockCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    res.json({ success: true, data: saved.map(a => a.companyId), dropped });
  } catch (err) {
    console.error('[setUserStockCompanies] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ نطاق شركات الستوك — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

export async function setUserStockItems(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const found = requested.length
      ? await prisma.item.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(i => i.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userStockItemAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userStockItemAssignment.createMany({
        data: ids.map(itemId => ({ userId, itemId })),
        skipDuplicates: true,
      })] : []),
    ]);

    const saved = await prisma.userStockItemAssignment.findMany({ where: { userId }, select: { itemId: true } });
    res.json({ success: true, data: saved.map(a => a.itemId), dropped });
  } catch (err) {
    console.error('[setUserStockItems] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ نطاق ايتمات الستوك — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
}

// ── Set user lines ────────────────────────────────────────────────────────
export async function setUserLines(req, res) {
  const userId = parseInt(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  const raw = Array.isArray(req.body?.lineIds) ? req.body.lineIds : [];
  const requested = [...new Set(raw.map(id => parseInt(id)).filter(Number.isInteger))];

  try {
    const found = requested.length
      ? await prisma.productLine.findMany({ where: { id: { in: requested } }, select: { id: true } })
      : [];
    const validSet = new Set(found.map(l => l.id));
    const ids = requested.filter(id => validSet.has(id));
    const dropped = requested.filter(id => !validSet.has(id));

    await prisma.$transaction([
      prisma.userLineAssignment.deleteMany({ where: { userId } }),
      ...(ids.length ? [prisma.userLineAssignment.createMany({
        data: ids.map(id => ({ userId, lineId: id })),
        skipDuplicates: true,
      })] : []),
    ]);

    const saved = await prisma.userLineAssignment.findMany({ where: { userId }, select: { lineId: true } });
    res.json({ success: true, data: saved.map(a => a.lineId), dropped });
  } catch (err) {
    console.error('[setUserLines] failed for user', userId, err);
    res.status(500).json({ error: 'فشل حفظ اللاينات — لم يتغيّر شيء. حاول مرة أخرى.' });
  }
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

// ── Set user subordinates (عكس setUserManagers: من حساب المدير نفسه، يختار
// أي المستخدمين هو مديرهم — تعيين سريع بدل الدخول لكل حساب على حدة). يمسّ فقط
// صفوف UserManagerAssignment التي managerId فيها = هذا الحساب، فلا يمحو مديرين
// آخرين مُعيَّنين لنفس الموظف من جهة أخرى.
export async function setUserSubordinates(req, res) {
  const managerId = parseInt(req.params.id);
  const { userIds = [] } = req.body;
  const ids = [...new Set(userIds.map(n => parseInt(n)))].filter(id => Number.isInteger(id) && id !== managerId);

  await prisma.$transaction([
    prisma.userManagerAssignment.deleteMany({ where: { managerId, userId: { notIn: ids } } }),
    ...(ids.length ? [prisma.userManagerAssignment.createMany({
      data: ids.map(userId => ({ userId, managerId })),
      skipDuplicates: true,
    })] : []),
  ]);
  res.json({ success: true });
}

// ── Sync a manager's companies + items down to their whole subtree ─────────
// زر «مزامنة» في تبويب «الموظفون»: يأخذ شركات وايتمات هذا الحساب (عادة مدير
// شركة) ويطبّقها حرفياً على كل من تحته في التسلسل الإداري — مباشرين وغير
// مباشرين، عبر UserManagerAssignment (BFS بحماية من الحلقات) — بدل الدخول
// لكل حساب على حدة وتكرار نفس الاختيار يدوياً.
export async function syncManagerScopeToSubordinates(req, res) {
  const managerId = parseInt(req.params.id);
  if (!Number.isInteger(managerId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });

  try {
    const manager = await prisma.user.findUnique({
      where: { id: managerId },
      select: {
        id: true, role: true,
        companyAssignments: { select: { companyId: true, isPrimary: true } },
        itemAssignments: { select: { itemId: true } },
      },
    });
    if (!manager) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (isOfficeScopedRole(manager.role)) {
      return res.status(400).json({ error: 'هذا الدور يعمل على مستوى المكتب — لا شركات يدوية لمزامنتها.' });
    }

    const companyIds = manager.companyAssignments.map(a => a.companyId);
    const primaryCompanyId = manager.companyAssignments.find(a => a.isPrimary)?.companyId ?? companyIds[0] ?? null;
    const itemIds = manager.itemAssignments.map(a => a.itemId);

    // كل التابعين (مباشر وغير مباشر) — BFS على UserManagerAssignment
    const subordinateIds = new Set();
    let frontier = [managerId];
    while (frontier.length) {
      const rows = await prisma.userManagerAssignment.findMany({
        where: { managerId: { in: frontier } },
        select: { userId: true },
      });
      const next = [];
      for (const r of rows) {
        if (r.userId !== managerId && !subordinateIds.has(r.userId)) {
          subordinateIds.add(r.userId);
          next.push(r.userId);
        }
      }
      frontier = next;
    }

    const targetIds = [...subordinateIds];
    if (!targetIds.length) {
      return res.json({ success: true, affectedCount: 0, companyIds, itemIds });
    }

    const targets = await prisma.user.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, role: true },
    });

    for (const t of targets) {
      const ops = [];
      // الأدوار المكتبية تُدار تلقائياً (كل شركات المكتب) — لا نلمس شركاتها هنا
      if (!isOfficeScopedRole(t.role)) {
        ops.push(
          prisma.userCompanyAssignment.deleteMany({ where: { userId: t.id } }),
          ...(companyIds.length ? [prisma.userCompanyAssignment.createMany({
            data: companyIds.map(cid => ({ userId: t.id, companyId: cid, isPrimary: cid === primaryCompanyId })),
            skipDuplicates: true,
          })] : []),
        );
      }
      ops.push(
        prisma.userItemAssignment.deleteMany({ where: { userId: t.id } }),
        ...(itemIds.length ? [prisma.userItemAssignment.createMany({
          data: itemIds.map(iid => ({ userId: t.id, itemId: iid })),
          skipDuplicates: true,
        })] : []),
      );
      await prisma.$transaction(ops);
      try {
        await syncUserItemDerivedLinks(t.id);
      } catch (e) {
        console.warn('[syncManagerScopeToSubordinates] item link sync failed (non-fatal) for user', t.id, e.message);
      }
    }

    res.json({ success: true, affectedCount: targets.length, companyIds, itemIds });
  } catch (err) {
    console.error('[syncManagerScopeToSubordinates] failed for manager', managerId, err);
    res.status(500).json({ error: 'فشلت المزامنة — حاول مرة أخرى.' });
  }
}

// ── Copy a province leader's companies + items to the other province leaders ─
// body: { targetIds?: number[] } — بدونها تُطبَّق على كل قادة المحافظات الآخرين في
// المكتب. تستبدل شركاتهم وايتماتهم بنفس اختيار هذا القائد (بلا رئيسية)، ويبقى
// تعديل كل واحد منهم بعدها يدوياً.
export async function syncProvinceLeaderScope(req, res) {
  const sourceId = parseInt(req.params.id);
  if (!Number.isInteger(sourceId)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });
  try {
    const source = await prisma.user.findUnique({
      where: { id: sourceId },
      select: {
        id: true, officeId: true,
        companyAssignments: { select: { companyId: true } },
        itemAssignments: { select: { itemId: true } },
      },
    });
    if (!source) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (!source.officeId || !(await isProvinceLeader(sourceId))) {
      return res.status(400).json({ error: 'هذا الحساب ليس تيم ليدر محافظة.' });
    }
    const companyIds = source.companyAssignments.map(a => a.companyId);
    const itemIds = source.itemAssignments.map(a => a.itemId);

    const leaders = await provinceLeaderIds(source.officeId);
    leaders.delete(sourceId);
    let targetIds = [...leaders];
    if (Array.isArray(req.body?.targetIds)) {
      const wanted = new Set(req.body.targetIds.map(n => parseInt(n)));
      targetIds = targetIds.filter(id => wanted.has(id));
    }
    for (const uid of targetIds) {
      await prisma.$transaction([
        prisma.userCompanyAssignment.deleteMany({ where: { userId: uid } }),
        ...(companyIds.length ? [prisma.userCompanyAssignment.createMany({
          data: companyIds.map(companyId => ({ userId: uid, companyId, isPrimary: false })),
          skipDuplicates: true,
        })] : []),
        prisma.userItemAssignment.deleteMany({ where: { userId: uid } }),
        ...(itemIds.length ? [prisma.userItemAssignment.createMany({
          data: itemIds.map(itemId => ({ userId: uid, itemId })),
          skipDuplicates: true,
        })] : []),
      ]);
      try { await syncUserItemDerivedLinks(uid); }
      catch (e) { console.warn('[syncProvinceLeaderScope] item link sync failed (non-fatal) for user', uid, e.message); }
    }
    res.json({ success: true, affectedCount: targetIds.length, companyIds, itemIds });
  } catch (err) {
    console.error('[syncProvinceLeaderScope] failed for', sourceId, err);
    res.status(500).json({ error: 'فشل التطبيق — حاول مرة أخرى.' });
  }
}

// ── Set user features (enable/disable per-user features) ────────────────────
export async function setUserFeatures(req, res) {
  const id = parseInt(req.params.id);
  const { disabledFeatures = [], enabledFeatures, requireGps, disableActivityLog, doctorFilterByArea, doctorFilterPlanMode, doctorFilterSurveyOnly, hiddenFromOrgChart, defaultReportView, timeTheme } = req.body;

  const existing = await prisma.user.findUnique({ where: { id }, select: { permissions: true } });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  let perms = {};
  try { perms = JSON.parse(existing.permissions || '{}'); } catch {}
  perms.disabledFeatures = disabledFeatures;
  // ميزات الاشتراك (OPT_IN_FEATURES في featureConfig.ts) المفعّلة صراحةً — مطفأة ما لم تكن هنا
  if (Array.isArray(enabledFeatures)) perms.enabledFeatures = enabledFeatures.map(String);
  if (requireGps !== undefined) perms.requireGps = Boolean(requireGps);
  if (disableActivityLog !== undefined) perms.disableActivityLog = Boolean(disableActivityLog);
  if (doctorFilterByArea !== undefined)     perms.doctorFilterByArea     = Boolean(doctorFilterByArea);
  if (doctorFilterPlanMode !== undefined)   perms.doctorFilterPlanMode   = String(doctorFilterPlanMode);
  if (doctorFilterSurveyOnly !== undefined) perms.doctorFilterSurveyOnly = Boolean(doctorFilterSurveyOnly);
  // الخانة (مبيعات/ارجاعات/صافي) التي تُفتح تلقائياً عند دخول صفحة التقارير
  // والتحليل (تجاري أو علمي) — راجع getDefaultReportView في AuthContext.
  if (defaultReportView !== undefined && ['sales', 'returns', 'net'].includes(defaultReportView)) {
    perms.defaultReportView = defaultReportView;
  }
  // إخفاء بصري بحت من شجرة «الهيكلية» (/api/my-company-org) — لا يمسّ صلاحيات
  // الحساب ولا بياناته ولا نتائجه إطلاقاً. راجع reparentAroundHidden في server/index.js.
  if (hiddenFromOrgChart !== undefined) perms.hiddenFromOrgChart = Boolean(hiddenFromOrgChart);
  // ثيم الوقت: خلفية تتبع ساعة المستخدم — معطّل افتراضياً، يُفعَّل لحساب بعينه
  // (راجع src/lib/timeTheme.ts).
  if (timeTheme !== undefined) perms.timeTheme = Boolean(timeTheme);

  const user = await prisma.user.update({
    where: { id },
    data: { permissions: JSON.stringify(perms) },
    select: { id: true, permissions: true },
  });
  invalidateAllAreasFlag(id); // permissions تغيّرت — أسقِط الراية المخزّنة مؤقتاً
  res.json({ success: true, data: user });
}

// ── تفعيل/تعطيل ميزة واحدة لعدد من الحسابات دفعة واحدة ─────────────────────
// PUT /api/sa/users/bulk-features  { userIds: number[], featureKey: string, enabled: boolean }
// يُضيف/يُزيل featureKey فقط من disabledFeatures لكل حساب (لا يمسّ باقي ميزاته
// المحفوظة)، بخلاف setUserFeatures أعلاه الذي يستبدل القائمة كاملة لحساب واحد.
export async function bulkSetUserFeature(req, res) {
  const { userIds, featureKey, enabled } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'اختر حساباً واحداً على الأقل' });
  }
  if (!featureKey || typeof featureKey !== 'string') {
    return res.status(400).json({ error: 'ميزة غير صالحة' });
  }
  const ids = userIds.map(id => parseInt(id)).filter(Number.isInteger);

  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, permissions: true } });
  const failed = [];
  for (const u of users) {
    try {
      let perms = {};
      try { perms = JSON.parse(u.permissions || '{}'); } catch {}
      const current = new Set(perms.disabledFeatures ?? []);
      // enabledFeatures = ميزات الاشتراك المفعّلة صراحةً (OPT_IN_FEATURES) — نحدّثها معاً كي
      // يصحّ التفعيل لأي مفتاح دون أن يعرف السيرفر أيها «اشتراك»
      const optedIn = new Set(perms.enabledFeatures ?? []);
      if (enabled) { current.delete(featureKey); optedIn.add(featureKey); }
      else { current.add(featureKey); optedIn.delete(featureKey); }
      perms.disabledFeatures = Array.from(current);
      perms.enabledFeatures = Array.from(optedIn);
      await prisma.user.update({ where: { id: u.id }, data: { permissions: JSON.stringify(perms) } });
      invalidateAllAreasFlag(u.id);
    } catch (e) {
      failed.push({ id: u.id, error: e.message });
    }
  }
  const foundIds = new Set(users.map(u => u.id));
  for (const id of ids) { if (!foundIds.has(id)) failed.push({ id, error: 'غير موجود' }); }

  res.json({ success: true, updated: users.length - failed.length, failed });
}

// ── تفعيل/إطفاء «كل المناطق والمحافظات تلقائياً» ───────────────────────────
// PUT /api/sa/users/:id/all-areas  { enabled: boolean }
//
// راية واحدة في permissions.autoAllAreas تُغني عن تعيين المناطق يدوياً لحسابات
// الإدارة: النطاق يُوسَّع وقت الاستعلام في areaScope.js إلى كل صفوف Area، فأي
// منطقة تُضاف (سوبر أدمن، رفع ملف، السيرفي الخارجي) أو تُحذف أو يُعدَّل اسمها
// تنعكس فوراً على كل صاحب راية — بلا إعادة تعيين وبلا فروق بين حساب وآخر.
// التعيينات اليدوية المحفوظة تبقى كما هي وتستأنف عملها فور الإطفاء.
export async function setUserAllAreas(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'معرّف مستخدم غير صالح' });
  const enabled = Boolean(req.body?.enabled);

  const existing = await prisma.user.findUnique({ where: { id }, select: { role: true, permissions: true } });
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (enabled && !isAllAreasRole(existing.role)) {
    return res.status(400).json({
      error: `هذه الميزة متاحة للأدوار الإدارية فقط (${[...ALL_AREAS_ROLES].join('، ')}).`,
    });
  }

  let perms = {};
  try { perms = JSON.parse(existing.permissions || '{}'); } catch {}
  perms.autoAllAreas = enabled;

  await prisma.user.update({ where: { id }, data: { permissions: JSON.stringify(perms) } });
  invalidateAllAreasFlag(id);

  const effectiveAreaCount = (await resolveEffectiveAreaIds(id)).length;
  res.json({ success: true, autoAllAreas: enabled, effectiveAreaCount });
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
