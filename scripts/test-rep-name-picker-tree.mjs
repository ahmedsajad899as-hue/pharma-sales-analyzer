// اختبار ترتيب قائمة نسب أسماء ميركاتو بالهيكلية — npm run test:rep-name-picker-tree
import assert from 'node:assert/strict';
import { buildRepNamePickerTree, SECTION } from '../server/lib/repNamePickerTree.js';

const U = (id, role, name, extra = {}) => ({ id, role, name, company: 'CT', isMarketer: false, managerIds: [], side: null, ...extra });
const users = [
  U(1, 'company_manager', 'مدير CT'),
  U(2, 'team_leader', 'نور / ليدر الرصافة'),
  U(3, 'team_leader', 'سامر', { side: 'الكرخ' }),
  U(4, 'scientific_rep', 'رسول', { managerIds: [3] }),
  U(5, 'scientific_rep', 'احمد', { managerIds: [2] }),
  U(6, 'scientific_rep', 'بلا ليدر'),
  U(10, 'team_leader', 'ليدر البصرة'),
  U(11, 'scientific_rep', 'مندوب البصرة', { company: 'osel' }),
  U(20, 'company_manager', 'مدير المسوقين', { isMarketer: true, company: null }),
  U(21, 'team_leader', 'ليدر مسوقين', { isMarketer: true, side: 'الرصافة' }),
  U(22, 'scientific_rep', 'مسوق', { isMarketer: true, managerIds: [21] }),
  U(30, 'company_manager', 'وليد', { isMarketer: true }),
  U(31, 'scientific_rep', 'مسوق الانبار', { isMarketer: true }),
  U(40, 'office_employee', 'موظف'),
  U(41, 'office_manager', 'مدير مكتب'),
];
const tree = buildRepNamePickerTree({
  users,
  provinceTeams: [{ provinceName: 'البصرة', leaderUserId: 10, repUserIds: [11] }],
  provinceMarketers: new Map([[31, ['الانبار']]]),
  provinceMarketerManagers: new Set([30]),
});
const ids = tree.map(n => n.userId);
const at = (id) => tree.find(n => n.userId === id);

// الشركة: المدير ← ليدر الكرخ ومندوبوه ← ليدر الرصافة ومندوبوه ← بلا ليدر
assert.deepEqual(ids.slice(0, 6), [1, 3, 4, 2, 5, 6]);
assert.equal(at(4).depth, 1);
assert.equal(at(3).roleLabel, 'تيم ليدر · الكرخ');
// المحافظات معزولة عن الشركات
assert.equal(at(10).section, SECTION.provinces);
assert.equal(at(11).section, SECTION.provinces);
assert.equal(at(11).depth, 1);
// المسوقون: بغداد منفصل عن المحافظات
assert.equal(at(22).section, SECTION.marketersBg);
assert.equal(at(22).depth, 1);
assert.equal(at(31).section, SECTION.marketersPv);
assert.equal(at(30).section, SECTION.marketersPv);
// الإدارة المكتبية في الأخير، مدير المكتب أولاً
assert.deepEqual(ids.slice(-2), [41, 40]);
// كل حساب مرة واحدة
assert.equal(new Set(ids).size, users.length);
console.log('✅ كل حالات ترتيب الهيكلية نجحت');
