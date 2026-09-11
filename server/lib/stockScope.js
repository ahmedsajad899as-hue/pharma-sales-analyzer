// ════════════════════════════════════════════════════════════════════════════
// stockScope.js — نطاق شركات/ايتمات الستوك (UserStockCompanyAssignment /
// UserStockItemAssignment) لصفحة «Stock» (الجدول الخام) و«رصيد المذاخر».
//
// مستقل عمداً عن UserCompanyAssignment (تُديره officeScope.js تلقائياً بكل شركات
// المكتب لمدير/موظف المكتب — إعادة استعماله هنا كانت ستكسر ذلك) وعن
// UserItemAssignment (نطاق المبيعات — مفهوم مختلف قد يفترقان فيه). نفس اصطلاح
// itemScope.js: قائمة فارغة = بلا تقييد (كل الشركات/الايتمات)، لا «صفر».
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';
import { areSimilar } from './fuzzyMatch.js';
import { asArray, detectCompanyCol, detectItemNameCol } from './stockMatrix.js';

/**
 * نطاق ستوك المستخدم — كل بُعد null إن لم يكن مقيَّداً.
 * @param {number|null} userId
 * @returns {Promise<{
 *   itemIds: number[]|null, itemNameKeys: Set<string>|null,
 *   companyIds: number[]|null, companyNameKeys: Set<string>|null,
 * }>}
 */
export async function resolveStockScope(userId) {
  const empty = { itemIds: null, itemNameKeys: null, companyIds: null, companyNameKeys: null };
  if (!userId) return empty;

  const [itemAssigns, companyAssigns] = await Promise.all([
    prisma.userStockItemAssignment.findMany({ where: { userId }, select: { itemId: true, item: { select: { name: true } } } }),
    prisma.userStockCompanyAssignment.findMany({ where: { userId }, select: { companyId: true, company: { select: { name: true } } } }),
  ]);

  let itemIds = null, itemNameKeys = null;
  if (itemAssigns.length) {
    itemNameKeys = new Set(itemAssigns.map(a => normalizeItemKey(a.item?.name || '')).filter(Boolean));
    const directIds = itemAssigns.map(a => a.itemId);
    if (itemNameKeys.size) {
      // توسيع بالاسم — نفس الايتم قد يتكرر كصفوف Item متعددة (كتالوج/مؤقت/لكل حساب)
      const allItems = await prisma.item.findMany({ select: { id: true, name: true } });
      const matchingIds = allItems.filter(i => itemNameKeys.has(normalizeItemKey(i.name || ''))).map(i => i.id);
      itemIds = [...new Set([...directIds, ...matchingIds])];
    } else {
      itemIds = [...new Set(directIds)];
    }
  }

  let companyIds = null, companyNameKeys = null;
  if (companyAssigns.length) {
    companyIds = [...new Set(companyAssigns.map(a => a.companyId))];
    companyNameKeys = new Set(companyAssigns.map(a => normalizeItemKey(a.company?.name || '')).filter(Boolean));
  }

  return { itemIds, itemNameKeys, companyIds, companyNameKeys };
}

/** هل النطاق بلا أي تقييد على الإطلاق — تفادي أي معالجة إضافية للحالة الشائعة */
export function isUnrestricted(scope) {
  return !scope || (scope.itemIds === null && scope.companyIds === null);
}

// أحرف/أرقام فقط (بكل اللغات) — يُسقط الفواصل والرموز التي تُلصَق بها الأعمدة
// الملصَقة في ملفات الستوك الخام دون أن يُسقط حروف عربية أو تشكيل الايتمات.
const alnumKey = (s) => normalizeItemKey(s).replace(/[^\p{L}\p{N}]/gu, '');
const MIN_CONTAIN_LEN = 3; // دون هذا الطول احتمال تطابق عرضي بريء مرتفع جداً

/**
 * هل يقع نص حر ضمن مجموعة مفاتيح أسماء النطاق — تام، ثم احتواء بعد تجريد كل حرف
 * غير أبجدي/رقمي، ثم تشابه. مشترك بين صفحة Stock الخام (filterStockMatrixRows)
 * وأرصدة رصيد المذاخر (makeBalanceScopeFilter) كي لا تتفق الصفحتان على البيانات
 * وتختلفا على من يراها. keys=null يعني بُعداً غير مقيَّد.
 */
function matchesNameScope(raw, keys) {
  if (!keys) return true;
  const key = normalizeItemKey(raw);
  if (!key) return false;
  if (keys.has(key)) return true;
  const rawAlnum = alnumKey(raw);
  if (rawAlnum.length >= MIN_CONTAIN_LEN) {
    for (const k of keys) {
      const kAlnum = alnumKey(k);
      if (kAlnum.length >= MIN_CONTAIN_LEN && (rawAlnum.includes(kAlnum) || kAlnum.includes(rawAlnum))) return true;
    }
  }
  for (const k of keys) if (areSimilar(raw, k)) return true;
  return false;
}

/**
 * مُرشِّح StockBalance بنطاق المستخدم — يدمج بُعدي الشركة/الايتم (AND)، كل بُعد
 * يُطبَّق فقط إن كان مقيَّداً.
 *
 * كان هذا شرط Prisma (buildStockBalanceWhere) يطابق بُعدين بطريقة تُصفّر النتيجة:
 *   • الايتم بالـ FK وحده (itemId) — وهو null لكل ايتم لم يُربط بالكتالوج بثقة
 *     alias/exact/high وقت الاستيعاب، فكل رصيد لايتم غير مربوط كان يختفي للأبد
 *     حتى لو كان اسمه نفسه ضمن ايتمات النطاق.
 *   • الشركة بأسماء ScientificCompany، بينما StockBalance.companyName يُكتب من
 *     كتالوج Company (جدول آخر، resolveCompanyLabel) — تطابق تام عبر جدولين
 *     مختلفين يفشل عند أي فرق تهجئة، فتُحجب كل الأرصدة.
 * النتيجة كانت صفحة Stock الخام تعرض الصفوف و«رصيد المذاخر» فارغة تماماً. الآن
 * كلتاهما تستعملان matchesNameScope نفسها، والايتم يُقبل بالـ FK أو بمفتاح اسمه.
 *
 * @param {Awaited<ReturnType<typeof resolveStockScope>>} scope
 * @returns {(b: {itemId: number|null, itemKey: string, itemName: string, companyName: string|null}) => boolean}
 */
export function makeBalanceScopeFilter(scope) {
  if (isUnrestricted(scope)) return () => true;
  const itemIdSet = scope.itemIds ? new Set(scope.itemIds) : null;
  return (b) => {
    if (itemIdSet) {
      const byId = b.itemId != null && itemIdSet.has(b.itemId);
      // itemKey مُطبَّع بنفس normalizeItemKey المستعمل في بناء itemNameKeys
      const byKey = !!scope.itemNameKeys?.has(b.itemKey);
      if (!byId && !byKey && !matchesNameScope(b.itemName, scope.itemNameKeys)) return false;
    }
    if (scope.companyNameKeys?.size && !matchesNameScope(b.companyName ?? '', scope.companyNameKeys)) return false;
    return true;
  };
}

/**
 * فلترة صفوف ملف Stock الخام (SalesDataFile.rows) بنطاق المستخدم — اسم
 * الشركة/الايتم هنا نص حر لم يمرّ بأي مطابقة مسبقة (بعكس StockBalance)، وغالباً
 * مُلصَق بلا فواصل (شوهد فعلياً: "AL-HAYATIRAQIN/A" لشركة كتالوجها "AL-HAYATI"،
 * "DevaTurkeyN/A" لـ"Deva") — تشابه Levenshtein (areSimilar) يفشل مع هذا
 * الإلصاق (نسب تشابه ~0.3-0.5، تحت العتبة) رغم أن الاسم موجود فعلاً داخل النص.
 * لذا المطابقة: تامة أولاً، وإلا احتواء بعد تجريد كل حرف غير أبجدي/رقمي (تُطابِق
 * "alhayati" داخل "alhayatiraqina")، وإلا تشابه كاحتياط أخير لفروق الكتابة
 * الحقيقية (لا الإلصاق).
 * @param {any[]} rows
 * @param {string[]} fixedCols
 * @param {Awaited<ReturnType<typeof resolveStockScope>>} scope
 */
export function filterStockMatrixRows(rows, fixedCols, scope) {
  if (isUnrestricted(scope)) return rows;

  const itemCol = detectItemNameCol(fixedCols);
  const companyCol = detectCompanyCol(fixedCols);

  return rows.filter(row => {
    const itemOk = matchesNameScope(String(row?.[itemCol] ?? '').trim(), scope.itemNameKeys);
    const companyOk = matchesNameScope(String(row?.[companyCol] ?? '').trim(), scope.companyNameKeys);
    return itemOk && companyOk;
  });
}

/** يفلتر rows كل ملفات Stock (SalesDataFile) دفعة واحدة — يُستعمل في GET /api/sales-data-files */
export function filterStockFiles(files, scope) {
  if (isUnrestricted(scope)) return files;
  return files.map(f => ({
    ...f,
    rows: filterStockMatrixRows(asArray(f.rows), asArray(f.fixedCols), scope),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// توحيد اسم الشركة على صفحة Stock الخام — نفس آلية StockCompanyNameLink المستعملة
// أصلاً في stock-ledger.service.js (resolveCompanyLabel) عند استيعاب حركات رصيد
// المذاخر، لكنها لم تكن مُطبَّقة إطلاقاً على صفحة «Stock» (الجدول الخام) نفسها —
// فنفس الشركة تظهر بتهجئتين مختلفتين بين ملف وآخر («Marcyrl» مقابل
// «REMASEEygptN/A») بلا أي توحيد. هذا لا يُعدّل الملف المرفوع الأصلي (SalesDataFile
// يبقى كما رُفع) — التوحيد يحصل عند القراءة فقط، فيمكن تصحيحه لاحقاً بلا فقدان بيانات.
// ════════════════════════════════════════════════════════════════════════════

/**
 * مُحلِّل اسم شركة جاهز لمستخدم — رابط محفوظ (StockCompanyNameLink) أولاً، وإلا
 * تطابق تام مع كتالوج Company الخاص به، وإلا يبقى الاسم كما ورد. نفس منطق
 * resolveCompanyLabel المحلي في stock-ledger.service.js، مُصدَّر هنا ليُعاد استعماله
 * في قراءة صفحة Stock أيضاً (ولسكربتات الترحيل التي تحتاج نفس القرار).
 * @param {number} userId
 * @returns {Promise<(raw: string) => string>}
 */
export async function loadCompanyLabelResolver(userId) {
  const [links, cos] = await Promise.all([
    prisma.stockCompanyNameLink.findMany({ where: { userId }, select: { fromKey: true, companyId: true } }),
    prisma.company.findMany({ where: { userId }, select: { id: true, name: true } }),
  ]);
  const linkByKey = new Map(links.map(l => [l.fromKey, l.companyId]));
  const nameById = new Map(cos.map(c => [c.id, c.name]));
  const nameByKey = new Map(cos.map(c => [normalizeItemKey(c.name), c.name]));

  return (raw) => {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return trimmed;
    const key = normalizeItemKey(trimmed);
    if (linkByKey.has(key)) {
      const companyId = linkByKey.get(key);
      return companyId ? (nameById.get(companyId) ?? trimmed) : trimmed;
    }
    return nameByKey.get(key) ?? trimmed;
  };
}

/** يُطبِّق مُحلِّل اسم الشركة على عمود الشركة في rows كل ملفات Stock — يُستعمل في
 *  GET /api/sales-data-files قبل الفلترة، كي تُطابِق rows القانونية نطاق المستخدم. */
export function applyCompanyLabelsToFiles(files, resolveLabel) {
  return files.map(f => {
    const fixedCols = asArray(f.fixedCols);
    const companyCol = detectCompanyCol(fixedCols);
    if (!companyCol) return f;
    const rows = asArray(f.rows).map(r => (r && Object.prototype.hasOwnProperty.call(r, companyCol))
      ? { ...r, [companyCol]: resolveLabel(r[companyCol]) }
      : r);
    return { ...f, rows };
  });
}
