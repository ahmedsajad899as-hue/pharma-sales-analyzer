// ════════════════════════════════════════════════════════════════════════════
// smartPlanMatching.js — منطق البلان الشهري الذكي (مستقل عن MonthlyPlan الكلاسيكي)
// ────────────────────────────────────────────────────────────────────────────
// يجمع: (1) دمج/إنشاء مرشّحين من ملفات Excel متعددة لنفس البلان، (2) تصنيف
// الأسماء الغامضة عبر نفس محرّك classifyDoctorRows المستخدم في استيراد
// الزيارات (ذاكرة DoctorNameLink/MasterSurveyDoctorAlias + تطابق تام/ضبابي)،
// (3) خوارزمية توزيع حتمية 100% على فئات نسبية مرنة (لا يقرر Gemini الأعداد
// أبداً — فقط "الأفضل" ضمن عدد ثابت، عبر smart-plan-curator-ai.js).
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { buildAreaNameIndex, getScopedSurveyDoctors, doctorLinkKey, cleanDoctorName } from './surveyDoctors.js';
import { resolveAreaByName } from './areaResolver.js';
import { normalizeAreaName } from './itemResolver.js';
import { cleanPharmacyName } from './surveyPharmacies.js';
import { similarity } from './fuzzyMatch.js';
import { classifyDoctorRows, saveDoctorNameLinks } from '../modules/doctors/doctor-visits-import.js';
import { resolveDocOwnerUserId } from '../modules/doctors/doctors.controller.js';

// ── ملكية صفوف Doctor لهذه الجلسة ────────────────────────────────────────────
// مندوب له حساب دخول خاص (ScientificRepresentative.userId) يملك أطباءه بنفسه؛
// وإلا تُنسَب لمن أنشأ الجلسة (مديره غالباً) — نفس فلسفة resolveDocOwnerUserId
// لكن بدايةً من صف المندوب نفسه لا من حساب المستخدم الحالي.
export async function resolveSmartPlanOwnerUserId(rep, actingUserId) {
  if (rep?.userId) return rep.userId;
  return resolveDocOwnerUserId(actingUserId);
}

// ── نطاق مناطق مندوب علمي واحد (لا صلاحيات المستخدم الحالي) ─────────────────
// resolveAreaScope في surveyDoctors.js مبنية لصلاحيات "المستخدم الحالي يشاهد
// كذا"، وتفترض حساب دخول لكل مندوب في بعض المسارات — غير مضمون هنا. هذه بديل
// أبسط ومباشر: مناطق هذا المندوب المُعيَّنة فعلاً (ScientificRepArea) فقط.
export async function buildRepAreaScope(scientificRepId) {
  const areaRows = await prisma.scientificRepArea.findMany({
    where: { scientificRepId },
    select: { area: { select: { id: true, name: true } } },
  });
  const areaRecords = areaRows.map(r => r.area);
  const normToArea = await buildAreaNameIndex(areaRecords);
  const surveys = await prisma.masterSurvey.findMany({ where: { isActive: true }, select: { id: true } });
  return {
    areaIds: areaRecords.map(a => a.id),
    areaRecords,
    normToArea,
    normAreaNames: [...normToArea.keys()],
    surveyIds: surveys.map(s => s.id),
  };
}

/** أطباء السيرفي المُقيَّدين بمناطق هذا المندوب — fallback عند عدم رفع ملف سيرفي. */
export async function getRepSurveyDoctors(scientificRepId) {
  const scope = await buildRepAreaScope(scientificRepId);
  return getScopedSurveyDoctors(scope);
}

/**
 * يسحب أطباء السيرفي تلقائياً (مرة واحدة فقط لكل بلان — علامة SmartPlanUpload
 * وهمية بنوع 'survey' تمنع التكرار) حين لا يرفع المستخدم ملف سيرفي صريحاً.
 * حذف تلك العلامة (clearSmartPlanUpload) يُعيد تفعيل هذا الالتقاط تلقائياً في
 * المرة التالية — يطابق القرار المؤكَّد مع المستخدم (اختياري + fallback تلقائي).
 */
export async function ensureSurveyFallback(smartPlanId, scientificRepId) {
  const existing = await prisma.smartPlanUpload.findFirst({ where: { smartPlanId, kind: 'survey' } });
  if (existing) return { used: false };

  const surveyDoctors = await getRepSurveyDoctors(scientificRepId);
  const drafts = surveyDoctors.map(d => ({
    rawName: d.name,
    areaName: d.areaName,
    pharmacyName: d.pharmacyName,
    items: [],
    sourceFlags: { inSurvey: true },
  }));
  const { matched, created } = await ingestCandidateDrafts(smartPlanId, drafts);
  await prisma.smartPlanUpload.create({
    data: {
      smartPlanId, kind: 'survey',
      fileName: '(تلقائي — بيانات السيرفي حسب مناطق المندوب)',
      rowCount: surveyDoctors.length, matchedCount: matched + created,
    },
  });
  return { used: true, rowCount: surveyDoctors.length };
}

// ════════════════════════════════════════════════════════════════════════════
// دمج/إنشاء مرشّحين (SmartPlanCandidate) من صفوف Excel خام — قبل أي حسم هوية
// ════════════════════════════════════════════════════════════════════════════

/**
 * يدمج دفعة صفوف خام (name/areaName/pharmacyName/items/sourceFlags) في مرشّحي
 * البلان الحاليين (غير المحسومين بعد، doctorId=null) — نفس الاسم+المنطقة
 * (مفتاح doctorLinkKey) يُدمَج بدل إنشاء صفّ مكرَّر، فيتراكم sourceFlags/items
 * من أكثر من ملف على نفس الطبيب. لا يلمس المرشّحين المحسومين مسبقاً إطلاقاً.
 */
export async function ingestCandidateDrafts(smartPlanId, drafts) {
  const cleaned = (drafts || []).filter(d => String(d?.rawName ?? '').trim());
  if (!cleaned.length) return { matched: 0, created: 0 };

  const unresolved = await prisma.smartPlanCandidate.findMany({ where: { smartPlanId, doctorId: null } });
  const byKey = new Map(unresolved.map(c => [doctorLinkKey(c.rawName, c.areaName), c]));

  let matched = 0, created = 0;
  for (const draft of cleaned) {
    const rawName = String(draft.rawName).trim();
    const areaName = draft.areaName?.trim() || null;
    const key = doctorLinkKey(rawName, areaName);
    const existing = byKey.get(key);

    if (existing) {
      const mergedFlags = { ...(existing.sourceFlags || {}) };
      for (const [k, v] of Object.entries(draft.sourceFlags || {})) if (v) mergedFlags[k] = true;
      const mergedItems = Array.from(new Set([...(existing.items || []), ...(draft.items || [])]));
      const updated = await prisma.smartPlanCandidate.update({
        where: { id: existing.id },
        data: {
          areaName: existing.areaName || areaName,
          pharmacyName: existing.pharmacyName || draft.pharmacyName?.trim() || null,
          items: mergedItems,
          sourceFlags: mergedFlags,
        },
      });
      byKey.set(key, updated);
      matched++;
    } else {
      const createdRow = await prisma.smartPlanCandidate.create({
        data: {
          smartPlanId,
          rawName,
          areaName,
          pharmacyName: draft.pharmacyName?.trim() || null,
          items: draft.items?.length ? draft.items : [],
          sourceFlags: draft.sourceFlags || {},
          eligibleBucketKeys: [],
        },
      });
      byKey.set(key, createdRow);
      created++;
    }
  }
  return { matched, created };
}

// ════════════════════════════════════════════════════════════════════════════
// تصنيف الأسماء غير المحسومة — إعادة استعمال classifyDoctorRows بالكامل
// ════════════════════════════════════════════════════════════════════════════

/**
 * يبني صفوفاً بشكل ما يتوقعه classifyDoctorRows (doctorName/areaName/specialty/
 * pharmacyName) من مرشّحي هذا البلان غير المحسومين بعد، ويشغّل التصنيف — قراءة
 * فقط، لا كتابة. يُستعمل من كل من resolveSmartPlanCandidates (الحتمي) و
 * aiResolveSmartPlanCandidates (Gemini) على نفس المدخلات بالضبط.
 */
async function classifyUnresolved(smartPlanId, ownerUserId) {
  const candidates = await prisma.smartPlanCandidate.findMany({ where: { smartPlanId, doctorId: null } });
  if (!candidates.length) return { candidates: [], adapterRows: [], doctorNames: { resolved: [], pending: [], unrelated: [] } };

  const adapterRows = candidates.map(c => ({
    doctorName: c.rawName,
    areaName: c.areaName || '',
    specialty: '',
    pharmacyName: c.pharmacyName || '',
    _candidateId: c.id,
  }));

  const { doctorNames } = await classifyDoctorRows(adapterRows, ownerUserId);
  return { candidates, adapterRows, doctorNames };
}

/**
 * يُسنِد doctorId لمرشّح — وإن كان مرشّح آخر في نفس الجلسة قد سبق ربطه بنفس
 * doctorId (اسمان مختلفا التهجئة حُسما لنفس الطبيب فعلاً، فيصطدمان بقيد
 * @@unique([smartPlanId, doctorId])) يُدمَج هذا الصفّ في ذاك (اتحاد sourceFlags/
 * items) ويُحذَف بدل ترك الخطأ يوقف بقية الدفعة — لا يجوز أن يظهر نفس الطبيب
 * مرتين في تجمّع بلان واحد.
 */
async function assignDoctorToCandidate(smartPlanId, candidateId, doctorId, extra = {}) {
  try {
    return await prisma.smartPlanCandidate.update({ where: { id: candidateId }, data: { doctorId, ...extra } });
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    const [existing, dup] = await Promise.all([
      prisma.smartPlanCandidate.findFirst({ where: { smartPlanId, doctorId } }),
      prisma.smartPlanCandidate.findUnique({ where: { id: candidateId } }),
    ]);
    if (!existing || !dup) throw e;
    const mergedFlags = { ...(existing.sourceFlags || {}) };
    for (const [k, v] of Object.entries(dup.sourceFlags || {})) if (v) mergedFlags[k] = true;
    const mergedItems = Array.from(new Set([...(existing.items || []), ...(dup.items || [])]));
    const merged = await prisma.smartPlanCandidate.update({
      where: { id: existing.id },
      data: {
        areaName: existing.areaName || dup.areaName || null,
        pharmacyName: existing.pharmacyName || dup.pharmacyName || null,
        items: mergedItems,
        sourceFlags: mergedFlags,
      },
    });
    await prisma.smartPlanCandidate.delete({ where: { id: candidateId } });
    return merged;
  }
}

/**
 * التمريرة الحتمية: تطبّق روابط محفوظة/تطابقاً تاماً بلا سؤال، وتُنشئ صفّ
 * Doctor حقيقياً فوراً لكل اسم بلا أي مرشّح (unrelated) — يطابق قرار "تجسيد
 * Doctor حقيقي دائماً" في خطة التصميم. الأسماء الملتبسة (ask) تبقى بلا doctorId
 * لتمرّ لاحقاً على aiResolveSmartPlanCandidates ثم مراجعة بشرية إن لزم.
 */
export async function resolveSmartPlanCandidates(smartPlanId, ownerUserId) {
  const { adapterRows, doctorNames } = await classifyUnresolved(smartPlanId, ownerUserId);
  if (!adapterRows.length) return { linked: 0, exact: 0, ask: 0, created: 0 };

  const statusByKey = new Map();
  for (const r of doctorNames.resolved) statusByKey.set(r.key, r.status); // 'linked' | 'exact'
  for (const r of doctorNames.pending) statusByKey.set(r.key, 'ask');
  for (const r of doctorNames.unrelated) statusByKey.set(r.key, 'unrelated');

  let linked = 0, exact = 0, ask = 0, created = 0;
  for (const r of adapterRows) {
    const status = statusByKey.get(r.doctorKey);
    if (status === 'linked' || status === 'exact') {
      await assignDoctorToCandidate(smartPlanId, r._candidateId, r.doctorId, {
        matchTier: status,
        matchConfidence: 1,
        areaName: r.areaName || undefined,
        pharmacyName: r.pharmacyName || undefined,
      });
      status === 'linked' ? linked++ : exact++;
    } else if (status === 'ask') {
      const group = doctorNames.pending.find(p => p.key === r.doctorKey);
      const topScore = group?.suggestions?.[0]?.score ?? null;
      await prisma.smartPlanCandidate.update({
        where: { id: r._candidateId },
        data: { matchTier: 'ask', matchConfidence: topScore },
      });
      ask++;
    } else if (status === 'unrelated') {
      const areaResolved = r.areaName ? await resolveAreaByName(r.areaName) : null;
      const newDoctor = await prisma.doctor.create({
        data: {
          name: cleanDoctorName(r.doctorName) || r.doctorName,
          areaId: areaResolved?.area?.id ?? null,
          pharmacyName: r.pharmacyName || null,
          userId: ownerUserId,
        },
      });
      await prisma.smartPlanCandidate.update({
        where: { id: r._candidateId },
        data: { doctorId: newDoctor.id, matchTier: 'new', matchConfidence: null, resolvedAreaId: areaResolved?.area?.id ?? null },
      });
      created++;
    }
  }
  return { linked, exact, ask, created };
}

/**
 * يعيد قائمة "ask" الحالية (بعد التمريرة الحتمية) مع مرشّحيها — لعرضها في
 * الواجهة أو تغذية Gemini. كل مجموعة مُلحَقة بـcandidateId (صفّ SmartPlanCandidate
 * الفعلي المقابل لها — فريد لأن ingestCandidateDrafts يدمج بنفس المفتاح مسبقاً).
 */
export async function getAmbiguousCandidates(smartPlanId, ownerUserId) {
  const { adapterRows, doctorNames } = await classifyUnresolved(smartPlanId, ownerUserId);
  const candidateIdByKey = new Map(adapterRows.map(r => [r.doctorKey, r._candidateId]));
  return doctorNames.pending.map(g => ({ ...g, candidateId: candidateIdByKey.get(g.key) }));
  // [{raw,key,candidateId,areaName,specialty,pharmacyName,dates,suggestions:[{id,name,score,areaName,...}]}]
}

/**
 * تأكيد بشري لمرشّح "ask" متبقٍّ: doctorId رقم = اختيار أحد المقترحين، null =
 * "ليس أياً منهم، طبيب جديد". يُحفَظ القرار في DoctorNameLink كي لا يتكرر
 * السؤال لهذا الاسم مستقبلاً (لهذا المندوب وزملائه في نفس الشركة/المكتب).
 */
export async function confirmCandidateMatch(smartPlanId, ownerUserId, candidateId, doctorId) {
  const candidate = await prisma.smartPlanCandidate.findFirst({ where: { id: candidateId, smartPlanId } });
  if (!candidate) return null;

  // doctorId مُقترَح من الواجهة يجب أن يخصّ نفس مالك الأطباء (ownerUserId) —
  // منع ربط عرضي/خبيث بصفّ Doctor يخص حساباً آخر بالكامل.
  if (doctorId) {
    const belongs = await prisma.doctor.findFirst({ where: { id: doctorId, userId: ownerUserId }, select: { id: true } });
    if (!belongs) return null;
  }

  let finalDoctorId = doctorId;
  let matchTier = 'linked';
  if (!finalDoctorId) {
    const areaResolved = candidate.areaName ? await resolveAreaByName(candidate.areaName) : null;
    const newDoctor = await prisma.doctor.create({
      data: {
        name: cleanDoctorName(candidate.rawName) || candidate.rawName,
        areaId: areaResolved?.area?.id ?? null,
        pharmacyName: candidate.pharmacyName || null,
        userId: ownerUserId,
      },
    });
    finalDoctorId = newDoctor.id;
    matchTier = 'new';
  }

  await saveDoctorNameLinks(ownerUserId, [{ fromName: candidate.rawName, areaName: candidate.areaName, doctorId: finalDoctorId }]);

  return assignDoctorToCandidate(smartPlanId, candidate.id, finalDoctorId, {
    matchTier, matchConfidence: matchTier === 'linked' ? 1 : null,
  });
}

/**
 * يطبّق حسم Gemini لاسم ملتبس واحد (مسار aiResolveSmartPlanCandidates في
 * smart-plan-name-ai.js) — بخلاف confirmCandidateMatch (تأكيد بشري)، يُسجَّل
 * الرابط بثقة 'fuzzy' لا 'confirmed' لأن مراجعاً بشرياً لم يرَه بعد؛ هذا يطابق
 * قرار خطة التصميم: حسم Gemini وحده لا يُعامَل كتأكيد بشري نهائي.
 */
export async function applyAiCandidateMatch(smartPlanId, ownerUserId, candidateId, doctorId, { reason = null, score = null } = {}) {
  const candidate = await prisma.smartPlanCandidate.findFirst({ where: { id: candidateId, smartPlanId } });
  if (!candidate) return null;

  let finalDoctorId = doctorId;
  if (!finalDoctorId) {
    const areaResolved = candidate.areaName ? await resolveAreaByName(candidate.areaName) : null;
    const newDoctor = await prisma.doctor.create({
      data: {
        name: cleanDoctorName(candidate.rawName) || candidate.rawName,
        areaId: areaResolved?.area?.id ?? null,
        pharmacyName: candidate.pharmacyName || null,
        userId: ownerUserId,
      },
    });
    finalDoctorId = newDoctor.id;
  }

  const fromKey = doctorLinkKey(candidate.rawName, candidate.areaName);
  await prisma.doctorNameLink.upsert({
    where: { userId_fromKey: { userId: ownerUserId, fromKey } },
    update: { fromName: candidate.rawName, areaName: candidate.areaName || null, doctorId: finalDoctorId, confidence: 'fuzzy' },
    create: { userId: ownerUserId, fromKey, fromName: candidate.rawName, areaName: candidate.areaName || null, doctorId: finalDoctorId, confidence: 'fuzzy', needsReview: true },
  });

  return assignDoctorToCandidate(smartPlanId, candidate.id, finalDoctorId, {
    matchTier: 'ai_resolved', matchConfidence: score, aiReason: reason,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ربط الصيدليات المفتوحة — بعد استقرار doctorId/pharmacyName لكل مرشّح محسوم
// ════════════════════════════════════════════════════════════════════════════

/**
 * يعيد حساب sourceFlags.openPharmacyLinked لكل مرشّح محسوم (doctorId غير فارغ)
 * في هذا البلان، مقابل قائمة أسماء الصيدليات المفتوحة المرفوعة (SmartPlanUpload
 * kind='openPharmacies'). idempotent وآمن التكرار — يُستدعى بعد resolve وأيضاً
 * دفاعياً في بداية compute.
 */
/**
 * يطابق اسم صيدلية طبيب مع قائمة الصيدليات المفتوحة. findClosestPharmacyName
 * تتخطّى التطابق الحرفي (cand === name) لأنها مصمّمة لأسماء صيدليات "محذوفة"،
 * فنفحص التطابق التام بعد التنظيف أولاً ثم نرجع للتطابق الضبابي.
 * @returns {string|null} اسم الصيدلية المفتوحة المطابقة أو null
 */
// مطابقة صارمة عمداً: الضبابية العامة (areSimilar: بادئة/تداخل كلمات) صُمّمت
// لدمج تهجئات نفس الاسم وتُنتج مطابقات كاذبة بين أسماء صيدليات قصيرة تتشارك
// كلمة (مثل اسم المنطقة «الحارثية») فتظهر صيدليات "مفتوحة" وهي ليست في الملف.
const PHARMACY_NOISE_WORDS = new Set(['صيدليه', 'الصيدليه', 'صيدلية', 'الصيدلية', 'ص', 'مذخر', 'المذخر']);
function pharmacyTokens(name) {
  const s = String(name ?? '').toLowerCase()
    .replace(/[ً-ٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.split(/\s+/).filter(Boolean)
    .filter(w => !PHARMACY_NOISE_WORDS.has(w))
    .map(w => (w.length > 3 && w.startsWith('ال')) ? w.slice(2) : w);
}

export function matchOpenPharmacy(pharmacyName, openNames) {
  if (!pharmacyName?.trim() || !openNames?.length) return null;
  const tokens = pharmacyTokens(pharmacyName);
  if (!tokens.length) return null;
  const flat = tokens.join('');
  const sortedKey = [...tokens].sort().join(' ');
  let best = null, bestScore = 0;
  for (const cand of openNames) {
    const ct = pharmacyTokens(cand);
    if (!ct.length) continue;
    const cflat = ct.join('');
    if (cflat === flat || [...ct].sort().join(' ') === sortedKey) return cand; // تطابق تام (بعد التطبيع/ترتيب الكلمات)
    // خطأ إملائي بسيط فقط: اسم طويل نسبياً وتشابه عالٍ جداً
    if (Math.min(flat.length, cflat.length) >= 7) {
      const sim = similarity(flat, cflat);
      if (sim >= 0.9 && sim > bestScore) { bestScore = sim; best = cand; }
    }
  }
  return best;
}

/** مفتاح استبعاد طبيب — نفس مفتاح ربط الأسماء المستعمل لدمج المرشّحين. */
export function excludedKeySet(plan) {
  return new Set(Array.isArray(plan?.excludedDoctorKeys) ? plan.excludedDoctorKeys : []);
}

/**
 * نظرة "مناطق المندوب وأطباؤها" للبلان: كل منطقة مُعيَّنة لهذا المندوب مع أطباء
 * السيرفي فيها (اختصاص/صيدلية/كلاس) — نفس مصدر تحليل الزيارات — مع علامة هل
 * صيدلية كل طبيب مطابقة لأحد الصيدليات المفتوحة المرفوعة، وهل هو مستبعد يدوياً.
 */
export async function getAreaDoctorsOverview(plan) {
  const scope = await buildRepAreaScope(plan.scientificRepId);
  const docs = await getScopedSurveyDoctors(scope);
  const upload = await prisma.smartPlanUpload.findFirst({
    where: { smartPlanId: plan.id, kind: 'openPharmacies' },
    orderBy: { id: 'desc' },
  });
  const openNames = upload?.data?.pharmacyNames || [];
  const excluded = excludedKeySet(plan);

  // منطقة → صيدلية → أطباء (الأطباء بلا صيدلية تحت مجموعة اسمها null)
  const byArea = new Map(scope.areaRecords.map(a => [a.id, { areaId: a.id, areaName: a.name, pharmacyMap: new Map() }]));
  const matchCache = new Map();
  for (const d of docs) {
    const area = scope.normToArea.get(normalizeAreaName(d.areaName ?? ''));
    const bucket = area && byArea.get(area.id);
    if (!bucket) continue;
    const key = doctorLinkKey(d.name, d.areaName);
    const pharmName = d.pharmacyName?.trim() || null;
    const pKey = pharmName ? pharmacyTokens(pharmName).join('') || pharmName : '';
    let group = bucket.pharmacyMap.get(pKey);
    if (!group) {
      if (pharmName && !matchCache.has(pharmName)) matchCache.set(pharmName, matchOpenPharmacy(pharmName, openNames));
      const matched = pharmName ? matchCache.get(pharmName) : null;
      group = { name: pharmName, openPharmacy: !!matched, matchedOpenPharmacy: matched, doctors: [] };
      bucket.pharmacyMap.set(pKey, group);
    }
    group.doctors.push({
      id: d.id, key, name: d.name, specialty: d.specialty || null,
      className: d.className || null, phone: d.phone || null,
      included: !excluded.has(key),
    });
  }
  const areas = [...byArea.values()].map(({ pharmacyMap, ...a }) => ({
    ...a,
    pharmacies: [...pharmacyMap.values()].sort((x, y) =>
      (x.name ? 0 : 1) - (y.name ? 0 : 1) || (x.name || '').localeCompare(y.name || '', 'ar')),
  })).sort((a, b) => a.areaName.localeCompare(b.areaName, 'ar'));
  return { areas, hasOpenPharmaciesFile: openNames.length > 0, openPharmacyNamesCount: openNames.length };
}

export async function applyOpenPharmacyLinks(smartPlanId) {
  const upload = await prisma.smartPlanUpload.findFirst({
    where: { smartPlanId, kind: 'openPharmacies' },
    orderBy: { id: 'desc' },
  });
  const openNames = upload?.data?.pharmacyNames || [];
  const candidates = await prisma.smartPlanCandidate.findMany({
    where: { smartPlanId, doctorId: { not: null } },
    select: { id: true, pharmacyName: true, sourceFlags: true },
  });

  let linkedCount = 0;
  for (const c of candidates) {
    const isLinked = !!matchOpenPharmacy(c.pharmacyName, openNames);
    const current = c.sourceFlags || {};
    if (!!current.openPharmacyLinked === isLinked) continue; // لا تغيير — تفادي كتابة غير ضرورية
    await prisma.smartPlanCandidate.update({
      where: { id: c.id },
      data: { sourceFlags: { ...current, openPharmacyLinked: isLinked } },
    });
    if (isLinked) linkedCount++;
  }
  return { openPharmacyNamesCount: openNames.length, linkedCount };
}

/** ينظّف قائمة أسماء صيدليات خام (من ملف الصيدليات المفتوحة) — تطبيع + إزالة تكرار. */
export function cleanOpenPharmacyNames(rawNames) {
  const seen = new Set();
  const out = [];
  for (const raw of rawNames || []) {
    const cleaned = cleanPharmacyName(raw);
    if (!cleaned) continue;
    const key = normalizeAreaName(cleaned); // تطبيع عام كافٍ هنا (لا حاجة لمفتاح صيدليات مخصّص لمجرّد إزالة تكرار)
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// خوارزمية توزيع النسب — حتمية بالكامل (راجع القسم 2 من خطة التصميم)
// ════════════════════════════════════════════════════════════════════════════

/**
 * (أ) طريقة الباقي الأكبر (Largest Remainder / Hare quota): يضمن
 * sum(quotas) === N دائماً بصرف النظر عن كسور percent/100*N.
 * @param {number} N
 * @param {{key:string,percent:number}[]} buckets
 * @returns {Map<string, number>} key → quota
 */
export function computeBucketQuotas(N, buckets) {
  const totalPercent = buckets.reduce((s, b) => s + (Number(b.percent) || 0), 0) || 100;
  const raw = buckets.map(b => (N * (Number(b.percent) || 0)) / totalPercent);
  const floors = raw.map(Math.floor);
  let remainder = N - floors.reduce((s, f) => s + f, 0);

  const fractions = raw.map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const quotas = [...floors];
  for (let k = 0; k < fractions.length && remainder > 0; k++, remainder--) {
    quotas[fractions[k].i]++;
  }
  return new Map(buckets.map((b, i) => [b.key, quotas[i]]));
}

/**
 * (ب) إسناد كل مرشّح مؤهَّل لأكثر من bucket واحد إلى bucket "موطن" واحد فقط —
 * الأكثر تقييداً أولاً (أقل عدد بدائل مؤهَّلة)، ثم أفضل مساحة نسبية متبقية،
 * بفاصل تعادل = ترتيب bucket في ratioConfig.
 * @param {{id:number, eligibleBucketKeys:string[]}[]} candidates
 * @param {{key:string}[]} buckets
 * @param {Map<string,number>} quotas
 * @returns {{homeByBucket: Map<string, any[]>, unassignable: any[]}}
 */
export function assignHomeBuckets(candidates, buckets, quotas) {
  const bucketOrder = new Map(buckets.map((b, i) => [b.key, i]));
  const homeByBucket = new Map(buckets.map(b => [b.key, []]));
  const unassignable = [];

  const sorted = [...candidates].sort((a, b) => {
    const la = (a.eligibleBucketKeys || []).length, lb = (b.eligibleBucketKeys || []).length;
    if (la !== lb) return la - lb;
    return a.id - b.id;
  });

  for (const cand of sorted) {
    const eligible = (cand.eligibleBucketKeys || []).filter(k => homeByBucket.has(k));
    if (!eligible.length) { unassignable.push(cand); continue; }

    let bestKey = null, bestSlack = -Infinity, bestOrder = Infinity;
    for (const key of eligible) {
      const quota = quotas.get(key) || 0;
      const current = homeByBucket.get(key).length;
      const slack = quota - current; // قد يكون سالباً لو bucket ممتلئ فعلاً — يبقى مرشّحاً محتملاً (فائض يُعاد توزيعه لاحقاً)
      const order = bucketOrder.get(key) ?? Infinity;
      if (slack > bestSlack || (slack === bestSlack && order < bestOrder)) {
        bestSlack = slack; bestKey = key; bestOrder = order;
      }
    }
    homeByBucket.get(bestKey).push(cand);
  }

  return { homeByBucket, unassignable };
}

/**
 * (ج) إعادة توزيع النقص: bucket ناقص مرشّحين (home أقل من quota) يُسحَب له
 * بديل من فائض buckets أخرى — شرط أن يكون المرشّح مؤهَّلاً فعلياً لهذا الـbucket
 * الناقص (eligibleBucketKeys)، لا فقط من موطنه الأصلي. أي نقص لا يمكن سدّه
 * يُترك ويُعرض بوضوح — لا اختلاق أي اختيار وهمي.
 * @returns {{finalByBucket: Map<string, any[]>, shortfallByBucket: Map<string, number>}}
 */
export function redistributeShortfalls(homeByBucket, buckets, quotas) {
  const finalByBucket = new Map([...homeByBucket.entries()].map(([k, v]) => [k, [...v]]));
  const shortfallByBucket = new Map();

  for (const bucket of buckets) {
    const key = bucket.key;
    const quota = quotas.get(key) || 0;
    let current = finalByBucket.get(key);
    let need = quota - current.length;
    if (need <= 0) { shortfallByBucket.set(key, 0); continue; }

    // مرشّحون في buckets أخرى تجاوز موطنها quota ـها (فائض)، ومؤهَّلون أيضاً لهذا bucket
    const donors = [];
    for (const other of buckets) {
      if (other.key === key) continue;
      const otherList = finalByBucket.get(other.key);
      const otherQuota = quotas.get(other.key) || 0;
      const surplusCount = otherList.length - otherQuota;
      if (surplusCount <= 0) continue;
      const eligibleDonors = otherList.filter(c => (c.eligibleBucketKeys || []).includes(key));
      donors.push(...eligibleDonors.slice(0, surplusCount).map(c => ({ c, fromKey: other.key })));
    }

    for (const { c, fromKey } of donors) {
      if (need <= 0) break;
      const fromList = finalByBucket.get(fromKey);
      const idx = fromList.findIndex(x => x.id === c.id);
      if (idx === -1) continue;
      fromList.splice(idx, 1);
      current.push(c);
      need--;
    }
    shortfallByBucket.set(key, Math.max(0, need));
  }

  return { finalByBucket, shortfallByBucket };
}

/**
 * الحساب الكامل: quotas → إسناد موطن → إعادة توزيع النقص. لا يستدعي Gemini —
 * تُستدعى طبقة الـcurator (smart-plan-curator-ai.js) لاحقاً فقط على الفائض
 * ضمن كل bucket مُشبَع، لاختيار "الأفضل" ضمن العدد الثابت المحسوم هنا.
 * @param {number} targetDoctorCount
 * @param {{key,label,percent,sourceTag}[]} ratioConfig
 * @param {any[]} resolvedCandidates — مرشّحون محسومون (doctorId غير فارغ) فقط
 */
export function computeBucketPlan(targetDoctorCount, ratioConfig, resolvedCandidates) {
  const buckets = ratioConfig.filter(b => b.key && Number(b.percent) > 0);
  const withEligibility = resolvedCandidates.map(c => {
    const flags = c.sourceFlags || {};
    const eligibleBucketKeys = buckets.filter(b => flags[b.sourceTag]).map(b => b.key);
    return { ...c, eligibleBucketKeys };
  });

  const quotas = computeBucketQuotas(targetDoctorCount, buckets);
  const { homeByBucket, unassignable } = assignHomeBuckets(withEligibility, buckets, quotas);
  const { finalByBucket, shortfallByBucket } = redistributeShortfalls(homeByBucket, buckets, quotas);

  const summary = buckets.map(b => ({
    key: b.key,
    label: b.label,
    percent: b.percent,
    quota: quotas.get(b.key) || 0,
    poolSize: finalByBucket.get(b.key).length,
    shortfall: shortfallByBucket.get(b.key) || 0,
  }));

  return { buckets, quotas, finalByBucket, unassignable, summary };
}
