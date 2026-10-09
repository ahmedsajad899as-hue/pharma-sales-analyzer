// ════════════════════════════════════════════════════════════════════════════
// rep-followup.controller.js — واجهة HTTP لمتابعة المندوبين.
//
// الصلاحيات: مجموعة الأدوار هنا تطابق MANAGER_ROLES في صفحة التارگت (الواجهة)
// وتضمّ office_employee و office_hr عمداً — المجموعة المشتركة في
// middleware/authMiddleware.js تُسقطهما، وهذا بالضبط ما أفرغ صفحة التارگت
// لحساب office_hr سابقاً. والمندوب الميداني يقرأ لقطته هو وحدها عبر /me.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { getStandards, upsertStandards, listOverrides, upsertOverride, deleteOverride, FOLLOWUP_DEFAULTS } from '../../lib/followupStandards.js';
import { resolveDocOwnerUserId } from '../doctors/doctors.controller.js';
import * as svc from './rep-followup.service.js';
import { baghdadNow } from './rep-followup.service.js';

const FOLLOWUP_MANAGER_ROLES = new Set([
  'admin', 'manager', 'company_manager', 'team_leader', 'supervisor',
  'office_manager', 'product_manager', 'commercial_supervisor',
  'commercial_team_leader', 'office_employee', 'office_hr',
]);

const isManager = (role) => FOLLOWUP_MANAGER_ROLES.has(role);

function periodFromQuery(query) {
  const b = baghdadNow();
  const month = parseInt(query.month) || (b.getUTCMonth() + 1);
  const year = parseInt(query.year) || b.getUTCFullYear();
  return { month, year, periodKey: svc.periodKeyOf(year, month) };
}

function companyIdsFromQuery(query) {
  return String(query.companyIds ?? '').split(',').map(s => parseInt(s)).filter(n => Number.isFinite(n));
}

// ── GET /api/rep-followup/standards ────────────────────────────────────────
export async function getStandardsHandler(req, res, next) {
  try {
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    const [standards, overrides] = await Promise.all([
      getStandards(ownerUserId),
      listOverrides(ownerUserId),
    ]);
    // أسماء المندوبين لصفوف الاستثناء — الاستثناء مخزَّن بـ scientificRepId
    // وحده، وعرض رقم بلا اسم في شاشة إعدادات غير مفهوم.
    const repIds = overrides.map(o => o.scientificRepId);
    const reps = repIds.length
      ? await prisma.scientificRepresentative.findMany({
          where: { id: { in: repIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(reps.map(r => [r.id, r.name]));
    res.json({
      success: true,
      ownerUserId,
      canEdit: isManager(req.user.role),
      defaults: FOLLOWUP_DEFAULTS,
      standards,
      overrides: overrides.map(o => ({ ...o, repName: nameById.get(o.scientificRepId) ?? `#${o.scientificRepId}` })),
    });
  } catch (e) { next(e); }
}

// ── PUT /api/rep-followup/standards ────────────────────────────────────────
export async function putStandardsHandler(req, res, next) {
  try {
    if (!isManager(req.user.role)) return res.status(403).json({ error: 'تعديل المعايير متاح للمدراء فقط' });
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    await upsertStandards(ownerUserId, req.body ?? {});
    res.json({ success: true, standards: await getStandards(ownerUserId) });
  } catch (e) { next(e); }
}

// ── PUT /api/rep-followup/standards/override/:repId ───────────────────────
export async function putOverrideHandler(req, res, next) {
  try {
    if (!isManager(req.user.role)) return res.status(403).json({ error: 'تعديل المعايير متاح للمدراء فقط' });
    const repId = parseInt(req.params.repId);
    if (!Number.isFinite(repId)) return res.status(400).json({ error: 'معرّف المندوب غير صالح' });
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    await upsertOverride(ownerUserId, repId, req.body ?? {});
    res.json({ success: true, overrides: await listOverrides(ownerUserId) });
  } catch (e) { next(e); }
}

// ── DELETE /api/rep-followup/standards/override/:repId ────────────────────
export async function deleteOverrideHandler(req, res, next) {
  try {
    if (!isManager(req.user.role)) return res.status(403).json({ error: 'تعديل المعايير متاح للمدراء فقط' });
    const repId = parseInt(req.params.repId);
    if (!Number.isFinite(repId)) return res.status(400).json({ error: 'معرّف المندوب غير صالح' });
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    await deleteOverride(ownerUserId, repId);
    res.json({ success: true, overrides: await listOverrides(ownerUserId) });
  } catch (e) { next(e); }
}

// ── GET /api/rep-followup/scorecards ──────────────────────────────────────
/**
 * تقرأ اللقطات المحفوظة — لا تحسب شيئاً. الحساب ثقيل (getReport لكل مندوب
 * مرتين على ملفات بعشرات آلاف الصفوف)، فلو وقع على كل فتح صفحة لصار كل مدير
 * يُشعل الخادم بالتنقّل بين الشهور. الحساب يجري ليلاً أو بزرّ «احسب الآن».
 */
export async function getScorecardsHandler(req, res, next) {
  try {
    if (!isManager(req.user.role)) return res.status(403).json({ error: 'هذه الصفحة متاحة للمدراء فقط' });
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    const { month, year, periodKey } = periodFromQuery(req.query);
    const [reps, standards] = await Promise.all([
      svc.getSnapshots(ownerUserId, periodKey),
      getStandards(ownerUserId),
    ]);
    res.json({
      success: true,
      periodKey, month, year,
      standards,
      reps,
      // المصدر الوحيد لـ«متى آخر حساب» — تاريخ أقدم لقطة في الفترة.
      computedAt: reps.length ? reps.reduce((min, r) => (r.computedAt < min ? r.computedAt : min), reps[0].computedAt) : null,
      fileScope: reps[0]?.fileScope ?? null,
    });
  } catch (e) { next(e); }
}

// ── POST /api/rep-followup/recompute ──────────────────────────────────────
export async function recomputeHandler(req, res, next) {
  try {
    if (!isManager(req.user.role)) return res.status(403).json({ error: 'الحساب متاح للمدراء فقط' });
    const { month, year } = periodFromQuery(req.body ?? {});
    const result = await svc.computeScorecards(req.user, {
      month, year,
      companyIds: companyIdsFromQuery(req.body ?? {}),
      persist: true,
    });
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
}

// ── GET /api/rep-followup/me ──────────────────────────────────────────────
/**
 * لقطة المندوب نفسه. يقرأها من لقطات **مديره** لا بحساب جديد: الرقم الذي يراه
 * المندوب يجب أن يكون نفس الرقم الذي يراه مديره حرفياً، وإلا صار كل نقاش عن
 * الأداء نقاشاً عن الأرقام.
 */
export async function getMyScorecardHandler(req, res, next) {
  try {
    const ownerUserId = await resolveDocOwnerUserId(req.user.id);
    const { month, year, periodKey } = periodFromQuery(req.query);
    const [card, standards] = await Promise.all([
      svc.getSnapshotForRep(ownerUserId, req.user.id, periodKey),
      getStandards(ownerUserId),
    ]);
    res.json({ success: true, periodKey, month, year, standards, card });
  } catch (e) { next(e); }
}
