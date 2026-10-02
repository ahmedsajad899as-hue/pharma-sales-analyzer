// ════════════════════════════════════════════════════════════════════════════
// warehouseGapTemplate.js — نموذج إكسل شخصي لكل مدير شركة/قائد فريق لتوثيق
// مبيعات صيدليات تمّت عبر المذاخر لكن غابت عن ملف ميركاتو. يُبنى بناءً على
// شركات/ايتمات/مندوبي ذلك المستخدم تحديداً (لا نموذج عام واحد للجميع)، ويُقرأ
// عند إعادة رفعه بنفس ترتيب الأعمدة الثابت الذي يُنشئه buildWarehouseGapWorkbook.
// الصفوف الناتجة بنفس شكل صفوف insertManualSales (sales.service.js) لإعادة
// استخدام نفس منطق الحل/الإنشاء والربط بالمندوبين والمناطق والايتمات بلا تكرار.
// ════════════════════════════════════════════════════════════════════════════

import * as XLSX from 'xlsx';

export const DATA_SHEET  = 'البيانات';
const INSTR_SHEET  = 'تعليمات';
const REF_SHEET    = 'القوائم المرجعية';

// ترتيب وتسميات أعمدة تبويب البيانات — ثابتة، يعتمد عليها القارئ أدناه.
const HEADERS = [
  'التاريخ', 'اسم الصيدلية', 'المنطقة', 'المندوب', 'الشركة', 'الايتم',
  'الكمية', 'سعر الوحدة', 'القيمة الإجمالية', 'اسم المذخر', 'رقم الفاتورة', 'ملاحظات',
];

function normalizeHeader(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * يبني ملف إكسل (Buffer) مخصّصاً لمستخدم واحد.
 * @param {{ reps: string[], items: string[], companies: string[] }} scope
 * @returns {Buffer}
 */
export function buildWarehouseGapWorkbook({ reps = [], items = [], companies = [] }) {
  const wb = XLSX.utils.book_new();

  // ── 1) تبويب البيانات — فارغ عدا الترويسة، هو ما يُقرأ عند الرفع ──
  const dataSheet = XLSX.utils.aoa_to_sheet([HEADERS]);
  dataSheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 24 },
    { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, dataSheet, DATA_SHEET);

  // ── 2) تبويب التعليمات ──
  const instrRows = [
    ['تعليمات تعبئة نموذج مبيعات المذاخر الناقصة من ميركاتو'],
    [''],
    ['1', 'هذا الملف خاص بك: يحتوي فقط على شركاتك وايتماتك المعيّنة وأسماء مندوبي فريقك.'],
    ['2', 'استخدمه لتسجيل مبيعات صيدليات تمّت فعلاً عبر أحد المذاخر، لكنها لم تظهر ضمن ملف ميركاتو.'],
    ['3', 'في تبويب "' + DATA_SHEET + '" — صف واحد = عملية بيع واحدة. لا تُغيّر أسماء الأعمدة أو ترتيبها.'],
    ['4', 'اكتب اسم المندوب والشركة والمادة بالضبط كما وردت في تبويب "' + REF_SHEET + '" (انسخ منه مباشرة لتفادي الأخطاء الإملائية).'],
    ['5', 'يكفي تعبئة "سعر الوحدة" أو "القيمة الإجمالية" — الحقل الناقص يُحسب تلقائياً من الآخر.'],
    ['6', 'الحقول الإلزامية: التاريخ، اسم الصيدلية، المندوب، الايتم، الكمية، وأحد حقلي السعر.'],
    ['7', 'بعد التعبئة احفظ الملف وارفعه من نفس الشاشة التي حمّلت منها هذا النموذج.'],
    ['8', 'ستُحتسب هذه المبيعات تلقائياً ضمن مبيعات ميركاتو في كل التقارير بعد الرفع — لا حاجة لأي خطوة إضافية.'],
  ];
  const instrSheet = XLSX.utils.aoa_to_sheet(instrRows);
  instrSheet['!cols'] = [{ wch: 4 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, instrSheet, INSTR_SHEET);

  // ── 3) تبويب القوائم المرجعية — للنسخ منه ──
  const maxLen = Math.max(reps.length, items.length, companies.length, 1);
  const refRows = [['المندوب', 'الشركة', 'الايتم']];
  for (let i = 0; i < maxLen; i++) {
    refRows.push([reps[i] ?? '', companies[i] ?? '', items[i] ?? '']);
  }
  const refSheet = XLSX.utils.aoa_to_sheet(refRows);
  refSheet['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, refSheet, REF_SHEET);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * يقرأ ملفاً مُعبَّأً بنفس شكل buildWarehouseGapWorkbook ويُرجع صفوفاً بشكل
 * صفوف insertManualSales: { repName, item, company?, quantity, totalValue?,
 * unitPrice?, pharmacy?, warehouse?, area?, date?, invoiceNumber?, notes? }
 * @param {Buffer} buffer
 * @returns {{ rows: object[], warnings: string[] }}
 */
export function parseWarehouseGapWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const warnings = [];

  const sheetName = wb.SheetNames.find(n => normalizeHeader(n) === DATA_SHEET) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return { rows: [], warnings: ['لم يُعثر على أي تبويب في الملف.'] };

  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (raw.length < 1) return { rows: [], warnings: ['الملف فارغ.'] };

  const headerRow = raw[0].map(normalizeHeader);
  const colIdx = name => headerRow.findIndex(h => h === name);

  const idx = {
    date:          colIdx('التاريخ'),
    pharmacy:      colIdx('اسم الصيدلية'),
    area:          colIdx('المنطقة'),
    repName:       colIdx('المندوب'),
    company:       colIdx('الشركة'),
    item:          colIdx('الايتم'),
    quantity:      colIdx('الكمية'),
    unitPrice:     colIdx('سعر الوحدة'),
    totalValue:    colIdx('القيمة الإجمالية'),
    warehouse:     colIdx('اسم المذخر'),
    invoiceNumber: colIdx('رقم الفاتورة'),
    notes:         colIdx('ملاحظات'),
  };

  if (idx.item === -1 || idx.quantity === -1 || idx.repName === -1) {
    return {
      rows: [],
      warnings: ['تعذّر التعرف على أعمدة الملف — تأكد من استخدام النموذج المُحمَّل من التطبيق بلا تعديل أسماء الأعمدة.'],
    };
  }

  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.every(c => String(c ?? '').trim() === '')) continue; // صف فارغ

    const item     = String(r[idx.item] ?? '').trim();
    const repName  = String(r[idx.repName] ?? '').trim();
    const quantity = Number(String(r[idx.quantity] ?? '').replace(/,/g, '')) || 0;
    if (!item || !repName || quantity <= 0) {
      warnings.push(`صف ${i + 1}: تم تجاهله — يحتاج مندوباً ومادة وكمية أكبر من صفر.`);
      continue;
    }

    rows.push({
      repName,
      item,
      company:       idx.company       !== -1 ? (String(r[idx.company]       ?? '').trim() || undefined) : undefined,
      quantity,
      unitPrice:     idx.unitPrice     !== -1 ? (Number(String(r[idx.unitPrice]  ?? '').replace(/,/g, '')) || undefined) : undefined,
      totalValue:    idx.totalValue    !== -1 ? (Number(String(r[idx.totalValue] ?? '').replace(/,/g, '')) || undefined) : undefined,
      pharmacy:      idx.pharmacy      !== -1 ? (String(r[idx.pharmacy]      ?? '').trim() || undefined) : undefined,
      warehouse:     idx.warehouse     !== -1 ? (String(r[idx.warehouse]     ?? '').trim() || undefined) : undefined,
      area:          idx.area          !== -1 ? (String(r[idx.area]         ?? '').trim() || undefined) : undefined,
      date:          idx.date          !== -1 ? (r[idx.date] || undefined) : undefined,
      invoiceNumber: idx.invoiceNumber !== -1 ? (String(r[idx.invoiceNumber] ?? '').trim() || undefined) : undefined,
      notes:         idx.notes         !== -1 ? (String(r[idx.notes]        ?? '').trim() || undefined) : undefined,
    });
  }

  if (rows.length === 0 && warnings.length === 0) {
    warnings.push('لم يتم العثور على أي صف بيانات في تبويب "' + DATA_SHEET + '".');
  }

  return { rows, warnings };
}
