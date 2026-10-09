// ════════════════════════════════════════════════════════════════════════════
// rep-followup.digest.js — «المدير الآلي»: يصوغ ملخّصاً يومياً واحداً ويُسلّمه.
//
// قواعد مكتوبة في الكود لأنها هي ما يفرّق بين تذكير مفيد وإشعار يُكتَم:
//
// • رسالة واحدة في اليوم لكل مستلم، لا رسالة لكل مشكلة. السقف maxLinesPerDigest
//   من معايير المكتب، والبنود مرتَّبة بالأهمية فيُقتطع الأقل أهمية لا الأهم.
// • كل سطر يحمل رقماً واسماً وإجراءً ممكناً اليوم. «أداؤك منخفض» ليست رسالة.
// • لا تكرار لما يرسله مُجدوِل تنبيهات الصيدليات (pharmacy-alerts.scheduler):
//   الصيدليات المتأخرة عن الطلب له وحده، وإلا وصل المندوب تنبيهان لنفس الشيء.
// • حارس ضد الإرسال المزدوج: RepFollowupDigestLog بمفتاح (مستلم، نوع، يوم بغداد)
//   — إعادة تشغيل الخادم قرب موعد الإرسال لا تُعيد الرسالة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { effectiveFor } from '../../lib/followupStandards.js';
import { baghdadDayKey } from './rep-followup.service.js';
import { sendTextToUser } from '../telegram/telegram.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_AR = {
  excellent: 'ممتاز', good: 'جيد', watch: 'يحتاج متابعة',
  behind: 'متأخر', no_data: 'بلا بيانات', error: 'خطأ بالحساب',
};

const fmtNum = (v) => Math.round(v || 0).toLocaleString('en-US');
const fmtUSD = (v) => `$${fmtNum(v)}`;

// ════════════════════════════════════════════════════════════════════════════
// ملخّص المندوب
// ════════════════════════════════════════════════════════════════════════════

/**
 * يبني أسطر ملخّص مندوب واحد مرتَّبة بالأهمية (الأهم أولاً).
 * @param {object} card لقطة المندوب من computeScorecards
 * @param {object} standards معايير المكتب
 * @param {{overdueDoctors:number|null, idleAreas:string[]}} extra إشارات تحتاج نافذة زمنية أطول من الشهر
 */
export function buildRepDigestLines(card, standards, extra = {}) {
  const m = card.metrics;
  if (!m) return [];
  const eff = effectiveFor(standards, null);
  const lines = [];

  // 1) التارجت أولاً — هو ما يُحاسَب عليه آخر الشهر.
  if (m.target.total > 0 && m.target.achievementPct !== null) {
    if (m.target.projectedPct !== null && m.target.projectedPct < eff.targetAchievementMinPct && m.target.gapQty > 0) {
      lines.push(`🎯 التارجت ${m.target.achievementPct}% ومرّ ${m.visits.monthProgressPct}% من الشهر — ناقصك ${fmtNum(m.target.gapQty)} وحدة` +
        (m.target.remainingWorkDays > 0 ? ` (${fmtNum(m.target.neededPerDay)} باليوم خلال ${m.target.remainingWorkDays} يوم عمل متبقي).` : '.'));
    } else if (m.target.achievementPct >= eff.targetAchievementMinPct) {
      lines.push(`✅ التارجت ${m.target.achievementPct}% — ماشي فوق المعيار، كمّل عليه.`);
    }
  }

  // 2) ايتمات بلا مبيع — أسرع فرصة لتقليل الفجوة.
  if (m.target.zeroSaleItems?.length) {
    const names = m.target.zeroSaleItems.slice(0, 3).map(i => i.itemName).join('، ');
    lines.push(`📦 ${m.target.zeroSaleItems.length} ايتم عليه تارجت وما باع ولا وحدة: ${names}${m.target.zeroSaleItems.length > 3 ? ' وغيرها' : ''}.`);
  }

  // 3) يوم ضائع أمس/اليوم — الإشارة الأكثر قابلية للتصحيح فوراً.
  if (m.visits.zeroDays > 0) {
    lines.push(`📅 ${m.visits.zeroDays} يوم عمل بلا أي زيارة مسجَّلة هذا الشهر` +
      (m.visits.zeroDayList?.length ? ` (أيام ${m.visits.zeroDayList.slice(0, 5).join('، ')}) — سجّلها إذا كانت منجزة.` : '.'));
  }

  // 4) الزيارات مقابل المتوقَّع حتى اليوم.
  if (m.visits.doctorVisitPct !== null && m.visits.doctorVisitPct < 85) {
    lines.push(`🏥 زيارات الأطباء ${m.visits.doctorVisits} من ${m.visits.expectedDoctorVisits} متوقَّعة حتى اليوم (${m.visits.doctorVisitPct}%).`);
  }

  // 5) أطباء تجاوزوا دورة الزيارة — يستعمل معيار doctorRevisitDays.
  if (extra.overdueDoctors != null && extra.overdueDoctors > 0) {
    lines.push(`🔁 ${extra.overdueDoctors} طبيب في مناطقك ما تمت زيارته منذ ${eff.doctorRevisitDays} يوماً أو أكثر.`);
  }

  // 6) مناطق مهجورة — يستعمل معيار areaIdleDays.
  if (extra.idleAreas?.length) {
    lines.push(`📍 ${extra.idleAreas.length} منطقة بلا أي زيارة منذ ${eff.areaIdleDays} يوماً: ${extra.idleAreas.slice(0, 3).join('، ')}${extra.idleAreas.length > 3 ? ' وغيرها' : ''}.`);
  }

  // 7) التغطية.
  if (m.coverage.doctorCoveragePct !== null && m.coverage.doctorCoveragePct < eff.doctorCoverageTargetPct) {
    lines.push(`🧭 تغطية الأطباء ${m.coverage.doctorCoveragePct}% (${m.coverage.visitedDoctors} من ${m.coverage.totalDoctors}) والمطلوب ${eff.doctorCoverageTargetPct}%.`);
  }

  // 8) البلان اليومي.
  if (m.discipline?.hasData && m.discipline.adherencePct !== null && m.discipline.adherencePct < 70) {
    lines.push(`📝 التزام البلان ${m.discipline.adherencePct}% — ${m.discipline.planned - m.discipline.visited} مدخلاً بلا تنفيذ.`);
  }

  // 9) إشارة إيجابية — نظام كل رسائله لوم يُكرَه ويُغلَق.
  if (m.growth.growthPct !== null && m.growth.growthPct > 0) {
    lines.push(`📈 مبيعك زاد ${m.growth.growthPct}% عن الشهر الماضي (${fmtUSD(m.sales.netValue)} مقابل ${fmtUSD(m.sales.prevNetValue)}).`);
  }

  return lines;
}

export function formatRepDigest(card, standards, extra) {
  const lines = buildRepDigestLines(card, standards, extra);
  if (!lines.length) return null;
  const eff = effectiveFor(standards, null);
  const head = `👋 ${card.repName} — متابعة اليوم (المؤشّر ${card.score}/100 · ${STATUS_AR[card.status] ?? card.status})`;
  const body = lines.slice(0, Math.max(1, eff.maxLinesPerDigest));
  const hidden = lines.length - body.length;
  const tail = hidden > 0 ? `\n… و${hidden} ملاحظة أخرى داخل التطبيق.` : '';
  return { title: head, body: body.join('\n') + tail, lineCount: body.length };
}

// ════════════════════════════════════════════════════════════════════════════
// ملخّص المدير
// ════════════════════════════════════════════════════════════════════════════

export function formatManagerDigest(cards, standards, { dayOfMonth } = {}) {
  const eff = effectiveFor(standards, null);
  const measurable = cards.filter(c => c.status !== 'no_data' && c.status !== 'error');
  if (!measurable.length) return null;

  const lines = [];

  const noVisitsToday = measurable.filter(c => dayOfMonth && (c.metrics?.visits?.zeroDayList ?? []).includes(dayOfMonth));
  if (noVisitsToday.length) {
    lines.push(`🚫 بلا أي زيارة مسجَّلة اليوم (${noVisitsToday.length}): ${noVisitsToday.slice(0, 6).map(c => c.repName).join('، ')}${noVisitsToday.length > 6 ? ' …' : ''}`);
  }

  const willMiss = measurable.filter(c => {
    const t = c.metrics?.target;
    return t && t.total > 0 && t.projectedPct !== null && t.projectedPct < eff.targetAchievementMinPct;
  }).sort((a, b) => (a.metrics.target.projectedPct) - (b.metrics.target.projectedPct));
  if (willMiss.length) {
    lines.push(`⚠️ لن يصل التارجت بالسرعة الحالية (${willMiss.length}): ` +
      willMiss.slice(0, 5).map(c => `${c.repName} ${c.metrics.target.achievementPct}%→${c.metrics.target.projectedPct}%`).join(' · '));
  }

  const idle = measurable.filter(c => (c.metrics?.coverage?.areasWithNoVisits ?? []).length > 0);
  if (idle.length) {
    lines.push(`📍 مناطق بلا زيارة هذا الشهر: ` +
      idle.slice(0, 5).map(c => `${c.repName} (${c.metrics.coverage.areasWithNoVisits.length})`).join(' · '));
  }

  const behind = measurable.filter(c => c.status === 'behind');
  if (behind.length) {
    lines.push(`🔻 الأدنى مؤشّراً: ${behind.slice(0, 5).map(c => `${c.repName} ${c.score}`).join(' · ')}`);
  }

  const best = measurable.filter(c => c.status === 'excellent');
  if (best.length) {
    lines.push(`🏅 الأعلى مؤشّراً: ${best.slice(0, 3).map(c => `${c.repName} ${c.score}`).join(' · ')}`);
  }

  const noData = cards.filter(c => c.status === 'no_data');
  if (noData.length) {
    lines.push(`❔ بلا بيانات قابلة للقياس (${noData.length}) — تارجت غير مُدخَل أو ملفات غير مفعّلة: ${noData.slice(0, 4).map(c => c.repName).join('، ')}`);
  }

  if (!lines.length) return null;
  const avg = Math.round(measurable.reduce((s, c) => s + c.score, 0) / measurable.length);
  return {
    title: `📊 متابعة الفريق — ${measurable.length} مندوباً، متوسط المؤشّر ${avg}/100`,
    body: lines.slice(0, Math.max(2, eff.maxLinesPerDigest)).join('\n'),
    lineCount: lines.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// إشارات تحتاج نافذة أطول من الشهر الحالي
// ════════════════════════════════════════════════════════════════════════════

/**
 * عدد الأطباء في مناطق المندوب الذين لم تُزَر منذ doctorRevisitDays.
 *
 * تقديري بطبيعته: المقام هو أطباء السيرفي في مناطقه (من اللقطة)، والمطروح هو
 * الأطباء المتمايزون الذين زارهم في النافذة — وقد يزور طبيباً خارج مناطقه فيُنقص
 * العدد قليلاً. المطلوب إشارة «عندك متأخرون» لا جرد محاسبي، فالتقدير كافٍ هنا
 * ولا يُستعمل في المؤشّر ولا في المحاسبة.
 */
export async function countOverdueDoctors(card, days) {
  const total = card.metrics?.coverage?.totalDoctors ?? 0;
  if (!total) return null;
  const or = [];
  if (card.scientificRepId) or.push({ scientificRepId: card.scientificRepId });
  if (card.repUserId) or.push({ userId: card.repUserId });
  if (!or.length) return null;

  const since = new Date(Date.now() - days * DAY_MS);
  const visits = await prisma.doctorVisit.findMany({
    where: { OR: or, isActive: true, visitDate: { gte: since } },
    select: { doctorId: true },
    distinct: ['doctorId'],
  });
  return Math.max(0, total - visits.length);
}

/** مناطق المندوب التي لا زيارة فيها (طبيب أو صيدلية) خلال areaIdleDays. */
export async function findIdleAreas(card, days) {
  const areas = (card.metrics?.coverage?.areas ?? []).map(a => a.areaName).filter(Boolean);
  if (!areas.length) return [];
  const or = [];
  if (card.scientificRepId) or.push({ scientificRepId: card.scientificRepId });
  if (card.repUserId) or.push({ userId: card.repUserId });
  if (!or.length) return [];

  const since = new Date(Date.now() - days * DAY_MS);
  const [docVisits, pharmVisits] = await Promise.all([
    prisma.doctorVisit.findMany({
      where: { OR: or, isActive: true, visitDate: { gte: since } },
      select: { doctor: { select: { area: { select: { name: true } }, masterSurveyDoctor: { select: { areaName: true } } } } },
    }),
    prisma.pharmacyVisit.findMany({
      where: { OR: or, isActive: true, visitDate: { gte: since } },
      select: { areaName: true, area: { select: { name: true } } },
    }),
  ]);

  const touched = new Set();
  for (const v of docVisits) {
    const n = v.doctor?.masterSurveyDoctor?.areaName || v.doctor?.area?.name;
    if (n) touched.add(normName(n));
  }
  for (const v of pharmVisits) {
    const n = v.area?.name || v.areaName;
    if (n) touched.add(normName(n));
  }
  return areas.filter(a => a !== 'بدون منطقة' && !touched.has(normName(a)));
}

// تطبيع خفيف لاسم المنطقة — نفس روح normalizeAreaName لكن بلا استيراد محرّك
// الايتمات كاملاً في مسار الملخّص.
function normName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

// ════════════════════════════════════════════════════════════════════════════
// التسليم
// ════════════════════════════════════════════════════════════════════════════

/**
 * يُسلّم ملخّصاً واحداً على القنوات المطلوبة ويسجّله. يرجع false إن كان قد أُرسل
 * اليوم (الحارس) أو لم تنجح أي قناة.
 */
export async function deliverDigest({ ownerUserId, recipientId, kind, title, body, lineCount, channels }) {
  const dayKey = baghdadDayKey();
  const already = await prisma.repFollowupDigestLog.findUnique({
    where: { recipientId_kind_dayKey: { recipientId, kind, dayKey } },
  });
  if (already) return { sent: false, reason: 'already-sent-today' };

  const wanted = String(channels || 'app').split(',').map(s => s.trim()).filter(Boolean);
  const done = [];

  if (wanted.includes('app')) {
    try {
      await prisma.appNotification.create({
        data: {
          userId: recipientId,
          fromUserId: kind === 'rep' ? ownerUserId : null,
          type: kind === 'rep' ? 'followup_rep_digest' : 'followup_manager_digest',
          title,
          body,
          data: JSON.stringify({ kind, dayKey, lineCount }),
        },
      });
      done.push('app');
    } catch (e) {
      console.error('[followup-digest] فشل إشعار التطبيق لـ %d: %s', recipientId, e.message);
    }
  }

  if (wanted.includes('telegram')) {
    try {
      const res = await sendTextToUser(recipientId, `${title}\n\n${body}`);
      if (res.sent > 0) done.push('telegram');
    } catch (e) {
      console.error('[followup-digest] فشل تلكرام لـ %d: %s', recipientId, e.message);
    }
  }

  if (!done.length) return { sent: false, reason: 'no-channel-succeeded' };

  await prisma.repFollowupDigestLog.create({
    data: { ownerUserId, recipientId, kind, dayKey, channels: done.join(','), lineCount },
  });
  return { sent: true, channels: done };
}
