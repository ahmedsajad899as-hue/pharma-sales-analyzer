// اختبار قواعد فرق المحافظات (نقيّة) — npm run test:province-teams
import assert from 'node:assert/strict';
import {
  resolveAssignmentItemIds, findItemConflicts, buildItemAttribution,
  classifyChannel, personalSaleValue, toUSD,
  assignmentFillsSeat, planSeatAssignments,
} from '../server/modules/province-teams/province-teams.rules.js';
import { hasPersonalSaleTrigger, stripPersonalSaleTrigger } from '../server/modules/province-teams/personal-sale-trigger.js';
import { marketerHomeProvinces, pickMarketerLeaders } from '../server/lib/pharmacyRep.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

const DEVA = 1, OSEL = 2;
const companyItems = new Map([[DEVA, [10, 11, 12]], [OSEL, [20, 21]]]);

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
const humanisSeat = { companyId: HUMANIS, items: [{ id: 30, companyId: HUMANIS }, { id: 10, companyId: DEVA }] };
const devaSeat = { companyId: DEVA, items: [] };

t('المقعد يمتلئ بتقاطع الايتمات، و«كل الايتمات» يخص شركته الرئيسية فقط', () => {
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [10] }, humanisSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [11] }, humanisSeat), false);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: true, itemIds: [] }, humanisSeat), false);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: true, itemIds: [] }, devaSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: DEVA, allItems: false, itemIds: [11] }, devaSeat), true);
  assert.equal(assignmentFillsSeat({ companyId: OSEL, allItems: false, itemIds: [20] }, devaSeat), false);
});

t('مندوب المقعد: ايتمات المدير مقسَّمة على شركاتها، ومدير بلا ايتمات = كل الشركة', () => {
  const plan = planSeatAssignments(humanisSeat, []);
  assert.deepEqual(plan.assignments.map(a => [a.companyId, a.allItems, a.itemIds]), [[HUMANIS, false, [30]], [DEVA, false, [10]]]);
  assert.deepEqual(plan.keptItemIds, [30, 10]);
  const whole = planSeatAssignments(devaSeat, []);
  assert.deepEqual(whole.assignments.map(a => [a.companyId, a.allItems]), [[DEVA, true]]);
  assert.deepEqual(whole.keptItemIds, []);
});

t('مندوب المقعد: المتقاطع مع مندوب آخر يُترك له ويُبلَّغ عنه', () => {
  const byItems = planSeatAssignments(humanisSeat, [{ id: 1, repUserId: 9, repName: 'علي', companyId: DEVA, allItems: false, itemIds: [10, 11] }]);
  assert.deepEqual(byItems.assignments.map(a => a.companyId), [HUMANIS]);
  assert.deepEqual(byItems.keptItemIds, [30]);
  assert.deepEqual(byItems.dropped, [{ companyId: DEVA, repName: 'علي' }]);
  const byAll = planSeatAssignments(humanisSeat, [{ id: 1, repUserId: 9, repName: 'علي', companyId: DEVA, allItems: true, itemIds: [] }]);
  assert.deepEqual(byAll.assignments.map(a => a.companyId), [HUMANIS]);
  assert.equal(planSeatAssignments({ companyId: DEVA, items: [{ id: 10, companyId: DEVA }] }, [{ id: 1, repUserId: 9, repName: 'علي', companyId: DEVA, allItems: true, itemIds: [] }]).assignments.length, 0);
});

t('ايتم المدير بلا شركة في المكتب يبقى في قائمة المندوب بلا تعيين فريق', () => {
  const plan = planSeatAssignments({ companyId: HUMANIS, items: [{ id: 30, companyId: HUMANIS }, { id: 99, companyId: null }] }, []);
  assert.deepEqual(plan.assignments.map(a => a.companyId), [HUMANIS]);
  assert.deepEqual(plan.keptItemIds, [30, 99]);
});

console.log(`\n${passed} اختباراً نجح`);
