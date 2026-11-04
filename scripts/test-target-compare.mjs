// ════════════════════════════════════════════════════════════════════════════
// اختبار مقارنة التارگت بالمبيع النت (server/lib/targetCompare.js)
// تشغيل:  node scripts/test-target-compare.mjs
// ════════════════════════════════════════════════════════════════════════════

import { buildTargetComparison } from '../server/lib/targetCompare.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n   got:  ${JSON.stringify(actual)}\n   want: ${JSON.stringify(expected)}`}`);
};
const t = (itemId, name, target) => ({ itemId, target, item: { name } });
const s = (itemId, itemName, totalQuantity) => ({ itemId, itemName, totalQuantity });

{
  const r = buildTargetComparison([t(1, 'AIRTIDE 100', 100)], [s(99, 'airtide  100', 80)]);
  check('المبيع على صف Item آخر بنفس الاسم يُحتسب', r.rows[0].net, 80);
  check('نسبة الإنجاز', r.pct, 80);
}
{
  const r = buildTargetComparison([t(1, 'AIRTIDE 100', 100)], [s(2, 'AIRTIDE 250', 80)]);
  check('جرعة أخرى ليست نفس الايتم', r.rows[0].net, 0);
  check('...وتظهر كمبيع بلا تارگت', r.unTargeted, [{ itemName: 'AIRTIDE 250', net: 80 }]);
  check('...ولا ترفع الإنجاز', r.pct, 0);
}
{
  const r = buildTargetComparison([t(1, 'X', 50), t(2, 'x', 50)], [s(1, 'X', 60)]);
  check('صفّان بنفس الاسم يُدمجان ولا يتكرر مبيعهما', [r.rows.length, r.totalTarget, r.totalNet], [1, 100, 60]);
  check('...ويحتفظان بمعرّفيهما لخلايا الجدول', r.rows[0].itemIds, [1, 2]);
}
{
  const r = buildTargetComparison([t(1, 'X', 0)], [s(1, 'X', 10)]);
  check('تارگت صفر ليس تارگتاً', [r.rows.length, r.pct], [0, null]);
  check('...ومبيعه يبقى ظاهراً', r.unTargeted, [{ itemName: 'X', net: 10 }]);
}
{
  const r = buildTargetComparison([t(1, 'X', 100)], [s(1, 'X', -5)]);
  check('المرتجع الأكبر من المبيع يعطي صافياً سالباً', [r.totalNet, r.pct], [-5, -5]);
}
{
  const r = buildTargetComparison([], [s(1, 'X', 0)]);
  check('ايتم صافيه صفر لا يظهر', r.unTargeted, []);
  check('بلا بيانات لا ينهار', [buildTargetComparison(null, null).totalTarget, buildTargetComparison(null, null).pct], [0, null]);
}

console.log(failed ? `\n${failed} فشل` : '\nكل الاختبارات نجحت');
process.exit(failed ? 1 : 0);
