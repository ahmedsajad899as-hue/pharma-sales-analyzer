// ════════════════════════════════════════════════════════════════════════════
// uploadPreview.js — معاينة «الرفع الذكي» قبل الحفظ: كم صفاً جديداً وكم موجوداً أصلاً.
//
// processUploadedFile({ dryRun: true }) يقرأ الملف بالمحلّل نفسه ثم يتوقف هنا بدل
// _finishProcessing، فلا يُنشأ ملف ولا ايتم ولا منطقة ولا زبون ولا يُحفظ شيء على القرص.
//
// «جديد / موجود» يُحسب ببصمة الصف نفسها التي يُسقط بها الرفعُ الفعلي المكرر
// (saleFingerprint.js + appendRowsToCumulative): نفس ترتيب الصفوف (مبيعات ثم إرجاع)
// ونفس العدّاد المشترك، ثم يُسأل الملف التراكمي الهدف عن البصمات. البصمة تأخذ itemId أو
// customerId فقط حين لا يحمل الصف عمود ايتم/صيدلية؛ لهذه الصفوف وحدها يُحسم المعرّف
// بالقراءة فقط (findExistingItemId)، وما لا يوجد بعد يُعدّ جديداً — الرفع سيُنشئه بمعرّف جديد.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { keyFallbacks, mergeGroupKey, cumulativeFileName, CONDITION_VARIANT } from './saleFingerprint.js';
import { uploadIndex, uploadDayRange, findSupersededRows, publicSummary, recordTypesForUpload } from './cumulativeSupersede.js';
import { isMergeableType, monthsLabelOf } from './cumulativeFile.js';
import { fileNeedsRestamp } from './cumulativeAudit.js';
import { UNDATED_CUTOFF } from './salesMonths.js';
import { isOfficeWarehouseRow } from './pharmacyRep.js';
import { loadResolutionContext, resolveItemName } from './itemResolver.js';
// نفس normalizeArabic الذي يستعمله findOrCreateItem نفسه.
import { normalizeArabic } from '../modules/sales/sales.repository.js';

/** نفس normalizeAr في _finishProcessing (sales.service.js) — الاسم كما يصل إلى findOrCreate*. */
const normalizeAr = s => String(s)
  .trim()
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ـ/g, '')
  .replace(/[ً-ٟ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** معرّف لا يطابق أي صف قائم: كيان سيُنشئه الرفع لأول مرة. */
const NEW_ID = 'new';

/**
 * قراءة فقط لما يعيده findOrCreateItem (sales.repository.js) دون إنشاء.
 * @returns {Promise<number|string>} المعرّف، أو NEW_ID إن كان سيُنشأ.
 */
async function findExistingItemId(name, userId, sciCompanyIds, ctx) {
  const normalized = normalizeArabic(name);
  if (sciCompanyIds.length > 0) {
    const r = await resolveItemName(name, ctx);
    if (r.canonicalItem && ['alias', 'exact', 'high'].includes(r.confidence)) return r.canonicalItem.id;
  } else if (userId) {
    const userItems = await prisma.item.findMany({ where: { userId, isTemp: false }, select: { id: true, name: true } });
    const found = userItems.find(i => normalizeArabic(i.name) === normalized);
    if (found) return found.id;
  }
  const temp = await prisma.item.findUnique({ where: { name_userId: { name: normalized, userId } }, select: { id: true } });
  return temp?.id ?? NEW_ID;
}

/** العملة كما يقرّرها _finishProcessing حين لا يحددها المستخدم. */
function detectCurrencyByValues(rows) {
  const nonZero = rows.map(r => r.totalValue || 0).filter(v => v > 0).sort((a, b) => a - b);
  const median = nonZero.length ? nonZero[Math.floor(nonZero.length / 2)] : 0;
  return median >= 100000 ? 'IQD' : 'USD';
}

/**
 * عملة المعاينة: ما اختاره المستخدم، وإلا عملة الملف التراكمي القائم لنفس المصدر إن
 * كان واحداً (رفعات المكتب اليومية تذهب لملفها نفسه)، وإلا عملة ملفاته التراكمية الأخرى
 * إن اتفقت (أول ميركاتو لحساب ملف مكتبه بالدينار)، وإلا الكشف بالقيم. الكشف بالقيم وحده
 * يخطئ في الدينار حين تكون قيمة الصف الوسطى أقل من 100 ألف.
 */
async function pickCurrency({ sourceCurrency, userId, sourceSystem, rows }) {
  if (sourceCurrency === 'IQD' || sourceCurrency === 'USD') return { currency: sourceCurrency, reason: 'chosen' };
  if (userId) {
    const existing = await prisma.uploadedFile.findMany({
      where: { userId, isCumulative: true, NOT: { mergeGroup: { endsWith: `|${CONDITION_VARIANT}` } } },
      select: { detectedCurrency: true, sourceSystem: true },
    });
    const currenciesOf = (files) => [...new Set(files.map(f => f.detectedCurrency || 'IQD'))];
    const same = currenciesOf(existing.filter(f => (f.sourceSystem ?? null) === (sourceSystem ?? null)));
    if (same.length === 1) return { currency: same[0], reason: 'existing' };
    const any = currenciesOf(existing);
    if (!same.length && any.length === 1) return { currency: any[0], reason: 'existing-other' };
  }
  return { currency: detectCurrencyByValues(rows), reason: 'detected' };
}

const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * @param {object} p مخرجات المحلّل في processUploadedFile + خيارات الرفع
 * @returns {Promise<object>} ملخص المعاينة — راجع SmartUploadModal.tsx
 */
export async function previewParsedUpload({
  salesRows, returnsRows, skippedRows = [], userId, fileType, requestedType, sourceCurrency,
  sourceSystem = null, mergeIntoCumulative = true, diag = {}, originalName = '',
}) {
  const allRows = [...salesRows, ...returnsRows];
  const { currency, reason: currencyReason } = await pickCurrency({ sourceCurrency, userId, sourceSystem, rows: allRows });

  const storedFileType = fileType === 'auto'
    ? (salesRows.length > 0 && returnsRows.length > 0 ? 'auto' : returnsRows.length > 0 ? 'returns' : 'sales')
    : (fileType === 'matrix' ? 'sales' : fileType);
  const merges = mergeIntoCumulative && userId != null && isMergeableType(storedFileType);

  // ── الملف الهدف (قراءة فقط — resolveCumulativeTarget يُنشئه عند الرفع إن لم يوجد) ──
  let target = null;
  if (merges) {
    const group = mergeGroupKey({ userId, sourceSystem, detectedCurrency: currency });
    target = await prisma.uploadedFile.findFirst({
      where: { userId, isCumulative: true, mergeGroup: group },
      orderBy: { id: 'asc' },
      select: { id: true, originalName: true, rowCount: true },
    });
  }

  // ── معرّفات البديل للبصمة (نادرة: صف بلا عمود ايتم أو صيدلية) ──
  const sciCompanyIds = userId
    ? (await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } })).map(c => c.companyId)
    : [];
  let itemCtx = null;
  const itemIdCache = new Map();
  const customerIdCache = new Map();
  const itemIdOf = async (name) => {
    const key = normalizeAr(name || 'غير محدد');
    if (!itemIdCache.has(key)) {
      if (!itemCtx && sciCompanyIds.length) itemCtx = await loadResolutionContext({ scientificCompanyIds: sciCompanyIds, userId });
      itemIdCache.set(key, userId ? await findExistingItemId(key, userId, sciCompanyIds, itemCtx) : NEW_ID);
    }
    return itemIdCache.get(key);
  };
  const customerIdOf = async (name) => {
    if (!name) return null;
    const key = normalizeAr(name);
    if (!customerIdCache.has(key)) {
      const c = userId ? await prisma.customer.findUnique({ where: { name_userId: { name: key, userId } }, select: { id: true } }) : null;
      customerIdCache.set(key, c?.id ?? NEW_ID);
    }
    return customerIdCache.get(key);
  };
  const toKeyRow = async (r, recordType) => {
    const needs = keyFallbacks(r.rawData);
    return {
      rawData:    r.rawData ?? null,
      itemId:     needs.item ? await itemIdOf(r.item) : null,
      customerId: needs.customer ? await customerIdOf(r.customer) : null,
      recordType,
      quantity:   r.quantity,
      totalValue: r.totalValue,
    };
  };

  // نفس ترتيب appendRowsToCumulative: مبيعات ثم إرجاع، بعدّاد واحد (uploadIndex).
  const saleKeyRows = await Promise.all(salesRows.map(r => toKeyRow(r, 'sale')));
  const returnKeyRows = await Promise.all(returnsRows.map(r => toKeyRow(r, 'return')));
  const index = uploadIndex(saleKeyRows, returnKeyRows);
  const saleKeys = index.keys.slice(0, salesRows.length);
  const returnKeys = index.keys.slice(salesRows.length);

  // ── أيّها موجود أصلاً في الملف الهدف ──
  const existing = new Map(); // dedupKey → isHidden
  let approximate = false;
  if (target) {
    approximate = await fileNeedsRestamp(target.id);
    const keys = [...saleKeys, ...returnKeys];
    for (let i = 0; i < keys.length; i += 2000) {
      const found = await prisma.sale.findMany({
        where: { uploadedFileId: target.id, dedupKey: { in: keys.slice(i, i + 2000) } },
        select: { dedupKey: true, isHidden: true },
      });
      for (const f of found) existing.set(f.dedupKey, f.isHidden);
    }
  }

  const isNew = (k) => !existing.has(k);
  const tally = (rows, keys) => {
    let count = 0, value = 0;
    rows.forEach((r, i) => { if (isNew(keys[i])) { count++; value += Number(r.totalValue) || 0; } });
    return { count, value };
  };
  const newSales = tally(salesRows, saleKeys);
  const newReturns = tally(returnsRows, returnKeys);
  const existingHidden = [...existing.values()].filter(Boolean).length;

  // ── التواريخ ──
  const datedRange = (rows) => {
    let first = null, last = null, undated = 0;
    for (const r of rows) {
      const d = r.date ? new Date(r.date) : null;
      if (!d || Number.isNaN(d.getTime()) || d < UNDATED_CUTOFF) { undated++; continue; }
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
    }
    return { first: dayOf(first), last: dayOf(last), undated };
  };
  const all = datedRange(allRows);
  const newRowsList = [
    ...salesRows.filter((_, i) => isNew(saleKeys[i])),
    ...returnsRows.filter((_, i) => isNew(returnKeys[i])),
  ];
  const fresh = datedRange(newRowsList);

  // ── «أحدث ملف هو الصحيح لفترته»: صفوف رفعات سابقة غابت عن هذا الملف (cumulativeSupersede.js) ──
  // لا يُحسب على ملف ما زال يحمل بصمات قديمة: كل صفوفه ستبدو «غائبة» فيُقترح إخفاؤها.
  let supersede = null;
  if (target && !approximate) {
    const range = uploadDayRange(allRows.map(r => r.date ?? null));
    if (range) {
      supersede = publicSummary(await findSupersededRows({
        fileId: target.id, keySet: index.keySet, orders: index.orders, range, recordTypes: recordTypesForUpload(fileType),
      }));
    }
  }

  // ── صفوف اليزن (ميركاتو): تُحسب مكتباً للمسوّقين ولا تُحسب للمندوب العلمي ──
  let yazen = null;
  if (sourceSystem === 'mercato') {
    let rows = 0, newRows = 0;
    salesRows.forEach((r, i) => { if (isOfficeWarehouseRow(r.rawData)) { rows++; if (isNew(saleKeys[i])) newRows++; } });
    yazen = { rows, newRows };
  }

  return {
    dryRun: true,
    fileName: originalName,
    fileType,
    requestedType,
    smartReason: diag.smartReason ?? null,
    source: sourceSystem === 'mercato' ? 'mercato' : 'office',
    currency,
    currencyReason,
    counts: { sales: salesRows.length, returns: returnsRows.length, skipped: skippedRows.length, total: allRows.length },
    newCounts: {
      sales: newSales.count, returns: newReturns.count, total: newSales.count + newReturns.count,
      salesValue: newSales.value, returnsValue: newReturns.value,
    },
    existing: existing.size,
    existingHidden,
    dates: { first: all.first, last: all.last, undated: all.undated, newFirst: fresh.first, newLast: fresh.last, months: monthsLabelOf(allRows.map(r => r.date ?? null)) },
    target: merges
      ? { fileId: target?.id ?? null, name: target?.originalName ?? cumulativeFileName({ sourceSystem, detectedCurrency: currency }), exists: !!target }
      : null,
    yazen,
    supersede,
    sheets: diag.sheets ?? [],
    hiddenByFilter: diag.hiddenByFilter ?? 0,
    droppedCrossSheet: diag.droppedCrossSheet ?? 0,
    approximate,
    skippedSample: skippedRows.slice(0, 3).map(s => ({ row: s.row, errors: s.errors })),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// الرفع التلقائي من «مجلد المبيعات» (المرحلة 3): يُرفع الملف بلا مراجعة فقط حين تكون
// معاينته «سليمة»؛ أي شيء غير مألوف يُترك للمستخدم في نافذة «الرفع الذكي».
// ════════════════════════════════════════════════════════════════════════════

/** صفوف قديمة تُخفى تلقائياً بلا مراجعة حتى هذا العدد (أو 5% من صفوف الفترة إن كانت أكثر). */
export const AUTO_HIDE_LIMIT = 20;

/** أقسام «أحدث ملف هو الصحيح» التي يُطبّقها الرفع التلقائي — «من ملف آخر» أبداً. */
export function autoSupersedePlan(preview) {
  const s = preview?.supersede;
  const kinds = s ? ['changed', 'vanished'].filter(k => s[k].count > 0) : [];
  return { kinds, max: kinds.reduce((n, k) => n + s[k].count, 0) };
}

/**
 * لماذا لا يُرفع هذا الملف تلقائياً؟ مصفوفة فارغة = سليم.
 * @returns {string[]} أسباب بالعربية تُعرض للمستخدم
 */
export function autoUploadBlockers(preview) {
  const out = [];
  const t = preview.target;
  if (!t) out.push('الرفعة لن تُدمج في ملف تراكمي');
  else if (!t.exists) out.push(`سيُنشئ ملفاً جديداً «${t.name}»`);
  if (preview.currencyReason !== 'existing' && preview.currencyReason !== 'chosen') out.push('العملة غير مؤكدة');
  if (preview.hiddenByFilter > 0) out.push(`فلتر إكسل يخفي ${preview.hiddenByFilter} صف`);
  if (preview.approximate) out.push('الملف التراكمي يحتاج إعادة ختم');
  if (preview.fileType === 'auto') out.push('ملف بعدة أوراق يُقرأ كمختلط');
  const s = preview.supersede;
  if (s?.foreign.count) out.push(`${s.foreign.count} صف من ملف آخر غائب عن هذا الملف`);
  const hide = autoSupersedePlan(preview).max;
  if (hide > Math.max(AUTO_HIDE_LIMIT, Math.round((s?.inRange ?? 0) * 0.05))) out.push(`سيُخفي ${hide} صفاً قديماً`);
  return out;
}

/** لا جديد ولا تصحيح: الملف موجود كله أصلاً. */
export function nothingToUpload(preview) {
  return preview.newCounts.total === 0 && autoSupersedePlan(preview).max === 0;
}
