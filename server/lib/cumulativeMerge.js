// ════════════════════════════════════════════════════════════════════════════
// cumulativeMerge.js — دمج ملفات **موجودة مسبقاً** داخل ملف تراكمي واحد.
//
// مكمّل لـcumulativeFile.js: ذاك يتولّى الرفعات الجديدة وهي تصل، وهذا يُلملم ما
// رُفع قبل الميزة (مبيع شهر 9، مبيع شهر 10، ميركاتو 9، ميركاتو 10 …) في ملف
// واحد لكل مجموعة، مُسقطاً ما تكرّر بينها.
//
// فُصل عن cumulativeFile.js عمداً: مسار الرفع يُستدعى في كل رفعة ويجب أن يبقى
// خفيفاً، بينما هذا عملٌ يدوي ثقيل يُنفَّذ مرات معدودة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { fingerprintRows, mergeGroupKey, cumulativeFileName } from './saleFingerprint.js';
import { UNDATED_SENTINEL } from './salesMonths.js';
import { auditCumulativeFile } from './cumulativeAudit.js';
import {
  isMergeableType, openMergeBatch, closeMergeBatch, refreshCumulativeFile, monthsLabelOf,
  ensureLegacyBatch,
} from './cumulativeFile.js';

/** أسماء أعمدة التاريخ المحتملة — للحكم: هل كان للصف تاريخ في الإكسل أصلاً؟ */
const DATE_ALIASES = ['التاريخ', 'تاريخ', 'تاريخ البيع', 'تاريخ الفاتورة', 'تاريخ الطلب', 'تاريخ العملية',
  'أنشات بتاريخ', 'انشات بتاريخ', 'أنشأت بتاريخ', 'انشأت بتاريخ', 'تاريخ الانشاء', 'تاريخ الإنشاء', 'date'];

/**
 * ⚠️ لا نسأل saleDate: الصف الذي لم يحمل تاريخاً في الإكسل أخذ @default(now())
 * أي لحظة الرفع، فهو يبدو مؤرَّخاً تماماً. المصدر الوحيد الصادق هو نصّ الصف
 * الخام (rawData) — هل فيه عمود تاريخ بقيمة فعلاً؟
 */
function rawHasDate(rawData) {
  if (!rawData) return false;
  let raw;
  try { raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData; } catch { return false; }
  if (!raw) return false;
  for (const key of Object.keys(raw)) {
    if (DATE_ALIASES.some(a => a.toLowerCase() === key.trim().toLowerCase())) {
      const v = raw[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return true;
    }
  }
  return false;
}

/**
 * مجموعات الدمج المقترحة لحساب ما — لشاشة «دمج الملفات الحالية».
 *
 * لا نَعِد هنا بعدد المكررات: معرفته تتطلب حساب بصمة كل صف في كل الملفات
 * (مئات الآلاف) وهو عمل الدمج نفسه. المعاينة تُظهر ما سيُدمج مع أيّ، والعدد
 * الفعلي للمُسقَط يظهر بعد التنفيذ.
 */
export async function previewMergeGroups(userId) {
  if (!userId) return [];
  const files = await prisma.uploadedFile.findMany({
    where: { userId, NOT: { fileType: { in: ['filter_page', 'pharmacy_net'] } } },
    orderBy: { uploadedAt: 'asc' },
    select: {
      id: true, originalName: true, uploadedAt: true, fileType: true,
      sourceSystem: true, detectedCurrency: true, isCumulative: true, mergeGroup: true,
      _count: { select: { sales: true } },
    },
  });

  const groups = new Map();
  for (const f of files) {
    const key = mergeGroupKey({ userId, sourceSystem: f.sourceSystem, detectedCurrency: f.detectedCurrency });
    if (!groups.has(key)) {
      groups.set(key, {
        group:            key,
        sourceSystem:     f.sourceSystem || null,
        detectedCurrency: f.detectedCurrency,
        label:            cumulativeFileName({ sourceSystem: f.sourceSystem, detectedCurrency: f.detectedCurrency }),
        targetFileId:     null,
        files:            [],
        totalRows:        0,
      });
    }
    const g = groups.get(key);
    if (f.isCumulative && g.targetFileId == null) g.targetFileId = f.id;
    g.files.push({
      id: f.id, originalName: f.originalName, rowCount: f._count.sales,
      uploadedAt: f.uploadedAt, fileType: f.fileType, isCumulative: f.isCumulative,
    });
    g.totalRows += f._count.sales;
  }

  // مجموعة بملف واحد تراكمي أصلاً = لا شيء لدمجه.
  return [...groups.values()].filter(g => g.files.length > 1 || !g.files[0].isCumulative);
}

/**
 * يدمج ملفات موجودة داخل ملف تراكمي واحد، مُسقطاً الصفوف المكررة بينها.
 *
 * ⚠️ لماذا لا نُحوّل الصفوف بـupdateMany دفعةً واحدة: قيد (uploadedFileId,
 * dedupKey) الفريد سيُفشل التحديث كلّه عند أول تصادم بدل أن يُسقط المكرر —
 * skipDuplicates موجود في createMany وحده. فنعالج على دفعات، نحتفظ بمجموعة
 * البصمات المستعملة في الهدف، ونحذف الصف المكرر بدل نقله.
 *
 * ⚠️ رقم التكرار يُحسب **لكل ملف مصدر على حدة** (بترتيب Sale.id تصاعدياً = ترتيب
 * الإدراج الأصلي = ترتيب صفوف الإكسل)، تماماً كما يُحسب لرفعة واحدة. هذا ما
 * يجعل صفوف شهر 9 الموجودة في «ملف شهر 9» و«ملف شهري 9+10» تُنتج البصمات نفسها
 * فتُسقط الثانية، بينما صفّان متطابقان مشروعان داخل الملف الواحد يبقيان معاً
 * (الدرس المدفوع ثمنه في crossFileDedup.js).
 *
 * @param {object} args
 * @param {number} args.userId
 * @param {number[]} args.fileIds الملفات المراد دمجها (المالك فقط)
 */
export async function mergeExistingFiles({ userId, fileIds }) {
  const ids = [...new Set((fileIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length < 1) throw new Error('حدّد ملفاً واحداً على الأقل للدمج.');

  const files = await prisma.uploadedFile.findMany({
    where: { id: { in: ids }, userId },
    orderBy: { uploadedAt: 'asc' },
  });
  if (files.length !== ids.length) throw new Error('بعض الملفات غير موجودة أو لا تخصّك.');
  const blocked = files.find(f => !isMergeableType(f.fileType));
  if (blocked) throw new Error(`الملف "${blocked.originalName}" من نوع لا يقبل الدمج.`);

  // كل الملفات يجب أن تكون من نفس المصدر ونفس العملة — خلطهما يقرأ نصف الصفوف
  // بعملة خاطئة أو ينسب مبيع ميركاتو بمنطق المكتب. راجع mergeGroupKey.
  const groups = new Set(files.map(f => mergeGroupKey({
    userId, sourceSystem: f.sourceSystem, detectedCurrency: f.detectedCurrency,
  })));
  if (groups.size > 1) {
    throw new Error('لا يمكن دمج ملفات تختلف في المصدر (مكتب/ميركاتو) أو في العملة — ادمج كل مجموعة على حدة.');
  }
  const group  = [...groups][0];
  const sample = files[0];

  // الهدف: ملف تراكمي قائم في المجموعة، وإلا أقدم ملف يُرقّى إلى حاوية تراكمية.
  // الترقية أفضل من إنشاء ملف جديد: المشاركات والتفعيل وفلاتر الأعمدة تبقى على
  // حالها، ولا يحتاج المستخدم إعادة تفعيل شيء بعد الدمج.
  let target = files.find(f => f.isCumulative)
    ?? await prisma.uploadedFile.findFirst({ where: { userId, isCumulative: true, mergeGroup: group } });
  const targetWasCumulative = !!target;
  if (!target) {
    target = await prisma.uploadedFile.update({
      where: { id: sample.id },
      data: {
        isCumulative: true,
        mergeGroup:   group,
        originalName: cumulativeFileName({ sourceSystem: sample.sourceSystem, detectedCurrency: sample.detectedCurrency }),
      },
    });
  } else if (!target.mergeGroup) {
    target = await prisma.uploadedFile.update({ where: { id: target.id }, data: { mergeGroup: group } });
  }

  // بصمات الصفوف الموجودة أصلاً في الهدف: تُحسب الآن لأن صفوفه قد تكون من زمن
  // ما قبل هذه الميزة (dedupKey فارغ) فلا شيء يمنع إعادة إدخال ما فيها.
  //
  // ⚠️ هدف تراكمي قائم يحمل عدة رفعات: لا يُختم بعدّاد واحد للملف كله (كما
  // يفعل stampFileRows) — رقم التكرار وقت الرفع كان لكل رفعة على حدة، فالختم
  // بعدّاد واحد يُنتج بصمات لا تطابق إعادة رفع أي رفعة منها. auditCumulativeFile
  // يختمه بقواعد الرفع نفسها ويُسقط ما تكرّر بين رفعاته.
  let used;
  let skipped = 0;
  if (targetWasCumulative) {
    const audit = await auditCumulativeFile(target.id, { apply: true });
    skipped = audit.removed;
    used = await loadFileKeys(target.id);
  } else {
    used = new Set();
    const self = await stampFileRows({ fileId: target.id, targetFileId: target.id, used, batchId: null });
    skipped = self.skipped; // تكرار كان داخل الهدف نفسه
  }
  // صفوف الهدف نفسه (الملف الأول المُرقّى) تأخذ سجل رفعة باسمه، كي تظهر في
  // قائمة الرفعات ويمكن إيقافها/حذفها كأي رفعة أخرى.
  await ensureLegacyBatch(target);

  let moved   = 0;
  const deletedFiles = [];

  for (const src of files) {
    if (src.id === target.id) continue;
    const batch = await openMergeBatch({
      fileId:         target.id,
      originalName:   src.originalName,
      uploadedBy:     src.uploadedBy,
      fileType:       src.fileType,
      storedFilename: src.filename,
    });
    const res = await stampFileRows({ fileId: src.id, targetFileId: target.id, used, batchId: batch.id });
    await closeMergeBatch(batch.id, { rowsAdded: res.moved, rowsSkipped: res.skipped, monthsLabel: res.monthsLabel });
    moved   += res.moved;
    skipped += res.skipped;

    // المشاركات تُورَّث للهدف قبل حذف المصدر، وإلا فقد مَن كان يرى الملف رؤيته.
    const shares = await prisma.fileUserShare.findMany({ where: { fileId: src.id }, select: { userId: true } });
    if (shares.length > 0) {
      await prisma.fileUserShare.createMany({
        data: shares.map(s => ({ fileId: target.id, userId: s.userId })),
        skipDuplicates: true,
      });
    }
    if (src.sharedWithRepId && !target.sharedWithRepId) {
      await prisma.uploadedFile.update({ where: { id: target.id }, data: { sharedWithRepId: src.sharedWithRepId } });
      target.sharedWithRepId = src.sharedWithRepId;
    }

    // الملف المصدر صار فارغاً (كل صفوفه نُقلت أو حُذفت كمكررة) فحذفه لا يُفقد
    // بياناتٍ — ولهذا لا يمرّ بتنظيف المناديب/المناطق اليتيمة في DELETE /api/files/:id.
    await prisma.uploadedFile.delete({ where: { id: src.id } });
    deletedFiles.push({ id: src.id, originalName: src.originalName });
  }

  const refreshed = await refreshCumulativeFile(target.id);
  return {
    targetFileId: target.id,
    fileName:     refreshed.originalName,
    moved,
    skipped,
    totalRows:    refreshed.rowCount,
    deletedFiles,
  };
}

/** كل بصمات ملف (بعد ختمها) — مجموعة «المحجوز» التي تُقارَن بها الملفات المصدر. */
async function loadFileKeys(fileId) {
  const used = new Set();
  let cursor = 0;
  for (;;) {
    const rows = await prisma.sale.findMany({
      where: { uploadedFileId: fileId, id: { gt: cursor } },
      orderBy: { id: 'asc' }, take: 5000, select: { id: true, dedupKey: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const r of rows) if (r.dedupKey) used.add(r.dedupKey);
  }
  return used;
}

/**
 * يمرّ على صفوف ملف دفعةً دفعة: يحسب بصمة كل صف، ينقله إلى الملف الهدف إن كانت
 * بصمته جديدة، ويحذفه إن كانت مستعملة. حين fileId === targetFileId يكتفي بختم
 * الصفوف في مكانها (لا نقل) — وهي الحالة التي نُجهّز بها صفوف الهدف نفسه.
 */
async function stampFileRows({ fileId, targetFileId, used, batchId }) {
  const inPlace  = fileId === targetFileId;
  const counters = new Map(); // رقم التكرار — لكل ملف مصدر على حدة
  const CHUNK = 1000;
  let cursor  = 0;
  let moved   = 0;
  let skipped = 0;
  const dates = [];

  for (;;) {
    const rows = await prisma.sale.findMany({
      where:   { uploadedFileId: fileId, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take:    CHUNK,
      select:  {
        id: true, rawData: true, itemId: true, customerId: true,
        recordType: true, quantity: true, totalValue: true, saleDate: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const keys     = fingerprintRows(rows, counters);
    const toDelete = [];
    const dupKeys  = [];
    const updates  = [];

    rows.forEach((row, i) => {
      const key = keys[i];
      // بصمة مستعملة = نفس الصف موجود في الهدف. يُحذف بدل أن يُنقل — وهذا
      // بالضبط «ضمان عدم التكرار» حين يُرفع ملفان متداخلان أو الملف نفسه مرتين.
      if (used.has(key)) { skipped++; toDelete.push(row.id); dupKeys.push(key); return; }
      used.add(key);
      const undated = !rawHasDate(row.rawData);
      dates.push(undated ? UNDATED_SENTINEL : row.saleDate);
      updates.push({
        id:   row.id,
        data: {
          dedupKey: key,
          ...(inPlace ? {} : { uploadedFileId: targetFileId, mergeBatchId: batchId }),
          // صفّ بلا تاريخ في الإكسل كان يحمل لحظة الرفع؛ داخل ملف تراكمي يُرفع
          // عليه كل شهر هذا يجعله «مبيعاً» في شهر الرفع. العلامة الحارسة تُنهي
          // اللبس وتجعله يظهر في شريحة «بلا تاريخ» وحدها.
          ...(undated ? { saleDate: UNDATED_SENTINEL } : {}),
        },
      });
      if (!inPlace) moved++;
    });

    if (toDelete.length > 0) await prisma.sale.deleteMany({ where: { id: { in: toDelete } } });
    // الرفعة «كانت تحمل» هذه الصفوف — ترثها لو أُوقفت/حُذفت الرفعة المالكة.
    if (batchId != null && dupKeys.length > 0) {
      await prisma.fileMergeBatchDupKey.createMany({
        data: dupKeys.map(k => ({ batchId, fileId: targetFileId, dedupKey: k })),
        skipDuplicates: true,
      });
    }
    await bulkUpdateRows(updates, targetFileId, batchId, inPlace);
  }

  return { moved, skipped, monthsLabel: monthsLabelOf(dates) };
}

/**
 * تحديث دفعة صفوف بقيم مختلفة لكل صف — عبر `UPDATE … FROM (VALUES …)`.
 *
 * ⚠️ لماذا ليس حلقة من prisma.sale.update: البصمة تختلف لكل صف فلا مجال
 * لـupdateMany، والحلقة كانت ستُطلق استعلاماً لكل صف — ملفُ شهرٍ واحد فيه ~48
 * ألف صف (راجع ذاكرة project_pharma_pharmacy_net_grouping)، فدمج أربعة ملفات
 * = ~200 ألف ذهاب وإياب إلى قاعدة البيانات. هذا يتجاوز مهلة الطلب بسهولة ويترك
 * الدمج منصوفاً في المنتصف. العبارة المجمّعة تختصره إلى استعلام واحد لكل دفعة.
 *
 * الأمان: الأعداد تُصفّى بـNumber.isInteger، والبصمة نصّ base64url (حروف وأرقام
 * و`-`/`_` فقط) يُتحقَّق منه صراحةً قبل الإدماج — فلا سطح حقن في النص المبني.
 */
async function bulkUpdateRows(updates, targetFileId, batchId, inPlace) {
  if (updates.length === 0) return;
  const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/; // النقطة لبادئة الإصدار ("2.")
  const tuples = [];
  for (const u of updates) {
    const id = Number(u.id);
    const key = u.data.dedupKey;
    if (!Number.isInteger(id) || !KEY_RE.test(key)) continue;
    // null = «لا تغيّر هذا العمود» (COALESCE أدناه) — الصفوف المؤرَّخة تحتفظ
    // بتاريخها، والصفوف بلا تاريخ وحدها تُكتب بالعلامة الحارسة.
    const date = u.data.saleDate ? `'${new Date(u.data.saleDate).toISOString()}'::timestamp` : 'NULL::timestamp';
    tuples.push(`(${id}, '${key}', ${date})`);
  }
  if (tuples.length === 0) return;

  const moveCols = inPlace
    ? ''
    : `, "uploadedFileId" = ${Number(targetFileId)}, "mergeBatchId" = ${batchId == null ? 'NULL' : Number(batchId)}`;

  await prisma.$executeRawUnsafe(
    `UPDATE sales AS s
        SET "dedupKey" = v.k,
            "saleDate" = COALESCE(v.d, s."saleDate")${moveCols}
       FROM (VALUES ${tuples.join(',')}) AS v(id, k, d)
      WHERE s.id = v.id`,
  );
}
