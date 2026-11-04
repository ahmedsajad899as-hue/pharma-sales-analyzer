// مبيعات المندوب = المؤكد في «مبيعات المندوبين» + ميركاتو باسمه بلا تكرار — npm run test:rep-liquidation
import assert from 'node:assert/strict';
import { dropLinesFoundInMercato, isPureMercatoRow, widenDateRange, isInDateRange, repSaleToRows } from '../server/lib/repLiquidation.js';
import { countDistinctOrders } from '../server/lib/orderKey.js';

let nextLine = 1;
const line = (itemId, itemName, quantity, extra = {}) => ({ id: nextLine++, itemId, itemName, quantity, bonusQty: 0, unitPrice: 1000, ...extra });
const sale = (date, lines, extra = {}) => ({
  id: 1, createdById: 7, saleDate: new Date(`${date}T12:00:00Z`), pharmacyName: 'صيدلية الشفاء', areaName: 'حي الحسين',
  warehouseName: null, invoiceNumber: null, lines, ...extra,
});
const mercato = (date, itemId, itemName, quantity, raw = {}, extra = {}) => ({
  quantity, itemId, saleDate: new Date(`${date}T00:00:00Z`), recordType: 'sale',
  item: { id: itemId, name: itemName }, customer: { name: 'صيدلية الشفاء' }, area: { id: 1, name: 'حي الحسين' },
  rawData: JSON.stringify(raw), uploadedFile: { sourceSystem: 'mercato', mergeGroup: null }, ...extra,
});
const kept = (sales, rows) => dropLinesFoundInMercato(sales, rows).sales.flatMap(s => s.lines.map(l => l.itemName));

// ── التكرار ──
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10)]), [], 'نفس الطلبية في ميركاتو تُحسب منه وحده');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], []), ['Amoklavin 1G'], 'بلا ميركاتو يبقى مبيع المندوب');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10), line(6, 'Vitamin C', 4)])], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10)]), ['Vitamin C'], 'يسقط السطر المكرر وحده');
assert.deepEqual(kept([sale('2026-10-10', [line(null, 'Amoklavin 1G', 10)])], [mercato('2026-10-10', 99, 'Amoklavin 1G', 10)]), [], 'معرّف مختلف لكل رافع، والاسم يكفي');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10, { bonusQty: 2 })])], [mercato('2026-10-10', 5, 'Amoklavin 1G', 12)]), [], 'ميركاتو يعدّ البونص ضمن الكمية');

// ── ليست طلبية واحدة ──
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)], { pharmacyName: 'صيدلية النور' })], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10)]).length, 1, 'صيدلية أخرى');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)], { areaName: 'الكرادة' })], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10)]).length, 1, 'صيدلية بالاسم نفسه في منطقة أخرى');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)], { warehouseName: 'العهد الجديد' })], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10, { 'اسم المذخر': 'المنارة - بغداد' })]).length, 1, 'مذخر مختلف');
assert.equal(kept([sale('2026-10-01', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-20', 5, 'Amoklavin 1G', 10)]).length, 1, 'تاريخ بعيد');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-10', 6, 'Vitamin C', 10)]).length, 1, 'ايتم آخر');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('1970-01-01', 5, 'Amoklavin 1G', 10)]).length, 1, 'ميركاتو بلا تاريخ ولا رقم');

// ── نوافذ الكمية والتاريخ ──
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-16', 5, 'Amoklavin 1G', 10)]), [], 'نفس الكمية خلال أسبوع');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-11', 5, 'Amoklavin 1G', 6)]), [], 'تجهيز جزئي في اليوم نفسه تقريباً');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-14', 5, 'Amoklavin 1G', 6)]).length, 1, 'كمية مختلفة بعد أيام = طلبية أخرى');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)], { invoiceNumber: '777', pharmacyName: 'اسم مختلف تماما' })], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10, { 'رقم طلبية المذخر': '777' })]), [], 'نفس الرقم يغني عن اسم الصيدلية');

// ── كل صف ميركاتو يقابل سطراً واحداً ──
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)]), sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)], { id: 2 })], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10)]).length, 1, 'طلبيتان وصف ميركاتو واحد: تبقى واحدة');
assert.deepEqual(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 6), line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10), mercato('2026-10-10', 5, 'Amoklavin 1G', 6)]), [], 'مطابقة الكمية تسبق المطابقة الجزئية');
assert.equal(kept([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [mercato('2026-10-10', 5, 'Amoklavin 1G', 10, {}, { recordType: 'return' })]).length, 1, 'الإرجاع لا يطابق مبيعاً');
const r = mercato('2026-10-10', 5, 'Amoklavin 1G', 10);
const used = new Set();
assert.equal(dropLinesFoundInMercato([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [r], used).droppedLines.length, 1);
assert.equal(dropLinesFoundInMercato([sale('2026-10-10', [line(5, 'Amoklavin 1G', 10)])], [r], used).droppedLines.length, 0, 'حسابان بالاسم نفسه يتشاركان الصفوف المستعملة');

// ── ما يدخل من ميركاتو ──
assert.equal(isPureMercatoRow(mercato('2026-10-10', 5, 'X', 1)), true);
assert.equal(isPureMercatoRow({ ...r, uploadedFile: { sourceSystem: null } }), false, 'ملف مكتب');
assert.equal(isPureMercatoRow({ ...r, uploadedFile: { sourceSystem: 'mercato', mergeGroup: '7|mercato|IQD|condition' } }), false, 'ملف الكوديشن');
assert.equal(isPureMercatoRow({ ...r, rawData: JSON.stringify({ source: 'telegram-order' }) }), false, 'طلبية بوت في ملف ميركاتو');
assert.equal(isPureMercatoRow({ ...r, transit: {} }), false, 'ترانزيت');

// ── المدى ──
const oct = { startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T23:59:59.999Z') };
assert.equal(widenDateRange(oct).startDate.toISOString(), '2026-09-24T00:00:00.000Z');
assert.deepEqual(widenDateRange({}), {}, '«الكل» بلا مدى');
assert.equal(isInDateRange(new Date('2026-10-31T12:00:00Z'), { startDate: '2026-10-01', endDate: '2026-10-31' }), true, 'آخر يوم كاملاً');
assert.equal(isInDateRange(new Date('2026-11-01T00:00:00Z'), oct), false);
assert.equal(isInDateRange(new Date('2026-11-01T00:00:00Z'), {}), true);

// ── صفوف التقرير ──
const rows = repSaleToRows(sale('2026-10-10', [line(5, 'A', 2, { unitPrice: 1500 }), line(null, 'B', 3, { unitPrice: null })]), {
  repName: 'سجاد', iqdRate: 1500, areaOf: (name) => ({ id: 1, name }), itemOf: (l) => ({ id: l.itemId ?? `free:${l.itemName}`, name: l.itemName }),
});
assert.equal(rows[0].totalValue, 3000, 'الكمية × السعر');
assert.equal(rows[1].totalValue, 0, 'صنف حر بلا سعر');
assert.equal(countDistinctOrders(rows), 1, 'أسطر المبيع الواحد طلبية واحدة');
assert.equal(rows[0].uploadedFile.mergeGroup.endsWith('|condition'), true, 'تُعدّ ضمن اللكوديشن');

console.log('✓ rep-liquidation');
process.exit(0);
