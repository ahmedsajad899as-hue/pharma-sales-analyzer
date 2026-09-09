// ════════════════════════════════════════════════════════════════════════════
// surveyPharmacies.js — المصدر الموحّد لصيدليات السيرفي
// ────────────────────────────────────────────────────────────────────────────
// نظير surveyDoctors.js لكن للصيدليات: يُخرج خانة «زيارات الصيدليات» من نفس
// مبدأ خانة الأطباء — كل صيدليات السيرفي النشط ضمن مناطق نطاق المستخدم (لا فقط
// الصيدليات التي لها زيارة مسجَّلة مسبقاً)، فتظهر كل أسماء الصيدليات ومناطقها
// من السيرفي حتى قبل أي زيارة. resolveAreaScope مُستوردة من surveyDoctors.js
// لأنها عامة أصلاً (نطاق مناطق + سيرفيات) لا خاصة بالأطباء.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { areSimilar, similarity, normalizeStr } from './fuzzyMatch.js';

// Common prefixes/titles typed before a pharmacy name (same set the invoice-
// extraction path in sales.service.js strips) — stripped before comparing
// pharmacy names so "ص. النور" and "صيدلية النور" are recognised as the same name.
const PHARMACY_PREFIX_RE = /^\s*(ص\.?|صيدلية|الصيدلية|صيدليه|الصيدليه)\s+/i;
export function cleanPharmacyName(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3 && PHARMACY_PREFIX_RE.test(s); i++) s = s.replace(PHARMACY_PREFIX_RE, '').trim();
  return s;
}

// ── findClosestPharmacyName(deletedName, candidateNames) ────────────────────
// عند حذف صيدلية من السيرفي، الأطباء الذين كان اسم صيدليتهم هذا الاسم يحتاجون
// أقرب اسم بديل من الصيدليات المتبقية بدل أن يبقوا مربوطين باسم لم يعد موجوداً.
// نستعمل نفس محرّك areSimilar المستخدم لكشف التكرار عند استيراد الملفات (بادئة
// + Levenshtein + تداخل كلمات) لتصفية المرشّحين المقبولين فعلاً، ثم similarity
// لاختيار الأقرب بينهم. بلا مرشّح مقبول → null (يُترك الطبيب بلا اسم صيدلية).
export function findClosestPharmacyName(deletedName, candidateNames) {
  const cleanedDeleted = cleanPharmacyName(deletedName);
  if (!cleanedDeleted) return null;
  let best = null, bestScore = -1;
  for (const cand of candidateNames) {
    if (!cand || cand === deletedName) continue;
    const cleanedCand = cleanPharmacyName(cand);
    if (!cleanedCand || !areSimilar(cleanedDeleted, cleanedCand)) continue;
    const score = similarity(normalizeStr(cleanedDeleted), normalizeStr(cleanedCand));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

// ── getScopedSurveyPharmacies(scope) ─────────────────────────────────────────
// المجموعة القانونية: صيدليات السيرفي النشط ضمن مناطق النطاق. صيدلية بلا منطقة
// مسجَّلة لا يمكن نسبتها لفريق أصلاً فتُستبعد (كما تُستبعد صيدليات النطاق
// الفارغ بالكامل) — نفس فلسفة getScopedSurveyDoctors تماماً.
export async function getScopedSurveyPharmacies(scope) {
  const { surveyIds, normAreaNames } = scope;
  if (!surveyIds.length || !normAreaNames.length) return [];
  const all = await prisma.masterSurveyPharmacy.findMany({
    where: { surveyId: { in: surveyIds } },
    select: {
      id: true, name: true, ownerName: true, pharmacyName: true,
      phone: true, address: true, areaName: true, notes: true,
    },
    orderBy: { name: 'asc' },
  });
  const set = new Set(normAreaNames);
  return all.filter(p => p.areaName?.trim() && set.has(normalizeAreaName(p.areaName)));
}
