// ════════════════════════════════════════════════════════════════════════════
// dofied.pull.js — «استيراد الكولات من دوفايد» بضغطة زر في تحليل الكولات (2026-11-13).
//
// بخلاف السحب اليومي (dofied.sync.js، حساب واحد يختاره الماستر أدمن) هذا سحب عند
// الطلب لأي حساب مفعَّلة له الميزة visits_dofied_pull، ببيانات دخول دوفايد نفسها:
//  • المدى = أقدم «آخر يوم فيه كولات» بين كل مندوبي الحساب ← اليوم (pullWindow)؛
//    آخر يوم يُعاد سحبه عمداً (ربما سُحب ناقصاً)، والمكرّر يُسقط قبل المراجعة.
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

/**
 * أقدم بداية مسموحة: أول الشهر الحالي، أو قبل 7 أيام إن كنا في أول أسبوع من الشهر
 * (كي لا تضيع أيام آخر الشهر السابق). مندوب بلا كولات منذ ذلك اليوم يُسحب منه.
 */
export function pullFloor(today) {
  const monthStart = `${today.slice(0, 8)}01`;
  const weekAgo = addDays(today, -(DEFAULT_BACK_DAYS - 1));
  return monthStart < weekAgo ? monthStart : weekAgo;
}

/**
 * مدى السحب يغطي كل المندوبين (2026-11-13): البداية = أقدم «آخر يوم فيه كولات» بين
 * مندوبي الحساب، لا أحدثها — مدير سحب لفريقه حتى اليوم لا يجعل موظف المكتب يتخطّى
 * مندوباً آخر متأخراً. آخر يوم نفسه يُعاد (ربما سُحب ناقصاً)؛ المكرّر يُسقط قبل المراجعة.
 * نقيّ. lastDays: Map(repId → 'YYYY-MM-DD' | null).
 */
export function pullWindow(repIds, lastDays, today) {
  const floor = pullFloor(today);
  let from = today;
  let lagging = 0;
  for (const id of repIds) {
    const d = lastDays.get(id);
    const start = d && d >= floor ? (d <= today ? d : today) : floor;
    if (start < today) lagging++;
    if (start < from) from = start;
  }
  if (!repIds.length) from = floor;
  return { from, to: today, lagging };
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
  // مندوب معطَّل (ترك العمل) لا يُنتظر — وإلا لبدأ كل سحب من أول الشهر بسببه
  const activeIds = new Set((await prisma.scientificRepresentative.findMany({
    where: { id: { in: repIds }, isActive: true }, select: { id: true },
  })).map(r => r.id));
  return { user, repIds, windowRepIds: repIds.filter(id => activeIds.has(id)), officeWide: OFFICE_SCOPED_ROLES.has(user.role) };
}

/** آخر يوم (بغداد) فيه كولات فعّالة لكل مندوب — زيارات أطباء وصيدليات معاً. */
async function lastVisitDays(repIds) {
  const out = new Map();
  if (!repIds.length) return out;
  const where = { scientificRepId: { in: repIds }, isActive: true };
  const [d, p] = await Promise.all([
    prisma.doctorVisit.groupBy({ by: ['scientificRepId'], where, _max: { visitDate: true } }),
    prisma.pharmacyVisit.groupBy({ by: ['scientificRepId'], where, _max: { visitDate: true } }),
  ]);
  for (const g of [...d, ...p]) {
    if (!g._max.visitDate) continue;
    const day = visitDayKey(g._max.visitDate);
    const cur = out.get(g.scientificRepId);
    if (!cur || day > cur) out.set(g.scientificRepId, day);
  }
  return out;
}

async function windowFor(repIds) {
  return pullWindow(repIds, await lastVisitDays(repIds), baghdadNow().date);
}

/** ما يحتاجه الزر قبل الضغط: هل الميزة متاحة، والمدى المتوقع، وحالة آخر سحب. */
export async function pullInfo(userId) {
  const { user, windowRepIds } = await scopeOf(userId);
  const enabled = userFeatureOn(user, PULL_FEATURE, { optIn: true });
  const cfg = await getConfig();
  const configured = Boolean(cfg.username && cfg.passwordEnc);
  const win = enabled ? await windowFor(windowRepIds) : null;
  return {
    enabled, configured,
    window: win, repCount: windowRepIds.length,
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
  const { user, repIds, windowRepIds, officeWide } = await scopeOf(userId);
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

  const win = await windowFor(windowRepIds);
  const job = { state: 'running', from: win.from, to: win.to, lagging: win.lagging, startedAt: Date.now(), message: 'جارِ الاتصال بدوفايد…' };
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
