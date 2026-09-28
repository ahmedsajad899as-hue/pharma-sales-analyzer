/**
 * البلان الشهري الذكي — مستقل تماماً عن monthly-plans.controller.js الكلاسيكي
 * (لا يقرأ من MonthlyPlan/PlanEntry ولا يكتب إليها). راجع server/lib/
 * smartPlanMatching.js للمنطق الفعلي (دمج المرشّحين/التصنيف/خوارزمية النسب)،
 * وsmart-plan-name-ai.js/smart-plan-curator-ai.js لطبقتي Gemini.
 */

import fs from 'fs';
import prisma from '../../lib/prisma.js';
import { parseSmartPlanExcel } from './smart-plan-excel.js';
import {
  resolveSmartPlanOwnerUserId, ingestCandidateDrafts, ensureSurveyFallback,
  resolveSmartPlanCandidates, confirmCandidateMatch, applyOpenPharmacyLinks,
  cleanOpenPharmacyNames, computeBucketPlan, getAmbiguousCandidates,
} from '../../lib/smartPlanMatching.js';
import { aiResolveSmartPlanCandidates } from './smart-plan-name-ai.js';
import { curateBucket } from './smart-plan-curator-ai.js';

const UPLOAD_KINDS = new Set(['prescribers', 'candidates', 'survey', 'openPharmacies']);
const SOURCE_FLAG_BY_KIND = { prescribers: 'prescriberLinked', candidates: 'inCandidateList', survey: 'inSurvey' };

const DEFAULT_RATIO_CONFIG = [
  { key: 'prescriberLinked',   label: 'يكتبون الايتم',      percent: 50, sourceTag: 'prescriberLinked' },
  { key: 'openPharmacyLinked', label: 'صيدليات مفتوحة',      percent: 20, sourceTag: 'openPharmacyLinked' },
  { key: 'inSurvey',           label: 'من السيرفي',          percent: 20, sourceTag: 'inSurvey' },
  { key: 'inCandidateList',    label: 'مرشّحون',             percent: 10, sourceTag: 'inCandidateList' },
];

async function getOwnedPlan(req, idParam) {
  const id = parseInt(idParam);
  if (!Number.isInteger(id)) return null;
  return prisma.smartPlan.findFirst({
    where: { id, userId: req.user.id },
    include: { scientificRep: { select: { id: true, name: true, userId: true } } },
  });
}

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

// ── إنشاء / استعراض / تفاصيل / تعديل / حذف ───────────────────────────────────

export async function create(req, res) {
  try {
    const { scientificRepId, month, year, title, targetDoctorCount, ratioConfig } = req.body || {};
    const repId = parseInt(scientificRepId);
    if (!Number.isInteger(repId)) return fail(res, 400, 'يجب اختيار مندوب علمي');
    const rep = await prisma.scientificRepresentative.findUnique({ where: { id: repId } });
    if (!rep) return fail(res, 404, 'المندوب غير موجود');

    const m = parseInt(month), y = parseInt(year);
    if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) return fail(res, 400, 'شهر/سنة غير صالحة');

    const count = Number.isInteger(targetDoctorCount) && targetDoctorCount > 0 ? targetDoctorCount : 75;
    const plan = await prisma.smartPlan.create({
      data: {
        userId: req.user.id,
        scientificRepId: repId,
        month: m, year: y,
        title: title?.trim() || null,
        targetDoctorCount: count,
        ratioConfig: Array.isArray(ratioConfig) && ratioConfig.length ? ratioConfig : DEFAULT_RATIO_CONFIG,
      },
    });
    res.json({ success: true, plan });
  } catch (e) {
    console.error('[smart-monthly-plans] create', e);
    fail(res, 500, e.message);
  }
}

export async function list(req, res) {
  try {
    const { scientificRepId, month, year } = req.query;
    const where = { userId: req.user.id };
    if (scientificRepId) where.scientificRepId = parseInt(scientificRepId);
    if (month) where.month = parseInt(month);
    if (year) where.year = parseInt(year);
    const plans = await prisma.smartPlan.findMany({
      where, orderBy: { id: 'desc' },
      include: { scientificRep: { select: { id: true, name: true } } },
    });
    res.json({ success: true, plans });
  } catch (e) {
    console.error('[smart-monthly-plans] list', e);
    fail(res, 500, e.message);
  }
}

export async function getOne(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const [uploads, candidates] = await Promise.all([
      prisma.smartPlanUpload.findMany({ where: { smartPlanId: plan.id }, orderBy: { id: 'asc' } }),
      prisma.smartPlanCandidate.findMany({
        where: { smartPlanId: plan.id }, orderBy: { id: 'asc' },
        include: { doctor: { select: { id: true, name: true, area: { select: { name: true } } } } },
      }),
    ]);
    res.json({ success: true, plan, uploads, candidates });
  } catch (e) {
    console.error('[smart-monthly-plans] getOne', e);
    fail(res, 500, e.message);
  }
}

export async function update(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const { title, targetDoctorCount, ratioConfig } = req.body || {};
    const data = {};
    if (title !== undefined) data.title = title?.trim() || null;
    if (Number.isInteger(targetDoctorCount) && targetDoctorCount > 0) data.targetDoctorCount = targetDoctorCount;
    if (Array.isArray(ratioConfig)) data.ratioConfig = ratioConfig;
    const updated = await prisma.smartPlan.update({ where: { id: plan.id }, data });
    res.json({ success: true, plan: updated });
  } catch (e) {
    console.error('[smart-monthly-plans] update', e);
    fail(res, 500, e.message);
  }
}

export async function remove(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    await prisma.smartPlan.delete({ where: { id: plan.id } });
    res.json({ success: true });
  } catch (e) {
    console.error('[smart-monthly-plans] remove', e);
    fail(res, 500, e.message);
  }
}

// ── رفع الملفات الأربعة ───────────────────────────────────────────────────

export async function uploadFile(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    const kind = req.params.kind;
    if (!plan) { if (req.file) fs.unlink(req.file.path, () => {}); return fail(res, 404, 'البلان غير موجود'); }
    if (!UPLOAD_KINDS.has(kind)) { if (req.file) fs.unlink(req.file.path, () => {}); return fail(res, 400, 'نوع ملف غير معروف'); }
    if (!req.file) return fail(res, 400, 'لم يُرفَع أي ملف');

    let parsed;
    try {
      parsed = parseSmartPlanExcel(req.file.path, kind);
    } catch (e) {
      return fail(res, 400, e.message);
    } finally {
      fs.unlink(req.file.path, () => {});
    }

    if (kind === 'openPharmacies') {
      const cleanedNames = cleanOpenPharmacyNames(parsed.pharmacyNames);
      await prisma.smartPlanUpload.create({
        data: {
          smartPlanId: plan.id, kind, fileName: req.file.originalname,
          rowCount: parsed.rowCount, matchedCount: cleanedNames.length,
          data: { pharmacyNames: cleanedNames },
        },
      });
      const linkResult = await applyOpenPharmacyLinks(plan.id);
      return res.json({ success: true, rowCount: parsed.rowCount, pharmacyNamesCount: cleanedNames.length, ...linkResult });
    }

    const flagName = SOURCE_FLAG_BY_KIND[kind];
    const drafts = parsed.rows.map(r => ({
      rawName: r.doctorName,
      areaName: r.areaName,
      pharmacyName: r.pharmacyName,
      items: r.items,
      sourceFlags: { [flagName]: true },
    }));
    const { matched, created } = await ingestCandidateDrafts(plan.id, drafts);
    await prisma.smartPlanUpload.create({
      data: { smartPlanId: plan.id, kind, fileName: req.file.originalname, rowCount: parsed.rowCount, matchedCount: matched + created },
    });
    res.json({ success: true, rowCount: parsed.rowCount, matched, created });
  } catch (e) {
    console.error('[smart-monthly-plans] uploadFile', e);
    fail(res, 500, e.message);
  }
}

export async function clearUpload(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const kind = req.params.kind;
    await prisma.smartPlanUpload.deleteMany({ where: { smartPlanId: plan.id, kind } });
    if (kind === 'openPharmacies') await applyOpenPharmacyLinks(plan.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[smart-monthly-plans] clearUpload', e);
    fail(res, 500, e.message);
  }
}

// ── التصنيف: حتمي → Gemini → تأكيد بشري ──────────────────────────────────

export async function resolve(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    await ensureSurveyFallback(plan.id, plan.scientificRepId);
    const ownerUserId = await resolveSmartPlanOwnerUserId(plan.scientificRep, req.user.id);
    const counts = await resolveSmartPlanCandidates(plan.id, ownerUserId);
    await applyOpenPharmacyLinks(plan.id);
    await prisma.smartPlan.update({ where: { id: plan.id }, data: { status: 'resolving', lastRunAt: new Date() } });
    res.json({ success: true, ...counts });
  } catch (e) {
    console.error('[smart-monthly-plans] resolve', e);
    fail(res, 500, e.message);
  }
}

export async function getAmbiguous(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const ownerUserId = await resolveSmartPlanOwnerUserId(plan.scientificRep, req.user.id);
    const groups = await getAmbiguousCandidates(plan.id, ownerUserId);
    res.json({ success: true, groups });
  } catch (e) {
    console.error('[smart-monthly-plans] getAmbiguous', e);
    fail(res, 500, e.message);
  }
}

export async function resolveAi(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const ownerUserId = await resolveSmartPlanOwnerUserId(plan.scientificRep, req.user.id);
    const result = await aiResolveSmartPlanCandidates(plan.id, ownerUserId);
    await applyOpenPharmacyLinks(plan.id);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[smart-monthly-plans] resolveAi', e);
    fail(res, 500, e.message);
  }
}

export async function confirmMatches(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const ownerUserId = await resolveSmartPlanOwnerUserId(plan.scientificRep, req.user.id);
    const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];
    let confirmed = 0, failed = 0;
    for (const p of picks) {
      const candidateId = parseInt(p?.candidateId);
      if (!Number.isInteger(candidateId)) continue;
      const doctorId = Number.isInteger(p?.doctorId) ? p.doctorId : null;
      const result = await confirmCandidateMatch(plan.id, ownerUserId, candidateId, doctorId);
      result ? confirmed++ : failed++;
    }
    await applyOpenPharmacyLinks(plan.id);
    res.json({ success: true, confirmed, failed });
  } catch (e) {
    console.error('[smart-monthly-plans] confirmMatches', e);
    fail(res, 500, e.message);
  }
}

// ── حساب توزيع الفئات + تنسيق Gemini ─────────────────────────────────────

export async function compute(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    await applyOpenPharmacyLinks(plan.id); // دفاعياً — قد تغيّرت قائمة الصيدليات المفتوحة منذ آخر resolve

    const resolvedCandidates = await prisma.smartPlanCandidate.findMany({
      where: { smartPlanId: plan.id, doctorId: { not: null } },
    });
    const { buckets, finalByBucket, unassignable, summary } = computeBucketPlan(plan.targetDoctorCount, plan.ratioConfig, resolvedCandidates);

    // إعادة ضبط الاختيار السابق قبل تطبيق الجولة الجديدة
    await prisma.smartPlanCandidate.updateMany({
      where: { smartPlanId: plan.id },
      data: { selected: false, assignedBucketKey: null, aiScore: null, aiReason: null },
    });

    const deadline = Date.now() + 240_000;
    const finalSummary = [];
    for (const b of buckets) {
      const pool = finalByBucket.get(b.key) || [];
      const bucketSummary = summary.find(s => s.key === b.key);
      const quota = bucketSummary?.quota ?? 0;
      const picks = quota > 0 && pool.length
        ? await curateBucket(b.label, pool, quota, Math.max(5000, deadline - Date.now()))
        : [];
      const pickIds = new Set(picks.map(p => p.id));

      for (const pick of picks) {
        await prisma.smartPlanCandidate.update({
          where: { id: pick.id },
          data: { selected: true, assignedBucketKey: b.key, aiScore: pick.score, aiReason: pick.reason },
        });
      }
      const leftoverIds = pool.filter(c => !pickIds.has(c.id)).map(c => c.id);
      if (leftoverIds.length) {
        await prisma.smartPlanCandidate.updateMany({ where: { id: { in: leftoverIds } }, data: { assignedBucketKey: b.key } });
      }
      finalSummary.push({ ...bucketSummary, filledCount: picks.length });
    }

    await prisma.smartPlan.update({
      where: { id: plan.id },
      data: { status: 'ready', resultSummary: finalSummary, lastRunAt: new Date() },
    });
    res.json({ success: true, summary: finalSummary, unassignableCount: unassignable.length });
  } catch (e) {
    console.error('[smart-monthly-plans] compute', e);
    fail(res, 500, e.message);
  }
}

export async function updateCandidate(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const candidateId = parseInt(req.params.candidateId);
    const candidate = await prisma.smartPlanCandidate.findFirst({ where: { id: candidateId, smartPlanId: plan.id } });
    if (!candidate) return fail(res, 404, 'المرشّح غير موجود');

    const { selected, assignedBucketKey } = req.body || {};
    const data = {};
    if (typeof selected === 'boolean') data.selected = selected;
    if (assignedBucketKey !== undefined) data.assignedBucketKey = assignedBucketKey || null;
    const updated = await prisma.smartPlanCandidate.update({ where: { id: candidateId }, data });
    res.json({ success: true, candidate: updated });
  } catch (e) {
    console.error('[smart-monthly-plans] updateCandidate', e);
    fail(res, 500, e.message);
  }
}

export async function markExported(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const updated = await prisma.smartPlan.update({ where: { id: plan.id }, data: { status: 'exported', exportedAt: new Date() } });
    res.json({ success: true, plan: updated });
  } catch (e) {
    console.error('[smart-monthly-plans] markExported', e);
    fail(res, 500, e.message);
  }
}
