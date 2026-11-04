// اختبار قواعد فرق المحافظات (نقيّة) — npm run test:province-teams
import assert from 'node:assert/strict';
import {
  resolveAssignmentItemIds, findItemConflicts, buildItemAttribution,
  classifyChannel, personalSaleValue, toUSD,
  assignmentFillsSeat, planSeatAssignments, repBelongsToSeat, repSeatIds, removedProvinceIds, marketerTeamLinksToDrop,
} from '../server/modules/province-teams/province-teams.rules.js';
import { hasPersonalSaleTrigger, stripPersonalSaleTrigger } from '../server/modules/province-teams/personal-sale-trigger.js';
import { marketerHomeProvinces, pickMarketerLeaders, managesProvinceMarketers, marketersManagerCoverage } from '../server/lib/pharmacyRep.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

const DEVA = 1, OSEL = 2;
const companyItems = new Map([[DEVA, [10, 11, 12]], [OSEL, [20, 21]]]);

t('مدير مسوقي المحافظات: محافظات بلا بغداد', () => {
  assert.equal(managesProvinceMarketers(['الأنبار', 'واسط']), true);
  assert.equal(managesProvinceMarketers(['بغداد']), false);
  assert.equal(managesProvinceMarketers(['بغداد', 'الأنبار']), false);
  assert.equal(managesProvinceMarketers([]), false);
});

t('نطاق مدير المسوقين: ما أُسند له فقط', () => {
  // بغداد عبر الكرخ والرصافة: لا محافظات
  assert.deepEqual(marketersManagerCoverage({ assignedSideProvinces: ['بغداد', 'بغداد'] }), { baghdad: true, provinces: [] });
  // محافظات بلا بغداد
  assert.deepEqual(marketersManagerCoverage({ assignedProvinces: ['الأنبار', 'واسط'] }), { baghdad: false, provinces: ['الأنبار', 'واسط'] });
  // الإسناد الصريح لمحافظة مع بغداد يبقى
  assert.deepEqual(marketersManagerCoverage({ assignedProvinces: ['الأنبار'], assignedSideProvinces: ['بغداد'] }), { baghdad: true, provinces: ['الأنبار'] });
  // الإسناد الصريح يغلب المناطق الشاردة
  assert.deepEqual(marketersManagerCoverage({ assignedSideProvinces: ['بغداد'], areaCounts: new Map([['الأنبار', 5]]) }), { baghdad: true, provinces: [] });
  // بلا إسناد صريح: أكثرية المناطق، فمنطقة شاردة لا تفتح محافظتها
  assert.deepEqual(marketersManagerCoverage({ areaCounts: new Map([['بغداد', 30], ['الأنبار', 1]]) }), { baghdad: true, provinces: [] });
  assert.deepEqual(marketersManagerCoverage({ areaCounts: new Map([['الأنبار', 4]]) }), { baghdad: false, provinces: ['الأنبار'] });
  // بلا أي إسناد: لا شيء
  assert.deepEqual(marketersManagerCoverage(), { baghdad: false, provinces: [] });
});

t('فصل المسوق عن فريق العلميين: يُحذف الرابط المختلط فقط', () => {
  const row = (repUserId, repIsMarketer, leaderUserId, leaderIsMarketer) => ({ repUserId, repIsMarketer, leaderUserId, leaderIsMarketer });
  assert.deepEqual(marketerTeamLinksToDrop([row(1, true, 9, false)]), [{ userId: 1, managerId: 9 }]);
  assert.deepEqual(marketerTeamLinksToDrop([row(2, false, 8, true)]), [{ userId: 2, managerId: 8 }]);
  assert.deepEqual(marketerTeamLinksToDrop([row(3, true, 8, true)]), []);
  assert.deepEqual(marketerTeamLinksToDrop([row(4, false, 9, false)]), []);
  assert.deepEqual(marketerTeamLinksToDrop([row(5, true, null, false)]), []);
  assert.equal(marketerTeamLinksToDrop([row(1, true, 9, false), row(1, true, 9, false)]).length, 1);
});

t('تغيير محافظة الحساب: الخروج من القديمة فقط', () => {
  const DIYALA = 5, ANBAR = 7, BASRA = 9;
  assert.deepEqual(removedProvinceIds([DIYALA], [ANBAR]), [DIYALA]);
  assert.deepEqual(removedProvinceIds([DIYALA, ANBAR], [ANBAR]), [DIYALA]);
  assert.deepEqual(removedProvinceIds([ANBAR], [ANBAR, BASRA]), []);
  assert.deepEqual(removedProvinceIds([], [ANBAR]), []);
  assert.deepEqual(removedProvinceIds([DIYALA, DIYALA], []), [DIYALA]);
});

t('مسوق بغداد بمنطقة من محافظة يبقى على بغداد', () => {
  assert.deepEqual(marketerHomeProvinces([], new Map([['بغداد', 60], ['الأنبار', 1]])), ['بغداد']);
  assert.deepEqual(marketerHomeProvinces(['الأنبار'], new Map([['بغداد', 60]])), ['بغداد']);
  assert.deepEqual(marketerHomeProvinces([], new Map([['بغداد', 2], ['واسط', 2]])), ['بغداد']);
});

t('مسوق المحافظة: أكثرية مناطقه، والمُسنَدة كاملةً تحسم بين المحافظات', () => {
  assert.deepEqual(marketerHomeProvinces([], new Map([['الأنبار', 5], ['واسط', 1], ['بغداد', 1]])), ['الأنبار']);
  assert.deepEqual(marketerHomeProvinces(['الأنبار', 'واسط'], new Map()), ['الأنبار', 'واسط']);
  assert.deepEqual(marketerHomeProvinces(['الأنبار'], new Map([['واسط', 3]])), ['الأنبار']);
  assert.deepEqual(marketerHomeProvinces([], new Map()), []);
});

t('قائد مسوقي المحافظة: قائد الفارمسي فيها، لا قائد بغداد', () => {
  const m = (id, name, homes, managerIds = [], isLeader = false) => ({ id, name, homes, managerIds, isLeader });
  const leaders = pickMarketerLeaders([
    m(1, 'ليدر الكرخ', ['بغداد'], [], true),
    m(2, 'ليدر الجنوب', ['البصرة'], [], true),
    m(3, 'مسوق بغداد', ['بغداد'], [1]),
    m(4, 'مسوق البصرة', ['البصرة'], [2]),
    m(5, 'مسوق ميسان', ['ميسان'], [2]),
    m(6, 'مسوق الأنبار تابع لليدر الكرخ', ['الأنبار'], [1]),
  ]);
  assert.deepEqual(leaders.get('البصرة'), { id: 2, name: 'ليدر الجنوب' });
  assert.deepEqual(leaders.get('ميسان'), { id: 2, name: 'ليدر الجنوب' });
  assert.equal(leaders.has('الأنبار'), false);
  assert.equal(leaders.has('بغداد'), false);
});

t('كل ايتمات الشركة تُحسم من الكتالوج', () => {
  assert.deepEqual(resolveAssignmentItemIds({ allItems: true, companyId: DEVA, itemIds: [] }, companyItems), [10, 11, 12]);
  assert.deepEqual(resolveAssignmentItemIds({ allItems: false, companyId: DEVA, itemIds: [11, 11, '12'] }, companyItems), [11, 12]);
});

t('مندوب مشترك بين شركتين: لا تعارض', () => {
  const c = findItemConflicts(
    { id: null, repUserId: 5, companyId: OSEL, allItems: true, itemIds: [] },
    [{ id: 1, repUserId: 5, companyId: DEVA, allItems: true, itemIds: [] }],
  );
  assert.equal(c.length, 0);
});

t('مندوبان لنفس الشركة يتقاسمان الايتمات بلا تقاطع: مقبول', () => {
  const c = findItemConflicts(
    { id: null, repUserId: 6, companyId: DEVA, allItems: false, itemIds: [12] },
    [{ id: 1, repUserId: 5, companyId: DEVA, allItems: false, itemIds: [10, 11] }],
  );
  assert.equal(c.length, 0);
});

t('تقاطع ايتمات لنفس الشركة: مرفوض مع ذكر الايتم', () => {
  const c = findItemConflicts(
    { id: null, repUserId: 6, companyId: DEVA, allItems: false, itemIds: [11, 12] },
    [{ id: 1, repUserId: 5, repName: 'أحمد', companyId: DEVA, allItems: false, itemIds: [10, 11] }],
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'items');
  assert.deepEqual(c[0].itemIds, [11]);
  assert.equal(c[0].repName, 'أحمد');
});

t('«كل الايتمات» يتعارض مع أي مندوب آخر لنفس الشركة', () => {
  const c = findItemConflicts(
    { id: null, repUserId: 6, companyId: DEVA, allItems: true, itemIds: [] },
    [{ id: 1, repUserId: 5, companyId: DEVA, allItems: false, itemIds: [10] }],
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'all');
});

t('تعديل التعيين نفسه لا يتعارض مع نفسه', () => {
  const c = findItemConflicts(
    { id: 1, repUserId: 5, companyId: DEVA, allItems: true, itemIds: [] },
    [{ id: 1, repUserId: 5, companyId: DEVA, allItems: false, itemIds: [10] }],
  );
  assert.equal(c.length, 0);
});

t('النسب: كل ايتم لمندوب واحد، والتقاطع القديم يفوز فيه الأقدم ويُبلَّغ', () => {
  const { owner, overlaps } = buildItemAttribution([
    { id: 7, companyId: DEVA, allItems: false, itemIds: [11] },
    { id: 3, companyId: DEVA, allItems: false, itemIds: [10, 11] },
    { id: 4, companyId: OSEL, allItems: true, itemIds: [] },
  ], companyItems);
  assert.equal(owner.get(10), 3);
  assert.equal(owner.get(11), 3);
  assert.equal(owner.get(20), 4);
  assert.equal(owner.has(12), false); // ايتم غير معيَّن ⇒ «غير منسوب» لا يُسقط
  assert.deepEqual(overlaps, [{ itemId: 11, keptAssignmentId: 3, droppedAssignmentId: 7 }]);
});

t('تصنيف الوجهة: مذخر أم صيدلية', () => {
  assert.equal(classifyChannel(true, 'صيدلية النور'), 'warehouse');
  assert.equal(classifyChannel(false, 'مذخر الناقوس'), 'warehouse');
  assert.equal(classifyChannel(false, 'المذخر الرئيسي'), 'warehouse');
  assert.equal(classifyChannel(false, 'مذاخر العناية'), 'warehouse');
  assert.equal(classifyChannel(false, 'صيدلية قرب المذخر'), 'pharmacy');
  assert.equal(classifyChannel(false, ''), 'pharmacy');
});

t('قيمة الجهد الشخصي: سعر المذخر للمذخر، سعر المكتب للمكتب، والمكتوب يتقدّم', () => {
  const item = { price: 1000, warehousePrice: 1200 };
  assert.deepEqual(personalSaleValue({ channel: 'warehouse', quantity: 5 }, item), { unitPrice: 1200, totalValue: 6000 });
  assert.deepEqual(personalSaleValue({ channel: 'office', quantity: 5 }, item), { unitPrice: 1000, totalValue: 5000 });
  assert.deepEqual(personalSaleValue({ channel: 'office', quantity: 2, unitPrice: 750 }, item), { unitPrice: 750, totalValue: 1500 });
  assert.deepEqual(personalSaleValue({ channel: 'warehouse', quantity: 2 }, { price: 900, warehousePrice: null }), { unitPrice: 900, totalValue: 1800 });
  assert.deepEqual(personalSaleValue({ channel: 'warehouse', quantity: 2 }, null), { unitPrice: null, totalValue: 0 });
  assert.equal(toUSD(1470, 'IQD', 1470), 1);
  assert.equal(toUSD(5, 'USD', 1470), 5);
});

t('كلمة البوت: «مبيعي» تُلتقط و«مبيع شهر 9» لا', () => {
  assert.equal(hasPersonalSaleTrigger('مبيعي\nصيدلية النور\nبانادول 5'), true);
  assert.equal(hasPersonalSaleTrigger('جهدي صيدلية النور'), true);
  assert.equal(hasPersonalSaleTrigger('مبيعاتي'), true);
  assert.equal(hasPersonalSaleTrigger('محمد مبيع شهر 9'), false);
  assert.equal(hasPersonalSaleTrigger('طلبية صيدلية النور'), false);
  assert.equal(hasPersonalSaleTrigger(''), false);
});

t('إسقاط الكلمة يُبقي الأسطر', () => {
  assert.equal(stripPersonalSaleTrigger('مبيعي\nصيدلية النور - الكرخ\nبانادول 5 علبة'), 'صيدلية النور - الكرخ\nبانادول 5 علبة');
  assert.equal(stripPersonalSaleTrigger('مبيعي صيدلية النور\nبانادول 5'), 'صيدلية النور\nبانادول 5');
  assert.equal(stripPersonalSaleTrigger('صيدلية النور'), 'صيدلية النور');
});

// مقعد humanis: مديره مسند على ايتم من شركته وايتم من deva. مقعد deva: مديره بلا ايتمات.
const HUMANIS = 3;
const humanisSeat = { userId: 103, companyId: HUMANIS, items: [{ id: 30, companyId: HUMANIS }, { id: 10, companyId: DEVA }] };
const devaSeat = { userId: 101, companyId: DEVA, items: [] };

t('المقعد يمتلئ بتقاطع الايتمات، و«كل الايتمات» يخص شركته الرئيسية فقط', () => {
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [10] }, humanisSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [11] }, humanisSeat), false);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: true, itemIds: [] }, humanisSeat), false);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: true, itemIds: [] }, devaSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [11] }, devaSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: OSEL, allItems: false, itemIds: [20] }, devaSeat), false);
});

t('مندوب المقعد: ايتمات المدير مقسَّمة على شركاتها، ومدير بلا ايتمات = كل الشركة', () => {
  const plan = planSeatAssignments(humanisSeat);
  assert.deepEqual(plan.assignments.map(a => [a.companyId, a.allItems, a.itemIds]), [[HUMANIS, false, [30]], [DEVA, false, [10]]]);
  assert.deepEqual(plan.keptItemIds, [30, 10]);
  const whole = planSeatAssignments(devaSeat);
  assert.deepEqual(whole.assignments.map(a => [a.companyId, a.allItems]), [[DEVA, true]]);
  assert.deepEqual(whole.keptItemIds, []);
});

// مقعدان يتشاركان الايتم 10: مندوب مدير humanis لا يشغل مقعد مدير deva لمجرد هذا الايتم.
const sharedDevaSeat = { userId: 102, companyId: DEVA, items: [{ id: 10, companyId: DEVA }, { id: 11, companyId: DEVA }] };
const seatsWithShare = [humanisSeat, sharedDevaSeat];
const humanisRepAssignments = [{ companyId: HUMANIS, allItems: false, itemIds: [30] }, { companyId: DEVA, allItems: false, itemIds: [10] }];

t('مقعد المندوب يحسمه مديره حين يتشارك مديران ايتماً', () => {
  assert.deepEqual(repSeatIds(humanisRepAssignments, [103, 500], seatsWithShare), [103]);
  // مدير خارج المقاعد (التيم ليدر) لا يحسم، ومندوب قديم بلا مدير مقعد يبقى بكل ما يطابقه.
  assert.deepEqual(repSeatIds(humanisRepAssignments, [500], seatsWithShare), [103, 102]);
  // مدير مقعد لا يطابق تعيينات المندوب لا يسحبه إليه.
  assert.deepEqual(repSeatIds(humanisRepAssignments, [999], [...seatsWithShare, { userId: 999, companyId: OSEL, items: [{ id: 20, companyId: OSEL }] }]), [103, 102]);
  // مشترك فعلاً: يتبع المديرين معاً فيبقى في مقعديهما.
  assert.deepEqual(repSeatIds(humanisRepAssignments, [103, 102], seatsWithShare), [103, 102]);
});

t('عرض مدير الشركة: مندوب مقعد آخر لا يدخل فريقه بسبب ايتم مشترك', () => {
  const rep = { assignments: humanisRepAssignments, isSubordinate: false, primaryCompanyId: HUMANIS, managerIds: [103] };
  assert.equal(repBelongsToSeat(rep, sharedDevaSeat, seatsWithShare), false);
  assert.equal(repBelongsToSeat({ ...rep, isSubordinate: true }, humanisSeat, seatsWithShare), true);
});

t('الايتم المشترك يُنسب لمندوب واحد: مندوب شركة الايتم قبل الأقدم', () => {
  const noCatalog = new Map();
  const older = { id: 1, companyId: DEVA, allItems: false, itemIds: [10] };
  const home = { id: 2, companyId: DEVA, allItems: false, itemIds: [10, 11], isRepPrimaryCompany: true };
  const { owner, overlaps } = buildItemAttribution([older, home], noCatalog);
  assert.equal(owner.get(10), 2);
  assert.deepEqual(overlaps, [{ itemId: 10, keptAssignmentId: 2, droppedAssignmentId: 1 }]);
  // بلا مندوب شركة بينهما: الأقدم كما كان.
  assert.equal(buildItemAttribution([older, { ...home, isRepPrimaryCompany: false }], noCatalog).owner.get(10), 1);
});

t('ايتم المدير بلا شركة في المكتب يبقى في قائمة المندوب بلا تعيين فريق', () => {
  const plan = planSeatAssignments({ companyId: HUMANIS, items: [{ id: 30, companyId: HUMANIS }, { id: 99, companyId: null }] });
  assert.deepEqual(plan.assignments.map(a => a.companyId), [HUMANIS]);
  assert.deepEqual(plan.keptItemIds, [30, 99]);
});

t('عرض مدير الشركة: مندوب الفريق بمقعده، ولا تكفي شركة ثانوية أو تبعية', () => {
  const rep = (over) => ({ assignments: [], isSubordinate: false, primaryCompanyId: null, ...over });
  const own = { companyId: HUMANIS, allItems: false, itemIds: [30] };
  const otherCompany = { companyId: DEVA, allItems: true, itemIds: [] };
  assert.equal(repBelongsToSeat(rep({ assignments: [own] }), humanisSeat), true);
  // مندوب deva بكل ايتماتها، ومدير humanis مسند على ايتم من deva
  assert.equal(repBelongsToSeat(rep({ assignments: [otherCompany] }), humanisSeat), false);
  assert.equal(repBelongsToSeat(rep({ assignments: [otherCompany], isSubordinate: true, primaryCompanyId: HUMANIS }), humanisSeat), false);
  // مشترك بين شركتين: يظهر لكلا مديريهما
  assert.equal(repBelongsToSeat(rep({ assignments: [otherCompany, own] }), humanisSeat), true);
  // خارج الفرق: تابع المدير أو شركته الرئيسية
  assert.equal(repBelongsToSeat(rep({ isSubordinate: true }), humanisSeat), true);
  assert.equal(repBelongsToSeat(rep({ primaryCompanyId: HUMANIS }), humanisSeat), true);
  assert.equal(repBelongsToSeat(rep({ primaryCompanyId: DEVA }), humanisSeat), false);
});

console.log(`\n${passed} اختباراً نجح`);
