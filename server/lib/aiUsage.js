// aiUsage.js — تسجيل استهلاك الذكاء الاصطناعي وتلخيصه. التسجيل fire-and-forget: فشله لا يجوز
// أن يُسقط نداءً حقيقياً.
import prisma from './prisma.js';

export function logAiUsage({ feature = 'other', model, ok, errorKind = null, promptTokens = 0, outputTokens = 0, durationMs = 0 }) {
  prisma.aiUsageLog.create({
    data: {
      feature: String(feature || 'other').slice(0, 60),
      model: String(model || '?').slice(0, 60),
      ok: Boolean(ok), errorKind,
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens,
      durationMs: Math.round(durationMs || 0),
    },
  }).catch(e => console.error('[aiUsage] تعذّر التسجيل:', e?.message));
}

// تجميع بتوقيت بغداد حتى لا ينقسم يوم المستخدم عند منتصف الليل UTC.
const TZ = 'Asia/Baghdad';

export async function getAiUsageSummary(days = 7) {
  const d = Math.min(Math.max(parseInt(days) || 7, 1), 90);
  const since = new Date(Date.now() - d * 86400_000);

  const [daily, byFeature, byModel, totals, today] = await Promise.all([
    prisma.$queryRaw`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE ok)::int AS ok,
             COALESCE(SUM("totalTokens"),0)::bigint AS tokens
      FROM ai_usage_logs WHERE "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`
      SELECT feature, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE ok)::int AS ok,
             COALESCE(SUM("promptTokens"),0)::bigint AS "promptTokens",
             COALESCE(SUM("outputTokens"),0)::bigint AS "outputTokens",
             COALESCE(SUM("totalTokens"),0)::bigint AS tokens,
             COALESCE(AVG("durationMs"),0)::int AS "avgMs"
      FROM ai_usage_logs WHERE "createdAt" >= ${since}
      GROUP BY feature ORDER BY calls DESC`,
    prisma.$queryRaw`
      SELECT model, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT ok)::int AS failed,
             COALESCE(SUM("totalTokens"),0)::bigint AS tokens
      FROM ai_usage_logs WHERE "createdAt" >= ${since}
      GROUP BY model ORDER BY calls DESC`,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE ok)::int AS ok,
             COUNT(*) FILTER (WHERE "errorKind" = '429')::int AS "rateLimited",
             COUNT(*) FILTER (WHERE "errorKind" = 'timeout')::int AS timeouts,
             COALESCE(SUM("promptTokens"),0)::bigint AS "promptTokens",
             COALESCE(SUM("outputTokens"),0)::bigint AS "outputTokens",
             COALESCE(SUM("totalTokens"),0)::bigint AS tokens
      FROM ai_usage_logs WHERE "createdAt" >= ${since}`,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS calls, COALESCE(SUM("totalTokens"),0)::bigint AS tokens
      FROM ai_usage_logs
      WHERE to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD')
          = to_char((now() AT TIME ZONE ${TZ}), 'YYYY-MM-DD')`,
  ]);

  // BigInt لا يُسلسَل إلى JSON
  const num = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
  return num({ days: d, totals: totals[0], today: today[0], daily, byFeature, byModel });
}
