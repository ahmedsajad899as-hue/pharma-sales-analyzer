// ════════════════════════════════════════════════════════════════════════════
// repLiquidation.js — مبيعات المندوب العلمي (اللكوديشن) في «مندوبين المحافظات».
//
// قاعدة المستخدم (2026-11-04): مبيع المندوب = ما أكّده في «مبيعات المندوبين» + صفوف ملفات
// ميركاتو باسمه، لا غيرهما — لا ملف المكتب ولا ملف الكوديشن ولا الترانزيت.
//
// المندوب قد يسجّل طلبية موجودة أصلاً في ميركاتو، فسطرها يُحسب من ميركاتو وحده: ميركاتو
// يحمل القيمة الفعلية، بينما سطر المندوب بسعر الكتالوج وقت التسجيل.
// ════════════════════════════════════════════════════════════════════════════

import { normalizeArabic, normalizeItemKey } from './itemResolver.js';
import { areSimilar } from './fuzzyMatch.js';
import { CONDITION_VARIANT } from './saleFingerprint.js';
import { matchHelpers } from './manualDuplicateCheck.js';

const DAY = 86400000;
/** نفس الكمية: نفس نافذة كشف التكرار في manualDuplicateCheck (dateRelation «near»). */
export const SAME_QTY_WINDOW_DAYS = 7;
/** كمية مختلفة (تجهيز جزئي): نفس اليوم ±1 فقط، وإلا فهي طلبية أخرى للصيدلية نفسها. */
const ANY_QTY_WINDOW_DAYS = 1;

const parseRaw = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const MANUAL_SOURCE_RE = /"source"\s*:\s*"(manual-invoice|[a-z-]+-order)"/;

/** صف إكسل ميركاتو فقط: ملف الكوديشن يشاركه sourceSystem، وفواتير البوت قد تُحفظ في أي ملف. */
export function isPureMercatoRow(s) {
  if (s.transit || s.uploadedFile?.sourceSystem !== 'mercato') return false;
  if (String(s.uploadedFile?.mergeGroup ?? '').endsWith(`|${CONDITION_VARIANT}`)) return false;
  return !(typeof s.rawData === 'string' && MANUAL_SOURCE_RE.test(s.rawData));
}

function prepareMercatoRow(s) {
  const raw = parseRaw(s.rawData);
  const name = s.item?.name ?? '';
  return {
    row: s,
    itemId: s.itemId ?? null,
    keys: new Set([normalizeItemKey(name), raw['اسم المادة بالمكتب'] ? normalizeItemKey(raw['اسم المادة بالمكتب']) : null].filter(Boolean)),
    qty: Math.abs(Number(s.quantity) || 0),
    pharmacy: matchHelpers.pharmKey(raw.pharmacy || s.customer?.name || raw['اسم الشركة'] || ''),
    warehouse: matchHelpers.whKey(raw.warehouse ?? raw['اسم المذخر']),
    area: matchHelpers.areaKey(s.area?.name),
    invoice: matchHelpers.realInvoice(raw.invoiceNumber ?? raw['رقم طلبية المذخر'] ?? raw['رقم الفاتورة']),
    day: matchHelpers.dayOf(s.saleDate),
  };
}

function prepareRepSale(sale) {
  return {
    sale,
    pharmacy: matchHelpers.pharmKey(sale.pharmacyName),
    warehouse: matchHelpers.whKey(sale.warehouseName),
    area: matchHelpers.areaKey(sale.areaName),
    invoice: matchHelpers.realInvoice(sale.invoiceNumber),
    day: matchHelpers.dayOf(sale.saleDate),
    lines: sale.lines.map(line => ({
      line,
      keys: new Set([normalizeItemKey(line.itemName ?? '')].filter(Boolean)),
    })),
  };
}

const sameItem = (l, m) => {
  if (l.line.itemId && m.itemId && l.line.itemId === m.itemId) return true;
  for (const k of l.keys) if (m.keys.has(k)) return true;
  for (const a of l.keys) for (const b of m.keys) if (areSimilar(a, b)) return true;
  return false;
};

/** ميركاتو قد يعدّ البونص ضمن الكمية أو خارجها. */
const sameQuantity = (line, qty) => {
  const q = Number(line.quantity) || 0;
  return Math.abs(qty - q) < 0.001 || Math.abs(qty - (q + (Number(line.bonusQty) || 0))) < 0.001;
};

/** فرق الأيام إن كان سطر ميركاتو طلبية المندوب نفسها، وإلا null. */
function matchGap(s, l, m, windowDays) {
  const invoiceSame = Boolean(s.invoice && s.invoice === m.invoice);
  if (!invoiceSame && matchHelpers.namesMatch(s.pharmacy, m.pharmacy) !== true) return null;
  // مذخر مختلف أو منطقة مختلفة = طلبية أو صيدلية أخرى بالاسم نفسه. الطرف الفارغ لا يمنع.
  if (matchHelpers.namesMatch(s.warehouse, m.warehouse, 0.85) === false) return null;
  if (!invoiceSame && matchHelpers.namesMatch(s.area, m.area, 0.85) === false) return null;
  if (!sameItem(l, m)) return null;
  // صف ميركاتو بلا تاريخ لا يُطابَق إلا برقم الفاتورة: الصيدلية والايتم وحدهما لا يكفيان.
  if (s.day == null || m.day == null) return invoiceSame ? 0 : null;
  const gap = Math.abs(s.day - m.day) / DAY;
  return gap <= windowDays ? gap : null;
}

/**
 * يُسقط من مبيعات المندوب كل سطر موجود في صفوف ميركاتو الممرَّرة. كل صف ميركاتو يقابل سطراً
 * واحداً: نفس الكمية أولاً كي لا «يسرق» سطرٌ بكمية مختلفة مطابقةَ السطر الصحيح.
 *
 * @param {Array} sales مبيعات مؤكدة بأسطرها
 * @param {Array} mercatoRows صفوف Sale من ميركاتو لنفس المندوب؛ الإرجاع يُتجاهل
 * @param {Set} [used] صفوف ميركاتو المستعملة، يشاركها أكثر من حساب بالاسم نفسه
 * @returns {{sales: Array, droppedLines: number[]}} droppedLines = معرّفات الأسطر المُسقطة
 */
export function dropLinesFoundInMercato(sales, mercatoRows, used = new Set()) {
  const pool = mercatoRows
    .filter(r => String(r.recordType ?? 'sale').trim().toLowerCase() !== 'return')
    .map(prepareMercatoRow);
  const prepared = [...sales].sort((a, b) => new Date(a.saleDate) - new Date(b.saleDate)).map(prepareRepSale);
  const dropped = new Set();

  const runPass = (windowDays, accepts) => {
    for (const s of prepared) {
      for (const l of s.lines) {
        if (dropped.has(l.line)) continue;
        let best = null;
        for (const m of pool) {
          if (used.has(m.row) || !accepts(l.line, m.qty)) continue;
          const gap = matchGap(s, l, m, windowDays);
          if (gap != null && (!best || gap < best.gap)) best = { m, gap };
        }
        if (best) { used.add(best.m.row); dropped.add(l.line); }
      }
    }
  };
  runPass(SAME_QTY_WINDOW_DAYS, sameQuantity);
  runPass(ANY_QTY_WINDOW_DAYS, () => true);

  const kept = sales
    .map(sale => ({ ...sale, lines: sale.lines.filter(l => !dropped.has(l)) }))
    .filter(sale => sale.lines.length > 0);
  return { sales: kept, droppedLines: [...dropped].map(l => l.id) };
}

/**
 * يوسّع مدى التاريخ بنافذة التكرار: مبيع مسجَّل 31/10 قد يكون في ميركاتو بتاريخ 1/11، فيُطابَق
 * ولا يُحسب في أي شهر مرتين. حدود القيم كما يقرؤها resolveSciRepSales.
 * @returns {{startDate?:Date, endDate?:Date}}
 */
export function widenDateRange({ startDate, endDate } = {}, days = SAME_QTY_WINDOW_DAYS) {
  const out = {};
  if (startDate) out.startDate = new Date(new Date(startDate).getTime() - days * DAY);
  if (endDate) out.endDate = new Date(new Date(endDate).getTime() + days * DAY);
  return out;
}

/** هل التاريخ داخل المدى الأصلي؟ نهاية المدى = آخر ذلك اليوم، كما في resolveSciRepSales. */
export function isInDateRange(date, { startDate, endDate } = {}) {
  const t = new Date(date).getTime();
  if (startDate && t < new Date(startDate).getTime()) return false;
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    if (t > end.getTime()) return false;
  }
  return true;
}

/** شرط Prisma لمدى التاريخ بالقراءة نفسها، أو {} بلا مدى. */
export function dateRangeWhere({ startDate, endDate } = {}, field = 'saleDate') {
  const cond = {};
  if (startDate) cond.gte = new Date(startDate);
  if (endDate) {
    cond.lte = new Date(endDate);
    cond.lte.setUTCHours(23, 59, 59, 999);
  }
  return Object.keys(cond).length ? { [field]: cond } : {};
}

/** قوائم الحجب على مبيعات المندوب كما تُطبَّق على التقارير: منطقة أو صيدلية تحجب المبيع، وايتم يحجب سطره. */
export function dropBlockedLines(sales, blocks) {
  return sales
    .filter(s => !blocks.areas.has(normalizeArabic(s.areaName ?? '')) && !blocks.pharmacies.has(normalizeArabic(s.pharmacyName ?? '')))
    .map(s => ({ ...s, lines: s.lines.filter(l => !blocks.items.has(normalizeArabic(l.itemName ?? ''))) }))
    .filter(s => s.lines.length > 0);
}

/**
 * يحوّل أسطر مبيع مؤكد إلى صفوف بشكل Sale ليعمل عليها التجميع والتصدير كما هما. mergeGroup
 * بلاحقة الكوديشن يضعها في سطر اللكوديشن (bySource) وشيته. السعر بالدينار، فالعملة IQD.
 *
 * @param {object} sale مبيع بأسطره
 * @param {object} ctx
 * @param {string} ctx.repName
 * @param {number} ctx.iqdRate
 * @param {(name:string|null)=>{id:any,name:string,province?:{name:string}|null}} ctx.areaOf
 * @param {(line:object)=>{id:any,name:string}} ctx.itemOf
 */
export function repSaleToRows(sale, { repName, iqdRate, areaOf, itemOf }) {
  const orderNo = sale.invoiceNumber || `RS-${sale.id}`;
  const day = new Date(sale.saleDate).toISOString().slice(0, 10);
  const area = areaOf(sale.areaName);
  return sale.lines.map((line) => {
    const totalValue = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
    return {
      quantity: line.quantity,
      totalValue,
      recordType: 'sale',
      saleDate: sale.saleDate,
      areaId: typeof area.id === 'number' ? area.id : null,
      itemId: line.itemId ?? null,
      customerId: null,
      uploadedFileId: null,
      customerInfoNorm: null,
      area,
      item: itemOf(line),
      representative: { id: -sale.createdById, name: repName },
      customer: { name: sale.pharmacyName },
      uploadedFile: { detectedCurrency: 'IQD', exchangeRate: iqdRate, sourceSystem: 'mercato', mergeGroup: `rep-sales|${CONDITION_VARIANT}` },
      // بترويسات ميركاتو كصفوف الإدخال اليدوي (insertManualSales)، فتتوحد أعمدة التصدير.
      rawData: JSON.stringify({
        'رقم طلبية المذخر': orderNo,
        'أنشات بتاريخ': day,
        'اسم الشركة': sale.pharmacyName,
        'المنطقة': sale.areaName ?? '',
        'اسم المندوب': repName,
        'الصنف': line.companyName ?? '',
        'اسم المادة بالمكتب': line.itemName,
        'الكمية': line.quantity,
        'كمية البونص': line.bonusQty ?? 0,
        'السعر': line.unitPrice ?? '',
        'المجموع الكلي': totalValue,
        'اسم المذخر': sale.warehouseName ?? '',
        source: 'rep-sale',
      }),
    };
  });
}
