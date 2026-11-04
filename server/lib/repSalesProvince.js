// ════════════════════════════════════════════════════════════════════════════
// repSalesProvince.js — توزيع المبيع المؤكد في «مبيعات المندوبين» على المحافظات.
//
// هذا ما يظهر في حقل اللكوديشن بتبويب «مندوبين المحافظات». المحافظة من منطقة المبيع
// (كما يُحسب مبيع المحافظة الكلي)، ومنطقة غير معروفة ترجع لمحافظة المندوب نفسه.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Array<{createdById:number, areaName:string|null, lines:Array<{itemId:number|null, quantity:number, unitPrice:number|null}>}>} sales
 * @param {object} ctx
 * @param {(areaName:string|null)=>string|null} ctx.provinceOfArea
 * @param {(userId:number)=>string|null} ctx.homeProvinceOf
 * @param {(userId:number)=>'scientific'|'pharmacy'} ctx.kindOf
 * @param {(itemId:number|null)=>string|null} ctx.teamOfItem  null = ايتم بلا مدير: يدخل المحافظة لا الشركات
 * @param {(itemId:number|null)=>boolean} [ctx.allowItem]     نطاق المدير؛ بلا قيمة = كل الايتمات
 * @returns {{province:string, company:string|null, kind:string, value:number}[]}
 */
export function aggregateProvinceSales(sales, { provinceOfArea, homeProvinceOf, kindOf, teamOfItem, allowItem = () => true }) {
  const out = new Map();
  for (const sale of sales) {
    const province = provinceOfArea(sale.areaName) ?? homeProvinceOf(sale.createdById);
    if (!province) continue;
    const kind = kindOf(sale.createdById);
    for (const line of sale.lines) {
      const value = line.quantity * (line.unitPrice ?? 0);
      if (!value || !allowItem(line.itemId)) continue;
      const company = teamOfItem(line.itemId);
      const key = `${province}|${company ?? ''}|${kind}`;
      const row = out.get(key) ?? { province, company, kind, value: 0 };
      row.value += value;
      out.set(key, row);
    }
  }
  return [...out.values()];
}

/** شرط saleDate من معاملات التقارير: شهر YYYY-MM، أو من/إلى. */
export function saleDateRange({ month, startDate, endDate } = {}) {
  if (/^\d{4}-\d{2}$/.test(String(month ?? ''))) {
    const [y, m] = String(month).split('-').map(Number);
    return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
  }
  const range = {};
  if (startDate) range.gte = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  if (endDate) range.lte = new Date(`${String(endDate).slice(0, 10)}T23:59:59Z`);
  return Object.keys(range).length ? range : null;
}
