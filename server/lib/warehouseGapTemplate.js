// ════════════════════════════════════════════════════════════════════════════
// warehouseGapTemplate.js — نموذج إكسل شخصي لكل مدير شركة/قائد فريق لتوثيق
// مبيعات صيدليات تمّت عبر المذاخر لكن غابت عن ملف ميركاتو. يُبنى بناءً على
// شركات/ايتمات/مندوبي ذلك المستخدم تحديداً (لا نموذج عام واحد للجميع)، ويُقرأ
// عند إعادة رفعه بنفس ترتيب الأعمدة الثابت الذي يُنشئه buildWarehouseGapWorkbook.
// الصفوف الناتجة بنفس شكل صفوف insertManualSales (sales.service.js) لإعادة
// استخدام نفس منطق الحل/الإنشاء والربط بالمندوبين والمناطق والايتمات بلا تكرار.
//
// البناء يستعمل exceljs (لا xlsx) لأن مكتبة xlsx (SheetJS CE) المستعملة في
// باقي المشروع لا تكتب Data Validation ولا صيغاً حيّة (Formulas) — وهذا النموذج
// يحتاج كليهما. القراءة عند الرفع تبقى بمكتبة xlsx كسابقاً.
// ════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

export const DATA_SHEET = 'البيانات';
const INSTR_SHEET = 'تعليمات';
const REF_SHEET   = 'القوائم المرجعية';
const MAX_ROWS    = 300; // عدد صفوف البيانات المدعومة بالقوائم المنسدلة والصيغة التلقائية

// صفوف اليوم (1-31) كقائمة منسدلة مُضمَّنة — لا حاجة لنطاق مرجعي لهذه فقط.
const DAY_LIST_FORMULA = `"${Array.from({ length: 31 }, (_, i) => i + 1).join(',')}"`;

function normalizeHeader(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}
// يُزيل أي ملاحظة بين قوسين من آخر الترويسة ("اليوم (شهر 10/2026)" → "اليوم")
// كي تبقى مطابقة الأعمدة عند القراءة غير مرتبطة بنص الملاحظة الديناميكي.
function headerKey(s) {
  return normalizeHeader(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * يبني ملف إكسل (Buffer) مخصّصاً لمستخدم واحد:
 *   - المندوب/الشركة/الايتم: قوائم منسدلة صارمة (اختيار فقط، الكتابة اليدوية تُرفض).
 *   - اليوم: قائمة منسدلة سريعة 1-31 (الشهر مكتوب في الترويسة)، مع السماح بكتابة
 *     تاريخ كامل بدلاً منها لمبيعة من شهر آخر.
 *   - المذخر: قائمة منسدلة من مذاخر دفتر "رصيد المذاخر" الخاص بالمستخدم، مع
 *     السماح بكتابة اسم مختلف غير موجود فيها (قائمة اقتراح لا تقييد).
 *   - القيمة الإجمالية: صيغة حيّة = الكمية × سعر الوحدة، تتحدّث تلقائياً.
 * @param {{ reps: string[], items: string[], companies: string[], warehouses?: string[] }} scope
 * @returns {Promise<Buffer>}
 */
export async function buildWarehouseGapWorkbook({ reps = [], items = [], companies = [], warehouses = [] }) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const monthLabel = now.toLocaleDateString('ar-IQ', { month: 'long', year: 'numeric' });

  const HEADERS = [
    `اليوم (شهر ${mm}/${yyyy})`, 'اسم الصيدلية', 'المنطقة', 'المندوب', 'الشركة', 'الايتم',
    'الكمية', 'سعر الوحدة (اختياري)', 'القيمة الإجمالية (تُحسب تلقائياً)', 'اسم المذخر', 'رقم الفاتورة', 'ملاحظات',
  ];

  const wb = new ExcelJS.Workbook();

  // ── 1) تبويب البيانات ──
  const dataSheet = wb.addWorksheet(DATA_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  dataSheet.addRow(HEADERS);
  dataSheet.getRow(1).font = { bold: true };
  dataSheet.columns = [
    { width: 16 }, { width: 24 }, { width: 16 }, { width: 20 }, { width: 20 }, { width: 24 },
    { width: 10 }, { width: 16 }, { width: 20 }, { width: 18 }, { width: 14 }, { width: 24 },
  ];

  // ── 2) تبويب القوائم المرجعية — مصدر القوائم المنسدلة ──
  const refSheet = wb.addWorksheet(REF_SHEET, { views: [{ rightToLeft: true }] });
  refSheet.addRow(['المندوب', 'الشركة', 'الايتم', 'المذخر']);
  refSheet.getRow(1).font = { bold: true };
  const maxLen = Math.max(reps.length, items.length, companies.length, warehouses.length, 1);
  for (let i = 0; i < maxLen; i++) {
    refSheet.addRow([reps[i] ?? '', companies[i] ?? '', items[i] ?? '', warehouses[i] ?? '']);
  }
  refSheet.columns = [{ width: 22 }, { width: 22 }, { width: 26 }, { width: 22 }];

  // ── قوائم منسدلة صارمة (اختيار فقط) على المندوب/الشركة/الايتم، مع رسالة
  // توجيهية (Input Message) تظهر تلقائياً بمجرد الدخول للخلية — أقرب ما يمكن
  // تحقيقه داخل إكسل نفسه لـ"عرض اقتراح فور التركيز" (بلا حساب بالتطبيق). ──
  const strictCols = [
    { col: 4, refCol: 'A', len: reps.length, label: 'المندوب' },
    { col: 5, refCol: 'B', len: companies.length, label: 'الشركة' },
    { col: 6, refCol: 'C', len: items.length, label: 'الايتم' },
  ];
  for (const { col, refCol, len, label } of strictCols) {
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
        showInputMessage: true,
        promptTitle: label,
        prompt: `ابدأ الكتابة فيُقترَح عليك تلقائياً ما يطابقها (ميزة الإكمال التلقائي لخانات إكسل)، أو اضغط ▼ لعرض كل القائمة. الاختيار من القائمة إلزامي.`,
      };
    }
  }

  // ── قوائم منسدلة مرنة (اقتراح لا تقييد — اختيار أو كتابة شيء مختلف) ──
  // اليوم (عمود 1): قائمة 1-31 مُضمَّنة، بلا نطاق مرجعي.
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    dataSheet.getCell(r, 1).dataValidation = {
      type: 'list', allowBlank: true, formulae: [DAY_LIST_FORMULA],
      showInputMessage: true, promptTitle: 'اليوم',
      prompt: `اختر رقم اليوم من القائمة (1-31) — الشهر ${monthLabel} مكتوب أعلاه تلقائياً. لمبيعة من شهر آخر، اكتب تاريخاً كاملاً بصيغة YYYY-MM-DD بدل اختيار يوم.`,
    };
  }
  // المذخر (عمود 10): قائمة من دفتر رصيد المذاخر إن وُجدت.
  const warehousePrompt = 'ابدأ الكتابة فيُقترَح عليك تلقائياً ما يطابقها، أو اضغط ▼ لعرض القائمة. يمكن أيضاً كتابة اسم مذخر مختلف غير مُدرَج.';
  if (warehouses.length > 0) {
    const formula = `'${REF_SHEET}'!$D$2:$D$${warehouses.length + 1}`;
    for (let r = 2; r <= MAX_ROWS + 1; r++) {
      dataSheet.getCell(r, 10).dataValidation = {
        type: 'list', allowBlank: true, formulae: [formula],
        showInputMessage: true, promptTitle: 'اسم المذخر', prompt: warehousePrompt,
      };
    }
  }

  // ── صيغة حيّة: القيمة الإجمالية (عمود 9) = الكمية (G) × سعر الوحدة (H) ──
  // تظهر فارغة ما لم يُدخَل الحقلان معاً، وتتحدّث تلقائياً مع أي تعديل رقمي —
  // بلا حاجة لأي حساب يدوي من المستخدم.
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    dataSheet.getCell(r, 9).value = { formula: `IF(AND(G${r}<>"",H${r}<>""),G${r}*H${r},"")` };
  }

  // ── تحقق على الكمية (عمود 7): رقم صحيح أكبر من صفر — يمنع خطأ شائع (نص/صفر/سالب)
  // قبل الرفع بدل اكتشافه بعد الرفع بتجاهل الصف صامتاً. ──
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    dataSheet.getCell(r, 7).dataValidation = {
      type: 'whole', operator: 'greaterThan', formulae: [0], allowBlank: true,
      showErrorMessage: true, errorStyle: 'error', errorTitle: 'كمية غير صالحة',
      error: 'أدخل رقماً صحيحاً أكبر من صفر.',
      showInputMessage: true, promptTitle: 'الكمية', prompt: 'أدخل رقماً صحيحاً أكبر من صفر.',
    };
  }

  // ── تنسيق أرقام (فواصل آلاف) للوضوح — لا يغيّر القيمة المخزَّنة، عرض فقط. ──
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    dataSheet.getCell(r, 7).numFmt = '#,##0';
    dataSheet.getCell(r, 8).numFmt = '#,##0.00';
    dataSheet.getCell(r, 9).numFmt = '#,##0.00';
  }

  // ── قيم مخفية بنفس أعمدة القوائم الصارمة/المرنة (أسفل نطاق البيانات الفعلي،
  // صفوف مخفية) — بلا أي دور في التحقق أو القراءة (القارئ يتوقف عند MAX_ROWS)،
  // غرضها الوحيد تفعيل ميزة إكسل الأصلية "الإكمال التلقائي لقيم الخلايا"
  // (تقترح إكسل تلقائياً أثناء الكتابة أي قيمة أخرى موجودة بنفس العمود): بإضافة
  // كل الأسماء الصالحة في نفس العمود (ولو مخفية)، يبدأ إكسل باقتراحها فور
  // كتابة أول حرف مطابق — أقرب سلوك ممكن لاقتراح فوري بلا حاجة لحساب بالتطبيق.
  const seedStart = MAX_ROWS + 5;
  const seedLists = { 4: reps, 5: companies, 6: items, 10: warehouses };
  let seedMaxLen = 0;
  for (const list of Object.values(seedLists)) seedMaxLen = Math.max(seedMaxLen, list.length);
  for (let i = 0; i < seedMaxLen; i++) {
    const r = seedStart + i;
    for (const [colStr, list] of Object.entries(seedLists)) {
      const v = list[i];
      if (v) dataSheet.getCell(r, Number(colStr)).value = v;
    }
    dataSheet.getRow(r).hidden = true;
  }

  // ── 3) تبويب التعليمات ──
  const instrSheet = wb.addWorksheet(INSTR_SHEET, { views: [{ rightToLeft: true }] });
  const instrRows = [
    ['تعليمات تعبئة نموذج مبيعات المذاخر الناقصة من ميركاتو'],
    [''],
    ['1', 'هذا الملف خاص بك: يحتوي فقط على شركاتك وايتماتك المعيّنة وأسماء مندوبي فريقك.'],
    ['2', 'استخدمه لتسجيل مبيعات صيدليات تمّت فعلاً عبر أحد المذاخر، لكنها لم تظهر ضمن ملف ميركاتو.'],
    ['3', 'في تبويب "' + DATA_SHEET + '" — صف واحد = عملية بيع واحدة. لا تُغيّر أسماء الأعمدة أو ترتيبها.'],
    ['4', 'أعمدة المندوب والشركة والايتم قوائم منسدلة إلزامية — اضغط على الخلية واختر منها، لا تكتب فيها يدوياً.'],
    ['5', `عمود "اليوم": اختر رقم اليوم فقط من القائمة (1-31) — الشهر ${monthLabel} مكتوب تلقائياً في عنوان العمود. لمبيعة من شهر آخر، اكتب تاريخاً كاملاً بصيغة YYYY-MM-DD في نفس الخانة بدل اختيار يوم.`],
    ['6', 'عمود "اسم المذخر": قائمة اقتراحية من مذاخرك المسجَّلة في رصيد المذاخر — يمكن اختيار أحدها أو كتابة اسم مختلف إن كان المذخر غير مُدرَج.'],
    ['7', 'اترك "سعر الوحدة" فارغاً إن لم تعرفه — يُستكمل تلقائياً من سعر المذخر المسجَّل لهذا الايتم عند الحفظ. إن أدخلته، يظهر "القيمة الإجمالية" تلقائياً (الكمية × السعر) بلا حاجة لحسابه يدوياً.'],
    ['8', 'إن لم يكن للايتم سعر مذخر مسجَّل عند التطبيق ولم تُدخل سعراً، سيُطلب منك إدخال السعر يدوياً قبل الحفظ (تنبيه يظهر بعد الرفع).'],
    ['9', 'عند الكتابة في أي خانة قائمة (مندوب/شركة/ايتم/مذخر)، تظهر رسالة توضيحية تلقائياً، واقتراحات إكسل أثناء الكتابة (تكتب حرفاً أو حرفين فتظهر القيم المطابقة) — هذه ميزة إكسل نفسه، تعمل بلا أي حساب أو إنترنت.'],
    ['10', 'الورقة محمية جزئياً لمنع تغيير الترويسات أو القوائم بالخطأ — خانات التعبئة فقط (صفوف البيانات) قابلة للتحرير، وهذا لا يمنعك من إدخال أي بيع.'],
    ['11', 'الحقول الإلزامية: اليوم، اسم الصيدلية، المندوب، الايتم، الكمية.'],
    ['12', 'بعد التعبئة احفظ الملف وارفعه من نفس الشاشة التي حمّلت منها هذا النموذج (أو أرسله لمن يملك حساباً في التطبيق ليرفعه) — ستُحتسب هذه المبيعات تلقائياً ضمن ميركاتو في كل التقارير.'],
  ];
  instrSheet.addRows(instrRows);
  instrSheet.columns = [{ width: 4 }, { width: 100 }];

  // ── حماية الأوراق: يبقى نطاق التعبئة الفعلي (صفوف 2..301، كل الأعمدة) قابلاً
  // للتحرير، وكل شيء آخر (الترويسة، القوائم المرجعية، التعليمات، الصفوف
  // المخفية) مقفل — يمنع مستلماً بلا حساب في التطبيق من تغيير ترويسة بالخطأ
  // فيفشل القارئ لاحقاً، أو حذف/تعديل قوائم التحقق والإكمال التلقائي. بلا
  // كلمة سر (حماية من الخطأ لا سرّية) فـ"إزالة الحماية" تعمل فوراً من القائمة.
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    for (let c = 1; c <= HEADERS.length; c++) {
      dataSheet.getCell(r, c).protection = { locked: false };
    }
  }
  await dataSheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  await refSheet.protect('', { selectLockedCells: true, selectUnlockedCells: false });
  await instrSheet.protect('', { selectLockedCells: true, selectUnlockedCells: false });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/** يحوّل قيمة خانة "اليوم" إلى تاريخ: رقم يوم (1-31) يُركَّب مع شهر/سنة الترويسة،
 * أو أي قيمة أخرى (تاريخ كامل مكتوب، أو رقم تسلسلي من إكسل) تمر كما هي لتُفسَّر
 * لاحقاً عبر parseExcelDate (sales.service.js) الذي يفهم كلا الشكلين أصلاً. */
function resolveDayCell(raw, year, month) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const asDay = Number(raw);
  if (Number.isInteger(asDay) && asDay >= 1 && asDay <= 31 && String(raw).trim().length <= 2) {
    return new Date(Date.UTC(year, month - 1, asDay));
  }
  return raw;
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

  const headerRowRaw = raw[0];
  const headerRow = headerRowRaw.map(headerKey);
  const colIdx = name => headerRow.findIndex(h => h === name);

  // الشهر/السنة المضمَّنان في ترويسة عمود اليوم، مثل "اليوم (شهر 10/2026)".
  const dayHeaderIdx = colIdx('اليوم');
  let ymYear = new Date().getFullYear(), ymMonth = new Date().getMonth() + 1;
  if (dayHeaderIdx !== -1) {
    const m = normalizeHeader(headerRowRaw[dayHeaderIdx]).match(/شهر\s*(\d{1,2})\s*\/\s*(\d{4})/);
    if (m) { ymMonth = parseInt(m[1], 10); ymYear = parseInt(m[2], 10); }
  }

  const idx = {
    date:          dayHeaderIdx,
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

  // الحد الأعلى MAX_ROWS+1 يتجاهل عمداً الصفوف المخفية بعده (بذرة الإكمال
  // التلقائي لإكسل في buildWarehouseGapWorkbook) كي لا تُقرأ كصفوف مبيعات حقيقية.
  const lastRow = Math.min(raw.length, MAX_ROWS + 1);
  const rows = [];
  for (let i = 1; i < lastRow; i++) {
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
      date:          idx.date          !== -1 ? resolveDayCell(r[idx.date], ymYear, ymMonth) : undefined,
      invoiceNumber: idx.invoiceNumber !== -1 ? (String(r[idx.invoiceNumber] ?? '').trim() || undefined) : undefined,
      notes:         idx.notes         !== -1 ? (String(r[idx.notes]        ?? '').trim() || undefined) : undefined,
    });
  }

  if (rows.length === 0 && warnings.length === 0) {
    warnings.push('لم يتم العثور على أي صف بيانات في تبويب "' + DATA_SHEET + '".');
  }

  return { rows, warnings };
}
