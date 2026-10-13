// اختبار قواعد فرق المحافظات (نقيّة) — npm run test:province-teams
import assert from 'node:assert/strict';
import {
  resolveAssignmentItemIds, findItemConflicts, buildItemAttribution,
  classifyChannel, personalSaleValue, toUSD,
} from '../server/modules/province-teams/province-teams.rules.js';
import { hasPersonalSaleTrigger, stripPersonalSaleTrigger } from '../server/modules/province-teams/personal-sale-trigger.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };

const DEVA = 1, OSEL = 2;
const companyItems = new Map([[DEVA, [10, 11, 12]], [OSEL, [20, 21]]]);

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

console.log(`\n${passed} اختباراً نجح`);
