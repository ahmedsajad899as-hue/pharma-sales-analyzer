// ════════════════════════════════════════════════════════════════════════════
// visitImportDedup.js — منع عدّ الزيارة مرتين حين تتداخل رفعات استيراد مفعّلة.
// ────────────────────────────────────────────────────────────────────────────
// تصدير CRM جديد يغطي غالباً أياماً سبق رفعها، فتصبح الزيارة نفسها صفّين في
// DoctorVisit/PharmacyVisit وتُعدّ مرتين في كل الشاشات.
//
// الحل: العلم المُنَمذَج isActive (الذي تفلتر عليه كل قراءات الزيارات في التطبيق)
// يُعاد حسابه هنا = «وحدتها مفعّلة» و«ليست نسخة من زيارة في وحدة مفعّلة أقدم».
//  • الوحدة = دفعة داخل الملف التراكمي (VisitImportBatch)، أو الملف كله إن كان
//    ملفاً مستقلاً قديماً بلا دفعات.
//  • المفتاح: الطبيب × المندوب × يوم الزيارة (بتوقيت بغداد). الطبيب = طبيب السيرفي
//    (مشترك بين كل الحسابات) وإلا اسمه المطبَّع — صفوف Doctor ملك كل حساب على حدة،
//    فمعرّفها لا يصلح للمقارنة بين حسابين. الصيدلية = pharmacyKey(الاسم).
//  • النطاق = المندوب لا الحساب (2026-11-13): مدير الشركة يرفع زيارات مندوبيه،
//    وموظف المكتب يرفع ملف المكتب كاملاً بنفس الأيام ⇒ زيارات مندوبي المدير تبقى
//    مرة واحدة. الأقدم رفعاً يفوز بالمفتاح كاملاً، فتكرار نفس اليوم داخل الدفعة
//    الواحدة يبقى كما هو — لا نطوي إلا التداخل بين الرفعات.
//  • حذف/تعطيل الرفعة الفائزة يُعيد نسخ الرفعات الأخرى فعّالة (لا شيء يُحذف هنا).
// الزيارات اليدوية (visitImportFileId = null) لا تُمَسّ.
// يُستدعى بعد كل حفظ/تفعيل/تعطيل/حذف/دمج، ومرة عند الإقلاع للبيانات القديمة.
// ════════════════════════════════════════════════════════════════════════════
import prisma from './prisma.js';
import { pharmacyKey } from './pharmacyKey.js';
import { normalizeAreaName } from './itemResolver.js';
import { cleanDoctorName } from './surveyDoctors.js';

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const visitDayKey = (d) => new Date(new Date(d).getTime() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

// «عيادة الدكتور فلان» و«د. فلان» = فلان — نفس تنظيف الاستيراد.
export const doctorNameKey = (name) => normalizeAreaName(cleanDoctorName(name));
export const pharmacyVisitKey = (name) => pharmacyKey(name) || String(name ?? '').trim();

const REP_CHUNK = 25; // المفتاح يتضمّن المندوب ⇒ كل مجموعة مندوبين مستقلة، فتُعالج بالتتابع لتقليل الذاكرة

async function applyFlags(model, toTrue, toFalse) {
  const CHUNK = 5000;
  for (const [ids, isActive] of [[toTrue, true], [toFalse, false]]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await prisma[model].updateMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, data: { isActive } });
    }
  }
}

/** معلومات الوحدات (ملف مستقل / دفعة): هل هي مفعّلة، وترتيب أقدميتها. */
async function loadUnits(rows) {
  const fileIds = [...new Set(rows.map(r => r.visitImportFileId).filter(Number.isInteger))];
  const batchIds = [...new Set(rows.map(r => r.visitImportBatchId).filter(Number.isInteger))];
  const [files, batches] = await Promise.all([
    fileIds.length ? prisma.visitImportFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, isActive: true, createdAt: true } }) : [],
    batchIds.length ? prisma.visitImportBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, isActive: true, createdAt: true } }) : [],
  ]);
  const fileById = new Map(files.map(f => [f.id, f]));
  const batchById = new Map(batches.map(b => [b.id, b]));
  return (r) => {
    const file = fileById.get(r.visitImportFileId);
    const batch = r.visitImportBatchId ? batchById.get(r.visitImportBatchId) : null;
    const unit = batch ? `b${batch.id}` : `f${r.visitImportFileId}`;
    const at = (batch ?? file)?.createdAt?.getTime?.() ?? 0;
    const tie = batch ? batch.id : (r.visitImportFileId ?? 0);
    return { unit, at, tie, active: Boolean(file?.isActive) && (batch ? batch.isActive : true) };
  };
}

/** يقرّر أي الصفوف تبقى فعّالة. نقيّ. */
export function decideActive(rows, keyOf, unitOf) {
  const enriched = rows.map(r => ({ r, u: unitOf(r) }));
  enriched.sort((a, b) => a.u.at - b.u.at || a.u.tie - b.u.tie || a.r.id - b.r.id);
  const winner = new Map(); // key → unit
  const toTrue = [], toFalse = [];
  let duplicates = 0;
  for (const { r, u } of enriched) {
    let want = false;
    if (u.active) {
      const k = keyOf(r);
      if (!winner.has(k)) winner.set(k, u.unit);
      want = winner.get(k) === u.unit;
      if (!want) duplicates++;
    }
    if (want !== r.isActive) (want ? toTrue : toFalse).push(r.id);
  }
  return { toTrue, toFalse, duplicates };
}

/** مفتاح زيارة الطبيب: طبيب السيرفي إن وُجد — ولو عبر سميّه المربوط في نفس المجموعة — وإلا الاسم. */
export function doctorKeyFn(rows) {
  const msByName = new Map(); // `${rep}|${name}` → masterSurveyDoctorId
  for (const r of rows) {
    const ms = r.doctor?.masterSurveyDoctorId;
    if (ms) msByName.set(`${r.scientificRepId}|${doctorNameKey(r.doctor?.name)}`, ms);
  }
  return (r) => {
    const nk = doctorNameKey(r.doctor?.name);
    const ms = r.doctor?.masterSurveyDoctorId ?? msByName.get(`${r.scientificRepId}|${nk}`);
    return `${ms ? 's' + ms : 'n' + nk}|${r.scientificRepId}|${visitDayKey(r.visitDate)}`;
  };
}

async function recomputeChunk(repIds) {
  const where = { scientificRepId: { in: repIds }, visitImportFileId: { not: null } };
  const [docRows, pharmRows] = await Promise.all([
    prisma.doctorVisit.findMany({
      where,
      select: { id: true, visitImportFileId: true, visitImportBatchId: true, isActive: true, scientificRepId: true, visitDate: true,
        doctor: { select: { masterSurveyDoctorId: true, name: true } } },
    }),
    prisma.pharmacyVisit.findMany({
      where,
      select: { id: true, visitImportFileId: true, visitImportBatchId: true, isActive: true, pharmacyName: true, scientificRepId: true, visitDate: true },
    }),
  ]);
  if (!docRows.length && !pharmRows.length) return 0;
  const unitOf = await loadUnits([...docRows, ...pharmRows]);
  const doc = decideActive(docRows, doctorKeyFn(docRows), unitOf);
  const pharm = decideActive(pharmRows,
    r => `${pharmacyVisitKey(r.pharmacyName)}|${r.scientificRepId}|${visitDayKey(r.visitDate)}`, unitOf);
  await applyFlags('doctorVisit', doc.toTrue, doc.toFalse);
  await applyFlags('pharmacyVisit', pharm.toTrue, pharm.toFalse);
  return doc.duplicates + pharm.duplicates;
}

/** يعيد ضبط isActive لكل زيارات الاستيراد لهؤلاء المندوبين، عبر كل الحسابات. يُرجع عدد النسخ المكرّرة المخفية. */
export async function recomputeVisitDuplicatesForReps(repIds) {
  const ids = [...new Set((repIds || []).filter(Number.isInteger))];
  let total = 0;
  for (let i = 0; i < ids.length; i += REP_CHUNK) total += await recomputeChunk(ids.slice(i, i + REP_CHUNK));
  return total;
}

/** مندوبو زيارات ملف/دفعة — قبل الحذف (بعده لا يبقى ما يُسأل عنه). */
export async function repIdsOfImport({ fileId = null, batchId = null } = {}) {
  const where = batchId ? { visitImportBatchId: batchId } : { visitImportFileId: fileId };
  const [d, p] = await Promise.all([
    prisma.doctorVisit.findMany({ where: { ...where, scientificRepId: { not: null } }, select: { scientificRepId: true }, distinct: ['scientificRepId'] }),
    prisma.pharmacyVisit.findMany({ where: { ...where, scientificRepId: { not: null } }, select: { scientificRepId: true }, distinct: ['scientificRepId'] }),
  ]);
  return [...new Set([...d, ...p].map(r => r.scientificRepId))];
}

/**
 * ملف معطَّل/دفعة معطّلة ⇒ كل زياراتهما غير فعّالة، حتى ما لا مندوب له (خارج
 * نطاق الحساب بالمندوب أعلاه). يحفظ سلوك زر التعطيل كما كان.
 */
export async function deactivateDisabledUnits({ fileIds = [], batchIds = [] } = {}) {
  for (const model of ['doctorVisit', 'pharmacyVisit']) {
    if (fileIds.length) await prisma[model].updateMany({ where: { visitImportFileId: { in: fileIds }, isActive: true }, data: { isActive: false } });
    if (batchIds.length) await prisma[model].updateMany({ where: { visitImportBatchId: { in: batchIds }, isActive: true }, data: { isActive: false } });
  }
}

/** إقلاع: يطبّق الحساب على كل مندوب له زيارات استيراد (البيانات السابقة، والتداخل بين الحسابات). */
export async function backfillVisitImportDuplicates() {
  const [d, p] = await Promise.all([
    prisma.doctorVisit.findMany({ where: { visitImportFileId: { not: null }, scientificRepId: { not: null } }, select: { scientificRepId: true }, distinct: ['scientificRepId'] }),
    prisma.pharmacyVisit.findMany({ where: { visitImportFileId: { not: null }, scientificRepId: { not: null } }, select: { scientificRepId: true }, distinct: ['scientificRepId'] }),
  ]);
  return recomputeVisitDuplicatesForReps([...new Set([...d, ...p].map(r => r.scientificRepId))]);
}
