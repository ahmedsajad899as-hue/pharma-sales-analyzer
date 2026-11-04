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

/**
 * صافي صفوف ميركاتو لكل محافظة وشركة، بعمود usd مستقل عن value: قيمها بعملة ملفها فتُوحَّد
 * بالدولار كبقية التقارير، بينما value بالدينار من أسعار الكتالوج. الإرجاع يُطرح.
 *
 * @param {Array<{itemId:number|null, recordType?:string}>} rows
 * @param {object} ctx
 * @param {(row:object)=>string|null} ctx.provinceOf
 * @param {(row:object)=>number} ctx.usdOf
 * @param {(itemId:number|null)=>string|null} ctx.teamOfItem
 * @param {(itemId:number|null)=>boolean} [ctx.allowItem]
 * @param {Array<{province:string, company:string|null, kind:string, value:number}>} [base] صفوف مبيعات المندوبين تُضاف إليها
 * @returns {{province:string, company:string|null, kind:string, value:number, usd:number}[]}
 */
export function addMercatoToProvinces(rows, { provinceOf, usdOf, teamOfItem, allowItem = () => true }, base = []) {
  const out = new Map(base.map(r => [`${r.province}|${r.company ?? ''}|${r.kind}`, { ...r, usd: 0 }]));
  for (const row of rows) {
    if (!allowItem(row.itemId)) continue;
    const province = provinceOf(row);
    if (!province) continue;
    const company = teamOfItem(row.itemId);
    const key = `${province}|${company ?? ''}|scientific`;
    const cell = out.get(key) ?? { province, company, kind: 'scientific', value: 0, usd: 0 };
    const sign = String(row.recordType ?? '').trim().toLowerCase() === 'return' ? -1 : 1;
    cell.usd += sign * usdOf(row);
    out.set(key, cell);
  }
  return [...out.values()];
}
