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
}, 7);
const o = (p = {}) => prepareOfficeRow({
  id: nextId++, itemId: 1, quantity: 10, recordType: 'sale', saleDate: officeAt(p.date ?? '2026-11-11'),
  item: { name: p.item ?? 'AMOKLAVIN BID 1000MG 10TAB' }, customer: { name: p.pharmacy ?? 'صيدلية النور' }, area: { name: p.area ?? 'المنصور' },
  ...p.row,
});

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

run('منطقة مختلفة صراحةً → لا مطابقة', () => {
  assert.equal(matchYazenToOffice([y()], [o({ area: 'الكرادة' })]).length, 0);
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

run('كمية مختلفة (تجهيز جزئي) في اليوم التالي → مطابقة، وبعد 3 أيام → لا', () => {
  assert.equal(matchYazenToOffice([y()], [o({ row: { quantity: 6 } })]).length, 1);
  assert.equal(matchYazenToOffice([y()], [o({ date: '2026-11-13', row: { quantity: 6 } })]).length, 0);
});

run('اسم ايتم المكتب من عمود «اسم المادة بالمكتب» بمعرّف مختلف', () => {
  const a = y({ item: 'AMOK BID 1G', row: { itemId: 50, rawData: JSON.stringify({ 'اسم المذخر': 'ALYAZEN', 'اسم المادة بالمكتب': 'AMOKLAVIN BID 1000MG 10TAB' }) } });
  assert.equal(matchYazenToOffice([a], [o()]).length, 1);
});

console.log('all yazen-match tests passed');
process.exit(0);
