// قواعد أهلية المندوب المقترَح للطلبية. نقيّ بلا قاعدة بيانات: npm run test:rep-guess
import { isManagementRepRecord, candidateOwnsItem, candidateHoldsItem, provinceIdByNameKey, rowCoverage, candidateCoversRow } from '../server/lib/repGuessRules.js';
import { normalizeAreaName } from '../server/lib/itemResolver.js';

let fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  got: ${got}  want: ${want}`}`);
};

const cand = ({ items = [], keys = [], brands = [], companies = [], owned = [], allItems = [] } = {}) => ({
  explicitItems: new Set(items), itemKeys: new Set(keys), brands: new Set(brands),
  companies: new Set(companies), ownedCompanies: new Set(owned), allItemCompanies: new Set(allItems),
});

const managers = new Set(['yahay sajjad']);
eq('سجلّ مربوط بمدير ليس مندوباً', isManagementRepRecord(['company_manager'], 'x', new Set()), true);
eq('سجلّ بلا ربط يحمل اسم مدير ليس مندوباً', isManagementRepRecord([], 'yahay sajjad', managers), true);
eq('سجلّ بلا ربط باسم آخر يبقى مرشّحاً', isManagementRepRecord([], 'حسين قحطان', managers), false);
eq('سجلّ مربوط بمندوب وبمدير يبقى مرشّحاً', isManagementRepRecord(['company_manager', 'scientific_rep'], 'x', managers), false);

const moreserc = { itemId: 1, itemKey: 'moreserc 16 mg', brand: 'moreserc', sciId: 7 };
eq('قائمة صريحة بلا الصنف ⇒ ليس صاحبه', candidateOwnsItem(cand({ items: [9], keys: ['devit 20'], brands: ['devit'] }), moreserc), false);
eq('الصنف نفسه في القائمة', candidateOwnsItem(cand({ items: [1] }), moreserc), true);
eq('نفس الاسم بصفّ كتالوج آخر', candidateOwnsItem(cand({ items: [2], keys: ['moreserc 16 mg'] }), moreserc), true);
eq('نفس العلامة بجرعة أخرى', candidateOwnsItem(cand({ items: [3], brands: ['moreserc'] }), moreserc), true);
eq('بلا أي تعيين = الكل', candidateOwnsItem(cand(), moreserc), true);
eq('شركات معيَّنة بلا هذه الشركة', candidateOwnsItem(cand({ companies: [3] }), moreserc), false);
eq('الشركة معيَّنة بلا قائمة ايتمات', candidateOwnsItem(cand({ owned: [7] }), moreserc), true);
eq('فريق محافظة: كل ايتمات الشركة تغلب القائمة', candidateOwnsItem(cand({ items: [9], allItems: [7] }), moreserc), true);
eq('صنف غير مربوط لا يُنفى باسمه', candidateOwnsItem(cand({ items: [9], brands: ['devit'] }), { itemKey: 'مورسيرك', brand: 'مورسيرك' }), true);

// ── طلبية بالنجف (2026-11-06): اسم محافظة لا منطقة ⇒ كان يُقترح مندوبو بغداد ──
const byKey = provinceIdByNameKey([
  { id: 12, name: 'النجف', aliases: '["نجف"]' }, { id: 5, name: 'القادسية', aliases: null }, { id: 9, name: 'كربلاء', aliases: 'خربان' },
], normalizeAreaName);
eq('اسم المحافظة', byKey.get(normalizeAreaName('النجف')), 12);
eq('بلا «ال»', byKey.get(normalizeAreaName('نجف')), 12);
eq('aliases تالف لا يكسر الفهرس', byKey.get(normalizeAreaName('كربلاء')), 9);

const byProvince = new Map([[12, [100, 101]], [5, [200]]]);
const cover = (name, areaIds = []) => rowCoverage({ areaIds: new Set(areaIds), areaKey: normalizeAreaName(name), provinceByKey: byKey, areaIdsByProvince: byProvince });
eq('«النجف» بلا صفّ منطقة ⇒ المحافظة', cover('النجف').provinceId, 12);
eq('وتشمل كل مناطقها', cover('النجف').areaIds.size, 2);
eq('منطقة مطابقة تغلب المحافظة («القادسية» في الكرخ)', cover('القادسية', [777]).provinceId, null);
eq('اسم مجهول يبقى بلا نطاق', cover('حي غير معروف').provinceId, null);
eq('محافظة بلا مناطق لا تكسر', cover('كربلاء').areaIds.size, 0);

const rep = ({ areas = [], provinces = [] } = {}) => ({ areas: new Set(areas), provinces: new Set(provinces) });
eq('مندوب المحافظة يغطّيها', candidateCoversRow(rep({ provinces: [12] }), cover('النجف')), true);
eq('مندوب بمنطقة داخلها يغطّيها', candidateCoversRow(rep({ areas: [101] }), cover('النجف')), true);
eq('مندوب بغداد لا يغطّي النجف', candidateCoversRow(rep({ areas: [555], provinces: [1] }), cover('النجف')), false);
eq('تغطية منطقة عادية', candidateCoversRow(rep({ areas: [777] }), cover('القادسية', [777])), true);
eq('مندوب آخر لا يغطّي المنطقة', candidateCoversRow(rep({ areas: [1] }), cover('القادسية', [777])), false);

// ── المعيار تعيين الايتم لا شركة المندوب (قرار صاحب المشروع 2026-11-06) ──
const holder = ({ items = [], owned = [], keys = [] } = {}) => ({ items: new Set(items), ownedItems: new Set(owned), heldKeys: new Set(keys) });
const amok = { itemId: 31, itemKey: 'amoklavin bid 1000mg 10tab' };
eq('معيَّن له عبر تعيين الحساب', candidateHoldsItem(holder({ items: [31] }), amok), true);
eq('معيَّن له عبر تعيين الفريق', candidateHoldsItem(holder({ owned: [31] }), amok), true);
eq('نفس الصنف بصفّ كتالوج آخر', candidateHoldsItem(holder({ items: [90], keys: ['amoklavin bid 1000mg 10tab'] }), amok), true);
eq('شركته فقط لا تكفي', candidateHoldsItem(holder(), amok), false);
eq('جرعة أخرى ليست تعييناً', candidateHoldsItem(holder({ items: [30], keys: ['amoklavin bid 625mg 10tab'] }), amok), false);
// كانت تُنفى: قائمة فريقها (ownedItems) بلا الصنف، وهو في تعيين حسابها.
eq('تعيين الحساب يكفي ولو قائمة الفريق بلا الصنف', candidateOwnsItem(
  { ...cand({ items: [77], keys: ['pantactive'], brands: ['pantactive'] }), items: new Set([31]), ownedItems: new Set([77]), heldKeys: new Set(['amoklavin bid 1000mg 10tab']) },
  { ...amok, brand: 'amoklavin', sciId: 3 }), true);

console.log(fail ? `\n✗ ${fail} فشل` : '\n✓ كلها نجحت');
process.exit(fail ? 1 : 0);
