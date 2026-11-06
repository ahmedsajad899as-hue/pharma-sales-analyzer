// قواعد أهلية المندوب المقترَح للطلبية. نقيّ بلا قاعدة بيانات: npm run test:rep-guess
import { isManagementRepRecord, candidateOwnsItem } from '../server/lib/repGuessRules.js';

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

console.log(fail ? `\n✗ ${fail} فشل` : '\n✓ كلها نجحت');
process.exit(fail ? 1 : 0);
