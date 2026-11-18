// node scripts/test-yazen-match.mjs — مطابقة صفوف اليزن (ميركاتو) بصفوف ملف المكتب.
import assert from 'node:assert/strict';
import { prepareYazenRow, prepareOfficeRow, matchYazenToOffice } from '../server/lib/yazenOfficeMatch.js';

// ميركاتو: وقت الساعة كما هو (UTC). المكتب: منتصف ليل بغداد = 21:00 UTC من اليوم السابق.
const mercatoAt = (d) => new Date(`${d}T08:12:00Z`);
const officeAt = (d) => new Date(new Date(`${d}T00:00:00Z`).getTime() - 3 * 3600000);

let nextId = 1;
const y = (o = {}) => prepareYazenRow({
  id: nextId++, itemId: 1, quantity: 10, recordType: 'sale', saleDate: mercatoAt(o.date ?? '2026-11-10'),
  item: { name: o.item ?? 'AMOKLAVIN BID 1000MG 10TAB' }, customer: { name: o.pharmacy ?? 'صيدلية النور' }, area: { name: o.area ?? 'المنصور' },
  rawData: JSON.stringify({ 'اسم المذخر': 'ALYAZEN', ...(o.bonus ? { 'كمية البونص': o.bonus } : {}) }),
  ...o.row,
}, 7, o.ctx);
const o = (p = {}) => prepareOfficeRow({
  id: nextId++, itemId: 1, quantity: 10, recordType: 'sale', saleDate: officeAt(p.date ?? '2026-11-11'),
  item: { name: p.item ?? 'AMOKLAVIN BID 1000MG 10TAB' }, customer: { name: p.pharmacy ?? 'صيدلية النور' }, area: { name: p.area ?? 'المنصور' },
  ...p.row,
}, p.ctx);

const run = (name, fn) => { fn(); console.log('✓', name); };

run('اليزن يوم 10 والمكتب يوم 11 → مطابقة بفرق +1', () => {
  const a = y(), b = o();
  const m = matchYazenToOffice([a], [b]);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], { officeSaleId: b.id, mercatoSaleId: a.id, marketerRepId: 7, gapDays: 1 });
});

run('فرق 5 أيام → لا مطابقة', () => {
  assert.equal(matchYazenToOffice([y()], [o({ date: '2026-11-15' })]).length, 0);
});

run('صيدلية مختلفة → لا مطابقة', () => {
  assert.equal(matchYazenToOffice([y()], [o({ pharmacy: 'صيدلية الشفاء' })]).length, 0);
});

run('ايتم مختلف → لا مطابقة', () => {
  assert.equal(matchYazenToOffice([y()], [o({ item: 'AIRTIDE 250 50MCG 60CAP', row: { itemId: 2 } })]).length, 0);
});

run('منطقة مختلفة (المكتب يكتب منطقة واسعة) → مطابقة، والمنطقة نفسها أولى', () => {
  // إنتاج 2026-11-19: «ركن ابن البلدي» الطالبية (يزن) = مدينة الصدر (المكتب).
  assert.equal(matchYazenToOffice([y({ area: 'الطالبية' })], [o({ area: 'مدينة الصدر' })]).length, 1);
  const a = y({ area: 'الحبيبية' });
  const far = o({ area: 'مدينة الصدر' });
  const same = o({ area: 'الحبيبية' });
  assert.equal(matchYazenToOffice([a], [far, same])[0].officeSaleId, same.id);
});

run('«عبد الله» = «عبدالله» في اسم الصيدلية', () => {
  assert.equal(matchYazenToOffice([y({ pharmacy: 'صيدلية عبد الله عمران عباس' })], [o({ pharmacy: 'صيدلية عبدالله عمران عباس' })]).length, 1);
});

run('اسم الايتم بصيغتي النظامين', () => {
  const same = (a, b) => matchYazenToOffice([y({ item: a, row: { itemId: 10 } })], [o({ item: b, row: { itemId: 11 } })]).length === 1;
  assert.ok(same('VOLTAYAT 12.5MG 5SUPP', 'VOLTAYYAT12.5 SUPP'));
  assert.ok(same('DAYTRIX IM 1G 3.5ML 1VIAL', 'DAYTRIX ( CEFTRIAXONE ) 1G IM'));
  assert.ok(!same('DAYTRIX IM 1G 3.5ML 1VIAL', 'DAYTRIX ( CEFTRIAXONE ) 1G IV'), 'IM ≠ IV');
  assert.ok(!same('DEVIT 3 300.000IU 1AMP', 'DEVIT 3 50.000IU 8CAP'), 'تركيز مختلف');
  assert.ok(!same('VOLTAYAT 12.5MG 5SUPP', 'VOLTAYAT 50MG 5SUPP'), 'تركيز مختلف');
});

run('الكمية مع البونص → مطابقة', () => {
  const m = matchYazenToOffice([y({ bonus: 2 })], [o({ row: { quantity: 12 } })]);
  assert.equal(m.length, 1);
});

run('مرشحان: +1 يغلب نفس اليوم، والثاني يبقى حراً', () => {
  const a = y();
  const same = o({ date: '2026-11-10' });
  const next = o({ date: '2026-11-11' });
  const m = matchYazenToOffice([a], [same, next]);
  assert.equal(m.length, 1);
  assert.equal(m[0].officeSaleId, next.id);
});

run('صف المكتب لا يُستعمل مرتين', () => {
  const m = matchYazenToOffice([y(), y()], [o()]);
  assert.equal(m.length, 1);
});

run('إرجاع لا يطابق مبيعاً، وإرجاع يطابق إرجاعاً', () => {
  assert.equal(matchYazenToOffice([y({ row: { recordType: 'return' } })], [o()]).length, 0);
  assert.equal(matchYazenToOffice([y({ row: { recordType: 'return' } })], [o({ row: { recordType: 'return' } })]).length, 1);
});

run('كمية مختلفة (تأخر التجهيز) حتى 3 أيام → مطابقة، وبعد 4 → لا', () => {
  assert.equal(matchYazenToOffice([y()], [o({ row: { quantity: 6 } })]).length, 1);
  assert.equal(matchYazenToOffice([y()], [o({ date: '2026-11-13', row: { quantity: 6 } })]).length, 1);
  assert.equal(matchYazenToOffice([y()], [o({ date: '2026-11-14', row: { quantity: 6 } })]).length, 0);
});

run('كمية مختلفة وطلبية يزن مشابهة أخرى في الأيام الثلاثة → لا مطابقة', () => {
  // يزن 50 يوم 10 ويزن 30 يوم 11 (الصيدلية والايتم نفسهما)، والمكتب 15 يوم 12: لا يُعرف أصله.
  const a = y({ row: { quantity: 50 } });
  const b = y({ date: '2026-11-11', row: { quantity: 30 } });
  assert.equal(matchYazenToOffice([a, b], [o({ date: '2026-11-12', row: { quantity: 15 } })]).length, 0);
  // يزن لصيدلية أخرى لا يمنع.
  const c = y({ date: '2026-11-11', pharmacy: 'صيدلية الشفاء', row: { quantity: 30 } });
  assert.equal(matchYazenToOffice([a, c], [o({ date: '2026-11-12', row: { quantity: 15 } })]).length, 1);
});

run('المنطقة المدموجة (AreaAlias) = المنطقة القانونية', () => {
  const ctx = { itemRules: new Map(), areaAliases: new Map([['حبيبيه', ['مدينهصدر']]]) };
  const a = y({ area: 'الحبيبية', ctx });
  const other = o({ area: 'الكرادة', ctx });
  const merged = o({ area: 'مدينة الصدر', ctx });
  assert.equal(matchYazenToOffice([a], [other, merged])[0].officeSaleId, merged.id);
});

run('الايتم المدموج (ItemMergeRule) = الايتم القانوني', () => {
  const ctx = { itemRules: new Map([['amk 1g', [{ toItemId: 99, toKey: null }]]]), areaAliases: new Map() };
  const a = y({ item: 'AMK 1G', row: { itemId: 5 }, ctx });
  assert.equal(matchYazenToOffice([a], [o({ item: 'شي اخر', row: { itemId: 99 }, ctx })]).length, 1);
  assert.equal(matchYazenToOffice([a], [o({ item: 'شي اخر', row: { itemId: 98 }, ctx })]).length, 0);
});

run('اسم ايتم المكتب من عمود «اسم المادة بالمكتب» بمعرّف مختلف', () => {
  const a = y({ item: 'AMOK BID 1G', row: { itemId: 50, rawData: JSON.stringify({ 'اسم المذخر': 'ALYAZEN', 'اسم المادة بالمكتب': 'AMOKLAVIN BID 1000MG 10TAB' }) } });
  assert.equal(matchYazenToOffice([a], [o()]).length, 1);
});

console.log('all yazen-match tests passed');
process.exit(0);
