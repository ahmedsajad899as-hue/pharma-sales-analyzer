// ════════════════════════════════════════════════════════════════════════════
// saleFingerprint.js — بصمة صفّ مبيع/ارجاع، لمنع تكرار الطلبية داخل «الملف
// التراكمي» (UploadedFile.isCumulative).
//
// الفكرة: كل رفعة جديدة تنصهر داخل ملف واحد بدل أن تُنشئ ملفاً مستقلاً، فلا بد
// من مفتاح يقول «هذا الصف موجود أصلاً». المفتاح يُكتب في Sale.dedupKey، وقيدُ
// (uploadedFileId, dedupKey) الفريد هو ما يُسقط المكرر فعلياً — عبر
// createMany({ skipDuplicates: true })، فلا نحمّل مئات آلاف المفاتيح في ذاكرة
// السيرفر (951MB فقط — راجع ذاكرة project_pharma_server_capacity).
//
// ⚠️ الفخّ الذي يجب ألا نكرره: crossFileDedup.js يشرح كيف أن إسقاط كل الصفوف
// المتطابقة بمفتاح محتوى واحد حذف عشرات آلاف الطلبيات الحقيقية — بيانات الأدوية
// تكرر بشكل مشروع تماماً نفس الكمية (10/50/100) لنفس الصيدلية في اليوم نفسه.
// لذلك البصمة هنا ليست مفتاح محتوى مجرّداً بل **مفتاح محتوى + رقم تكراره داخل
// الرفعة**: صفّان متطابقان تماماً في نفس الملف يأخذان #0 و#1 فيبقيان معاً؛
// وحين يُعاد رفع الملف نفسه يُنتج الصفّان نفس الرقمين بالضبط فيُسقطان كلاهما.
// التكرار المشروع محفوظ، وإعادة الرفع لا تُضاعف شيئاً.
//
// ⚠️ مصدر كل مكوّنات المفتاح متطابق بين المسارين (رفع إكسل جديد / دمج ملفات
// قديمة موجودة): نقرأ من rawData الخام + recordType + الكمية والقيمة. لا نستعمل
// اسم المندوب (يتبدّل بقرارات ربط الأسماء) ولا saleDate: الصف بلا تاريخ في
// الإكسل يأخذ @default(now()) أي لحظة الرفع، فنفس الصف يحمل تاريخين مختلفين في
// رفعتين — نقرأ نصّ عمود التاريخ كما ورد في الإكسل بدلاً منه.
//
// ⚠️ الايتم: نصّ اسمه **كما ورد في الإكسل** (rawData) لا itemId (الإصدار 2).
// الإصدار 1 كان يأخذ itemId، وهذا رقم يتحرّك: دمج ايتمين (نافذة «دمج الايتمات
// المتشابهة؟» بعد الرفع، أو ربطه من طابور المراجعة) يُعيد توجيه صفوف المبيع
// القديمة إلى الايتم الهدف بينما تبقى بصمتها محسوبة على الرقم القديم — فرفعة
// لاحقة لنفس الشهر تحسب للصف ذاته بصمة بالرقم الجديد، فلا تتطابقان، فيدخل الصف
// مرتين. هذا ما ضخّم مبيع شهر 10 في الملف التراكمي ~20% (2026-10-15) بينما بقي
// الإرجاع سليماً (رُفع مرة واحدة). نص الإكسل الخام لا يغيّره أي دمج داخل التطبيق.
// itemId يبقى بديلاً فقط حين لا يحمل الصف عمود ايتم معروفاً (الإدخال اليدوي).
//
// البصمة تحمل بادئة الإصدار ("2.") — النقطة ليست من حروف base64url فلا تلتبس
// بصمة v1 ببصمة v2. ملف تراكمي ما زال يحمل بصمات v1 يُعاد ختمه (مع إسقاط ما
// تكرّر بسبب الخلل أعلاه) قبل أي رفعة جديدة — راجع cumulativeAudit.js.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';

const ORDER_NO_ALIASES = ['رقم الفاتورة', 'رقم الفاتوره', 'رقم طلبية المذخر', 'رقم طلبيه المذخر', 'رقم الطلبية', 'رقم الطلبيه', 'رقم الطلب', 'invoiceNumber'];
const PHARMACY_ALIASES = ['الصيدلية', 'اسم الصيدلية', 'العميل', 'اسم العميل', 'الزبون', 'اسم الزبون', 'اسم الشركة', 'اسم الشركه', 'pharmacy'];
const DATE_ALIASES     = ['التاريخ', 'تاريخ', 'تاريخ البيع', 'تاريخ الفاتورة', 'تاريخ الطلب', 'تاريخ العملية',
  'أنشات بتاريخ', 'انشات بتاريخ', 'أنشأت بتاريخ', 'انشأت بتاريخ', 'تاريخ الانشاء', 'تاريخ الإنشاء'];
// «الصنف» هي الشركة المصنّعة في ملفات ميركاتو (راجع mercatoColumnMap)، بينما
// «اسم الشركة» فيها هي الصيدلية المشترية — فالاسمان لا يتبادلان الأدوار هنا:
// كلاهما يدخل البصمة من عموده الخاص فلا يهمّ أيّهما يعني ماذا، المهم الثبات.
const COMPANY_ALIASES  = ['الشركة', 'الشركه', 'الشركة المصنعة', 'الشركه المصنعه', 'المجهز', 'الصنف', 'company'];
// أسماء عمود الايتم الصريحة فقط (نفس الجزء غير الملتبس من COLUMN_ALIASES.item في
// sales.service.js — لا نستورده تجنّباً لاستيراد دائري). «صنف/الصنف» مستبعدان
// عمداً: في ميركاتو «الصنف» هو الشركة المصنّعة، وأخذه اسماً للايتم كان سيجعل كل
// ايتمات الشركة الواحدة بصمة واحدة. حين لا يوجد عمود صريح نرجع إلى itemId.
const ITEM_ALIASES     = ['item name', 'product name', 'drug name', 'name of item',
  'اسم المادة', 'المادة', 'اسم الدواء', 'الدواء', 'اسم المنتج', 'المنتج',
  'اسم الايتم', 'الايتم', 'ايتم', 'آيتم', 'الآيتم', 'المستحضر', 'اسم المستحضر', 'اسم العلاج',
  'item', 'drug', 'product', 'medicine', 'brand', 'trade name', 'material'];

/** بادئة إصدار البصمة — راجع رأس الملف. */
export const KEY_VERSION_PREFIX = '2.';
export const isCurrentKey = (k) => typeof k === 'string' && k.startsWith(KEY_VERSION_PREFIX);

const normLoose = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/[ةه]/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ً-ٟ]/g, '').replace(/\s+/g, ' ');

const pick = (raw, aliases) => {
  if (!raw) return '';
  for (const key of Object.keys(raw)) {
    if (aliases.some(a => a.toLowerCase() === key.trim().toLowerCase())) {
      const v = raw[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
};

const parseRaw = (rawData) => {
  if (!rawData) return null;
  if (typeof rawData === 'object') return rawData;
  try { return JSON.parse(rawData); } catch { return null; }
};

/** عدد بصيغة ثابتة كي لا يفترق 10 عن 10.0 بين مسار وآخر. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0';
};

/**
 * مفتاح المحتوى (بلا رقم التكرار) لصفّ واحد.
 *
 * @param {object} row
 * @param {string|object|null} row.rawData  نص JSON للصف الخام كما ورد بالإكسل
 * @param {number|null} row.itemId          بديل فقط حين لا يحمل rawData عمود ايتم
 * @param {number|null} row.customerId      يُستعمل كبديل حين لا يحمل rawData اسم صيدلية
 * @param {string} row.recordType           'sale' | 'return'
 * @param {number} row.quantity
 * @param {number} row.totalValue
 * @returns {string}
 */
export function contentKey({ rawData, itemId, customerId, recordType = 'sale', quantity = 0, totalValue = 0 }) {
  const raw       = parseRaw(rawData);
  const orderNo   = normLoose(pick(raw, ORDER_NO_ALIASES));
  const dateRaw   = normLoose(pick(raw, DATE_ALIASES));
  const pharmacy  = normLoose(pick(raw, PHARMACY_ALIASES)) || (customerId != null ? `#${customerId}` : '');
  const company   = normLoose(pick(raw, COMPANY_ALIASES));
  const itemName  = normLoose(pick(raw, ITEM_ALIASES));
  const item      = itemName ? `n:${itemName}` : `#${itemId ?? ''}`;
  return [orderNo, dateRaw, pharmacy, company, item, recordType, num(quantity), num(totalValue)].join('|');
}

const hash = (s) => KEY_VERSION_PREFIX + createHash('sha1').update(s, 'utf8').digest('base64url').slice(0, 22);

/**
 * يُسنِد بصمة لكل صف في دفعة واحدة، مع ترقيم التكرار داخل الدفعة.
 *
 * ⚠️ الترتيب مهم: رقم التكرار يُمنح بترتيب ورود الصفوف، فإعادة رفع الملف نفسه
 * يجب أن تمرّ بنفس الترتيب كي تتطابق البصمات. مسار الرفع يقرأ الإكسل بالترتيب
 * نفسه دائماً، ومسار الدمج اليدوي يرتّب بـ Sale.id تصاعدياً (ترتيب الإدراج
 * الأصلي) لنفس السبب.
 *
 * @param {Array<object>} rows صفوف بالشكل الذي يقبله contentKey
 * @param {Map<string, number>} [counters] عدّاد خارجي — لمتابعة الترقيم عبر
 *        عدة دفعات تخصّ نفس الملف (مثلاً مبيعات ثم ارجاعات من نفس الرفعة).
 * @returns {string[]} بصمة لكل صف بنفس الترتيب
 */
export function fingerprintRows(rows, counters = new Map()) {
  return rows.map((row) => {
    const key = contentKey(row);
    const n   = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return hash(`${key}#${n}`);
  });
}

/**
 * «ملف الكوديشن»: مبيعات مذاخر تُضاف خارج ملف ميركاتو الأصلي (طلبيات بوت
 * تلكرام + إكسل الكوديشن). مصدره 'mercato' (فيُحتسب في كل مؤشرات ميركاتو بلا
 * أي تعديل عليها) لكنه حاوية تراكمية مستقلة تُفعَّل/تُعطَّل وحدها. يُميَّز
 * بلاحقة مجموعة الدمج لا بعمود جديد — فلا ترحيل schema.
 */
export const CONDITION_VARIANT = 'condition';

/** متغيّر الملف من مجموعة دمجه ('condition' أو null). */
export function fileVariant(file) {
  return String(file?.mergeGroup ?? '').endsWith(`|${CONDITION_VARIANT}`) ? CONDITION_VARIANT : null;
}

/** مجموعة الدمج التي ينتمي إليها ملف: نفس الحساب + نفس المصدر + نفس العملة (+ المتغيّر). */
export function mergeGroupKey({ userId, sourceSystem, detectedCurrency, variant = null }) {
  const base = `${userId ?? 0}|${sourceSystem || 'office'}|${detectedCurrency || 'IQD'}`;
  return variant ? `${base}|${variant}` : base;
}

/** اسم افتراضي للملف التراكمي حسب مصدره وعملته. */
export function cumulativeFileName({ sourceSystem, detectedCurrency, variant = null }) {
  const src = variant === CONDITION_VARIANT ? 'اللكوديشن' : sourceSystem === 'mercato' ? 'ميركاتو' : 'المكتب';
  const cur = detectedCurrency === 'USD' ? '$' : 'د.ع';
  return `مبيعات ${src} — تراكمي (${cur})`;
}
