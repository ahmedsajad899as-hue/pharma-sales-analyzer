// ════════════════════════════════════════════════════════════════════════════
// rep-followup.scheduler.js — نبضة المتابعة.
//
// ثلاث مهام يومية لكل مدير فعّل الميزة:
//   • إعادة حساب اللقطات ليلاً (٠٣:٠٠ بغداد) — فتفتح الصفحة صباحاً جاهزة بلا
//     انتظار. الحساب ثقيل (getReport لكل مندوب مرتين) فلا يجوز أن يقع على طلب
//     المستخدم في كل مرة.
//   • ملخّص المندوب في ساعته.
//   • ملخّص المدير في ساعته.
//
// بلا مكتبة cron عمداً — نفس نمط pharmacy-alerts.scheduler: نبضة كل دقيقة تسأل
// «هل حان وقت أحد؟»، والسيرفر نسخة واحدة على PM2 فلا خطر تشغيل مزدوج. الحارس
// ضد التكرار مزدوج: lastRepRunAt/lastManagerRunAt + RepFollowupDigestLog.
//
// بوابة مقصودة: تُعالَج فقط حسابات لها صفّ RepFollowupStandard محفوظ. مدير لم
// يفتح شاشة المعايير قطّ لا يُحسب له شيء — وإلا لحسبنا ليلاً لكل حساب في
// قاعدة البيانات على خادم ذاكرته ~١ غيغا.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import { computeScorecards, baghdadNow, baghdadDayKey } from './rep-followup.service.js';
import {
  formatRepDigest, formatManagerDigest, deliverDigest,
  countOverdueDoctors, findIdleAreas,
} from './rep-followup.digest.js';

const TICK_MS = 60 * 1000;
const NIGHTLY_HOUR = 3; // بغداد

/**
 * هل أُغلق هذا المفتاح لهذا الحساب من شاشة «المميزات»؟
 * نفس عقد hasFeature في الواجهة: permissions.disabledFeatures مصفوفة مفاتيح،
 * والغياب = مُفعَّل. JSON تالف ⇒ نعتبرها مُفعَّلة (لا نُسكِت ميزة بسبب حقل معطوب).
 */
function isFeatureDisabled(permissionsJson, key) {
  try {
    const p = JSON.parse(permissionsJson || '{}');
    return Array.isArray(p.disabledFeatures) && p.disabledFeatures.includes(key);
  } catch { return false; }
}

/** هل حان وقت هذه الساعة اليوم ولم يُنفَّذ بعد؟ */
export function isDueAtHour(hour, lastRunAt, now = new Date()) {
  const b = baghdadNow(now);
  if (b.getUTCHours() !== hour) return false;
  if (lastRunAt) {
    const last = baghdadNow(new Date(lastRunAt));
    if (last.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)) return false;
  }
  return true;
}

/** هل نُفِّذت مهمة بهذا الاسم لهذا الحساب اليوم؟ (حارس الحساب الليلي) */
async function alreadyRanToday(ownerUserId, kind) {
  const row = await prisma.repFollowupDigestLog.findUnique({
    where: { recipientId_kind_dayKey: { recipientId: ownerUserId, kind, dayKey: baghdadDayKey() } },
  });
  return Boolean(row);
}

async function markRan(ownerUserId, kind, lineCount = 0) {
  await prisma.repFollowupDigestLog.create({
    data: { ownerUserId, recipientId: ownerUserId, kind, dayKey: baghdadDayKey(), channels: '', lineCount },
  }).catch(() => { /* تزامن نادر: صفّ كُتب بين الفحص والكتابة — لا يستحق إسقاط النبضة */ });
}

/**
 * يحسب لقطات فريق مدير واحد. يعيد null إن تعذّر (حساب معطّل/محذوف).
 * @param {number} ownerUserId
 */
async function computeForOwner(ownerUserId) {
  const owner = await prisma.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true, role: true, isActive: true, permissions: true },
  });
  if (!owner || !owner.isActive) return null;

  // ميزة مُغلقة من شاشة «المميزات» عند الأدمن ⇒ لا حساب ولا رسائل. بدون هذا
  // الفحص كانت الصفحة تختفي من حساب المدير بينما تستمر رسائل الملخّص بالوصول
  // إليه وإلى مندوبيه — تعطيل بنصف مفعول يُربك أكثر مما ينظّم.
  if (isFeatureDisabled(owner.permissions, 'rep_followup')) return null;

  const b = baghdadNow();
  return computeScorecards(owner, {
    month: b.getUTCMonth() + 1,
    year: b.getUTCFullYear(),
    persist: true,
  });
}

/** ملخّص كل مندوب في فريق هذا المدير. */
async function runRepDigests(settings, computed) {
  const { standards, reps } = computed;
  let sent = 0;
  for (const card of reps) {
    if (!card.metrics || card.status === 'error') continue;
    // المندوب بلا حساب دخول لا مكان يُرسَل إليه.
    if (!card.repUserId) continue;
    try {
      const [overdueDoctors, idleAreas] = await Promise.all([
        countOverdueDoctors(card, standards.doctorRevisitDays),
        findIdleAreas(card, standards.areaIdleDays),
      ]);
      const msg = formatRepDigest(card, standards, { overdueDoctors, idleAreas });
      if (!msg) continue; // لا شيء يستحق رسالة — صمت مقصود لا رسالة فارغة
      const res = await deliverDigest({
        ownerUserId: settings.ownerUserId,
        recipientId: card.repUserId,
        kind: 'rep',
        title: msg.title,
        body: msg.body,
        lineCount: msg.lineCount,
        channels: settings.digestChannels,
      });
      if (res.sent) sent++;
    } catch (e) {
      console.error('[rep-followup] فشل ملخّص %s: %s', card.repName, e?.message);
    }
  }
  await prisma.repFollowupStandard.update({
    where: { ownerUserId: settings.ownerUserId },
    data: { lastRepRunAt: new Date() },
  });
  return sent;
}

async function runManagerDigest(settings, computed) {
  const b = baghdadNow();
  const msg = formatManagerDigest(computed.reps, computed.standards, { dayOfMonth: b.getUTCDate() });
  let sent = 0;
  if (msg) {
    const res = await deliverDigest({
      ownerUserId: settings.ownerUserId,
      recipientId: settings.ownerUserId,
      kind: 'manager',
      title: msg.title,
      body: msg.body,
      lineCount: msg.lineCount,
      channels: settings.digestChannels,
    });
    if (res.sent) sent = 1;
  }
  await prisma.repFollowupStandard.update({
    where: { ownerUserId: settings.ownerUserId },
    data: { lastManagerRunAt: new Date() },
  });
  return sent;
}

/** فحص كل الحسابات المؤهَّلة — قابل للاستدعاء يدوياً للاختبار. */
export async function checkAndRunDueFollowup(now = new Date()) {
  const all = await prisma.repFollowupStandard.findMany();
  const results = [];

  for (const s of all) {
    const needsNightly = isDueAtHour(NIGHTLY_HOUR, null, now) && !(await alreadyRanToday(s.ownerUserId, 'nightly'));
    const needsRep = s.digestEnabled && isDueAtHour(s.digestRepHour, s.lastRepRunAt, now);
    const needsManager = s.digestEnabled && isDueAtHour(s.digestManagerHour, s.lastManagerRunAt, now);
    if (!needsNightly && !needsRep && !needsManager) continue;

    try {
      // حساب واحد يخدم المهام الثلاث إن تصادفت في نفس الساعة.
      const computed = await computeForOwner(s.ownerUserId);
      if (!computed) continue;

      const out = { ownerUserId: s.ownerUserId, reps: computed.reps.length };
      if (needsNightly) { await markRan(s.ownerUserId, 'nightly', computed.reps.length); out.nightly = true; }
      if (needsRep) out.repDigests = await runRepDigests(s, computed);
      if (needsManager) out.managerDigest = await runManagerDigest(s, computed);
      results.push(out);
    } catch (e) {
      console.error('[rep-followup] فشل حساب/إرسال المدير %d: %s', s.ownerUserId, e?.message);
    }
  }
  return results;
}

let timer = null;
export function startRepFollowupScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    checkAndRunDueFollowup()
      .then(r => { if (r.length) console.log('[rep-followup] نُفِّذ:', JSON.stringify(r)); })
      .catch(e => console.error('[rep-followup] tick failed:', e?.message));
  }, TICK_MS);
  timer.unref?.();
  console.log('✓ مُجدوِل متابعة المندوبين يعمل');
}
