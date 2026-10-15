// ════════════════════════════════════════════════════════════════════════════
// cumulativeFile.js — «الملف التراكمي»: ملف واحد يبلع رفعات كل الأشهر.
//
// قبلها: كل رفعة إكسل = UploadedFile مستقل، فقائمة الملفات تطول شهراً بعد شهر،
// والتحليل يتطلّب تفعيل عدة ملفات معاً، وإعادة رفع الملف نفسه تُضاعف المبيع
// بصمت (الاستيراد لا يُسقط أي صف — راجع crossFileDedup.js).
//
// بعدها: لكل (حساب × مصدر × عملة) ملفٌ تراكمي واحد تنصهر فيه الرفعات. المصدر
// (مكتب/ميركاتو) والعملة يفصلان المجموعات لأسباب لا تقبل الخلط — راجع
// mergeGroupKey في saleFingerprint.js. منع التكرار يتم بقيد قاعدة البيانات
// الفريد (uploadedFileId, dedupKey) لا بفحص في الذاكرة.
//
// كل رفعة تُسجَّل كـFileMergeBatch داخل الملف، فيبقى واضحاً «شنو جوّا الملف»
// ويمكن التراجع عن رفعة واحدة بلا مساس بالباقي.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { fingerprintRows, mergeGroupKey, cumulativeFileName } from './saleFingerprint.js';
import { UNDATED_SENTINEL, UNDATED_CUTOFF, monthLabel } from './salesMonths.js';
import { ensureCumulativeKeysCurrent } from './cumulativeAudit.js';

/** أنواع الملفات التي لا تدخل نظام التراكم إطلاقاً (أدوات منفصلة بذاتها). */
const NON_MERGEABLE_TYPES = new Set(['filter_page', 'pharmacy_net']);

export function isMergeableType(fileType) {
  return !NON_MERGEABLE_TYPES.has(fileType);
}

/**
 * يجد الملف التراكمي الذي تنتمي إليه رفعة ما، أو يُنشئه.
 *
 * البحث بـmergeGroup لا باسم الملف: المستخدم حرّ في إعادة تسمية الملف التراكمي
 * (PATCH /api/files/:id/rename) ويجب أن تستمر الرفعات بالانصهار فيه بعدها.
 *
 * @returns {Promise<{ file: object, created: boolean }>}
 */
export async function resolveCumulativeTarget({ userId, sourceSystem = null, detectedCurrency = 'IQD', variant = null }) {
  const group = mergeGroupKey({ userId, sourceSystem, detectedCurrency, variant });
  const existing = await prisma.uploadedFile.findFirst({
    where: { userId, isCumulative: true, mergeGroup: group },
    orderBy: { id: 'asc' },
  });
  if (existing) return { file: existing, created: false };

  const name = cumulativeFileName({ sourceSystem, detectedCurrency, variant });
  const file = await prisma.uploadedFile.create({
    data: {
      filename:         `cumulative_${group.replace(/[^a-zA-Z0-9]/g, '_')}`,
      originalName:     name,
      rowCount:         0,
      userId,
      fileType:         'sales',
      sourceSystem,
      detectedCurrency,
      currencyMode:     detectedCurrency,
      isCumulative:     true,
      mergeGroup:       group,
    },
  });
  return { file, created: true };
}

/**
 * يُنشئ سجلّ الرفعة **قبل** إدراج الصفوف — لأن createMany لا يُرجع المعرّفات،
 * فلا سبيل لربط الصفوف بدفعتها بعد الإدراج. rowsAdded/rowsSkipped تُحدَّث بعده.
 */
export async function openMergeBatch({ fileId, originalName, uploadedBy, fileType = 'sales', storedFilename = null }) {
  return prisma.fileMergeBatch.create({
    data: { fileId, originalName, uploadedBy: uploadedBy || null, fileType, storedFilename },
  });
}

export async function closeMergeBatch(batchId, { rowsAdded, rowsSkipped, monthsLabel }) {
  return prisma.fileMergeBatch.update({
    where: { id: batchId },
    data: { rowsAdded, rowsSkipped, monthsLabel: monthsLabel || null },
  });
}

/**
 * يُعيد مزامنة بيانات الملف التراكمي بعد تغيّر صفوفه:
 *  - rowCount = العدد الفعلي.
 *  - fileType = 'auto' حين يحمل مبيعاً وارجاعاً معاً، وإلا نوع ما يحمله.
 *  - uploadedAt = الآن، كي تُرتَّب القائمة بآخر نشاط فعلي.
 *
 * ⚠️ تحريك uploadedAt آمن هنا تحديداً لأن الصفوف بلا تاريخ في الملف التراكمي
 * تحمل UNDATED_SENTINEL لا لحظةَ الرفع، فحارسُ «بلا تاريخ» في التحليل الشامل
 * لم يعد يعتمد على uploadedAt لهذه الملفات (راجع salesMonths.js).
 */
export async function refreshCumulativeFile(fileId) {
  const [total, salesCount, returnsCount] = await Promise.all([
    prisma.sale.count({ where: { uploadedFileId: fileId } }),
    prisma.sale.count({ where: { uploadedFileId: fileId, recordType: 'sale' } }),
    prisma.sale.count({ where: { uploadedFileId: fileId, recordType: 'return' } }),
  ]);
  const fileType = salesCount > 0 && returnsCount > 0 ? 'auto' : returnsCount > 0 ? 'returns' : 'sales';
  return prisma.uploadedFile.update({
    where: { id: fileId },
    data:  { rowCount: total, fileType, uploadedAt: new Date() },
  });
}

/** أشهر دفعة من الصفوف، كنصّ عرض مختصر ("9/2026، 10/2026"). */
export function monthsLabelOf(dates) {
  const set = new Set();
  let undated = false;
  for (const d of dates) {
    if (!d || new Date(d) < UNDATED_CUTOFF) { undated = true; continue; }
    const dt = new Date(d);
    set.add(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const parts = [...set].sort().map(ym => monthLabel(ym).short);
  if (undated) parts.push('بلا تاريخ');
  return parts.join('، ');
}

/**
 * يُدرج صفوف رفعة داخل ملف تراكمي، مُسقطاً ما سبق إدخاله.
 *
 * @param {object} args
 * @param {number} args.fileId       الملف التراكمي الهدف
 * @param {number} args.batchId      سجلّ الرفعة (FileMergeBatch)
 * @param {Array}  args.saleRows     صفوف جاهزة للإدراج (recordType = 'sale')
 * @param {Array}  args.returnRows   صفوف جاهزة للإدراج (recordType = 'return')
 * @param {number|null} args.userId
 * @returns {Promise<{ added: number, skipped: number }>}
 */
export async function appendRowsToCumulative({ fileId, batchId, saleRows = [], returnRows = [], userId = null }) {
  // ملف ما زال يحمل بصمات الإصدار 1 يُختم أولاً (ويُنظَّف من خلله) — وإلا لم
  // تتطابق بصمات هذه الرفعة (v2) مع أيٍّ من صفوفه وتضاعف كل ما يُعاد رفعه.
  const restamp = await ensureCumulativeKeysCurrent(fileId);
  if (restamp) console.log(`[cumulative] file #${fileId} أُعيد ختمه قبل الرفعة: ${restamp.removed} مكرر حُذف`);

  // عدّاد واحد للرفعة كلها: صفوف المبيع والإرجاع تُرقَّم في فضاء واحد كي لا
  // يتصادم ترقيمها (recordType جزء من مفتاح المحتوى أصلاً فلا تختلط عملياً،
  // لكن العدّاد المشترك يجعل الترتيب مستقرّاً في كلتا الحالتين).
  const counters = new Map();
  const prepare = (rows, recordType) => {
    const withType = rows.map(r => ({ ...r, recordType }));
    const keys = fingerprintRows(withType, counters);
    return withType.map((r, i) => ({
      representativeId: r.representativeId,
      areaId:           r.areaId,
      itemId:           r.itemId,
      customerId:       r.customerId ?? null,
      quantity:         r.quantity,
      totalValue:       r.totalValue,
      // صف بلا تاريخ في الإكسل يأخذ العلامة الحارسة صراحةً بدل @default(now()).
      saleDate:         r.saleDate ?? UNDATED_SENTINEL,
      uploadedFileId:   fileId,
      rawData:          r.rawData ?? null,
      customerInfoNorm: r.customerInfoNorm ?? null,
      userId,
      recordType,
      dedupKey:         keys[i],
      mergeBatchId:     batchId,
    }));
  };

  const payload = [...prepare(saleRows, 'sale'), ...prepare(returnRows, 'return')];
  if (payload.length === 0) return { added: 0, skipped: 0, monthsLabel: '' };

  // الإدراج على دفعات: دفعة واحدة بعشرات آلاف الصفوف تتجاوز سقف بارامترات
  // Postgres وتُنفخ ذاكرة العملية. skipDuplicates يترك القيد الفريد
  // (uploadedFileId, dedupKey) يُسقط ما سبق إدخاله بلا أي فحص في الذاكرة.
  const CHUNK = 2000;
  let added = 0;
  const inactiveIds = await inactiveBatchIds(fileId);
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const res = await prisma.sale.createMany({ data: chunk, skipDuplicates: true });
    added += res.count;
    if (res.count < chunk.length) {
      added += await claimSkippedKeys({ fileId, batchId, keys: chunk.map(r => r.dedupKey), inactiveIds });
    }
  }
  return {
    added,
    skipped: payload.length - added,
    monthsLabel: monthsLabelOf(payload.map(r => r.saleDate)),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// إدارة الرفعات داخل الملف التراكمي: إيقاف/تفعيل/حذف رفعة واحدة «كأنها لم تُرفع».
//
// الصف المكرر بين رفعتين يُخزَّن مرة واحدة ويُنسب للرفعة الأقدم (mergeBatchId)،
// والرفعة الأحدث تتذكّر أنها «كانت تحمله» في FileMergeBatchDupKey. لذلك إيقاف
// أو حذف رفعة لا يعني إخفاء/حذف كل صفوفها: ما تحمله رفعة أخرى فعّالة يُورَّث
// لها ويبقى ظاهراً، وما انفردت به وحده يختفي. بلا هذا التوريث كان حذف «مبيع
// شهر 10» يُسقط معه صفوفاً موجودة فعلاً في «اليزن (1)» الباقية.
//
// ⚠️ الإخفاء عبر Sale.isHidden: كل استعلامات التقارير تستثنيه أصلاً (فلاتر
// الأعمدة)، فلا حاجة لتعديل عشرات الاستعلامات. فلاتر الأعمدة تعيد حساب isHidden
// من الصفر، لذا تستدعي reapplyInactiveBatches بعدها كي لا تُظهر رفعة موقوفة.
//
// ⚠️ رفعات ما قبل هذا التحديث لم تُسجَّل بصماتها المكررة، فلا وريث لها: حذف
// رفعة قديمة يُسقط صفوفها المشتركة مع رفعة قديمة أخرى (السلوك السابق نفسه).
// ════════════════════════════════════════════════════════════════════════════

async function inactiveBatchIds(fileId) {
  const rows = await prisma.fileMergeBatch.findMany({ where: { fileId, isActive: false }, select: { id: true } });
  return new Set(rows.map(b => b.id));
}

/**
 * بعد createMany: البصمات التي أُسقطت لأنها موجودة أصلاً في الملف.
 *  - مالكها رفعة فعّالة → تُسجَّل كـ«كانت هذه الرفعة تحملها أيضاً».
 *  - مالكها رفعة موقوفة → الرفعة الجديدة تتبنّى الصف وتُظهره (وإلا رُفع الملف
 *    ولم يظهر منه شيء)، والموقوفة تُسجَّل كحاملة له.
 * @returns {Promise<number>} عدد الصفوف المتبنّاة (تُحسب ضمن المُضاف)
 */
async function claimSkippedKeys({ fileId, batchId, keys, inactiveIds }) {
  const owners = await prisma.sale.findMany({
    where: {
      uploadedFileId: fileId,
      dedupKey: { in: keys.filter(Boolean) },
      OR: [{ mergeBatchId: null }, { mergeBatchId: { not: batchId } }],
    },
    select: { id: true, dedupKey: true, mergeBatchId: true },
  });
  if (owners.length === 0) return 0;

  const adopt = owners.filter(o => inactiveIds.has(o.mergeBatchId));
  const dup   = owners.filter(o => !inactiveIds.has(o.mergeBatchId));
  if (dup.length > 0) {
    await prisma.fileMergeBatchDupKey.createMany({
      data: dup.map(o => ({ batchId, fileId, dedupKey: o.dedupKey })),
      skipDuplicates: true,
    });
  }
  if (adopt.length > 0) {
    await prisma.sale.updateMany({
      where: { id: { in: adopt.map(o => o.id) } },
      data:  { mergeBatchId: batchId, isHidden: false },
    });
    await prisma.fileMergeBatchDupKey.createMany({
      data: adopt.map(o => ({ batchId: o.mergeBatchId, fileId, dedupKey: o.dedupKey })),
      skipDuplicates: true,
    });
    for (const [oldId, n] of countBy(adopt, o => o.mergeBatchId)) {
      await prisma.fileMergeBatch.update({
        where: { id: oldId },
        data:  { rowsAdded: { decrement: n }, rowsSkipped: { increment: n } },
      });
    }
  }
  return adopt.length;
}

function countBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

/** يُبقي صفوف الرفعات الموقوفة مخفية بعد أي إعادة حساب لـisHidden. */
export async function reapplyInactiveBatches(fileId) {
  const ids = [...await inactiveBatchIds(fileId)];
  if (ids.length === 0) return 0;
  const res = await prisma.sale.updateMany({
    where: { uploadedFileId: fileId, mergeBatchId: { in: ids }, isHidden: false },
    data:  { isHidden: true },
  });
  return res.count;
}

/**
 * «الملف الأول»: حين تُدمج ملفات قديمة يُرقّى أقدمها نفسه إلى الحاوية التراكمية،
 * فتبقى صفوفه بلا mergeBatchId — لا تظهر في قائمة الرفعات ولا يمكن إيقافها أو
 * حذفها وحدها. هنا تُنسب لسجل رفعة باسمه الأصلي (من اسم الملف المحفوظ).
 */
export async function ensureLegacyBatch(file) {
  if (!file?.isCumulative) return null;
  const agg = await prisma.sale.aggregate({
    where:  { uploadedFileId: file.id, mergeBatchId: null },
    _count: { _all: true },
    _min:   { createdAt: true },
  });
  const n = agg._count._all;
  if (!n) return null;

  // الاسم المحفوظ "<timestamp>_<الاسم الأصلي>"؛ الحاوية المُنشأة من الرفع تحمل "cumulative_…".
  const stored   = String(file.filename || '');
  const realName = stored && !stored.startsWith('cumulative_') ? stored.replace(/^\d+_/, '') : null;
  const dates = await prisma.sale.groupBy({
    by: ['saleDate'], where: { uploadedFileId: file.id, mergeBatchId: null },
  });
  const batch = await prisma.fileMergeBatch.create({
    data: {
      fileId:         file.id,
      originalName:   realName || 'الملف الأول (قبل التراكم)',
      uploadedAt:     agg._min.createdAt ?? new Date(),
      uploadedBy:     file.uploadedBy || null,
      fileType:       file.fileType === 'returns' ? 'returns' : 'sales',
      storedFilename: realName ? stored : null,
      rowsAdded:      n,
      monthsLabel:    monthsLabelOf(dates.map(d => d.saleDate)) || null,
    },
  });
  const res = await prisma.sale.updateMany({
    where: { uploadedFileId: file.id, mergeBatchId: null },
    data:  { mergeBatchId: batch.id },
  });
  // طلبان متزامنان: الثاني لم يجد صفوفاً يتبنّاها — لا نترك سجلاً فارغاً.
  if (res.count === 0) { await prisma.fileMergeBatch.delete({ where: { id: batch.id } }); return null; }
  if (res.count !== n) await prisma.fileMergeBatch.update({ where: { id: batch.id }, data: { rowsAdded: res.count } });
  return batch;
}

/**
 * يُخرج رفعة من الملف: mode='delete' تحذفها نهائياً، mode='deactivate' توقفها.
 * صفوفها التي تحملها رفعة أخرى فعّالة تُورَّث لتلك الرفعة (تبقى ظاهرة)، والباقي
 * يُحذف أو يُخفى.
 */
export async function releaseBatch({ fileId, batchId, mode }) {
  const batch = await prisma.fileMergeBatch.findFirst({ where: { id: batchId, fileId } });
  if (!batch) throw Object.assign(new Error('الرفعة غير موجودة داخل هذا الملف'), { status: 404 });
  if (mode === 'deactivate' && !batch.isActive) return { handed: 0, released: 0 };

  const heirs = await prisma.fileMergeBatch.findMany({
    where: { fileId, isActive: true, id: { not: batchId } }, select: { id: true },
  });
  const heirIds = heirs.map(h => h.id);
  const handedPerHeir = new Map();
  let cursor = 0, handed = 0, released = 0;

  for (;;) {
    const rows = await prisma.sale.findMany({
      where:   { uploadedFileId: fileId, mergeBatchId: batchId, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take:    2000,
      select:  { id: true, dedupKey: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const keys = rows.map(r => r.dedupKey).filter(Boolean);
    const claims = heirIds.length && keys.length
      ? await prisma.fileMergeBatchDupKey.findMany({
          where:   { fileId, batchId: { in: heirIds }, dedupKey: { in: keys } },
          orderBy: { batchId: 'asc' }, // الأقدم يرث أولاً
          select:  { id: true, batchId: true, dedupKey: true },
        })
      : [];
    const heirOf = new Map();
    const usedClaims = [];
    for (const c of claims) {
      if (heirOf.has(c.dedupKey)) continue;
      heirOf.set(c.dedupKey, c.batchId);
      usedClaims.push(c.id);
    }

    const byHeir = new Map();
    const orphanIds = [];
    const handedKeys = [];
    for (const r of rows) {
      const h = r.dedupKey ? heirOf.get(r.dedupKey) : undefined;
      if (h) {
        if (!byHeir.has(h)) byHeir.set(h, []);
        byHeir.get(h).push(r.id);
        handedKeys.push(r.dedupKey);
      } else orphanIds.push(r.id);
    }

    for (const [h, ids] of byHeir) {
      await prisma.sale.updateMany({
        where: { id: { in: ids } },
        // رفعة موقوفة تُحذف: صفوفها مخفية، والوريث الفعّال يُظهرها.
        data:  { mergeBatchId: h, ...(batch.isActive ? {} : { isHidden: false }) },
      });
      handedPerHeir.set(h, (handedPerHeir.get(h) || 0) + ids.length);
      handed += ids.length;
    }
    if (usedClaims.length) await prisma.fileMergeBatchDupKey.deleteMany({ where: { id: { in: usedClaims } } });
    // الموقوفة تتذكّر أنها كانت تحمل ما ورّثته — فيعود لها لو حُذف الوريث لاحقاً.
    if (mode === 'deactivate' && handedKeys.length) {
      await prisma.fileMergeBatchDupKey.createMany({
        data: handedKeys.map(k => ({ batchId, fileId, dedupKey: k })),
        skipDuplicates: true,
      });
    }
    if (orphanIds.length) {
      if (mode === 'delete') await prisma.sale.deleteMany({ where: { id: { in: orphanIds } } });
      else await prisma.sale.updateMany({ where: { id: { in: orphanIds } }, data: { isHidden: true } });
      released += orphanIds.length;
    }
  }

  for (const [h, n] of handedPerHeir) {
    await prisma.fileMergeBatch.update({
      where: { id: h },
      data:  { rowsAdded: { increment: n }, rowsSkipped: { decrement: n } },
    });
  }
  if (mode === 'delete') {
    await prisma.fileMergeBatch.delete({ where: { id: batchId } }); // بصماته تُحذف معه (Cascade)
  } else {
    await prisma.fileMergeBatch.update({
      where: { id: batchId },
      data:  { isActive: false, rowsAdded: { decrement: handed }, rowsSkipped: { increment: handed } },
    });
  }
  return { handed, released };
}

/** يُعيد تفعيل رفعة موقوفة: صفوفها المملوكة تظهر من جديد. */
export async function reactivateBatch({ fileId, batchId }) {
  const batch = await prisma.fileMergeBatch.findFirst({ where: { id: batchId, fileId } });
  if (!batch) throw Object.assign(new Error('الرفعة غير موجودة داخل هذا الملف'), { status: 404 });
  if (batch.isActive) return { shown: 0 };
  await prisma.fileMergeBatch.update({ where: { id: batchId }, data: { isActive: true } });
  const res = await prisma.sale.updateMany({
    where: { uploadedFileId: fileId, mergeBatchId: batchId, isHidden: true },
    data:  { isHidden: false },
  });
  return { shown: res.count };
}

/**
 * أول/آخر تاريخ طلبية لكل رفعة — يشمل الصفوف التي حملتها الرفعة وأُسقطت كمكررة
 * (هي جزء من ملفها فعلاً)، ويستثني الصفوف بلا تاريخ (العلامة الحارسة 1970).
 */
export async function batchDateRanges(fileId) {
  const rows = await prisma.$queryRaw`
    SELECT x.bid AS "batchId", MIN(x.d) AS "firstDate", MAX(x.d) AS "lastDate"
      FROM (
        SELECT s."mergeBatchId" AS bid, s."saleDate" AS d
          FROM sales s
         WHERE s."uploadedFileId" = ${fileId} AND s."saleDate" >= ${UNDATED_CUTOFF}
        UNION ALL
        SELECT k."batchId" AS bid, s."saleDate" AS d
          FROM file_merge_batch_dup_keys k
          JOIN sales s ON s."uploadedFileId" = k."fileId" AND s."dedupKey" = k."dedupKey"
         WHERE k."fileId" = ${fileId} AND s."saleDate" >= ${UNDATED_CUTOFF}
      ) x
     GROUP BY x.bid`;
  const map = new Map();
  for (const r of rows) {
    if (r.batchId == null) continue;
    map.set(Number(r.batchId), { firstDate: r.firstDate, lastDate: r.lastDate });
  }
  return map;
}
