/**
 * Pharmacy alerts — منطق «صيدليات تأخرت عن الطلب» في مكان واحد.
 *
 * لماذا مُستخرَج: نفس الحساب يخدم مستهلكَين — تبويب التنبيهات في الواجهة،
 * والمُجدوِل الذي يرسل الإشعارات التلقائية. إبقاؤه في مكانين كان سيُنتج
 * اختلافاً صامتاً بين ما يراه المستخدم وما يصله كإشعار.
 */

import prisma from '../../lib/prisma.js';
import { buildItemScopeFilter } from '../../lib/itemScope.js';

/** تطبيع عربي للمطابقة الضبابية (نفس قواعد بقية الموديول). */
export function norm(s = '') {
  return String(s).trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** مفتاح ثابت لزوج (صيدلية × ايتم) — يُستعمل لمنع تكرار التنبيه. */
export function alertKeyOf(pharmaName, itemName) {
  return `${norm(pharmaName)}|${norm(itemName)}`;
}

function buildFileFilter(fileIds) {
  if (!fileIds) return {};
  const ids = String(fileIds).split(',').map(Number).filter(Boolean);
  if (!ids.length) return {};
  return ids.length === 1 ? { uploadedFileId: ids[0] } : { uploadedFileId: { in: ids } };
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

  // ايتمات المستخدم المعيّنة تُقيّد التنبيهات أيضاً — وإلا نبّهنا على ايتمات
  // لا يعمل عليها أصلاً.
  const itemScope = await buildItemScopeFilter(userId);

  const sales = await prisma.sale.findMany({
    where: { isHidden: false, ...(userId ? { userId } : {}), ...buildFileFilter(fileIds), ...itemScope },
    select: {
      quantity: true, totalValue: true, saleDate: true,
      item:     { select: { name: true } },
      customer: { select: { name: true } },
      area:     { select: { id: true, name: true } },
      rawData:  true,
    },
  });

  const map = new Map();
  const seen = new Set();

  for (const s of sales) {
    const iName = s.item?.name || 'غير محدد';
    let pharmaName = s.customer?.name;
    if (!pharmaName && s.rawData) {
      try {
        const raw = JSON.parse(s.rawData);
        pharmaName = raw.pharmacyName || raw.pharmacy || raw.customer || raw.Customer
          || raw['اسم الصيدلية'] || raw['الصيدلية'] || raw['العميل'] || null;
      } catch { /* صف بلا rawData صالح — نتجاهله */ }
    }
    if (!pharmaName) continue;

    const day = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : '';
    const dedupKey = [norm(pharmaName), norm(iName), day, s.quantity, s.totalValue].join('|');
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const key = `${pharmaName}|||${iName}`;
    if (!map.has(key)) {
      map.set(key, {
        pharmaName, itemName: iName,
        areaName: s.area?.name || '', areaId: s.area?.id ?? null,
        lastOrder: s.saleDate, lastOrderQty: s.quantity, orderCount: 0,
      });
    }
    const e = map.get(key);
    e.orderCount++;
    if (new Date(s.saleDate) > new Date(e.lastOrder)) {
      e.lastOrder    = s.saleDate;
      e.lastOrderQty = s.quantity;
      if (s.area?.id) { e.areaId = s.area.id; e.areaName = s.area.name || e.areaName; }
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
