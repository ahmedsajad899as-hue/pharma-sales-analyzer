/**
 * Daily Plans Service (البلان اليومي)
 *
 * Planning + reconciliation layer on top of the existing visit records
 * (DoctorVisit / PharmacyVisit). A rep picks doctors/pharmacies to visit
 * today; achievement is computed by auto-matching plan entries against the
 * actual visits recorded the same day. Repeated-doctor detection alerts the
 * rep's managers, with thresholds configurable by the company manager.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';
import { resolveDocOwnerUserId } from '../doctors/doctors.controller.js';

// App locale is Iraq (ar-IQ, Baghdad) — UTC+3. "Today"/day-boundaries for matching
// DoctorVisit/PharmacyVisit timestamps against a plan's calendar date must use this
// fixed offset rather than UTC, otherwise visits near local midnight get attributed
// to the wrong day (and look "missing"/mismatched when the plan reconciles).
const TZ_OFFSET_MIN = 180;

// Positive feedback = "successful visit / order dropped" (writing | stocked | interested)
const POSITIVE_FEEDBACK = ['writing', 'stocked', 'interested'];

// No rep action (visit / postpone / delete) within this window after an entry is
// added → it's auto-postponed so it stops looking "still pending" indefinitely.
const AUTO_POSTPONE_MS = 24 * 60 * 60 * 1000;
const AUTO_POSTPONE_NOTE = 'لم يتم اتخاذ أي إجراء خلال 24 ساعة';

const MANAGER_ROLES = new Set([
  'admin', 'manager', 'company_manager', 'supervisor', 'product_manager',
  'office_manager', 'commercial_supervisor', 'commercial_team_leader', 'team_leader',
]);

// Roles that should receive repeat / low-achievement alerts
const ALERT_TARGET_ROLES = new Set(['company_manager', 'team_leader', 'manager', 'supervisor', 'admin']);

const DEFAULT_SETTINGS = {
  repeatWindowDays: 7,
  repeatThreshold: 3,
  alertOnRepeatAfterPositive: true,
  lowAchievementThreshold: 50,
  minNewDoctorsPerDay: 0,
};

// ─── Helpers ─────────────────────────────────────────────────

// Baghdad-local "today" string, independent of the server OS timezone.
const todayStr = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

// Baghdad-local calendar-day string for a real timestamp (e.g. visitDate) —
// avoids misattributing visits made just after local midnight to the previous day.
const localDateStr = (date) => new Date(date.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

const normalizeName = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ').trim();

/** Local-day (Baghdad UTC+3) boundaries for a "YYYY-MM-DD" string, expressed in UTC instants. */
function dayRange(dateStr) {
  const gte = new Date(`${dateStr}T00:00:00.000Z`);
  gte.setUTCMinutes(gte.getUTCMinutes() - TZ_OFFSET_MIN);
  const lt = new Date(gte);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte, lt };
}

/** Build an OR clause matching a rep's visits (field rep via scientificRepId, manager-tracked via userId). */
function repVisitOr(ctx) {
  const or = [{ userId: ctx.repUserId }];
  if (ctx.scientificRepId) or.push({ scientificRepId: ctx.scientificRepId });
  return or;
}

/** Is `repUserId` a (direct or 2-level indirect) subordinate of `managerId`? */
async function isSubordinate(managerId, repUserId, role) {
  if (role === 'admin') return true;
  const direct = await prisma.userManagerAssignment.findFirst({ where: { managerId, userId: repUserId } });
  if (direct) return true;
  const mids = (await prisma.userManagerAssignment.findMany({ where: { managerId }, select: { userId: true } }))
    .map((m) => m.userId);
  if (mids.length) {
    const indirect = await prisma.userManagerAssignment.findFirst({
      where: { managerId: { in: mids }, userId: repUserId },
    });
    if (indirect) return true;
  }
  return false;
}

/**
 * Resolve the target rep for a request: self, or a subordinate when a manager
 * passes repUserId. Returns rep identity used everywhere downstream.
 */
export async function resolveRepContext(req) {
  const actorUserId = req.user.id;
  const actorRole = req.user.role;
  const raw = req.query.repUserId ?? req.body?.repUserId ?? null;
  const reqRepUserId = raw != null && raw !== '' ? parseInt(raw) : null;

  let repUserId = actorUserId;
  let isManagerView = false;
  if (reqRepUserId && reqRepUserId !== actorUserId) {
    if (!MANAGER_ROLES.has(actorRole)) throw new AppError('غير مصرح', 403);
    const ok = await isSubordinate(actorUserId, reqRepUserId, actorRole);
    if (!ok) throw new AppError('هذا المندوب ليس ضمن فريقك', 403);
    repUserId = reqRepUserId;
    isManagerView = true;
  }

  const userRow = await prisma.user.findUnique({ where: { id: repUserId }, select: { linkedRepId: true } });
  let scientificRepId = userRow?.linkedRepId ?? null;
  if (!scientificRepId) {
    const sr = await prisma.scientificRepresentative.findFirst({ where: { userId: repUserId }, select: { id: true } });
    scientificRepId = sr?.id ?? null;
  }
  return { actorUserId, actorRole, repUserId, scientificRepId, isManagerView };
}

/** Resolve the DailyPlanSettings that apply to a rep (walk up the manager chain), else defaults. */
export async function resolveSettings(repUserId) {
  const direct = await prisma.userManagerAssignment.findMany({ where: { userId: repUserId }, select: { managerId: true } });
  let ancestorIds = direct.map((d) => d.managerId);
  if (ancestorIds.length) {
    const up = await prisma.userManagerAssignment.findMany({
      where: { userId: { in: ancestorIds } }, select: { managerId: true },
    });
    ancestorIds = [...new Set([...ancestorIds, ...up.map((u) => u.managerId)])];
  }
  if (!ancestorIds.length) return { ...DEFAULT_SETTINGS };

  const rows = await prisma.dailyPlanSettings.findMany({
    where: { userId: { in: ancestorIds } },
    include: { user: { select: { role: true } } },
  });
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  // Prefer a company_manager's settings, else the first available.
  const preferred = rows.find((r) => r.user?.role === 'company_manager') ?? rows[0];
  return {
    repeatWindowDays: preferred.repeatWindowDays,
    repeatThreshold: preferred.repeatThreshold,
    alertOnRepeatAfterPositive: preferred.alertOnRepeatAfterPositive,
    lowAchievementThreshold: preferred.lowAchievementThreshold,
    minNewDoctorsPerDay: preferred.minNewDoctorsPerDay,
  };
}

/** Resolve the managers (in alert roles) who should be notified about a rep. */
async function getAlertManagers(repUserId) {
  const direct = await prisma.userManagerAssignment.findMany({ where: { userId: repUserId }, select: { managerId: true } });
  let ids = direct.map((d) => d.managerId);
  if (ids.length) {
    const up = await prisma.userManagerAssignment.findMany({ where: { userId: { in: ids } }, select: { managerId: true } });
    ids = [...new Set([...ids, ...up.map((u) => u.managerId)])];
  }
  if (!ids.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, role: true },
  });
  return users.filter((u) => ALERT_TARGET_ROLES.has(u.role)).map((u) => u.id);
}

/** Create a notification once per dedup key (prevents same-day spam). */
async function notifyOnce({ managerIds, fromUserId, type, title, body, dpKey, data }) {
  if (!managerIds.length) return;
  const payload = JSON.stringify({ ...(data || {}), dpKey });
  for (const managerId of managerIds) {
    const exists = await prisma.appNotification.findFirst({
      where: { userId: managerId, type, data: { contains: dpKey } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.appNotification.create({
      data: { userId: managerId, fromUserId, type, title, body, data: payload },
    });
  }
}

// ─── Plan lifecycle ──────────────────────────────────────────

async function getOrCreatePlan(ctx, planDate) {
  let plan = await prisma.dailyPlan.findFirst({ where: { userId: ctx.repUserId, planDate } });
  if (!plan) {
    plan = await prisma.dailyPlan.create({
      data: { userId: ctx.repUserId, repUserId: ctx.repUserId, scientificRepId: ctx.scientificRepId, planDate },
    });
  } else if (plan.scientificRepId == null && ctx.scientificRepId != null) {
    plan = await prisma.dailyPlan.update({ where: { id: plan.id }, data: { scientificRepId: ctx.scientificRepId } });
  }
  return plan;
}

export async function createPlan(ctx, planDate) {
  return getOrCreatePlan(ctx, planDate || todayStr());
}

/**
 * Reconcile a plan's entries with the day's actual visits, then return the
 * full plan view (entries + achievement + new-doctor quota + comments).
 */
export async function getPlanView(ctx, planDate) {
  const date = planDate || todayStr();
  const plan = await getOrCreatePlan(ctx, date);

  const entries = await prisma.dailyPlanEntry.findMany({
    where: { planId: plan.id },
    include: {
      doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true } },
      area: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // ── Auto-match against the day's real visits ──
  const range = dayRange(date);
  const [docVisits, pharmVisits] = await Promise.all([
    prisma.doctorVisit.findMany({
      where: { OR: repVisitOr(ctx), visitDate: range },
      select: { id: true, doctorId: true, feedback: true, visitDate: true },
      orderBy: { visitDate: 'desc' },
    }),
    prisma.pharmacyVisit.findMany({
      where: { OR: repVisitOr(ctx), visitDate: range },
      select: { id: true, pharmacyName: true, visitDate: true },
      orderBy: { visitDate: 'desc' },
    }),
  ]);
  const docVisitByDoctor = new Map();
  for (const v of docVisits) if (!docVisitByDoctor.has(v.doctorId)) docVisitByDoctor.set(v.doctorId, v);
  const pharmVisitByName = new Map();
  for (const v of pharmVisits) { const k = normalizeName(v.pharmacyName); if (!pharmVisitByName.has(k)) pharmVisitByName.set(k, v); }

  const updates = [];
  const enriched = entries.map((e) => {
    let feedback = null;
    if (e.status !== 'postponed') {
      if (e.entryType === 'doctor' && e.doctorId != null) {
        const v = docVisitByDoctor.get(e.doctorId);
        if (v) {
          feedback = v.feedback;
          if (e.status !== 'visited' || e.linkedVisitId !== v.id) {
            updates.push(prisma.dailyPlanEntry.update({ where: { id: e.id }, data: { status: 'visited', linkedVisitId: v.id } }));
          }
          e.status = 'visited'; e.linkedVisitId = v.id;
        }
      } else if (e.entryType === 'pharmacy' && e.pharmacyName) {
        const v = pharmVisitByName.get(normalizeName(e.pharmacyName));
        if (v) {
          if (e.status !== 'visited' || e.linkedPharmacyVisitId !== v.id) {
            updates.push(prisma.dailyPlanEntry.update({ where: { id: e.id }, data: { status: 'visited', linkedPharmacyVisitId: v.id } }));
          }
          e.status = 'visited'; e.linkedPharmacyVisitId = v.id;
        }
      }
      // Still no action (not visited) 24h after being added → auto-postpone.
      if (e.status === 'planned' && Date.now() - e.createdAt.getTime() > AUTO_POSTPONE_MS) {
        updates.push(prisma.dailyPlanEntry.update({
          where: { id: e.id },
          data: { status: 'postponed', postponeReason: 'other', postponeNote: AUTO_POSTPONE_NOTE, autoPostponed: true },
        }));
        e.status = 'postponed'; e.postponeReason = 'other'; e.postponeNote = AUTO_POSTPONE_NOTE; e.autoPostponed = true;
      }
    }
    return { ...e, currentFeedback: feedback };
  });
  if (updates.length) await prisma.$transaction(updates);

  const total = enriched.length;
  const visited = enriched.filter((e) => e.status === 'visited').length;
  const postponed = enriched.filter((e) => e.status === 'postponed').length;
  const achievement = total > 0 ? Math.round((visited / total) * 100) : 0;

  const settings = await resolveSettings(ctx.repUserId);
  const newDoctorEntries = enriched.filter((e) => e.entryType === 'doctor' && e.isNewDoctor);
  const newDoctorsPlanned = newDoctorEntries.length;
  const newDoctorsVisited = newDoctorEntries.filter((e) => e.status === 'visited').length;

  // Low-achievement alert for a finished past day
  if (ctx.repUserId && date < todayStr() && total > 0 && achievement < settings.lowAchievementThreshold) {
    const managers = await getAlertManagers(ctx.repUserId);
    await notifyOnce({
      managerIds: managers, fromUserId: ctx.repUserId,
      type: 'daily_plan_low_achievement',
      title: 'إنجاز يومي منخفض',
      body: `نسبة تحقيق البلان اليومي ${achievement}% (${visited}/${total}) بتاريخ ${date} — أقل من الحد ${settings.lowAchievementThreshold}%.`,
      dpKey: `low:${ctx.repUserId}:${date}`,
      data: { repUserId: ctx.repUserId, date, achievement },
    });
  }

  const comments = await prisma.dailyPlanComment.findMany({
    where: { planId: plan.id },
    include: { user: { select: { id: true, displayName: true, username: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return {
    plan: { id: plan.id, planDate: plan.planDate, status: plan.status, notes: plan.notes, repUserId: ctx.repUserId, isManagerView: ctx.isManagerView },
    entries: enriched,
    achievement: {
      total, visited, postponed, planned: total - visited - postponed, percent: achievement,
      visitedNames: enriched.filter((e) => e.status === 'visited').map(entryLabel),
      pendingNames: enriched.filter((e) => e.status !== 'visited').map(entryLabel),
    },
    newDoctorQuota: { required: settings.minNewDoctorsPerDay, planned: newDoctorsPlanned, visited: newDoctorsVisited },
    settings,
    comments: comments.map((c) => ({ id: c.id, content: c.content, createdAt: c.createdAt, by: c.user.displayName || c.user.username, userId: c.userId })),
  };
}

const entryLabel = (e) => e.entryType === 'doctor' ? (e.doctor?.name ?? `#${e.doctorId}`) : (e.pharmacyName ?? '—');

// ─── Repeat detection ────────────────────────────────────────

/** Repeat info for a doctor within a rep's recent daily plans. */
export async function getDoctorRepeatInfo(ctx, doctorId, settings, asOfDate) {
  const date = asOfDate || todayStr();
  const start = new Date(`${date}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - settings.repeatWindowDays);
  const startStr = start.toISOString().slice(0, 10);

  const entries = await prisma.dailyPlanEntry.findMany({
    where: { doctorId, plan: { userId: ctx.repUserId, planDate: { gte: startStr, lte: date } } },
    include: { plan: { select: { planDate: true } } },
  });
  const plannedDays = [...new Set(entries.map((e) => e.plan.planDate))].sort();

  const visits = await prisma.doctorVisit.findMany({
    where: { OR: repVisitOr(ctx), doctorId },
    select: { feedback: true, visitDate: true },
    orderBy: { visitDate: 'desc' },
  });
  const visitedDays = [...new Set(visits.map((v) => localDateStr(v.visitDate)))];
  const lastFeedback = visits[0]?.feedback ?? null;
  const hadPositive = visits.some((v) => POSITIVE_FEEDBACK.includes(v.feedback));

  const repeated = plannedDays.length >= settings.repeatThreshold;
  const repeatedAfterPositive = settings.alertOnRepeatAfterPositive && hadPositive && plannedDays.length >= 2;
  return {
    count: plannedDays.length, plannedDays, visitedDays, lastFeedback,
    hadPositive, repeated, repeatedAfterPositive,
    flagged: repeated || repeatedAfterPositive,
  };
}

// ─── Entries ─────────────────────────────────────────────────

export async function addEntry(ctx, planId, dto) {
  const plan = await prisma.dailyPlan.findFirst({ where: { id: planId, userId: ctx.repUserId } });
  if (!plan) throw new AppError('البلان غير موجود', 404);

  // When a manager adds to a rep's plan, snapshot who added it so the rep can see it.
  let addedByManager = false, addedByName = null;
  if (ctx.isManagerView && ctx.actorUserId !== ctx.repUserId) {
    const actor = await prisma.user.findUnique({ where: { id: ctx.actorUserId }, select: { displayName: true, username: true } });
    addedByManager = true;
    addedByName = actor?.displayName || actor?.username || null;
  }

  if (dto.entryType === 'pharmacy') {
    if (!dto.pharmacyName?.trim()) throw new AppError('اسم الصيدلية مطلوب', 400);
    const entry = await prisma.dailyPlanEntry.create({
      data: { planId, entryType: 'pharmacy', pharmacyName: dto.pharmacyName.trim(), areaId: dto.areaId ? parseInt(dto.areaId) : null, itemId: dto.itemId ? parseInt(dto.itemId) : null, addedByManager, addedByName },
    });
    return { entry, repeat: null };
  }

  // doctor entry
  const doctorId = parseInt(dto.doctorId);
  if (!doctorId) throw new AppError('doctorId مطلوب', 400);
  const dup = await prisma.dailyPlanEntry.findFirst({ where: { planId, doctorId } });
  if (dup) throw new AppError('الطبيب موجود في بلان اليوم', 409);

  // isNewDoctor = no prior visit by this rep
  const priorVisit = await prisma.doctorVisit.findFirst({ where: { OR: repVisitOr(ctx), doctorId }, select: { id: true } });
  const settings = await resolveSettings(ctx.repUserId);
  const repeat = await getDoctorRepeatInfo(ctx, doctorId, settings, plan.planDate);

  const entry = await prisma.dailyPlanEntry.create({
    data: { planId, entryType: 'doctor', doctorId, areaId: dto.areaId ? parseInt(dto.areaId) : null, itemId: dto.itemId ? parseInt(dto.itemId) : null, isNewDoctor: !priorVisit, addedByManager, addedByName },
  });

  // Notify managers when this addition crosses a configured threshold
  if (repeat.flagged) {
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { name: true } });
    const managers = await getAlertManagers(ctx.repUserId);
    const reason = repeat.repeated
      ? `تكرّر وضعه في ${repeat.count} أيام خلال آخر ${settings.repeatWindowDays} يوم`
      : `أُعيد التخطيط لزيارته رغم نتيجة سابقة ناجحة (${repeat.lastFeedback})`;
    await notifyOnce({
      managerIds: managers, fromUserId: ctx.repUserId,
      type: 'daily_plan_repeat',
      title: 'تكرار طبيب في البلان اليومي',
      body: `الدكتور ${doctor?.name ?? '#' + doctorId}: ${reason}. أيام التخطيط: ${repeat.plannedDays.join('، ')}.`,
      dpKey: `repeat:${ctx.repUserId}:${doctorId}:${plan.planDate}`,
      data: { repUserId: ctx.repUserId, doctorId, plannedDays: repeat.plannedDays, visitedDays: repeat.visitedDays },
    });
  }

  return { entry: { ...entry, isNewDoctor: !priorVisit }, repeat };
}

/** Ensure the source entry's doctor/pharmacy also appears on the chosen plan date (idempotent). */
async function carryOverToDate(ctx, sourceEntry, targetDateStr) {
  const plan = await getOrCreatePlan(ctx, targetDateStr);
  const dupWhere = sourceEntry.entryType === 'doctor'
    ? { planId: plan.id, doctorId: sourceEntry.doctorId }
    : { planId: plan.id, entryType: 'pharmacy', pharmacyName: sourceEntry.pharmacyName };
  const dup = await prisma.dailyPlanEntry.findFirst({ where: dupWhere });
  if (dup) return dup;
  return prisma.dailyPlanEntry.create({
    data: {
      planId: plan.id,
      entryType: sourceEntry.entryType,
      doctorId: sourceEntry.doctorId,
      pharmacyName: sourceEntry.pharmacyName,
      areaId: sourceEntry.areaId,
      itemId: sourceEntry.itemId,
      isNewDoctor: sourceEntry.isNewDoctor,
    },
  });
}

export async function updateEntry(ctx, entryId, dto) {
  const entry = await prisma.dailyPlanEntry.findFirst({
    where: { id: entryId, plan: { userId: ctx.repUserId } },
  });
  if (!entry) throw new AppError('المدخل غير موجود', 404);

  const data = {};
  if (dto.status) data.status = dto.status;            // planned | visited | postponed
  if (dto.status === 'postponed') {
    data.postponeReason = dto.postponeReason ?? 'other'; // absent | traveling | declined | other
    data.postponeNote = dto.postponeNote ?? null;
    data.postponeToDate = dto.postponeToDate?.trim() || null;
    data.autoPostponed = false; // manual postpone overrides the 24h-auto flag
  }
  if (dto.status && dto.status !== 'postponed') {
    data.postponeReason = null; data.postponeNote = null; data.postponeToDate = null; data.autoPostponed = false;
  }
  if (dto.itemId !== undefined) data.itemId = dto.itemId ? parseInt(dto.itemId) : null;

  const updated = await prisma.dailyPlanEntry.update({ where: { id: entryId }, data });
  if (data.postponeToDate) await carryOverToDate(ctx, entry, data.postponeToDate);
  return updated;
}

export async function removeEntry(ctx, entryId) {
  const entry = await prisma.dailyPlanEntry.findFirst({ where: { id: entryId, plan: { userId: ctx.repUserId } } });
  if (!entry) throw new AppError('المدخل غير موجود', 404);
  await prisma.dailyPlanEntry.delete({ where: { id: entryId } });
  return { ok: true };
}

/** Quick-record: create the real visit (doctor/pharmacy) and link the entry. */
export async function recordVisit(ctx, entryId, dto) {
  const entry = await prisma.dailyPlanEntry.findFirst({
    where: { id: entryId, plan: { userId: ctx.repUserId } },
    include: { plan: { select: { planDate: true } } },
  });
  if (!entry) throw new AppError('المدخل غير موجود', 404);

  const visitDate = dto.visitDate ? new Date(dto.visitDate) : new Date();
  if (entry.entryType === 'doctor') {
    const visit = await prisma.doctorVisit.create({
      data: {
        doctorId: entry.doctorId,
        scientificRepId: ctx.scientificRepId,
        visitDate,
        itemId: dto.itemId ? parseInt(dto.itemId) : (entry.itemId ?? null),
        feedback: dto.feedback ?? 'pending',
        notes: dto.notes ?? '',
        latitude: dto.latitude != null ? parseFloat(dto.latitude) : null,
        longitude: dto.longitude != null ? parseFloat(dto.longitude) : null,
        userId: ctx.repUserId,
      },
    });
    await prisma.dailyPlanEntry.update({ where: { id: entryId }, data: { status: 'visited', linkedVisitId: visit.id } });
    return visit;
  }
  // pharmacy
  const visit = await prisma.pharmacyVisit.create({
    data: {
      pharmacyName: entry.pharmacyName,
      areaId: entry.areaId,
      scientificRepId: ctx.scientificRepId,
      visitDate,
      notes: dto.notes ?? null,
      latitude: dto.latitude != null ? parseFloat(dto.latitude) : null,
      longitude: dto.longitude != null ? parseFloat(dto.longitude) : null,
      userId: ctx.repUserId,
    },
  });
  await prisma.dailyPlanEntry.update({ where: { id: entryId }, data: { status: 'visited', linkedPharmacyVisitId: visit.id } });
  return visit;
}

// ─── Suggestions (new doctors / carry-over) ──────────────────

export async function suggest(ctx, { mode = 'new', areaId, date }) {
  const planDate = date || todayStr();

  if (mode === 'carryover') {
    // Postponed doctor entries from the previous calendar day
    const prev = new Date(`${planDate}T00:00:00.000Z`); prev.setUTCDate(prev.getUTCDate() - 1);
    const prevStr = prev.toISOString().slice(0, 10);
    const rows = await prisma.dailyPlanEntry.findMany({
      where: { entryType: 'doctor', status: 'postponed', plan: { userId: ctx.repUserId, planDate: prevStr } },
      include: { doctor: { select: { id: true, name: true, specialty: true, pharmacyName: true } } },
    });
    return rows.map((r) => ({
      doctorId: r.doctorId, name: r.doctor?.name, specialty: r.doctor?.specialty,
      pharmacyName: r.doctor?.pharmacyName, postponeReason: r.postponeReason, postponeNote: r.postponeNote,
    }));
  }

  // mode = 'new' → doctors in the rep's areas that were never visited by this rep
  // Doctor rows are never owned by the field rep's own userId — they belong to the
  // rep's manager account (resolveDocOwnerUserId mirrors GET /api/doctors' resolution).
  const docOwnerUserId = await resolveDocOwnerUserId(ctx.repUserId);
  const repAreaIds = await getRepAreaIds(ctx);
  const where = { userId: docOwnerUserId, isActive: true };
  const areaFilter = areaId ? [parseInt(areaId)] : repAreaIds;
  if (areaFilter.length) where.areaId = { in: areaFilter };

  const doctors = await prisma.doctor.findMany({
    where, select: { id: true, name: true, specialty: true, pharmacyName: true, areaId: true, area: { select: { name: true } } },
    take: 300,
  });
  if (!doctors.length) return [];

  const visited = await prisma.doctorVisit.findMany({
    where: { OR: repVisitOr(ctx), doctorId: { in: doctors.map((d) => d.id) } },
    select: { doctorId: true }, distinct: ['doctorId'],
  });
  const visitedSet = new Set(visited.map((v) => v.doctorId));

  // exclude doctors already in today's plan
  const plan = await prisma.dailyPlan.findFirst({ where: { userId: ctx.repUserId, planDate }, select: { id: true } });
  const inPlan = plan
    ? new Set((await prisma.dailyPlanEntry.findMany({ where: { planId: plan.id, entryType: 'doctor' }, select: { doctorId: true } })).map((e) => e.doctorId))
    : new Set();

  return doctors
    .filter((d) => !visitedSet.has(d.id) && !inPlan.has(d.id))
    .map((d) => ({ doctorId: d.id, name: d.name, specialty: d.specialty, pharmacyName: d.pharmacyName, areaId: d.areaId, areaName: d.area?.name }))
    .slice(0, 50);
}

async function getRepAreaIds(ctx) {
  const [ua, sa] = await Promise.all([
    prisma.userAreaAssignment.findMany({ where: { userId: ctx.repUserId }, select: { areaId: true } }),
    ctx.scientificRepId
      ? prisma.scientificRepArea.findMany({ where: { scientificRepId: ctx.scientificRepId }, select: { areaId: true } })
      : Promise.resolve([]),
  ]);
  return [...new Set([...ua.map((r) => r.areaId), ...sa.map((r) => r.areaId)])];
}

// ─── Reports ─────────────────────────────────────────────────

/** Repeated-doctor report for a rep across a date range. */
export async function repeatsReport(ctx, { from, to }) {
  const toStr = to || todayStr();
  const fromStr = from || (() => { const d = new Date(`${toStr}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10); })();

  const entries = await prisma.dailyPlanEntry.findMany({
    where: { entryType: 'doctor', plan: { userId: ctx.repUserId, planDate: { gte: fromStr, lte: toStr } } },
    include: { doctor: { select: { id: true, name: true, specialty: true } }, plan: { select: { planDate: true } } },
  });

  const byDoctor = new Map();
  for (const e of entries) {
    if (e.doctorId == null) continue;
    if (!byDoctor.has(e.doctorId)) byDoctor.set(e.doctorId, { doctorId: e.doctorId, name: e.doctor?.name, specialty: e.doctor?.specialty, days: new Set() });
    byDoctor.get(e.doctorId).days.add(e.plan.planDate);
  }

  const settings = await resolveSettings(ctx.repUserId);
  const docIds = [...byDoctor.keys()];
  const visits = docIds.length
    ? await prisma.doctorVisit.findMany({
        where: { OR: repVisitOr(ctx), doctorId: { in: docIds } },
        select: { doctorId: true, feedback: true, visitDate: true }, orderBy: { visitDate: 'desc' },
      })
    : [];
  const visitsByDoctor = new Map();
  for (const v of visits) {
    if (!visitsByDoctor.has(v.doctorId)) visitsByDoctor.set(v.doctorId, []);
    visitsByDoctor.get(v.doctorId).push(v);
  }

  return [...byDoctor.values()]
    .map((d) => {
      const vs = visitsByDoctor.get(d.doctorId) || [];
      const plannedDays = [...d.days].sort();
      const visitedDays = [...new Set(vs.map((v) => localDateStr(v.visitDate)))].sort();
      const hadPositive = vs.some((v) => POSITIVE_FEEDBACK.includes(v.feedback));
      return {
        doctorId: d.doctorId, name: d.name, specialty: d.specialty,
        plannedCount: plannedDays.length, plannedDays, visitedDays,
        lastFeedback: vs[0]?.feedback ?? null, hadPositive,
        flagged: plannedDays.length >= settings.repeatThreshold || (settings.alertOnRepeatAfterPositive && hadPositive && plannedDays.length >= 2),
      };
    })
    .filter((d) => d.plannedCount >= 2)
    .sort((a, b) => b.plannedCount - a.plannedCount);
}

/** Aggregate postpone reasons for a rep across a date range. */
export async function postponeStats(ctx, { from, to }) {
  const toStr = to || todayStr();
  const fromStr = from || (() => { const d = new Date(`${toStr}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10); })();

  const rows = await prisma.dailyPlanEntry.findMany({
    where: { status: 'postponed', plan: { userId: ctx.repUserId, planDate: { gte: fromStr, lte: toStr } } },
    select: { postponeReason: true },
  });
  const counts = { absent: 0, traveling: 0, declined: 0, other: 0 };
  for (const r of rows) counts[r.postponeReason && counts[r.postponeReason] !== undefined ? r.postponeReason : 'other']++;
  return { from: fromStr, to: toStr, total: rows.length, counts };
}

// ─── Comments ────────────────────────────────────────────────

export async function addComment(ctx, planId, content) {
  if (!content?.trim()) throw new AppError('التعليق فارغ', 400);
  const plan = await prisma.dailyPlan.findFirst({ where: { id: planId, userId: ctx.repUserId } });
  if (!plan) throw new AppError('البلان غير موجود', 404);
  const c = await prisma.dailyPlanComment.create({
    data: { planId, userId: ctx.actorUserId, content: content.trim() },
    include: { user: { select: { displayName: true, username: true } } },
  });
  // Notify the rep when a manager comments
  if (ctx.isManagerView && ctx.repUserId !== ctx.actorUserId) {
    await prisma.appNotification.create({
      data: {
        userId: ctx.repUserId, fromUserId: ctx.actorUserId, type: 'daily_plan_comment',
        title: 'تعليق على بلانك اليومي', body: content.trim().slice(0, 200),
        data: JSON.stringify({ planId, planDate: plan.planDate }),
      },
    });
  }
  return { id: c.id, content: c.content, createdAt: c.createdAt, by: c.user.displayName || c.user.username, userId: c.userId };
}

// ─── Settings (company manager) ──────────────────────────────

export async function getSettings(userId) {
  const row = await prisma.dailyPlanSettings.findUnique({ where: { userId } });
  return row ?? { userId, ...DEFAULT_SETTINGS };
}

export async function putSettings(userId, dto) {
  const data = {
    repeatWindowDays: clampInt(dto.repeatWindowDays, 1, 60, DEFAULT_SETTINGS.repeatWindowDays),
    repeatThreshold: clampInt(dto.repeatThreshold, 2, 30, DEFAULT_SETTINGS.repeatThreshold),
    alertOnRepeatAfterPositive: dto.alertOnRepeatAfterPositive !== false,
    lowAchievementThreshold: clampInt(dto.lowAchievementThreshold, 0, 100, DEFAULT_SETTINGS.lowAchievementThreshold),
    minNewDoctorsPerDay: clampInt(dto.minNewDoctorsPerDay, 0, 50, DEFAULT_SETTINGS.minNewDoctorsPerDay),
  };
  return prisma.dailyPlanSettings.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
