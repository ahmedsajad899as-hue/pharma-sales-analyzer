// ════════════════════════════════════════════════════════════════════════════
// إضافة مستخدم من إدارة المكتب (مدير/HR/موظف مكتب) — مندوب علمي أو مسوّق.
//
// كل كتابة تمرّ بمعالجات السوبر أدمن نفسها (admin-users.controller): الإنشاء، الشركات،
// الايتمات، الأقسام، المناطق، المدراء، المحافظة — بنفس ترتيب نموذج «إضافة مستخدم»
// عنده. لذلك يحصل الحساب الجديد على كل ما يحصل عليه حساب السوبر أدمن (صلاحيات
// الحساب الجديد، ملفات المكتب، سجل المندوب، فريق المحافظة وقائده…) ويظهر عنده وعند
// الجميع فوراً، ولا يفترق المساران مع الزمن.
//
// ما يختلف هو الحدود: مكتب المُنشئ فقط، الدور مندوب فقط، والمدير من نفس الجهة
// (علمي ↔ علمي، مسوّق ↔ مسوّق). فشلُ أيّ خطوة بعد الإنشاء يحذف الحساب كاملاً كي لا
// يبقى حساب ناقص لا يملك موظف المكتب إكماله.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';
import { userFeatureOn } from '../../lib/userFeatures.js';
import { PHARMACY_KIND, BAGHDAD_PROVINCE } from '../../lib/pharmacyRep.js';
import { resolveEffectiveAreaIds } from '../../lib/areaScope.js';
import { loadMarketerManagers } from '../../lib/provinceSeats.js';
import {
  createUser as saCreateUser, setUserCompanies, setUserItems, setUserSubProvinces,
  setUserAreas, setUserManagers, setUserProvinces,
} from '../admin-users/admin-users.controller.js';

export const CREATE_FEATURE = 'users_create';
const CREATOR_ROLES = new Set(['office_manager', 'office_hr', 'office_employee']);
/** من يصلح مديراً مباشراً لمندوب جديد. */
const MANAGER_ROLES = ['company_manager', 'team_leader', 'supervisor', 'product_manager'];
const KINDS = new Set(['scientific', 'marketer']);

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
const cleanText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const idList = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))];
const nameOf = (u) => u.displayName || u.username;
const isMarketerRow = (u) => u.linkedRep?.repKind === PHARMACY_KIND;

/** المُنشئ: دور مكتبي، مربوط بمكتب، والميزة مفعّلة له من السوبر أدمن (اشتراك). */
async function loadCreator(req) {
  if (!CREATOR_ROLES.has(req.user?.role)) throw httpError(403, 'إضافة المستخدمين متاحة لإدارة المكتب فقط.');
  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, officeId: true, permissions: true, isActive: true },
  });
  if (!me?.isActive) throw httpError(403, 'حسابك غير نشط.');
  if (!me.officeId) throw httpError(400, 'حسابك غير مربوط بمكتب — يحدّده السوبر أدمن أولاً.');
  if (!userFeatureOn(me, CREATE_FEATURE, { optIn: true })) {
    throw httpError(403, 'ميزة «إضافة مستخدمين» غير مفعّلة لحسابك — يفعّلها السوبر أدمن من «المميزات».');
  }
  return me;
}

/**
 * يشغّل معالج السوبر أدمن نفسه على حساب ويُرجع { ok, status, body }.
 * المعالجات تقرأ req.params.id و req.body فقط وتكتب عبر res.status().json().
 */
async function runSaHandler(handler, userId, body) {
  let status = 200;
  let payload = null;
  const res = {
    status(code) { status = code; return this; },
    json(obj) { payload = obj; return this; },
  };
  await handler({ params: { id: String(userId ?? '') }, body, query: {} }, res);
  return { ok: status < 400, status, body: payload };
}

/** صف منطقة واحد لكل اسم مطبَّع (أقدم id) — نفس قاعدة محرّر المناطق في هذا الموديول. */
function canonicalAreas(rows) {
  const byName = new Map();
  for (const a of rows) {
    const k = normalizeAreaName(a.name);
    const cur = byName.get(k);
    if (!cur) { byName.set(k, { ...a }); continue; }
    // التكرار القديم قد يحمل المحافظة/القسم بينما الصف القانوني بلاها.
    if (cur.provinceId == null && a.provinceId != null) cur.provinceId = a.provinceId;
    if (cur.subProvinceId == null && a.subProvinceId != null) cur.subProvinceId = a.subProvinceId;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** GET /api/company-members/new-user/options — كل ما يحتاجه النموذج من مكتب المُنشئ. */
export async function newUserOptions(req, res, next) {
  try {
    const me = await loadCreator(req);
    const officeId = me.officeId;
    const [office, companies, provinces, subProvinces, areaRows, managerRows, teams, marketerManagers] = await Promise.all([
      prisma.scientificOffice.findUnique({ where: { id: officeId }, select: { id: true, name: true } }),
      prisma.scientificCompany.findMany({ where: { officeId }, select: { id: true, name: true, officeId: true }, orderBy: { name: 'asc' } }),
      prisma.province.findMany({ select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.subProvince.findMany({
        select: { id: true, name: true, provinceId: true },
        orderBy: [{ provinceId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.area.findMany({ select: { id: true, name: true, provinceId: true, subProvinceId: true }, orderBy: { id: 'asc' } }),
      prisma.user.findMany({
        where: { officeId, isActive: true, role: { in: MANAGER_ROLES } },
        select: {
          id: true, username: true, displayName: true, role: true, officeId: true, isActive: true,
          linkedRep: { select: { repKind: true } },
          companyAssignments: { select: { companyId: true, isPrimary: true, company: { select: { name: true } } } },
          itemAssignments: { select: { itemId: true } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.provinceTeam.findMany({
        where: { officeId, isActive: true, leaderUserId: { not: null } },
        select: { provinceId: true, leader: { select: { id: true, username: true, displayName: true, isActive: true } } },
      }),
      loadMarketerManagers([officeId]),
    ]);

    const managers = managerRows.map(u => {
      const marketer = isMarketerRow(u);
      return {
        id: u.id, username: u.username, displayName: u.displayName, role: u.role,
        officeId: u.officeId, isActive: u.isActive, isMarketer: marketer,
        companyIds: u.companyAssignments.map(c => c.companyId),
        primaryCompanyId: u.companyAssignments.find(c => c.isPrimary)?.companyId ?? null,
        itemIds: u.itemAssignments.map(i => i.itemId),
        // المسوق لا ينتمي لشركة: لا نعرض «شركته الرئيسية» تحت اسمه في المنتقي.
        companyAssignments: marketer ? [] : u.companyAssignments.map(c => ({ isPrimary: c.isPrimary, company: { name: c.company.name } })),
      };
    });

    res.json({
      success: true,
      office,
      companies,
      provinces,
      subProvinces,
      areas: canonicalAreas(areaRows),
      managers,
      provinceLeaders: teams
        .filter(t => t.leader?.isActive)
        .map(t => ({ provinceId: t.provinceId, userId: t.leader.id, name: nameOf(t.leader) })),
      marketerManagers: marketerManagers.map(m => ({ userId: m.userId, name: m.name, handlesProvinces: m.handlesProvinces })),
      baghdadName: BAGHDAD_PROVINCE,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

/** GET /api/company-members/new-user/company-items?companyIds=1,2 — ايتمات شركات المكتب المختارة. */
export async function newUserCompanyItems(req, res, next) {
  try {
    const me = await loadCreator(req);
    const requested = idList(String(req.query.companyIds ?? '').split(','));
    if (!requested.length) return res.json({ success: true, data: [] });
    const companies = await prisma.scientificCompany.findMany({
      where: { id: { in: requested }, officeId: me.officeId }, select: { id: true },
    });
    const companyIds = companies.map(c => c.id);
    if (!companyIds.length) return res.json({ success: true, data: [] });
    const items = await prisma.item.findMany({
      where: { scientificCompanyId: { in: companyIds }, isTemp: false },
      select: { id: true, name: true, scientificCompanyId: true, scientificCompany: { select: { name: true } } },
      orderBy: [{ scientificCompanyId: 'asc' }, { name: 'asc' }],
    });
    res.json({
      success: true,
      data: items.map(i => ({ id: i.id, name: i.name, companyId: i.scientificCompanyId, companyName: i.scientificCompany?.name ?? '—' })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

/** يتحقق من الطلب كاملاً قبل إنشاء أي شيء. */
async function validateCreate(me, b) {
  const kind = KINDS.has(b.kind) ? b.kind : null;
  if (!kind) throw httpError(400, 'حدّد نوع الحساب: مندوب علمي أو مسوّق.');

  const username = cleanText(b.username);
  const displayName = cleanText(b.displayName) || username;
  const password = typeof b.password === 'string' ? b.password : '';
  const phone = cleanText(b.phone) || null;
  if (!username) throw httpError(400, 'اسم الدخول مطلوب.');
  if (username.length > 60) throw httpError(400, 'اسم الدخول طويل جداً.');
  if (displayName.length > 120) throw httpError(400, 'الاسم طويل جداً.');
  if (password.trim().length < 6) throw httpError(400, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.');

  const officeCompanies = await prisma.scientificCompany.findMany({ where: { officeId: me.officeId }, select: { id: true, name: true } });
  const officeCompanyIds = new Set(officeCompanies.map(c => c.id));
  const companyIds = idList(b.companyIds);
  if (!companyIds.length) throw httpError(400, 'اختر شركة واحدة على الأقل من تبويب «الشركات».');
  if (companyIds.some(id => !officeCompanyIds.has(id))) throw httpError(400, 'بعض الشركات المختارة ليست من شركات مكتبك.');
  let primaryCompanyId = Number(b.primaryCompanyId);
  if (!companyIds.includes(primaryCompanyId)) primaryCompanyId = companyIds[0];

  const itemIds = idList(b.itemIds);
  if (itemIds.length) {
    const n = await prisma.item.count({ where: { id: { in: itemIds }, scientificCompanyId: { in: companyIds }, isTemp: false } });
    if (n !== itemIds.length) throw httpError(400, 'بعض الايتمات المختارة لا تتبع الشركات المختارة — حدّث النافذة وأعد الاختيار.');
  }

  const provinceId = b.provinceId != null && b.provinceId !== '' ? Number(b.provinceId) : null;
  let province = null;
  if (provinceId != null) {
    province = Number.isInteger(provinceId)
      ? await prisma.province.findUnique({ where: { id: provinceId }, select: { id: true, name: true } })
      : null;
    if (!province) throw httpError(400, 'المحافظة المختارة غير موجودة.');
  }
  const subProvinceIds = idList(b.subProvinceIds);
  const subRows = subProvinceIds.length
    ? await prisma.subProvince.findMany({ where: { id: { in: subProvinceIds } }, select: { id: true, name: true } })
    : [];
  if (subRows.length !== subProvinceIds.length) throw httpError(400, 'بعض الأقسام المختارة لم تعد موجودة — حدّث النافذة.');
  const areaIds = idList(b.areaIds);
  if (areaIds.length) {
    const n = await prisma.area.count({ where: { id: { in: areaIds } } });
    if (n !== areaIds.length) throw httpError(400, 'بعض المناطق المختارة لم تعد موجودة — حدّث النافذة.');
  }
  if (!province && !subRows.length && !areaIds.length) {
    throw httpError(400, 'حدّد مناطق عمله: محافظة، أو قسم (الكرخ/الرصافة)، أو مناطق من تبويب «المناطق».');
  }

  // المدير: من نفس المكتب، دور إداري، ومن نفس الجهة — لا صلة بين المسوقين والعلميين.
  const managerIds = idList(b.managerIds);
  const managers = managerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: managerIds } },
        select: { id: true, username: true, displayName: true, role: true, officeId: true, isActive: true, linkedRep: { select: { repKind: true } } },
      })
    : [];
  if (managers.length !== managerIds.length) throw httpError(400, 'أحد المدراء المختارين غير موجود — حدّث النافذة.');
  for (const m of managers) {
    if (m.officeId !== me.officeId || !m.isActive || !MANAGER_ROLES.includes(m.role)) {
      throw httpError(400, `«${nameOf(m)}» لا يصلح مديراً لهذا الحساب.`);
    }
    if ((kind === 'marketer') !== isMarketerRow(m)) {
      throw httpError(400, kind === 'marketer'
        ? `«${nameOf(m)}» من جهة العلميين — مدير المسوّق يكون من المسوقين.`
        : `«${nameOf(m)}» من جهة المسوقين — مدير المندوب العلمي يكون من العلميين.`);
    }
  }

  return {
    kind, username, displayName, password, phone,
    companyIds, primaryCompanyId, itemIds,
    province, subRows, areaIds, managers,
    companyNames: officeCompanies.filter(c => companyIds.includes(c.id)).map(c => c.name),
  };
}

/** حذف حساب لم يكتمل (وسجل المندوب الذي أُنشئ له للتو). */
async function removeIncomplete(userId) {
  await prisma.scientificRepresentative.deleteMany({ where: { userId } })
    .catch(e => console.error('[member-create] rollback reps', userId, e.message));
  await prisma.user.delete({ where: { id: userId } })
    .catch(e => console.error('[member-create] rollback user', userId, e.message));
}

/** POST /api/company-members/new-user */
export async function createMemberUser(req, res, next) {
  try {
    const me = await loadCreator(req);
    const v = await validateCreate(me, req.body ?? {});

    const created = await runSaHandler(saCreateUser, null, {
      username: v.username, password: v.password, displayName: v.displayName, phone: v.phone,
      role: 'scientific_rep', officeId: me.officeId,
      ...(v.kind === 'marketer' ? { repKind: PHARMACY_KIND } : {}),
    });
    if (created.status === 409) {
      return res.status(409).json({ error: `اسم الدخول «${v.username}» محجوز لحساب آخر — اختر اسماً مختلفاً.`, code: 'USERNAME_TAKEN' });
    }
    const userId = created.body?.data?.id;
    if (!created.ok || !userId) throw new Error(created.body?.error || 'create failed');

    // نفس ترتيب saveUser في نموذج السوبر أدمن: الشركات ← الايتمات ← الأقسام ← المناطق
    // ← المدراء ← المحافظة (آخراً: تسجيله في فريق المحافظة يربطه بقائدها).
    const steps = [
      ['الشركات', setUserCompanies, { companyIds: v.companyIds, primaryCompanyId: v.primaryCompanyId }],
      ...(v.itemIds.length ? [['الايتمات', setUserItems, { itemIds: v.itemIds }]] : []),
      ...(v.subRows.length ? [['الأقسام', setUserSubProvinces, { subProvinceIds: v.subRows.map(s => s.id) }]] : []),
      ...(v.areaIds.length ? [['المناطق', setUserAreas, { areaIds: v.areaIds }]] : []),
      ...(v.managers.length ? [['المدراء', setUserManagers, { managerIds: v.managers.map(m => m.id) }]] : []),
      ...(v.province ? [['المحافظة', setUserProvinces, { provinceIds: [v.province.id] }]] : []),
    ];
    for (const [label, handler, body] of steps) {
      let r;
      try { r = await runSaHandler(handler, userId, body); }
      catch (e) { r = { ok: false, body: { error: e.message } }; }
      if (!r.ok) {
        console.error('[member-create] step failed', label, userId, r.body?.error);
        await removeIncomplete(userId);
        return res.status(500).json({ error: `تعذّر حفظ ${label} — لم يُنشأ الحساب. حاول مرة أخرى.` });
      }
    }

    const areaCount = (await resolveEffectiveAreaIds(userId, { includeRepAreas: false }).catch(() => [])).length;
    try {
      await prisma.activityLog.create({
        data: {
          userId: me.id,
          action: 'member_create',
          module: 'company-members',
          details: JSON.stringify({
            targetUserId: userId,
            kind: v.kind,
            companies: v.companyNames,
            itemCount: v.itemIds.length,
            province: v.province?.name ?? null,
            subProvinces: v.subRows.map(s => s.name),
            areaCount,
            managers: v.managers.map(nameOf),
          }),
        },
      });
    } catch (e) { console.warn('[member-create] activity log failed (non-fatal):', e.message); }

    res.status(201).json({
      success: true,
      data: { id: userId, username: v.username, displayName: v.displayName, kind: v.kind, areaCount },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}
