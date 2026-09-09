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
