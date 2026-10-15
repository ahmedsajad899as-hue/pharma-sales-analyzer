// ════════════════════════════════════════════════════════════════════════════
// cumulativeAudit.js — تدقيق الملف التراكمي: «هل فيه صفوف دخلت مرتين؟»
//
// الخلفية (2026-10-15): مبيع شهر 10 في ملف المكتب التراكمي ظهر أكبر من الإكسل
// بنحو 20%، والإرجاع سليم. السبب في بصمة الإصدار 1 (راجع رأس saleFingerprint.js):
// كانت تأخذ itemId، ودمج الايتمات بين رفعتين يُحرّك itemId للصفوف القديمة دون
// بصمتها، فرفعة الشهر التالية لا تتعرّف على الصف وتُدخله ثانيةً.
//
// هذا الملف يُعيد ختم كل صفوف ملف تراكمي ببصمة الإصدار 2 **بنفس قواعد الرفع
// تماماً**: رقم التكرار لكل رفعة على حدة (FileMergeBatch)، بترتيب Sale.id — فصفّان
// متطابقان مشروعان داخل رفعة واحدة يبقيان (الدرس المدفوع في crossFileDedup.js)،
// بينما الصف نفسه حين ظهر في رفعتين تبقى نسخة الرفعة الأقدم وتُحذف اللاحقة.
// هذا بالضبط ما كان skipDuplicates سيفعله وقت الرفع لو كانت البصمة صحيحة.
//
// وضعان:
//   - معاينة (apply=false): لا تكتب شيئاً — تقرير بالأشهر والرفعات والمكرر.
//   - تنفيذ  (apply=true): حذف المكرر + كتابة البصمات الجديدة، داخل معاملة واحدة.
//
// ensureCumulativeKeysCurrent يُستدعى قبل أي رفعة تنصهر في ملف تراكمي: ملفٌ ما
// زال يحمل بصمات v1 لا يجوز أن يُضاف إليه بصمات v2، وإلا لم تتطابق مع شيء وتضاعف
// كل الرفعة المعادة.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { contentKey, fingerprintRows, KEY_VERSION_PREFIX } from './saleFingerprint.js';
import { UNDATED_CUTOFF, monthLabel } from './salesMonths.js';

const CHUNK = 2000;

/** قفل لكل ملف داخل العملية: تدقيق يدوي ورفعة متزامنان لا يختمان نفس الصفوف معاً. */
const locks = new Map();
async function withFileLock(fileId, fn) {
  const prev = locks.get(fileId) ?? Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(fileId, chained);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (locks.get(fileId) === chained) locks.delete(fileId);
  }
}

const ymOf = (d) => {
  if (!d) return 'none';
  const dt = new Date(d);
  if (dt < UNDATED_CUTOFF) return 'none';
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
};
const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

const emptyMonth = () => ({
  sale:      { rows: 0, qty: 0, value: 0 },
  ret:       { rows: 0, qty: 0, value: 0 },
  dupSale:   { rows: 0, qty: 0, value: 0 },
  dupRet:    { rows: 0, qty: 0, value: 0 },
  suspect:   { rows: 0, value: 0 },
});
const add = (bucket, qty, value) => { bucket.rows++; bucket.qty += qty || 0; bucket.value += value || 0; };

/** هل في الملف صفّ واحد على الأقل لم يُختم ببصمة الإصدار الحالي؟ */
export async function fileNeedsRestamp(fileId) {
  const stale = await prisma.sale.findFirst({
    where: {
      uploadedFileId: fileId,
      OR: [{ dedupKey: null }, { NOT: { dedupKey: { startsWith: KEY_VERSION_PREFIX } } }],
    },
    select: { id: true },
  });
  return !!stale;
}

/**
 * يدقّق ملفاً تراكمياً واحداً (ويُصلحه حين apply=true).
 *
 * @param {number} fileId
 * @param {{ apply?: boolean }} [opts]
 */
export async function auditCumulativeFile(fileId, { apply = false } = {}) {
  return withFileLock(fileId, () => runAudit(fileId, apply));
}

async function runAudit(fileId, apply) {
  const file = await prisma.uploadedFile.findUnique({
    where: { id: fileId },
    select: { id: true, originalName: true, isCumulative: true, detectedCurrency: true, rowCount: true },
  });
  if (!file) throw new Error('الملف غير موجود');

  const batchRows = await prisma.fileMergeBatch.findMany({ where: { fileId } });
  const batchById = new Map(batchRows.map(b => [b.id, b]));

  // المجموعات بترتيب أول صفّ فيها = ترتيب دخولها الملف. الصفوف بلا رفعة
  // (mergeBatchId=null) هي ما كان في الملف قبل تفعيل التراكم — الأقدم دائماً.
  const groups = await prisma.sale.groupBy({
    by: ['mergeBatchId'], where: { uploadedFileId: fileId }, _min: { id: true }, _count: { _all: true },
  });
  // الرفعات الموقوفة (isActive=false، صفوفها مخفية) تأتي أخيراً: حين يتكرّر صفّ
  // بين رفعة فعّالة وأخرى موقوفة تبقى نسخة الفعّالة الظاهرة، وتُسجَّل الموقوفة
  // «حاملةً» له (FileMergeBatchDupKey) فترثه لو حُذفت الفعّالة لاحقاً.
  const isInactive = (gid) => gid != null && batchById.get(gid)?.isActive === false;
  groups.sort((a, b) =>
    (isInactive(a.mergeBatchId) - isInactive(b.mergeBatchId)) || ((a._min.id ?? 0) - (b._min.id ?? 0)));

  const used     = new Map();     // بصمة → رفعة الصف المُبقى (الأقدم الفعّال يفوز)
  const rename   = new Map();     // بصمة قديمة → بصمة v2 — لتحديث سجلات FileMergeBatchDupKey
  const holders  = [];            // { batchId, dedupKey } — رفعة حملت صفاً حُذفت نسخته منها
  const loose    = new Map();     // مفتاح «مرن» → { g, c, multi: Map<group,count>|null } — للمشتبه فقط
  const months   = new Map();
  const perBatch = new Map();
  const toDelete = [];
  const toUpdate = [];             // { id, key } — صفوف تغيّرت بصمتها
  const examples = [];
  let scanned = 0;
  let stale   = 0;

  const monthOf = (ym) => { if (!months.has(ym)) months.set(ym, emptyMonth()); return months.get(ym); };

  for (const g of groups) {
    const gid = g.mergeBatchId ?? null;
    const counters = new Map();   // رقم التكرار لكل رفعة على حدة — كوقت الرفع تماماً
    const stat = { rows: 0, dupRows: 0, dupSaleValue: 0, dupReturnValue: 0 };
    perBatch.set(gid, stat);
    let cursor = 0;

    for (;;) {
      const rows = await prisma.sale.findMany({
        where:   { uploadedFileId: fileId, mergeBatchId: gid, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take:    CHUNK,
        select:  {
          id: true, rawData: true, itemId: true, customerId: true, recordType: true,
          quantity: true, totalValue: true, saleDate: true, dedupKey: true, isHidden: true,
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      const keys = fingerprintRows(rows, counters);
      rows.forEach((r, i) => {
        scanned++;
        stat.rows++;
        const key  = keys[i];
        const isRet = r.recordType === 'return';
        const m    = monthOf(ymOf(r.saleDate));
        if (r.dedupKey !== key) {
          stale++;
          if (r.dedupKey) rename.set(r.dedupKey, key);
        }

        if (used.has(key)) {
          toDelete.push(r.id);
          if (gid != null && used.get(key) !== gid) holders.push({ batchId: gid, dedupKey: key });
          stat.dupRows++;
          if (isRet) stat.dupReturnValue += r.totalValue || 0; else stat.dupSaleValue += r.totalValue || 0;
          if (!r.isHidden) add(isRet ? m.dupRet : m.dupSale, r.quantity, r.totalValue);
          if (examples.length < 12) {
            const parts = contentKey(r).split('|');
            examples.push({
              batch: gid, month: ymOf(r.saleDate), recordType: r.recordType,
              orderNo: parts[0], date: parts[1], pharmacy: parts[2], item: parts[4].replace(/^n:/, ''),
              quantity: r.quantity, value: r.totalValue,
            });
          }
          return;
        }
        used.set(key, gid);
        if (r.dedupKey !== key) toUpdate.push({ id: r.id, key });
        if (!r.isHidden) add(isRet ? m.ret : m.sale, r.quantity, r.totalValue);

        // «مشتبه» للعرض فقط — نفس الصيدلية/الايتم/الكمية/القيمة/اليوم في رفعتين
        // مختلفتين رغم اختلاف رقم الطلبية أو صيغة نص التاريخ. لا يُحذف تلقائياً:
        // قد يكون طلبيتين حقيقيتين في يوم واحد.
        const p = contentKey(r).split('|');
        const lk = [p[2], p[3], p[4], p[5], p[6], p[7], dayOf(r.saleDate)].join('|');
        // الغالبية الساحقة تظهر في رفعة واحدة: نخزّن عدداً مجرّداً، ولا نُنشئ Map
        // إلا حين يظهر المفتاح في رفعة ثانية (ذاكرة السيرفر 951MB فقط).
        const lv = loose.get(lk);
        if (lv === undefined) loose.set(lk, { g: gid, c: 1, multi: null });
        else if (!lv.multi && lv.g === gid) lv.c++;
        else {
          if (!lv.multi) { lv.multi = new Map([[lv.g, lv.c]]); }
          lv.multi.set(gid, (lv.multi.get(gid) || 0) + 1);
        }
      });
    }
  }

  // المشتبه: لكل مفتاح مرن ظهر في أكثر من رفعة، ما يزيد عن أكبر رفعة منها.
  let suspectRows = 0;
  let suspectValue = 0;
  for (const [lk, lv] of loose) {
    const lg = lv.multi;
    if (!lg || lg.size < 2) continue;
    let total = 0, max = 0;
    for (const c of lg.values()) { total += c; if (c > max) max = c; }
    const extra = total - max;
    const parts = lk.split('|');
    const value = Number(parts[5]) || 0;
    suspectRows  += extra;
    suspectValue += value * extra;
    if (parts[3] === 'sale') {
      const m = monthOf(parts[6] ? parts[6].slice(0, 7) : 'none');
      m.suspect.rows += extra; m.suspect.value += value * extra;
    }
  }
  loose.clear();

  let removed = 0;
  if (apply && (toDelete.length > 0 || toUpdate.length > 0)) {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        const res = await tx.sale.deleteMany({ where: { id: { in: toDelete.slice(i, i + CHUNK) } } });
        removed += res.count;
      }
      // مرحلتان: تفريغ بصمات الصفوف المتغيّرة أولاً ثم كتابتها، كي لا يصطدم صفٌّ
      // ببصمة جديدة ما زال صفٌّ آخر يحملها مؤقتاً تحت القيد الفريد.
      const ids = toUpdate.map(u => u.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        await tx.sale.updateMany({ where: { id: { in: ids.slice(i, i + CHUNK) } }, data: { dedupKey: null } });
      }
      const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
      for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const tuples = toUpdate.slice(i, i + CHUNK)
          .filter(u => Number.isInteger(u.id) && KEY_RE.test(u.key))
          .map(u => `(${u.id}, '${u.key}')`);
        if (tuples.length === 0) continue;
        await tx.$executeRawUnsafe(
          `UPDATE sales AS s SET "dedupKey" = v.k
             FROM (VALUES ${tuples.join(',')}) AS v(id, k)
            WHERE s.id = v.id`,
        );
      }
      // سجلات «الرفعة كانت تحمل هذا الصف» تُكتب بالبصمات الجديدة، ويُضاف إليها
      // كل رفعة حُذفت نسختها هنا — كي يبقى توريث الصفوف عند حذف/إيقاف رفعة سليماً.
      // (الجدول قد لا يكون في عميل Prisma المنشور بعد — نتخطّاه حينها.)
      if (tx.fileMergeBatchDupKey) {
        const old = await tx.fileMergeBatchDupKey.findMany({ where: { fileId }, select: { batchId: true, dedupKey: true } });
        const next = [
          ...old.map(o => ({ batchId: o.batchId, fileId, dedupKey: rename.get(o.dedupKey) ?? o.dedupKey })),
          ...holders.map(h => ({ batchId: h.batchId, fileId, dedupKey: h.dedupKey })),
        ].filter(r => batchById.has(r.batchId) && used.get(r.dedupKey) !== r.batchId);
        await tx.fileMergeBatchDupKey.deleteMany({ where: { fileId } });
        for (let i = 0; i < next.length; i += CHUNK) {
          await tx.fileMergeBatchDupKey.createMany({ data: next.slice(i, i + CHUNK), skipDuplicates: true });
        }
      }
      // عدّادات الرفعات تعكس الواقع الجديد: ما حُذف من رفعة كان «مكرراً» أصلاً.
      for (const [gid, st] of perBatch) {
        if (gid == null || st.dupRows === 0 || !batchById.has(gid)) continue;
        await tx.fileMergeBatch.update({
          where: { id: gid },
          data:  { rowsAdded: { decrement: st.dupRows }, rowsSkipped: { increment: st.dupRows } },
        });
      }
      const total = await tx.sale.count({ where: { uploadedFileId: fileId } });
      await tx.uploadedFile.update({ where: { id: fileId }, data: { rowCount: total } });
    }, { timeout: 10 * 60 * 1000, maxWait: 30 * 1000 });
    console.log(`[cumulative-audit] file #${fileId}: حُذف ${removed} صف مكرر، أُعيد ختم ${toUpdate.length} بصمة`);
  }

  const round = (n) => Math.round(n);
  const monthList = [...months.entries()]
    .sort(([a], [b]) => (a === 'none' ? -1 : b === 'none' ? 1 : a.localeCompare(b)))
    .map(([ym, m]) => ({
      ym,
      label: ym === 'none' ? 'بلا تاريخ' : monthLabel(ym).short,
      // «بعد» = ما يبقى (الصفوف غير المكررة). «قبل» = بعد + المكرر.
      saleAfter:    { rows: m.sale.rows, qty: m.sale.qty, value: round(m.sale.value) },
      saleBefore:   { rows: m.sale.rows + m.dupSale.rows, qty: m.sale.qty + m.dupSale.qty, value: round(m.sale.value + m.dupSale.value) },
      dupSale:      { rows: m.dupSale.rows, qty: m.dupSale.qty, value: round(m.dupSale.value) },
      returnAfter:  { rows: m.ret.rows, qty: m.ret.qty, value: round(m.ret.value) },
      dupReturn:    { rows: m.dupRet.rows, qty: m.dupRet.qty, value: round(m.dupRet.value) },
      suspectSale:  { rows: m.suspect.rows, value: round(m.suspect.value) },
    }));

  return {
    fileId,
    fileName:   file.originalName,
    currency:   file.detectedCurrency,
    scanned,
    staleKeys:  stale,
    duplicates: toDelete.length,
    suspects:   { rows: suspectRows, value: round(suspectValue) },
    applied:    apply,
    removed,
    months:     monthList,
    batches:    groups.map(g => {
      const b  = g.mergeBatchId != null ? batchById.get(g.mergeBatchId) : null;
      const st = perBatch.get(g.mergeBatchId ?? null) || { rows: 0, dupRows: 0, dupSaleValue: 0, dupReturnValue: 0 };
      return {
        id:           g.mergeBatchId ?? null,
        name:         b?.originalName ?? (g.mergeBatchId == null ? 'صفوف الملف الأصلية (قبل التراكم)' : `رفعة #${g.mergeBatchId}`),
        uploadedAt:   b?.uploadedAt ?? null,
        rows:         st.rows,
        duplicates:   st.dupRows,
        dupSaleValue: round(st.dupSaleValue),
        dupReturnValue: round(st.dupReturnValue),
      };
    }),
    examples,
  };
}

/**
 * يضمن أن كل صفوف الملف التراكمي مختومة ببصمة الإصدار الحالي قبل أن تُضاف إليه
 * رفعة جديدة — وإلا لم تتطابق بصمات الرفعة الجديدة (v2) مع القديمة (v1) أبداً.
 * يُسقط في طريقه ما تكرّر بسبب خلل v1. سريع حين يكون الملف مختوماً أصلاً
 * (استعلام findFirst واحد على الفهرس الفريد).
 */
export async function ensureCumulativeKeysCurrent(fileId) {
  if (!(await fileNeedsRestamp(fileId))) return null;
  const res = await auditCumulativeFile(fileId, { apply: true });
  return { removed: res.removed, restamped: res.staleKeys };
}
