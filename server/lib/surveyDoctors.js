// ════════════════════════════════════════════════════════════════════════════
// surveyDoctors.js — المصدر الموحّد لأطباء السيرفي
// ────────────────────────────────────────────────────────────────────────────
// يجمع منطق "نطاق المناطق + أطباء السيرفي المُقيّدين بالمناطق" الذي كان مكرراً
// (ومتضارباً) في: doctors.controller (visitsByArea/list)،
// doctor-archive.controller (getArchive/importFromVisits/getSurveyDoctors).
//
// الهدف: تخرج كل الخانات (الزيارات/الأطباء/الأرشيف) من نفس المجموعة تماماً
// فيتطابق العدد، مع الحفاظ على تقييد كل مندوب بمناطقه والمدير يرى كل مناطق فريقه.
//
// كما يوفّر service موحّد لإنشاء/تعديل طبيب السيرفي مع:
//   cascade لصفوف Doctor المرتبطة + تسجيل MasterSurveyEditLog (سجل الإشعارات).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { findOrCreateArea } from '../modules/sales/sales.repository.js';
import { resolveAreaByName } from './areaResolver.js';
import { normalizeAreaName } from './itemResolver.js';
import { resolveEffectiveAreaIds } from './areaScope.js';
import { OFFICE_SCOPED_ROLES } from './officeScope.js';
import { normalizeRepName, repNameScore } from '../modules/scientific-reps/scientific-reps.service.js';

// ════════════════════════════════════════════════════════════════════════════
// مطابقة أسماء الأطباء — مشتركة بين استيراد زيارات الأطباء (doctor-visits-
// import.js) واستيراد أطباء السيرفي نفسه (survey-admin.controller.js). كانت
// معرَّفة محلياً في doctor-visits-import.js فقط؛ نُقلت هنا كي يستفيد منها
// الطرفان بلا ازدواج، ويُحفظ التطابق المؤكَّد في مكان واحد (MasterSurveyDoctorAlias).
// ════════════════════════════════════════════════════════════════════════════

// CRM/ملفات خارجية تكتب اسم الطبيب أحياناً "عيادة الدكتور فلان" بدل "فلان"
// وحدها — لو تُرك كما هو، لا يطابق السجل الصافي الموجود أصلاً.
const DOCTOR_PREFIX_RE = /^\s*(عيادة\s+)?(الدكتور|دكتور|د\.?)\s+/i;
export function cleanDoctorName(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3 && DOCTOR_PREFIX_RE.test(s); i++) s = s.replace(DOCTOR_PREFIX_RE, '').trim();
  return s;
}

/** مفتاح تصنيف موحّد للاسم — نفس المفتاح يُستخدم عند القراءة وعند حفظ الرابط لاحقاً. */
export function doctorLinkKey(name, areaName) {
  return `${normalizeRepName(cleanDoctorName(name))}|${normalizeAreaName(areaName || '')}`;
}

/**
 * درجة تطابق طبيب واحدة (0..1): الاسم هو الأساس (محرك تشابه أسماء المندوبين
 * — كلمتان مشتركتان على الأقل)، وتُضاف نقاط ترجيح عند تطابق المنطقة/
 * الاختصاص/الصيدلية أيضاً.
 */
export function doctorMatchScore(cand, target) {
  const nameScore = repNameScore(cand.name, target.name);
  if (nameScore === 0) return 0;
  let bonus = 0;
  if (cand.areaName && target.areaName && normalizeAreaName(cand.areaName) === normalizeAreaName(target.areaName)) bonus += 0.12;
  if (cand.specialty && target.specialty && normalizeRepName(cand.specialty) === normalizeRepName(target.specialty)) bonus += 0.08;
  if (cand.pharmacyName && target.pharmacyName && normalizeRepName(cand.pharmacyName) === normalizeRepName(target.pharmacyName)) bonus += 0.05;
  return Math.min(1, nameScore + bonus);
}

export const DOCTOR_ASK_FLOOR = 0.45; // أدنى نقاط يُعتَد بها كمرشَّح يُعرض للمستخدم

// الأدوار الميدانية (مُقيّدة بمناطقها). المدراء يرون كامل الفريق.
const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'commercial_rep']);
export const isFieldRole = (role) => FIELD_ROLES.has(role);

// ── مناطق مستخدم واحد ──────────────────────────────────────────────────────
// المصادر الثلاثة (UserAreaAssignment + ScientificRepArea + مناطق المحافظات
// المعيّنة) موحّدة في areaScope.js — راجعه لسبب التوحيد.
async function areaIdsForUser(userId, linkedRepId) {
  return resolveEffectiveAreaIds(userId, { linkedRepId: linkedRepId ?? null });
}

// حل معرّف المندوب العلمي لمستخدم (linkedRepId ثم fallback عبر ScientificRepresentative.userId)
async function resolveRepId(userId, linkedRepId) {
  if (linkedRepId) return linkedRepId;
  const own = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
  return own?.id ?? null;
}

// أدوار إدارية وسيطة لا تزور أطباء بنفسها — تُستبعد من تجميع «الشركة الرئيسية»
// كما تُستبعد من شرائح «المندوب» في getManagerSubReps (doctors.controller.js).
// تشمل أيضاً الأدوار المكتبية (office_manager/office_hr/office_employee — راجع
// officeScope.js): لا تزور أطباء بنفسها، وبما أنها تحمل الآن كل شركات مكتبها
// isPrimary=true معاً فضمّها هنا كان سيجعلها "تطابق" أي companyId في
// resolveCompanyMembers، لا شركة فريقها الفعلية فقط.
const MANAGEMENT_ROLES = new Set(['company_manager', 'team_leader', ...OFFICE_SCOPED_ROLES]);

// ── resolveCompanyMembers(managerId, companyId) ──────────────────────────────
// أعضاء فريق المدير الذين «شركتهم الرئيسية» (UserCompanyAssignment isPrimary)
// هي companyId — تُستخدم لتصفية شاشة الزيارات حسب «الشركة الرئيسية» لكل
// فريق/مندوب، لا حسب مندوب واحد.
//
// عمداً بلا المدير نفسه: مدير المكتب عادةً مُعيَّن على مناطق إدارية واسعة
// (محافظات كاملة) لأغراض الإشراف العام، لا لأنه يزور أطباءها بنفسه. ضمّه هنا
// كان يُسرّب كل نطاقه الإداري إلى أي شركة تصادف كونها «شركته الرئيسية» هو
// شخصياً، فتظهر تلك الشركة بعدد الإجمالي الكامل بدل عدد مندوبيها فقط.
export async function resolveCompanyMembers(managerId, companyId) {
  const subs = await prisma.userManagerAssignment.findMany({
    where: { managerId },
    include: { user: { select: { id: true, linkedRepId: true, role: true } } },
  });
  const candidates = subs.map(s => s.user).filter(u => !MANAGEMENT_ROLES.has(u.role));
  if (!candidates.length) return [];

  const assignments = await prisma.userCompanyAssignment.findMany({
    where: { userId: { in: candidates.map(c => c.id) }, companyId, isPrimary: true },
    select: { userId: true },
  });
  const matched = new Set(assignments.map(a => a.userId));

  const members = [];
  for (const c of candidates) {
    if (!matched.has(c.id)) continue;
    const repId = await resolveRepId(c.id, c.linkedRepId ?? null);
    members.push({ userId: c.id, repId });
  }
  return members;
}

// ── buildAreaNameIndex(areaRecords) ──────────────────────────────────────────
// خريطة "اسم مطبَّع → صف Area" لمجموعة مناطق، مضافاً إليها كل تهجئة سبق ربطها
// بإحداها عبر AreaAlias (دمج يدوي أو ربط ضبابي تلقائي عند الاستيراد — راجع
// areaResolver.js وmergeAreaInto). بدون هذا، طبيب/صيدلية سيرفي مخزَّن بالاسم
// (نص خام بلا FK) بتهجئة قديمة أو مختلفة قليلاً عن الاسم القانوني يبقى غير
// مرئي رغم أن منطقته الحقيقية ضمن النطاق فعلاً.
export async function buildAreaNameIndex(areaRecords) {
  const normToArea = new Map(areaRecords.map(a => [normalizeAreaName(a.name), a]));
  const areaIds = areaRecords.map(a => a.id);
  if (areaIds.length) {
    const aliasRows = await prisma.areaAlias.findMany({
      where: { areaId: { in: areaIds } }, select: { fromKey: true, areaId: true },
    });
    const areaById = new Map(areaRecords.map(a => [a.id, a]));
    for (const alias of aliasRows) {
      const target = areaById.get(alias.areaId);
      if (target && !normToArea.has(alias.fromKey)) normToArea.set(alias.fromKey, target);
    }
  }
  return normToArea;
}

// ── resolveAreaScope(user, { repUserId, companyId }) ─────────────────────────
// يُرجع نطاق المناطق + السيرفيات النشطة:
//   - مندوب ميداني: مناطقه هو.
//   - مدير + repUserId: مناطق ذاك المندوب.
//   - مدير + companyId (مدير المكتب فقط عملياً): اتحاد مناطق أعضاء الفريق
//     (المندوبين فقط، بلا المدير نفسه — راجع resolveCompanyMembers) الذين
//     شركتهم الرئيسية هي هذه.
//   - مدير (الكل): اتحاد مناطق المدير + كل مندوبي فريقه (UserManagerAssignment).
export async function resolveAreaScope(user, { repUserId = null, companyId = null } = {}) {
  const ids = new Set();
  const memberUserIds = new Set(); // لطبقة الزيارات: مَن تُحتسب زياراتهم
  const memberRepIds  = new Set(); // معرّفات المندوب العلمي المقابلة

  const addMember = (uid, repId) => {
    if (uid) memberUserIds.add(uid);
    if (repId) memberRepIds.add(repId);
  };

  if (isFieldRole(user.role)) {
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { linkedRepId: true } });
    const repId = await resolveRepId(user.id, u?.linkedRepId ?? null);
    addMember(user.id, repId);
    (await areaIdsForUser(user.id, repId)).forEach(id => ids.add(id));
  } else if (repUserId) {
    const u = await prisma.user.findUnique({ where: { id: repUserId }, select: { linkedRepId: true } });
    const repId = await resolveRepId(repUserId, u?.linkedRepId ?? null);
    addMember(repUserId, repId);
    (await areaIdsForUser(repUserId, repId)).forEach(id => ids.add(id));
  } else if (companyId) {
    const members = await resolveCompanyMembers(user.id, companyId);
    for (const m of members) {
      addMember(m.userId, m.repId);
      (await areaIdsForUser(m.userId, m.repId)).forEach(id => ids.add(id));
    }
  } else {
    // مدير "الكل": مناطقه + كل مندوبي الفريق الفعليين (بلا أدوار الإدارة
    // الوسيطة — مدير الشركة وقائد التيم لا يزوران أطباء بنفسهما، فضمّهما هنا
    // كان يُحسب أي زيارة مسجَّلة تحت حسابهما الشخصي ضمن إجمالي "الكل").
    const [ownU, allSubs] = await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { linkedRepId: true } }),
      prisma.userManagerAssignment.findMany({
        where: { managerId: user.id },
        include: { user: { select: { id: true, linkedRepId: true, role: true } } },
      }),
    ]);
    const subs = allSubs.filter(s => !MANAGEMENT_ROLES.has(s.user.role));
    const ownRepId = await resolveRepId(user.id, ownU?.linkedRepId ?? null);
    addMember(user.id, ownRepId);
    (await areaIdsForUser(user.id, ownRepId)).forEach(id => ids.add(id));
    for (const s of subs) {
      const repId = await resolveRepId(s.user.id, s.user.linkedRepId ?? null);
      addMember(s.user.id, repId);
      (await areaIdsForUser(s.user.id, repId)).forEach(id => ids.add(id));
    }
    // شبكة أمان: ضمّ مناطق أطباء المدير الحاليين (حتى لا ينخفض الرقم عن الوضع
    // السابق لو كانت تعيينات مناطق الفريق ناقصة). إضافة فقط — لا تُنقِص التغطية.
    const ownerDoctorAreas = await prisma.doctor.findMany({
      where: { userId: user.id, areaId: { not: null } },
      select: { areaId: true }, distinct: ['areaId'],
    });
    ownerDoctorAreas.forEach(d => ids.add(d.areaId));
  }

  const areaIds = [...ids].filter(Boolean);
  const areaRecords = areaIds.length
    ? await prisma.area.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
    : [];
  const normToArea = await buildAreaNameIndex(areaRecords);

  const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
  const surveyIds = surveys.map(s => s.id);

  return {
    areaIds, areaRecords, normToArea, normAreaNames: [...normToArea.keys()], surveyIds,
    memberUserIds: [...memberUserIds].filter(Boolean),
    memberRepIds:  [...memberRepIds].filter(Boolean),
  };
}

// ── overlayVisits(scope, dateFilter) ─────────────────────────────────────────
// يجمع زيارات كل أعضاء النطاق ويُنشئ خرائط بحث بالـmasterSurveyDoctorId والاسم.
export async function buildVisitOverlay(scope, dateFilter) {
  const orClauses = [];
  if (scope.memberRepIds.length)  orClauses.push({ scientificRepId: { in: scope.memberRepIds } });
  // مطابقة userId (مَن حفظ/رفع الزيارة) مقصورة على الزيارات بلا مندوب علمي محسوم
  // (مدير يسجّل زيارته شخصياً بلا ScientificRepresentative). زيارة لها
  // scientificRepId فعلي — وهي كل زيارات الاستيراد الجماعي، رقم الملف يُنسَب
  // فيها userId لمَن رفع الملف لا للمندوب الفعلي — تُنسب لذلك المندوب حصراً؛
  // بدون هذا القيد كانت الزيارة تظهر لمن رفع الملف بصرف النظر عن مندوبها
  // الحقيقي، فيختلف عدد "الزيارات" باختلاف مَن يفتح الشاشة رغم تطابق مناطقهم.
  if (scope.memberUserIds.length) orClauses.push({ scientificRepId: null, userId: { in: scope.memberUserIds } });
  const bySurveyDocId = new Map();
  const byName = new Map();
  if (!orClauses.length) return { bySurveyDocId, byName };

  const visits = await prisma.doctorVisit.findMany({
    // isActive=false → زيارات ملف استيراد إكسل مُعطَّل (VisitImportFile) — تبقى
    // محفوظة لكن تُخفى من شاشة الزيارات حتى يُعاد تفعيل الملف.
    where: { OR: orClauses, isActive: true, ...(dateFilter ? { visitDate: dateFilter } : {}) },
    select: {
      id: true, visitDate: true, feedback: true, feedbackSource: true, notes: true, itemName: true, geoCorrect: true,
      item: { select: { id: true, name: true } },
      doctor: { select: { masterSurveyDoctorId: true, name: true } },
      scientificRep: { select: { name: true } },
      user: { select: { displayName: true, username: true } },
    },
    orderBy: { visitDate: 'desc' },
  });
  for (const v of visits) {
    // ايتم محفوظ نصاً (لا يطابق الكتالوج) يُعرض كأي ايتم آخر — بمعرّف null.
    const item = v.item ?? (v.itemName ? { id: null, name: v.itemName } : null);
    // مَن قام بالزيارة فعلياً: المندوب العلمي المحسوم أولاً (كل زيارات الاستيراد
    // الجماعي تحمله)، وإلا مَن سجّلها شخصياً (مدير يسجّل زيارته بنفسه بلا مندوب).
    const repName = v.scientificRep?.name || v.user?.displayName || v.user?.username || null;
    const entry = { id: v.id, visitDate: v.visitDate, feedback: v.feedback, feedbackSource: v.feedbackSource, notes: v.notes, item, geoCorrect: v.geoCorrect, repName };
    const msId = v.doctor?.masterSurveyDoctorId;
    if (msId != null) {
      if (!bySurveyDocId.has(msId)) bySurveyDocId.set(msId, []);
      bySurveyDocId.get(msId).push(entry);
    }
    if (v.doctor?.name) {
      const nk = normalizeAreaName(v.doctor.name);
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(entry);
    }
  }
  return { bySurveyDocId, byName };
}

// ── getScopedSurveyDoctors(scope) ────────────────────────────────────────────
// المجموعة القانونية: أطباء السيرفي النشط ضمن مناطق النطاق.
// نطاق فارغ (لا مناطق مُعيّنة) → لا أطباء — يطابق السلوك الحالي للمندوب الميداني
// ويتفادى إغراق القائمة بكامل السيرفي عند غياب تعيينات المناطق.
export async function getScopedSurveyDoctors(scope) {
  const { surveyIds, normAreaNames } = scope;
  if (!surveyIds.length || !normAreaNames.length) return [];
  const all = await prisma.masterSurveyDoctor.findMany({
    where: { surveyId: { in: surveyIds } },
    select: {
      id: true, name: true, specialty: true, areaName: true,
      pharmacyName: true, className: true, phone: true, zoneName: true,
    },
    orderBy: { name: 'asc' },
  });
  const set = new Set(normAreaNames);
  return all.filter(d => d.areaName?.trim() && set.has(normalizeAreaName(d.areaName)));
}

// ── ensureDoctorRowsForScope(ownerUserId, scopedDocs, scope) ──────────────────
// يضمن وجود صف Doctor واحد (مربوط عبر masterSurveyDoctorId، لا بالاسم) لكل طبيب
// سيرفي في النطاق، تحت حساب المالك. يستبدل الاستيراد النصي الهش.
// يُرجع Map(masterSurveyDoctorId → doctorId).
export async function ensureDoctorRowsForScope(ownerUserId, scopedDocs, scope) {
  const map = new Map();
  if (!ownerUserId || !scopedDocs.length) return map;

  const scopedIds = scopedDocs.map(d => d.id);

  // 1) الصفوف المربوطة أصلاً
  const linked = await prisma.doctor.findMany({
    where: { userId: ownerUserId, masterSurveyDoctorId: { in: scopedIds } },
    select: { id: true, masterSurveyDoctorId: true, areaId: true },
  });
  for (const d of linked) map.set(d.masterSurveyDoctorId, d.id);

  const missing = scopedDocs.filter(d => !map.has(d.id));
  if (!missing.length) return map;

  // 2) ربط صفوف قديمة بنفس الاسم غير مربوطة بعد (تفادي التكرار)
  const byName = new Map(missing.map(d => [d.name.trim().toLowerCase(), d]));
  const legacy = await prisma.doctor.findMany({
    where: {
      userId: ownerUserId,
      masterSurveyDoctorId: null,
      name: { in: missing.map(d => d.name.trim()) },
    },
    select: { id: true, name: true, areaId: true },
  });
  const claimed = new Set();
  for (const row of legacy) {
    const sd = byName.get(row.name.trim().toLowerCase());
    if (!sd || claimed.has(sd.id)) continue;
    claimed.add(sd.id);
    const areaId = row.areaId ?? scope.normToArea.get(normalizeAreaName(sd.areaName ?? ''))?.id ?? null;
    await prisma.doctor.update({
      where: { id: row.id },
      data: { masterSurveyDoctorId: sd.id, ...(row.areaId ? {} : areaId ? { areaId } : {}) },
    });
    map.set(sd.id, row.id);
  }

  // 3) إنشاء صفوف جديدة للباقي
  const toCreate = missing.filter(d => !claimed.has(d.id));
  if (toCreate.length) {
    await prisma.doctor.createMany({
      data: toCreate.map(sd => ({
        name:                 sd.name.trim(),
        specialty:            sd.specialty    || null,
        pharmacyName:         sd.pharmacyName || null,
        areaId:               scope.normToArea.get(normalizeAreaName(sd.areaName ?? ''))?.id ?? null,
        userId:               ownerUserId,
        masterSurveyDoctorId: sd.id,
      })),
      skipDuplicates: true,
    });
    // إعادة الجلب للحصول على المعرّفات
    const created = await prisma.doctor.findMany({
      where: { userId: ownerUserId, masterSurveyDoctorId: { in: toCreate.map(d => d.id) } },
      select: { id: true, masterSurveyDoctorId: true },
    });
    for (const d of created) map.set(d.masterSurveyDoctorId, d.id);
  }

  return map;
}

// ── تسجيل حركة في سجل تعديلات السيرفي (سجل الإشعارات) ─────────────────────────
export function logSurveyEdit(surveyId, entryType, entryId, action, oldData, newData, editedById) {
  return prisma.masterSurveyEditLog.create({
    data: {
      surveyId, entryType, entryId, action,
      oldData: oldData ? JSON.stringify(oldData) : null,
      newData: newData ? JSON.stringify(newData) : null,
      editedById: editedById ?? null,
    },
  });
}

// إيجاد/إنشاء منطقة بالاسم (كتالوج مشترك) وربطها بحساب المستخدم — لمزامنة areaId عند cascade
async function resolveAreaIdForUser(areaName, userId) {
  if (!areaName?.trim()) return null;
  return (await findOrCreateArea(areaName, userId)).id;
}

// ── ensureGlobalArea / loadAreaNameIndex ──────────────────────────────────────
// طبيب سيرفي بمنطقة اسمها جديد كلياً (لم تُستخدم من قبل في أي حساب) يبقى غير
// مرئي للجميع إلى الأبد: getScopedSurveyDoctors تطابق بالاسم المطبَّع مقابل
// مناطق Area الموجودة فعلاً — واسم بلا أي صف Area مطابق لا يمكن أن يُسنَد لفريق
// أصلاً. المطابقة الفعلية (تام → alias محفوظ → ضبابي بثقة عالية → إنشاء جديد
// معلَّم needsReview) موحّدة الآن في areaResolver.js — هنا فقط نضيف مساراً
// سريعاً لتفادي إعادة نفس المطابقة لكل صف داخل دفعة استيراد إكسل واحدة
// (knownNames يُمرَّر جاهزاً من commitDoctorImport عبر loadAreaNameIndex).
export async function loadAreaNameIndex() {
  const rows = await prisma.area.findMany({ select: { name: true } });
  return new Set(rows.map(r => normalizeAreaName(r.name)));
}

export async function ensureGlobalArea(areaName, knownNames = null) {
  const trimmed = String(areaName ?? '').trim();
  if (!trimmed) return;
  const norm = normalizeAreaName(trimmed);
  if (knownNames?.has(norm)) return;
  await resolveAreaByName(trimmed);
  if (knownNames) knownNames.add(norm);
}

// ── createSurveyDoctor — إنشاء طبيب سيرفي موحّد (log + notify) ────────────────
// editedById: userId للمندوب/المدير، أو null للسوبر أدمن.
// areaCache: Set اختياري (من loadAreaNameIndex) لتفادي استعلام كامل جدول
// المناطق عند كل صف في استيراد جماعي — commitDoctorImport يمرّره جاهزاً.
export async function createSurveyDoctor(surveyId, fields, editedById, areaCache = null) {
  if (fields.areaName) await ensureGlobalArea(fields.areaName, areaCache);
  const doc = await prisma.masterSurveyDoctor.create({
    data: {
      surveyId,
      name:         fields.name.trim(),
      specialty:    fields.specialty    ?? null,
      areaName:     fields.areaName      ?? null,
      pharmacyName: fields.pharmacyName ?? null,
      className:    fields.className     ?? null,
      zoneName:     fields.zoneName      ?? null,
      phone:        fields.phone         ?? null,
      notes:        fields.notes         ?? null,
      lastEditedById: editedById ?? null,
      lastEditedAt:   new Date(),
    },
  });
  await logSurveyEdit(surveyId, 'doctor', doc.id, 'create', null, doc, editedById);
  return doc;
}

// ── updateSurveyDoctor — تعديل طبيب سيرفي موحّد (cascade + log) ───────────────
// يُطبّق التغيير على MasterSurveyDoctor + كل صفوف Doctor المرتبطة + يسجّل الحركة.
export async function updateSurveyDoctor(surveyId, docId, fields, editedById, areaCache = null) {
  const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
  if (!old || old.surveyId !== surveyId) return { error: 'not_found' };

  const data = { lastEditedById: editedById ?? null, lastEditedAt: new Date() };
  for (const key of ['name', 'specialty', 'areaName', 'pharmacyName', 'className', 'zoneName', 'phone', 'notes']) {
    if (fields[key] !== undefined) data[key] = key === 'name' ? String(fields[key]).trim() : fields[key];
  }
  if (data.areaName) await ensureGlobalArea(data.areaName, areaCache);

  const updated = await prisma.masterSurveyDoctor.update({ where: { id: docId }, data });
  await logSurveyEdit(surveyId, 'doctor', docId, 'update', old, updated, editedById);

  // Cascade لصفوف Doctor المرتبطة
  const cascadeData = {};
  if (data.name         !== undefined) cascadeData.name         = data.name;
  if (data.specialty    !== undefined) cascadeData.specialty    = data.specialty;
  if (data.pharmacyName !== undefined) cascadeData.pharmacyName = data.pharmacyName;
  if (data.notes        !== undefined) cascadeData.notes        = data.notes;

  if (Object.keys(cascadeData).length > 0 || data.areaName !== undefined) {
    if (data.areaName !== undefined) {
      const linkedDoctors = await prisma.doctor.findMany({
        where: { masterSurveyDoctorId: docId },
        select: { id: true, userId: true },
      });
      const userGroups = new Map();
      for (const d of linkedDoctors) {
        const key = d.userId ?? null;
        if (!userGroups.has(key)) userGroups.set(key, []);
        userGroups.get(key).push(d.id);
      }
      for (const [uid, ids] of userGroups) {
        const resolvedAreaId = uid ? await resolveAreaIdForUser(data.areaName, uid) : null;
        await prisma.doctor.updateMany({ where: { id: { in: ids } }, data: { ...cascadeData, areaId: resolvedAreaId } });
      }
    } else {
      await prisma.doctor.updateMany({ where: { masterSurveyDoctorId: docId }, data: cascadeData });
    }
  }

  return { old, updated };
}

// ════════════════════════════════════════════════════════════════════════════
// استيراد أطباء السيرفي من Excel — مطابقة ضد أطباء هذا السيرفي + الروابط
// (MasterSurveyDoctorAlias) المحفوظة مسبقاً، بنفس فلسفة classifyDoctorRows
// في doctor-visits-import.js لكن ضد MasterSurveyDoctor مباشرة لا Doctor خاص
// بمستخدم — لأن هذا استيراد لكتالوج السيرفي المشترك نفسه لا لزيارات مندوب.
// ════════════════════════════════════════════════════════════════════════════

/**
 * تصنّف صفوف طبيب مرفوعة (name/areaName/specialty/pharmacyName...) دفعة
 * واحدة (مجموعة واحدة لكل اسم+منطقة مختلفين) مقابل أطباء هذا السيرفي +
 * الروابط المحفوظة. لا تُنشئ ولا تحفظ شيئاً — قراءة فقط.
 *
 *   resolved (status: linked|exact) → رابط محفوظ مسبقاً أو اسم مطابق تماماً
 *     لطبيب واحد لا لبس فيه → بلا سؤال.
 *   pending  → مرشّحون بدرجة معتد بها لكن بلا حسم → يُعرض للسوبر أدمن.
 *   unrelated → لا مرشّح على الإطلاق → طبيب سيرفي جديد بلا سؤال.
 */
export async function classifySurveyDoctorRows(surveyId, rows) {
  const rowsWithName = (rows || []).filter(r => String(r?.name ?? '').trim());
  if (rowsWithName.length === 0) return { resolved: [], pending: [], unrelated: [] };

  const [aliases, existingDoctors] = await Promise.all([
    prisma.masterSurveyDoctorAlias.findMany({
      where: { surveyId },
      select: { fromKey: true, surveyDoctorId: true },
    }),
    prisma.masterSurveyDoctor.findMany({
      where: { surveyId },
      select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true, className: true, zoneName: true, phone: true, notes: true },
    }),
  ]);
  const aliasByKey = new Map(aliases.map(a => [a.fromKey, a]));
  const candById = new Map(existingDoctors.map(d => [d.id, d]));

  const groups = new Map();
  for (const r of rowsWithName) {
    const key = doctorLinkKey(r.name, r.areaName);
    if (!groups.has(key)) {
      groups.set(key, {
        key, raw: r.name, cleanedName: cleanDoctorName(r.name),
        areaName: r.areaName || '', specialty: r.specialty || '', pharmacyName: r.pharmacyName || '',
        rows: [],
      });
    }
    groups.get(key).rows.push(r);
  }

  const resolved = [], pending = [], unrelated = [];

  for (const g of groups.values()) {
    for (const r of g.rows) r.rowKey = g.key;

    const alias = aliasByKey.get(g.key);
    if (alias) {
      const doc = alias.surveyDoctorId ? candById.get(alias.surveyDoctorId) : null;
      for (const r of g.rows) r.matchedDoctorId = alias.surveyDoctorId ?? null;
      resolved.push({ raw: g.raw, key: g.key, status: 'linked', doctor: doc ? { id: doc.id, name: doc.name } : null });
      continue;
    }

    const cleanNorm = normalizeRepName(g.cleanedName);
    const exactMatches = existingDoctors.filter(c => normalizeRepName(c.name) === cleanNorm);
    let exact = null;
    if (exactMatches.length === 1) exact = exactMatches[0];
    else if (exactMatches.length > 1 && g.areaName) {
      const areaMatches = exactMatches.filter(c => c.areaName && normalizeAreaName(c.areaName) === normalizeAreaName(g.areaName));
      if (areaMatches.length === 1) exact = areaMatches[0];
    }
    if (exact) {
      for (const r of g.rows) r.matchedDoctorId = exact.id;
      resolved.push({ raw: g.raw, key: g.key, status: 'exact', doctor: { id: exact.id, name: exact.name } });
      continue;
    }

    const scored = exactMatches.length > 1
      ? exactMatches.map(c => ({ ...c, score: 1 }))
      : existingDoctors
          .map(c => ({ ...c, score: doctorMatchScore({ name: g.cleanedName, areaName: g.areaName, specialty: g.specialty, pharmacyName: g.pharmacyName }, c) }))
          .filter(c => c.score >= DOCTOR_ASK_FLOOR)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

    for (const r of g.rows) r.matchedDoctorId = null;
    if (scored.length === 0) {
      unrelated.push({ raw: g.raw, key: g.key, areaName: g.areaName, specialty: g.specialty, pharmacyName: g.pharmacyName });
    } else {
      pending.push({
        raw: g.raw, key: g.key, areaName: g.areaName, specialty: g.specialty, pharmacyName: g.pharmacyName,
        suggestions: scored.map(c => ({ id: c.id, name: c.name, score: c.score, areaName: c.areaName, specialty: c.specialty, pharmacyName: c.pharmacyName })),
      });
    }
  }

  const byName = (a, b) => a.raw.localeCompare(b.raw, 'ar');
  return { resolved: resolved.sort(byName), pending: pending.sort(byName), unrelated: unrelated.sort(byName) };
}

/**
 * يحفظ/يحدّث تطابقاً مؤكَّداً على مستوى السيرفي (MasterSurveyDoctorAlias) —
 * surveyDoctorId=null يعني «ليس أياً من الموجودين» فيُحفظ أيضاً كي لا يتكرّر
 * السؤال، وسيُنشأ طبيب سيرفي جديد دائماً لهذا الاسم.
 */
export async function saveSurveyDoctorAlias(surveyId, { fromName, areaName, surveyDoctorId, confidence = 'confirmed', createdById = null }) {
  const name = String(fromName ?? '').trim();
  if (!name || !normalizeRepName(cleanDoctorName(name))) return null;
  const fromKey = doctorLinkKey(name, areaName);
  return prisma.masterSurveyDoctorAlias.upsert({
    where:  { surveyId_fromKey: { surveyId, fromKey } },
    update: { fromName: name, areaName: areaName || null },
    create: { surveyId, fromKey, fromName: name, areaName: areaName || null, surveyDoctorId: surveyDoctorId ?? null, confidence, createdById },
  });
}

/**
 * يبحث عن alias مؤكَّد مسبقاً لاسم/منطقة ضمن مجموعة سيرفيات — يُستخدم في
 * استيراد الزيارات (findSurveyDoctor في doctor-visits-import.js) ليتعرّف
 * فوراً على تهجئة أكّدها السوبر أدمن سابقاً عبر استيراد أطباء السيرفي، بلا
 * حاجة لإعادة حساب درجة تشابه ولا عتبة نقاط — تأكيد بشري أعلى ثقة من أي تقدير آلي.
 */
export async function loadSurveyDoctorAliases(surveyIds) {
  if (!surveyIds?.length) return new Map();
  const rows = await prisma.masterSurveyDoctorAlias.findMany({
    where: { surveyId: { in: surveyIds } },
    select: { fromKey: true, surveyDoctorId: true },
  });
  return new Map(rows.map(r => [r.fromKey, r.surveyDoctorId]));
}
