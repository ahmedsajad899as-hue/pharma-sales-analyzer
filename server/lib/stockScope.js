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

/**
 * شرط Prisma لـ StockBalance — يدمج بُعدي الشركة/الايتم (AND)، كل بُعد يُطبَّق
 * فقط إن كان مقيَّداً. StockBalance.companyName نص حر بلا FK؛ المطابقة بالاسم
 * القانوني (نفس normalizeItemKey المستعمل في resolveCompanyLabel وقت الاستيعاب).
 */
export async function buildStockBalanceWhere(userId) {
  const scope = await resolveStockScope(userId);
  if (isUnrestricted(scope)) return {};

  const clauses = [];
  if (scope.itemIds) clauses.push({ itemId: { in: scope.itemIds } });
  if (scope.companyNameKeys?.size) {
    // مطابقة بالاسم القانوني: companyName يُخزَّن أصلاً بصيغته القانونية عند
    // الاستيعاب (resolveCompanyLabel في stock-ledger.service.js) — تطابق تام يكفي هنا.
    const companies = await prisma.scientificCompany.findMany({
      where: { id: { in: scope.companyIds } }, select: { name: true },
    });
    clauses.push({ companyName: { in: companies.map(c => c.name) } });
  }
  if (!clauses.length) return {};
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

/**
 * فلترة صفوف ملف Stock الخام (SalesDataFile.rows) بنطاق المستخدم — اسم
 * الشركة/الايتم هنا نص حر لم يمرّ بأي مطابقة مسبقة (بعكس StockBalance)، فالمطابقة
 * تامة أولاً ثم تشابه (areSimilar) كاحتياط لفروق الكتابة.
 * @param {any[]} rows
 * @param {string[]} fixedCols
 * @param {Awaited<ReturnType<typeof resolveStockScope>>} scope
 */
export function filterStockMatrixRows(rows, fixedCols, scope) {
  if (isUnrestricted(scope)) return rows;

  const itemCol = detectItemNameCol(fixedCols);
  const companyCol = detectCompanyCol(fixedCols);

  const matchesSet = (raw, keys) => {
    if (!keys) return true; // بُعد غير مقيَّد
    const key = normalizeItemKey(raw);
    if (!key) return false;
    if (keys.has(key)) return true;
    for (const k of keys) if (areSimilar(raw, k)) return true;
    return false;
  };

  return rows.filter(row => {
    const itemOk = matchesSet(String(row?.[itemCol] ?? '').trim(), scope.itemNameKeys);
    const companyOk = matchesSet(String(row?.[companyCol] ?? '').trim(), scope.companyNameKeys);
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
