// ════════════════════════════════════════════════════════════════════════════
// race.js — صفحة «التحفيز»: سباق التارگت + الشارات + منصّة التتويج.
//
// لا حساب مبيعات هنا: كل الأرقام من لقطات متابعة المندوبين (RepScorecardSnapshot)
// التي يحسبها rep-followup.service ليلاً أو بزر «احسب الآن». فتح الصفحة = قراءة
// صفوف جاهزة فقط — الخادم ذاكرته محدودة، وحساب getReport لكل مندوب عند كل فتح
// كان سيُثقله (راجع تعليق getScorecardsHandler).
//
// المدير يرى فريقه (getSnapshotsForViewer). المندوب يرى زملاء فريقه = كل لقطات
// نفس الحاسب (ownerUserId) للقطته هو — بلا قيم مالية، النسب والشارات فقط.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import * as svc from './rep-followup.service.js';

const isManager = (role) => svc.FOLLOWUP_MANAGER_ROLES.has(role);
const shiftMonth = (year, month, delta) => {
  const t = year * 12 + (month - 1) + delta;
  return { year: Math.floor(t / 12), month: (t % 12) + 1 };
};

/** لقطات فريق المشاهد لفترة. ownerHint: حاسب لقطات المندوب (يُعاد استعماله للأشهر السابقة). */
async function teamSnapshots(user, periodKey, ctx) {
  if (isManager(user.role)) return svc.getSnapshotsForViewer(user, periodKey);
  if (!ctx.ownerUserId) {
    const ownerIds = await svc.resolveSnapshotOwnerIds(user.id);
    const mine = await prisma.repScorecardSnapshot.findFirst({
      where: { ownerUserId: { in: ownerIds }, repUserId: user.id, periodType: 'month', periodKey },
      orderBy: { computedAt: 'desc' },
      select: { ownerUserId: true },
    });
    if (!mine) return [];
    ctx.ownerUserId = mine.ownerUserId;
  }
  return svc.getSnapshots(ctx.ownerUserId, periodKey);
}

const pctOf = (snap) => {
  const t = snap.metrics?.target;
  return t && t.total > 0 && t.achievementPct !== null ? t.achievementPct : null;
};

/** ترتيب السباق: أصحاب التارگت بالنسبة، ثم البقية بالمؤشّر العام. */
const raceOrder = (a, b) => {
  if ((a.achievementPct === null) !== (b.achievementPct === null)) return a.achievementPct === null ? 1 : -1;
  if (a.achievementPct !== null) return b.achievementPct - a.achievementPct;
  return b.score - a.score;
};

const podiumOf = (snaps) => snaps
  .filter(s => pctOf(s) !== null)
  .sort((a, b) => pctOf(b) - pctOf(a))
  .slice(0, 3)
  .map(s => ({ repUserId: s.repUserId, repName: s.repName, achievementPct: pctOf(s) }));

/** أطباء زارهم المندوب لأول مرة (أول زيارة له لهم تقع في هذا الشهر). */
async function newDoctorsCount(snap, start, end) {
  const repId = snap.scientificRepId ?? -1;
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS c FROM (
      SELECT "doctorId", MIN("visitDate") AS first
        FROM doctor_visits
       WHERE ("scientificRepId" = ${repId} OR "userId" = ${snap.repUserId}) AND "isActive" = true
       GROUP BY "doctorId"
    ) t
    WHERE t.first >= ${start} AND t.first < ${end}`;
  return rows[0]?.c ?? 0;
}

// ── GET /api/rep-followup/race?month=&year= ─────────────────────────────────
export async function getRaceHandler(req, res, next) {
  try {
    const b = svc.baghdadNow();
    const month = parseInt(req.query.month) || (b.getUTCMonth() + 1);
    const year = parseInt(req.query.year) || b.getUTCFullYear();
    const periodKey = svc.periodKeyOf(year, month);
    const isCurrentMonth = b.getUTCFullYear() === year && b.getUTCMonth() + 1 === month;

    const ctx = {};
    const cur = await teamSnapshots(req.user, periodKey, ctx);
    const p1 = shiftMonth(year, month, -1);
    const p2 = shiftMonth(year, month, -2);
    const [prev1, prev2] = await Promise.all([
      teamSnapshots(req.user, svc.periodKeyOf(p1.year, p1.month), ctx),
      teamSnapshots(req.user, svc.periodKeyOf(p2.year, p2.month), ctx),
    ]);
    const pctPrev1 = new Map(prev1.map(s => [s.repUserId, pctOf(s)]));
    const pctPrev2 = new Map(prev2.map(s => [s.repUserId, pctOf(s)]));

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    // متسلسل — استعلام خفيف لكل مندوب، والفريق عادةً عشرات لا مئات.
    const reps = [];
    for (const s of cur) {
      const m = s.metrics ?? {};
      reps.push({
        repUserId: s.repUserId,
        repName: s.repName,
        company: s.company?.name ?? null,
        score: s.score,
        status: s.status,
        achievementPct: pctOf(s),
        projectedPct: m.target?.total > 0 ? (m.target.projectedPct ?? null) : null,
        targetTotal: m.target?.total ?? 0,
        achieved: m.target?.achieved ?? 0,
        orderCount: m.sales?.orderCount ?? 0,
        growthPct: m.growth?.growthPct ?? null,
        doctorVisits: m.visits?.doctorVisits ?? 0,
        firstOrderAt: m.sales?.firstOrderAt ?? null,
        newDoctors: await newDoctorsCount(s, start, end).catch(() => 0),
        badges: [],
      });
    }

    // ── الشارات ────────────────────────────────────────────────────────────
    const award = (rep, key) => { if (rep && !rep.badges.includes(key)) rep.badges.push(key); };
    const topBy = (fn) => {
      let best = null, bestV = -Infinity;
      for (const r of reps) { const v = fn(r); if (v !== null && v !== undefined && v > bestV) { best = r; bestV = v; } }
      return best;
    };
    for (const r of reps) {
      if (r.achievementPct !== null && r.achievementPct >= 100) {
        award(r, 'target');
        if ((pctPrev1.get(r.repUserId) ?? 0) >= 100 && (pctPrev2.get(r.repUserId) ?? 0) >= 100) award(r, 'streak3');
      }
      if (r.newDoctors >= 10) award(r, 'newDoctors');
    }
    const firsts = reps.filter(r => r.firstOrderAt).sort((a, b) => new Date(a.firstOrderAt) - new Date(b.firstOrderAt));
    if (firsts.length) award(firsts[0], 'firstOrder');
    const grower = topBy(r => (r.growthPct !== null && r.growthPct > 0 ? r.growthPct : null));
    if (grower) award(grower, 'topGrowth');
    const visitor = topBy(r => (r.doctorVisits > 0 ? r.doctorVisits : null));
    if (visitor) award(visitor, 'topVisits');

    reps.sort(raceOrder);
    const progress = cur.find(s => s.metrics?.visits?.monthProgressPct != null)?.metrics.visits.monthProgressPct ?? (isCurrentMonth ? null : 100);

    res.json({
      success: true,
      periodKey, month, year, isCurrentMonth,
      monthProgressPct: progress,
      computedAt: cur.length ? cur.reduce((min, r) => (r.computedAt < min ? r.computedAt : min), cur[0].computedAt) : null,
      canRecompute: isManager(req.user.role),
      me: req.user.id,
      reps,
      podium: isCurrentMonth ? [] : podiumOf(cur),
      prevPodium: podiumOf(prev1),
      prevPeriodKey: svc.periodKeyOf(p1.year, p1.month),
    });
  } catch (e) { next(e); }
}
