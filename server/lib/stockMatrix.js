/**
 * stockMatrix.js — أدوات مشتركة لقراءة ملفات الستوك بصيغة المصفوفة (SalesDataFile)
 *
 * صفحة Stock (SalesDataPage.tsx) تحلّل ملف الستوك في العميل وتخزّنه كـ SalesDataFile:
 *   fixedCols  = أعمدة التعريف (الشركة / المادة / السعر ...)
 *   areaCols   = عمود لكل مذخر: { key, label, region }
 *   rows       = صف لكل ايتم: row[fixedCol] نص، row[areaCol.key] كمية كنص
 *
 * هذه الوحدة تنقل منطق كشف عمود «اسم الايتم» و«الشركة» من الواجهة إلى الخادم
 * ليستعمله دفتر رصيد المذاخر (stock-ledger) عند اشتقاق الستوك الافتتاحي من
 * ملف Stock موجود، بدل تكرار نفس الجداول في مكانين.
 * (المصدر الأصلي: src/pages/SalesDataPage.tsx — detectCompanyCol / detectItemNameCol)
 */

import { isPlaceholderCompanyValue } from './companyResolver.js';

export const COMPANY_KW = ['company', 'comp', 'شركة', 'الشركة', 'شركه', 'الشركه', 'vendor', 'supplier', 'brand', 'manufacture', 'principal', 'item code', 'itemcode'];
export const ITEM_KW_EXACT = ['item', 'الايتم', 'اسم الايتم', 'اسم المادة', 'اسم الماده', 'المادة', 'مادة', 'المواد', 'مواد', 'name', 'product', 'منتج', 'المنتج', 'الاصناف', 'اصناف', 'صنف', 'الدواء', 'دواء'];
export const ITEM_KW_PART = ['item', 'الايتم', 'اسم', 'نام', 'name', 'product', 'مادة', 'دواء', 'صنف'];

/** تطبيع عنوان عمود بنفس طريقة تطبيع القيم (تشكيل، ألف، ة، ى، مسافات) */
export function normColHeader(s) {
  return String(s ?? '').toLowerCase().trim()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A')
    .replace(/\s+/g, ' ');
}

/** @param {string[]} fixedCols @returns {string} اسم عمود الشركة أو '' */
export function detectCompanyCol(fixedCols) {
  const normed = fixedCols.map(normColHeader);
  const kw = COMPANY_KW.map(normColHeader);
  return fixedCols.find((_, i) => kw.some(k => normed[i].includes(k))) ?? '';
}

/** @param {string[]} fixedCols @returns {string} اسم عمود الايتم (مع احتياطي) */
export function detectItemNameCol(fixedCols) {
  const normed = fixedCols.map(normColHeader);
  const exactN = ITEM_KW_EXACT.map(normColHeader);
  const partN = ITEM_KW_PART.map(normColHeader);
  const exact = fixedCols.find((_, i) => exactN.some(k => normed[i] === k));
  if (exact) return exact;
  return (
    fixedCols.find((_, i) =>
      partN.some(k => normed[i].includes(k)) &&
      !normed[i].includes('code') && !normed[i].includes('كود') && !normed[i].includes('id')
    ) ?? fixedCols[1] ?? fixedCols[0] ?? ''
  );
}

/** كمية من خلية نصية في المصفوفة (نفس toNum في صفحة Stock) */
export function matrixQty(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

/**
 * SalesDataFile.fixedCols/areaCols/rows قد تصل كنص JSON (schema.prisma المحلي)
 * أو ككائن جاهز (Json في نسخة postgresql) — هذه تتعامل مع الحالتين.
 */
export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * تسطيح ملف Stock (مصفوفة) إلى صفوف طولية: صف لكل (مذخر × ايتم) بكمية > 0.
 * الخلايا الفارغة والأصفار تُتخطى — 190 ايتم × 17 مذخر = 3230 خلية أغلبها صفر.
 *
 * @param {{fixedCols:any, areaCols:any, rows:any}} file صف SalesDataFile
 * @returns {{warehouse:string, region:string, itemName:string, companyName:string|null, qty:number}[]}
 */
export function flattenStockMatrix(file) {
  const fixedCols = asArray(file.fixedCols);
  const areaCols = asArray(file.areaCols);
  const rows = asArray(file.rows);

  const itemCol = detectItemNameCol(fixedCols);
  const companyCol = detectCompanyCol(fixedCols);

  const out = [];
  for (const row of rows) {
    const itemName = String(row?.[itemCol] ?? '').trim();
    if (!itemName) continue;
    const companyNameRaw = companyCol ? String(row?.[companyCol] ?? '').trim() : '';
    const companyName = (companyNameRaw && !isPlaceholderCompanyValue(companyNameRaw)) ? companyNameRaw : null;

    for (const col of areaCols) {
      if (!col?.key) continue;
      const qty = matrixQty(row?.[col.key]);
      if (qty <= 0) continue;   // صفر/فارغ = لا رصيد، لا صف حركة
      out.push({
        warehouse: String(col.label ?? '').trim(),
        region: String(col.region ?? '').trim(),
        itemName,
        companyName,
        qty,
      });
    }
  }
  return out;
}
