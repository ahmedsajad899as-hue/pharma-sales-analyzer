// ════════════════════════════════════════════════════════════════════════════
// rep-followup.service.js — طبقة القياس في نظام متابعة المندوبين.
//
// تحسب لكل مندوب علمي، لشهر واحد، لقطة واحدة تضمّ خمس عائلات مقاييس:
//   المبيع/التارجت · الزيارات · التغطية · التطوّر · الانضباط
// ثم تختصرها في مؤشّر واحد (score) وحالة (status) وأسباب بالعربي.
//
// ثلاثة مبادئ تحكم هذا الملف:
//
// 1) لا منطق مبيعات أو زيارات جديد هنا. المبيع من scientific-reps.getReport()
//    (نفس دالة تقرير المندوب العلمي بكل حجوباتها وتطبيع عملتها)، والزيارات
//    والتغطية من doctors.computeRepsVisitsSummary(). رقم في هذه الصفحة يخالف
//    الصفحة الأصلية يعني أن أحدهما خطأ — فلا نسمح بوجود حاسبين.
//
// 2) الملفات = «الملفات المفعّلة» لحساب المدير (lib/activeFiles.js). الحساب
//    بلا واجهة لا يرى تفعيل المتصفح، وبدون هذا تظهر أرقام اللقطة أعلى من أرقام
//    الشاشة بلا سبب مفهوم.
//
// 3) ما لا يمكن قياسه لا يُحتسب صفراً. مندوب بلا تارجت مُدخَل لا يستحق 0 من 40
//    على المبيع — يُستبعد وزن المبيع من المقام (renormalize). وإلا صار المؤشّر
//    يعاقب على تقصير إداري لا تقصير المندوب.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { computeRepsVisitsSummary, loadFollowupForViewer } from '../doctors/doctors.controller.js';
import { getReport } from '../scientific-reps/scientific-reps.service.js';
import { resolveActiveFileIds } from '../../lib/activeFiles.js';
import { effectiveFor, parseRestWeekdays, workingDaysElapsed, workingDaysInMonth } from '../../lib/followupStandards.js';

const pad2 = (n) => String(n).padStart(2, '0');
export const periodKeyOf = (year, month) => `${year}-${pad2(month)}`;

/** بغداد UTC+3 بلا توقيت صيفي — «اليوم» يجب أن يطابق يوم المستخدم لا يوم UTC. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const baghdadNow = (d = new Date()) => new Date(d.getTime() + BAGHDAD_OFFSET_MS);
export const baghdadDayKey = (d = new Date()) => baghdadNow(d).toISOString().slice(0, 10);

function monthBounds(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    lastDay,
  };
}

function prevMonthOf(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const clamp100 = (v) => Math.max(0, Math.min(100, v));

// ════════════════════════════════════════════════════════════════════════════
// الحساب الكامل لفريق مدير واحد
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {{id:number, role:string}} viewerUser  المدير (أو حساب إداري) الذي يُحسب فريقه
 * @param {{month:number, year:number, companyIds?:number[], persist?:boolean}} opts
 */
export async function computeScorecards(viewerUser, { month, year, companyIds = [], persist = true } = {}) {
  const t0 = Date.now();
  const followup = await loadFollowupForViewer(viewerUser.id);
  const { ownerUserId, standards } = followup;

  // ملفات المبيعات تُقرأ من حساب **المالك** لا المشاهد: المندوب الذي يفتح
  // سكوركاردَه يجب أن يرى نفس أرقام مديره، لا أرقاماً محسوبة على ملفاته هو.
  const files = await resolveActiveFileIds(ownerUserId);
  const fileScope = { ids: files.ids, synced: files.synced, source: files.source, count: files.ids.length };

  const { reps, companies } = await computeRepsVisitsSummary(viewerUser, { month, year, companyIds, followup });

  const nowB = baghdadNow();
  const isCurrentMonth = nowB.getUTCFullYear() === year && nowB.getUTCMonth() + 1 === month;
  const { startDate, endDate } = monthBounds(year, month);
  const prev = prevMonthOf(year, month);
  const prevBounds = monthBounds(prev.year, prev.month);

  const cards = [];
  // متسلسل عمداً لا Promise.all: كل getReport يقرأ آلاف صفوف المبيعات، والخادم
  // ذاكرته ~١ غيغا. عشرون استدعاءً متوازياً كان سيُسقط العملية.
  for (const rep of reps) {
    try {
      cards.push(await buildCardForRep({
        rep, followup, standards, files, month, year,
        startDate, endDate, prevBounds, isCurrentMonth, ownerUserId, nowB,
      }));
    } catch (err) {
      console.error('[rep-followup] فشل حساب المندوب %s: %s', rep.name, err?.message);
      cards.push(failedCard(rep, err));
    }
  }

  cards.sort((a, b) => b.score - a.score);

  if (persist) await persistSnapshots(ownerUserId, periodKeyOf(year, month), cards, fileScope);

  console.log('[rep-followup] حُسب %d مندوباً لـ %s في %dms', cards.length, periodKeyOf(year, month), Date.now() - t0);
  return {
    periodKey: periodKeyOf(year, month),
    month, year,
    ownerUserId,
    standards,
    fileScope,
    companies,
    reps: cards,
    computedAt: new Date().toISOString(),
  };
}

async function buildCardForRep(ctx) {
  const {
    rep, followup, standards, files, month, year,
    startDate, endDate, prevBounds, isCurrentMonth, ownerUserId, nowB,
  } = ctx;

  const eff = effectiveFor(standards, followup.overridesByRepId?.get(rep.repId) ?? null);

  // ── المبيع (الشهر الحالي والسابق) ─────────────────────────────────────────
  let sales = { netValue: 0, orderCount: 0, byItem: [], bySource: null, hasData: false };
  let prevSales = { netValue: 0, orderCount: 0, hasData: false };
  if (rep.repId && files.ids.length) {
    const cur = await getReport(rep.repId, { fileIds: files.ids, startDate, endDate }, ownerUserId);
    sales = {
      netValue: cur.summary.totalValue,
      orderCount: cur.summary.orderCount,
      byItem: cur.byItem ?? [],
      bySource: cur.bySource ?? null,
      hasData: true,
    };
    const pv = await getReport(rep.repId, { fileIds: files.ids, startDate: prevBounds.startDate, endDate: prevBounds.endDate }, ownerUserId);
    prevSales = { netValue: pv.summary.totalValue, orderCount: pv.summary.orderCount, hasData: true };
  }

  // ── التارجت (كمية لا قيمة — نفس وحدة شاشة التارگت) ────────────────────────
  const targetRows = rep.repId
    ? await prisma.repItemTarget.findMany({
        where: { repType: 'scientific', repId: rep.repId, month, year },
        include: { item: { select: { id: true, name: true } } },
      })
    : [];
  const qtyByItem = new Map((sales.byItem ?? []).map(it => [it.itemId, it.totalQuantity ?? 0]));
  const targetTotal = targetRows.reduce((s, t) => s + (t.target || 0), 0);
  const achievedQty = targetRows.reduce((s, t) => s + (qtyByItem.get(t.itemId) ?? 0), 0);
  const perItem = targetRows.map(t => {
    const actual = qtyByItem.get(t.itemId) ?? 0;
    return {
      itemId: t.itemId,
      itemName: t.item?.name ?? `#${t.itemId}`,
      target: t.target || 0,
      actual,
      achievementPct: pct(actual, t.target || 0),
    };
  }).sort((a, b) => (a.achievementPct ?? 999) - (b.achievementPct ?? 999));
  const zeroSaleItems = perItem.filter(i => i.target > 0 && i.actual <= 0);

  const achievementPct = pct(achievedQty, targetTotal);
  // إسقاط نهاية الشهر بالسرعة الحالية — هذا ما يجعل الرقم قابلاً للتنفيذ: «أنت
  // على ٤٠٪ ومرّ ٦٠٪ من الشهر» أهم من «أنت على ٤٠٪».
  const workDaysTotal = workingDaysInMonth(year, month, eff.restWeekdays);
  const workDaysElapsed = isCurrentMonth
    ? workingDaysElapsed(year, month, nowB, eff.restWeekdays)
    : workDaysTotal;
  const monthProgressPct = pct(workDaysElapsed, workDaysTotal) ?? 100;
  const projectedPct = (achievementPct !== null && workDaysElapsed > 0)
    ? Math.round(achievementPct * (workDaysTotal / workDaysElapsed))
    : null;
  const gapQty = targetTotal > 0 ? Math.max(0, targetTotal - achievedQty) : 0;
  const remainingWorkDays = Math.max(0, workDaysTotal - workDaysElapsed);
  const neededPerDay = remainingWorkDays > 0 ? Math.ceil(gapQty / remainingWorkDays) : gapQty;

  // ── الزيارات (المتوقَّع يتبع الأيام المنقضية لا الشهر كله) ─────────────────
  const expectedDoctorVisits = eff.doctorVisitsPerDay * workDaysElapsed;
  const expectedPharmacyVisits = eff.pharmacyVisitsPerDay * workDaysElapsed;
  const doctorVisitPct = pct(rep.doctorVisitCount, expectedDoctorVisits);
  const pharmacyVisitPct = pct(rep.pharmacyVisitCount, expectedPharmacyVisits);

  // أيام عمل انقضت بلا أي زيارة مسجَّلة — أصدق مؤشّر على يوم ضائع.
  const rest = parseRestWeekdays(eff.restWeekdays);
  const lastDayToCount = isCurrentMonth ? nowB.getUTCDate() : new Date(Date.UTC(year, month, 0)).getUTCDate();
  const zeroDayList = [];
  for (const d of rep.days ?? []) {
    if (d.day > lastDayToCount) break;
    if (rest.has(new Date(Date.UTC(year, month - 1, d.day)).getUTCDay())) continue;
    if ((d.doctorVisitCount + d.pharmacyVisitCount) === 0) zeroDayList.push(d.day);
  }

  // ── التغطية (نسبة مَن زارهم من أطباء/صيدليات السيرفي في مناطقه) ────────────
  const doctorCoveragePct = pct(rep.visitedDoctors, rep.totalDoctors);
  const pharmacyCoveragePct = pct(rep.visitedPharmacies, rep.totalPharmacies);
  // منطقة بلا أي زيارة هذا الشهر. ملاحظة: تظهر هنا فقط المناطق التي لها أطباء/
  // صيدليات في السيرفي أو زيارات فعلية — منطقة فارغة من السيرفي تماماً لا مصدر
  // لها لتُحتسب (تُعالَج بفحص «الظهور» في شاشة السيرفي لا هنا).
  const areasWithNoVisits = (rep.areas ?? [])
    .filter(a => (a.doctorVisitCount + a.pharmacyVisitCount) === 0)
    .map(a => a.areaName);

  // ── التطوّر ───────────────────────────────────────────────────────────────
  const growthPct = (prevSales.hasData && prevSales.netValue > 0)
    ? Math.round(((sales.netValue - prevSales.netValue) / prevSales.netValue) * 100)
    : null;
  const orderGrowthPct = (prevSales.hasData && prevSales.orderCount > 0)
    ? Math.round(((sales.orderCount - prevSales.orderCount) / prevSales.orderCount) * 100)
    : null;

  // ── الانضباط: التزام البلان اليومي ────────────────────────────────────────
  const plan = await planAdherence(rep, year, month);

  const metrics = {
    sales: {
      netValue: sales.netValue, orderCount: sales.orderCount, hasData: sales.hasData,
      bySource: sales.bySource,
      prevNetValue: prevSales.netValue, prevOrderCount: prevSales.orderCount,
    },
    target: {
      total: targetTotal, achieved: achievedQty, achievementPct, projectedPct,
      gapQty, neededPerDay, remainingWorkDays, itemCount: targetRows.length,
      zeroSaleItems: zeroSaleItems.slice(0, 10),
      weakest: perItem.filter(i => i.target > 0).slice(0, 5),
    },
    visits: {
      doctorVisits: rep.doctorVisitCount, pharmacyVisits: rep.pharmacyVisitCount,
      expectedDoctorVisits, expectedPharmacyVisits, doctorVisitPct, pharmacyVisitPct,
      workDaysElapsed, workDaysTotal, monthProgressPct,
      activeDays: rep.activeDays ?? 0, zeroDays: zeroDayList.length, zeroDayList: zeroDayList.slice(0, 15),
    },
    coverage: {
      visitedDoctors: rep.visitedDoctors, totalDoctors: rep.totalDoctors, doctorCoveragePct,
      visitedPharmacies: rep.visitedPharmacies, totalPharmacies: rep.totalPharmacies, pharmacyCoveragePct,
      areasWithNoVisits, areaCount: (rep.areas ?? []).length,
      areas: rep.areas ?? [],
    },
    growth: { growthPct, orderGrowthPct },
    discipline: plan,
    standardsUsed: {
      doctorVisitsPerDay: eff.doctorVisitsPerDay,
      pharmacyVisitsPerDay: eff.pharmacyVisitsPerDay,
      workDaysPerMonth: eff.workDaysPerMonth,
      doctorRevisitDays: eff.doctorRevisitDays,
      doctorCoverageTargetPct: eff.doctorCoverageTargetPct,
      pharmacyCoverageTargetPct: eff.pharmacyCoverageTargetPct,
      targetAchievementMinPct: eff.targetAchievementMinPct,
      growthTargetPct: eff.growthTargetPct,
      areaIdleDays: eff.areaIdleDays,
      hasOverride: eff.hasOverride,
      overrideNote: eff.overrideNote ?? null,
    },
  };

  const { score, status, components } = scoreCard(metrics, eff);
  const reasons = buildReasons(metrics, eff, status);

  return {
    repUserId: rep.userId,
    scientificRepId: rep.repId ?? null,
    repName: rep.name,
    company: rep.company ?? null,
    score, status, components, reasons, metrics,
  };
}

function failedCard(rep, err) {
  return {
    repUserId: rep.userId,
    scientificRepId: rep.repId ?? null,
    repName: rep.name,
    company: rep.company ?? null,
    score: 0,
    status: 'error',
    components: {},
    reasons: [`تعذّر حساب هذا المندوب: ${err?.message || 'خطأ غير معروف'}`],
    metrics: null,
  };
}

// ── التزام البلان اليومي ────────────────────────────────────────────────────
/**
 * البلان يُطابَق بهوية المندوب (scientificRepId أو repUserId) لا بحساب المالك:
 * صفوف البلان قد يملكها المدير أو المندوب نفسه حسب مَن أنشأها، والمطابقة
 * بالمالك وحده كانت تُرجع صفراً لمندوب يبني بلانه بنفسه.
 */
async function planAdherence(rep, year, month) {
  const { startDate, endDate } = monthBounds(year, month);
  const or = [];
  if (rep.repId) or.push({ scientificRepId: rep.repId });
  if (rep.userId) or.push({ repUserId: rep.userId });
  if (!or.length) return { planned: 0, visited: 0, postponed: 0, adherencePct: null, hasData: false };

  const plans = await prisma.dailyPlan.findMany({
    // planDate نصّ "YYYY-MM-DD" — المقارنة المعجمية صحيحة لهذه الصيغة تحديداً.
    where: { OR: or, planDate: { gte: startDate, lte: endDate } },
    select: { id: true, entries: { select: { status: true, autoPostponed: true } } },
  });
  let planned = 0, visited = 0, postponed = 0, autoPostponed = 0;
  for (const p of plans) {
    for (const e of p.entries) {
      planned++;
      if (e.status === 'visited') visited++;
      else if (e.status === 'postponed') { postponed++; if (e.autoPostponed) autoPostponed++; }
    }
  }
  return {
    planned, visited, postponed, autoPostponed,
    planCount: plans.length,
    adherencePct: pct(visited, planned),
    hasData: planned > 0,
  };
}

// ── المؤشّر ─────────────────────────────────────────────────────────────────
/**
 * وزن كل عائلة من معايير المكتب، والعائلة غير القابلة للقياس تُسقَط من المقام
 * بدل أن تُحتسب صفراً (راجع المبدأ ٣ أعلى الملف).
 */
export function scoreCard(metrics, eff) {
  const parts = [];

  // المبيع: التحقّق مقابل أدنى تحقّق مقبول (٩٠٪ افتراضاً) — لا مقابل ١٠٠٪،
  // فالمعيار الذي يضعه المدير هو خط النجاح لا الكمال.
  if (metrics.target.achievementPct !== null && metrics.target.total > 0) {
    const bar = eff.targetAchievementMinPct || 100;
    parts.push({ key: 'sales', weight: eff.weightSales, pct: clamp100((metrics.target.achievementPct / bar) * 100) });
  }

  // الزيارات: أطباء ٦٠٪ + صيدليات ٤٠٪ من الوزن.
  if (metrics.visits.doctorVisitPct !== null || metrics.visits.pharmacyVisitPct !== null) {
    const d = clamp100(metrics.visits.doctorVisitPct ?? 0);
    const p = clamp100(metrics.visits.pharmacyVisitPct ?? 0);
    parts.push({ key: 'visits', weight: eff.weightVisits, pct: d * 0.6 + p * 0.4 });
  }

  // التغطية: نسبة المحقَّق من نسبة التغطية المطلوبة.
  if (metrics.coverage.doctorCoveragePct !== null || metrics.coverage.pharmacyCoveragePct !== null) {
    const dBar = eff.doctorCoverageTargetPct || 100;
    const pBar = eff.pharmacyCoverageTargetPct || 100;
    const d = clamp100(((metrics.coverage.doctorCoveragePct ?? 0) / dBar) * 100);
    const p = clamp100(((metrics.coverage.pharmacyCoveragePct ?? 0) / pBar) * 100);
    parts.push({ key: 'coverage', weight: eff.weightCoverage, pct: d * 0.6 + p * 0.4 });
  }

  // التطوّر: نمو شهر/شهر مقابل النمو المطلوب. نمو سالب = صفر لا رقم سالب
  // (المؤشّر لا يجوز أن يهبط تحت الصفر بسبب عائلة واحدة).
  if (metrics.growth.growthPct !== null) {
    const bar = eff.growthTargetPct || 10;
    parts.push({ key: 'growth', weight: eff.weightGrowth, pct: clamp100((metrics.growth.growthPct / bar) * 100) });
  }

  // الانضباط: التزام البلان + نسبة الأيام غير الضائعة.
  const disciplineBits = [];
  if (metrics.discipline.adherencePct !== null) disciplineBits.push(clamp100(metrics.discipline.adherencePct));
  if (metrics.visits.workDaysElapsed > 0) {
    disciplineBits.push(clamp100(((metrics.visits.workDaysElapsed - metrics.visits.zeroDays) / metrics.visits.workDaysElapsed) * 100));
  }
  if (disciplineBits.length) {
    parts.push({ key: 'discipline', weight: eff.weightDiscipline, pct: disciplineBits.reduce((a, b) => a + b, 0) / disciplineBits.length });
  }

  const totalWeight = parts.reduce((s, p) => s + (p.weight || 0), 0);
  const score = totalWeight > 0
    ? Math.round(parts.reduce((s, p) => s + p.pct * (p.weight || 0), 0) / totalWeight)
    : 0;

  const components = {};
  for (const p of parts) components[p.key] = { weight: p.weight, pct: Math.round(p.pct) };
  // لا بيانات على الإطلاق ≠ أداء صفر — حالة منفصلة كي لا يُحاسَب المندوب على
  // ملفات لم تُرفَع أو تارجت لم يُدخَل.
  const status = totalWeight === 0 ? 'no_data'
    : score >= 85 ? 'excellent'
      : score >= 70 ? 'good'
        : score >= 50 ? 'watch'
          : 'behind';

  return { score, status, components, measuredWeight: totalWeight };
}

/** أسباب الحالة بالعربي — أسطر قصيرة قابلة للتنفيذ، لا جمل عامة. */
export function buildReasons(metrics, eff, status) {
  const out = [];
  const t = metrics.target, v = metrics.visits, c = metrics.coverage, g = metrics.growth, d = metrics.discipline;

  if (status === 'no_data') {
    out.push('لا توجد بيانات كافية: لا ملفات مبيعات مفعّلة ولا زيارات ولا تارجت لهذا الشهر.');
    return out;
  }

  if (t.total > 0 && t.achievementPct !== null) {
    if (t.projectedPct !== null && t.projectedPct < eff.targetAchievementMinPct) {
      out.push(`التارجت ${t.achievementPct}% ومرّ ${v.monthProgressPct}% من الشهر — المتوقَّع نهاية الشهر ${t.projectedPct}%${t.neededPerDay > 0 ? `، يحتاج ${t.neededPerDay.toLocaleString('en-US')} وحدة باليوم` : ''}.`);
    } else if (t.achievementPct >= eff.targetAchievementMinPct) {
      out.push(`التارجت ${t.achievementPct}% — فوق المعيار (${eff.targetAchievementMinPct}%).`);
    }
    if (t.zeroSaleItems.length) {
      out.push(`${t.zeroSaleItems.length} ايتم عليه تارجت بلا أي مبيع: ${t.zeroSaleItems.slice(0, 3).map(i => i.itemName).join('، ')}${t.zeroSaleItems.length > 3 ? ' …' : ''}`);
    }
  } else if (t.total === 0) {
    out.push('لا تارجت مُدخَل لهذا الشهر — وزن المبيع مُستبعَد من المؤشّر.');
  }

  if (v.doctorVisitPct !== null && v.doctorVisitPct < 70) {
    out.push(`زيارات الأطباء ${v.doctorVisits} من ${v.expectedDoctorVisits} متوقَّعة حتى اليوم (${v.doctorVisitPct}%).`);
  }
  if (v.zeroDays > 0) {
    out.push(`${v.zeroDays} يوم عمل بلا أي زيارة مسجَّلة${v.zeroDayList.length ? ` (أيام: ${v.zeroDayList.slice(0, 6).join('، ')})` : ''}.`);
  }

  if (c.doctorCoveragePct !== null && c.doctorCoveragePct < eff.doctorCoverageTargetPct) {
    out.push(`تغطية الأطباء ${c.doctorCoveragePct}% (${c.visitedDoctors} من ${c.totalDoctors}) والمطلوب ${eff.doctorCoverageTargetPct}%.`);
  }
  if (c.areasWithNoVisits.length) {
    out.push(`${c.areasWithNoVisits.length} منطقة بلا أي زيارة هذا الشهر: ${c.areasWithNoVisits.slice(0, 3).join('، ')}${c.areasWithNoVisits.length > 3 ? ' …' : ''}`);
  }

  if (g.growthPct !== null) {
    if (g.growthPct < 0) out.push(`المبيع أقل من الشهر الماضي بـ ${Math.abs(g.growthPct)}%.`);
    else if (g.growthPct >= eff.growthTargetPct) out.push(`نمو ${g.growthPct}% عن الشهر الماضي — فوق المطلوب (${eff.growthTargetPct}%).`);
  }

  if (d.hasData && d.adherencePct !== null && d.adherencePct < 70) {
    out.push(`التزام البلان ${d.adherencePct}% (${d.visited} من ${d.planned} مدخلاً)${d.autoPostponed ? `، منها ${d.autoPostponed} أُجِّل تلقائياً بلا إجراء` : ''}.`);
  }

  return out.slice(0, 6);
}

// ── التخزين والقراءة ────────────────────────────────────────────────────────

async function persistSnapshots(ownerUserId, periodKey, cards, fileScope) {
  const scopeJson = JSON.stringify(fileScope);
  for (const card of cards) {
    const data = {
      ownerUserId,
      repUserId: card.repUserId,
      scientificRepId: card.scientificRepId,
      repName: card.repName,
      companyId: card.company?.id ?? null,
      companyName: card.company?.name ?? null,
      periodType: 'month',
      periodKey,
      score: card.score,
      status: card.status,
      metrics: JSON.stringify({ components: card.components, ...(card.metrics ?? {}) }),
      reasons: JSON.stringify(card.reasons),
      fileScope: scopeJson,
      computedAt: new Date(),
    };
    await prisma.repScorecardSnapshot.upsert({
      where: { ownerUserId_repUserId_periodType_periodKey: { ownerUserId, repUserId: card.repUserId, periodType: 'month', periodKey } },
      create: data,
      update: data,
    });
  }
}

/** اللقطات المحفوظة — هذا ما تقرأه الصفحة، فلا تحسب شيئاً عند كل فتح. */
export async function getSnapshots(ownerUserId, periodKey) {
  const rows = await prisma.repScorecardSnapshot.findMany({
    where: { ownerUserId, periodType: 'month', periodKey },
    orderBy: { score: 'desc' },
  });
  return rows.map(hydrateSnapshot);
}

export async function getSnapshotForRep(ownerUserId, repUserId, periodKey) {
  const row = await prisma.repScorecardSnapshot.findUnique({
    where: { ownerUserId_repUserId_periodType_periodKey: { ownerUserId, repUserId, periodType: 'month', periodKey } },
  });
  return row ? hydrateSnapshot(row) : null;
}

function hydrateSnapshot(row) {
  const parsed = safeJson(row.metrics, {});
  const { components = {}, ...metrics } = parsed;
  return {
    repUserId: row.repUserId,
    scientificRepId: row.scientificRepId,
    repName: row.repName,
    company: row.companyId ? { id: row.companyId, name: row.companyName } : null,
    score: row.score,
    status: row.status,
    components,
    metrics: Object.keys(metrics).length ? metrics : null,
    reasons: safeJson(row.reasons, []),
    fileScope: safeJson(row.fileScope, null),
    computedAt: row.computedAt,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
