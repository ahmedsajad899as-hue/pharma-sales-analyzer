// توزيع مبيع «مبيعات المندوبين» المؤكد على المحافظات — npm run test:rep-sales-province
import assert from 'node:assert/strict';
import { aggregateProvinceSales, addMercatoToProvinces } from '../server/lib/repSalesProvince.js';

const ctx = {
  provinceOfArea: (a) => ({ 'حي الحسين': 'كربلاء', 'الكرادة': 'بغداد' })[a] ?? null,
  homeProvinceOf: (u) => ({ 1: 'كربلاء', 2: 'النجف' })[u] ?? null,
  kindOf: (u) => (u === 3 ? 'pharmacy' : 'scientific'),
  teamOfItem: (i) => ({ 10: 'Deva', 11: 'Humanis' })[i] ?? null,
};
const line = (itemId, quantity, unitPrice) => ({ itemId, quantity, unitPrice });
const run = (sales, extra = {}) => aggregateProvinceSales(sales, { ...ctx, ...extra });

assert.deepEqual(
  run([{ createdById: 1, areaName: 'حي الحسين', lines: [line(10, 2, 100), line(10, 1, 50)] }]),
  [{ province: 'كربلاء', company: 'Deva', kind: 'scientific', value: 250 }],
  'الكمية × السعر، والأسطر المتشابهة تُجمع',
);
assert.equal(run([{ createdById: 2, areaName: 'حي الحسين', lines: [line(10, 1, 100)] }])[0].province, 'كربلاء', 'منطقة المبيع تغلب محافظة المندوب');
assert.equal(run([{ createdById: 2, areaName: 'منطقة مكتوبة يدوياً', lines: [line(10, 1, 100)] }])[0].province, 'النجف', 'منطقة غير معروفة ترجع لمحافظة المندوب');
assert.deepEqual(run([{ createdById: 9, areaName: null, lines: [line(10, 1, 100)] }]), [], 'بلا منطقة ولا محافظة: لا يُنسب لأي محافظة');
assert.deepEqual(run([{ createdById: 1, areaName: 'حي الحسين', lines: [line(null, 5, null)] }]), [], 'ايتم حر بلا سعر لا يضيف قيمة');
assert.equal(run([{ createdById: 1, areaName: 'حي الحسين', lines: [line(99, 1, 100)] }])[0].company, null, 'ايتم بلا مدير يبقى في المحافظة بلا شركة');
assert.equal(run([{ createdById: 3, areaName: 'حي الحسين', lines: [line(10, 1, 100)] }])[0].kind, 'pharmacy', 'المسوق يُفصل عن العلمي');
assert.deepEqual(
  run([{ createdById: 1, areaName: 'حي الحسين', lines: [line(10, 1, 100), line(11, 1, 70)] }], { allowItem: (i) => i === 11 }),
  [{ province: 'كربلاء', company: 'Humanis', kind: 'scientific', value: 70 }],
  'مدير الشركة: ايتماته فقط',
);

// ── ميركاتو فوق مبيعات المندوبين ──
const mctx = { provinceOf: (r) => r.province ?? null, usdOf: (r) => r.usd, teamOfItem: ctx.teamOfItem };
assert.deepEqual(
  addMercatoToProvinces([{ itemId: 10, province: 'كربلاء', usd: 5 }, { itemId: 10, province: 'كربلاء', usd: 2, recordType: 'return' }], mctx, [{ province: 'كربلاء', company: 'Deva', kind: 'scientific', value: 1000 }]),
  [{ province: 'كربلاء', company: 'Deva', kind: 'scientific', value: 1000, usd: 3 }],
  'تُضاف للخلية نفسها، والإرجاع يُطرح، والعملتان منفصلتان',
);
assert.deepEqual(addMercatoToProvinces([{ itemId: 10, usd: 5 }], mctx), [], 'بلا محافظة لا يُنسب');
assert.deepEqual(addMercatoToProvinces([{ itemId: 10, province: 'كربلاء', usd: 5 }], { ...mctx, allowItem: (i) => i === 11 }), [], 'مدير الشركة: ايتماته فقط');
assert.equal(addMercatoToProvinces([], mctx, [{ province: 'كربلاء', company: null, kind: 'pharmacy', value: 9 }])[0].kind, 'pharmacy', 'صفوف المسوق تبقى كما هي');

console.log('✓ rep-sales-province');
