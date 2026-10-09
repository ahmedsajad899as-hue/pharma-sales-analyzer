// ════════════════════════════════════════════════════════════════════════════
// rep-field-survey.service.js — سيرفي المندوب العلمي الميداني
// ────────────────────────────────────────────────────────────────────────────
// أرشيف توثيقي فقط ومعزول تماماً: لا يقرأ من السيرفي الرئيسي ولا يكتب فيه،
// ولا يُقرأ من المبيعات أو الزيارات أو التحليلات.
//
// الطبيب قد يرتبط بعدة صيدليات قريبة (طبيب واحد). كل اسم يحمل موقعاً إلزامياً
// ودقة محددة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import { resolveEffectiveAreaNames } from '../../lib/areaScope.js';
import { cleanDoctorName } from '../../lib/surveyDoctors.js';
import { normalizeRepName } from '../scientific-reps/scientific-reps.service.js';

export const FIELD_REP_ROLE = 'scientific_rep';

// أقصى خطأ مقبول في دقة الموقع (متر). أي قراءة أسوأ تُرفض ولا تُحفظ.
export const MAX_ACCURACY_M = 50;
const MAX_NEAR_PHARMACIES = 20;

// الأدوار التي ترى سجلات مندوبيها (عرض فقط). الأدمن يرى الكل.
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

// المندوب لا يحتاج كتابة «د./دكتور» أو «صيدلية» — إن كتبها من عادة تُزال تلقائياً
// عند الحفظ بدل أن تبقى مكررة داخل الاسم المخزَّن.
const DOCTOR_NAME_PREFIX_RE = /^\s*(الدكتورة|الدكتور|دكتورة|دكتور|د\.?)\s+/i;
const PHARMACY_NAME_PREFIX_RE = /^\s*(صيدلية|صيدليه)\s+/i;

function stripDoctorPrefix(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3 && DOCTOR_NAME_PREFIX_RE.test(s); i++) s = s.replace(DOCTOR_NAME_PREFIX_RE, '').trim();
  return s;
}

function stripPharmacyPrefix(name) {
  return String(name ?? '').trim().replace(PHARMACY_NAME_PREFIX_RE, '').trim();
}

// نظيرا requireText مع إزالة البادئة — الاسم الفارغ بعد الإزالة (مثلاً "د." وحدها) يُرفض أيضاً
function requireDoctorName(value, max = 200) {
  const s = stripDoctorPrefix(value).slice(0, max);
  if (!s) throw new AppError('اسم الطبيب مطلوب', 400, 'VALIDATION_ERROR');
  return s;
}

function requirePharmacyName(value, max = 200) {
  const s = stripPharmacyPrefix(value).slice(0, max);
  if (!s) throw new AppError('اسم الصيدلية مطلوب', 400, 'VALIDATION_ERROR');
  return s;
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
const areaKey = (name) => normalizeRepName(String(name ?? '').trim());

// ════════════════════════════════════════════════════════════════════════════
// المشاركة بين مندوبي المكتب الواحد على المناطق المشتركة
// ────────────────────────────────────────────────────────────────────────────
// أربعة مندوبين في مكتب واحد يعملون جميعاً على «مدينة الصدر» — ولو كانوا على
// شركات مختلفة — يرون أسماء بعضهم في تلك المنطقة ويعدّلون تفاصيلها، بدل أن
// يُعيد كلٌّ منهم تسجيل نفس الطبيب/الصيدلية من الصفر.
//
// المطابقة باسم المنطقة المطبَّع لا بمعرّفها: Area مُفهرسة @@unique([name,userId])
// فلكل حساب صفٌّ منفصل لنفس المنطقة (راجع areaScope.js) — ومقارنة المعرّفات بين
// حسابَين مختلفين تُرجع «لا تقاطع» دائماً حتى لو كانا على نفس الزون حرفياً.
//
// الحدّ: المكتب. مندوبان في مكتبين مختلفين لا يريان بعضهما ولو تشابهت أسماء
// مناطقهما.
// ════════════════════════════════════════════════════════════════════════════

async function officeIdsOf(userId) {
  const [u, assignments] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } }),
    prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { company: { select: { officeId: true } } },
    }),
  ]);
  return [...new Set([
    ...(u?.officeId ? [u.officeId] : []),
    ...assignments.map(a => a.company?.officeId).filter(Boolean),
  ])];
}

/**
 * زملاء المندوب في نفس المكتب + أسماء مناطقه المطبّعة.
 * بلا مكتب أو بلا مناطق مُعيَّنة → لا مشاركة (يرى سجلاته وحدها كما كان).
 * @returns {Promise<{ peerIds: Set<number>, areaKeys: Set<string> }>}
 */
export async function resolveRepSharedScope(user) {
  const empty = { peerIds: new Set(), areaKeys: new Set() };
  if (user?.role !== FIELD_REP_ROLE) return empty;

  const [officeIds, areaNames] = await Promise.all([
    officeIdsOf(user.id),
    resolveEffectiveAreaNames(user.id),
  ]);
  const areaKeys = new Set(areaNames.map(areaKey).filter(Boolean));
  if (!officeIds.length || areaKeys.size === 0) return { peerIds: new Set(), areaKeys };

  const officeCompanies = await prisma.scientificCompany.findMany({
    where: { officeId: { in: officeIds } },
    select: { id: true },
  });
  const companyIds = officeCompanies.map(c => c.id);

  const peers = await prisma.user.findMany({
    where: {
      isActive: true,
      id: { not: user.id },
      role: FIELD_REP_ROLE,
      OR: [
        { officeId: { in: officeIds } },
        ...(companyIds.length ? [{ companyAssignments: { some: { companyId: { in: companyIds } } } }] : []),
      ],
    },
    select: { id: true },
  });
  return { peerIds: new Set(peers.map(p => p.id)), areaKeys };
}

/** هل يرى/يعدّل هذا المندوبُ سجلاً ليس له؟ نعم إن كان لزميل مكتب في منطقة من مناطقه. */
function inSharedScope(scope, entry) {
  return scope.peerIds.has(entry.userId) && scope.areaKeys.has(areaKey(entry.areaName));
}

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

// الارتباط القديم (parentId) يُدمج في قائمة الصيدليات قبل أي تعديل عليها
async function migrateLegacyParent(row) {
  if (!row.parentId) return row;
  const parent = await prisma.repFieldSurveyEntry.findUnique({ where: { id: row.parentId }, select: { name: true } });
  return { ...row, nearPharmacies: dedupeNames([...row.nearPharmacies, parent?.name]), parentId: null };
}

/**
 * الصيدليات القريبة المكتوبة مع طبيب ولا وجود لها كصيدلية مسجَّلة لدى هذا
 * المندوب تُنشأ الآن صفاً صيدلية حقيقياً (بموقع الطبيب نفسه لحظة تسجيله) — فتظهر
 * في خانة الصيدليات أيضاً. الربط بالاسم (pharmacyIds في listEntries) يلتقطها
 * تلقائياً بلا أي تغيير إضافي، لأنه مبني على تطابق الاسم لا على معرّف صريح.
 */
async function ensureOwnPharmacies(userId, names, areaName, coords) {
  if (!names.length) return 0;
  const own = await prisma.repFieldSurveyEntry.findMany({
    where: { userId, kind: 'pharmacy' },
    select: { name: true },
  });
  const ownKeys = new Set(own.map(p => plainKey(p.name)));
  let created = 0;
  for (const name of names) {
    const k = plainKey(name);
    if (ownKeys.has(k)) continue;
    ownKeys.add(k);
    try {
      await prisma.repFieldSurveyEntry.create({
        data: { userId, kind: 'pharmacy', name, areaName, notes: null, ...coords },
      });
      created++;
    } catch (err) {
      console.error('[rep-field-survey] auto-create pharmacy failed', name, err?.message);
    }
  }
  return created;
}

/**
 * الأسماء المكررة: كل سجلات المندوب نفسه (بأي منطقة)، إضافة إلى سجلات زملاء
 * المكتب في نفس المنطقة المُدخَلة — فلا يُعيد مندوبان تسجيل نفس الطبيب في
 * «مدينة الصدر» كلٌّ على حِدة. تقييد مطابقة الزملاء بالمنطقة مقصود: نفس الاسم
 * في منطقة أخرى غالباً شخص آخر، والتنبيه عنه ضجيج.
 */
async function findNameMatches(user, kind, name, areaName, scope) {
  const key = kind === 'doctor' ? doctorKey(name) : plainKey(name);
  const newAreaKey = areaKey(areaName);
  const candidateIds = [user.id, ...scope.peerIds];
  const rows = await prisma.repFieldSurveyEntry.findMany({
    where: { userId: { in: candidateIds }, kind },
    select: { id: true, userId: true, name: true, areaName: true, nearPharmacies: true },
  });
  const matches = rows
    .filter(e => (kind === 'doctor' ? doctorKey(e.name) : plainKey(e.name)) === key)
    .filter(e => e.userId === user.id || (inSharedScope(scope, e) && areaKey(e.areaName) === newAreaKey));
  if (!matches.length) return [];

  const otherIds = [...new Set(matches.map(m => m.userId).filter(id => id !== user.id))];
  const owners = otherIds.length
    ? await prisma.user.findMany({ where: { id: { in: otherIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const ownerName = new Map(owners.map(o => [o.id, o.displayName || o.username]));

  return matches.map(e => ({
    id: e.id,
    name: e.name,
    areaName: e.areaName,
    nearPharmacies: e.nearPharmacies,
    repName: e.userId === user.id ? null : (ownerName.get(e.userId) ?? null),
  }));
}

// ─── Create ──────────────────────────────────────────────────

/**
 * تسجيل طبيب في الأرشيف. الصيدليات القريبة (قائمة) تُربط بالطبيب الواحد.
 * - اسم مكرر في سجلاتك: يُرجع { duplicate, matches } ولا يحفظ، إلا مع allowDuplicate.
 * - mergeIntoId: يضيف الصيدليات إلى طبيب موجود لديك بدل إنشاء سجل ثانٍ.
 */
export async function createDoctorEntry(user, body) {
  assertFieldRep(user);
  const name = requireDoctorName(body?.name);
  const areaName = requireText(body?.areaName, 'المنطقة مطلوبة');
  const coords = requireCoords(body);
  const nearPharmacies = cleanNearPharmacies([
    ...(Array.isArray(body?.nearPharmacies) ? body.nearPharmacies : []),
    body?.pharmacyName,
  ]);

  const scope = await resolveRepSharedScope(user);
  const mergeIntoId = Number(body?.mergeIntoId) || null;
  if (mergeIntoId) {
    const target = await prisma.repFieldSurveyEntry.findUnique({ where: { id: mergeIntoId } });
    // الدمج متاح مع طبيب زميل في منطقة مشتركة أيضاً — وهو المقصود أصلاً من
    // عرض التكرار عبر المكتب: اسم واحد بدل اسمين.
    if (!target || target.kind !== 'doctor' || (target.userId !== user.id && !inSharedScope(scope, target))) {
      throw new AppError('الطبيب المراد الدمج معه غير موجود', 404, 'NOT_FOUND');
    }
    const base = await migrateLegacyParent(target);
    const entry = await prisma.repFieldSurveyEntry.update({
      where: { id: mergeIntoId },
      data: {
        nearPharmacies: cleanNearPharmacies([...base.nearPharmacies, ...nearPharmacies]),
        parentId: null,
        editedAt: new Date(),
        editedById: user.id,
      },
    });
    // الصيدليات تُنشأ تحت مالك السجل لا تحت المُدمِج، حتى يبقى الربط بالاسم
    // (pharmaIdsByKey في listEntries) متسقاً داخل حساب المالك.
    const pharmaciesCreated = await ensureOwnPharmacies(target.userId, entry.nearPharmacies, entry.areaName, {
      latitude: entry.latitude, longitude: entry.longitude, accuracy: entry.accuracy,
    });
    return { entry, merged: true, pharmaciesCreated };
  }

  if (!body?.allowDuplicate) {
    const matches = await findNameMatches(user, 'doctor', name, areaName, scope);
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
  const pharmaciesCreated = await ensureOwnPharmacies(user.id, nearPharmacies, areaName, coords);
  return { entry, merged: false, pharmaciesCreated };
}

/**
 * تسجيل صيدلية + أطبائها القريبين في الأرشيف.
 * طبيب مسجَّل لديك بنفس الاسم يُربط بهذه الصيدلية (بدون تغيير موقعه) بدل التكرار.
 * الطبيب الجديد يرث موقع الصيدلية الملتقط لحظة التسجيل.
 */
export async function createPharmacyEntry(user, body) {
  assertFieldRep(user);
  const name = requirePharmacyName(body?.name);
  const areaName = requireText(body?.areaName, 'المنطقة مطلوبة');
  const notes = optionalText(body?.notes, 1000);
  const coords = requireCoords(body);

  if (!body?.allowDuplicate) {
    const scope = await resolveRepSharedScope(user);
    const matches = await findNameMatches(user, 'pharmacy', name, areaName, scope);
    if (matches.length) return { duplicate: true, matches };
  }

  // أطباء الدفعة الواحدة بلا تكرار
  const nearbyInput = [];
  const seenKeys = new Set();
  for (const d of Array.isArray(body?.doctors) ? body.doctors : []) {
    const dName = stripDoctorPrefix(d?.name).slice(0, 200);
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
  const counts = { created: 0, linkedOwn: 0, failed: 0 };

  for (const d of nearbyInput) {
    try {
      const k = doctorKey(d.name);
      const own = ownDoctors.find(o => doctorKey(o.name) === k);
      if (own) {
        const base = await migrateLegacyParent(own);
        await prisma.repFieldSurveyEntry.update({
          where: { id: own.id },
          data: { nearPharmacies: dedupeNames([...base.nearPharmacies, name]), parentId: null, editedAt: new Date() },
        });
        counts.linkedOwn++;
      } else {
        const doctor = await prisma.repFieldSurveyEntry.create({
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
    } catch (err) {
      counts.failed++;
      console.error('[rep-field-survey] nearby doctor failed', d.name, err?.message);
    }
  }

  return { entry: pharmacy, nearbyCount: nearbyInput.length, nearby: counts };
}

// ─── Update ──────────────────────────────────────────────────

/**
 * تعديل سجل يملكه المندوب نفسه فقط. الحقل الذي لا يُرسَل يبقى كما هو.
 * - تغيير اسم الصيدلية يُحدِّث الأطباء الذين يذكرونها.
 * - تعديل منطقة الصيدلية أو موقعها يسري إلى الأطباء المرتبطين بها بالطريقة القديمة فقط.
 */
export async function updateEntry(user, entryId, body) {
  assertFieldRep(user);
  const current = await prisma.repFieldSurveyEntry.findUnique({ where: { id: entryId } });
  if (!current) throw new AppError('السجل غير موجود أو لا تملك صلاحية تعديله', 404, 'NOT_FOUND');
  if (current.userId !== user.id) {
    const scope = await resolveRepSharedScope(user);
    if (!inSharedScope(scope, current)) {
      throw new AppError('السجل غير موجود أو لا تملك صلاحية تعديله', 404, 'NOT_FOUND');
    }
  }
  // كل العمليات التابعة تجري تحت مالك السجل لا تحت المُعدِّل: الطبيب الذي
  // يذكر صيدليةً، والصيدليات التي تُنشأ تلقائياً، كلها تخص حساب المالك —
  // وإلا انقسم السجل الواحد بين حسابين عند أول تعديل من زميل.
  const ownerId = current.userId;

  const data = { editedAt: new Date(), editedById: user.id };
  if (body?.name !== undefined) {
    data.name = current.kind === 'doctor' ? requireDoctorName(body.name) : requirePharmacyName(body.name);
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
          where: { userId: ownerId, kind: 'doctor' },
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

  let pharmaciesCreated = 0;
  if (current.kind === 'doctor' && data.nearPharmacies !== undefined) {
    pharmaciesCreated = await ensureOwnPharmacies(ownerId, row.nearPharmacies, row.areaName, {
      latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy,
    });
  }
  return { entry: row, pharmaciesCreated };
}

// ─── Read ────────────────────────────────────────────────────

/**
 * سيرفي المندوب: المندوب يرى سجلاته + سجلات زملاء مكتبه في المناطق التي يعمل
 * عليها هو (resolveRepSharedScope). المدير يرى سجلات مندوبي فريقه (نفس قائمة
 * getManagerRoster المستخدمة في تحليل الكولات)، ويمكنه التصفية بمندوب.
 */
export async function listEntries(user, { repUserId = null, kind = null } = {}) {
  let userIds = null; // null = كل المستخدمين (أدمن فقط)
  let reps = [];
  let scope = null;   // نطاق المشاركة — للمندوب فقط

  if (user.role === FIELD_REP_ROLE) {
    scope = await resolveRepSharedScope(user);
    userIds = [user.id, ...scope.peerIds];
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

  const allRows = userIds && userIds.length === 0 ? [] : await prisma.repFieldSurveyEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { parent: { select: { name: true } } },
  });

  // من سجلات الزملاء لا يظهر إلا ما يقع في مناطق هذا المندوب — سجلاته هو تظهر
  // كاملة مهما كانت منطقتها (قد تكون سجّل في منطقة قبل نقلها عنه).
  const rows = scope
    ? allRows.filter(r => r.userId === user.id || scope.areaKeys.has(areaKey(r.areaName)))
    : allRows;

  // صيدليات كل مندوب بمفتاح الاسم — لربط الطبيب بالصيدليات المسجَّلة فعلاً
  const pharmaIdsByKey = new Map();
  for (const r of rows) {
    if (r.kind !== 'pharmacy') continue;
    const k = `${r.userId}|${plainKey(r.name)}`;
    pharmaIdsByKey.set(k, [...(pharmaIdsByKey.get(k) ?? []), r.id]);
  }

  const peopleIds = [...new Set([
    ...rows.map(r => r.userId),
    ...rows.map(r => r.editedById).filter(Boolean),
  ])];
  const people = peopleIds.length
    ? await prisma.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true, username: true } })
    : [];
  const ownerName = new Map(people.map(o => [o.id, o.displayName || o.username]));

  // قائمة المندوبين للفلتر: للمدير فريقه، وللمندوب نفسه + زملاء المكتب الذين
  // يشاركونه مناطقه (مع شركة كلٍّ منهم — فالزملاء قد يكونون على شركات مختلفة).
  let repsOut = reps.map(r => ({ userId: r.userId, name: r.name, company: r.company?.name ?? null }));
  if (scope) {
    const visibleOwnerIds = [...new Set(rows.map(r => r.userId))];
    const companyRows = visibleOwnerIds.length
      ? await prisma.userCompanyAssignment.findMany({
        where: { userId: { in: visibleOwnerIds }, isPrimary: true },
        select: { userId: true, company: { select: { name: true } } },
      })
      : [];
    const companyOf = new Map(companyRows.map(c => [c.userId, c.company?.name ?? null]));
    repsOut = visibleOwnerIds
      .map(id => ({ userId: id, name: ownerName.get(id) ?? '—', company: companyOf.get(id) ?? null }))
      .sort((a, b) => (a.userId === user.id ? -1 : b.userId === user.id ? 1 : a.name.localeCompare(b.name, 'ar')));
  }

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
        createdAt:    r.createdAt,
        editedAt:     r.editedAt,
        editedByName: r.editedById ? (ownerName.get(r.editedById) ?? null) : null,
        // التعديل متاح للمالك ولزملاء المكتب في مناطقه المشتركة. المدير يطّلع
        // ويصدّر فقط (كما كان) — فلا يُحسب له canEdit.
        canEdit:      scope ? (r.userId === user.id || inSharedScope(scope, r)) : false,
      };
    }),
    reps: repsOut,
  };
}
