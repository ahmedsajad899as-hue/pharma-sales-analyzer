// ════════════════════════════════════════════════════════════════════════════
// targetCompare.js — مقارنة التارگت بالمبيع النت لشخص واحد (منطق نقي بلا قاعدة بيانات).
//
// المطابقة بالاسم المطبَّع لا بالمعرّف: للايتم الواحد عدة صفوف Item (كتالوج ومؤقتة ولكل
// حساب)، والتارگت قد يكون على صف والمبيع على آخر. القياس على الإنتاج في itemScope.js:
// المعرّفات وحدها تُسقط مبيعات حقيقية. والتطبيع يحافظ على الجرعة وطريقة الإعطاء.
// ════════════════════════════════════════════════════════════════════════════

import { normalizeItemKey } from './itemResolver.js';

const round = n => +Number(n || 0).toFixed(2);

/** الإنجاز بالنسبة المئوية؛ null حين لا تارگت (لا معنى لنسبة بلا هدف). */
export const achievementPct = (net, target) => (target > 0 ? Math.round((net / target) * 100) : null);

/**
 * @param {Array<{itemId:number, target:number, item?:{name:string}}>} targetRows
 * @param {Array<{itemId:number, itemName:string, totalQuantity:number}>} soldItems صافي الكمية (byItem من التقرير)
 * @returns {{rows:Array, unTargeted:Array, totalTarget:number, totalNet:number, pct:number|null}}
 *   الإنجاز الكلي = صافي ايتمات التارگت فقط ÷ مجموع التارگت؛ مبيع ايتم بلا تارگت لا يرفع النسبة
 *   ويُعرض منفصلاً في unTargeted.
 */
export function buildTargetComparison(targetRows, soldItems) {
  const sold = new Map();
  for (const s of soldItems ?? []) {
    const k = normalizeItemKey(s.itemName ?? '');
    const prev = sold.get(k);
    sold.set(k, { itemName: prev?.itemName ?? s.itemName, net: (prev?.net ?? 0) + (s.totalQuantity || 0) });
  }

  // صفّا Item بنفس الاسم يُدمجان: مبيع الايتم لا يُحسب مرتين مقابل تارگتين
  const merged = new Map();
  for (const t of targetRows ?? []) {
    if (!(t.target > 0)) continue; // الحفظ يكتب الخانة الفارغة صفراً: ليست تارگتاً
    const name = t.item?.name ?? `#${t.itemId}`;
    const k = normalizeItemKey(name);
    const row = merged.get(k) ?? { itemIds: [], itemName: name, target: 0 };
    row.itemIds.push(t.itemId);
    row.target += t.target;
    merged.set(k, row);
  }

  const rows = [...merged.entries()].map(([k, r]) => {
    const net = round(sold.get(k)?.net);
    return { ...r, target: round(r.target), net, pct: achievementPct(net, r.target) };
  }).sort((a, b) => a.itemName.localeCompare(b.itemName));

  const unTargeted = [...sold.entries()]
    .filter(([k, s]) => !merged.has(k) && round(s.net) !== 0)
    .map(([, s]) => ({ itemName: s.itemName, net: round(s.net) }))
    .sort((a, b) => b.net - a.net);

  const totalTarget = round(rows.reduce((s, r) => s + r.target, 0));
  const totalNet = round(rows.reduce((s, r) => s + r.net, 0));
  return { rows, unTargeted, totalTarget, totalNet, pct: achievementPct(totalNet, totalTarget) };
}
