// ════════════════════════════════════════════════════════════════════════════
// dofied.sync.js — السحب اليومي من دوفايد إلى طابور مراجعة الزيارات.
//
// قرارات صاحب المشروع (2026-11-09): مرة يومياً، يدخل طابور المراجعة (لا حفظ مباشر)،
// وباسم الحساب الذي كان يرفع ملفات دوفايد يدوياً (يُختار من صفحة الماستر أدمن).
//
//  • المدى = اليوم التالي لآخر يوم سُحب ← أمس (يوم مكتمل). اليوم الجاري لا يُسحب:
//    زيارات بعد السحب كانت ستضيع لأن اليوم يُحسب «مسحوباً».
//  • ملف سابق ينتظر المراجعة (PendingVisitsImport واحد لكل حساب) ⇒ لا سحب، والأيام
//    تتراكم للمرة القادمة. لا شيء يُستبدل قبل أن يراجعه المستخدم.
//  • التكرار بين الملفات يحسمه الحفظ نفسه (visitImportDedup) كما في الرفع اليدوي.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { encryptPassword, decryptPassword } from '../../lib/passwordCrypto.js';
import { extractVisitsFromExcel } from '../doctors/doctor-visits-import.js';
import { login, exportRange, SUSPICIOUS_CODES } from './dofied.client.js';

const TZ = 'Asia/Baghdad';
const FIRST_RUN_DAYS = 1; // أول سحب: أمس فقط — ما قبله رُفع يدوياً
const MAX_WINDOW_DAYS = 31;

/** تاريخ اليوم (YYYY-MM-DD) والساعة بتوقيت بغداد. */
export function baghdadNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** مدى السحب، أو null إن لم يكتمل يوم جديد بعد. نقيّ. */
export function syncWindow(lastSyncedDate, today) {
  const to = addDays(today, -1);
  let from = lastSyncedDate ? addDays(lastSyncedDate, 1) : addDays(today, -FIRST_RUN_DAYS);
  if (from > to) return null;
  const earliest = addDays(to, -(MAX_WINDOW_DAYS - 1));
  if (from < earliest) from = earliest; // انقطاع طويل: آخر شهر فقط، والأقدم يُرفع يدوياً
  return { from, to };
}

export async function getConfig() {
  return prisma.dofiedSync.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

/** الإعداد للواجهة — بلا كلمة السر. */
export async function publicConfig() {
  const c = await getConfig();
  const user = c.userId
    ? await prisma.user.findUnique({ where: { id: c.userId }, select: { id: true, username: true, displayName: true, isActive: true } })
    : null;
  const pending = c.userId ? await prisma.pendingVisitsImport.findUnique({ where: { userId: c.userId }, select: { fileName: true, createdAt: true } }) : null;
  const { passwordEnc, ...rest } = c;
  return { ...rest, hasPassword: Boolean(passwordEnc), user, pending, nextWindow: syncWindow(c.lastSyncedDate, baghdadNow().date) };
}

export async function saveConfig({ username, password, userId, enabled, runHour, lastSyncedDate, notifyChatId }) {
  await getConfig();
  const data = {};
  if (notifyChatId !== undefined) data.notifyChatId = String(notifyChatId || '').replace(/[^\d-]/g, '') || null;
  if (username !== undefined) data.username = String(username || '').trim() || null;
  if (password) data.passwordEnc = encryptPassword(String(password));
  if (userId !== undefined) data.userId = Number(userId) || null;
  if (enabled !== undefined) data.enabled = Boolean(enabled);
  if (runHour !== undefined) {
    const h = Number(runHour);
    if (Number.isInteger(h) && h >= 0 && h <= 23) data.runHour = h;
  }
  if (lastSyncedDate !== undefined) {
    data.lastSyncedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(lastSyncedDate || '')) ? lastSyncedDate : null;
  }
  await prisma.dofiedSync.update({ where: { id: 1 }, data });
  return publicConfig();
}

const record = (status, message) => prisma.dofiedSync.update({
  where: { id: 1 }, data: { lastRunAt: new Date(), lastStatus: status, lastMessage: String(message).slice(0, 500) },
}).catch(e => console.error('[dofied] تعذّر حفظ الحالة:', e?.message));

// ─── التنبيه على تلكرام ──────────────────────────────────────────────────────
// استيراد كسول: وحدة تلكرام كبيرة وتستورد مسارات الطلبيات، ولا داعي لربطها هنا عند التحميل.
async function sendAlert(chatId, text) {
  if (!chatId) return { ok: false, error: 'لم يُضبط رقم محادثة التنبيه' };
  try {
    const { sendTextToChat } = await import('../telegram/telegram.service.js');
    return await sendTextToChat(chatId, text);
  } catch (e) {
    console.error('[dofied] تعذّر إرسال التنبيه:', e?.message);
    return { ok: false, error: e?.message };
  }
}

/** نص التنبيه. نقيّ. */
export function alertText({ message, suspicious, paused }) {
  return [
    suspicious ? '🚨 ربط دوفايد: علامة اكتشاف محتملة' : '⚠️ ربط دوفايد: فشل السحب اليومي',
    '',
    `السبب: ${message}`,
    ...(suspicious ? ['', 'رفض الدخول أو الحجب قد يعني أن دوفايد لاحظ الربط، أو أن كلمة السر تغيّرت، أو أن الحساب أُوقف.'] : []),
    ...(paused ? ['', '⏸️ أوقفتُ السحب التلقائي احتياطياً كي لا تتكرّر المحاولات.'] : []),
    '',
    'المراجعة والتشغيل: لوحة الماستر أدمن ← ربط دوفايد.',
  ].join('\n');
}

export async function sendTestAlert() {
  const c = await getConfig();
  return sendAlert(c.notifyChatId, '✅ تنبيه تجريبي من ربط دوفايد — ستصلك هنا رسالة إن فشل السحب اليومي أو ظهرت علامة اكتشاف.');
}

/** اختبار الاتصال: تسجيل دخول فقط. */
export async function testConnection() {
  const c = await getConfig();
  await login(c.username, decryptPassword(c.passwordEnc));
  return { ok: true };
}

let running = false;

/** سحب واحد. @returns {{status, message}} */
export async function runSync({ trigger = 'schedule' } = {}) {
  if (running) return { status: 'busy', message: 'سحب آخر يعمل الآن' };
  running = true;
  try {
    const c = await getConfig();
    if (!c.userId) return finish('error', 'لم يُختر الحساب الذي يستلم الملف');
    const user = await prisma.user.findUnique({ where: { id: c.userId } });
    if (!user?.isActive) return finish('error', 'الحساب المستلِم غير موجود أو معطّل');

    const win = syncWindow(c.lastSyncedDate, baghdadNow().date);
    if (!win) return finish('ok', 'لا يوجد يوم مكتمل جديد للسحب');

    const pending = await prisma.pendingVisitsImport.findUnique({ where: { userId: user.id }, select: { fileName: true } });
    if (pending) return finish('waiting', `ملف «${pending.fileName}» ما زال بانتظار المراجعة — يُسحب ${win.from} ← ${win.to} بعد مراجعته`);

    const jar = await login(c.username, decryptPassword(c.passwordEnc));
    const { buffer, taskRows } = await exportRange(jar, win.from, win.to);
    const fileName = `دوفايد ${win.from}${win.from === win.to ? '' : ` إلى ${win.to}`}.xlsx`;
    if (!taskRows) {
      await prisma.dofiedSync.update({ where: { id: 1 }, data: { lastSyncedDate: win.to } });
      return finish('ok', `لا زيارات في دوفايد بين ${win.from} و${win.to}`);
    }

    const tmpPath = path.join(os.tmpdir(), `dofied_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.xlsx`);
    fs.writeFileSync(tmpPath, buffer);
    // extractVisitsFromExcel يحذف الملف المؤقت بنفسه بعد القراءة.
    const data = await extractVisitsFromExcel({ path: tmpPath, originalname: fileName }, user);
    const docs = data.doctorRows?.length || 0;
    const pharms = data.pharmacyRows?.length || 0;
    if (!docs && !pharms) {
      await prisma.dofiedSync.update({ where: { id: 1 }, data: { lastSyncedDate: win.to } });
      return finish('ok', `سُحب ${taskRows} سجل من دوفايد لكن لم يُستخرج أي صف صالح (${win.from} ← ${win.to})`);
    }
    // التسجيل والتقدّم معاً: فشل أحدهما لا يترك ملفاً بلا تقدّم أو تقدّماً بلا ملف.
    await prisma.$transaction([
      prisma.pendingVisitsImport.create({ data: { userId: user.id, fileName, payload: data } }),
      prisma.dofiedSync.update({ where: { id: 1 }, data: { lastSyncedDate: win.to } }),
    ]);
    return finish('ok', `«${fileName}»: ${docs} طبيب و${pharms} صيدلية بانتظار مراجعة ${user.displayName?.trim() || user.username}`);
  } catch (e) {
    console.error(`[dofied] فشل السحب (${trigger}):`, e?.message);
    return finish('error', e?.code ? e.message : `خطأ غير متوقّع: ${String(e?.message || e).slice(0, 200)}`, e?.code);
  } finally {
    running = false;
  }

  async function finish(status, message, code = null) {
    const before = await getConfig().catch(() => null);
    await record(status, message);
    if (status !== 'ok' || trigger !== 'schedule') console.log(`[dofied] ${status}: ${message}`);
    const suspicious = status === 'error' && SUSPICIOUS_CODES.has(code);
    // علامة اكتشاف من السحب التلقائي ⇒ إيقاف احتياطي: محاولة دخول مرفوضة كل يوم تزيد الانتباه.
    const paused = suspicious && trigger === 'schedule' && before?.enabled;
    if (paused) await prisma.dofiedSync.update({ where: { id: 1 }, data: { enabled: false } }).catch(() => {});
    // التنبيه للتلقائي (لا أحد ينظر للصفحة ليلاً)، ولعلامة الاكتشاف من أي تشغيل.
    if (status === 'error' && (trigger === 'schedule' || suspicious)) {
      await sendAlert(before?.notifyChatId, alertText({ message, suspicious, paused }));
    } else if (status === 'ok' && trigger === 'schedule' && before?.lastStatus === 'error') {
      await sendAlert(before?.notifyChatId, `✅ ربط دوفايد عاد يعمل: ${message}`);
    }
    return { status, message, suspicious, paused };
  }
}

/** مؤقّت: يفحص كل 10 دقائق، ويسحب مرة واحدة يومياً بعد الساعة المختارة. */
export function startDofiedScheduler() {
  const tick = async () => {
    try {
      const c = await getConfig();
      if (!c.enabled) return;
      const now = baghdadNow();
      if (now.hour < c.runHour) return;
      if (c.lastRunAt && baghdadNow(c.lastRunAt).date === now.date) return; // حاول اليوم مرة
      await runSync({ trigger: 'schedule' });
    } catch (e) {
      console.error('[dofied] مؤقّت:', e?.message);
    }
  };
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 60 * 1000).unref();
}
