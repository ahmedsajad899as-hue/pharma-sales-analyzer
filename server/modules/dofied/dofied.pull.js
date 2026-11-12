// ════════════════════════════════════════════════════════════════════════════
// dofied.pull.js — «استيراد الكولات من دوفايد» بضغطة زر في تحليل الكولات (2026-11-13).
//
// بخلاف السحب اليومي (dofied.sync.js، حساب واحد يختاره الماستر أدمن) هذا سحب عند
// الطلب لأي حساب مفعَّلة له الميزة visits_dofied_pull، ببيانات دخول دوفايد نفسها:
//  • المدى = آخر يوم فيه كولات لمندوبي الحساب ← اليوم. آخر يوم يُعاد سحبه عمداً:
//    ربما سُحب ناقصاً (منتصف النهار)، والمكرّر منه يُسقط قبل المراجعة.
//  • ملف المكتب كامل (كل الشركات) ⇒ يبقى منه مندوبو الحساب فقط — إلا أدوار المكتب
//    التي ترفع للمكتب كله.
//  • ما رُفع سابقاً (من هذا الحساب أو غيره لنفس المندوب) يُسقط قبل المراجعة
//    (dropAlreadyImportedRows)، والنتيجة تدخل PendingVisitsImport فتفتح نافذة
//    المراجعة نفسها — لا شيء يُحفظ قبل أن يراجعه المستخدم.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { decryptPassword } from '../../lib/passwordCrypto.js';
import { userFeatureOn } from '../../lib/userFeatures.js';
import { OFFICE_SCOPED_ROLES } from '../../lib/officeScope.js';
import { list as listScientificReps, normalizeRepName } from '../scientific-reps/scientific-reps.service.js';
import { extractVisitsFromExcel, pruneNameLists } from '../doctors/doctor-visits-import.js';
import { login, exportRange } from './dofied.client.js';
import { getConfig, baghdadNow, dofiedLock } from './dofied.sync.js';
import { visitDayKey } from '../../lib/visitImportDedup.js';

export const PULL_FEATURE = 'visits_dofied_pull';
const MAX_DAYS = 31;
const DEFAULT_BACK_DAYS = 7; // لا كولات سابقة إطلاقاً ⇒ آخر أسبوع
const COOLDOWN_MS = 2 * 60 * 1000; // كل دخول لدوفايد يظهر في سجلّاتهم — لا ضغطات متلاحقة

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** مدى السحب. نقيّ. lastDay = آخر يوم فيه كولات (YYYY-MM-DD) أو null. */
export function pullWindow(lastDay, today) {
  let from = lastDay && lastDay <= today ? lastDay : addDays(today, -(DEFAULT_BACK_DAYS - 1));
  const earliest = addDays(today, -(MAX_DAYS - 1));
  if (from < earliest) from = earliest;
  return { from, to: today };
}

const jobs = new Map(); // userId → حالة آخر سحب (ذاكرة فقط؛ إعادة تشغيل الخادم تنسى السحب الجاري)

async function scopeOf(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, role: true, permissions: true, isActive: true },
  });
  if (!user?.isActive) throw Object.assign(new Error('الحساب غير موجود أو معطّل'), { status: 403 });
  const reps = await listScientificReps({}, user, {});
  const repIds = [...new Set(reps.map(r => r.id).filter(Number.isInteger))];
  return { user, repIds, officeWide: OFFICE_SCOPED_ROLES.has(user.role) };
}

async function lastVisitDay(repIds) {
  if (!repIds.length) return null;
  const where = { scientificRepId: { in: repIds }, isActive: true };
  const [d, p] = await Promise.all([
    prisma.doctorVisit.aggregate({ where, _max: { visitDate: true } }),
    prisma.pharmacyVisit.aggregate({ where, _max: { visitDate: true } }),
  ]);
  const max = [d._max.visitDate, p._max.visitDate].filter(Boolean).sort((a, b) => b - a)[0];
  return max ? visitDayKey(max) : null;
}

/** ما يحتاجه الزر قبل الضغط: هل الميزة متاحة، والمدى المتوقع، وحالة آخر سحب. */
export async function pullInfo(userId) {
  const { user, repIds } = await scopeOf(userId);
  const enabled = userFeatureOn(user, PULL_FEATURE, { optIn: true });
  const cfg = await getConfig();
  const configured = Boolean(cfg.username && cfg.passwordEnc);
  const lastDay = enabled ? await lastVisitDay(repIds) : null;
  return {
    enabled, configured, lastDay,
    window: pullWindow(lastDay, baghdadNow().date),
    job: jobs.get(userId) ?? null,
  };
}

/** يبدأ السحب بالخلفية ويُرجع فوراً. النتيجة تُقرأ من pullStatus ثم من pending-import. */
export async function startPull(userId) {
  const cur = jobs.get(userId);
  if (cur?.state === 'running') return cur;
  if (cur?.finishedAt && Date.now() - cur.finishedAt < COOLDOWN_MS && cur.state !== 'error') {
    throw Object.assign(new Error('سُحب للتوّ — انتظر دقيقتين قبل سحب جديد'), { status: 429 });
  }
  const { user, repIds, officeWide } = await scopeOf(userId);
  if (!userFeatureOn(user, PULL_FEATURE, { optIn: true })) {
    throw Object.assign(new Error('هذه الميزة غير مفعّلة لحسابك'), { status: 403 });
  }
  const cfg = await getConfig();
  if (!cfg.username || !cfg.passwordEnc) {
    throw Object.assign(new Error('ربط دوفايد غير مُعدّ بعد — تواصل مع الإدارة'), { status: 400 });
  }
  const pending = await prisma.pendingVisitsImport.findUnique({ where: { userId }, select: { fileName: true } });
  if (pending) {
    throw Object.assign(new Error(`لديك ملف «${pending.fileName}» بانتظار المراجعة — أكمله أو ألغِه أولاً`), { status: 409 });
  }
  if (!officeWide && !repIds.length) {
    throw Object.assign(new Error('لا مندوبين مرتبطين بحسابك لسحب كولاتهم'), { status: 400 });
  }

  const lastDay = await lastVisitDay(repIds);
  const win = pullWindow(lastDay, baghdadNow().date);
  const job = { state: 'running', from: win.from, to: win.to, lastDay, startedAt: Date.now(), message: 'جارِ الاتصال بدوفايد…' };
  jobs.set(userId, job);

  runPull(job, { user, repIds, officeWide, cfg }).catch(e => {
    console.error(`[dofied-pull] user ${userId}:`, e?.message);
    Object.assign(job, { state: 'error', message: e?.code ? e.message : `تعذّر السحب: ${String(e?.message || e).slice(0, 200)}`, finishedAt: Date.now() });
  });
  return job;
}

export function pullStatus(userId) {
  return jobs.get(userId) ?? null;
}

/**
 * يُبقي صفوف مندوبي الحساب فقط: مندوب محسوم ضمن نطاقه، أو اسم غير محسوم يشبه
 * أحد مندوبيه (pending). الباقي مندوبو شركات أخرى في نفس حساب دوفايد. نقيّ.
 */
export function keepOwnReps(data, repIds) {
  const own = new Set(repIds);
  const askKeys = new Set((data.repNames?.pending ?? []).map(e => e.key ?? normalizeRepName(e.raw)));
  const keep = (r) => (Number.isInteger(r.repId) ? own.has(r.repId) : Boolean(r.repName) && askKeys.has(normalizeRepName(r.repName)));
  const doctorRows = (data.doctorRows ?? []).filter(keep);
  const pharmacyRows = (data.pharmacyRows ?? []).filter(keep);
  const dropped = (data.doctorRows?.length ?? 0) + (data.pharmacyRows?.length ?? 0) - doctorRows.length - pharmacyRows.length;
  return { data: pruneNameLists({ ...data, doctorRows, pharmacyRows }), dropped };
}

async function runPull(job, { user, repIds, officeWide, cfg }) {
  // دخول واحد لدوفايد في كل لحظة — السحب اليومي وسحوبات الحسابات الأخرى تنتظر دورها
  await dofiedLock.run(async () => {
    job.message = `جارِ سحب الكولات من ${job.from} إلى ${job.to}…`;
    const jar = await login(cfg.username, decryptPassword(cfg.passwordEnc));
    const { buffer, taskRows } = await exportRange(jar, job.from, job.to);
    job.taskRows = taskRows;
    if (!taskRows) {
      Object.assign(job, { state: 'done', imported: 0, message: `لا كولات في دوفايد من ${job.from} إلى ${job.to}`, finishedAt: Date.now() });
      return;
    }
    job.message = `وصل ${taskRows} سجل — جارِ المطابقة…`;
    const fileName = `دوفايد ${job.from}${job.from === job.to ? '' : ` إلى ${job.to}`}.xlsx`;
    const tmpPath = path.join(os.tmpdir(), `dofied_pull_${user.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.xlsx`);
    fs.writeFileSync(tmpPath, buffer);
    // extractVisitsFromExcel يحذف الملف المؤقت بنفسه، ويُسقط ما رُفع سابقاً.
    let data = await extractVisitsFromExcel({ path: tmpPath, originalname: fileName }, user);
    let otherReps = 0;
    if (!officeWide) ({ data, dropped: otherReps } = keepOwnReps(data, repIds));
    const docs = data.doctorRows?.length || 0;
    const pharms = data.pharmacyRows?.length || 0;
    const already = data.alreadyImported || 0;
    Object.assign(job, { already, otherReps, doctors: docs, pharmacies: pharms });
    if (!docs && !pharms) {
      Object.assign(job, {
        state: 'done', imported: 0, finishedAt: Date.now(),
        message: `لا كولات جديدة من ${job.from} إلى ${job.to}${already ? ` — ${already} كول مرفوع سابقاً` : ''}`,
      });
      return;
    }
    await prisma.pendingVisitsImport.create({
      data: { userId: user.id, fileName, payload: { ...data, source: 'dofied', fileName } },
    });
    Object.assign(job, {
      state: 'done', imported: docs + pharms, finishedAt: Date.now(),
      message: `${docs} زيارة طبيب و${pharms} زيارة صيدلية جاهزة للتدقيق${already ? ` (أُسقط ${already} كول مرفوع سابقاً)` : ''}`,
    });
  });
}
