// ════════════════════════════════════════════════════════════════════════════
// survey-sync.service.js — منطق دورة تحديث السيرفي (بلا HTTP)
// ────────────────────────────────────────────────────────────────────────────
// مشترك بين لوحة السوبر أدمن (survey-admin.routes.js) وواجهة المندوب
// (master-survey.routes.js): نفس التصدير ونفس المقارنة ونفس التطبيق، فلا
// يتباعد مساران كما تباعدت نسخ «حدِّث طبيب السيرفي» الثلاث سابقاً.
// ════════════════════════════════════════════════════════════════════════════

import prisma from '../../lib/prisma.js';
import {
  SYNC_TYPES, isSyncType, formatSurveyCode, rowHash, buildExportPayload,
  makeExportToken, diffSurveyRows, applySyncRow, rememberSyncDecision,
  previewPharmacyRenameImpact, emptyCounts, normalizeStored,
} from '../../lib/surveySync.js';
import {
  resolveAreaScope, getScopedSurveyDoctors, loadAreaNameIndex,
} from '../../lib/surveyDoctors.js';
import { getScopedSurveyPharmacies } from '../../lib/surveyPharmacies.js';
import { normalizeAreaName } from '../../lib/itemResolver.js';

// دفعات معلَّقة أقدم من هذا تُعتبر مهجورة عند التنظيف؛ ولقطات التصدير تُقلَّم
// بعد هذه المدة لأن قرص السيرفر ضيّق ولا قيمة لبصمة أقدم من موسم مراجعة.
export const EXPORT_RETENTION_DAYS = 120;

function assertType(entryType) {
  if (!isSyncType(entryType)) throw Object.assign(new Error('نوع غير معروف'), { status: 400 });
}

// ── جلب صفوف السيرفي المطلوب تصديرها ────────────────────────────────────────
// ثلاثة مصادر، بنفس الترتيب الذي يختاره المستدعي:
//   forUser  → نطاق ذلك المستخدم الفعلي (نفس resolveAreaScope الذي تستعمله الشاشات)
//   areaNames→ مناطق محدَّدة يختارها السوبر أدمن
//   لا شيء   → كل صفوف السيرفي النشطة
export async function collectExportRecords({ surveyId, entryType, forUser = null, areaNames = null }) {
  assertType(entryType);
  const def = SYNC_TYPES[entryType];
  const select = { id: true };
  for (const f of def.fields) select[f] = true;

  if (forUser) {
    const scope = await resolveAreaScope({ id: forUser.id, role: forUser.role }, {});
    // نقصر النطاق على هذا السيرفي: resolveAreaScope يُرجع كل السيرفيات النشطة.
    const scoped = { ...scope, surveyIds: scope.surveyIds.filter(id => id === surveyId) };
    const rows = entryType === 'doctor'
      ? await getScopedSurveyDoctors(scoped)
      : await getScopedSurveyPharmacies(scoped);
    if (!rows.length) return { records: [], areaNames: scope.normAreaNames };
    // getScoped* لا تُرجع كل الحقول (لا notes مثلاً) — نعيد الجلب بالمعرّفات.
    const full = await prisma[entryType === 'doctor' ? 'masterSurveyDoctor' : 'masterSurveyPharmacy'].findMany({
      where: { id: { in: rows.map(r => r.id) } },
      select, orderBy: { name: 'asc' },
    });
    return { records: full, areaNames: [...new Set(rows.map(r => r.areaName).filter(Boolean))] };
  }

  const where = { surveyId, isActive: true };
  const model = entryType === 'doctor' ? prisma.masterSurveyDoctor : prisma.masterSurveyPharmacy;
  let records = await model.findMany({ where, select, orderBy: { name: 'asc' } });

  if (areaNames?.length) {
    const wanted = new Set(areaNames.map(a => normalizeAreaName(String(a))).filter(Boolean));
    records = records.filter(r => r.areaName && wanted.has(normalizeAreaName(r.areaName)));
  }
  return { records, areaNames: areaNames ?? null };
}

// ── إنشاء لقطة تصدير ────────────────────────────────────────────────────────
// نحفظ البصمات لا القيم — هي كل ما يلزم للسؤال الوحيد الذي ستجيب عنه لاحقاً:
// «هل تغيّر هذا الصف داخل التطبيق بعد أن استلم المندوب ملفه؟».
export async function createExport({ surveyId, entryType, forUser = null, areaNames = null, createdById = null }) {
  assertType(entryType);
  const { records, areaNames: usedAreas } = await collectExportRecords({ surveyId, entryType, forUser, areaNames });
  const { rows, rowHashes } = buildExportPayload(entryType, records);
  const token = makeExportToken();

  await prisma.surveyExport.create({
    data: {
      token, surveyId, entryType,
      forUserId: forUser?.id ?? null,
      areaNames: usedAreas?.length ? JSON.stringify(usedAreas) : null,
      rowHashes: JSON.stringify(rowHashes),
      rowCount: rows.length,
      createdById,
    },
  });

  return { token, rows, rowCount: rows.length, entryType, surveyId };
}

// ── تحليل ملف مرفوع ─────────────────────────────────────────────────────────
// لا يكتب شيئاً على السيرفي — فقط دفعة بصفوفها المصنَّفة بانتظار المراجعة.
export async function analyzeUpload({ surveyId, entryType, fileName, token, rows, uploadedById = null }) {
  assertType(entryType);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw Object.assign(new Error('الملف لا يحتوي صفوفاً'), { status: 400 });
  }

  let sourceExport = null;
  if (token) {
    sourceExport = await prisma.surveyExport.findUnique({ where: { token } });
    if (sourceExport && (sourceExport.surveyId !== surveyId || sourceExport.entryType !== entryType)) {
      // رمز تصدير من سيرفي/نوع آخر: نتجاهله بدل أن نبني عليه بصمات لا تخصّ
      // هذه الصفوف (وهو ما كان سيُنتج «تعارضات» وهمية في كل صف).
      sourceExport = null;
    }
  }
  const baselineHashes = sourceExport ? JSON.parse(sourceExport.rowHashes || '{}') : {};

  const { rows: classified, counts } = await diffSurveyRows({
    entryType, surveyId, incomingRows: rows, baselineHashes,
  });

  // الأثر الجانبي لإعادة تسمية صيدلية يُحسب الآن لا بعد الاعتماد — السوبر أدمن
  // يحتاج أن يرى «سيتبع الاسم الجديد ٣٤٠ زيارة» قبل أن يضغط موافق.
  if (entryType === 'pharmacy') {
    for (const r of classified) {
      if (r.changeType !== 'update' && r.changeType !== 'conflict') continue;
      const impact = await previewPharmacyRenameImpact(surveyId, r);
      if (impact) r.impact = impact;
    }
  }

  const batch = await prisma.surveySyncBatch.create({
    data: {
      surveyId, entryType,
      exportId: sourceExport?.id ?? null,
      fileName: String(fileName || 'ملف بلا اسم').slice(0, 250),
      uploadedById,
      status: 'pending',
      counts: JSON.stringify(counts),
      rows: {
        create: classified.map(r => ({
          entryId: r.entryId ?? null,
          rowNumber: r.rowNumber,
          changeType: r.changeType,
          incoming: JSON.stringify(r.incoming),
          current: r.current ? JSON.stringify(stripRow(entryType, r.current)) : null,
          diffs: r.diffs?.length || r.impact ? JSON.stringify({ fields: r.diffs ?? [], impact: r.impact ?? null }) : null,
          candidates: r.candidates?.length ? JSON.stringify(r.candidates) : null,
          // ما لا يحتاج قراراً يُعتمد ذاتياً كي لا تُغرق شاشة المراجعة بمئات
          // الصفوف التي لم يمسّها أحد.
          decision: r.changeType === 'unchanged' ? 'approved' : 'pending',
        })),
      },
    },
    select: { id: true },
  });

  return { batchId: batch.id, counts, exportMatched: !!sourceExport };
}

function stripRow(entryType, row) {
  const out = { id: row.id, isActive: row.isActive };
  for (const f of SYNC_TYPES[entryType].fields) out[f] = row[f] ?? null;
  return out;
}

// ── قراءة الدفعات ───────────────────────────────────────────────────────────
export async function listBatches({ surveyId = null, uploadedById = null, status = null, limit = 50 }) {
  const where = {};
  if (surveyId) where.surveyId = surveyId;
  if (uploadedById) where.uploadedById = uploadedById;
  if (status) where.status = status;

  const batches = await prisma.surveySyncBatch.findMany({
    where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100),
  });
  const userIds = [...new Set(batches.map(b => b.uploadedById).filter(Boolean))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
    : [];
  const byId = new Map(users.map(u => [u.id, u]));

  return batches.map(b => ({
    ...b,
    counts: safeParse(b.counts, emptyCounts()),
    uploadedBy: b.uploadedById ? (byId.get(b.uploadedById) ?? null) : null,
  }));
}

export async function getBatch(batchId, { changeType = null, page = 1, limit = 200 } = {}) {
  const batch = await prisma.surveySyncBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;

  const where = { batchId };
  if (changeType) where.changeType = changeType;
  const take = Math.min(limit, 500);
  const [rows, total] = await Promise.all([
    prisma.surveySyncRow.findMany({
      where, orderBy: { rowNumber: 'asc' }, skip: (Math.max(page, 1) - 1) * take, take,
    }),
    prisma.surveySyncRow.count({ where }),
  ]);

  const def = SYNC_TYPES[batch.entryType];
  return {
    batch: { ...batch, counts: safeParse(batch.counts, emptyCounts()) },
    fields: def.fields,
    headers: def.headers,
    rows: rows.map(r => ({
      id: r.id,
      entryId: r.entryId,
      code: r.entryId ? formatSurveyCode(batch.entryType, r.entryId) : '',
      rowNumber: r.rowNumber,
      changeType: r.changeType,
      decision: r.decision,
      appliedAt: r.appliedAt,
      incoming: safeParse(r.incoming, {}),
      current: safeParse(r.current, null),
      diffs: safeParse(r.diffs, null),
      candidates: safeParse(r.candidates, null),
    })),
    total, page: Math.max(page, 1), limit: take,
  };
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── القرارات ────────────────────────────────────────────────────────────────
/**
 * قرار على صف واحد. targetEntryId يحسم صفوف unmatched: رقم = «هو هذا»، و
 * صفر/null صراحةً = «ليس أياً منهم، أنشئه جديداً». وفي الحالتين يُحفظ القرار
 * في جدول الروابط فلا يُعاد السؤال عن نفس الاسم في الرفعة القادمة.
 */
export async function decideRow(rowId, { decision, targetEntryId = undefined, decidedById = null }) {
  if (!['approved', 'rejected', 'pending'].includes(decision)) {
    throw Object.assign(new Error('قرار غير معروف'), { status: 400 });
  }
  const row = await prisma.surveySyncRow.findUnique({ where: { id: rowId } });
  if (!row) return null;
  const batch = await prisma.surveySyncBatch.findUnique({ where: { id: row.batchId } });
  if (!batch || batch.status !== 'pending') {
    throw Object.assign(new Error('الدفعة لم تعد قابلة للتعديل'), { status: 409 });
  }

  const data = { decision, decidedById };

  if (row.changeType === 'unmatched' && targetEntryId !== undefined) {
    if (targetEntryId) {
      data.entryId = Number(targetEntryId);
      data.changeType = 'update';
    } else {
      data.entryId = null;
      data.changeType = 'new';
    }
    const incoming = safeParse(row.incoming, {});
    await rememberSyncDecision(batch.entryType, batch.surveyId, {
      fromName: incoming.name, areaName: incoming.areaName,
      targetId: targetEntryId ? Number(targetEntryId) : null,
      createdById: decidedById,
    });
  }

  // التعارض يُحسم باختيار صريح: الاعتماد يعني «طبّق ما في الملف فوق الحالي».
  if (row.changeType === 'conflict' && decision === 'approved') data.changeType = 'update';

  return prisma.surveySyncRow.update({ where: { id: rowId }, data });
}

/** قرار جماعي على كل صفوف نوع واحد — ما عدا unmatched فهي تحتاج هدفاً لكل صف. */
export async function decideBulk(batchId, { changeType, decision, decidedById = null }) {
  const batch = await prisma.surveySyncBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;
  if (batch.status !== 'pending') {
    throw Object.assign(new Error('الدفعة لم تعد قابلة للتعديل'), { status: 409 });
  }
  if (changeType === 'unmatched' && decision === 'approved') {
    throw Object.assign(new Error('صفوف «بلا مطابقة» تحتاج قراراً فردياً لكل اسم'), { status: 400 });
  }

  const where = { batchId };
  if (changeType) where.changeType = changeType;
  const res = await prisma.surveySyncRow.updateMany({ where, data: { decision, decidedById } });

  if (changeType === 'conflict' && decision === 'approved') {
    await prisma.surveySyncRow.updateMany({ where: { batchId, changeType: 'conflict' }, data: { changeType: 'update' } });
  }
  return { updated: res.count };
}

// ── التطبيق ─────────────────────────────────────────────────────────────────
/**
 * يطبّق الصفوف المعتمَدة فقط. ثلاث حمايات مقصودة:
 *  1) يرفض البدء ما دام أي تعارض أو أي صف بلا مطابقة لم يُحسم — هذه هي الحالات
 *     التي لا يجوز فيها تخمين نية أحد.
 *  2) يعيد التحقق من كل صف مقابل حالته الحيّة لحظة التطبيق: الدفعة قد تنتظر
 *     أياماً، وقد يكون أحدهم عدّل الصف داخل التطبيق بعد المراجعة. الصف الذي
 *     تغيّر يُعاد إلى «تعارض» ولا يُطبَّق.
 *  3) editedById = رافع الملف لا السوبر أدمن المعتمِد، كي يظهر التغيير في
 *     تغذية 🔔 «سجل الأطباء» منسوباً لصاحبه فعلاً.
 */
export async function applyBatch(batchId, { decidedById = null } = {}) {
  const batch = await prisma.surveySyncBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;
  if (batch.status !== 'pending') {
    throw Object.assign(new Error('هذه الدفعة طُبّقت أو أُهملت سابقاً'), { status: 409 });
  }

  const blocking = await prisma.surveySyncRow.count({
    where: { batchId, decision: 'pending', changeType: { in: ['conflict', 'unmatched'] } },
  });
  if (blocking > 0) {
    throw Object.assign(
      new Error(`يوجد ${blocking} صفاً بتعارض أو بلا مطابقة يحتاج قراراً قبل التطبيق`),
      { status: 400 },
    );
  }

  const rows = await prisma.surveySyncRow.findMany({
    where: { batchId, decision: 'approved', appliedAt: null, changeType: { in: ['update', 'move', 'new', 'delete'] } },
    orderBy: { rowNumber: 'asc' },
  });

  const editedById = batch.uploadedById ?? decidedById ?? null;
  const areaCache = await loadAreaNameIndex();
  const model = batch.entryType === 'doctor' ? prisma.masterSurveyDoctor : prisma.masterSurveyPharmacy;

  const result = { applied: 0, skippedStale: 0, failed: 0, created: 0, updated: 0, deactivated: 0, errors: [] };

  for (const r of rows) {
    const incoming = safeParse(r.incoming, {});
    const snapshot = safeParse(r.current, null);

    // الحماية (2): هل تغيّر الصف منذ لحظة الرفع؟
    if (r.entryId && snapshot) {
      const select = { id: true, isActive: true };
      for (const f of SYNC_TYPES[batch.entryType].fields) select[f] = true;
      const live = await model.findUnique({ where: { id: r.entryId }, select });
      if (!live) {
        result.failed++;
        result.errors.push({ rowNumber: r.rowNumber, error: 'الصف لم يعد موجوداً' });
        await prisma.surveySyncRow.update({ where: { id: r.id }, data: { decision: 'rejected' } });
        continue;
      }
      if (rowHash(batch.entryType, live) !== rowHash(batch.entryType, snapshot)) {
        result.skippedStale++;
        await prisma.surveySyncRow.update({
          where: { id: r.id },
          data: { changeType: 'conflict', decision: 'pending', current: JSON.stringify(stripRow(batch.entryType, live)) },
        });
        continue;
      }
    }

    try {
      const out = await applySyncRow(batch.entryType, batch.surveyId, {
        changeType: r.changeType, entryId: r.entryId, incoming,
      }, editedById, areaCache);

      if (out?.error) {
        result.failed++;
        result.errors.push({ rowNumber: r.rowNumber, error: out.error });
        continue;
      }
      await prisma.surveySyncRow.update({ where: { id: r.id }, data: { appliedAt: new Date() } });
      result.applied++;
      if (r.changeType === 'new') result.created++;
      else if (r.changeType === 'delete') result.deactivated++;
      else result.updated++;
    } catch (e) {
      result.failed++;
      result.errors.push({ rowNumber: r.rowNumber, error: e.message });
    }
  }

  // دفعة بقي فيها صفوف عادت للتعارض تظل معلَّقة كي يراجعها السوبر أدمن ويعيد
  // التطبيق؛ لا تُختم إلا إذا لم يبقَ شيء ينتظر.
  const stillPending = await prisma.surveySyncRow.count({
    where: { batchId, decision: 'pending', changeType: { in: ['conflict', 'unmatched', 'update', 'move', 'new', 'delete'] } },
  });
  if (stillPending === 0) {
    await prisma.surveySyncBatch.update({
      where: { id: batchId },
      data: { status: 'applied', reviewedAt: new Date() },
    });
  }

  return { ...result, stillPending, status: stillPending === 0 ? 'applied' : 'pending' };
}

export async function discardBatch(batchId) {
  const batch = await prisma.surveySyncBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;
  if (batch.status === 'applied') {
    throw Object.assign(new Error('لا يمكن إهمال دفعة طُبّقت'), { status: 409 });
  }
  return prisma.surveySyncBatch.update({
    where: { id: batchId },
    data: { status: 'discarded', reviewedAt: new Date() },
  });
}

// ── تقليم لقطات التصدير القديمة ─────────────────────────────────────────────
// تُستدعى عند كل تصدير جديد: البصمات بلا قيمة بعد انقضاء موسم المراجعة، وقرص
// السيرفر ضيّق. الدفعات نفسها تبقى — هي السجل الدائم لمن غيّر ماذا.
export async function pruneOldExports() {
  const cutoff = new Date(Date.now() - EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.surveyExport.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
