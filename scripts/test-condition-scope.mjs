// اختبار تقييد شيتات ملف اللكوديشن بايتمات مدير الشركة — منطق نقيّ بلا قاعدة بيانات.
// npm run test:condition-scope
import { restrictSheetsToItems } from '../server/lib/conditionFile.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const row = (id, itemId, total, invoice) => ({ id, itemId, quantity: 1, total, invoice, date: '2026-10-01', pharmacy: 'ص' });
const sheet = (rep, team, rows) => ({
  rep, team, rows,
  quantity: rows.length,
  total: rows.reduce((a, r) => a + r.total, 0),
  orders: new Set(rows.map(r => r.invoice)).size,
});
const sheets = () => [
  sheet('مندوب مختلط', 'humanis', [row(1, 10, 100, 'a'), row(2, 20, 500, 'b'), row(3, null, 900, 'c')]),
  sheet('شركته الرئيسية deva', 'deva', [row(4, 10, 40, 'd')]),
  sheet('كل مبيعه لغيره', 'CT', [row(5, 20, 70, 'e')]),
];

const out = restrictSheetsToItems(sheets(), new Set([10]), 'humanis');
eq('الشيت الذي لا يبقى فيه شيء يسقط', out.map(s => s.rep), ['مندوب مختلط', 'شركته الرئيسية deva']);
eq('صفوف ايتمات المدير فقط — لا ايتم غيره ولا صف بلا ايتم', out[0].rows.map(r => r.id), [1]);
eq('المجاميع تُعاد حسابها', [out[0].quantity, out[0].total, out[0].orders], [1, 100, 1]);
eq('شركة واحدة فقط فيبقى عرض المندوبين', [...new Set(out.map(s => s.team))], ['humanis']);

const input = sheets();
eq('مدير بلا ايتمات: الشيتات كما هي', restrictSheetsToItems(input, new Set(), 'humanis'), input);

restrictSheetsToItems(input, new Set([10]), 'humanis');
eq('لا يعدّل الشيتات الأصلية (شيت الشركة يُبنى منها)', [input[0].rows.length, input[1].team], [3, 'deva']);

if (fail) { console.error(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
process.exit(0);
