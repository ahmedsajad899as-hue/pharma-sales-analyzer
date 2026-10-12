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
export async function resolveCumulativeTarget({ userId, sourceSystem = null, detectedCurrency = 'IQD' }) {
  const group = mergeGroupKey({ userId, sourceSystem, detectedCurrency });
  const existing = await prisma.uploadedFile.findFirst({
    where: { userId, isCumulative: true, mergeGroup: group },
    orderBy: { id: 'asc' },
  });
  if (existing) return { file: existing, created: false };

  const name = cumulativeFileName({ sourceSystem, detectedCurrency });
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
  for (let i = 0; i < payload.length; i += CHUNK) {
    const res = await prisma.sale.createMany({ data: payload.slice(i, i + CHUNK), skipDuplicates: true });
    added += res.count;
  }
  return {
    added,
    skipped: payload.length - added,
    monthsLabel: monthsLabelOf(payload.map(r => r.saleDate)),
  };
}
