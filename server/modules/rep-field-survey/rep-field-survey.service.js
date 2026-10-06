// ════════════════════════════════════════════════════════════════════════════
// rep-field-survey.service.js — سيرفي المندوب العلمي الميداني
// ────────────────────────────────────────────────────────────────────────────
// أرشيف توثيقي: أطباء وصيدليات يسجّلها المندوب بمنطقته مع موقع إلزامي ودقة
// محددة. لا يُقرأ من المبيعات ولا الزيارات ولا التحليلات.
//
// الطبيب قد يرتبط بعدة صيدليات قريبة (طبيب واحد). الطبيب الذي له صيدلية قريبة
// واحدة على الأقل يُنشر في سيرفي الأطباء الرئيسي، فيُعتبر طبيباً فعلياً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { createSurveyDoctor, publishSurveyDoctorToOwners, doctorLinkKey, cleanDoctorName } from '../../lib/surveyDoctors.js';
import { normalizeRepName } from '../scientific-reps/scientific-reps.service.js';

export const FIELD_REP_ROLE = 'scientific_rep';

// أقصى خطأ مقبول في دقة الموقع (متر). أي قراءة أسوأ تُرفض ولا تُحفظ.
export const MAX_ACCURACY_M = 50;
const MAX_NEAR_PHARMACIES = 20;

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

// الموقع إلزامي، ودقته يجب أن تكون ضمن الحد. بلا ذلك لا يُحفظ الاسم.
function requireCoords(body) {
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const ok = Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180
    && !(latitude === 0 && longitude === 0);
  if (!ok) {
    throw new AppError('الموقع الجغرافي مطلوب — لا يمكن حفظ الاسم بدون تحديد موقعه على الخارطة', 400, 'LOCATION_REQUIRED');
  }
  const accuracy = Number(body?.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    throw new AppError('دقة الموقع غير معروفة — أعد تحديد الموقع', 400, 'LOCATION_REQUIRED');
  }
  if (accuracy > MAX_ACCURACY_M) {
    throw new AppError(`دقة الموقع ±${Math.round(accuracy)} م غير كافية (المطلوب ${MAX_ACCURACY_M} م أو أدق). اخرج إلى مكان مفتوح أو استخدم الهاتف مع GPS`, 400, 'LOW_ACCURACY');
  }
  return { latitude, longitude, accuracy };
}

function assertFieldRep(user) {
  if (user?.role !== FIELD_REP_ROLE) {
    throw new AppError('هذه الصفحة للتسجيل متاحة لحساب المندوب العلمي فقط', 403, 'FORBIDDEN');
  }
}

// مفاتيح المقارنة: الاسم بعد إزالة «د.» وتطبيع العربية، والصيدلية بتطبيع الاسم فقط
const doctorKey = (name) => normalizeRepName(cleanDoctorName(name));
const plainKey = (name) => normalizeRepName(String(name ?? '').trim());

// إزالة التكرار (بالتطبيع) دون حد — تُستعمل عند القراءة لتفادي رفض بيانات قديمة
function dedupeNames(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw ?? '').trim().slice(0, 200);
    const k = plainKey(name);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

function cleanNearPharmacies(list) {
  const out = dedupeNames(list);
  if (out.length > MAX_NEAR_PHARMACIES) {
    throw new AppError(`عدد الصيدليات القريبة كبير جداً (الحد ${MAX_NEAR_PHARMACIES})`, 400, 'VALIDATION_ERROR');
  }
  return out;
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

async function loadMasterDoctors(hostId) {
  if (!hostId) return [];
  return prisma.masterSurveyDoctor.findMany({
    where: { surveyId: hostId, isActive: true },
    select: { id: true, name: true, areaName: true, pharmacyName: true },
  });
}

// الارتباط القديم (parentId) يُدمج في قائمة الصيدليات قبل أي تعديل عليها
async function migrateLegacyParent(row) {
  if (!row.parentId) return row;
  const parent = await prisma.repFieldSurveyEntry.findUnique({ where: { id: row.parentId }, select: { name: true } });
  return { ...row, nearPharmacies: dedupeNames([...row.nearPharmacies, parent?.name]), parentId: null };
}

/**
 * ينشر طبيباً له صيدلية قريبة واحدة على الأقل في سيرفي الأطباء الرئيسي.
 * إن وُجد طبيب بنفس الاسم والمنطقة فيه يُربط به بدل التكرار.
 * @returns {'published'|'linked'|'skipped'|'no-survey'|'already'|'failed'}
 */
async function ensurePublished(user, hostId, entry, masterRows) {
  if (!hostId) return 'no-survey';
  if (entry.masterSurveyDoctorId) return 'already';
  if (!entry.nearPharmacies.length) return 'skipped';
  try {
    const key = doctorLinkKey(entry.name, entry.areaName);
    const hit = masterRows.find(d => doctorLinkKey(d.name, d.areaName) === key);
    let masterId;
    let status;
    if (hit) {
      masterId = hit.id;
      status = 'linked';
    } else {
      const doc = await createSurveyDoctor(hostId, {
        name: entry.name,
        specialty: entry.specialty,
        areaName: entry.areaName,
        pharmacyName: entry.nearPharmacies.join('، '),
        className: entry.className,
      }, user.id);
      await publishSurveyDoctorToOwners(doc);
      masterRows.push({ id: doc.id, name: doc.name, areaName: doc.areaName, pharmacyName: doc.pharmacyName });
      masterId = doc.id;
      status = 'published';
    }
    await prisma.repFieldSurveyEntry.update({ where: { id: entry.id }, data: { masterSurveyDoctorId: masterId } });
    return status;
  } catch (err) {
    console.error('[rep-field-survey] publish failed', entry.id, err?.message);
    return 'failed';
  }
}

// الأسماء المكررة: سجلات المندوب نفسه، وللأطباء أيضاً سيرفي الأطباء
async function findNameMatches(userId, kind, name, hostId) {
  const key = kind === 'doctor' ? doctorKey(name) : plainKey(name);
  const own = await prisma.repFieldSurveyEntry.findMany({
    where: { userId, kind },
    select: { id: true, name: true, areaName: true, nearPharmacies: true },
  });
  const matches = own
    .filter(e => (kind === 'doctor' ? doctorKey(e.name) : plainKey(e.name)) === key)
    .map(e => ({ source: 'own', id: e.id, name: e.name, areaName: e.areaName, nearPharmacies: e.nearPharmacies }));
  if (kind === 'doctor') {
    for (const d of await loadMasterDoctors(hostId)) {
      if (doctorKey(d.name) === key) {
        matches.push({ source: 'survey', id: d.id, name: d.name, areaName: d.areaName, nearPharmacies: d.pharmacyName ? [d.pharmacyName] : [] });
      }
    }
  }
  return matches;
}

// ─── Create ──────────────────────────────────────────────────

/**
 * تسجيل طبيب. الصيدليات القريبة (قائمة) تُربط بالطبيب الواحد.
 * - اسم مكرر: يُرجع { duplicate, matches } ولا يحفظ، إلا إذا أُرسل allowDuplicate.
 * - mergeIntoId: يضيف الصيدليات إلى طبيب موجود لديك بدل إنشاء سجل ثانٍ.
 */
export async function createDoctorEntry(user, body) {
  assertFieldRep(user);
  const name = requireText(body?.name, 'اسم الطبيب مطلوب');
  const areaName = requireText(body?.areaName, 'المنطقة مطلوبة');
  const coords = requireCoords(body);
  const nearPharmacies = cleanNearPharmacies([
    ...(Array.isArray(body?.nearPharmacies) ? body.nearPharmacies : []),
    body?.pharmacyName,
  ]);
  const hostId = await hostSurveyIdFor(user.id);

  const mergeIntoId = Number(body?.mergeIntoId) || null;
  if (mergeIntoId) {
    const target = await prisma.repFieldSurveyEntry.findUnique({ where: { id: mergeIntoId } });
    if (!target || target.userId !== user.id || target.kind !== 'doctor') {
      throw new AppError('الطبيب المراد الدمج معه غير موجود', 404, 'NOT_FOUND');
    }
    const base = await migrateLegacyParent(target);
    const entry = await prisma.repFieldSurveyEntry.update({
      where: { id: mergeIntoId },
      data: {
        nearPharmacies: cleanNearPharmacies([...base.nearPharmacies, ...nearPharmacies]),
        parentId: null,
        editedAt: new Date(),
      },
    });
    const status = await ensurePublished(user, hostId, entry, await loadMasterDoctors(hostId));
    return { entry, merged: true, publish: { status } };
  }

  if (!body?.allowDuplicate) {
    const matches = await findNameMatches(user.id, 'doctor', name, hostId);
    if (matches.length) return { duplicate: true, matches };
  }

  const entry = await prisma.repFieldSurveyEntry.create({
    data: {
      userId: user.id,
      kind: 'doctor',
      name,
      specialty: optionalText(body?.specialty),
      className: optionalText(body?.className, 100),
      areaName,
      notes: optionalText(body?.notes, 1000),
      nearPharmacies,
      ...coords,
    },
  });
  const status = await ensurePublished(user, hostId, entry, await loadMasterDoctors(hostId));
  return { entry, merged: false, publish: { status } };
}

/**
 * تسجيل صيدلية + أطبائها القريبين.
 * طبيب مسجَّل لديك بنفس الاسم يُربط بهذه الصيدلية (بدون تغيير موقعه) بدل التكرار.
 * الطبيب الجديد يرث موقع الصيدلية الملتقط لحظة التسجيل.
 */
export async function createPharmacyEntry(user, body) {
  assertFieldRep(user);
  const name = requireText(body?.name, 'اسم الصيدلية مطلوب');
  const areaName = requireText(body?.areaName, 'المنطقة مطلوبة');
  const notes = optionalText(body?.notes, 1000);
  const coords = requireCoords(body);
  const hostId = await hostSurveyIdFor(user.id);

  if (!body?.allowDuplicate) {
    const matches = await findNameMatches(user.id, 'pharmacy', name, hostId);
    if (matches.length) return { duplicate: true, matches };
  }

  // أطباء الدفعة الواحدة بلا تكرار
  const nearbyInput = [];
  const seenKeys = new Set();
  for (const d of Array.isArray(body?.doctors) ? body.doctors : []) {
    const dName = String(d?.name ?? '').trim().slice(0, 200);
    if (!dName) continue;
    const k = doctorKey(dName);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    nearbyInput.push({ name: dName, specialty: optionalText(d?.specialty), className: optionalText(d?.className, 100) });
  }

  const pharmacy = await prisma.repFieldSurveyEntry.create({
    data: { userId: user.id, kind: 'pharmacy', name, areaName, notes, ...coords },
  });

  const ownDoctors = await prisma.repFieldSurveyEntry.findMany({ where: { userId: user.id, kind: 'doctor' } });
  const masterRows = await loadMasterDoctors(hostId);
  const counts = { created: 0, linkedOwn: 0 };
  const publish = { hostSurvey: !!hostId, published: 0, linkedSurvey: 0, failed: 0 };

  for (const d of nearbyInput) {
    try {
      const k = doctorKey(d.name);
      const own = ownDoctors.find(o => doctorKey(o.name) === k);
      let doctor;
      if (own) {
        const base = await migrateLegacyParent(own);
        doctor = await prisma.repFieldSurveyEntry.update({
          where: { id: own.id },
          data: { nearPharmacies: dedupeNames([...base.nearPharmacies, name]), parentId: null, editedAt: new Date() },
        });
        counts.linkedOwn++;
      } else {
        doctor = await prisma.repFieldSurveyEntry.create({
          data: {
            userId: user.id,
            kind: 'doctor',
            name: d.name,
            specialty: d.specialty,
            className: d.className,
            areaName,
            nearPharmacies: [name],
            ...coords,
          },
        });
        ownDoctors.push(doctor);
        counts.created++;
      }
      const status = await ensurePublished(user, hostId, doctor, masterRows);
      if (status === 'published') publish.published++;
      if (status === 'linked') publish.linkedSurvey++;
      if (status === 'failed') publish.failed++;
    } catch (err) {
      publish.failed++;
      console.error('[rep-field-survey] nearby doctor failed', d.name, err?.message);
    }
  }

  return { entry: pharmacy, nearbyCount: nearbyInput.length, nearby: counts, publish };
}

// ─── Update ──────────────────────────────────────────────────

/**
 * تعديل سجل يملكه المندوب نفسه فقط. الحقل الذي لا يُرسَل يبقى كما هو.
 * - تغيير اسم الصيدلية يُحدِّث الأطباء الذين يذكرونها.
 * - تعديل منطقة الصيدلية أو موقعها يسري إلى الأطباء المرتبطين بها بالطريقة القديمة فقط.
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
    if (body?.nearPharmacies !== undefined) {
      data.nearPharmacies = cleanNearPharmacies(body.nearPharmacies);
      data.parentId = null;
    }
  }
  if (body?.latitude !== undefined || body?.longitude !== undefined) {
    Object.assign(data, requireCoords(body));
  }

  const row = await prisma.$transaction(async tx => {
    const updated = await tx.repFieldSurveyEntry.update({ where: { id: entryId }, data });
    if (current.kind === 'pharmacy') {
      // الأطباء المرتبطون بالطريقة القديمة (parentId) يتبعون الصيدلية في منطقتها وموقعها
      if (data.areaName !== undefined) {
        await tx.repFieldSurveyEntry.updateMany({ where: { parentId: entryId }, data: { areaName: data.areaName } });
      }
      if (data.latitude !== undefined) {
        await tx.repFieldSurveyEntry.updateMany({
          where: { parentId: entryId, latitude: current.latitude, longitude: current.longitude },
          data: { latitude: data.latitude, longitude: data.longitude, accuracy: data.accuracy },
        });
      }
      // تغيير الاسم يُحدِّث الأطباء الذين يذكرون الصيدلية بالاسم القديم
      if (data.name !== undefined && plainKey(data.name) !== plainKey(current.name)) {
        const owned = await tx.repFieldSurveyEntry.findMany({
          where: { userId: user.id, kind: 'doctor' },
          select: { id: true, nearPharmacies: true },
        });
        for (const d of owned) {
          if (!d.nearPharmacies.some(p => plainKey(p) === plainKey(current.name))) continue;
          const renamed = dedupeNames(d.nearPharmacies.map(p => (plainKey(p) === plainKey(current.name) ? data.name : p)));
          await tx.repFieldSurveyEntry.update({ where: { id: d.id }, data: { nearPharmacies: renamed } });
        }
      }
    }
    return updated;
  });

  let publish = null;
  if (current.kind === 'doctor' && data.nearPharmacies !== undefined) {
    const hostId = await hostSurveyIdFor(user.id);
    publish = { status: await ensurePublished(user, hostId, row, await loadMasterDoctors(hostId)) };
  }
  return { entry: row, publishedToDoctorSurvey: row.masterSurveyDoctorId != null, publish };
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

  // صيدليات كل مندوب بمفتاح الاسم — لربط الطبيب بالصيدليات المسجَّلة فعلاً
  const pharmaIdsByKey = new Map();
  for (const r of rows) {
    if (r.kind !== 'pharmacy') continue;
    const k = `${r.userId}|${plainKey(r.name)}`;
    pharmaIdsByKey.set(k, [...(pharmaIdsByKey.get(k) ?? []), r.id]);
  }

  const ownerIds = [...new Set(rows.map(r => r.userId))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const ownerName = new Map(owners.map(o => [o.id, o.displayName || o.username]));

  return {
    entries: rows.map(r => {
      const isDoctor = r.kind === 'doctor';
      // الصيدليات القريبة = المخزَّنة + الصيدلية القديمة المرتبطة بالمعرّف (إن وُجدت)
      const nearPharmacies = isDoctor ? dedupeNames([...r.nearPharmacies, r.parent?.name]) : [];
      const pharmacyIds = isDoctor ? [...new Set([
        ...(r.parentId ? [r.parentId] : []),
        ...nearPharmacies.flatMap(p => pharmaIdsByKey.get(`${r.userId}|${plainKey(p)}`) ?? []),
      ])] : [];
      return {
        id:           r.id,
        userId:       r.userId,
        repName:      ownerName.get(r.userId) ?? null,
        kind:         r.kind,
        name:         r.name,
        specialty:    r.specialty,
        className:    r.className,
        areaName:     r.areaName,
        notes:        r.notes,
        latitude:     r.latitude,
        longitude:    r.longitude,
        accuracy:     r.accuracy,
        nearPharmacies,
        pharmacyIds,
        publishedToDoctorSurvey: r.masterSurveyDoctorId != null,
        createdAt:    r.createdAt,
        editedAt:     r.editedAt,
      };
    }),
    // قائمة المندوبين للفلتر — للمدير فقط (المندوب لا يحتاجها)
    reps: reps.map(r => ({ userId: r.userId, name: r.name, company: r.company?.name ?? null })),
  };
}
