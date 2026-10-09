// ════════════════════════════════════════════════════════════════════════════
// followupStandards.js — المعايير التي يُحاسَب عليها المندوب، كلها قابلة للتغيير.
//
// لا رقم مزروع في الكود: «٨ أطباء باليوم»، «٨٠٪ تغطية»، «٣٠ يوماً للمنطقة
// المهجورة» كلها قرارات إدارية لا هندسية، فتُخزَّن لا تُكتب. مستويان:
//   • RepFollowupStandard  — افتراضي المكتب (صف واحد لكل مدير)
//   • RepFollowupOverride  — استثناء لمندوب واحد، حقل null = يورث الافتراضي
//
// فخّ مقصود تفاديه: الصف الافتراضي **لا** يُنشأ تلقائياً عند القراءة. مدير لم
// يفتح شاشة المعايير بعد يحصل على FOLLOWUP_DEFAULTS في الذاكرة، فلا تتكوّن صفوف
// شبحية لحسابات لا تستعمل الميزة أصلاً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

/** نفس قيم @default في السكيما — تُستعمل قبل أن يحفظ المدير أي شيء. */
export const FOLLOWUP_DEFAULTS = {
  doctorVisitsPerDay: 8,
  pharmacyVisitsPerDay: 4,
  workDaysPerMonth: 26,
  restWeekdays: '5',
  doctorRevisitDays: 30,
  doctorCoverageTargetPct: 80,
  pharmacyCoverageTargetPct: 70,
  areaIdleDays: 30,
  targetAchievementMinPct: 90,
  growthTargetPct: 10,
  weightSales: 40,
  weightVisits: 25,
  weightCoverage: 20,
  weightGrowth: 10,
  weightDiscipline: 5,
  digestEnabled: false,
  digestRepHour: 8,
  digestManagerHour: 18,
  digestChannels: 'app,telegram',
  maxLinesPerDigest: 6,
};

/** الحقول القابلة للاستثناء لمندوب واحد (بقيتها على مستوى المكتب فقط). */
export const OVERRIDABLE_KEYS = [
  'doctorVisitsPerDay', 'pharmacyVisitsPerDay', 'workDaysPerMonth', 'doctorRevisitDays',
  'doctorCoverageTargetPct', 'pharmacyCoverageTargetPct', 'areaIdleDays',
  'targetAchievementMinPct', 'growthTargetPct',
];

// مَن يملك المعايير المطبَّقة على مستخدم ما (المدير لنفسه، والمندوب الميداني
// مديره) يُحسم في rep-followup.service.js عبر resolveDocOwnerUserId — لا هنا:
// هذا الملف يبقى تابعاً لـ prisma وحده كي لا تنشأ حلقة استيراد مع doctors.controller.
/** معايير المكتب — الصف المحفوظ مدموجاً فوق الافتراضي، بلا إنشاء صف. */
export async function getStandards(ownerUserId) {
  const row = await prisma.repFollowupStandard.findUnique({ where: { ownerUserId } });
  if (!row) return { ...FOLLOWUP_DEFAULTS, ownerUserId, isSaved: false };
  return { ...FOLLOWUP_DEFAULTS, ...stripNulls(row), isSaved: true };
}

export async function upsertStandards(ownerUserId, patch) {
  const data = pickNumbersAndFlags(patch);
  return prisma.repFollowupStandard.upsert({
    where: { ownerUserId },
    create: { ownerUserId, ...data },
    update: data,
  });
}

export async function listOverrides(ownerUserId) {
  return prisma.repFollowupOverride.findMany({ where: { ownerUserId }, orderBy: { scientificRepId: 'asc' } });
}

export async function upsertOverride(ownerUserId, scientificRepId, patch) {
  const data = {};
  for (const k of OVERRIDABLE_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    // '' أو null من الواجهة = «ارجع للافتراضي» لا صفر.
    data[k] = (v === null || v === '' || typeof v === 'undefined') ? null : clampInt(v);
  }
  if ('note' in patch) data.note = patch.note ? String(patch.note).slice(0, 300) : null;
  return prisma.repFollowupOverride.upsert({
    where: { ownerUserId_scientificRepId: { ownerUserId, scientificRepId } },
    create: { ownerUserId, scientificRepId, ...data },
    update: data,
  });
}

export async function deleteOverride(ownerUserId, scientificRepId) {
  await prisma.repFollowupOverride.deleteMany({ where: { ownerUserId, scientificRepId } });
}

/**
 * المعايير الفعلية لمندوب واحد = المكتب + استثناؤه (إن وُجد).
 * @param {object} standards  ناتج getStandards()
 * @param {object|null} override صف RepFollowupOverride أو null
 */
export function effectiveFor(standards, override) {
  const out = { ...standards };
  if (override) {
    for (const k of OVERRIDABLE_KEYS) {
      if (override[k] !== null && typeof override[k] !== 'undefined') out[k] = override[k];
    }
    out.overrideNote = override.note ?? null;
    out.hasOverride = true;
  } else {
    out.hasOverride = false;
  }
  return out;
}

/** أيام الراحة كمجموعة أرقام (0=الأحد … 6=السبت). */
export function parseRestWeekdays(raw) {
  return new Set(String(raw ?? '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6));
}

/**
 * أيام العمل المنقضية فعلاً من الشهر حتى `until` (شاملاً) — لا عدد أيام الشهر.
 * بدون هذا يُقاس أداء يوم ٥ من الشهر على تارجت شهر كامل فيظهر كل الفريق متأخراً.
 */
export function workingDaysElapsed(year, month, until, restWeekdays) {
  const rest = parseRestWeekdays(restWeekdays);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDay = (until.getUTCFullYear() === year && until.getUTCMonth() === month - 1)
    ? Math.min(until.getUTCDate(), last)
    : last;
  let count = 0;
  for (let d = 1; d <= endDay; d++) {
    if (!rest.has(new Date(Date.UTC(year, month - 1, d)).getUTCDay())) count++;
  }
  return count;
}

/** كل أيام العمل في الشهر (المقام الشهري الكامل). */
export function workingDaysInMonth(year, month, restWeekdays) {
  return workingDaysElapsed(year, month, new Date(Date.UTC(year, month, 0)), restWeekdays);
}

// ── مساعدات داخلية ──────────────────────────────────────────────────────────

function stripNulls(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
  return out;
}

function clampInt(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 100000));
}

const INT_KEYS = [
  'doctorVisitsPerDay', 'pharmacyVisitsPerDay', 'workDaysPerMonth', 'doctorRevisitDays',
  'doctorCoverageTargetPct', 'pharmacyCoverageTargetPct', 'areaIdleDays',
  'targetAchievementMinPct', 'growthTargetPct',
  'weightSales', 'weightVisits', 'weightCoverage', 'weightGrowth', 'weightDiscipline',
  'digestRepHour', 'digestManagerHour', 'maxLinesPerDigest',
];

function pickNumbersAndFlags(patch) {
  const data = {};
  for (const k of INT_KEYS) if (k in patch) data[k] = clampInt(patch[k]);
  // ساعات الإرسال 0..23 — قيمة خارجها تُسكِت الملخّص للأبد بلا أثر مفهوم.
  if ('digestRepHour' in data) data.digestRepHour = Math.min(23, data.digestRepHour);
  if ('digestManagerHour' in data) data.digestManagerHour = Math.min(23, data.digestManagerHour);
  if ('digestEnabled' in patch) data.digestEnabled = Boolean(patch.digestEnabled);
  if ('restWeekdays' in patch) data.restWeekdays = [...parseRestWeekdays(patch.restWeekdays)].join(',');
  if ('digestChannels' in patch) {
    const allowed = new Set(['app', 'telegram']);
    const list = String(patch.digestChannels ?? '').split(',').map(s => s.trim()).filter(c => allowed.has(c));
    data.digestChannels = list.length ? [...new Set(list)].join(',') : 'app';
  }
  return data;
}
