// ════════════════════════════════════════════════════════════════════════════
// visitImportDedup.js — منع عدّ الزيارة مرتين حين تتداخل ملفات استيراد مفعّلة.
// ────────────────────────────────────────────────────────────────────────────
// تصدير CRM جديد يغطي غالباً أياماً سبق رفعها في ملف أقدم، فتصبح الزيارة نفسها
// صفّين في DoctorVisit/PharmacyVisit وتُعدّ مرتين في كل الشاشات.
//
// الحل: العلم المُنَمذَج isActive (الذي تفلتر عليه كل قراءات الزيارات في التطبيق)
// يُعاد حسابه هنا = «ملفه مفعّل» و«ليس نسخة من زيارة في ملف مفعّل أقدم».
// المفتاح: (الطبيب | الصيدلية) × المندوب × يوم الزيارة (بتوقيت بغداد).
// الأقدم رفعاً يفوز بالمفتاح كاملاً، فتكرار نفس اليوم داخل الملف الواحد يبقى كما
// هو — لا نطوي إلا التداخل بين الملفات (نفس مبدأ crossFileDedup للمبيعات).
// الزيارات اليدوية (visitImportFileId = null) لا تُمَسّ.
// يُستدعى بعد كل حفظ/تفعيل/تعطيل/حذف ملف، ومرة عند الإقلاع للبيانات القديمة.
// ════════════════════════════════════════════════════════════════════════════
import prisma from './prisma.js';
import { pharmacyKey } from './pharmacyKey.js';

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const dayKey = (d) => new Date(new Date(d).getTime() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

async function applyFlags(model, toTrue, toFalse) {
  const CHUNK = 5000;
  for (const [ids, isActive] of [[toTrue, true], [toFalse, false]]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await prisma[model].updateMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, data: { isActive } });
    }
  }
}

/** يحسب أي الصفوف تبقى فعّالة؛ rows مرتّبة مسبقاً حسب أقدمية الملف. */
function decide(rows, keyOf, fileOrder) {
  const winner = new Map(); // key → fileId
  const toTrue = [], toFalse = [];
  rows.sort((a, b) => fileOrder.get(a.visitImportFileId) - fileOrder.get(b.visitImportFileId) || a.id - b.id);
  for (const r of rows) {
    const k = keyOf(r);
    if (!winner.has(k)) winner.set(k, r.visitImportFileId);
    const want = winner.get(k) === r.visitImportFileId;
    if (want !== r.isActive) (want ? toTrue : toFalse).push(r.id);
  }
  return { toTrue, toFalse, duplicates: rows.length - [...winner.keys()].length };
}

/** يعيد ضبط isActive لكل زيارات ملفات الاستيراد لمالك واحد. يُرجع عدد الصفوف المكرّرة المُخفاة. */
export async function recomputeVisitImportDuplicates(ownerUserId) {
  const files = await prisma.visitImportFile.findMany({
    where: { ownerUserId },
    select: { id: true, isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!files.length) return 0;
  const activeIds = files.filter(f => f.isActive).map(f => f.id);
  const inactiveIds = files.filter(f => !f.isActive).map(f => f.id);
  const fileOrder = new Map(files.map((f, i) => [f.id, i]));

  // ملفات معطّلة: كل زياراتها غير فعّالة (يحفظ سلوك زر التعطيل كما هو)
  if (inactiveIds.length) {
    await prisma.doctorVisit.updateMany({ where: { visitImportFileId: { in: inactiveIds }, isActive: true }, data: { isActive: false } });
    await prisma.pharmacyVisit.updateMany({ where: { visitImportFileId: { in: inactiveIds }, isActive: true }, data: { isActive: false } });
  }
  if (!activeIds.length) return 0;

  const [docRows, pharmRows] = await Promise.all([
    prisma.doctorVisit.findMany({
      where: { visitImportFileId: { in: activeIds } },
      select: { id: true, visitImportFileId: true, isActive: true, doctorId: true, scientificRepId: true, visitDate: true,
        doctor: { select: { masterSurveyDoctorId: true } } },
    }),
    prisma.pharmacyVisit.findMany({
      where: { visitImportFileId: { in: activeIds } },
      select: { id: true, visitImportFileId: true, isActive: true, pharmacyName: true, scientificRepId: true, visitDate: true },
    }),
  ]);

  const doc = decide(docRows,
    r => `${r.doctor?.masterSurveyDoctorId ? 's' + r.doctor.masterSurveyDoctorId : 'd' + r.doctorId}|${r.scientificRepId}|${dayKey(r.visitDate)}`,
    fileOrder);
  const pharm = decide(pharmRows,
    r => `${pharmacyKey(r.pharmacyName) || r.pharmacyName}|${r.scientificRepId}|${dayKey(r.visitDate)}`,
    fileOrder);

  await applyFlags('doctorVisit', doc.toTrue, doc.toFalse);
  await applyFlags('pharmacyVisit', pharm.toTrue, pharm.toFalse);
  return doc.duplicates + pharm.duplicates;
}

/** إقلاع: يطبّق الحساب على كل المالكين ممن لديهم أكثر من ملف (البيانات السابقة لهذه الميزة). */
export async function backfillVisitImportDuplicates() {
  const groups = await prisma.visitImportFile.groupBy({ by: ['ownerUserId'], _count: { _all: true } });
  let total = 0;
  for (const g of groups) {
    if (g._count._all < 2) continue;
    total += await recomputeVisitImportDuplicates(g.ownerUserId);
  }
  return total;
}
