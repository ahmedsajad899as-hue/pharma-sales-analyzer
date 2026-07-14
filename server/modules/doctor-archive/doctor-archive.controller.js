import prisma from '../../lib/prisma.js';
import { normalizeArabic, normalizeAreaName } from '../../lib/itemResolver.js';
import {
  resolveAreaScope, getScopedSurveyDoctors, isFieldRole,
  createSurveyDoctor, updateSurveyDoctor,
} from '../../lib/surveyDoctors.js';

const normKey = s => normalizeArabic(s).toLowerCase();

// Same normalization used in visitsByArea — strips area prefixes like "حي "
const normArea = normalizeAreaName;

const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'commercial_rep']);

// Visible surveys for this user (same logic as master-survey module)
function visibleWhere(user) {
  return {
    isActive: true,
    hiddenUsers:   { none: { userId: user.id } },
    hiddenOffices: user.officeId ? { none: { officeId: user.officeId } } : undefined,
  };
}

// Get area names assigned to this user
async function getUserAreaNames(userId) {
  const rows = await prisma.userAreaAssignment.findMany({
    where: { userId },
    include: { area: { select: { name: true } } },
  });
  return rows.map(r => r.area.name.trim());
}

// ── GET /api/doctor-archive ──────────────────────────────────
// Returns archive entries for current user with survey doctor data,
// grouped by area.
// Managers can pass ?repUserId=<id> to view ALL survey doctors in the rep's
// assigned areas (with archive status overlay), like the visits analysis page.
export async function getArchive(req, res, next) {
  try {
    const requestingUser = req.user;
    const isManager = !isFieldRole(requestingUser.role);
    const repUserId = (isManager && req.query.repUserId) ? parseInt(req.query.repUserId, 10) : null;
    if (repUserId !== null && isNaN(repUserId)) return res.status(400).json({ success: false, error: 'Invalid repUserId' });

    // ── المصدر الموحّد: نفس نطاق ومجموعة "تحليل الزيارات" بالضبط ──────────────
    const scope      = await resolveAreaScope(requestingUser, { repUserId });
    const scopedDocs = await getScopedSurveyDoctors(scope);

    // طبقة الأرشيف: أعلام الزيارة/الكتابة لأعضاء النطاق (المندوب نفسه، أو كل الفريق للمدير)
    const overlayUserIds = scope.memberUserIds.length ? scope.memberUserIds : [requestingUser.id];
    const entries = scopedDocs.length ? await prisma.doctorArchiveEntry.findMany({
      where: { userId: { in: overlayUserIds }, masterSurveyDoctorId: { in: scopedDocs.map(d => d.id) } },
      select: { id: true, userId: true, masterSurveyDoctorId: true, isVisited: true, isWriting: true, visitItems: true, writingItems: true, notes: true },
    }) : [];

    // دمج الإدخالات حسب طبيب السيرفي (OR للأعلام عبر الفريق)
    const merged = new Map(); // surveyDoctorId → { entryId, ownerUserId, isVisited, isWriting, visitItems, writingItems, notes }
    for (const e of entries) {
      const cur = merged.get(e.masterSurveyDoctorId);
      if (!cur) {
        merged.set(e.masterSurveyDoctorId, {
          entryId: e.id, ownerUserId: e.userId, isVisited: e.isVisited, isWriting: e.isWriting,
          visitItems:   e.visitItems  ? JSON.parse(e.visitItems)  : [],
          writingItems: e.writingItems ? JSON.parse(e.writingItems) : [],
          notes: e.notes ?? null,
        });
      } else {
        // مَن كان صاحب أول علم صحيح (زيارة/كتابة) قبل الدمج، كي لا يُستبدل لاحقاً
        const hadFlagBefore = cur.isVisited || cur.isWriting;
        cur.isVisited = cur.isVisited || e.isVisited;
        cur.isWriting = cur.isWriting || e.isWriting;
        if (!cur.visitItems.length && e.visitItems)   cur.visitItems   = JSON.parse(e.visitItems);
        if (!cur.writingItems.length && e.writingItems) cur.writingItems = JSON.parse(e.writingItems);
        if (!cur.notes && e.notes) cur.notes = e.notes;
        // ownerUserId = صاحب البيانات الفعلية (أول من سجّل زيارة/كتابة)، كي تستهدف
        // تعديلات العرض الجماعي (بدون repUserId) إدخال المندوب الحقيقي بدل إنشاء
        // إدخال منفصل باسم المشاهد (كان يسبب عدم تأثير إلغاء التأشير في تبويب "الكل").
        if (!hadFlagBefore && (e.isVisited || e.isWriting)) cur.ownerUserId = e.userId;
        // للمندوب المفرد نفضّل entryId/ownerUserId الخاص به دائماً
        if (repUserId && e.userId === repUserId) { cur.entryId = e.id; cur.ownerUserId = e.userId; }
      }
    }

    // تجميع حسب المنطقة — كل أطباء السيرفي في النطاق (مؤرشفين أو لا)
    const areaMap = new Map();
    for (const doc of scopedDocs) {
      const areaKey = doc.areaName?.trim() || 'بدون منطقة';
      if (!areaMap.has(areaKey)) areaMap.set(areaKey, { name: areaKey, doctors: [] });
      const m = merged.get(doc.id);
      areaMap.get(areaKey).doctors.push({
        entryId:        m?.entryId ?? null,
        ownerUserId:    m?.ownerUserId ?? null,
        surveyDoctorId: doc.id,
        doctorId:       null,
        name:           doc.name,
        specialty:      doc.specialty ?? null,
        areaName:       doc.areaName ?? null,
        pharmacyName:   doc.pharmacyName ?? null,
        className:      doc.className ?? null,
        isVisited:      m?.isVisited ?? false,
        isWriting:      m?.isWriting ?? false,
        visitItems:     m?.visitItems ?? [],
        writingItems:   m?.writingItems ?? [],
        notes:          m?.notes ?? null,
      });
    }

    const areas = [...areaMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const totalVisited = [...merged.values()].filter(m => m.isVisited).length;
    const totalWriting = [...merged.values()].filter(m => m.isWriting).length;

    res.json({ success: true, areas, total: scopedDocs.length, totalVisited, totalWriting });
  } catch (e) { next(e); }
}

// ── GET /api/doctor-archive/survey-doctors ───────────────────
// Returns survey doctors NOT yet in this user's archive.
// Respects area assignment and survey visibility.
export async function getSurveyDoctors(req, res, next) {
  try {
    const userId = req.user.id;
    const { q, areaFilter } = req.query;

    // Already archived doctor ids
    const archived = await prisma.doctorArchiveEntry.findMany({
      where: { userId },
      select: { masterSurveyDoctorId: true },
    });
    const archivedIds = new Set(archived.map(e => e.masterSurveyDoctorId));

    // Visible surveys
    const surveys = await prisma.masterSurvey.findMany({
      where: visibleWhere(req.user),
      select: { id: true },
    });
    const surveyIds = surveys.map(s => s.id);
    if (surveyIds.length === 0) return res.json({ success: true, doctors: [] });

    // Area restriction for field roles
    let areaNames = null;
    if (FIELD_ROLES.has(req.user.role)) {
      const assigned = await getUserAreaNames(userId);
      if (assigned.length > 0) areaNames = new Set(assigned.map(normArea));
    }

    // Fetch all doctors from visible surveys
    const doctors = await prisma.masterSurveyDoctor.findMany({
      where: { surveyId: { in: surveyIds } },
      select: { id: true, name: true, specialty: true, areaName: true, pharmacyName: true, className: true },
      orderBy: { name: 'asc' },
    });

    let result = doctors.filter(d => !archivedIds.has(d.id));

    // Apply area restriction
    if (areaNames) {
      result = result.filter(d => !d.areaName?.trim() || areaNames.has(normArea(d.areaName)));
    }

    // Apply search filter
    if (q?.trim()) {
      const qn = normKey(q.trim());
      result = result.filter(d =>
        normKey(d.name).includes(qn) ||
        normKey(d.specialty ?? '').includes(qn) ||
        normKey(d.areaName ?? '').includes(qn) ||
        normKey(d.pharmacyName ?? '').includes(qn)
      );
    }

    // Apply area filter
    if (areaFilter && areaFilter !== 'all') {
      const af = normKey(areaFilter);
      result = result.filter(d => normKey(d.areaName ?? '') === af);
    }

    res.json({ success: true, doctors: result });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/:surveyDoctorId ─────────────────
// Add a survey doctor to the current user's archive.
// Managers can pass ?forUserId=<id> to add to a specific rep's archive.
export async function addToArchive(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }
    const surveyDoctorId   = parseInt(req.params.surveyDoctorId);
    if (isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'معرّف غير صحيح' });

    // Verify doctor exists
    const doc = await prisma.masterSurveyDoctor.findUnique({ where: { id: surveyDoctorId } });
    if (!doc) return res.status(404).json({ success: false, error: 'الطبيب غير موجود في السيرفي' });

    const entry = await prisma.doctorArchiveEntry.upsert({
      where:  { userId_masterSurveyDoctorId: { userId, masterSurveyDoctorId: surveyDoctorId } },
      create: { userId, masterSurveyDoctorId: surveyDoctorId },
      update: {}, // do nothing if already exists
    });

    res.json({ success: true, entry });
  } catch (e) { next(e); }
}

// ── PATCH /api/doctor-archive/:surveyDoctorId ────────────────
// Update isVisited, isWriting, writingItems, notes for an archive entry.
// Auto-creates the entry if it doesn't exist (upsert).
// Managers can pass ?forUserId=<id> to update a specific rep's entry.
// :surveyDoctorId can be 0 — in that case pass ?doctorId=<id> in query to
// resolve the masterSurveyDoctorId from the Doctor record.
export async function updateArchiveEntry(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }

    let surveyDoctorId = parseInt(req.params.surveyDoctorId);

    // If no surveyDoctorId (0 or NaN), try resolving via doctorId query param
    if (!surveyDoctorId && req.query.doctorId) {
      const dId = parseInt(req.query.doctorId, 10);
      if (!isNaN(dId)) {
        const doc = await prisma.doctor.findUnique({ where: { id: dId }, select: { masterSurveyDoctorId: true } });
        if (doc?.masterSurveyDoctorId) surveyDoctorId = doc.masterSurveyDoctorId;
      }
    }

    if (!surveyDoctorId || isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'هذا الطبيب غير مرتبط بسجل سيرفي، لا يمكن حفظ الزيارة' });

    const data = {};
    if (req.body.isVisited   !== undefined) data.isVisited   = Boolean(req.body.isVisited);
    if (req.body.isWriting   !== undefined) data.isWriting   = Boolean(req.body.isWriting);
    if (req.body.visitItems !== undefined) {
      const items = Array.isArray(req.body.visitItems) ? req.body.visitItems : [];
      data.visitItems = JSON.stringify(items.map(String).filter(Boolean));
    }
    if (req.body.writingItems !== undefined) {
      const items = Array.isArray(req.body.writingItems) ? req.body.writingItems : [];
      data.writingItems = JSON.stringify(items.map(String).filter(Boolean));
    }
    if (req.body.notes !== undefined) data.notes = req.body.notes || null;

    // Upsert: create entry if it doesn't exist yet, then apply data
    const updated = await prisma.doctorArchiveEntry.upsert({
      where:  { userId_masterSurveyDoctorId: { userId, masterSurveyDoctorId: surveyDoctorId } },
      create: { userId, masterSurveyDoctorId: surveyDoctorId, ...data },
      update: data,
    });

    res.json({ success: true, entry: updated });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/custom-doctor ───────────────────
// Create a brand-new doctor (not from survey) and add to archive.
export async function addCustomDoctor(req, res, next) {
  try {
    const userId = req.user.id;
    const { name, specialty, areaName, pharmacyName, className } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });

    // Find first visible survey for this user to host the doctor
    const survey = await prisma.masterSurvey.findFirst({
      where: {
        isActive: true,
        hiddenUsers:   { none: { userId } },
        ...(req.user.officeId ? { hiddenOffices: { none: { officeId: req.user.officeId } } } : {}),
      },
      orderBy: { id: 'asc' },
    });
    if (!survey) return res.status(400).json({ success: false, error: 'لا توجد قائمة سيرفي متاحة لإضافة الطبيب' });

    // Create the doctor inside the survey (عبر الخدمة الموحّدة: يسجّل الحركة للإشعارات)
    const doctor = await createSurveyDoctor(survey.id, {
      name:         name.trim(),
      specialty:    specialty?.trim()    || null,
      areaName:     areaName?.trim()     || null,
      pharmacyName: pharmacyName?.trim() || null,
      className:    className?.trim()    || null,
    }, userId);

    // Archive the new doctor for this user
    const entry = await prisma.doctorArchiveEntry.create({
      data: { userId, masterSurveyDoctorId: doctor.id },
    });

    res.json({ success: true, entry, doctor });
  } catch (e) { next(e); }
}

// ── DELETE /api/doctor-archive/:surveyDoctorId ───────────────
// Remove a doctor from the current user's archive.
// Managers can pass ?forUserId=<id> to remove from a specific rep's archive.
export async function removeFromArchive(req, res, next) {
  try {
    const isManager = !FIELD_ROLES.has(req.user.role);
    let userId = req.user.id;
    if (isManager && req.query.forUserId) {
      const fid = parseInt(req.query.forUserId, 10);
      if (!isNaN(fid)) userId = fid;
    }
    const surveyDoctorId = parseInt(req.params.surveyDoctorId);
    if (isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'معرّف غير صحيح' });

    await prisma.doctorArchiveEntry.deleteMany({
      where: { userId, masterSurveyDoctorId: surveyDoctorId },
    });

    res.json({ success: true });
  } catch (e) { next(e); }
}

// ── POST /api/doctor-archive/import-from-visits ──────────────
// Bulk-import all survey doctors visible in the rep's "تحليل الزيارات"
// into the archive. Managers can pass ?repUserId=<id> to import for a rep.
// Already-archived doctors are skipped (upsert-like, idempotent).
export async function importFromVisits(req, res, next) {
  try {
    const requestingUser = req.user;
    const isManager = !FIELD_ROLES.has(requestingUser.role);

    // Decide target user (the rep whose archive we populate)
    let targetUserId = requestingUser.id;
    if (isManager && req.body.repUserId) {
      const rid = parseInt(req.body.repUserId, 10);
      if (!isNaN(rid)) targetUserId = rid;
    }

    // Normalization — MUST match visitsByArea exactly (including prefix stripping)
    const normArea = normalizeAreaName;

    let surveyDoctorIds = [];

    // Check if targetUser is a field rep or a manager
    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true, linkedRepId: true } });
    const isTargetFieldRep = FIELD_ROLES.has(targetUser?.role ?? '');

    if (!isTargetFieldRep && !req.body.repUserId) {
      // Manager viewing their own archive: visitsByArea uses Doctor records.
      // Use Doctor.masterSurveyDoctorId to link to archive entries.
      const doctors = await prisma.doctor.findMany({
        where: { userId: targetUserId, masterSurveyDoctorId: { not: null } },
        select: { masterSurveyDoctorId: true },
      });
      surveyDoctorIds = [...new Set(doctors.map(d => d.masterSurveyDoctorId).filter(Boolean))];
    } else {
      // Field rep or manager targeting a specific rep: use MasterSurveyDoctor in their areas
      const linkedRepId = targetUser?.linkedRepId ?? null;
      const [uaRows, saRows] = await Promise.all([
        prisma.userAreaAssignment.findMany({ where: { userId: targetUserId }, select: { areaId: true } }),
        linkedRepId
          ? prisma.scientificRepArea.findMany({ where: { scientificRepId: linkedRepId }, select: { areaId: true } })
          : Promise.resolve([]),
      ]);
      const repAreaIds = [...new Set([...uaRows.map(r => r.areaId), ...saRows.map(r => r.areaId)])];

      if (repAreaIds.length > 0) {
        const areaRecords = await prisma.area.findMany({
          where: { id: { in: repAreaIds } },
          select: { name: true },
        });
        const normAreaNames = new Set(areaRecords.map(a => normArea(a.name)));

        const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
        const surveyIds = surveys.map(s => s.id);
        if (surveyIds.length > 0) {
          const allDocs = await prisma.masterSurveyDoctor.findMany({
            where: { surveyId: { in: surveyIds } },
            select: { id: true, areaName: true },
          });
          surveyDoctorIds = allDocs
            .filter(d => d.areaName?.trim() && normAreaNames.has(normArea(d.areaName)))
            .map(d => d.id);
        }
      }
    }

    if (surveyDoctorIds.length === 0) {
      return res.json({ success: true, imported: 0, alreadyExists: 0, total: 0 });
    }

    // Find already-archived ones to skip
    const existing = await prisma.doctorArchiveEntry.findMany({
      where: { userId: targetUserId, masterSurveyDoctorId: { in: surveyDoctorIds } },
      select: { masterSurveyDoctorId: true },
    });
    const existingSet = new Set(existing.map(e => e.masterSurveyDoctorId));
    const toCreate = surveyDoctorIds.filter(id => !existingSet.has(id));

    if (toCreate.length > 0) {
      await prisma.doctorArchiveEntry.createMany({
        data: toCreate.map(id => ({ userId: targetUserId, masterSurveyDoctorId: id })),
        skipDuplicates: true,
      });
    }

    res.json({
      success: true,
      imported: toCreate.length,
      alreadyExists: existingSet.size,
      total: surveyDoctorIds.length,
    });
  } catch (e) { next(e); }
}

// ── PATCH /api/doctor-archive/doctor/:surveyDoctorId ─────────
// Update profile fields (name, specialty, areaName, pharmacyName, className)
// on a MasterSurveyDoctor record. Only the doctor's owner or a manager can do this.
export async function updateDoctorProfile(req, res, next) {
  try {
    const surveyDoctorId = parseInt(req.params.surveyDoctorId, 10);
    if (isNaN(surveyDoctorId)) return res.status(400).json({ success: false, error: 'معرّف غير صحيح' });

    const { name, specialty, areaName, pharmacyName, className } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ success: false, error: 'الاسم لا يمكن أن يكون فارغاً' });

    // نجلب surveyId ثم نمرّ عبر الخدمة الموحّدة (cascade + تسجيل الحركة للإشعارات)
    const existing = await prisma.masterSurveyDoctor.findUnique({ where: { id: surveyDoctorId }, select: { surveyId: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'الطبيب غير موجود في السيرفي' });

    const fields = {};
    if (name        !== undefined) fields.name         = String(name).trim();
    if (specialty   !== undefined) fields.specialty    = specialty?.trim()    || null;
    if (areaName    !== undefined) fields.areaName     = areaName?.trim()     || null;
    if (pharmacyName!== undefined) fields.pharmacyName = pharmacyName?.trim() || null;
    if (className   !== undefined) fields.className    = className?.trim()    || null;

    const result = await updateSurveyDoctor(existing.surveyId, surveyDoctorId, fields, req.user.id);
    if (result.error) return res.status(404).json({ success: false, error: 'الطبيب غير موجود في السيرفي' });

    res.json({ success: true, doctor: result.updated });
  } catch (e) { next(e); }
}
