// ════════════════════════════════════════════════════════════════════════════
// warehouseGapTemplate.js — نموذج إكسل شخصي لكل مدير شركة/قائد فريق لتوثيق
// مبيعات صيدليات تمّت عبر المذاخر لكن غابت عن ملف ميركاتو. يُبنى بناءً على
// شركات/ايتمات/مندوبي ذلك المستخدم تحديداً (لا نموذج عام واحد للجميع)، ويُقرأ
// عند إعادة رفعه بنفس ترتيب الأعمدة الثابت الذي يُنشئه buildWarehouseGapWorkbook.
// الصفوف الناتجة بنفس شكل صفوف insertManualSales (sales.service.js) لإعادة
// استخدام نفس منطق الحل/الإنشاء والربط بالمندوبين والمناطق والايتمات بلا تكرار.
//
// البناء يستعمل exceljs (لا xlsx) لأن مكتبة xlsx (SheetJS CE) المستعملة في
// باقي المشروع لا تكتب Data Validation — وهذا النموذج يحتاج قوائم منسدلة
// حقيقية (اختيار لا كتابة) لأعمدة المندوب/الشركة/الايتم. القراءة عند الرفع
// تبقى بمكتبة xlsx كسابقاً (قراءة عادية، لا علاقة لها بالتحقق).
// ════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

export const DATA_SHEET = 'البيانات';
const INSTR_SHEET = 'تعليمات';
const REF_SHEET   = 'القوائم المرجعية';

// ترتيب وتسميات أعمدة تبويب البيانات — ثابتة، يعتمد عليها القارئ أدناه.
const HEADERS = [
  'التاريخ', 'اسم الصيدلية', 'المنطقة', 'المندوب', 'الشركة', 'الايتم',
  'الكمية', 'سعر الوحدة (اختياري)', 'القيمة الإجمالية (اختياري)', 'اسم المذخر', 'رقم الفاتورة', 'ملاحظات',
];
// فهرس أعمدة تحتاج قائمة منسدلة (1-based، كما تتوقعه exceljs) + اسم عمودها بتبويب القوائم المرجعية
const DROPDOWN_COLS = [
  { col: 4, refCol: 'A', label: 'المندوب' },  // المندوب
  { col: 5, refCol: 'B', label: 'الشركة' },   // الشركة
  { col: 6, refCol: 'C', label: 'الايتم' },   // الايتم
];
const MAX_ROWS = 300; // عدد صفوف البيانات المدعومة بالقائمة المنسدلة

function normalizeHeader(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * يبني ملف إكسل (Buffer) مخصّصاً لمستخدم واحد — أعمدة المندوب/الشركة/الايتم
 * قوائم منسدلة حقيقية (اختيار فقط، الكتابة اليدوية تُرفض بخطأ Excel) مبنية من
 * تبويب "القوائم المرجعية" المملوء بنطاق ذلك المستخدم.
 * @param {{ reps: string[], items: string[], companies: string[] }} scope
 * @returns {Promise<Buffer>}
 */
export async function buildWarehouseGapWorkbook({ reps = [], items = [], companies = [] }) {
  const wb = new ExcelJS.Workbook();

  // ── 1) تبويب البيانات ──
  const dataSheet = wb.addWorksheet(DATA_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  dataSheet.addRow(HEADERS);
  dataSheet.getRow(1).font = { bold: true };
  dataSheet.columns = [
    { width: 12 }, { width: 24 }, { width: 16 }, { width: 20 }, { width: 20 }, { width: 24 },
    { width: 10 }, { width: 16 }, { width: 18 }, { width: 16 }, { width: 14 }, { width: 24 },
  ];

  // ── 2) تبويب القوائم المرجعية — مصدر القوائم المنسدلة ──
  const refSheet = wb.addWorksheet(REF_SHEET, { views: [{ rightToLeft: true }] });
  refSheet.addRow(['المندوب', 'الشركة', 'الايتم']);
  refSheet.getRow(1).font = { bold: true };
  const maxLen = Math.max(reps.length, items.length, companies.length, 1);
  for (let i = 0; i < maxLen; i++) {
    refSheet.addRow([reps[i] ?? '', companies[i] ?? '', items[i] ?? '']);
  }
  refSheet.columns = [{ width: 22 }, { width: 22 }, { width: 26 }];

  // ── قوائم منسدلة حقيقية على تبويب البيانات (اختيار فقط) ──
  const lists = { A: reps, B: companies, C: items };
  for (const { col, refCol, label } of DROPDOWN_COLS) {
    const len = lists[refCol].length;
    if (len === 0) continue; // لا قائمة متاحة لهذا المستخدم — يبقى العمود نصاً حراً كاحتياط
    const formula = `'${REF_SHEET}'!$${refCol}$2:$${refCol}$${len + 1}`;
    for (let r = 2; r <= MAX_ROWS + 1; r++) {
      dataSheet.getCell(r, col).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [formula],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: 'قيمة غير متاحة',
        error: `اختر ${label} من القائمة المنسدلة فقط — لا تتم الكتابة يدوياً.`,
      };
    }
  }

  // ── 3) تبويب التعليمات ──
  const instrSheet = wb.addWorksheet(INSTR_SHEET, { views: [{ rightToLeft: true }] });
  const instrRows = [
    ['تعليمات تعبئة نموذج مبيعات المذاخر الناقصة من ميركاتو'],
    [''],
    ['1', 'هذا الملف خاص بك: يحتوي فقط على شركاتك وايتماتك المعيّنة وأسماء مندوبي فريقك.'],
    ['2', 'استخدمه لتسجيل مبيعات صيدليات تمّت فعلاً عبر أحد المذاخر، لكنها لم تظهر ضمن ملف ميركاتو.'],
    ['3', 'في تبويب "' + DATA_SHEET + '" — صف واحد = عملية بيع واحدة. لا تُغيّر أسماء الأعمدة أو ترتيبها.'],
    ['4', 'أعمدة المندوب والشركة والايتم قوائم منسدلة — اضغط على الخلية واختر منها، لا تكتب فيها يدوياً.'],
    ['5', 'اترك "سعر الوحدة" و"القيمة الإجمالية" فارغين إن لم تعرفهما — سيستخدم التطبيق سعر المذخر المسجَّل لهذا الايتم تلقائياً عند الحفظ.'],
    ['6', 'إن لم يكن للايتم سعر مذخر مسجَّل عند التطبيق، سيُطلب منك إدخال السعر يدوياً قبل الحفظ (تنبيه يظهر بعد الرفع).'],
    ['7', 'الحقول الإلزامية: التاريخ، اسم الصيدلية، المندوب، الايتم، الكمية.'],
    ['8', 'بعد التعبئة احفظ الملف وارفعه من نفس الشاشة التي حمّلت منها هذا النموذج.'],
    ['9', 'ستُحتسب هذه المبيعات تلقائياً ضمن مبيعات ميركاتو في كل التقارير بعد الرفع — لا حاجة لأي خطوة إضافية.'],
  ];
  instrSheet.addRows(instrRows);
  instrSheet.columns = [{ width: 4 }, { width: 100 }];

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
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

  const headerRow = raw[0].map(h => normalizeHeader(h).replace(/\s*\(اختياري\)\s*$/, ''));
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
