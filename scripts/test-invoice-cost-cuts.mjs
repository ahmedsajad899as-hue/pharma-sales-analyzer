// ════════════════════════════════════════════════════════════════════════════
// اختبار خطة تقليل كلفة صور الفواتير (2026-11-13) — بلا ذكاء ولا قاعدة بيانات.
// تشغيل: npm run test:invoice-cost
//  • الفحص السريع (gateScore): فاتورتنا تمرّ للقراءة الكاملة، وفاتورة زبون آخر تُترك.
//  • ردّ المذخر على نصّ طلبية يدوية (matchQuotedText): تُعرف الطلبية بلا ذكاء.
//  • تشخيص «تلقائي» (diagnoseInvoiceRows): أيّ سطر يُعاد بالأقوى وحده.
//  • استخراج نص PDF: الأعمدة بترتيب رأس الجدول (الكمية لا تختلط بالبونص).
// ════════════════════════════════════════════════════════════════════════════
import { gateScore, GATE_MIN_SCORE } from '../server/lib/invoiceGate.js';
import { matchQuotedText } from '../server/modules/warehouse-dispatch/dispatch.inbound.js';
import { diagnoseInvoiceRows } from '../server/lib/aiModelSettings.js';
import { isPdf } from '../server/lib/invoicePdf.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`✗ ${label}\n    نتيجة: ${JSON.stringify(actual)}\n    متوقَّع: ${JSON.stringify(expected)}`); }
  else console.log(`✓ ${label}`);
};

// ── 1) الفحص السريع ─────────────────────────────────────────────────────────
const open = [
  { pharmacy: 'صيدلية النخيل الذهبي', items: ['Potafast sachets', 'Panadol Extra'] },
  { pharmacy: 'صيدلية الشفاء', items: ['Augmentin 1g'] },
];
const pass = (reading) => gateScore(reading, open) >= GATE_MIN_SCORE;
check('فاتورتنا: الاسم مطابق', pass({ pharmacy: 'النخيل الذهبي', items: ['POTAFAST SACHETS 30', 'PANADOL EXTRA 500MG'] }), true);
check('فاتورتنا والاسم مقروء ناقصاً («النخيل»)', pass({ pharmacy: 'النخيل', items: ['POTAFAST SACHETS 30'] }), true);
check('فاتورتنا والاسم مسبوق بعنوان الحقل', pass({ pharmacy: 'المتعامل: محمد يوسف / صيدلية الشفاء', items: ['AUGMENTIN 1G 14 TAB'] }), true);
check('الاسم لم يُقرأ ⇒ تُقرأ كاملة (لا نخاطر)', pass({ pharmacy: null, items: ['VITAMIN C'] }), true);
check('الأصناف مطابقة والاسم مقروء خطأً ⇒ تُقرأ كاملة', pass({ pharmacy: 'النخيلي الدهبي', items: ['POTAFAST SACHETS 30', 'PANADOL EXTRA'] }), true);
check('زبون آخر وأصناف أخرى ⇒ تُترك', pass({ pharmacy: 'الزنجيلي', items: ['SELADRENALIN', 'OMEPRAZOLE 20'] }), false);
check('زبون آخر (اسم مركّب) ⇒ تُترك', pass({ pharmacy: 'محمد يوسف احمد / صيدلية الزنجيلي', items: ['CIPROFLOXACIN'] }), false);

// ── 2) ردّ على نصّ طلبية يدوية ───────────────────────────────────────────────
const manual = [
  { order: { pharmacyName: 'سهل نينوى', lines: [{ itemName: 'Potafast' }, { itemName: 'Pantactive 40' }] }, warehouseName: 'سبأ الجديد' },
  { order: { pharmacyName: 'النور', lines: [{ itemName: 'Augmentin' }] }, warehouseName: 'سبأ الجديد' },
];
const quoted = '*الصيدلية: سهل نينوى*\nالمنطقة: الموصل\n──────────\n1) Potafast (humanis) — الكمية: 10 + بونص 2\n2) Pantactive 40 — الكمية: 5';
check('نصّ «طلبيات المذاخر» اليدوي يعرّف طلبيته', matchQuotedText(quoted, [], manual)?.name, 'سهل نينوى');
check('نصّ بوت الكروب («صيدلية X - المنطقة»)', matchQuotedText('صيدلية النور - الكرادة\nAugmentin 4', [], manual)?.name, 'النور');
check('اقتباس لا يخصّ أي طلبية', matchQuotedText('شكراً وصلت', [], manual), null);
check('بلا اقتباس', matchQuotedText(null, [], manual), null);
check('دفعة بوت مفتوحة (open) تُعرف أيضاً',
  matchQuotedText('صيدلية الشفاء - المنصور\nPanadol 10', [{ id: 7, pharmacyName: 'الشفاء', lines: [{ item: 'Panadol' }] }], [])?.d?.id, 7);

// ── 3) تشخيص «تلقائي»: الجزء المتعذّر وحده ──────────────────────────────────
const rows = [
  { item: 'A', quantity: 10, unitPrice: 5, total: 50, pharmacy: 'x' },
  { item: 'B', quantity: 6, unitPrice: 20, total: 200, pharmacy: 'x' },  // 6×20≠200 (الكمية 10 قُرئت 6)
  { item: 'B', quantity: 2, unitPrice: null, total: null, priceShown: false, pharmacy: 'x' }, // بونص بلا سعر
];
const d = diagnoseInvoiceRows(rows, { grandTotal: 250 });
check('سطر واحد خاطئ يُحدَّد بموضعه', d.badRows, [1]);
check('سطر البونص بلا سعر لا يُعدّ خطأً', d.badRows.includes(2), false);
check('بلا صيدلية في «مقارنة» لا يُعدّ خطأً', diagnoseInvoiceRows([{ item: 'A', quantity: 1, unitPrice: 5, total: 5 }], { needPharmacy: false }).ok, true);
check('مجموع الفاتورة بفاصل آلاف مقروء عشرياً يُقبل', diagnoseInvoiceRows([{ item: 'A', quantity: 2, unitPrice: 91932, total: 183864, pharmacy: 'x' }], { grandTotal: 183.864 }).ok, true);
check('لا أصناف ⇒ إعادة كاملة', diagnoseInvoiceRows([]).noRows, true);

// ── 4) PDF ───────────────────────────────────────────────────────────────────
check('بايتات PDF تُعرف', isPdf(Buffer.from('%PDF-1.7\n...')), true);
check('JPEG ليس PDF', isPdf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])), false);

console.log(failed ? `\n✗ فشل ${failed}` : '\n✓ كل الاختبارات نجحت');
process.exit(failed ? 1 : 0);
