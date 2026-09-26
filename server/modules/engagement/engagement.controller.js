import prisma from '../../lib/prisma.js';
import { logActivity } from '../../lib/activityLogger.js';

const PING_TYPES = new Set(['app_open', 'page_view', 'heartbeat']);
// سقف دفاعي على الخادم لثواني كل نبضة — يطابق MAX_TICK_SECONDS في
// src/hooks/useEngagementHeartbeat.ts، ويحمي من نبضة مزوَّرة/معطوبة بقيمة ضخمة.
const MAX_HEARTBEAT_SECONDS = 90;
const OFFICE_ENGAGEMENT_ROLES = ['company_manager', 'office_hr', 'office_employee'];

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// ── POST /api/engagement/ping ───────────────────────────────────
// Lightweight explicit signal from the frontend: real "app opened" / "page
// visited" events. ActivityLog's global middleware only logs write requests,
// so these would otherwise never be recorded.
export async function pingActivity(req, res) {
  const { type, page, seconds } = req.body || {};
  if (!PING_TYPES.has(type)) return res.status(400).json({ error: 'نوع غير صالح' });

  let details = null;
  if (type === 'heartbeat') {
    const clamped = Math.max(1, Math.min(Number(seconds) || 0, MAX_HEARTBEAT_SECONDS));
    details = String(clamped);
  }

  req._skipActivity = true; // avoid a duplicate generic "POST /api/engagement/ping" row
  await logActivity({ userId: req.user.id, action: type, module: page || 'app', details, req });
  res.json({ success: true });
}

function scoreUser({ lastActiveAt, activeDaysLast7, distinctFeaturesLast30, interactionsLast30 }) {
  if (!lastActiveAt) return { score: 0, status: 'never' };

  const daysSince = Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / DAY_MS);
  const recency =
    daysSince <= 0 ? 40 : daysSince === 1 ? 32 : daysSince <= 3 ? 22 : daysSince <= 7 ? 10 : 0;
  const frequency = Math.min(activeDaysLast7 / 7, 1) * 35;
  const breadth = Math.min(distinctFeaturesLast30 / 8, 1) * 15 + Math.min(interactionsLast30 / 20, 1) * 10;

  const score = Math.round(recency + frequency + breadth);
  const status = score >= 70 ? 'very_active' : score >= 40 ? 'moderate' : score >= 15 ? 'low' : 'inactive';
  return { score, status };
}

// ── GET /api/engagement/team ─────────────────────────────────────
// office_manager only: engagement snapshot of company_manager/office_hr/
// office_employee accounts sharing their officeId.
export async function getTeamEngagement(req, res) {
  const viewer = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { officeId: true, role: true },
  });
  if (viewer?.role !== 'office_manager') {
    return res.status(403).json({ error: 'هذه الصفحة متاحة لمدير المكتب فقط.' });
  }

  const members = await prisma.user.findMany({
    where: {
      officeId: viewer.officeId,
      role: { in: OFFICE_ENGAGEMENT_ROLES },
      id: { not: req.user.id },
    },
    select: { id: true, username: true, displayName: true, role: true, isActive: true },
    orderBy: { username: 'asc' },
  });

  const cutoff30 = new Date(Date.now() - 30 * DAY_MS);
  const memberIds = members.map(m => m.id);
  const logs = memberIds.length
    ? await prisma.activityLog.findMany({
        where: { userId: { in: memberIds }, createdAt: { gte: cutoff30 } },
        select: { userId: true, action: true, module: true, details: true, createdAt: true },
      })
    : [];

  const logsByUser = new Map(memberIds.map(id => [id, []]));
  for (const log of logs) logsByUser.get(log.userId)?.push(log);

  const todayKey = dayKey(new Date());
  const last7Cutoff = dayKey(new Date(Date.now() - 6 * DAY_MS));
  const last14Days = Array.from({ length: 14 }, (_, i) => dayKey(new Date(Date.now() - (13 - i) * DAY_MS)));

  const data = members.map(member => {
    const userLogs = logsByUser.get(member.id) ?? [];

    let lastActiveAt = null;
    let opensToday = 0;
    let secondsToday = 0;
    let secondsLast7 = 0;
    const activeDaySet7 = new Set();
    const activeDaySet30 = new Set();
    const featureCounts = {};
    let interactionsLast30 = 0;
    const dayBuckets = new Map(last14Days.map(d => [d, { opens: 0, events: 0, seconds: 0 }]));

    for (const log of userLogs) {
      const ts = log.createdAt;
      if (!lastActiveAt || ts > lastActiveAt) lastActiveAt = ts;

      const key = dayKey(ts);
      activeDaySet30.add(key);
      if (key >= last7Cutoff) activeDaySet7.add(key);
      if (key === todayKey && log.action === 'app_open') opensToday++;

      const heartbeatSeconds = log.action === 'heartbeat' ? (parseInt(log.details, 10) || 0) : 0;
      if (heartbeatSeconds) {
        if (key === todayKey) secondsToday += heartbeatSeconds;
        if (key >= last7Cutoff) secondsLast7 += heartbeatSeconds;
      }

      const bucket = dayBuckets.get(key);
      if (bucket) {
        bucket.events++;
        if (log.action === 'app_open') bucket.opens++;
        bucket.seconds += heartbeatSeconds;
      }

      const isWriteAction = /^(POST|PUT|PATCH|DELETE)\s/.test(log.action);
      if (log.action === 'page_view' || isWriteAction) {
        const feat = log.module || 'other';
        featureCounts[feat] = (featureCounts[feat] ?? 0) + 1;
      }
      if (isWriteAction) interactionsLast30++;
    }

    const distinctFeaturesLast30 = Object.keys(featureCounts).length;
    const topFeatures = Object.entries(featureCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([module, count]) => ({ module, count }));

    const { score, status } = scoreUser({
      lastActiveAt,
      activeDaysLast7: activeDaySet7.size,
      distinctFeaturesLast30,
      interactionsLast30,
    });

    const minutesToday = Math.round(secondsToday / 60);
    const minutesLast7 = Math.round(secondsLast7 / 60);

    return {
      id: member.id,
      username: member.username,
      displayName: member.displayName,
      role: member.role,
      isActive: member.isActive,
      lastActiveAt,
      opensToday,
      minutesToday,
      minutesLast7,
      avgMinutesPerActiveDay7: activeDaySet7.size ? Math.round(minutesLast7 / activeDaySet7.size) : 0,
      activeDaysLast7: activeDaySet7.size,
      activeDaysLast30: activeDaySet30.size,
      distinctFeaturesLast30,
      interactionsLast30,
      topFeatures,
      dailySeries: last14Days.map(d => {
        const b = dayBuckets.get(d);
        return { date: d, opens: b.opens, events: b.events, minutes: Math.round(b.seconds / 60) };
      }),
      score,
      status,
    };
  });

  data.sort((a, b) => a.score - b.score);

  const activeToday = data.filter(u => u.opensToday > 0).length;
  const avgScore = data.length ? Math.round(data.reduce((s, u) => s + u.score, 0) / data.length) : 0;
  const avgMinutesToday = data.length ? Math.round(data.reduce((s, u) => s + u.minutesToday, 0) / data.length) : 0;

  res.json({
    success: true,
    data,
    summary: { total: data.length, activeToday, avgScore, avgMinutesToday },
  });
}
