// ════════════════════════════════════════════════════════════════════════════
// cumulativeSupersede.js — «أحدث ملف هو الصحيح لفترته» (المرحلة 2 من الرفع اليومي).
//
// المشكلة: ملفات المكتب وميركاتو تُصدَّر «من أول الشهر حتى اليوم» وتُرفع كل يوم. البصمة
// (saleFingerprint.js) تُسقط الصف المكرر، لكنها لا تفهم التعديل: صف تغيّرت كميته أو
// قيمته يأخذ بصمة جديدة فيُضاف، وتبقى نسخته القديمة فيُحسب مرتين؛ وطلبية أُلغيت تبقى.
//
// الحل: صفوف رفعات سابقة في الملف التراكمي نفسه، داخل فترة الرفعة الجديدة (من أول يوم
// إلى آخر يوم فيها) ومن نوعها (مبيع/إرجاع)، وغير موجودة فيها ← «مُستبدَلة». قسمان:
//   • changed: طلبيتها (رقم الطلبية + الصيدلية) ما زالت في الملف الجديد بأسطر أخرى —
//     الملف الجديد يحسم هذه الطلبية، فإخفاء النسخة القديمة آمن.
//   • vanished: الطلبية كلها غابت، ورفعتها السابقة نسخة أقدم من هذا الملف (أغلب صفوفها
//     في الفترة موجودة فيه) ← أُلغيت. تُخفى افتراضياً.
//   • foreign: غابت، لكن رفعتها ملف آخر (أغلب صفوفها ليست في هذا الملف): ملف مكمّل رُفع
//     لنفس الفترة، أو أن الملف الجديد جزئي (منطقة/شركة). لا تُخفى إلا باختيار صريح.
//   الحكم لكل رفعة سابقة وحدها لا للفترة كلها: ملف المكتب الكامل يحوي 94% من الفترة،
//   لكن صف ملف صغير آخر رُفع في الفترة نفسها ليس «ملغى» (وجدناه في تجربة الواجهة).
//
// لا يُحذف شيء: الصفوف المُستبدَلة تُنقل إلى رفعة موقوفة «مُستبدَل بـ…» في قائمة رفعات
// الملف (آلية الإيقاف القائمة: Sale.isHidden + reapplyInactiveBatches)، فتعود بإعادة
// تفعيلها، وتُحذف نهائياً بحذفها. لا تُستدعى إلا من «الرفع الذكي» باختيار صريح.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { contentKey, fingerprintRows } from './saleFingerprint.js';
import { monthsLabelOf } from './cumulativeFile.js';
import { UNDATED_CUTOFF } from './salesMonths.js';

/** رفعة سابقة يحوي الملف الجديد هذه النسبة من صفوفها (في فترته) أو أكثر = نسخة أقدم منه. */
export const SAME_SERIES_MIN_COVERAGE = 0.5;
export const SUPERSEDE_KINDS = ['changed', 'vanished', 'foreign'];

/**
 * أنواع السجلات التي تحسمها رفعة: ملف المبيعات لا يمسّ الإرجاع والعكس — إلا إن حمل الملف
 * النوع الآخر فعلاً. ملف «مبيعات» فيه ورقة «ارجاع» (يقرؤها المحلّل إرجاعاً بإجبار اسم الورقة)
 * يحسم إرجاع فترته أيضاً: SYSTEM SALE'S 21-11 رُفع «مبيعات» فبقيت 13 فاتورة إرجاع أُلغيت
 * من التصدير الأحدث (36 مليون) ظاهرةً من رفعة 17/11.
 * @param {string} fileType
 * @param {{sales?:number, returns?:number}} [counts] عدد صفوف كل نوع في الرفعة
 */
export function recordTypesForUpload(fileType, counts = {}) {
  const types = new Set(fileType === 'returns' ? ['return'] : fileType === 'auto' ? ['sale', 'return'] : ['sale']);
  if (counts.sales > 0) types.add('sale');
  if (counts.returns > 0) types.add('return');
  return [...types];
}

/** من أول يوم إلى آخر يوم (UTC) في الرفعة؛ الصفوف بلا تاريخ خارجها. null = لا تواريخ. */
export function uploadDayRange(dates) {
  let min = null, max = null;
  for (const v of dates) {
    const d = v ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime()) || d < UNDATED_CUTOFF) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  if (!min) return null;
  const start = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), min.getUTCDate()));
  const end = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth(), max.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

/** «رقم الطلبية + الصيدلية + النوع» من مفتاح المحتوى نفسه؛ null حين لا رقم طلبية. */
function orderIdentity(row) {
  const [orderNo, , pharmacy, , , recordType] = contentKey(row).split('|');
  return orderNo ? `${orderNo}|${pharmacy}|${recordType}` : null;
}

/** صف أدخله التطبيق (فاتورة يدوية، طلبية بوت، مبيع مندوب…) لا الإكسل — لا يحسمه أي ملف. */
function isAppEnteredRow(rawData) {
  if (!rawData) return false;
  try {
    const raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return typeof raw?.source === 'string' && raw.source.trim() !== '';
  } catch { return false; }
}

/**
 * بصمات الرفعة وطلبياتها بالترتيب نفسه الذي يختمها به appendRowsToCumulative (مبيعات ثم
 * إرجاع، بعدّاد واحد).
 * @param {Array} saleRows صفوف بشكل contentKey (rawData/itemId/customerId/quantity/totalValue)
 * @param {Array} returnRows
 */
export function uploadIndex(saleRows, returnRows) {
  const counters = new Map();
  const sales = saleRows.map(r => ({ ...r, recordType: 'sale' }));
  const returns = returnRows.map(r => ({ ...r, recordType: 'return' }));
  const keys = [...fingerprintRows(sales, counters), ...fingerprintRows(returns, counters)];
  const orders = new Set([...sales, ...returns].map(orderIdentity).filter(Boolean));
  return { keys, keySet: new Set(keys), orders };
}

const summarize = (rows) => ({
  count: rows.length,
  value: rows.reduce((s, r) => s + (Number(r.totalValue) || 0), 0),
  sample: rows.slice(0, 8).map(r => ({
    date: r.saleDate ? new Date(r.saleDate).toISOString().slice(0, 10) : null,
    pharmacy: r.customer?.name ?? null,
    item: r.item?.name ?? null,
    quantity: r.quantity,
    value: r.totalValue,
    type: r.recordType,
  })),
});

/**
 * صفوف الملف التي تحسمها هذه الرفعة.
 * @param {object} p
 * @param {number} p.fileId الملف التراكمي
 * @param {Set<string>} p.keySet بصمات الرفعة كلها
 * @param {Set<string>} p.orders طلبيات الرفعة (orderIdentity)
 * @param {{start:Date,end:Date}} p.range
 * @param {string[]} p.recordTypes
 * @returns {Promise<{range, inRange:number, matched:number, coverage:number, changed:object, vanished:object, rows:{changed:Array, vanished:Array}}>}
 */
export async function findSupersededRows({ fileId, keySet, orders, range, recordTypes }) {
  const candidates = await prisma.sale.findMany({
    where: {
      uploadedFileId: fileId, isHidden: false, dedupKey: { not: null },
      recordType: { in: recordTypes }, saleDate: { gte: range.start, lte: range.end },
    },
    select: {
      id: true, dedupKey: true, mergeBatchId: true, rawData: true, itemId: true, customerId: true,
      recordType: true, quantity: true, totalValue: true, saleDate: true,
      item: { select: { name: true } }, customer: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
  const inRange = candidates.filter(r => !isAppEnteredRow(r.rawData));
  // لكل رفعة سابقة: كم من صفوفها في الفترة يحويه الملف الجديد.
  const perBatch = new Map(); // mergeBatchId|0 → { total, matched }
  for (const r of inRange) {
    const b = perBatch.get(r.mergeBatchId ?? 0) ?? { total: 0, matched: 0 };
    b.total++;
    if (keySet.has(r.dedupKey)) b.matched++;
    perBatch.set(r.mergeBatchId ?? 0, b);
  }
  const sameSeries = (r) => { const b = perBatch.get(r.mergeBatchId ?? 0); return b.matched / b.total >= SAME_SERIES_MIN_COVERAGE; };

  const changed = [], vanished = [], foreign = [];
  let matched = 0;
  for (const r of inRange) {
    if (keySet.has(r.dedupKey)) { matched++; continue; }
    const id = orderIdentity(r);
    if (id && orders.has(id)) changed.push(r);
    else (sameSeries(r) ? vanished : foreign).push(r);
  }
  const foreignBatchIds = [...new Set(foreign.map(r => r.mergeBatchId).filter(id => id != null))];
  const foreignFiles = foreignBatchIds.length
    ? (await prisma.fileMergeBatch.findMany({ where: { id: { in: foreignBatchIds } }, select: { originalName: true } })).map(b => b.originalName)
    : [];
  return {
    range: { first: range.start.toISOString().slice(0, 10), last: range.end.toISOString().slice(0, 10) },
    inRange: inRange.length,
    matched,
    coverage: inRange.length ? matched / inRange.length : 1,
    changed: summarize(changed),
    vanished: summarize(vanished),
    foreign: { ...summarize(foreign), files: foreignFiles },
    rows: { changed, vanished, foreign },
  };
}

/** يُبعد rows من الاستجابة (ثقيلة، فيها rawData). */
export function publicSummary(found) {
  if (!found) return null;
  const { rows, ...rest } = found;
  return rest;
}

/**
 * يُخفي الصفوف المُستبدَلة في رفعة موقوفة جديدة «مُستبدَل بـ…».
 * بصماتها تُمحى من سجلات «كانت الرفعة تحمله» (FileMergeBatchDupKey): الملف الأحدث قال إنها
 * لم تعد موجودة، فلا ترثها رفعة قديمة فتظهر من جديد إن حُذفت رفعتها.
 * @returns {Promise<{batchId:number|null, count:number}>}
 */
export async function hideSupersededRows({ fileId, rows, uploadName, uploadedBy = null, fileType = 'sales' }) {
  if (!rows.length) return { batchId: null, count: 0 };
  const batch = await prisma.fileMergeBatch.create({
    data: {
      fileId,
      originalName: `مُستبدَل بـ«${uploadName}»`,
      uploadedBy,
      fileType: fileType === 'returns' ? 'returns' : 'sales',
      isActive: false,
      rowsAdded: rows.length,
      monthsLabel: monthsLabelOf(rows.map(r => r.saleDate)) || null,
    },
  });
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await prisma.sale.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data: { mergeBatchId: batch.id, isHidden: true } });
    await prisma.fileMergeBatchDupKey.deleteMany({ where: { fileId, dedupKey: { in: chunk.map(r => r.dedupKey) } } });
  }
  const perOwner = new Map();
  for (const r of rows) if (r.mergeBatchId != null) perOwner.set(r.mergeBatchId, (perOwner.get(r.mergeBatchId) || 0) + 1);
  for (const [ownerId, n] of perOwner) {
    await prisma.fileMergeBatch.update({ where: { id: ownerId }, data: { rowsAdded: { decrement: n } } }).catch(() => {});
  }
  return { batchId: batch.id, count: rows.length };
}

/** 'changed,vanished' من الواجهة ← مصفوفة أقسام صالحة. */
export function parseSupersedeKinds(v) {
  return [...new Set(String(v ?? '').split(',').map(s => s.trim()).filter(k => SUPERSEDE_KINDS.includes(k)))];
}

/**
 * وقت الحفظ: يُعيد الحساب على حالة الملف الآن، ويُطبّق الأقسام المختارة فقط إن لم يتجاوز
 * عددها ما وافق عليه المستخدم في المعاينة (max) — وإلا لا يُخفي شيئاً ويُبلّغ.
 */
export async function applySupersede({ fileId, keySet, orders, dates, fileType, counts, kinds, max, uploadName, uploadedBy }) {
  if (!kinds.length) return null;
  const range = uploadDayRange(dates);
  if (!range) return { skipped: true, reason: 'no-dates', count: 0 };
  const found = await findSupersededRows({ fileId, keySet, orders, range, recordTypes: recordTypesForUpload(fileType, counts) });
  const rows = kinds.flatMap(k => found.rows[k]);
  if (!rows.length) return { count: 0, batchId: null };
  if (!(Number(max) >= rows.length)) {
    console.warn(`[supersede] file #${fileId}: ${rows.length} صف للإخفاء > ${max} وافق عليه المستخدم — لم يُخفَ شيء`);
    return { skipped: true, reason: 'more-than-previewed', count: rows.length };
  }
  const res = await hideSupersededRows({ fileId, rows, uploadName, uploadedBy, fileType });
  console.log(`[supersede] file #${fileId}: أُخفي ${res.count} صف (${kinds.join('+')}) في الرفعة الموقوفة #${res.batchId}`);
  return res;
}
