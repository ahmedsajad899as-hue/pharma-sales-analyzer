/**
 * المُجدوِل: يرسل تنبيهات «صيدليات تأخرت عن الطلب» تلقائياً.
 *
 * بلا مكتبة cron خارجية عمداً: نبضة كل دقيقة تسأل «هل حان وقت أي مدير؟».
 * السيرفر نسخة واحدة على PM2، فلا خطر تشغيل مزدوج، و lastRunAt يمنع إعادة
 * الإرسال إذا أُعيد تشغيل السيرفر قرب موعد الإرسال.
 */

import prisma from '../../lib/prisma.js';
import { computePharmacyAlerts, alertKeyOf } from './pharmacy-alerts.service.js';
import { usersForAreaIds } from '../../lib/areaScope.js';

const TICK_MS = 60 * 1000;
// بغداد UTC+3 بلا توقيت صيفي — الخادم يعمل بـ UTC، فنُزيح يدوياً بدل الاعتماد
// على منطقة زمنية قد تختلف بين البيئات.
const BAGHDAD_OFFSET_MIN = 3 * 60;

function baghdadNow(d = new Date()) {
  return new Date(d.getTime() + BAGHDAD_OFFSET_MIN * 60000);
}

/** هل حان وقت الإرسال لهذه الإعدادات الآن؟ */
export function isDue(settings, now = new Date()) {
  if (!settings.enabled) return false;
  const b = baghdadNow(now);
  if (b.getUTCHours() !== settings.hour) return false;
  if (settings.frequency === 'weekly' && b.getUTCDay() !== settings.weekday) return false;

  // مرة واحدة في اليوم مهما تكرّرت النبضات أو أُعيد تشغيل السيرفر
  if (settings.lastRunAt) {
    const last = baghdadNow(new Date(settings.lastRunAt));
    if (last.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)) return false;
  }
  return true;
}

/**
 * يبني ويُرسل تنبيهات مدير واحد.
 * @returns {Promise<{ repNotifs: number, managerNotifs: number, alerts: number }>}
 */
export async function runAlertsForOwner(settings) {
  const ownerId = settings.userId;

  // ملفات Pharmacy Net الخاصة بهذا المدير — المُجدوِل بلا واجهة تختار الملفات،
  // فنأخذ كل ملفاته من هذا النوع.
  const files = await prisma.uploadedFile.findMany({
    where:  { userId: ownerId, fileType: 'pharmacy_net' },
    select: { id: true },
  });
  if (files.length === 0) return { repNotifs: 0, managerNotifs: 0, alerts: 0 };

  const alerts = await computePharmacyAlerts(ownerId, {
    fileIds: files.map(f => f.id).join(','),
    thresholdDays: settings.thresholdDays,
  });
  if (alerts.length === 0) return { repNotifs: 0, managerNotifs: 0, alerts: 0 };

  const cutoff = new Date(Date.now() - settings.cooldownDays * 86400000);

  // ── توجيه لكل مندوب حسب منطقة الصيدلية ──────────────────────────────────
  let repNotifs = 0;
  if (settings.notifyReps) {
    const areaIds = [...new Set(alerts.map(a => a.areaId).filter(Boolean))];
    const areaUsers = await usersForAreaIds(areaIds);

    const perUser = new Map(); // userId -> alerts[]
    for (const a of alerts) {
      if (!a.areaId) continue;
      for (const uid of areaUsers.get(a.areaId) ?? []) {
        if (uid === ownerId) continue; // المدير له ملخّصه المنفصل
        if (!perUser.has(uid)) perUser.set(uid, []);
        perUser.get(uid).push(a);
      }
    }

    for (const [uid, list] of perUser) {
      const fresh = await filterByCooldown(uid, list, cutoff);
      if (fresh.length === 0) continue;
      await sendSummary(uid, ownerId, fresh, settings, 'rep');
      await recordNotified(ownerId, uid, fresh);
      repNotifs++;
    }
  }

  // ── ملخّص المدير ────────────────────────────────────────────────────────
  let managerNotifs = 0;
  if (settings.notifyManager) {
    const fresh = await filterByCooldown(ownerId, alerts, cutoff);
    if (fresh.length > 0) {
      await sendSummary(ownerId, null, fresh, settings, 'manager');
      await recordNotified(ownerId, ownerId, fresh);
      managerNotifs = 1;
    }
  }

  await prisma.pharmacyAlertSettings.update({
    where: { userId: ownerId },
    data:  { lastRunAt: new Date() },
  });

  return { repNotifs, managerNotifs, alerts: alerts.length };
}

/** يستبعد ما نُبّه عليه لنفس المستلم خلال فترة الهدوء. */
async function filterByCooldown(recipientId, list, cutoff) {
  const keys = list.map(a => alertKeyOf(a.pharmaName, a.itemName));
  const recent = await prisma.pharmacyAlertLog.findMany({
    where:  { recipientId, alertKey: { in: keys }, notifiedAt: { gte: cutoff } },
    select: { alertKey: true },
  });
  const blocked = new Set(recent.map(r => r.alertKey));
  return list.filter(a => !blocked.has(alertKeyOf(a.pharmaName, a.itemName)));
}

async function recordNotified(ownerUserId, recipientId, list) {
  const now = new Date();
  for (const a of list) {
    const alertKey = alertKeyOf(a.pharmaName, a.itemName);
    // upsert لأن الصف قد يكون موجوداً من دورة أقدم تجاوزت فترة الهدوء
    await prisma.pharmacyAlertLog.upsert({
      where:  { recipientId_alertKey: { recipientId, alertKey } },
      update: { notifiedAt: now, ownerUserId },
      create: { recipientId, alertKey, ownerUserId, notifiedAt: now },
    });
  }
}

async function sendSummary(recipientId, fromUserId, list, settings, kind) {
  const top = list.slice(0, 8)
    .map(a => `• ${a.pharmaName} — ${a.itemName} (${a.daysSinceLast} يوم)`)
    .join('\n');
  const more = list.length > 8 ? `\n… و${list.length - 8} صيدلية أخرى` : '';

  const title = kind === 'manager'
    ? `🔔 ${list.length} صيدلية تجاوزت ${settings.thresholdDays} يوماً بلا طلبية`
    : `🔔 ${list.length} صيدلية في مناطقك تحتاج متابعة`;

  await prisma.appNotification.create({
    data: {
      userId: recipientId,
      fromUserId: fromUserId ?? null,
      type: 'pharmacy_overdue',
      title,
      body: `${top}${more}`,
      data: JSON.stringify({
        thresholdDays: settings.thresholdDays,
        count: list.length,
        items: list.slice(0, 50).map(a => ({
          pharmacy: a.pharmaName, item: a.itemName,
          area: a.areaName, days: a.daysSinceLast, lastOrder: a.lastOrder,
        })),
      }),
    },
  });
}

/** فحص كل المديرين المفعّلين — يُستدعى من النبضة، وقابل للاستدعاء يدوياً للاختبار. */
export async function checkAndRunDueAlerts(now = new Date()) {
  const all = await prisma.pharmacyAlertSettings.findMany({ where: { enabled: true } });
  const results = [];
  for (const s of all) {
    if (!isDue(s, now)) continue;
    try {
      results.push({ userId: s.userId, ...(await runAlertsForOwner(s)) });
    } catch (e) {
      console.error(`[pharmacy-alerts] فشل إرسال تنبيهات المستخدم ${s.userId}:`, e.message);
    }
  }
  return results;
}

let timer = null;
export function startPharmacyAlertScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    checkAndRunDueAlerts().then(r => {
      if (r.length) console.log('[pharmacy-alerts] أُرسلت تنبيهات:', JSON.stringify(r));
    }).catch(e => console.error('[pharmacy-alerts] tick failed:', e.message));
  }, TICK_MS);
  timer.unref?.();
  console.log('✓ مُجدوِل تنبيهات الصيدليات يعمل');
}
