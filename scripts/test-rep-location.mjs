// قرار موقع المندوب (المحافظة + الكرخ/الرصافة) — npm run test:rep-location
import assert from 'node:assert/strict';
import { repKindOf, repLocationFrom } from '../server/lib/repLocation.js';

const inKarkh = { province: 'بغداد', side: 'الكرخ' };
const inRusafa = { province: 'بغداد', side: 'الرصافة' };
const inAnbar = { province: 'الانبار', side: null };
const loc = (r) => repLocationFrom(r);

assert.deepEqual(loc({ areas: [inKarkh, inKarkh, inRusafa] }), { province: 'بغداد', side: 'الكرخ', group: 'karkh' }, 'أكثرية المناطق تحدد القسم');
assert.deepEqual(loc({ areas: [inRusafa] }), { province: 'بغداد', side: 'الرصافة', group: 'rusafa' });
assert.deepEqual(loc({ assignedSides: [{ name: 'الرصافة', province: 'بغداد', areaCount: 40 }] }), { province: 'بغداد', side: 'الرصافة', group: 'rusafa' }, 'قسم مسنَد كاملاً');
assert.equal(loc({ assignedSides: [{ name: 'الكرخ', province: 'بغداد', areaCount: 40 }], areas: [inAnbar, inAnbar] }).group, 'karkh', 'القسم المسنَد يساوي كل مناطقه');

assert.equal(loc({ areas: [inKarkh, inKarkh, inAnbar] }).group, 'karkh', 'منطقة واحدة في محافظة لا تنقله إليها');
assert.equal(loc({ areas: [inKarkh, inAnbar] }).group, 'karkh', 'التعادل مع بغداد لبغداد');
assert.deepEqual(loc({ areas: [inAnbar, inAnbar, inKarkh] }), { province: 'الانبار', side: null, group: 'provinces' });

assert.deepEqual(loc({ teamProvinces: ['البصرة'], areas: [inKarkh, inKarkh] }), { province: 'البصرة', side: null, group: 'provinces' }, 'فريق المحافظة يغلب المناطق');
assert.equal(loc({ teamProvinces: ['البصرة', 'ميسان'] }).province, 'البصرة، ميسان');
assert.deepEqual(loc({ assignedProvinces: ['ديالى'] }), { province: 'ديالى', side: null, group: 'provinces' });

assert.deepEqual(loc({ name: 'زاهر احسان / ليدر الرصافة ph' }), { province: 'بغداد', side: 'الرصافة', group: 'rusafa' }, 'القسم من الاسم كملاذ أخير');
assert.deepEqual(loc({ name: 'عمر ايمن / ليدر الكرخ ph' }), { province: 'بغداد', side: 'الكرخ', group: 'karkh' });
assert.deepEqual(loc({ name: 'علي - مسوقين - الديوانية', provinceInText: () => 'القادسية' }), { province: 'القادسية', side: null, group: 'provinces' });
assert.deepEqual(loc({ name: 'عمر / ليدر الكرخ', areas: [inRusafa] }).side, 'الرصافة', 'المناطق تغلب الاسم');

assert.deepEqual(loc({ name: 'احمد' }), { province: null, side: null, group: 'other' }, 'بلا بيانات: غير مصنف لا تخمين');
assert.deepEqual(loc({ assignedProvinces: ['بغداد'], name: 'احمد' }), { province: 'بغداد', side: null, group: 'other' }, 'بغداد بلا قسم تبقى ظاهرة ولا تُنسب لقسم');

assert.equal(repKindOf({ role: 'company_manager', name: 'ahmed sajjad' }), 'manager');
assert.equal(repKindOf({ role: 'office_manager', name: 'x' }), 'manager');
assert.equal(repKindOf({ role: 'team_leader', name: 'زاهر' }), 'leader');
assert.equal(repKindOf({ role: 'commercial_team_leader', name: 'x' }), 'leader');
assert.equal(repKindOf({ role: 'scientific_rep', name: 'عمر ايمن / ليدر الكرخ ph' }), 'leader', 'ليدر بدور مندوب يُعرف من اسمه');
assert.equal(repKindOf({ role: 'scientific_rep', name: 'علي', leadsProvinceTeam: true }), 'leader');
assert.equal(repKindOf({ role: 'scientific_rep', name: 'علي' }), 'rep');

console.log('✓ موقع المندوب');
