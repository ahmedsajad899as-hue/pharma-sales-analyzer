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
  cleanOpenPharmacyEntries, computeBucketPlan, getAmbiguousCandidates,
  getAreaDoctorsOverview, selectedKeySet, getScopedDoctorKeySet, loadKnownAreaNameChecker,
  saveOpenPharmacyLink, deleteOpenPharmacyLink, lookupPharmacyEverywhere,
} from '../../lib/smartPlanMatching.js';
import { doctorLinkKey } from '../../lib/surveyDoctors.js';
import { renameOrMergePharmacies } from '../../lib/smartPlanPharmacyEdit.js';
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

// ── مناطق المندوب + أطباؤها + اختيار الأطباء المسموحين ──────────────────────

export async function getAreaDoctors(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const overview = await getAreaDoctorsOverview(plan);
    res.json({ success: true, ...overview });
  } catch (e) {
    console.error('[smart-monthly-plans] getAreaDoctors', e);
    fail(res, 500, e.message);
  }
}

export async function saveDoctorSelection(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const keys = req.body?.selectedKeys;
    if (!Array.isArray(keys)) return fail(res, 400, 'selectedKeys يجب أن تكون مصفوفة');
    const cleaned = Array.from(new Set(keys.filter(k => typeof k === 'string' && k)));
    await prisma.smartPlan.update({ where: { id: plan.id }, data: { selectedDoctorKeys: cleaned } });
    res.json({ success: true, selectedCount: cleaned.length });
  } catch (e) {
    console.error('[smart-monthly-plans] saveDoctorSelection', e);
    fail(res, 500, e.message);
  }
}

// ── تعريف/دمج/تعديل أسماء الصيدليات ────────────────────────────────────────

/** تعريف عالمي: صيدلية من ملف المفتوحة = صيدلية سيرفي X (أو toName=null: صيدلية مستقلة). */
export async function savePharmacyLink(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const { fromName, areaName, toName } = req.body || {};
    if (!String(fromName ?? '').trim()) return fail(res, 400, 'اسم الصيدلية مطلوب');
    await saveOpenPharmacyLink({ fromName, areaName, toName }, req.user.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[smart-monthly-plans] savePharmacyLink', e);
    fail(res, 500, e.message);
  }
}

/**
 * تشخيص «ليش تظهر غير موجودة في السيرفي؟» — يبحث عن الاسم بلا قيد منطقة في
 * صيدليات السيرفي وأسماء صيدليات الأطباء وزيارات الصيدليات، ليتبيّن إن كانت في
 * منطقة خارج نطاق المندوب أو معروفة من الزيارات فقط أو غير موجودة إطلاقاً.
 */
export async function lookupPharmacy(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const out = await lookupPharmacyEverywhere(plan, req.query.name);
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('[smart-monthly-plans] lookupPharmacy', e);
    fail(res, 500, e.message);
  }
}

export async function removePharmacyLink(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const { fromName, areaName } = req.body || {};
    await deleteOpenPharmacyLink({ fromName, areaName });
    res.json({ success: true });
  } catch (e) {
    console.error('[smart-monthly-plans] removePharmacyLink', e);
    fail(res, 500, e.message);
  }
}

async function afterPharmacyEdit(plan, oldNames, newName) {
  // مرشّحو هذا البلان يتبعون الاسم الجديد كي لا ينفصل تأشير "مفتوحة" عنهم
  const olds = oldNames.map(n => String(n).trim()).filter(Boolean);
  if (olds.length) {
    await prisma.smartPlanCandidate.updateMany({
      where: { smartPlanId: plan.id, OR: olds.map(n => ({ pharmacyName: { equals: n, mode: 'insensitive' } })) },
      data: { pharmacyName: newName },
    });
  }
  await applyOpenPharmacyLinks(plan.id);
}

/** تعديل اسم صيدلية في السيرفي الأصلي (يُطبَّق على أطبائها وزياراتها داخل المنطقة). */
export async function renamePharmacy(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const { areaId, oldName, newName } = req.body || {};
    if (!Number.isInteger(areaId) || !String(oldName ?? '').trim() || !String(newName ?? '').trim()) return fail(res, 400, 'بيانات غير مكتملة');
    const result = await renameOrMergePharmacies(plan.scientificRepId, areaId, [oldName], newName, req.user.id);
    if (result.error) return fail(res, 400, result.error === 'area_not_in_scope' ? 'المنطقة ليست من مناطق هذا المندوب' : 'لا تغيير');
    await afterPharmacyEdit(plan, [oldName], String(newName).trim());
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[smart-monthly-plans] renamePharmacy', e);
    fail(res, 500, e.message);
  }
}

/** دمج صيدليات سيرفي في واحدة (keepName تبقى، mergeNames تُدمَج فيها). */
export async function mergePharmacies(req, res) {
  try {
    const plan = await getOwnedPlan(req, req.params.id);
    if (!plan) return fail(res, 404, 'البلان غير موجود');
    const { areaId, keepName, mergeNames } = req.body || {};
    if (!Number.isInteger(areaId) || !String(keepName ?? '').trim() || !Array.isArray(mergeNames) || !mergeNames.length) return fail(res, 400, 'بيانات غير مكتملة');
    const result = await renameOrMergePharmacies(plan.scientificRepId, areaId, mergeNames, keepName, req.user.id);
    if (result.error) return fail(res, 400, result.error === 'area_not_in_scope' ? 'المنطقة ليست من مناطق هذا المندوب' : 'لا تغيير');
    await afterPharmacyEdit(plan, mergeNames, String(keepName).trim());
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[smart-monthly-plans] mergePharmacies', e);
    fail(res, 500, e.message);
  }
}

// ── رفع الملفات الأربعة ───────────────────────────────────────────────────

export async function uploadFile(req, res) {
  try {
    // multer يفك ترميز اسم الملف كـ latin1 فيتشوّه العربي — نعيده إلى UTF-8
    if (req.file?.originalname) req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const plan = await getOwnedPlan(req, req.params.id);
    const kind = req.params.kind;
    if (!plan) { if (req.file) fs.unlink(req.file.path, () => {}); return fail(res, 404, 'البلان غير موجود'); }
    if (!UPLOAD_KINDS.has(kind)) { if (req.file) fs.unlink(req.file.path, () => {}); return fail(res, 400, 'نوع ملف غير معروف'); }
    if (!req.file) return fail(res, 400, 'لم يُرفَع أي ملف');

    let parsed;
    try {
      const isAreaName = kind === 'openPharmacies' ? await loadKnownAreaNameChecker() : undefined;
      parsed = parseSmartPlanExcel(req.file.path, kind, { isAreaName });
    } catch (e) {
      return fail(res, 400, e.message);
    } finally {
      fs.unlink(req.file.path, () => {});
    }

    if (kind === 'openPharmacies') {
      const cleanedEntries = cleanOpenPharmacyEntries(parsed.pharmacyEntries);
      await prisma.smartPlanUpload.create({
        data: {
          smartPlanId: plan.id, kind, fileName: req.file.originalname,
          rowCount: parsed.rowCount, matchedCount: cleanedEntries.length,
          data: { pharmacyNames: cleanedEntries.map(e => e.name), pharmacyEntries: cleanedEntries },
        },
      });
      const linkResult = await applyOpenPharmacyLinks(plan.id);
      return res.json({ success: true, rowCount: parsed.rowCount, pharmacyNamesCount: cleanedEntries.length, hasAreaInfo: parsed.hasAreaInfo, ...linkResult });
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

    const allResolved = await prisma.smartPlanCandidate.findMany({
      where: { smartPlanId: plan.id, doctorId: { not: null } },
      include: { doctor: { select: { name: true, area: { select: { name: true } } } } },
    });
    // إن حدّد المستخدم أطباء من لوحة المناطق: كل طبيب داخل عالم اللوحة (أطباء السيرفي
    // بمناطق المندوب) يجب أن يكون مُحدَّداً؛ أما مرشّحو الملفات المرفوعة خارج ذلك
    // العالم فلا يتأثرون. لم يحدّد أحداً → لا قيد إطلاقاً.
    const selected = selectedKeySet(plan);
    let resolvedCandidates = allResolved;
    if (selected.size) {
      const universe = await getScopedDoctorKeySet(plan.scientificRepId);
      resolvedCandidates = allResolved.filter(c => {
        const keys = [doctorLinkKey(c.rawName, c.areaName)];
        if (c.doctor) keys.push(doctorLinkKey(c.doctor.name, c.doctor.area?.name ?? c.areaName));
        const inUniverse = keys.some(k => universe.has(k));
        return !inUniverse || keys.some(k => selected.has(k));
      });
    }

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
