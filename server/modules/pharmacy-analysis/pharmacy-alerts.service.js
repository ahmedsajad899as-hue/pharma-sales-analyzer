/**
 * Pharmacy alerts — منطق «صيدليات تأخرت عن الطلب» في مكان واحد.
 *
 * لماذا مُستخرَج: نفس الحساب يخدم مستهلكَين — تبويب التنبيهات في الواجهة،
 * والمُجدوِل الذي يرسل الإشعارات التلقائية. إبقاؤه في مكانين كان سيُنتج
 * اختلافاً صامتاً بين ما يراه المستخدم وما يصله كإشعار.
 */

import { norm, getScopedSales, dedupCrossFile } from './scoped-sales.js';

export { norm };

/**
 * A stable key for a (pharmacy x item) pair - used to avoid repeat alerts.
 */
export function alertKeyOf(pharmaName, itemName) {
  return `${norm(pharmaName)}|${norm(itemName)}`;
}

/**
 * يحسب الصيدليات × الايتمات التي تجاوزت مدة بلا طلبية جديدة.
 *
 * لكل زوج (صيدلية، ايتم) نحتفظ بأحدث طلبية فقط: الطلبيات الأقدم لا تعني شيئاً
 * بمجرد وجود أحدث منها. والصفوف المكررة عبر ملفات متداخلة تُستبعَد بمفتاح
 * (صيدلية، ايتم، تاريخ، كمية، قيمة) — نفس ملفٍ مرفوع مرتين لا يضاعف العدّ.
 *
 * @param {number} userId        مالك الملفات
 * @param {{ fileIds?: string|null, thresholdDays?: number }} opts
 * @returns {Promise<Array>} مرتبة تنازلياً حسب الأيام منذ آخر طلبية
 */
export async function computePharmacyAlerts(userId, opts = {}) {
  const { fileIds = null, thresholdDays = 30 } = opts;

  // نفس المُحمِّل المشترك مع تبويبَي الصيدليات والايتمات: استعلام واحد مخزَّن
  // مؤقتاً للنطاق بدل استعلام ثالث مستقل (كان يجلب rawData لكل صف أيضاً).
  const sales = await getScopedSales(userId, fileIds);

  // التكرار يُطوى عبر الملفات المتداخلة فقط — كانت النسخة السابقة تُسقط أي
  // صفّين متطابقَي القيم ولو كانا طلبيتين حقيقيتين في الملف نفسه، فتنقص
  // «عدد الطلبيات» في التنبيهات كما كان يحدث في تبويب الصيدليات.
  const deduped = dedupCrossFile(
    sales.filter(s => s._pharmaName),
    s => [s._normPharma, s._normItem, s._day, s.quantity, s.totalValue].join('|'),
  );

  const map = new Map();

  for (const s of deduped) {
    const iName = s._itemName || 'غير محدد';
    const pharmaName = s._pharmaName;

    const key = `${pharmaName}|||${iName}`;
    if (!map.has(key)) {
      map.set(key, {
        pharmaName, itemName: iName,
        areaName: s._areaName, areaId: s.areaId ?? null,
        lastOrder: s.saleDate, lastOrderQty: s.quantity, orderCount: 0,
      });
    }
    const e = map.get(key);
    e.orderCount++;
    if (new Date(s.saleDate) > new Date(e.lastOrder)) {
      e.lastOrder    = s.saleDate;
      e.lastOrderQty = s.quantity;
      if (s.areaId) { e.areaId = s.areaId; e.areaName = s._areaName || e.areaName; }
    }
  }

  const now = Date.now();
  return [...map.values()]
    .map(e => ({
      ...e,
      totalQty: e.lastOrderQty,
      daysSinceLast: Math.floor((now - new Date(e.lastOrder).getTime()) / 86400000),
    }))
    .filter(e => e.daysSinceLast >= thresholdDays)
    .sort((a, b) => b.daysSinceLast - a.daysSinceLast);
}
