// ════════════════════════════════════════════════════════════════════════════
// test-sale-fingerprint.mjs — اختبار بصمة الصف التي يقوم عليها «الملف التراكمي».
//
// npm run test:fingerprint
//
// كل حالة هنا كلّفت المشروع شيئاً من قبل أو تُكلّفه لو انكسرت:
//  1. إعادة رفع الملف نفسه لا تُضاعف المبيع.
//  2. صفّان متطابقان تماماً داخل الملف الواحد يبقيان كلاهما (التكرار المشروع —
//     الدرس المدفوع ثمنه في crossFileDedup.js).
//  3. ملف متداخل (شهر 9 + 10) يُسقط شهر 9 ويُبقي شهر 10.
//  4. الإرجاع لا يُحذف كمكرر للمبيع رغم تطابق باقي الحقول.
//  5. اختلاف نص اسم الايتم بين رفعتين لا يكسر البصمة (المفتاح itemId لا الاسم).
// ════════════════════════════════════════════════════════════════════════════

import { fingerprintRows, contentKey, mergeGroupKey } from '../server/lib/saleFingerprint.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failures++;
};

const row = (over = {}) => ({
  rawData: JSON.stringify({
    'رقم الطلبية': over.order ?? 'A-100',
    'التاريخ':     over.date  ?? '2026-09-05',
    'الصيدلية':    over.pharmacy ?? 'صيدلية النور',
    'الشركة':      over.company ?? 'deva',
  }),
  itemId:     over.itemId ?? 7,
  customerId: over.customerId ?? 11,
  recordType: over.recordType ?? 'sale',
  quantity:   over.quantity ?? 10,
  totalValue: over.totalValue ?? 150000,
});

// ── 1. إعادة رفع الملف نفسه ──────────────────────────────────────────────────
const file = [row(), row({ order: 'A-101', itemId: 8 }), row({ order: 'A-102', date: '2026-09-07' })];
const first  = fingerprintRows(file);
const second = fingerprintRows(file);
check('إعادة رفع الملف نفسه تُنتج البصمات ذاتها', JSON.stringify(first) === JSON.stringify(second));

// ── 2. تكرار مشروع داخل الملف الواحد ────────────────────────────────────────
const dupes = [row(), row(), row()];
const dupKeys = fingerprintRows(dupes);
check('ثلاثة صفوف متطابقة داخل الملف تبقى متمايزة', new Set(dupKeys).size === 3);
check('وإعادة رفعها تُطابقها واحداً لواحد',
  JSON.stringify(fingerprintRows(dupes)) === JSON.stringify(dupKeys));

// ── 3. ملف متداخل: شهر 9 موجود، شهر 10 جديد ─────────────────────────────────
const sept    = [row({ order: 'S1' }), row({ order: 'S2', itemId: 9 })];
const octo    = [row({ order: 'O1', date: '2026-10-03' }), row({ order: 'O2', date: '2026-10-09', itemId: 9 })];
const existing = new Set(fingerprintRows(sept));
const reupload = fingerprintRows([...sept, ...octo]); // ملف يحمل الشهرين معاً
const dropped  = reupload.filter(k => existing.has(k));
const kept     = reupload.filter(k => !existing.has(k));
check('صفوف شهر 9 المتداخلة تُسقط كلها', dropped.length === sept.length);
check('صفوف شهر 10 وحدها تُضاف', kept.length === octo.length);

// ── 4. الإرجاع ليس مكرراً للمبيع ────────────────────────────────────────────
const sale   = fingerprintRows([row()])[0];
const ret    = fingerprintRows([row({ recordType: 'return' })])[0];
check('صف الإرجاع له بصمة مختلفة عن المبيع المطابق', sale !== ret);

// ── 5. تغيّر اسم الايتم نصّياً لا يكسر البصمة ────────────────────────────────
// (البصمة تقرأ itemId لا الاسم — توحيد الكتالوج يُبدّل نص الاسم بين رفعتين.)
const a = contentKey({ ...row(), rawData: JSON.stringify({ 'رقم الطلبية': 'A-100', 'التاريخ': '2026-09-05', 'الصيدلية': 'صيدلية النور', 'الشركة': 'deva', 'اسم المادة': 'بانادول' }) });
const b = contentKey({ ...row(), rawData: JSON.stringify({ 'رقم الطلبية': 'A-100', 'التاريخ': '2026-09-05', 'الصيدلية': 'صيدلية النور', 'الشركة': 'deva', 'اسم المادة': 'Panadol 500' }) });
check('اختلاف نص اسم المادة لا يغيّر البصمة', a === b);

// تغيّر حقل حقيقي (الكمية) يجب أن يغيّرها
check('اختلاف الكمية يغيّر البصمة', contentKey(row()) !== contentKey(row({ quantity: 20 })));
check('اختلاف الصيدلية يغيّر البصمة', contentKey(row()) !== contentKey(row({ pharmacy: 'صيدلية الشفاء' })));
check('اختلاف الشركة يغيّر البصمة', contentKey(row()) !== contentKey(row({ company: 'humanis' })));

// ── 6. مجموعات الدمج تفصل المصدر والعملة ────────────────────────────────────
const office = mergeGroupKey({ userId: 3, sourceSystem: null, detectedCurrency: 'IQD' });
const merc   = mergeGroupKey({ userId: 3, sourceSystem: 'mercato', detectedCurrency: 'IQD' });
const usd    = mergeGroupKey({ userId: 3, sourceSystem: null, detectedCurrency: 'USD' });
check('ميركاتو لا يشارك مجموعة المكتب', office !== merc);
check('الدولار لا يشارك مجموعة الدينار', office !== usd);

// ── 7. صفّ بلا rawData لا يتعطّل ─────────────────────────────────────────────
const bare = fingerprintRows([
  { rawData: null, itemId: 3, customerId: null, recordType: 'sale', quantity: 1, totalValue: 5 },
  { rawData: null, itemId: 3, customerId: null, recordType: 'sale', quantity: 1, totalValue: 5 },
]);
check('صفّان بلا rawData يبقيان متمايزين', bare[0] !== bare[1]);

console.log(failures === 0 ? '\n✅ كل الاختبارات نجحت' : `\n❌ ${failures} اختبار فشل`);
process.exit(failures === 0 ? 0 : 1);
