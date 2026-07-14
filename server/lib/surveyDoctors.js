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
import { normalizeAreaName } from './itemResolver.js';

// الأدوار الميدانية (مُقيّدة بمناطقها). المدراء يرون كامل الفريق.
const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'commercial_rep']);
export const isFieldRole = (role) => FIELD_ROLES.has(role);

// ── مناطق مستخدم واحد من كِلا المصدرين (UserAreaAssignment + ScientificRepArea) ──
async function areaIdsForUser(userId, linkedRepId) {
  const [ua, sa] = await Promise.all([
    prisma.userAreaAssignment.findMany({ where: { userId }, select: { areaId: true } }),
    linkedRepId
      ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
      : Promise.resolve([]),
  ]);
  return [...ua.map(r => r.areaId), ...sa.map(r => r.areaId)];
}

// حل معرّف المندوب العلمي لمستخدم (linkedRepId ثم fallback عبر ScientificRepresentative.userId)
async function resolveRepId(userId, linkedRepId) {
  if (linkedRepId) return linkedRepId;
  const own = await prisma.scientificRepresentative.findFirst({ where: { userId }, select: { id: true } });
  return own?.id ?? null;
}

// ── resolveAreaScope(user, { repUserId }) ────────────────────────────────────
// يُرجع نطاق المناطق + السيرفيات النشطة:
//   - مندوب ميداني: مناطقه هو.
//   - مدير + repUserId: مناطق ذاك المندوب.
//   - مدير (الكل): اتحاد مناطق المدير + كل مندوبي فريقه (UserManagerAssignment).
export async function resolveAreaScope(user, { repUserId = null } = {}) {
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
  } else {
    // مدير "الكل": مناطقه + كل مندوبي الفريق
    const [ownU, subs] = await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { linkedRepId: true } }),
      prisma.userManagerAssignment.findMany({
        where: { managerId: user.id },
        include: { user: { select: { id: true, linkedRepId: true } } },
      }),
    ]);
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
  const normToArea = new Map(areaRecords.map(a => [normalizeAreaName(a.name), a]));

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
  if (scope.memberUserIds.length) orClauses.push({ userId: { in: scope.memberUserIds } });
  const bySurveyDocId = new Map();
  const byName = new Map();
  if (!orClauses.length) return { bySurveyDocId, byName };

  const visits = await prisma.doctorVisit.findMany({
    where: { OR: orClauses, ...(dateFilter ? { visitDate: dateFilter } : {}) },
    select: {
      id: true, visitDate: true, feedback: true, notes: true,
      item: { select: { id: true, name: true } },
      doctor: { select: { masterSurveyDoctorId: true, name: true } },
    },
    orderBy: { visitDate: 'desc' },
  });
  for (const v of visits) {
    const entry = { id: v.id, visitDate: v.visitDate, feedback: v.feedback, notes: v.notes, item: v.item };
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

// إيجاد/إنشاء منطقة بالاسم لمستخدم (لمزامنة areaId عند cascade)
async function resolveAreaIdForUser(areaName, userId) {
  if (!areaName?.trim()) return null;
  const norm = areaName.trim().toLowerCase();
  const userAreas = await prisma.area.findMany({ where: { userId }, select: { id: true, name: true } });
  const found = userAreas.find(a => a.name.trim().toLowerCase() === norm);
  if (found) return found.id;
  const created = await prisma.area.create({ data: { name: areaName.trim(), userId } });
  return created.id;
}

// ── createSurveyDoctor — إنشاء طبيب سيرفي موحّد (log + notify) ────────────────
// editedById: userId للمندوب/المدير، أو null للسوبر أدمن.
export async function createSurveyDoctor(surveyId, fields, editedById) {
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
export async function updateSurveyDoctor(surveyId, docId, fields, editedById) {
  const old = await prisma.masterSurveyDoctor.findUnique({ where: { id: docId } });
  if (!old || old.surveyId !== surveyId) return { error: 'not_found' };

  const data = { lastEditedById: editedById ?? null, lastEditedAt: new Date() };
  for (const key of ['name', 'specialty', 'areaName', 'pharmacyName', 'className', 'zoneName', 'phone', 'notes']) {
    if (fields[key] !== undefined) data[key] = key === 'name' ? String(fields[key]).trim() : fields[key];
  }

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
