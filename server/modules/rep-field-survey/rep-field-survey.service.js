// ════════════════════════════════════════════════════════════════════════════
// rep-field-survey.service.js — سيرفي المندوب العلمي الميداني
// ────────────────────────────────────────────────────────────────────────────
// أرشيف توثيقي فقط: أطباء وصيدليات يسجّلها المندوب العلمي بمنطقته مع موقع
// إلزامي لكل اسم. لا يُقرأ من المبيعات ولا الزيارات ولا التحليلات.
//
// الاستثناء الوحيد للربط: أطباء «القريبين من صيدلية» يُنشرون في سيرفي الأطباء
// الرئيسي (MasterSurveyDoctor) فيُعتبرون أطباء فعلاً كما تُعامل أي إضافة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { createSurveyDoctor, publishSurveyDoctorToOwners, doctorLinkKey } from '../../lib/surveyDoctors.js';

export const FIELD_REP_ROLE = 'scientific_rep';

// الأدوار التي ترى سيرفي مندوبيها (عرض فقط). الأدمن يرى الكل.
const VIEWER_ROLES = new Set([
  'company_manager', 'office_manager', 'office_hr', 'office_employee',
  'team_leader', 'supervisor', 'manager', 'admin',
]);

// ─── Validation helpers ──────────────────────────────────────

function requireText(value, missingMessage, max = 200) {
  const s = String(value ?? '').trim();
  if (!s) throw new AppError(missingMessage, 400, 'VALIDATION_ERROR');
  return s.slice(0, max);
}

function optionalText(value, max = 200) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

// الموقع إلزامي: بلا إحداثيات صالحة لا يُحفظ الاسم مطلقاً.
function requireCoords(body) {
  const latitude  = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const ok = Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180
    && !(latitude === 0 && longitude === 0);
  if (!ok) {
    throw new AppError('الموقع الجغرافي مطلوب — لا يمكن حفظ الاسم بدون تحديد موقعه على الخارطة', 400, 'LOCATION_REQUIRED');
  }
  const acc = Number(body?.accuracy);
  return { latitude, longitude, accuracy: Number.isFinite(acc) && acc >= 0 ? acc : null };
}

function assertFieldRep(user) {
  if (user?.role !== FIELD_REP_ROLE) {
    throw new AppError('هذه الصفحة للتسجيل متاحة لحساب المندوب العلمي فقط', 403, 'FORBIDDEN');
  }
}

// ─── Survey host (نفس منطق اختيار السيرفي المضيف في addDoctor/الاستيراد) ──────

async function hostSurveyIdFor(userId) {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } });
  const survey = await prisma.masterSurvey.findFirst({
    where: {
      isActive: true,
      hiddenUsers: { none: { userId } },
      ...(owner?.officeId ? { hiddenOffices: { none: { officeId: owner.officeId } } } : {}),
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return survey?.id ?? null;
}

// ─── Create ──────────────────────────────────────────────────

/** تسجيل طبيب مستقل — أرشيف فقط، لا نشر في سيرفي الأطباء. */
export async function createDoctorEntry(user, body) {
  assertFieldRep(user);
  const data = {
    userId:       user.id,
    kind:         'doctor',
    name:         requireText(body?.name, 'اسم الطبيب مطلوب'),
    specialty:    optionalText(body?.specialty),
    className:    optionalText(body?.className, 100),
    pharmacyName: optionalText(body?.pharmacyName),
    areaName:     requireText(body?.areaName, 'المنطقة مطلوبة'),
    notes:        optionalText(body?.notes, 1000),
    ...requireCoords(body),
  };
  const entry = await prisma.repFieldSurveyEntry.create({ data });
  return { entry };
}

/**
 * تسجيل صيدلية + أطبائها القريبين. كل طبيب قريب يرث موقع الصيدلية الملتقط لحظة
 * التسجيل (موقع واحد لكل زيارة ميدانية)، ويُنشر في سيرفي الأطباء الرئيسي.
 */
export async function createPharmacyEntry(user, body) {
  assertFieldRep(user);
  const name     = requireText(body?.name, 'اسم الصيدلية مطلوب');
  const areaName = requireText(body?.areaName, 'المنطقة مطلوبة');
  const notes    = optionalText(body?.notes, 1000);
  const coords   = requireCoords(body);

  // تجاهل الصفوف الفارغة، وأسقط المكرر داخل نفس الدفعة (نفس الاسم بعد التطبيع)
  const seen = new Set();
  const nearby = [];
  for (const d of Array.isArray(body?.doctors) ? body.doctors : []) {
    const dName = String(d?.name ?? '').trim();
    if (!dName) continue;
    const key = doctorLinkKey(dName, areaName);
    if (seen.has(key)) continue;
    seen.add(key);
    nearby.push({
      name:      dName.slice(0, 200),
      specialty: optionalText(d?.specialty),
      className: optionalText(d?.className, 100),
    });
  }

  const pharmacy = await prisma.repFieldSurveyEntry.create({
    data: {
      userId: user.id, kind: 'pharmacy', name, areaName, notes, ...coords,
      children: {
        create: nearby.map(d => ({
          userId: user.id, kind: 'doctor', areaName, pharmacyName: name, ...d, ...coords,
        })),
      },
    },
    include: { children: true },
  });

  // ── نشر أطباء الصيدلية في سيرفي الأطباء الرئيسي ──────────────────────────
  const hostId = await hostSurveyIdFor(user.id);
  const publish = { hostSurvey: !!hostId, published: 0, linkedExisting: 0, failed: 0 };

  if (hostId && pharmacy.children.length) {
    const existing = await prisma.masterSurveyDoctor.findMany({
      where: { surveyId: hostId, isActive: true },
      select: { id: true, name: true, areaName: true },
    });
    const byKey = new Map(existing.map(d => [doctorLinkKey(d.name, d.areaName), d.id]));

    for (const child of pharmacy.children) {
      try {
        const key = doctorLinkKey(child.name, areaName);
        let masterId = byKey.get(key);
        if (masterId) {
          publish.linkedExisting++;
        } else {
          const doc = await createSurveyDoctor(hostId, {
            name: child.name, specialty: child.specialty, areaName,
            pharmacyName: name, className: child.className,
          }, user.id);
          await publishSurveyDoctorToOwners(doc);
          masterId = doc.id;
          byKey.set(key, masterId);
          publish.published++;
        }
        await prisma.repFieldSurveyEntry.update({
          where: { id: child.id },
          data: { masterSurveyDoctorId: masterId },
        });
      } catch (err) {
        publish.failed++;
        console.error('[rep-field-survey] publish doctor failed', child.id, err?.message);
      }
    }
  }

  return { entry: pharmacy, nearbyCount: pharmacy.children.length, publish };
}

// ─── Update ──────────────────────────────────────────────────

/**
 * تعديل سجل يملكه المندوب نفسه فقط. الحقل الذي لا يُرسَل يبقى كما هو.
 * - تعديل اسم الصيدلية أو منطقتها أو موقعها يسري إلى أطبائها القريبين
 *   (الذين يرثون بياناتها). موقع الطبيب القريب المختلف عن موقع صيدليته لا يُمس.
 * - الطبيب القريب لا يغيّر اسم صيدليته، فهو يتبع الصيدلية الأم.
 * - الصف المنشور في سيرفي الأطباء الرئيسي لا يُعدَّل تلقائياً.
 */
export async function updateEntry(user, entryId, body) {
  assertFieldRep(user);
  const current = await prisma.repFieldSurveyEntry.findUnique({ where: { id: entryId } });
  if (!current || current.userId !== user.id) {
    throw new AppError('السجل غير موجود أو لا تملك صلاحية تعديله', 404, 'NOT_FOUND');
  }

  const data = { editedAt: new Date() };
  if (body?.name !== undefined) {
    data.name = requireText(body.name, current.kind === 'doctor' ? 'اسم الطبيب مطلوب' : 'اسم الصيدلية مطلوب');
  }
  if (body?.areaName !== undefined) data.areaName = requireText(body.areaName, 'المنطقة مطلوبة');
  if (body?.notes !== undefined) data.notes = optionalText(body.notes, 1000);
  if (current.kind === 'doctor') {
    if (body?.specialty !== undefined) data.specialty = optionalText(body.specialty);
    if (body?.className !== undefined) data.className = optionalText(body.className, 100);
    if (!current.parentId && body?.pharmacyName !== undefined) data.pharmacyName = optionalText(body.pharmacyName);
  }
  // الموقع: إن أُرسل أي إحداثي يجب أن تكون الإحداثيات كاملة وصالحة
  if (body?.latitude !== undefined || body?.longitude !== undefined) {
    Object.assign(data, requireCoords(body));
  }

  return prisma.$transaction(async tx => {
    const row = await tx.repFieldSurveyEntry.update({ where: { id: entryId }, data });
    if (current.kind === 'pharmacy') {
      const kidData = {};
      if (data.name !== undefined) kidData.pharmacyName = data.name;
      if (data.areaName !== undefined) kidData.areaName = data.areaName;
      if (Object.keys(kidData).length) {
        await tx.repFieldSurveyEntry.updateMany({ where: { parentId: entryId }, data: kidData });
      }
      if (data.latitude !== undefined) {
        // الأطباء الذين يرثون موقع الصيدلية فقط ينتقلون معها
        await tx.repFieldSurveyEntry.updateMany({
          where: { parentId: entryId, latitude: current.latitude, longitude: current.longitude },
          data: { latitude: data.latitude, longitude: data.longitude, accuracy: data.accuracy },
        });
      }
    }
    return { entry: row, publishedToDoctorSurvey: row.masterSurveyDoctorId != null };
  });
}

// ─── Read ────────────────────────────────────────────────────

/**
 * سيرفي المندوب: المندوب يرى سجلاته فقط. المدير يرى سجلات مندوبي فريقه (نفس
 * قائمة getManagerRoster المستخدمة في تحليل الكولات)، ويمكنه التصفية بمندوب.
 */
export async function listEntries(user, { repUserId = null, kind = null } = {}) {
  let userIds = null; // null = كل المستخدمين (أدمن فقط)
  let reps = [];

  if (user.role === FIELD_REP_ROLE) {
    userIds = [user.id];
  } else if (VIEWER_ROLES.has(user.role)) {
    if (user.role !== 'admin') {
      const roster = await getManagerRoster(user);
      reps = roster.reps;
      userIds = reps.map(r => r.userId);
    }
  } else {
    throw new AppError('لا تملك صلاحية عرض هذا السيرفي', 403, 'FORBIDDEN');
  }

  if (repUserId) {
    if (userIds && !userIds.includes(repUserId)) {
      throw new AppError('هذا المندوب ليس ضمن فريقك', 403, 'FORBIDDEN');
    }
    userIds = [repUserId];
  }

  const where = {
    ...(userIds ? { userId: { in: userIds } } : {}),
    ...(kind ? { kind } : {}),
  };

  const rows = userIds && userIds.length === 0 ? [] : await prisma.repFieldSurveyEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { parent: { select: { name: true } } },
  });

  // أسماء المندوبين للعرض في سجلات المدير (المندوب يرى اسمه فقط)
  const ownerIds = [...new Set(rows.map(r => r.userId))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const ownerName = new Map(owners.map(o => [o.id, o.displayName || o.username]));

  return {
    entries: rows.map(r => ({
      id:           r.id,
      userId:       r.userId,
      repName:      ownerName.get(r.userId) ?? null,
      kind:         r.kind,
      name:         r.name,
      specialty:    r.specialty,
      className:    r.className,
      pharmacyName: r.pharmacyName,
      areaName:     r.areaName,
      notes:        r.notes,
      latitude:     r.latitude,
      longitude:    r.longitude,
      accuracy:     r.accuracy,
      parentId:     r.parentId,
      parentName:   r.parent?.name ?? null,
      publishedToDoctorSurvey: r.masterSurveyDoctorId != null,
      createdAt:    r.createdAt,
      editedAt:     r.editedAt,
    })),
    // قائمة المندوبين للفلتر — للمدير فقط (المندوب لا يحتاجها)
    reps: reps.map(r => ({ userId: r.userId, name: r.name, company: r.company?.name ?? null })),
  };
}
