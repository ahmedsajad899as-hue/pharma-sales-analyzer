/**
 * Sales Service
 * Business logic for parsing Excel files and inserting sales data.
 * Orchestrates repository calls — no direct DB access here.
 */

import { canRotate, rotateJpeg } from '../../lib/invoiceImage.js';
import { customerKnownScore } from '../../lib/invoiceCustomerMatch.js';
import { repCoreName, buildRepIndex, matchRepName } from '../../lib/repNameMatch.js';
import XLSX from 'xlsx';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  findOrCreateArea,
  findOrCreateItem,
  findOrCreateCompany,
  findOrCreateCustomer,
  findRepByName,
  bulkCreateSales,
  createUploadedFile,
  getAllCompanies,
  normalizeArabic,
} from './sales.repository.js';
import { buildNormalizationMap, areSimilar, similarity } from '../../lib/fuzzyMatch.js';
import { isPlaceholderCompanyValue } from '../../lib/companyResolver.js';
import { PROVINCE_COLUMN_ALIASES, buildProvinceLookup, matchProvinceName, provinceFromText } from '../../lib/provinces.js';
import { userIdsAssignedToProvinces, syncUserAreaDerivedLinks, resolveEffectiveAreaIds } from '../../lib/areaScope.js';
import { loadResolutionContext, resolveItemName, normalizeItemKey, normalizeAreaName } from '../../lib/itemResolver.js';
import { getAssignedItemsCatalog } from '../../lib/itemScope.js';
import { getManagerRoster } from '../../lib/managerRoster.js';
import {
  isMergeableType, resolveCumulativeTarget, openMergeBatch,
  appendRowsToCumulative, closeMergeBatch, refreshCumulativeFile,
} from '../../lib/cumulativeFile.js';
import { CONDITION_VARIANT } from '../../lib/saleFingerprint.js';
import { UNDATED_SENTINEL } from '../../lib/salesMonths.js';
import { resolveLedgerScope } from '../../lib/stockLedgerScope.js';
import { getWarehouses } from '../stock-ledger/stock-ledger.repository.js';
import { buildWarehouseGapWorkbook, parseWarehouseGapWorkbook } from '../../lib/warehouseGapTemplate.js';
import { syncCommercialsForNewSales } from '../scientific-reps/scientific-reps.service.js';
import { ExcelRowSchema } from './sales.dto.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';
import { callAI } from '../../lib/claudeAi.js';
import { callQwen, qwenConfigured } from '../../lib/qwenAi.js';

// صور الفواتير تُقرأ بـ Qwen-VL (أرخص)، وClaude احتياطي إن فشل Qwen أو لم يُهيّأ مفتاحه —
// حتى لا تتوقّف قراءة الفواتير بسبب عطل مزوّد واحد.
async function callInvoiceAI(parts, opts) {
  if (!qwenConfigured()) return callAI(parts, opts);
  try {
    return await callQwen(parts, opts);
  } catch (err) {
    console.error(`[invoice-extract] Qwen فشل (${opts?.feature}) — احتياطي Claude:`, String(err?.message || '').slice(0, 150));
    return callAI(parts, opts);
  }
}

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2  = path.dirname(__filename2);
// Folder where we persist the original Excel files
const EXCEL_UPLOADS_DIR = path.join(__dirname2, '..', '..', '..', 'uploads', 'excel-files');

function ensureExcelUploadsDir() {
  if (!existsSync(EXCEL_UPLOADS_DIR)) mkdirSync(EXCEL_UPLOADS_DIR, { recursive: true });
}

/**
 * Column name variants the parser will accept (case-insensitive).
 * Extend this map to support more Excel header names.
 */
export const COLUMN_ALIASES = {
  repName:    [
    'representative name', 'rep name', 'rep', 'sales rep', 'salesman', 'agent',
    'مندوب', 'اسم المندوب', 'المندوب', 'اسم الممثل', 'الممثل', 'البائع',
    'اسم البائع', 'موظف المبيعات', 'مندوب المبيعات',
  ],
  // المحافظة لم تعد هنا — صارت حقلاً مستقلاً (province) أدناه. كانت الترويستان
  // «محافظة» و«الموقع» في نفس القائمة، و resolveColumns يأخذ أول alias يطابق
  // ترويسة موجودة، فيفوز عمود واحد ويُهمل الآخر تماماً.
  area:       [
    'area', 'region', 'territory', 'zone', 'city', 'location', 'district',
    'منطقة', 'المنطقة', 'المدينة', 'مدينة', 'المنطقه', 'منطقه',
    'الفرع', 'فرع', 'الموقع',
  ],
  // المستوى الجغرافي الأعلى. القائمة مشتركة مع autoMatchProvinces الذي يقرأ
  // نفس الترويسات من Sale.rawData للملفات المرفوعة قبل هذه الميزة.
  province:   [...PROVINCE_COLUMN_ALIASES],
  item:       [
    // NOTE: order matters — resolveColumns() picks the FIRST alias that matches a
    // header. Explicit drug/item-name headers come first so a file that has both
    // an ambiguous "صنف" (often = customer type: تجاري/حكومي) and a real "المادة"
    // column resolves item to "المادة", not "صنف". Ambiguous/generic terms go last
    // as a fallback for files that only carry them.
    'item name', 'product name', 'drug name', 'name of item', 'Item Name',
    'اسم المادة', 'المادة', 'اسم الدواء', 'الدواء', 'اسم المنتج', 'المنتج',
    'اسم الصنف', 'اسم الايتم', 'الايتم', 'ايتم', 'آيتم', 'الآيتم',
    'المستحضر', 'اسم المستحضر', 'اسم العلاج',
    'item', 'drug', 'product', 'medicine', 'brand', 'trade name', 'material',
    'صنف', 'الصنف', 'مادة', 'دواء', 'منتج', 'بند', 'description',
  ],
  quantity:   [
    'quantity', 'qty', 'units', 'boxes', 'packs', 'count', 'no', 'pieces',
    'كمية', 'الكمية', 'عدد', 'العدد', 'الوحدات', 'عدد الوحدات',
    'كميه', 'الكميه', 'حجم', 'الحجم',
  ],
  totalValue: [
    'total value', 'totalvalue', 'value', 'total', 'amount',
    'sales value', 'net value', 'net amount', 'total sales', 'revenue',
    'net sale', 'net sales', 'netsale', 'netsales',
    'قيمة المبيعات', 'إجمالي المبيعات', 'اجمالي المبيعات',
    'القيمة الإجمالية', 'قيمة الطلب', 'الإجمالي', 'إجمالي', 'اجمالي',
    'قيمة', 'القيمة', 'قيمه', 'القيمه',
    'المجموع الكلي', 'مجموع كلي', 'المجموع', 'مجموع', 'الإجمالي الكلي',
    'اجمالي كلي', 'total amount', 'grand total', 'net total',
    'السعر الكلي', 'سعر كلي', 'السعر الاجمالي', 'السعر الإجمالي', 'القيمة الكلية',
    'مبلغ الإجمالي', 'مبلغ الاجمالي', 'المبلغ الإجمالي', 'المبلغ الاجمالي',
  ],
  unitPrice: [
    'price', 'unit price', 'unit cost', 'selling price', 'cost', 'rate',
    'price per unit', 'cost per unit',
    'السعر', 'سعر', 'سعر الوحدة', 'سعر الوحده', 'سعر الوحدات',
    'المبلغ', 'مبلغ', 'سعر المبيع', 'سعر البيع',
  ],
  customer: [
    'customer', 'client', 'pharmacy', 'hospital', 'clinic', 'buyer', 'account',
    'pharmacist', 'dr', 'doctor', 'distributor', 'wholesaler',
    'زبون', 'الزبون', 'عميل', 'العميل', 'صيدلية', 'الصيدلية', 'مستشفى', 'المستشفى',
    'عيادة', 'العيادة', 'جهة', 'اسم الزبون', 'اسم العميل', 'اسم الصيدلية',
    'الموزع', 'موزع', 'تاجر', 'التاجر', 'أسم العميل', 'طبيب',
    'مذخر', 'المذخر', 'اسم المذخر', 'مخزن', 'المخزن', 'اسم المخزن',
    'مستودع', 'المستودع', 'اسم المستودع', 'warehouse', 'store', 'depot',
  ],
  date: [
    'date', 'sale date', 'invoice date', 'order date', 'transaction date', 'period',
    'تاريخ', 'التاريخ', 'تاريخ البيع', 'تاريخ الفاتورة', 'تاريخ الطلب',
    'تاريخ العملية', 'الفترة', 'الشهر', 'شهر',
    'أنشات بتاريخ', 'انشات بتاريخ', 'تاريخ الانشاء', 'تاريخ الإنشاء',
    'created at', 'created date', 'order created',
  ],
  company: [
    'company', 'company name', 'manufacturer', 'brand company', 'pharma company',
    'شركة', 'شركه', 'اسم الشركة', 'اسم الشركه', 'الشركة', 'الشركه',
    'المورد', 'مورد', 'اسم المورد', 'المصنع', 'مصنع', 'اسم المصنع',
    'الشركة المصنعة', 'اسم الشركه المصنعه',
  ],
  // حقل حر منفصل عن «customer» أعلاه (اسم الصيدلية/العميل نفسه) — يُستعمل فقط
  // لتغذية Sale.customerInfoNorm الذي يطابقه «حجب أسماء داخل معلومات الزبون».
  // عبارات مركّبة عمداً (لا كلمات مفردة كـ«الزبون») كي لا تتزاحم مع partial
  // matching لحقل customer حين لا يوجد عمود «العميل/الزبون» منفصل بالملف.
  customerInfo: [
    'معلومات الزبون', 'معلومات العميل', 'بيانات الزبون', 'بيانات العميل',
    'تفاصيل الزبون', 'تفاصيل العميل', 'وصف الزبون', 'وصف العميل',
    'customer info', 'customer information', 'customer details',
  ],
};

/**
 * Process an uploaded Excel file:
 *  1. Parse the workbook
 *  2. Validate each row
 *  3. Auto-create areas/items/reps if new
 *  4. Bulk-insert sales
 *  5. Record the upload
 *
 * @param {Express.Multer.File} file
 * @param {{ uploadedBy?: string, columnMapping?: object }} options
 * @returns {{ rowCount, skipped, uploadedFile }}
 */
export async function processUploadedFile(file, options = {}) {
  // rawOriginalName: يتخطّى تصحيح latin1→utf8 أدناه (مطلوب فقط لأسماء ملفات
  // multipart القادمة من متصفح/multer — عطل ترميز معروف). مصادر أخرى (تلكرام
  // مثلاً) ترسل file.originalname كنص UTF-8 صحيح أصلاً؛ تمريره لنفس التحويل
  // كان سيُفسده بدل تصحيحه.
  const { uploadedBy, columnMapping = {}, userId = null, fileType = 'sales', sourceCurrency = null, rawOriginalName = false, mergeIntoCumulative = true } = options;
  const fixOriginalName = (name) => rawOriginalName ? name : Buffer.from(name, 'latin1').toString('utf8');

  // ── 0. filter_page — just store the file, skip all sales processing ──────────
  if (fileType === 'filter_page') {
    const fileBuffer = file.buffer || readFileSync(file.path);
    const originalName = fixOriginalName(file.originalname);
    // Save to disk (best-effort — ephemeral on Railway)
    ensureExcelUploadsDir();
    const safeOriginalName = originalName.replace(/[^a-zA-Z0-9\u0600-\u06FF._-]/g, '_');
    const savedFilename = `${Date.now()}_${safeOriginalName}`;
    const savedFilePath = path.join(EXCEL_UPLOADS_DIR, savedFilename);
    try { writeFileSync(savedFilePath, fileBuffer); } catch (e) {
      console.warn('[upload] could not save filter_page file to disk:', e.message);
    }
    // Also save base64 content to DB — survives Railway ephemeral disk restarts
    const fileContent = fileBuffer.toString('base64');
    const uploadedFile = await createUploadedFile({
      filename:     savedFilename,
      originalName: originalName,
      rowCount:     0,
      uploadedBy:   uploadedBy || null,
      userId,
      fileType:     'filter_page',
      fileContent,
    });
    return { rowCount: 0, skipped: 0, uploadedFile, normalizationLog: [] };
  }

  // ── 1. Parse workbook ────────────────────────────────────
  const fileBuffer = file.buffer || readFileSync(file.path);
  // cellStyles: true → يحمّل !rows (تشمل hidden) من ملف الإكسل، لازمة لاحترام
  // فلتر الإكسل (AutoFilter) عند القراءة أدناه (skipHidden).
  const workbook   = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true, cellStyles: true });

  console.log(`[upload] fileType="${fileType}" | sheets in workbook:`, workbook.SheetNames);

  // ── 1b. Matrix (cross-tabular pivot) format shortcut ─────
  if (fileType === 'matrix') {
    const ws         = workbook.Sheets[workbook.SheetNames[0]];
    const matrixRows = parseMatrixSheet(ws);

    if (matrixRows.length === 0) {
      throw new AppError(
        'لم يتم العثور على بيانات صالحة في ملف المصفوفة.\n' +
        'تأكد من هيكل الملف: الصف الأول = أسماء المناطق (مدموجة ومُلوّنة)، ' +
        'الصف الثاني = أسماء المذاخر، الأعمدة الأولى = كود الصنف، اسم الصنف، السعر.',
        422,
        'MATRIX_EMPTY',
      );
    }

    // Inject the matrix flat rows directly as salesRows and skip the tabular parser
    return await _finishProcessing({
      salesRows:      matrixRows,
      returnsRows:    [],
      skippedRows:    [],
      totalRows:      matrixRows.length,
      file,
      uploadedBy,
      userId,
      columnMapping,
      fileType:       'sales',   // matrix output is always treated as sales
      sourceCurrency,
      rawOriginalName,
      mergeIntoCumulative,
    });
  }

  // ── Standard tabular format below ────────────────────────

  // Decide which sheets to process and whether they are forced-return sheets
  const sheetsToProcess = [];
  if (fileType === 'auto') {
    // Multi-sheet: process ALL sheets; detect type by sheet name
    for (const sn of workbook.SheetNames) {
      sheetsToProcess.push({ sheetName: sn, forceReturn: isReturnSheet(sn) });
    }
  } else {
    // Always process first sheet with the selected fileType
    sheetsToProcess.push({ sheetName: workbook.SheetNames[0], forceReturn: fileType === 'returns' });
    // Smart multi-sheet: also process additional sheets whose names indicate sales or returns
    for (let i = 1; i < workbook.SheetNames.length; i++) {
      const sn = workbook.SheetNames[i];
      if (isReturnSheet(sn)) {
        sheetsToProcess.push({ sheetName: sn, forceReturn: true });
      } else if (isSalesSheet(sn)) {
        sheetsToProcess.push({ sheetName: sn, forceReturn: false });
      }
    }
  }

  // Collect all raw rows with their sheet-level return flag + per-sheet colMap
  const allRawEntries = [];
  let totalRows = 0;
  let isMercatoFile = false;   // أي ورقة بتوقيع ميركاتو تجعل الملف كله ميركاتو
  for (const { sheetName, forceReturn } of sheetsToProcess) {
    const ws = workbook.Sheets[sheetName];
    // Skip leading title/metadata rows: start parsing from the detected header row.
    const headerRowIdx = detectHeaderRow(ws, columnMapping);
    let rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: headerRowIdx });
    if (rows.length === 0) continue;
    // فلتر الإكسل (AutoFilter): الصفوف التي أخفاها المستخدم بفلتر في الملف الأصلي
    // (قبل الرفع) تبقى مستبعدة هنا فلا تُستورد — أي فلتره في الإكسل يستمر مفعوله
    // داخل التطبيق. لا نلمس الأعمدة المخفية (قد تكون مخفية لأسباب شكلية فقط
    // وبياناتها ما زالت مطلوبة)، فقط الصفوف عبر ws['!rows'][r].hidden.
    const hiddenRowInfo = ws['!rows'];
    if (hiddenRowInfo && hiddenRowInfo.length) {
      const beforeFilter = rows.length;
      rows = rows.filter(row => !hiddenRowInfo[row.__rowNum__]?.hidden);
      if (rows.length < beforeFilter) {
        console.log(`[upload] Sheet "${sheetName}": استبعدنا ${beforeFilter - rows.length} صف مخفي بفلتر الإكسل (AutoFilter).`);
      }
      if (rows.length === 0) continue;
    }
    // Resolve columns independently per sheet (each sheet may have different header names)
    const sheetHeaders = Object.keys(rows[0]);
    const sheetColMap  = resolveColumns(sheetHeaders, columnMapping);
    // ميركاتو: نفرض خريطته الصريحة فوق المطابقة العامة (تُخطئ في المادة/الشركة/
    // الزبون هنا) — مع إبقاء أي override صريح من المستخدم فوق الجميع.
    if (detectMercatoFormat(sheetHeaders)) {
      isMercatoFile = true;
      for (const [field, col] of Object.entries(mercatoColumnMap(sheetHeaders))) {
        if (columnMapping[field] && sheetHeaders.includes(columnMapping[field])) continue;
        sheetColMap[field] = col;
      }
      console.log(`[upload] Sheet "${sheetName}" detected as MERCATO — using explicit column map.`);
    }
    console.log(`[upload] Sheet: "${sheetName}" | forceReturn=${forceReturn} | rows=${rows.length} | cols:`, sheetColMap);
    for (const row of rows) allRawEntries.push({ raw: { ...row, _sheetName: sheetName }, forceReturn, colMap: sheetColMap });
    totalRows += rows.length;
  }

  if (allRawEntries.length === 0) {
    throw new AppError('Excel file is empty or has no data rows.', 400, 'EMPTY_FILE');
  }

  // ── 2. Column map is now per-row (set above per-sheet)
  const colMap = allRawEntries[0].colMap; // used only for error messages below

  // ── 3. Parse + validate each row ────────────────────────
  const salesRows   = [];   // recordType = 'sale'
  const returnsRows = [];   // recordType = 'return'
  const skippedRows = [];
  // اسم الايتم لكل صف كانت قيمة عمود «الشركة» فيه نصاً غير فارغ لكنه بلا معنى
  // فعلي (null/N-A/undefined...) — تُعرض للمستخدم بعد الرفع ليحدد شركتها يدوياً
  // بدل ربطها بشركة وهمية بصمت.
  const unclearCompanyItems = new Set();

  for (let i = 0; i < allRawEntries.length; i++) {
    const { raw, forceReturn, colMap: rc } = allRawEntries[i];

    const rawQty   = parseNumeric(raw[rc.quantity]);
    const rawTotal = parseNumeric(raw[rc.totalValue]);
    const rawPrice = parseNumeric(raw[rc.unitPrice]);
    const qty      = Math.abs(rawQty || 0);

    // Skip summary/total rows — these have qty=0 and a large totalValue (e.g. grand total footer rows in Excel)
    if (qty === 0) {
      skippedRows.push({ row: i + 2, errors: { quantity: ['zero quantity – likely a summary row'] }, data: raw });
      continue;
    }

    // totalValue logic:
    // 1. If an explicit total column is mapped and has a value → use it
    // 2. Else if a unit-price column is mapped → qty × unitPrice
    // 3. Else fall back to whatever totalValue column returned
    let totalVal;
    if (rc.totalValue !== 'totalValue' && Math.abs(rawTotal) > 0) {
      totalVal = Math.abs(rawTotal);
    } else if (rc.unitPrice !== 'unitPrice' && Math.abs(rawPrice) > 0) {
      totalVal = qty * Math.abs(rawPrice);
    } else {
      totalVal = Math.abs(rawTotal);
    }

    // ── Determine record type ──────────────────────────────
    let rowRecordType;
    if (fileType === 'auto') {
      rowRecordType = (forceReturn || rawQty < 0 || rawTotal < 0) ? 'return' : 'sale';
    } else {
      // forceReturn is set when the sheet name indicates returns (e.g. "الارجاعات")
      rowRecordType = (fileType === 'returns' || forceReturn || rawQty < 0 || rawTotal < 0) ? 'return' : 'sale';
    }

    // قيمة عمود المحافظة — تُحفظ على Area لاحقاً، لا على Sale (المحافظة تُشتق
    // من المنطقة). null إن لم يوجد عمود محافظة في الملف.
    const provinceVal = String(raw[rc.province] || '').trim() || null;

    // تراجع: ملف فيه «محافظة» فقط بلا عمود منطقة كان يعمل قبل فصل الحقلين
    // (كانت «محافظة» alias للمنطقة). نُبقيه يعمل باستعمال المحافظة اسماً
    // للمنطقة أيضاً، وإلا صارت كل صفوفه «غير محدد».
    // اسم الشيت هذا يُستعمل كمنطقة فقط حين يكون اسماً حقيقياً لمنطقة (ملف
    // مقسّم شيت لكل منطقة) — أما الاسم الافتراضي الذي لم يُغيَّر ("Sheet1"،
    // "ورقة1"…) فليس اسم منطقة فعلياً، فتجاهله يمنع إنشاء منطقة وهمية باسمه.
    const sheetNameVal = String(raw['_sheetName'] || '').trim();
    const areaVal = String(raw[rc.area] || '').trim()
      || provinceVal
      || (isGenericSheetName(sheetNameVal) ? '' : sheetNameVal)
      || 'غير محدد';

    const itemNameVal   = String(raw[rc.item] || '').trim() || 'غير محدد';
    const companyRawVal = String(raw[rc.company] || '').trim();
    if (companyRawVal && isPlaceholderCompanyValue(companyRawVal)) {
      unclearCompanyItems.add(itemNameVal);
    }

    const parsed = {
      repName:    String(raw[rc.repName]    || '').trim() || 'غير محدد',
      // اسم الشيت يُستعمل كمنطقة حين لا يوجد عمود منطقة ولا محافظة في الصف
      area:       areaVal,
      province:   provinceVal,
      item:       itemNameVal,
      company:    (companyRawVal && !isPlaceholderCompanyValue(companyRawVal)) ? companyRawVal : undefined,
      quantity:   qty,
      totalValue: totalVal,
      customer:   (String(raw[rc.customer] || '').trim()) || undefined,
      customerInfoNorm: (() => {
        const v = String(raw[rc.customerInfo] || '').trim();
        return v ? normalizeArabic(v) : undefined;
      })(),
      date:       parseExcelDate(raw[rc.date]),
      rawData:    JSON.stringify(raw),
    };

    const result = ExcelRowSchema.safeParse(parsed);
    if (!result.success) {
      skippedRows.push({ row: i + 2, errors: result.error.flatten().fieldErrors, data: parsed });
      continue;
    }

    if (rowRecordType === 'return') {
      returnsRows.push(result.data);
    } else {
      salesRows.push(result.data);
    }
  }

  const validRows = [...salesRows, ...returnsRows];

  if (validRows.length === 0) {
    const actualHeaders = Object.keys(allRawEntries[0]?.raw || {});
    const firstBadRow = skippedRows[0];
    throw new AppError(
      `No valid rows found. All ${allRawEntries.length} rows failed validation.\n` +
      `Detected columns: [${actualHeaders.join(', ')}]\n` +
      `Mapped to: rep=${colMap.repName}, area=${colMap.area}, item=${colMap.item}, qty=${colMap.quantity}, value=${colMap.totalValue}\n` +
      `First row sample: ${JSON.stringify(firstBadRow?.data)}`,
      422,
      'ALL_ROWS_INVALID',
    );
  }

  // ── 3b–7. Shared finishing logic ─────────────────────────
  return _finishProcessing({ salesRows, returnsRows, skippedRows, file, uploadedBy, userId, fileType, sourceCurrency, sourceSystem: isMercatoFile ? 'mercato' : null, unclearCompanyItems: [...unclearCompanyItems], rawOriginalName, mergeIntoCumulative });
}

// ─── _finishProcessing ─────────────────────────────────────────────────────────
// Everything from fuzzy normalisation to bulk insert — shared by both the
// standard tabular path and the matrix (cross-tabular) path.
async function _finishProcessing({ salesRows, returnsRows, skippedRows, file, uploadedBy, userId, fileType, sourceCurrency, sourceSystem = null, unclearCompanyItems = [], rawOriginalName = false, mergeIntoCumulative = true }) {
  const fixOriginalName = (name) => rawOriginalName ? name : Buffer.from(name, 'latin1').toString('utf8');
  const validRows = [...salesRows, ...returnsRows];

  // ── 3b. Fuzzy-name normalisation ─────────────────────────────────────────────
  // Compare incoming names against existing DB names (same userId) so that minor
  // spelling variants across files get collapsed to a single canonical name.
  let normalizationLog = [];

  // Fetch the scientific companies the uploader belongs to (for catalog matching)
  let sciCompanyIds = [];
  if (userId) {
    const userCompanies = await prisma.userCompanyAssignment.findMany({
      where: { userId },
      select: { companyId: true },
    });
    sciCompanyIds = userCompanies.map(c => c.companyId);
  }

  if (userId) {
    const [existingCompanies] = await Promise.all([
      getAllCompanies(userId),
    ]);

    const incomingCompanies = [...new Set(validRows.map(r => r.company).filter(Boolean))];

    const companyDedup = buildNormalizationMap(incomingCompanies, existingCompanies.map(c => c.name), 'company');

    normalizationLog = [...companyDedup.log];

    if (normalizationLog.length > 0) {
      for (const row of validRows) {
        if (row.company && companyDedup.map[row.company]) row.company = companyDedup.map[row.company];
      }
      console.log(`[upload] Fuzzy normalizations (${normalizationLog.length}):`, normalizationLog);
    }
  }

  // ── 4. Resolve/create Areas, Items, Reps, Companies (de-duped) ─────────────
  // Normalize Arabic names before deduplication so الأعظمية/الاعظمية → same entry.
  const normalizeAr = s => String(s)
    .trim()
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (const row of validRows) {
    row.area    = normalizeAr(row.area);
    row.item    = normalizeAr(row.item);
    row.repName = normalizeAr(row.repName);
    if (row.customer) row.customer = normalizeAr(row.customer);
    if (row.company)  row.company  = normalizeAr(row.company);
  }

  // المحافظة تُكتب على Area لا على Sale — تُشتق لاحقاً عبر Area.provinceId
  const areaProvinceMap = await buildAreaProvinceMap(validRows);
  const uniqueAreas     = [...new Set(validRows.map(r => r.area))];
  const uniqueItems     = [...new Set(validRows.map(r => r.item))];
  const uniqueReps      = [...new Set(validRows.map(r => r.repName))];
  const uniqueCustomers = [...new Set(validRows.map(r => r.customer).filter(Boolean))];
  const uniqueCompanies = [...new Set(validRows.map(r => r.company).filter(Boolean))];

  // نحمّل سياق التوحيد (كتالوج الشركة + ايتمات المستخدم + aliases) مرة واحدة ونمرّره
  // لكل استدعاء findOrCreateItem بدل تحميله لكل اسم (يمنع استعلامات متكرّرة).
  const itemCtx = sciCompanyIds.length > 0
    ? await loadResolutionContext({ scientificCompanyIds: sciCompanyIds, userId })
    : null;

  const [areaMap, itemMap, repMap, customerMap, companyMap] = await Promise.all([
    resolveEntities(uniqueAreas,     name => findOrCreateArea(name, userId, areaProvinceMap[name] ?? null)),
    resolveEntities(uniqueItems,     name => findOrCreateItem(name, userId, sciCompanyIds, itemCtx)),
    resolveEntities(uniqueReps,      name => findOrCreateRep(name, userId)),
    resolveEntities(uniqueCustomers, name => findOrCreateCustomer(name, userId)),
    resolveEntities(uniqueCompanies, name => findOrCreateCompany(name, userId)),
  ]);

  // المستخدمون المعيَّنون على المحافظات الواردة في هذا الملف قد تكون دخلت
  // نطاقَهم مناطقُ جديدة للتو. فلترتهم وقت الاستعلام تلتقط ذلك تلقائياً، لكن
  // اللقطات المشتقة (ScientificRepArea/Commercial) لا — فنعيد بناءها.
  // غير حابس: فشلُه لا يُفشل الرفع.
  const touchedProvinceIds = [...new Set(Object.values(areaProvinceMap))];
  if (touchedProvinceIds.length > 0) {
    try {
      const uids = await userIdsAssignedToProvinces(touchedProvinceIds);
      for (const uid of uids) {
        await syncUserAreaDerivedLinks(uid).catch(() => {});
      }
    } catch (e) {
      console.warn('[upload] province re-sync failed (non-fatal):', e.message);
    }
  }

  // Track which items are temporary (not in any company catalog)
  const tempItemNames = [];
  if (sciCompanyIds.length > 0) {
    const resolvedItemIds = Object.values(itemMap).filter(Boolean);
    const tempItems = await prisma.item.findMany({
      where: { id: { in: resolvedItemIds }, isTemp: true },
      select: { name: true },
    });
    tempItemNames.push(...tempItems.map(i => i.name));
  }

  // Link each item to its company (from the first row that maps item → company)
  if (uniqueCompanies.length > 0) {
    const itemCompanyMap = {}; // itemName → companyName
    for (const row of validRows) {
      if (row.company && row.item && !itemCompanyMap[row.item]) {
        itemCompanyMap[row.item] = row.company;
      }
    }
    await Promise.all(
      Object.entries(itemCompanyMap).map(([itemName, companyName]) => {
        const itemId    = itemMap[itemName];
        const companyId = companyMap[companyName];
        if (itemId && companyId) {
          return prisma.item.updateMany({ where: { id: itemId, companyId: null }, data: { companyId } });
        }
      }).filter(Boolean)
    );
  }

  // ── Determine currency: user-specified takes priority over auto-detection ──
  let detectedCurrency;
  if (sourceCurrency === 'IQD' || sourceCurrency === 'USD') {
    detectedCurrency = sourceCurrency;
  } else {
    const CURRENCY_THRESHOLD = 100000;
    const nonZeroValues = validRows.map(r => r.totalValue || 0).filter(v => v > 0).sort((a, b) => a - b);
    const median = nonZeroValues.length > 0
      ? nonZeroValues[Math.floor(nonZeroValues.length / 2)]
      : 0;
    detectedCurrency = median >= CURRENCY_THRESHOLD ? 'IQD' : 'USD';
  }

  // ── 5. Record the file upload ────────────────────────────
  const originalName = fixOriginalName(file.originalname);
  const storedFileType = fileType === 'auto'
    ? (salesRows.length > 0 && returnsRows.length > 0 ? 'auto' : returnsRows.length > 0 ? 'returns' : 'sales')
    : (fileType === 'matrix' ? 'sales' : fileType);

  // ── Save original file to disk so we can serve it later ──
  ensureExcelUploadsDir();
  const safeOriginalName = originalName.replace(/[^a-zA-Z0-9\u0600-\u06FF._-]/g, '_');
  const savedFilename = `${Date.now()}_${safeOriginalName}`;
  const savedFilePath = path.join(EXCEL_UPLOADS_DIR, savedFilename);
  try {
    // كان يشير إلى fileBuffer غير الموجود في هذا النطاق، فترمي ReferenceError
    // ويبتلعها catch — فلم يُحفَظ أي ملف أصلي على القرص منذ ذلك الحين، وصار
    // «تحميل الملف الأصلي» يرجّع 404. نشتقّ البايتات هنا كما في بقية المسارات.
    const originalBytes = file.buffer || (file.path ? readFileSync(file.path) : null);
    if (!originalBytes) throw new Error('لا توجد بايتات للملف (لا buffer ولا path)');
    writeFileSync(savedFilePath, originalBytes);
  } catch (e) {
    console.warn('[upload] could not save original file to disk:', e.message);
  }

  // ── 6. صفوف الإدراج (بلا وجهة بعد — تُحدَّد أدناه) ────────
  // saleDate يبقى null حين لا يحمل الإكسل تاريخاً: مسار الملف المستقل يحوّله
  // إلى undefined فيأخذ @default(now()) كما كان دائماً، بينما المسار التراكمي
  // يكتب UNDATED_SENTINEL صراحةً (راجع salesMonths.js).
  const buildInsert = (rows) => rows.map(r => ({
    representativeId: repMap[r.repName],
    areaId:           areaMap[r.area],
    itemId:           itemMap[r.item],
    customerId:       r.customer ? (customerMap[r.customer] ?? null) : null,
    quantity:         r.quantity,
    totalValue:       r.totalValue,
    saleDate:         r.date ?? null,
    rawData:          r.rawData ?? null,
    customerInfoNorm: r.customerInfoNorm ?? null,
  }));

  // ── 6b. الوجهة: ملف تراكمي (الافتراضي) أم ملف مستقل؟ ────
  // التراكم هو السلوك الافتراضي: رفعة شهر 10 تنصهر داخل نفس الملف الذي يحمل
  // شهر 9، والصفوف التي سبق إدخالها تُسقَط بقيد (uploadedFileId, dedupKey)
  // الفريد — فإعادة رفع الملف نفسه مرتين لا تُضاعف شيئاً. المستخدم يستطيع
  // إيقافه لرفعة بعينها (standalone=1) حين يريد ملفاً معزولاً يسهل حذفه.
  const wantsMerge = mergeIntoCumulative && userId != null && isMergeableType(storedFileType);
  let uploadedFile;
  let mergeInfo = null;

  if (wantsMerge) {
    const { file: target, created } = await resolveCumulativeTarget({ userId, sourceSystem, detectedCurrency });
    const batch = await openMergeBatch({
      fileId:         target.id,
      originalName,
      uploadedBy:     uploadedBy || null,
      fileType:       storedFileType,
      storedFilename: savedFilename,
    });
    const { added, skipped, monthsLabel } = await appendRowsToCumulative({
      fileId:     target.id,
      batchId:    batch.id,
      saleRows:   buildInsert(salesRows),
      returnRows: buildInsert(returnsRows),
      userId,
    });
    await closeMergeBatch(batch.id, { rowsAdded: added, rowsSkipped: skipped, monthsLabel });
    uploadedFile = await refreshCumulativeFile(target.id);
    mergeInfo = {
      merged:      true,
      createdFile: created,
      batchId:     batch.id,
      added,
      skipped,
      monthsLabel,
      fileName:    uploadedFile.originalName,
      totalRows:   uploadedFile.rowCount,
    };
    console.log(`[upload] merged into cumulative #${target.id}: +${added} صف، ${skipped} مكرر مُسقط (${monthsLabel})`);
  } else {
    uploadedFile = await createUploadedFile({
      filename:         savedFilename,
      originalName:     originalName,
      rowCount:         validRows.length,
      uploadedBy:       uploadedBy || null,
      userId,
      fileType:         storedFileType,
      sourceSystem,
      detectedCurrency: detectedCurrency,
      currencyMode:     detectedCurrency,
    });

    if (salesRows.length > 0) {
      await bulkCreateSales(buildInsert(salesRows), uploadedFile.id, userId, 'sale');
    }
    if (returnsRows.length > 0) {
      await bulkCreateSales(buildInsert(returnsRows), uploadedFile.id, userId, 'return');
    }
  }

  // ── 7. Auto-assign areas & items to each rep ────────────
  const repAreaPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${areaMap[r.area]}`, { representativeId: repMap[r.repName], areaId: areaMap[r.area] }])
  ).values()];

  const repItemPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${itemMap[r.item]}`, { representativeId: repMap[r.repName], itemId: itemMap[r.item] }])
  ).values()];

  await Promise.all([
    repAreaPairs.length > 0
      ? prisma.representativeArea.createMany({ data: repAreaPairs, skipDuplicates: true })
      : Promise.resolve(),
    repItemPairs.length > 0
      ? prisma.representativeItem.createMany({ data: repItemPairs, skipDuplicates: true })
      : Promise.resolve(),
  ]);

  return {
    rowCount:       validRows.length,
    salesCount:     salesRows.length,
    returnsCount:   returnsRows.length,
    skipped:        skippedRows,
    normalizations: normalizationLog,
    unknownItems:   tempItemNames,
    unclearCompanyItems,
    uploadedFile: {
      id:           uploadedFile.id,
      originalName: uploadedFile.originalName,
      uploadedAt:   uploadedFile.uploadedAt,
      sourceSystem: uploadedFile.sourceSystem ?? null,
      isCumulative: uploadedFile.isCumulative ?? false,
    },
    // تفاصيل الانصهار — الواجهة تعرض منها «أُضيف X صف، أُسقط Y مكرر».
    merge: mergeInfo,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Returns true if a sheet name strongly suggests it contains returns/refunds.
 * Matches common Arabic & English naming conventions used in Iraqi pharma Excel files.
 */
function isReturnSheet(sheetName) {
  const s = String(sheetName).trim();
  return /ارجاع|ارجاعات|الارجاع|الارجاعات|اراجيع|رجيع|مرتجع|مرتجعات|المرتجع|المرتجعات|return|returns|refund|refunds|credit note|credit|debit note/i
    .test(s);
}

/**
 * Returns true if a sheet name indicates it contains sales data.
 */
function isSalesSheet(sheetName) {
  const s = String(sheetName).trim();
  return /مبيع|مبيعات|المبيع|المبيعات|sale|sales/i.test(s);
}

/**
 * Returns true if a sheet name is Excel's untouched default ("Sheet1", "ورقة1"…)
 * rather than something the file's author actually renamed to a region/area name.
 */
function isGenericSheetName(sheetName) {
  const s = String(sheetName).trim();
  return /^(sheet|ورقة|ورقه|صفحة|صفحه)\s*\d*$/i.test(s);
}

/**
 * Robustly parse a numeric value coming from Excel.
 * Handles: Arabic numerals, comma-thousands separators, spaces, currency symbols.
 */
export function parseNumeric(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const str = String(val)
    // Convert Arabic-Indic numerals (٠-٩) → ASCII
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    // Remove thousands separators (comma or Arabic comma ،)
    .replace(/[,،]/g, '')
    // Remove currency symbols and spaces
    .replace(/[^\d.\-]/g, '')
    .trim();
  const n = parseFloat(str);
  return isFinite(n) ? n : 0;
}

/**
 * Parse a date value from an Excel cell.
 * XLSX with cellDates:true returns JS Date objects for date cells.
 * Also handles string dates in common formats.
 * Returns undefined if unparseable.
 */
export function parseExcelDate(val) {
  if (!val) return undefined;
  if (val instanceof Date && isFinite(val.getTime())) return val;
  if (typeof val === 'number') {
    // Excel serial date number (days since 1900-01-01)
    const date = XLSX.SSF.parse_date_code(val);
    if (date) return new Date(Date.UTC(date.y, date.m - 1, date.d));
    return undefined;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return undefined;
    // Try common formats: dd/mm/yyyy, mm/dd/yyyy, yyyy-mm-dd
    const parts = s.match(/^(\d{1,4})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (parts) {
      const [, a, b, c] = parts;
      // If first part > 31, it's yyyy-mm-dd
      if (Number(a) > 31) {
        const d = new Date(`${a}-${String(b).padStart(2,'0')}-${String(c).padStart(2,'0')}`);
        return isFinite(d.getTime()) ? d : undefined;
      }
      // Otherwise assume dd/mm/yyyy (Iraqi default)
      const d = new Date(`${c}-${String(b).padStart(2,'0')}-${String(a).padStart(2,'0')}`);
      return isFinite(d.getTime()) ? d : undefined;
    }
    const d = new Date(s);
    return isFinite(d.getTime()) ? d : undefined;
  }
  return undefined;
}

/**
 * Headers that should NEVER be used as item/rep/area/etc. — status & notes columns.
 * If a header contains any of these patterns, it is excluded from partial matching.
 */
const EXCLUDED_HEADER_PATTERNS = [
  'حالة', 'ملاحظة', 'ملاحظات', 'رقم', 'كود', 'كود', 'رمز',
  'status', 'note', 'notes', 'remark', 'remarks', 'code', 'no.',
  'id', '#', 'serial', 'تسلسل', 'مسلسل',
];

/**
 * Returns true if this header looks like a status/notes/ID column that
 * should NOT be used as a data field via partial matching.
 */
function isExcludedHeader(header) {
  const lower = header.toLowerCase().trim();
  return EXCLUDED_HEADER_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

// ─── Matrix (Cross-tabular Pivot) Format ─────────────────────────────────────

/**
 * Column header patterns that indicate an "item info" column (not a pharmacy column).
 * Used by parseMatrixSheet to distinguish item-info columns from pharmacy-data columns.
 */
const ITEM_INFO_HEADER_PATTERNS = [
  // Item code / ID
  'item code', 'product code', 'drug code', 'code', 'sku', 'barcode',
  'كود الصنف', 'كود', 'رمز الصنف', 'رمز', 'رقم الصنف',
  // Item name
  'item name', 'item', 'product name', 'product', 'drug name', 'drug',
  'medicine name', 'medicine', 'brand name', 'brand',
  'اسم الصنف', 'اسم المادة', 'اسم الدواء', 'اسم المنتج',
  'صنف', 'مادة', 'دواء', 'منتج',
  // Price
  'unit price', 'price', 'cost', 'rate',
  'سعر الوحدة', 'سعر الوحده', 'سعر', 'السعر', 'الثمن', 'ثمن', 'التكلفة', 'تكلفة',
  // Currency
  'currency', 'عملة', 'العملة',
];

/**
 * Returns true if a header cell value matches known item-info column patterns.
 * Used to distinguish fixed item-info columns (code / name / price) from
 * dynamic pharmacy-quantity columns in a cross-tabular Excel matrix.
 */
function isItemInfoHeader(val) {
  const lower = String(val).toLowerCase().trim();
  return ITEM_INFO_HEADER_PATTERNS.some(p => lower === p || lower.includes(p));
}

/**
 * Returns true if a header cell looks like a grand-total / subtotal column.
 * Such columns must be excluded from the pharmacy-column map so their values
 * are never recorded as sales to a specific warehouse/pharmacy.
 */
function isTotalHeader(val) {
  const lower = String(val).toLowerCase().trim();
  return /مجموع|اجمالي|إجمالي|الاجمالي|الإجمالي|مجموع كلي|الكلي|grand.?total|total.?iraq|total.?all|sub.?total|subtotal|overall|sum/.test(lower);
}

/**
 * Try to extract a company name from an item code.
 * Example: "ALBALSAMIRAQIN/A"  →  "ALBALSAMIRAQIN"
 *          "DevaTurkeyN/A"     →  "DevaTurkey"
 * Returns empty string if no company can be inferred.
 */
function extractCompanyFromCode(code) {
  if (!code || isPlaceholderCompanyValue(code)) return '';
  // Take the leading alphabetic sequence before / - N _ or digit
  const match = String(code).match(/^([A-Za-z\u0600-\u06FF]+)/);
  const result = match ? match[1].trim() : '';
  return isPlaceholderCompanyValue(result) ? '' : result;
}

/**
 * Parse a cross-tabular (matrix / pivot) Excel sheet where:
 *
 *   Row 0  — Region names, typically in merged cells that each span several
 *             pharmacy columns.  Columns A-C (or however many item-info cols
 *             there are) are blank or have a fixed label in this row.
 *   Row 1  — Pharmacy / warehouse names.  The first few columns hold labels
 *             like "Item code", "Item", "Price".
 *   Row 2+ — Data rows: col 0 = item code, col 1 = item name, col 2 = price,
 *             remaining cols = quantity sold at each pharmacy.
 *
 * Returns an array of flat sale-record objects ready for entity resolution.
 */
function parseMatrixSheet(ws) {
  const ref = ws['!ref'];
  if (!ref) return [];

  const range  = XLSX.utils.decode_range(ref);
  const merges = ws['!merges'] || [];

  // Helper: read the raw value of a cell (r=row, c=col, both absolute 0-based)
  const cellVal = (r, c) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = ws[addr];
    return cell !== undefined ? cell.v : '';
  };

  // ── Step 1: Build colRegionMap using merge ranges in row 0 ──────────────────
  // merged cell in row 0 → all its columns share the same region name
  const colRegionMap = {}; // absolute col index → region name string

  for (const merge of merges) {
    if (merge.s.r !== range.s.r) continue; // only row-0 merges
    const addr = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const cell = ws[addr];
    const regionName = cell ? String(cell.v || '').trim() : '';
    if (!regionName) continue;
    if (isTotalHeader(regionName)) continue; // skip total/sum merged headers
    for (let c = merge.s.c; c <= merge.e.c; c++) {
      colRegionMap[c] = regionName;
    }
  }

  // Also pick up unmerged single-cell region names in row 0 that are not item-info
  for (let c = range.s.c; c <= range.e.c; c++) {
    if (colRegionMap[c]) continue; // already set by a merge
    const val = String(cellVal(range.s.r, c) || '').trim();
    if (val && !isItemInfoHeader(val) && !isTotalHeader(val)) {
      colRegionMap[c] = val;
    }
  }

  // ── Step 2: Scan row 1 to identify item-info cols vs pharmacy cols ──────────
  const colPharmacyMap  = {}; // absolute col index → pharmacy name
  const itemInfoColsAbs = new Set();

  for (let c = range.s.c; c <= range.e.c; c++) {
    const val = String(cellVal(range.s.r + 1, c) || '').trim();
    if (!val) continue;

    if (isItemInfoHeader(val)) {
      itemInfoColsAbs.add(c);
    } else if (isTotalHeader(val)) {
      // Skip total/sum columns entirely — they are not pharmacies
    } else if (colRegionMap[c]) {
      // Has a region → pharmacy column
      colPharmacyMap[c] = val;
    }
  }

  // ── Step 3: Identify roles within item-info columns ────────────────────────
  let itemCodeCol = -1;
  let itemNameCol = -1;
  let priceCol    = -1;

  for (const c of itemInfoColsAbs) {
    const val = String(cellVal(range.s.r + 1, c) || '').trim().toLowerCase();
    if (val.match(/code|كود|رمز|رقم/)) {
      itemCodeCol = c;
    } else if (val.match(/price|سعر|ثمن|تكلفة|cost/)) {
      priceCol = c;
    } else if (val.match(/item|name|صنف|دواء|مادة|منتج|اسم/)) {
      itemNameCol = c;
    }
  }

  // Positional fallback: first 3 item-info cols → code, name, price
  if (itemCodeCol === -1 || itemNameCol === -1 || priceCol === -1) {
    const sorted = [...itemInfoColsAbs].sort((a, b) => a - b);
    if (itemCodeCol === -1 && sorted.length >= 1) itemCodeCol = sorted[0];
    if (itemNameCol === -1 && sorted.length >= 2) itemNameCol = sorted[1];
    if (priceCol    === -1 && sorted.length >= 3) priceCol    = sorted[2];
  }

  // Last-resort fallback: if NO item-info cols were detected at all,
  // assume first 3 absolute columns are code / name / price
  if (itemInfoColsAbs.size === 0) {
    itemCodeCol = range.s.c;
    itemNameCol = range.s.c + 1;
    priceCol    = range.s.c + 2;
  }

  // ── Step 4: Parse data rows (row 2 onwards) ────────────────────────────────
  const flatRows = [];

  for (let r = range.s.r + 2; r <= range.e.r; r++) {
    const itemName = itemNameCol >= 0 ? String(cellVal(r, itemNameCol) || '').trim() : '';
    if (!itemName) continue; // skip blank rows
    if (isTotalHeader(itemName)) continue; // skip grand-total / subtotal rows

    const itemCode = itemCodeCol >= 0 ? String(cellVal(r, itemCodeCol) || '').trim() : '';
    const price    = priceCol    >= 0 ? parseNumeric(cellVal(r, priceCol)) : 0;

    // Build a raw-row snapshot for audit logging
    const rawRow = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = cellVal(r, c);
      if (v !== '' && v !== undefined) rawRow[c] = v;
    }

    // Iterate all pharmacy columns for this item row
    for (const [colStr, pharmacyName] of Object.entries(colPharmacyMap)) {
      const c   = parseInt(colStr, 10);
      const qty = parseNumeric(cellVal(r, c));
      if (qty <= 0) continue; // no sale at this pharmacy

      const regionName = colRegionMap[c] || 'غير محدد';
      const totalVal   = price > 0 ? qty * price : qty;

      flatRows.push({
        repName:    'غير محدد',
        area:       regionName,
        item:       itemName,
        company:    extractCompanyFromCode(itemCode) || undefined,
        quantity:   qty,
        totalValue: totalVal,
        customer:   pharmacyName,
        date:       undefined,
        rawData:    JSON.stringify(rawRow),
      });
    }
  }

  console.log(`[matrix] Parsed ${flatRows.length} sale records from matrix sheet.`,
    `Regions: [${[...new Set(Object.values(colRegionMap))].join(', ')}]`,
    `Pharmacies: ${Object.keys(colPharmacyMap).length}`,
  );

  return flatRows;
}

// ─── ميركاتو: ملفات تطبيق الطلبيات عبر المذاخر العامة ────────────────────────
// نوعا ملفات المبيعات مختلفان جوهرياً:
//   • ملف سستم المكتب العلمي — طلبيات مباشرة من المكتب/الشركة بلا مذاخر،
//     و«اسم المندوب» فيه مندوب تجاري.
//   • ملف ميركاتو — المندوب العلمي يرسل الطلبية إلى مذخر عام يجهّزها، و«اسم
//     المندوب» فيه هو المندوب العلمي نفسه.
//
// ولملف ميركاتو معانٍ مختلفة لنفس الترويسات، فالمطابقة العامة تُخطئ فيه ثلاث
// مرات (تحقّق فعلي على ملف إنتاج):
//   «الصنف» → يُقرأ كمادة فتصير كل الأدوية باسم الشركة (Deva…)
//   «اسم الشركة» → يُقرأ كشركة وهو في الحقيقة اسم الصيدلية
//   «اسم المذخر» → يُقرأ كزبون وهو المذخر المجهِّز لا المشتري
// لذلك نكتشفه بتوقيع أعمدته ونفرض عليه خريطة صريحة.
const _mNorm = s => String(s ?? '').toLowerCase().trim()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/ـ/g, '').replace(/[ً-ٟ]/g, '').replace(/\s+/g, ' ');
/** هل تحتوي الترويسة كل هذه الأجزاء (بعد التطبيع)؟ */
const _mHas = (header, ...parts) => {
  const h = _mNorm(header);
  return parts.every(p => h.includes(_mNorm(p)));
};

/**
 * توقيع ملف ميركاتو: عمود «اسم المذخر» + (عمود «رقم طلبية المذخر» أو عمود
 * «اسم المادة بالمكتب») معاً. وجود «اسم المذخر» وحده لا يكفي — فهو alias زبون
 * في ملفات أخرى.
 *
 * بعض تصديرات ميركاتو (مثل تقرير بلا عمود رقم طلبية) لا تحمل «رقم طلبية
 * المذخر» فكانت تفلت من الاكتشاف فتُقرأ بالمطابقة العامة، التي تُخطئ حصراً في
 * حقل الايتم: exact-match tier في resolveColumns تلتقط «الصنف» (alias صريح
 * في قائمة الايتم) قبل الوصول لـ partial-match الذي كان سيفضّل «اسم المادة
 * بالمكتب» — فتتحوّل أسماء الشركات (Deva/ALBALSAM…) لايتمات جديدة في طابور
 * المراجعة. «اسم المادة بالمكتب» توقيع فريد بما يكفي (عبارة "بالمكتب" غير
 * موجودة في أي ترويسة أخرى بالتطبيق) فنعتمده كبديل لعمود رقم الطلبية.
 */
export function detectMercatoFormat(headers) {
  const hasWarehouse     = headers.some(h => _mHas(h, 'اسم', 'مذخر'));
  const hasOrderNum      = headers.some(h => _mHas(h, 'رقم', 'طلبيه', 'مذخر'));
  const hasOfficeItemCol = headers.some(h => _mHas(h, 'ماده', 'بالمكتب'));
  return hasWarehouse && (hasOrderNum || hasOfficeItemCol);
}

/**
 * خريطة أعمدة ميركاتو الصريحة. تُرجع الحقول التي عُثر عليها فقط، فما لم يُعثر
 * عليه يبقى على نتيجة المطابقة العامة.
 */
export function mercatoColumnMap(headers) {
  const pick = pred => headers.find(pred);
  const map = {};
  const set = (field, col) => { if (col) map[field] = col; };

  set('repName',    pick(h => _mHas(h, 'مندوب')));
  set('area',       pick(h => _mHas(h, 'منطق')));
  set('province',   pick(h => _mHas(h, 'مدين')));
  // «اسم المادة بالمكتب» — نستبعد «حالة المادة بطلبية المذخر» (تحوي «المادة» أيضاً)
  set('item',       pick(h => _mHas(h, 'ماده') && !_mHas(h, 'حال') && !_mHas(h, 'رقم')));
  // «الصنف» في ميركاتو = الشركة المصنّعة (Deva / HUMANIS)
  set('company',    pick(h => ['الصنف', 'صنف'].includes(_mNorm(h))));
  // «اسم الشركة» في ميركاتو = الصيدلية المشترية (الزبون)
  set('customer',   pick(h => _mHas(h, 'شرك') && !_mHas(h, 'مذخر')));
  set('quantity',   pick(h => _mHas(h, 'كميه') && !_mHas(h, 'بونص')));
  set('unitPrice',  pick(h => ['السعر', 'سعر'].includes(_mNorm(h))));
  set('totalValue', pick(h => _mHas(h, 'مجموع')));
  set('date',       pick(h => _mHas(h, 'بتاريخ') || ['التاريخ', 'تاريخ'].includes(_mNorm(h))));
  // الحقول التالية لا تُقرأ في مسار المبيعات العادي (لا حقل يطلبها) — أُضيفت
  // خصيصاً لرصيد المذاخر (stock-ledger.service.js) الذي يحتاج حالة الطلبية/المادة
  // لتقرير هل الصف مبيع فعلي يُخصم من الستوك، ورقم الطلبية لمنع تكرار احتسابها
  // عند إعادة رفع نفس الملف. لا تأثير على هذا المسار.
  set('orderNumber', pick(h => _mHas(h, 'رقم', 'طلبيه', 'مذخر'))); // نفس معيار hasOrderNum في detectMercatoFormat
  set('orderStatus', pick(h => _mHas(h, 'حاله', 'طلبيه') && !_mHas(h, 'ماده'))); // «حالة طلبية المذخر» — تُستبعد «حالة المادة بطلبية المذخر»
  set('itemStatus',  pick(h => _mHas(h, 'حاله', 'ماده'))); // «حالة المادة بطلبية المذخر»
  set('bonusQty',    pick(h => _mHas(h, 'كميه') && _mHas(h, 'بونص'))); // «كمية البونص»
  return map;
}

/**
 * Resolve column headers from the Excel file against known aliases.
 * @param {string[]} headers   - Actual Excel column headers
 * @param {object}   overrides - Manual overrides from request
 */
// أعضاء قائمة الايتم المذكورون في تعليق COLUMN_ALIASES.item أعلاه كـ"احتياط أخير
// للملفات التي لا تحمل غيرهم" — لكن مرحلتي المطابقة أدناه (تام ثم جزئي) كانتا
// مستقلتين، فعمود اسمه حرفياً "الصنف" كان يفوز بالمطابقة التامة قبل أن تصل
// الدالة أصلاً لمرحلة المطابقة الجزئية التي كانت ستُفضّل "اسم المادة" — فتتحوّل
// أسماء الشركات في ملفات كهذه لايتمات جديدة في طابور المراجعة. حل: هذه الأسماء
// تُستبعد من كل المراحل ولا تُجرَّب إلا إن فشلت بقية القائمة تماماً (تام وجزئي).
// «اسم الصنف» أيضاً — نفس الالتباس، وبلا استبعاده كانت مطابقة "يحوي" العكسية
// (alias.includes(header)) تجعل عموداً اسمه حرفياً "الصنف" وحده يطابق alias
// "اسم الصنف" (لأنها تحويه) فيتسلل نفس الخطأ من باب خلفي رغم استبعاد "الصنف" أعلاه.
const AMBIGUOUS_ALIASES = {
  item: new Set(['صنف', 'الصنف', 'اسم الصنف']),
};

export function resolveColumns(headers, overrides) {
  const result = {};
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());

  const resolveField = (aliasList) => {
    // 1. Exact alias match (no exclusions — if user named it exactly, use it)
    const exactMatch = aliasList.find(alias =>
      lowerHeaders.includes(alias.toLowerCase())
    );
    if (exactMatch) return headers[lowerHeaders.indexOf(exactMatch.toLowerCase())];
    // 2. Partial / contains match — skip headers that look like status/notes/ID columns
    const partialIdx = lowerHeaders.findIndex((h, idx) => {
      if (isExcludedHeader(headers[idx])) return false; // skip status/notes columns
      return aliasList.some(alias => h.includes(alias.toLowerCase()) || alias.toLowerCase().includes(h));
    });
    return partialIdx !== -1 ? headers[partialIdx] : null;
  };

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // 1. Manual override takes priority
    if (overrides[field] && headers.includes(overrides[field])) {
      result[field] = overrides[field];
      continue;
    }
    const ambiguous = AMBIGUOUS_ALIASES[field];
    const specificAliases = ambiguous ? aliases.filter(a => !ambiguous.has(a)) : aliases;
    // 2-3. Try every non-ambiguous alias first (exact, then partial); only if
    // none of them match anything do we fall back to the ambiguous ones.
    result[field] = resolveField(specificAliases)
      ?? (ambiguous ? resolveField(aliases) : null)
      // 4. Final fallback: use the field name itself (may be undefined in the row)
      ?? field;
  }
  return result;
}

/**
 * Count how many known fields a candidate header row resolves to an ACTUAL
 * column (not the resolveColumns() fallback, which just returns the field name).
 * Higher score = more likely to be the real header row.
 */
function scoreHeaderRow(cells, overrides) {
  const cm = resolveColumns(cells, overrides);
  let score = 0;
  for (const [field, col] of Object.entries(cm)) {
    if (col && col !== field && cells.includes(col)) score++;
  }
  return score;
}

/**
 * Find the real header row in a worksheet.
 *
 * Many exported reports start with title/metadata rows (e.g. a
 * "From :01/07/2026 To :31/07/2026" banner, a "الكل" filter line) BEFORE the
 * actual column headers. sheet_to_json() treats the very first row as headers,
 * so those files parse as __EMPTY / __EMPTY_1 columns and every row fails.
 *
 * We scan the first rows as arrays, score each as a potential header row via the
 * column aliases, and return the 0-indexed sheet row with the best score. When no
 * row scores high enough we fall back to the sheet's first row (legacy behavior),
 * so normal files (headers on row 0) are unaffected.
 *
 * @returns {number} absolute sheet row index to pass as sheet_to_json `range`
 */
export function detectHeaderRow(ws, overrides = {}) {
  if (!ws || !ws['!ref']) return 0;
  let range;
  try { range = XLSX.utils.decode_range(ws['!ref']); } catch { return 0; }
  const startRow = range.s.r;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
  const LOOK = Math.min(aoa.length, 25); // real headers appear near the top
  const MIN_SCORE = 3;                   // need at least this many matched fields to trust detection

  let bestIdx = 0, bestScore = -1;
  for (let i = 0; i < LOOK; i++) {
    const cells = (aoa[i] || []).map(c => String(c ?? '').trim()).filter(Boolean);
    if (cells.length < 3) continue;      // header rows span several columns
    const score = scoreHeaderRow(cells, overrides);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  if (bestScore < MIN_SCORE) return startRow; // not confident → first row (legacy)
  return startRow + bestIdx;
}

/**
 * Resolve a list of entity names to their DB IDs, creating missing ones.
 * Returns a { name → id } map.
 * @param {string[]} names
 * @param {Function} upsertFn
 */
/**
 * خريطة: اسم المنطقة ← معرّف المحافظة، مبنية من صفوف الملف.
 *
 * تصويت بالأغلبية لأن نفس المنطقة قد ترد بمحافظات مختلفة داخل الملف الواحد
 * (خطأ إدخال، أو اسم منطقة متكرر بين محافظتين). نأخذ الأكثر تكراراً بدل أول
 * صف يصادفنا، فلا يقرّر صفٌّ شاذّ محافظةَ المنطقة كلها.
 *
 * @returns {Promise<Record<string, number>>} فارغة إن لم يحمل الملف عمود محافظة
 */
async function buildAreaProvinceMap(validRows) {
  const withProvince = validRows.filter(r => r.province);
  if (withProvince.length === 0) return {};

  const provinces = await prisma.province.findMany();
  if (provinces.length === 0) return {};
  const lookup = buildProvinceLookup(provinces);

  const votes = new Map(); // areaName -> Map(provinceId -> count)
  const unmatched = new Set();
  for (const r of withProvince) {
    const p = matchProvinceName(r.province, lookup);
    if (!p) { unmatched.add(r.province); continue; }
    if (!votes.has(r.area)) votes.set(r.area, new Map());
    const m = votes.get(r.area);
    m.set(p.id, (m.get(p.id) || 0) + 1);
  }

  if (unmatched.size > 0) {
    console.warn('[upload] محافظات غير معروفة (تُتجاهل):', [...unmatched].join(', '));
  }

  const out = {};
  for (const [areaName, m] of votes) {
    let bestId = null, bestCount = -1;
    for (const [pid, count] of m) if (count > bestCount) { bestId = pid; bestCount = count; }
    if (bestId != null) out[areaName] = bestId;
  }
  return out;
}

// Runs `fn` over `items` with at most `limit` in flight at once — unbounded
// Promise.all over hundreds of unique names (one Postgres round-trip each)
// starves the connection pool (connection_limit=3 on the small VPS) and
// times out with "Timed out fetching a new connection from the pool".
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function resolveEntities(names, upsertFn) {
  const entries = await mapWithConcurrency(names, 3, async name => [name, (await upsertFn(name)).id]);
  return Object.fromEntries(entries);
}

/**
 * Find or create a MedicalRepresentative by name.
 * Auto-creates a placeholder rep if none exists.
 */
async function findOrCreateRep(name, userId) {
  const existing = await findRepByName(name, userId);
  if (existing) return existing;
  return prisma.medicalRepresentative.create({ data: { name, userId } });
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual / invoice-image sales entry
// Sales that come as warehouse (مذخر) invoices and never appear in the uploaded
// Excel files. Two entry paths (image → AI extract, or manual typing) both end
// up as reviewed flat rows that get persisted as Sale records — either merged
// into an existing UploadedFile or into a new one — reusing the same entity
// resolution + auto-assign logic as the Excel upload (without touching
// _finishProcessing).
// ═══════════════════════════════════════════════════════════════════════════

export const INVOICE_PROMPT = `أنت خبير في قراءة فواتير مذاخر الأدوية العراقية واستخراج بياناتها.
الصورة المرفقة فاتورة بيع من مذخر أدوية (البائع) إلى صيدلية/زبون (المشتري). نماذج الفواتير تختلف
من مذخر لآخر (ترتيب الأعمدة، المسميات، وقد يكون الخط مطبوعاً أو يدوياً) — افهم *معنى* الحقول لا مواضعها.

استخرج التالي:
• من ترويسة الفاتورة (تنطبق على كل أصناف هذه الفاتورة): اسم المذخر (البائع، غالباً بأعلى الفاتورة مع الشعار)،
  رقم الفاتورة، التاريخ، اسم الصيدلية/الزبون المشتري، ومنطقة الصيدلية.
• لكل صنف (سطر) في جدول الفاتورة: اسم المادة/الدواء، الشركة المصنّعة، الكمية،
  سعر الوحدة (الإفرادي/المفرد)، السعر الكلي للسطر، والبونص = الكمية المجانية. **افحص رؤوس أعمدة الجدول كلها:**
  إن وُجد عمود اسمه «كمية مجانية» أو «مجاني» أو «البونص» أو «بونص» أو «هدية» أو «free» أو «bonus» فقيمته في كل سطر هي bonus
  (لا تتركه 0 وفيه رقم).

أعِد **مصفوفة JSON فقط** (JSON array) — بلا أي نص أو شرح قبلها أو بعدها — كل عنصر يمثّل صنفاً واحداً
بهذا الشكل بالضبط:
[
  {
    "item": "اسم المادة كاملاً",
    "company": "الشركة المصنّعة أو null",
    "quantity": 10,
    "unitPrice": 9900,
    "total": 99000,
    "bonus": 0,
    "priceShown": true,
    "pharmacy": "اسم الصيدلية فقط",
    "warehouse": "اسم المذخر",
    "area": "منطقة الصيدلية أو null",
    "warehouseAddress": "عنوان المذخر المطبوع في ترويسته أو null",
    "date": "2026-08-19",
    "invoiceNumber": "22287",
    "box": [ymin, xmin, ymax, xmax],
    "box_customer": [ymin, xmin, ymax, xmax],
    "box_header": [ymin, xmin, ymax, xmax]
  }
]

قواعد صارمة:
- **مواضع المناطق (box):** لكل صنف أضف ثلاثة مستطيلات تحيط بـ**مناطق واسعة** في الصورة (تحديد المنطقة الأوسع أدقّ بكثير من الحقل المفرد الصغير):
  • "box" = **سطر هذا الصنف كاملاً** في جدول الفاتورة (من اسم المادة حتى آخر أسعاره).
  • "box_customer" = **كتلة الزبون كاملة** (اسم الصيدلية والمنطقة).
  • "box_header" = **كتلة ترويسة الفاتورة كاملة** التي تضمّ اسم المذخر ورقم الفاتورة والتاريخ معاً.
  كل مستطيل أربعة أعداد صحيحة **بمقياس 0 إلى 1000** بالترتيب [ymin, xmin, ymax, xmax] (y من الأعلى للأسفل، x من اليسار لليمين). اجعل المستطيل يحيط بالمنطقة/الكتلة **كاملةً بسخاء** (لا بحقل مفرد ضيّق). إن تعذّر تحديد موضعٍ اجعله null. تُستخدم لتكبير الصورة على كل منطقة عند المراجعة.
- **اسم المادة (item):** انسخه كاملاً كما هو مكتوب في الفاتورة بلا اختصار أو حذف (الاسم + التركيز + الشكل، مثل "DEVA … 457MG SYRUP").
- **اسم الصيدلية (pharmacy):** الاسم الفعلي فقط، بلا أي بادئة أو لقب قبله مثل: "ص"، "ص."، "صيدلية"، "الصيدلية"، "صيدليه"، "زبون"، "الزبون"، "عميل"، "العميل"، "اسم"، "الاسم"، "د"، "دكتور"، ولا عنوان الحقل الإنجليزي "Client name" أو "Customer" (في «Client name : صيدلية ‹اسم›» يكون pharmacy = ‹اسم› فقط)، وبلا المنطقة (انظر القاعدة التالية).
- **الصورة قد تكون مائلة أو مُدارة 90° أو مقلوبة** — اقرأ النص باتجاهه الصحيح.
- **أين تجد اسم الصيدلية:** يأتي عادةً بعد عنوان حقل مثل: «اسم الزبون»، «الزبون»، «السيد»، «السادة»، «حضرة»، «الاسم»، «الصيدلية»، «صيدلية»، «ص»، «العميل»، «اسم العميل»، «المشتري» (شكله: «السيد : صيدلية ‹اسم›/ ‹منطقة›» ⇒ pharmacy=‹اسم›، area=‹منطقة›) — وقد يُكتب **بلا أي عنوان**. العنوان نفسه ليس جزءاً من الاسم. احذر: «اسم المندوب»، «المندوب»، «الكاشير»، «المجهز»، «منظم الفاتورة»، «السائق» حقول أشخاص من طرف المذخر — **ليست** الصيدلية.
- **أين تجد المنطقة:** بعد عنوان مثل «المنطقة»، «منطقة»، «الزون»، «الموقع»، «المكان»، «المحلة»، «العنوان» — أو **بعد اسم الصيدلية مباشرةً** مفصولة بشرطة «-» أو «/» أو فاصلة أو نقطتين «:»، وأحياناً **بلا فاصل** («‹اسم› ‹منطقة›»). إن كان العنوان «محافظة - حي» فالمنطقة هي **الحيّ** لا المحافظة. انسخ اسم المنطقة كما هو مكتوب ولا تترجمه.
- **فصل الصيدلية عن المنطقة:** كثيراً ما يُكتب اسم الصيدلية والمنطقة معاً في خانة الزبون مفصولين بشرطة «-» أو فاصلة، بالشكل «‹اسم› - ‹منطقة›». الجزء الأول هو اسم الصيدلية (pharmacy)، والجزء الأخير بعد الشرطة هو المنطقة (area). ضع كلاً في حقله المناسب ولا تدمجهما في حقل واحد.
- **سطر الزبون في نماذج «طلبية المكاتب»:** كثير من مذاخر العراق لا تضع للزبون خانةً مُعنونة، بل تكتبه **سطراً واحداً في أعلى الورقة** — غالباً فوق الباركود وفوق اسم المذخر الكبير. يبدأ بـ«ص» أو «صيدلية»، ثم اسم الصيدلية، ثم فاصل (شرطة «-» أو «ـ» أو «/»)، ثم المنطقة، وقد ينتهي بـ«م» متبوعاً باسم المندوب. شكله: «ص ‹اسم› ـ ‹منطقة› م ‹مندوب›» ⇒ pharmacy = ‹اسم›، area = ‹منطقة›، و‹مندوب› **يُهمَل ولا يُوضَع في أي من الحقلين**. ابحث عن هذا السطر دائماً قبل أن تُعيد pharmacy فارغاً، ولا تخلط بينه وبين اسم المذخر الذي يظهر بخط كبير مع الشعار.
- **المنطقة (area):** منطقة **الصيدلية المشترية** فقط — تأتي عادةً في خانة خاصة أو مباشرةً بعد اسم الصيدلية (بعد الشرطة). لا تضع فيها عنوان المذخر، ولا اسم الشعبة/المندوب، ولا أي نص من ترويسة البائع.
- **خانة «المنطقة» المُعنونة تتقدّم على كل شيء:** إن وُجد في كتلة الزبون حقل عنوانه «المنطقة» أو «منطقة» فقيمته هي area حرفياً، حتى لو ظهر اسم حيّ آخر في مكان غيره من الورقة.
- **عنوان المذخر (warehouseAddress):** المذخر يطبع عنوانه في ترويسته قرب اسمه وشعاره وأرقام هواتفه («الإدارة»، «كول سنتر»)، غالباً بالشكل «‹محافظة› - ‹حي› - ‹شارع›». انسخه في warehouseAddress — وهذا العنوان **ليس** منطقة الصيدلية أبداً ولا يوضع في area.
- المذخر (warehouse) هو البائع أعلى الفاتورة، والصيدلية (pharmacy) هي المشتري — لا تخلط بينهما. **اسم المذخر/الشعار (حتى لو كان لاتينياً مثل «Aspirin Drug store») لا يوضع أبداً في pharmacy.**
- **البونص (bonus) = عدد القطع المجانية** المُجهَّزة مع الصنف بلا سعر. يظهر بأحد الأشكال:
  • عمود مستقل بعنوان مثل «كمية مجانية»، «مجاني»، «البونص»، «بونص»، «هدية»، «free»، «bonus» ⇒ قيمته في bonus.
  • داخل خانة الكمية بصيغة «10+2» أو «10 + 2» ⇒ quantity = 10، bonus = 2.
  • **سطر مستقل لنفس المادة** سعره صفر أو فارغ (بعد سطرها المدفوع) ⇒ أضف كميته إلى bonus سطرها المدفوع **ولا تُعِده صفاً منفصلاً**.
  لا تضع البونص في quantity، ولا تحسب السعر الكلي عليه. إن لم يوجد فاجعله 0.
- **priceShown:** هل خانة السعر أو المبلغ **مطبوعة فعلاً بأرقام** في هذا السطر من الصورة؟ إن كانت الخانتان فارغتين فـ priceShown = false و unitPrice = null و total = null —
  **ممنوع** أن تنسخ سعر سطر آخر أو تحسب المبلغ بنفسك لسطر لا سعر فيه. هذا السطر غالباً سطر البونص.
- **لا تحذف ولا تدمج الأسطر المتكرّرة:** إن تكرّرت نفس المادة في سطرين (الثاني بلا سعر = بونص) فأعِد السطرين كما هما كلاً بصفّه.
- انتبه: المبالغ قد تُكتب بفاصل آلاف شكله «'» أو «.» أو «,» («76'800» = 76800، «7'680» = 7680).
- كرّر قيم الترويسة (warehouse, pharmacy, invoiceNumber, date, area) في كل صف من هذه الفاتورة.
- الأرقام أرقام حقيقية بلا فواصل آلاف ولا رموز عملة (مثال: 99000 وليس "99,000").
- إن لم تجد قيمة حقلٍ فاجعلها null — لا تختلق ولا تخمّن قيماً.
- التاريخ بصيغة YYYY-MM-DD إن أمكن، وإلا كما هو مكتوب.
- إن كانت الصورة غير واضحة أو ليست فاتورة، أعِد مصفوفة فارغة [].`;

// Common prefixes/titles that get typed before a pharmacy/customer name on
// Iraqi invoices. We strip them so the stored customer is the clean name.
// العناوين الإنجليزية («Client name :»، «Customer :») تُطبع في فواتير مذاخر ثنائية اللغة.
const PHARMACY_PREFIX_RE = /^\s*((?:client|customer)\s*name|client|customer|name|اسم\s+الزبون|السيد|السادة|الساده|حضرة|ص\.?|صيدلية|الصيدلية|صيدليه|الصيدليه|زبون|الزبون|عميل|العميل|اسم|الاسم|د\.?|دكتور|dr\.?)(?:\s*[:：]\s*|\s+)/i;
export function cleanPharmacyName(name) {
  let s = String(name ?? '').trim();
  // Strip repeatedly in case of stacked prefixes (e.g. "اسم الزبون ...")
  // ويُسقَط بينها أي فاصل طرفي: تُكتب خانة الزبون كثيراً «ص / ماء الرسيل / سيدية»،
  // فبعد إسقاط «ص» يبقى «/ ماء الرسيل» بشرطة مائلة مُعلّقة في أول الاسم.
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(PHARMACY_PREFIX_RE, '').trim();
    s = s.replace(/^[/\-\u2013،,.|]+/, '').trim().replace(/[/\-\u2013،,|]+$/, '').trim();
    if (s === before) break;
  }
  return s;
}

// Invoices often write "pharmacy name - area" in one customer field, e.g.
// "اروى علي احمد - التاجي". Split on the LAST " - " (or " / "): the tail is the
// area, the head is the pharmacy. The tail wins over a mis-read area because the
// invoice puts the area right after the pharmacy name.
export function splitPharmacyArea(pharmacy, area) {
  // «ـ» (تطويل) تُستعمل في فواتير المذاخر كشرطة فاصلة: «نديم عدنان ـ الطارمية».
  // تُحوَّل إلى شرطة عادية **فقط حين تكون محاطة بمسافات** — التطويل داخل الكلمة
  // زخرفة لا فاصل، وتقسيمُه كان سيشطر أسماء الأدوية («دافـلون»).
  const dashed = String(pharmacy ?? '').replace(/\s+\u0640+\s+/g, ' - ')
    // لاحقة المندوب تُسقَط من **المدخل** لا من الناتج: في «محمد فارس محسن -
    // حي المستنصرية م محمد علي» تجعل اللاحقةُ الذيلَ خمس كلمات فيتجاوز حدّ
    // الأربع أدناه، فلا ينفصل شيء ويدخل السطر كلّه في خانة الصيدلية.
    .replace(/\s+م(?:\s+[^\s\d]{2,}){1,3}\s*$/, '')
    .trim();
  let ph = cleanPharmacyName(dashed);
  let ar = String(area ?? '').trim();
  // «الحرية ص. العترة»: سطر المنطقة دُمج قبل سطر الصيدلية (طلبيات الكروبات تكتب
  // المنطقة سطراً مستقلاً فوق «ص …»). «ص» منفردة بعد كلمة = بداية اسم الصيدلية،
  // وما قبلها منطقة. «ص» يجب أن تتبعها مسافة أو نقطة كي لا تُقصّ «صباح».
  const emb = ph.match(/^([^\d/\-–]+?)\s+(?:صيدلي[ةه]|ص)(?:\s*[.:]\s*|\s+)(\S.*)$/);
  if (emb && emb[1].trim().split(/\s+/).length <= 4) {
    ph = cleanPharmacyName(emb[2]);
    ar = emb[1].trim(); // نفس قاعدة الذيل أدناه: منطقة سطر الزبون أوثق من خانة الموديل
  }
  const m = ph.match(/^(.*\S)\s*[-\/–]\s*(\S.*)$/); // last " - " or " / " separator
  if (m) {
    const head = m[1].trim();
    const tail = m[2].trim();
    // Only split when the tail looks like a short area label (not part of a long name)
    if (head && tail && tail.split(/\s+/).length <= 4) {
      ph = head;
      ar = tail; // pharmacy-line area is the reliable one
    }
  }
  // لاحقة المندوب في سطر الزبون: «الطارمية م بشار» ⇒ المنطقة «الطارمية».
  // «م» هنا اختصار «مندوب»، ويتبعها اسم من كلمة إلى ثلاث («م محمد عباس»).
  // الشرط يستثني الأرقام عمداً كي تبقى منطقة حقيقية مثل «حي الجامعة م 304»
  // سليمة، حيث «م» هناك اختصار «محلّة» لا «مندوب».
  ar = ar.replace(/\s+م(?:\s+[^\s\d]{2,}){1,3}\s*$/, '').trim();

  return { pharmacy: ph, area: ar };
}

/**
 * هل «المنطقة» المقروءة هي في الحقيقة عنوان المذخر (البائع) من ترويسته؟
 * حدث فعلاً (2026-10-16): فاتورة «مذخر بوابة عشتار» عنوانه «بغداد - نفق الشرطة -
 * حي حطين» وخانة الزبون «المنطقة: الدورة» — قُرئت المنطقة «بغداد - نفق الشرطة»
 * فضاع الحيّ الحقيقي وتعذّر تخمين المندوب. منطقة تطابق جزءاً من عنوان المذخر
 * تُرمى، وتبقى الخانة فارغة لتُملأ من سيرفي الصيدلية أو يملأها المراجِع.
 */
export function isWarehouseAddressArea(area, warehouseAddress) {
  const key = (s) => normalizeItemKey(String(s ?? '')).replace(/\s+/g, ' ').trim();
  const a = key(area), w = key(warehouseAddress);
  if (!a || !w) return false;
  if (a === w) return true;
  // منطقة من كلمة واحدة («الدورة») تبقى ولو ورد اسمها في عنوان المذخر — المذخر
  // والصيدلية قد يكونان في الحيّ نفسه. يُرمى فقط ما يبدو **عنواناً منسوخاً**:
  // جزءان فأكثر بفاصل («بغداد - نفق الشرطة») كلّها موجودة في عنوان المذخر.
  const parts = String(area).split(/[-/،,–]/).map(key).filter(x => x.length >= 2);
  return parts.length >= 2 && parts.every(x => w.includes(x));
}

/** Validate a Gemini bounding box → [ymin, xmin, ymax, xmax] in 0-1000, or null. */
export function normalizeBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const n = b.map(Number);
  if (n.some(v => !isFinite(v))) return null;
  return n;
}

/** Parse Gemini's reply into an array of invoice rows (mirrors analyzeSurveyEntriesBatched). */
export function parseInvoiceJson(raw) {
  if (!raw) return [];
  let cleaned = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/); // first [...] block if wrapped in prose
  if (match) cleaned = match[0];
  let arr;
  try { arr = JSON.parse(cleaned); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter(r => r && typeof r === 'object');
}

// ─── نداء ثانٍ مركَّز: سطر الزبون وحده ──────────────────────────────────────
// سطر الزبون في «طلبية المكاتب» سطرٌ صغير باهت أعلى الورقة فوق الباركود، بلا
// عنوان حقل. قياساً على فواتير حقيقية: البرومبت الكامل يُعيده فارغاً باستمرار
// مهما شُدِّدت قاعدته — فهو تفصيل صغير وسط تعليمات كثيرة. النداء المركَّز يقرأه
// بموثوقية، ولا يُستدعى إلا حين تفشل القراءة الأولى، فكلفته صفر في الحالة
// الطبيعية.
const buildCustomerLinePrompt = (warehouse) => `هذه صورة فاتورة/«طلبية مكاتب» من مذخر أدوية عراقي.

**تنبيه:** الصورة قد تكون مُلتقَطة مائلةً أو مُدارة 90° أو مقلوبة — اقرأ النص باتجاهه الصحيح أياً كان دوران الورقة.

مهمتك **قراءة سطر واحد فقط** من **هذه الصورة بالذات**: سطر الزبون (الصيدلية المشترية). ‹اسم› و‹منطقة› أدناه رموز لمكان القيمة لا قيم حقيقية — **اكتب ما تراه في الصورة حرفياً**. للسطر أشكال:
1) حقل مُعنون في ترويسة الفاتورة بعد «اسم الزبون» أو «الزبون» أو «الاسم» أو «الصيدلية» أو «العميل»، شكله: «اسم الزبون : ‹اسم› - ‹منطقة›». (حقل «العنوان» المجاور قد يحمل المنطقة أيضاً بالشكل «‹محافظة› - ‹منطقة›».)
2) حقل بعد «السيد» أو «السادة» أو «حضرة» (وقد يتبعه «المحترم»)، شكله: «السيد : صيدلية ‹اسم›/ ‹منطقة›» — ما قبل «/» اسم الصيدلية وما بعدها المنطقة.
3) سطر بلا عنوان في **أعلى الورقة**، فوق الباركود وفوق اسم المذخر الكبير، بخط صغير وربما على خلفية رمادية فاتحة. شكله:
«ص ‹اسم› ـ ‹منطقة› م ‹مندوب›»
«اسم المندوب» و«الكاشير» و«المجهز» و«منظم الفاتورة» أشخاص من طرف المذخر — ليسوا الزبون ولا المنطقة.

انظر إلى أعلى الصورة بتمعّن واقرأ ذلك السطر، ثم أعِد **كائن JSON فقط** بلا أي نص آخر وبلا أسوار:
{"line":"السطر كما هو حرفياً","pharmacy":"اسم الصيدلية فقط","area":"المنطقة","areaField":"قيمة حقل «المنطقة» المُعنون في كتلة الزبون أو null"}

قواعد:
- إن وُجد في كتلة الزبون حقل مُعنون «المنطقة» أو «منطقة» فانسخ قيمته حرفياً في areaField — هو المرجع للمنطقة.
- عنوان المذخر المطبوع في ترويسته قرب أرقام الهواتف («‹محافظة› - ‹حي› - ‹شارع›») **ليس** منطقة الزبون — لا تضعه في area ولا areaField.
- «ص» أو «ص.» أو «صيدلية» في أول السطر بادئة — تُحذف من pharmacy.
- الفاصل بين اسم الصيدلية والمنطقة قد يكون «-» أو «ـ» أو «/» أو «،». ما قبله اسم الصيدلية وما بعده المنطقة.
- ما يأتي بعد «م» منفردة هو **اسم المندوب** — لا تضعه في pharmacy ولا في area.
- لا تخلط بين هذا السطر واسم المذخر (ولا شعاره اللاتيني) ولا مع «طلبية المكاتب» ولا مع أي عنوان مطبوع في الترويسة.${warehouse ? `\n- **اسم المذخر في هذه الفاتورة بالذات هو «${warehouse}» — هذا هو البائع وليس الزبون. ممنوع منعاً باتاً أن تُعيده في pharmacy.**` : ''}
- المذخر يُكتب بخط كبير عريض بجانب الباركود. أما الزبون فسطر صغير **فوقه**.
- اكتب الكلمات **متصلة** كما هي في الورقة — لا تُدخل مسافة داخل الكلمة الواحدة («روعة» لا «رو عة»)، فالاسم يُطابَق لاحقاً بقائمة صيدليات والمسافة الزائدة تُنشئ زبوناً مكرّراً.
- إن لم تجد سطراً كهذا إطلاقاً فأعِد {"line":null,"pharmacy":null,"area":null}.`;

/** يلتقط أول كائن JSON من ردّ Gemini (نظير parseInvoiceJson للمصفوفات). */
function parseJsonObject(raw) {
  if (!raw) return null;
  let cleaned = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) cleaned = m[0];
  try {
    const o = JSON.parse(cleaned);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/**
 * حارس النسخ من البرومبت: قراءة صيدلية تظهر **حرفياً** داخل نص التعليمات ليست من
 * الصورة بل نُسخت من مثال. حدث فعلاً (2026-10-13): فاتورة «محمد فارس محسن - حي
 * المستنصرية» قُرئت «محمد عبد الامير الرفيعي / العطيفية» = المثال الذي كان في
 * البرومبت. الأمثلة صارت رموزاً (‹اسم›)، وهذا خط دفاع ثانٍ إن عاد مثال حقيقي يوماً.
 */
export function isCopiedFromPrompt(pharmacy, promptText) {
  const k = normalizeItemKey(pharmacy).replace(/\s+/g, '');
  if (k.length < 5) return false;
  return normalizeItemKey(promptText).replace(/\s+/g, '').includes(k);
}

/**
 * يقرأ سطر الزبون من صورة فاتورة. يُعيد { pharmacy, area } أو null.
 * لا يرمي أبداً — فشله يترك الحقلين فارغين ليملأهما المراجِع.
 */
export async function extractCustomerLine(img, { timeoutMs = 45_000, warehouse = '', thinkingBudget = 0 } = {}) {
  try {
    const text = await callInvoiceAI(
      [buildCustomerLinePrompt(warehouse), { inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } }],
      { timeoutMs, thinkingBudget, feature: 'invoice-customer-line' },
    );
    const o = parseJsonObject(text);
    if (!o) return null;

    // لاحقة المندوب تُسقَط **قبل** الفصل لا بعده: في «محمد فارس محسن - حي
    // المستنصرية م محمد علي» تجعل اللاحقةُ الذيلَ خمس كلمات، فيتجاوز حدّ
    // splitPharmacyArea (أربع كلمات) ولا ينفصل شيء إطلاقاً.
    const line = String(o.line ?? '').trim().replace(/\s+م(?:\s+[^\s\d]{2,}){1,3}\s*$/, '').trim();
    const split = line
      ? splitPharmacyArea(line, o.area ?? '')
      : splitPharmacyArea(o.pharmacy ?? '', o.area ?? '');
    const areaField = String(o.areaField ?? '').trim().replace(/^(?:المنطقة|المنطقه|منطقة|منطقه)\s*[:：]?\s*/, '');
    if (areaField && areaField.toLowerCase() !== 'null') split.area = areaField;
    if (!split.pharmacy) return null;
    // رقم من 3 خانات فأكثر = سعر/هاتف/كمية قُرئت من الجدول لا اسم صيدلية.
    if (/\d{3,}/.test(split.pharmacy.replace(/[\s,.'٬]/g, '')) || /[٠-٩]{3,}/.test(split.pharmacy)) return null;
    if (/\d{3,}/.test(String(split.area ?? '').replace(/[\s,.'٬]/g, ''))) split.area = '';
    if (isCopiedFromPrompt(split.pharmacy, buildCustomerLinePrompt(warehouse))) {
      console.error('[invoice-extract] رُفضت قراءة منسوخة من مثال البرومبت:', split.pharmacy);
      return null;
    }

    // حارس: النداء المركَّز يُعيد أحياناً اسم المذخر (البائع) بدل الزبون. كتابة
    // المذخر في خانة الصيدلية أسوأ من تركها فارغة — تُنشئ زبوناً وهمياً باسم
    // مذخر يلتصق بالمبيعات، فنرفضه.
    const looksLikeWarehouse = isWarehouseAsPharmacy(split.pharmacy, warehouse);
    if (looksLikeWarehouse) {
      console.error('[invoice-extract] رُفض سطر زبون يطابق المذخر:', split.pharmacy);
      return null;
    }
    return split;
  } catch (err) {
    console.error('[invoice-extract] فشل قراءة سطر الزبون:', String(err?.message || '').slice(0, 150));
    return null;
  }
}

// ─── تنظيف حتمي بعد قراءة الصورة ────────────────────────────────────────────

const WAREHOUSE_WORD_RE = /مذخر|مخزن|مستودع|drug\s*store|pharma\s*store/i;
const warehouseKey = (s) => normalizeItemKey(String(s ?? '')
  .replace(/مذخر|مخزن|مستودع|ادويه|أدوية|ادوية|drug\s*store|store|for\s+drugs?/gi, ' ')).replace(/\s+/g, '');

/**
 * هل «الصيدلية» المقروءة هي في الحقيقة المذخر البائع؟ الشعار الكبير اللاتيني
 * («Aspirin Drug store») يُقرأ أحياناً كزبون. كتابة المذخر في خانة الصيدلية تُنشئ
 * زبوناً وهمياً يلتصق بالمبيعات — أسوأ من خانة فارغة يكملها النداء المركَّز.
 */
// حقول أشخاص من طرف المذخر تتسرّب أحياناً لخانة الصيدلية («المجهز: حسين فالح»،
// «المندوب: عبد الرحمن مسلم 0772…»). رقم هاتف (7 أرقام فأكثر) دليل مثله.
const STAFF_FIELD_RE = /^\s*(اسم\s+)?(المجهز|مجهز|المندوب|مندوب|الكاشير|كاشير|منظم\s+الفاتور[ةه]|السائق|سائق|الحسابات)\s*[:：]?/;
export function isStaffField(pharmacy) {
  const ph = String(pharmacy ?? '').trim();
  return !!ph && (STAFF_FIELD_RE.test(ph) || /\d{7,}/.test(ph.replace(/\s+/g, '')));
}

export function isWarehouseAsPharmacy(pharmacy, warehouse) {
  const ph = String(pharmacy ?? '').trim();
  if (!ph) return false;
  if (isStaffField(ph)) return true;
  if (WAREHOUSE_WORD_RE.test(ph)) return true;
  const a = warehouseKey(ph), b = warehouseKey(warehouse);
  if (!a || !b) return false;
  // الاحتواء بحدّ 6 أحرف: «الحياة» قد تكون صيدلية ومذخراً معاً — التساوي وحده يحسمها.
  return a === b || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b));
}

const isZeroish = (v) => v == null || v === '' || !Number(v);
// قراءة الموديل أن خانتي السعر فارغتان في الصورة. مقيس (2026-10-15) على فاتورة
// «طريق السلام»: سطر البونص (5 بلا سعر) كان يعود بسعر منسوخ من السطر المدفوع
// ومبلغ محسوب (6057 × 5)، فلا يتعرّف عليه الطيّ أدناه ويبقى بيعاً مدفوعاً.
const isPriceless = (r) => r.priceShown === false || r.priceShown === 'false'
  || (isZeroish(r.total) && isZeroish(r.unitPrice));

/**
 * البونص: (1) «10+2» داخل الكمية ⇒ كمية 10 وبونص 2. (2) سطر مستقل لنفس المادة
 * بلا سعر ⇒ يُضاف لبونص سطرها المدفوع ويُحذف. يعمل على صفوف صورة واحدة.
 */
export function foldBonusRows(rows) {
  for (const r of rows) {
    const q = String(r.quantity ?? '').trim();
    const m = q.match(/^(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      r.quantity = Number(m[1]);
      r.bonus = (Number(r.bonus) || 0) + Number(m[2]);
    }
  }
  // علامة نهاية الفاتورة «***** انتهى *****» تُطبع تحت آخر سطر فتلتصق باسمه
  // («Amoklavin-BID ***** انتهى») فيضيع تطابقه مع سطره المدفوع.
  for (const r of rows) {
    if (typeof r.item === 'string') r.item = r.item.replace(/\*{3,}.*$/s, '').replace(/\s*انتهى\s*$/, '').trim() || r.item;
  }
  // المادة المكرّرة التي يحمل أحد أسطرها مبلغاً مطبوعاً: ذلك السطر هو المدفوع،
  // وتكرارها بلا مبلغ بونص حتى لو نسخ الموديل سعر الوحدة إليه أو أخطأ priceShown.
  // priceShown=false يغلب أي مبلغ أعاده الموديل: مقيس (2026-10-16) — سطر بونص
  // «AMOKLAVIN 5» بلا سعر مطبوع عاد بمبلغ محسوب (6.057 × 5 = 30.285) فبقي طلبية
  // ثانية لأن الفحص كان ينظر للمبلغ وحده متى وُجد سطر مدفوع.
  const noPrintedPrice = (r) => r.priceShown === false || r.priceShown === 'false';
  // مبلغ «مُستعار»: مقيس (2026-10-16، فاتورة طريق السلام 675630) — سطر البونص
  // «Amoklavin 1000 × 5» بلا سعر عاد بمبلغ السطر التالي (83'400) وسعر وحدة لا
  // يطابقه (5'693)، مع priceShown=true. المبلغ الحقيقي يساوي الكمية × السعر؛
  // ومبلغ يتكرّر على سطر آخر يطابقه هناك فهو مبلغ ذلك السطر لا هذا.
  const consistent = (r) => {
    const q = Number(r.quantity), u = Number(r.unitPrice), t = Number(r.total);
    return q > 0 && u > 0 && t > 0 && Math.abs(q * u - t) <= Math.max(1, t * 0.02);
  };
  const borrowedTotal = (r) => !isZeroish(r.total) && !consistent(r)
    && rows.some(o => o !== r && consistent(o) && Math.abs(Number(o.total) - Number(r.total)) < 0.5);
  const withTotal = new Map();
  for (const pass of [true, false]) { // السطر المتّسق حسابياً أولاً
    for (const r of rows) {
      const k = normalizeItemKey(r.item ?? '');
      if (k && !isZeroish(r.total) && !noPrintedPrice(r) && !borrowedTotal(r) && (!pass || consistent(r)) && !withTotal.has(k)) withTotal.set(k, r);
    }
  }
  const keyOf = (r) => normalizeItemKey(r.item ?? '');
  const isFree = (r) => {
    const paid = withTotal.get(keyOf(r));
    if (paid) {
      if (paid === r) return false;
      if (isZeroish(r.total) || noPrintedPrice(r) || borrowedTotal(r)) return true;
      // تكرار لصنف سطره المدفوع متّسق، وهذا السطر لا يتّسق مبلغه مع كميته وسعره.
      if (consistent(paid) && !consistent(r) && !isZeroish(r.unitPrice)) return true;
      // سعر وحدة منسوخ حرفياً من السطر المدفوع ومبلغ محسوب عليه (6 × 4'389 =
      // 26'334): سطر لاحق بنفس السعر وكمية أقلّ هو سطر البونص في فواتير المذاخر —
      // الطلبية المدفوعة الثانية لنفس الصنف بنفس السعر تُجمع في سطر واحد.
      const pu = Number(paid.unitPrice), ru = Number(r.unitPrice);
      return pu > 0 && Math.abs(pu - ru) <= pu * 0.005
        && Number(r.quantity) < Number(paid.quantity) && rows.indexOf(r) > rows.indexOf(paid);
    }
    return isPriceless(r);
  };
  const paidByItem = new Map(withTotal);
  for (const r of rows) {
    const k = keyOf(r);
    if (k && !isFree(r) && !paidByItem.has(k)) paidByItem.set(k, r);
  }
  // اسم سطر البونص يُقرأ أحياناً مبتوراً («Amoklavin-BID» من «Amoklavin-BID 1000mg
  // 10 tab deva») — بادئة كلمة كاملة من اسم سطر مدفوع واحد فقط تكفي.
  const findPaid = (k) => {
    if (paidByItem.has(k)) return paidByItem.get(k);
    if (k.length < 5) return null;
    const hits = [...paidByItem.entries()].filter(([pk]) => pk.startsWith(k + ' ') || k.startsWith(pk + ' '));
    return hits.length === 1 ? hits[0][1] : null;
  };
  return rows.filter(r => {
    const k = keyOf(r);
    if (!k || !isFree(r)) return true;
    const paid = findPaid(k);
    if (!paid || paid === r) return true;
    paid.bonus = (Number(paid.bonus) || 0) + (Number(r.quantity) || 0) + (Number(r.bonus) || 0);
    return false;
  });
}

// ─── اتجاه الصورة ───────────────────────────────────────────────────────────
const ORIENTATION_PROMPT = `انظر إلى اتجاه الكتابة في هذه الصورة (ورقة فاتورة من مذخر أدوية).
السؤال: هل الأسطر المكتوبة أفقية وتُقرأ بشكل طبيعي كما هي (رأس الحروف للأعلى)؟
- إن كانت كذلك (حتى لو الورقة مائلة قليلاً أقل من 30°) فأعِد {"rotate": 0}.
- وإلا فاذكر كم درجة يلزم تدوير الصورة **باتجاه عقارب الساعة** لتصبح الأسطر أفقية مقروءة: 90 أو 180 أو 270.
مثال: إن كانت رؤوس الحروف تتجه نحو **يمين** الصورة فالتدوير 270؛ نحو **يسارها** فالتدوير 90؛ نحو **الأسفل** فالتدوير 180.
أعِد كائن JSON فقط: {"rotate": 0}`;

/**
 * يكتشف التدوير اللازم (0/90/180/270 مع عقارب الساعة). ثلاث قراءات والأغلبية —
 * قراءة واحدة قد تخطئ في الصور المائلة ~45°. يُعيد 0 عند أي فشل (القراءة بلا تدوير).
 */
export async function detectInvoiceRotation(img) {
  try {
    const parts = [ORIENTATION_PROMPT, { inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } }];
    const votes = await Promise.all([1, 2, 3].map(async () => {
      try {
        const o = parseJsonObject(await callInvoiceAI(parts, { timeoutMs: 20_000, thinkingBudget: 0, feature: 'invoice-orient' }));
        const v = Number(o?.rotate);
        return [0, 90, 180, 270].includes(v) ? v : null;
      } catch { return null; }
    }));
    const tally = new Map();
    for (const v of votes) if (v != null) tally.set(v, (tally.get(v) || 0) + 1);
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? best[0] : 0;
  } catch { return 0; }
}

/**
 * يُعيد صندوقاً [ymin,xmin,ymax,xmax] (0-1000) مأخوذاً من صورة مُدارة `deg` درجة مع
 * عقارب الساعة إلى إحداثيات الصورة الأصلية — بتحويل زواياه ثم أخذ الحدود.
 */
export function unrotateBox(box, deg) {
  if (!box || !deg) return box;
  const [y1, x1, y2, x2] = box;
  const pts = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([nx, ny]) => {
    if (deg === 90)  return [ny, 1000 - nx];
    if (deg === 180) return [1000 - nx, 1000 - ny];
    return [1000 - ny, nx]; // 270
  });
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)].map(v => Math.max(0, Math.min(1000, Math.round(v))));
}

/** يُدير الصورة للوضع القائم إن لزم. يُعيد { mimeType, base64, rotated }. */
export async function orientInvoiceImage(img) {
  try {
    const buf = Buffer.from(img.base64, 'base64');
    if (!canRotate(buf)) return { ...img, rotated: 0 };
    const deg = await detectInvoiceRotation(img);
    if (!deg) return { ...img, rotated: 0 };
    const out = rotateJpeg(buf, deg);
    return { mimeType: 'image/jpeg', base64: out.toString('base64'), rotated: deg };
  } catch (e) {
    console.error('[invoice-extract] تعذّر تعديل اتجاه الصورة:', String(e?.message || '').slice(0, 120));
    return { ...img, rotated: 0 };
  }
}

/**
 * ثلاث قراءات مركَّزة متوازية لسطر الزبون (+ قراءة النداء الكامل) ثم تصويت. السطر صغير وقد تكون الصورة
 * مُدارة، فالقراءة الواحدة تتذبذب («النعيمي» ثم «اللبني») — مقيس على صورة حقيقية
 * مُدارة 90°: المنطقة ثابتة والاسم صحيح في ~4 من 5. الأغلبية تُسقط الشاذّ،
 * والتعادل يحسمه ما تؤكّده بيانات الماستر. نداءات lite سريعة (~2 ث معاً).
 * يُعيد { pharmacy, area, score } أو null.
 */
async function extractCustomerLineVoted(img, opts, n = 3, priorRead = null) {
  // flash لا lite: مقيس (2026-10-13) على 3 فواتير × 3 تشغيلات — flash صحيح 9/9، وlite
  // قرأ الأسعار والجدول («HUMANIS / 20,452») في فاتورتين بعد إزالة المثال من البرومبت.
  // (lite تفوّق سابقاً على الصورة المُدارة فقط — والتدوير صار يُصحَّح قبل القراءة.)
  const reads = (await Promise.all(Array.from({ length: n }, () => extractCustomerLine(img, { ...opts })))).filter(Boolean);
  // قراءة النداء الكامل صوتٌ إضافي — كانت صحيحة غالباً فلا تُرمى لمجرّد أنها
  // غير معروفة في الماستر (صيدلية جديدة).
  // وزنها صوتان: النداء الكامل يعمل بالموديل الأقوى (flash) والمركَّز بـlite.
  if (priorRead?.pharmacy) reads.push(priorRead, priorRead);
  if (!reads.length) return null;
  const groups = new Map();
  for (const r of reads) {
    const k = normalizeItemKey(r.pharmacy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let best = null;
  for (const list of groups.values()) {
    const r = list[0];
    const score = await customerKnownScore(r.pharmacy, r.area);
    const areaVotes = new Map();
    for (const x of list) if (x.area) areaVotes.set(x.area, (areaVotes.get(x.area) || 0) + 1);
    const area = [...areaVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? r.area;
    const cand = { pharmacy: r.pharmacy, area, score, votes: list.length };
    if (!best || cand.votes > best.votes || (cand.votes === best.votes && cand.score > best.score)) best = cand;
  }
  return best;
}

/**
 * Extract sale rows from one or more invoice images via Gemini vision.
 * Returns flat, UNSAVED rows for the user to review before saving.
 * @param {{ mimeType: string, base64: string }[]} images
 * @param {{ extraContext?: string }} [opts] extraContext = نص حرّ أرسله صاحب الصورة
 *        مع الصورة (كابشن رسالة بوت مثلاً) يُلحَق بالبرومبت كسياق مساعد. حين لا
 *        يُمرَّر يبقى نص البرومبت مطابقاً حرفياً لما كان — مسار /extract-invoice سليم.
 * @returns {Promise<object[]>}
 */
export async function extractInvoiceRows(images, { extraContext } = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new AppError('لم يتم إرسال أي صورة.', 400, 'NO_IMAGES');
  }
  const OVERALL_BUDGET_MS = 190_000; // stay under Nginx's 300s proxy timeout
  const started = Date.now();
  const allRows = [];
  let processed = 0;
  let lastErr = null;

  // Process each image separately so multi-invoice uploads keep per-image header
  // details (warehouse / invoiceNumber / date / pharmacy / area). `_imageIndex`
  // lets the UI link each row back to the invoice photo it came from.
  for (let idx = 0; idx < images.length; idx++) {
    const elapsed = Date.now() - started;
    if (elapsed >= OVERALL_BUDGET_MS) break;
    try {
      // اتجاه الصورة أولاً: فاتورة مُدارة 90° تُقرأ بتذبذب («النعيمي» بدل «النبض»)
      // وبعد تدويرها قائمةً تُقرأ صحيحة. صناديق التكبير تُعاد لإحداثيات الأصل أدناه
      // لأن المراجعة تعرض الصورة الأصلية لا المُدارة.
      const img = await orientInvoiceImage(images[idx]);
      const parts = [
        extraContext
          ? `${INVOICE_PROMPT}

ملاحظة من مُرسِل الصورة (نصّ حرّ قد يصحّح أو يكمل ما في الصورة — اعتمده حين يتعارض مع قراءة غير واضحة): «${extraContext}»`
          : INVOICE_PROMPT,
        { inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } },
      ];
      const text = await callInvoiceAI(parts, {
        timeoutMs:  70_000,
        maxTotalMs: OVERALL_BUDGET_MS - elapsed,
        thinkingBudget: 0,
        feature: 'invoice-read',
      });
      let imageRows = [];
      let imageWarehouseAddress = '';
      for (const row of parseInvoiceJson(text)) {
        if (!imageWarehouseAddress && row.warehouseAddress) imageWarehouseAddress = String(row.warehouseAddress);
        const split = splitPharmacyArea(row.pharmacy, row.area); // clean prefixes + split "name - area"
        row.pharmacy = (isWarehouseAsPharmacy(split.pharmacy, row.warehouse) || isCopiedFromPrompt(split.pharmacy, INVOICE_PROMPT))
          ? '' : split.pharmacy;
        row.area = isWarehouseAddressArea(split.area, row.warehouseAddress) ? '' : split.area;
        delete row.warehouseAddress;
        row._imageIndex = idx;
        imageRows.push(row);
        row._box = unrotateBox(normalizeBox(row.box), img.rotated);                  // this item's whole row in the image
        row._boxCustomer = unrotateBox(normalizeBox(row.box_customer), img.rotated); // pharmacy/area block
        row._boxHeader = unrotateBox(normalizeBox(row.box_header), img.rotated);     // whole header block (warehouse+invoice#+date)
        delete row.box; delete row.box_customer; delete row.box_header;
      }
      imageRows = foldBonusRows(imageRows);
      for (const r of imageRows) delete r.priceShown;

      // احتياطي سطر الزبون: نداء مركَّز واحد للصورة حين لم تُقرأ الصيدلية، **أو**
      // قُرئت لكن الصيدلية غير محسومة في سيرفي الماستر. الحالة الثانية
      // مقيسة: فاتورة «طريق السلام» المصوَّرة مُدارة 90° أعاد النداء الكامل فيها
      // «اللحمي»/«**** النقدي» بدل «النعيمي»، بينما قرأ النداء المركَّز السطر صحيحاً.
      // ثم تُختار القراءة التي تؤكّدها بيانات الماستر أكثر (التعادل للمركَّز).
      const first = imageRows.find(r => r.pharmacy) || imageRows[0];
      const whAddress = imageWarehouseAddress;
      const firstScore = first?.pharmacy ? await customerKnownScore(first.pharmacy, first.area) : -1;
      if (imageRows.length > 0 && firstScore < 2) {
        const cust = await extractCustomerLineVoted(img, {
          timeoutMs: Math.min(45_000, Math.max(10_000, OVERALL_BUDGET_MS - (Date.now() - started))),
          warehouse: imageRows.find(r => r.warehouse)?.warehouse || '',
        }, 3, first?.pharmacy ? { pharmacy: first.pharmacy, area: first.area } : null);
        if (cust && isWarehouseAddressArea(cust.area, whAddress)) cust.area = '';
        if (cust && cust.score >= Math.max(0, firstScore)) {
          for (const r of imageRows) {
            r.pharmacy = cust.pharmacy;
            if (cust.area || !r.area) r.area = cust.area;
          }
        }
      }

      allRows.push(...imageRows);
      processed++;
    } catch (err) {
      lastErr = err;
      console.error('[invoice-extract] image failed:', String(err?.message || '').slice(0, 200));
    }
  }

  if (processed === 0 && lastErr) {
    throw new AppError('تعذّر تحليل الفاتورة عبر الذكاء الاصطناعي. جرّب صورة أوضح أو أدخل البيانات يدوياً.', 502, 'AI_EXTRACT_FAILED');
  }
  return allRows;
}

/**
 * ميزة "استخراج ايتماتي المعينة فقط": تُهمِل فقط صفوف الاستخراج التي لا تشبه
 * أي ايتم من ايتمات المستخدم المعيّنة له (UserItemAssignment) إطلاقاً —
 * الباقي يُبقى ليصل إلى شبكة المراجعة.
 *
 * ثلاث حالات حسب resolveItemName:
 *  - alias/exact/high (مرشّح واحد واثق) → توحَّد الاسم فوراً مع الايتم المعيّن.
 *  - medium (تشابه لكن أكثر من مرشّح محتمل، أو تشابه غير قاطع) → يُبقى الصف
 *    باسمه كما استُخرج بلا تخمين، ليسأل عنه فحص الأسماء قبل الحفظ
 *    (checkManualNames / نافذة «أسماء متشابهة») لاحقاً — لا نخمّن هنا ولا نُهمِل
 *    صفاً قد يكون فعلاً أحد ايتمات المستخدم فقط لأن التشابه لم يكن قاطعاً.
 *  - none (لا تشابه إطلاقاً) → يُهمَل، هذا هو المقصود الفعلي بـ"غير معيّن لي".
 *
 * بلا تعيينات محفوظة للمستخدم = بلا تقييد (كل الصفوف تُبقى كما استُخرجت)، نفس
 * اصطلاح resolveEffectiveItemIds — تعيين فارغ لا يعني "صفر ايتمات".
 *
 * @param {object[]} rows نتيجة extractInvoiceRows
 * @param {number|null} userId
 * @returns {Promise<{ rows: object[], droppedCount: number }>}
 */
export async function filterRowsToAssignedItems(rows, userId) {
  const catalog = await getAssignedItemsCatalog(userId);
  if (!catalog) return { rows, droppedCount: 0 }; // بلا تعيينات = بلا تقييد
  const catalogById = new Map(catalog.map(c => [c.id, c]));
  const ctx = { catalog, catalogById, aliasMap: new Map() };

  const kept = [];
  for (const row of rows) {
    const name = String(row.item ?? '').trim();
    if (!name) continue;
    const r = await resolveItemName(name, ctx);
    if (r.canonicalItem) {
      row.item = r.canonicalItem.name; // ثقة عالية — توحيد مباشر مع الايتم المعيّن
      kept.push(row);
    } else if (r.suggestions.length > 0) {
      // تشابه غير قاطع — يُبقى كما استُخرج، سيُسأل عنه المستخدم لاحقاً قبل الحفظ
      kept.push(row);
    }
    // else: لا تشابه إطلاقاً مع ايتمات المستخدم المعيّنة → يُهمَل
  }
  return { rows: kept, droppedCount: rows.length - kept.length };
}

/**
 * فحص أسماء الايتمات والشركات قبل حفظ صفوف الإدخال اليدوي / فاتورة الصورة.
 *
 * لا يكتب شيئاً — يُرجع لكل اسم حالته كي تسأل الواجهة المستخدم عند الشك بدل أن
 * يقرّر النظام صامتاً. الحالات:
 *   exact : تطابق تام أو قاعدة توحيد محفوظة → يُوحَّد الاسم بلا سؤال
 *   ask   : تشابه غير قاطع (مرشّح واحد أو أكثر) → يؤكّد المستخدم
 *   new   : لا شبيه → يُضاف كاسم جديد بلا سؤال
 *
 * ملاحظة على «مرشّح واحد»: مسار رفع الإكسل يربطه تلقائياً (ثقة high)، لكن هنا
 * نسأل عنه أيضاً — فأسماء الفواتير تأتي من قراءة صورة وقد تُخطئ حرفاً، والسؤال
 * مرة واحدة أرخص من مبيعات تُنسب لايتم خاطئ.
 *
 * نطاق مطابقة الايتمات: الايتمات المعيَّنة للمستخدم إن وُجدت (وهي ما يعنيه
 * المستخدم بـ«ايتماته»)، وإلا كتالوج شركاته العلمية — نفس اصطلاح
 * resolveEffectiveItemIds: تعيين فارغ لا يعني صفر ايتمات.
 *
 * @param {object}   opts
 * @param {object[]} opts.rows   صفوف فيها { item, company }
 * @param {number|null} opts.userId
 * @returns {Promise<{ items: object[], companies: object[], scope: string }>}
 */
export async function checkManualNames({ rows, userId = null }) {
  const list = Array.isArray(rows) ? rows : [];
  const uniq = key => [...new Set(list.map(r => String(r?.[key] ?? '').trim()).filter(Boolean))];
  const itemNames    = uniq('item');
  const companyNames = uniq('company').filter(c => !isPlaceholderCompanyValue(c));

  // ── سياق الايتمات ──
  let ctx = null;
  let scope = 'none';
  const assigned = await getAssignedItemsCatalog(userId);
  if (assigned && assigned.length > 0) {
    ctx = { catalog: assigned, catalogById: new Map(assigned.map(c => [c.id, c])), aliasMap: new Map() };
    scope = 'assigned';
  } else if (userId) {
    const ua = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    const ids = ua.map(c => c.companyId).filter(Boolean);
    ctx = await loadResolutionContext({ scientificCompanyIds: ids, userId });
    scope = ids.length > 0 ? 'catalog' : 'user-items';
  }

  const items = [];
  for (const raw of itemNames) {
    if (!ctx || ctx.catalog.length === 0) { items.push({ raw, status: 'new', suggestions: [] }); continue; }
    const r = await resolveItemName(raw, ctx);
    if (r.confidence === 'alias' || r.confidence === 'exact') {
      items.push({ raw, status: 'exact', canonical: r.canonicalItem, suggestions: [] });
    } else if (r.suggestions.length > 0) {
      items.push({ raw, status: 'ask', suggestions: r.suggestions.slice(0, 5) });
    } else {
      items.push({ raw, status: 'new', suggestions: [] });
    }
  }

  // ── الشركات: تُطابَق مع شركات المستخدم القائمة (نموذج Company لا الكتالوج العلمي) ──
  const existingCompanies = userId ? await getAllCompanies(userId) : [];
  const companies = [];
  for (const raw of companyNames) {
    const key = normalizeItemKey(raw);
    const exact = existingCompanies.find(c => normalizeItemKey(c.name) === key);
    if (exact) {
      companies.push({ raw, status: 'exact', canonical: { id: exact.id, name: exact.name }, suggestions: [] });
      continue;
    }
    const cands = existingCompanies
      .filter(c => areSimilar(raw, c.name))
      .map(c => ({ id: c.id, name: c.name, sim: similarity(key, normalizeItemKey(c.name)) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5);
    companies.push({ raw, status: cands.length > 0 ? 'ask' : 'new', suggestions: cands });
  }

  return { items, companies, scope };
}

/**
 * يجمع نطاق مدير الشركة/قائد الفريق (شركاته، ايتماته المعيّنة، أسماء فريقه)
 * لبناء نموذج إكسل مذاخر خاص به — نفس مصادر النطاق المستعملة في فحص الأسماء
 * أعلاه (UserCompanyAssignment و getAssignedItemsCatalog) بالإضافة لفريق
 * المدير عبر getManagerRoster (managerRoster.js) الذي يحدّد نطاق الاستيراد
 * بالفعل في صفحات أخرى (Pharmacy Net، تحليل الكولات).
 *
 * @param {{id:number, role:string}} user
 * @returns {Promise<{ reps: string[], items: string[], companies: string[] }>}
 */
/**
 * ايتمات المستخدم المعيّنة مع سعر المذخر المعروف لكل منها (Item.warehousePrice،
 * وإلا Item.price كبديل) — تُستعمل لملء السعر تلقائياً حين يُترك حقلا السعر
 * فارغين في نموذج المذاخر، فلا حاجة لكتابة سعر معروف أصلاً عند التطبيق.
 * @param {number} userId
 * @returns {Promise<{name:string, unitPrice:number|null}[]>}
 */
export async function getWarehouseGapItemCatalog(userId) {
  const assigned = await getAssignedItemsCatalog(userId);
  if (!assigned || assigned.length === 0) return [];
  const rows = await prisma.item.findMany({
    where:  { id: { in: assigned.map(a => a.id) } },
    select: {
      name: true, price: true, warehousePrice: true,
      scientificCompany: { select: { name: true } },
      company:           { select: { name: true } },
    },
  });
  return rows.map(r => ({
    name:        r.name,
    unitPrice:   r.warehousePrice ?? r.price ?? null,
    companyName: r.scientificCompany?.name ?? r.company?.name ?? null,
  }));
}

/**
 * محافظة/محافظات عمل فريق المدير — تُشتق من مناطق مندوبيه الفعلية
 * (resolveEffectiveAreaIds لكل مندوب ← Area.province)، لا من إعداد صريح، لأن
 * لا تعيين محافظة مباشر على المدير نفسه. تُستعمل حصراً لتضييق قائمة اقتراح
 * المذاخر (StockWarehouse.region نص حر بلا ربط بـArea/Province) على محافظة
 * الفريق بدل كل مذاخر المكتب المشترك (قد تضم محافظات فرق أخرى بنفس المكتب).
 * @param {{userId:number, linkedRepId:number|null}[]} reps
 * @returns {Promise<{id:number,name:string}[]>}
 */
async function provincesForRoster(reps) {
  if (!reps || reps.length === 0) return [];
  const areaIdSets = await Promise.all(
    reps.map(r => resolveEffectiveAreaIds(r.userId, { linkedRepId: r.linkedRepId }).catch(() => [])),
  );
  const areaIds = [...new Set(areaIdSets.flat())];
  if (areaIds.length === 0) return [];
  const areas = await prisma.area.findMany({
    where:  { id: { in: areaIds } },
    select: { province: { select: { id: true, name: true } } },
  });
  const map = new Map();
  for (const a of areas) if (a.province) map.set(a.province.id, a.province);
  return [...map.values()];
}

export async function getWarehouseGapScope(user) {
  const [userCompanies, itemCatalog, roster, ledgerWarehouses] = await Promise.all([
    prisma.userCompanyAssignment.findMany({ where: { userId: user.id }, select: { company: { select: { name: true } } } }),
    getWarehouseGapItemCatalog(user.id),
    getManagerRoster(user, { includeTeamLead: true }),
    // قائمة مذاخر اقتراحية فقط (دفتر رصيد المذاخر) — لا تقييد، راجع buildWarehouseGapWorkbook.
    resolveLedgerScope(user).then(({ readIds }) => readIds.length ? getWarehouses(readIds) : []).catch(() => []),
  ]);

  const companies = [...new Set(userCompanies.map(c => c.company?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  const items = [...new Set(itemCatalog.map(i => i.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  const reps = [...new Set(roster.reps.map(r => r.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));

  // تضييق المذاخر على محافظة فريق المدير إن أمكن تحديدها — وإلا كل مذاخر
  // الدفتر المشترك كما كانت (احتياط آمن، لا قائمة فارغة بسبب بيانات ناقصة).
  let scopedWarehouses = ledgerWarehouses;
  const teamProvinces = await provincesForRoster(roster.reps).catch(() => []);
  if (teamProvinces.length > 0) {
    const targetKeys = teamProvinces.map(p => normalizeAreaName(p.name));
    const filtered = ledgerWarehouses.filter(w => {
      const regionKey = normalizeAreaName(w.region || '');
      return regionKey && targetKeys.some(t => regionKey.includes(t) || t.includes(regionKey));
    });
    if (filtered.length > 0) scopedWarehouses = filtered;
  }
  const warehouses = [...new Set(scopedWarehouses.map(w => w.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));

  // ربط الايتم بشركته (لعمود الشركة التلقائي في النموذج) — أول شركة لكل ايتم.
  const itemCompanyMap = new Map();
  for (const i of itemCatalog) {
    if (i.name && i.companyName && !itemCompanyMap.has(i.name)) itemCompanyMap.set(i.name, i.companyName);
  }
  const itemCompanies = [...itemCompanyMap.entries()]
    .map(([item, company]) => ({ item, company }))
    .sort((a, b) => a.item.localeCompare(b.item, 'ar'));

  // عمود «المحافظة» في كوديشن «مندوبين المحافظات» — الأسماء الرسمية كما تطابقها التقارير.
  const provinces = (await prisma.province.findMany({ select: { name: true } }).catch(() => []))
    .map(p => p.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));

  return { reps, items, companies, warehouses, itemCompanies, provinces };
}

/**
 * يبني ملف الإكسل الخاص بمستخدم واحد (Buffer جاهز للتنزيل).
 * @param {{id:number, role:string, displayName?:string, username?:string}} user
 */
export async function buildWarehouseGapTemplateForUser(user, { withProvince = false } = {}) {
  const scope = await getWarehouseGapScope(user);
  // عمود المحافظة لنموذج «مندوبين المحافظات» وحده — نموذج بغداد يبقى كما هو.
  const buffer = await buildWarehouseGapWorkbook({ ...scope, provinces: withProvince ? scope.provinces.filter(p => p.trim() !== 'بغداد') : [] });
  const who = (user.displayName || user.username || 'مستخدم').replace(/[\\/:*?"<>|]/g, '').trim();
  return { buffer, filename: `${withProvince ? 'نموذج لكوديشن المحافظات' : 'نموذج مبيعات مذاخر'} - ${who}.xlsx` };
}

/**
 * يقرأ ملف نموذج المذاخر المُعبَّأ ويُرجع صفوفاً بشكل صفوف insertManualSales —
 * بلا كتابة في قاعدة البيانات (معاينة فقط، يُستدعى قبل /api/sales/manual).
 *
 * للصفوف التي تُركت فيها "سعر الوحدة" و"القيمة الإجمالية" فارغتين معاً (لأن
 * الايتم يُختار من قائمة منسدلة، لا حاجة لمعرفة سعره يدوياً)، يُستكمل السعر من
 * Item.warehousePrice/price المسجَّل لذلك الايتم ضمن ايتمات المستخدم المعيّنة.
 * إن لم يكن له سعر مسجَّل، يبقى الحقلان فارغين مع تنبيه يطلب إدخال السعر يدوياً.
 *
 * @param {Buffer} buffer
 * @param {number|null} userId
 */
export async function parseWarehouseGapFile(buffer, userId = null) {
  const { rows, warnings, format = 'template' } = parseWarehouseGapWorkbook(buffer);
  if (format === 'tasks' && rows.length) await attachTaskProvinces(rows, warnings);
  if (rows.length === 0 || !userId) return { rows, warnings, format };

  const needsPrice   = rows.some(r => !r.unitPrice && !r.totalValue);
  const needsCompany = rows.some(r => !r.company);
  if (!needsPrice && !needsCompany) return { rows, warnings, format };

  const catalog = await getWarehouseGapItemCatalog(userId);
  const byKey = new Map(catalog.map(i => [normalizeItemKey(i.name), i]));

  // الشركة تُستكمل من الايتم إن تُركت فارغة (احتياط لو لم تُحسب الصيغة عند التعبئة)،
  // والسعر يُستكمل كما كان.
  const enriched = rows.map(r => {
    const cat = byKey.get(normalizeItemKey(r.item));
    const withCompany = !r.company && cat?.companyName ? { ...r, company: cat.companyName } : r;
    if (withCompany.unitPrice || withCompany.totalValue) return withCompany;
    const price = cat?.unitPrice;
    if (price == null) {
      warnings.push(`الايتم "${r.item}" (${r.pharmacy || 'بلا اسم صيدلية'}): لا يوجد سعر مذخر مسجَّل له — أدخل السعر يدوياً قبل الحفظ.`);
      return withCompany;
    }
    return { ...withCompany, unitPrice: price, totalValue: price * r.quantity };
  });

  return { rows: enriched, warnings, format };
}

/**
 * ملف مهام المسوقين بلا عمود محافظة: المحافظة من اسم المندوب («… - مسوقين -
 * الديوانية»، «… فارمسي الكوت»)، وإلا من اسم المذخر ثم الصيدلية — بالاسم الرسمي
 * (الكوت ← واسط) كي تُجمَّع مع مبيع المحافظة نفسها في المقارنة.
 */
async function attachTaskProvinces(rows, warnings) {
  const lookup = buildProvinceLookup(await prisma.province.findMany({ select: { id: true, name: true, aliases: true } }));
  const missing = new Set();
  for (const r of rows) {
    const p = provinceFromText(r.repName, lookup) || provinceFromText(r.warehouse, lookup) || provinceFromText(r.pharmacy, lookup);
    if (p) r.province = p.name;
    else missing.add(r.repName);
  }
  if (missing.size) {
    warnings.push(`لم تُعرف المحافظة من اسم ${missing.size} مندوب (${[...missing].slice(0, 5).join('، ')}${missing.size > 5 ? '…' : ''}) — اخترها في الجدول أو من «المحافظة لكل الصفوف الفارغة».`);
  }
}

// ─── مبيعات يدوية داخل ملف ميركاتو: كتابة القيم تحت ترويسات الملف الفعلية ───
// كانت الصفوف اليدوية تحمل مفاتيح إنجليزية (invoiceNumber/warehouse/…) فتظهر في
// محرّر ملف ميركاتو أعمدةً فارغة: رقم طلبية المذخر وحالتها والمذخر والبونص
// والسعر واسم المادة بالمكتب كلها فارغة، والمندوب «وليد» (حساب الكروب) لا العلمي
// المختار. الآن تُكتب القيم تحت **ترويسات الملف نفسه** (تُقرأ من صفوفه الأصلية).
const MERCATO_DEFAULT_HEADERS = {
  orderNumber: 'رقم طلبية المذخر', orderStatus: 'حالة طلبية المذخر', date: 'أنشات بتاريخ',
  customer: 'اسم الشركة', area: 'المنطقة', repName: 'اسم المندوب', company: 'الصنف',
  item: 'اسم المادة بالمكتب', quantity: 'الكمية', bonusQty: 'كمية البونص', unitPrice: 'السعر',
  totalValue: 'المجموع الكلي', warehouse: 'اسم المذخر',
};
/** حالة طلبية المذخر لكل الفواتير المحلَّلة — «جاهزة للتسليم» تُحتسب مبيعاً في رصيد المذاخر. */
/**
 * فهرس أسماء المندوبين الموجودين فعلاً في الملف. المندوب العلمي المختار عند التحليل
 * يُكتب غالباً مختصراً («حسين قحطان») بينما الملف يحمل الاسم كما يسجّله ميركاتو
 * («حسين قحطان العبيدي») — فيظهر الاسمان كمندوبَين مختلفَين في الملف ذاته.
 */
export async function loadFileRepIndex(fileId) {
  if (!fileId) return null;
  const groups = await prisma.sale.groupBy({ by: ['representativeId'], where: { uploadedFileId: Number(fileId) } });
  const ids = groups.map(g => g.representativeId).filter(Boolean);
  if (!ids.length) return null;
  const reps = await prisma.medicalRepresentative.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return reps.length ? buildRepIndex(reps) : null;
}

/** الاسم المطابق في الملف إن وُجد مرشّح واحد بلا لبس، وإلا الاسم كما هو. */
export function alignRepToFile(name, index) {
  const core = repCoreName(String(name ?? '')) || String(name ?? '').trim();
  if (!core || !index) return core;
  const m = matchRepName(core, index);
  if (m.status === 'exact' && m.rep?.name) return m.rep.name;
  // «حسين قحطان» ⊂ «حسين قحطان العبيدي»: matchRepName يُعيد 'ask' باقتراحات. نحسم
  // تلقائياً فقط حين يتفرّد مرشّح (أو يتطابق الاسم الأول والثاني حرفياً كحسابين لنفس
  // الشخص)، أما لبس بين شخصين مختلفين فيبقى الاسم كما اختاره المراجِع.
  const top = (m.suggestions || []).filter(x => x.score >= 0.7);
  if (!top.length) return core;
  const names = new Set(top.map(x => normalizeItemKey(x.name)));
  const lead = top[0], second = top.find(x => normalizeItemKey(x.name) !== normalizeItemKey(lead.name));
  if (names.size === 1 || !second || lead.score - second.score >= 0.15) return lead.name;
  return core;
}

/**
 * هل rawData.source يخصّ صفاً أُدخل يدوياً أو من فاتورة/طلبية؟ المسار اليدوي يكتب
 * 'manual-invoice' أما طلبيات البوت فتكتب 'telegram-order' / 'viber-order'
 * (ManualSalesModal يضيف اللاحقة -order). الاقتصار على القيمة الأولى كان يُسقط
 * صفوف البوت من ترجمة أعمدة المحرّر ومن التصدير ومن الترحيل.
 */
// 'warehouse-gap-template' = صفوف إكسل الكوديشن (WarehouseGapImportModal) — نفس
// المفاتيح الإنجليزية المساعدة، فتُعامَل مثلها في المحرّر واكتشاف الترويسات.
export const isManualInvoiceSource = (src) => src === 'manual-invoice' || src === 'warehouse-gap-template' || /-order$/.test(String(src ?? ''));

export const MERCATO_READY_STATUS = 'جاهزة للتسليم';

/** ترويسات ميركاتو للملف الهدف، أو null إن لم يكن ملف ميركاتو. */
export async function resolveMercatoHeaders(target, userId) {
  let sourceSystem = (target.sourceSystem === 'mercato' || target.condition) ? 'mercato' : null;
  const keys = [];
  if (target.fileId) {
    const file = await prisma.uploadedFile.findFirst({
      where: { id: Number(target.fileId), userId }, select: { id: true, sourceSystem: true },
    });
    if (!file) return null; // يُرفض لاحقاً بخطأ «الملف غير موجود»
    sourceSystem = file.sourceSystem || sourceSystem;
    const sample = await prisma.sale.findMany({
      where: { uploadedFileId: file.id }, select: { rawData: true }, orderBy: { id: 'asc' }, take: 60,
    });
    const seen = new Set();
    for (const row of sample) {
      let raw; try { raw = JSON.parse(row.rawData || '{}'); } catch { continue; }
      if (isManualInvoiceSource(raw?.source)) continue; // مفاتيحنا لا تُحدّد الترويسات
      for (const k of Object.keys(raw)) if (!k.startsWith('_') && !seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  const isMercato = sourceSystem === 'mercato' || (keys.length > 0 && detectMercatoFormat(keys));
  if (!isMercato) return null;
  const found = keys.length ? mercatoColumnMap(keys) : {};
  const warehouseKey = keys.find(h => _mHas(h, 'اسم', 'مذخر') && !_mHas(h, 'رقم') && !_mHas(h, 'حال'));
  if (warehouseKey) found.warehouse = warehouseKey;
  return { ...MERCATO_DEFAULT_HEADERS, ...found };
}

/**
 * Persist manual / invoice-extracted sale rows as Sale records — merged into an
 * existing UploadedFile or into a new one. Reuses the same normalization,
 * entity-resolution and rep auto-assignment as the Excel upload path.
 *
 * @param {object}   opts
 * @param {object[]} opts.rows   flat rows: { repName, item, company?, quantity, totalValue, unitPrice?, pharmacy?, warehouse?, area?, date?, invoiceNumber?, bonus? }
 * @param {object}   opts.target { fileId?: number } | { newFileName?: string, sourceCurrency?: 'IQD'|'USD' }
 * @param {number|null} opts.userId
 * @param {string|null} opts.uploadedBy
 */
export async function insertManualSales({ rows, target = {}, userId = null, uploadedBy = null, rememberItems = [] }) {
  const normalizeAr = s => String(s ?? '')
    .trim()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const mercato = await resolveMercatoHeaders(target, userId);
  // ملف الكوديشن يُطابق أسماء المندوبين بملف ميركاتو الشقيق (هو من يحمل الأسماء
  // كما يسجّلها ميركاتو)، وإلا ظهر «حسين قحطان» و«حسين قحطان العبيدي» مندوبَين.
  const repIndexFileId = target.fileId || (target.condition && userId
    ? (await prisma.uploadedFile.findFirst({
        where: { userId, sourceSystem: 'mercato', isCumulative: true, NOT: { mergeGroup: { endsWith: `|${CONDITION_VARIANT}` } } },
        orderBy: { id: 'asc' }, select: { id: true },
      }))?.id
    : null);
  const fileRepIndex = (mercato && repIndexFileId) ? await loadFileRepIndex(repIndexFileId).catch(() => null) : null;

  // ── 1. Coerce + validate incoming rows ──
  const validRows = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const quantity  = Math.abs(Number(r.quantity) || 0);
    const unitPrice = Number(r.unitPrice) || 0;
    let totalValue  = Math.abs(Number(r.totalValue) || 0);
    if (!totalValue && unitPrice) totalValue = quantity * unitPrice; // derive if only unit price given
    const itemName = String(r.item ?? '').trim();
    if (!itemName || quantity === 0) continue; // every row needs at least an item + quantity

    // ملف ميركاتو: «اسم المندوب» = المندوب العلمي المختار عند التحليل (لا حساب الكروب).
    // أسماء الحسابات تحمل لاحقة «/ المنطقة ph» فتُسقَط.
    const sciRep = r.scientificRep ? alignRepToFile(r.scientificRep, fileRepIndex) : '';
    const repForRow = (mercato && sciRep) ? sciRep : r.repName;
    const mercatoRaw = {};
    if (mercato) {
      const h = mercato;
      const d = r.date ? parseExcelDate(r.date) : null;
      const cleanPharmacy = r.pharmacy ? cleanPharmacyName(r.pharmacy) : '';
      const price = unitPrice || (quantity ? Math.round((totalValue / quantity) * 100) / 100 : 0);
      mercatoRaw[h.orderNumber] = r.invoiceNumber ?? '';
      mercatoRaw[h.orderStatus] = MERCATO_READY_STATUS;
      mercatoRaw[h.date]        = d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
      mercatoRaw[h.customer]    = cleanPharmacy;   // «اسم الشركة» في ميركاتو = الصيدلية المشترية
      mercatoRaw[h.area]        = r.area ?? '';
      mercatoRaw[h.repName]     = repForRow ?? '';
      mercatoRaw[h.company]     = r.company || ''; // «الصنف» = الشركة المصنّعة لا اسم المادة
      mercatoRaw[h.item]        = itemName;        // «اسم المادة بالمكتب»
      mercatoRaw[h.quantity]    = quantity;
      mercatoRaw[h.bonusQty]    = Number(r.bonus) || 0; // 0 حين لا بونص
      mercatoRaw[h.unitPrice]   = price || '';
      mercatoRaw[h.totalValue]  = totalValue;
      mercatoRaw[h.warehouse]   = r.warehouse ?? '';
      mercatoRaw._mercatoShaped = true;
    }

    const rawData = JSON.stringify({
      ...mercatoRaw,
      invoiceNumber: r.invoiceNumber ?? null,
      warehouse:     r.warehouse ?? null,
      pharmacy:      r.pharmacy ?? null,
      unitPrice:     unitPrice || null,
      bonus:         r.bonus ?? null,
      company:       r.company ?? null,
      notes:         r.notes ?? null,
      // المندوب العلمي صاحب الطلبية (من طلبيات البوت) — لا عمود مُهيكَل له في
      // Sale، فيُحفَظ في rawData كبقية حقول الفاتورة (المذخر/البونص/رقم الفاتورة).
      scientificRep: r.scientificRep ?? null,
      // محافظة الصف (كوديشن «مندوبين المحافظات») — التقارير تقرأ مفتاح province حين
      // لا محافظة لمنطقة الصف (resolveRawProvinceName / loadProvinceResolver).
      province:      String(r.province ?? '').trim() || null,
      source:        r.source || 'manual-invoice',
    });

    const areaNorm = normalizeAr(r.area);
    validRows.push({
      itemId:   Number.isInteger(Number(r.itemId)) && Number(r.itemId) > 0 ? Number(r.itemId) : null,
      repName:  normalizeAr(repForRow) || 'غير محدد',
      area:     areaNorm || 'غير محدد',
      // تملأ محافظة منطقة جديدة/بلا محافظة فقط (findOrCreateArea لا يكتب فوق محافظة
      // محفوظة). بلا منطقة لا تُمرَّر، وإلا أُسندت المحافظة لمنطقة «غير محدد» المشتركة.
      province: areaNorm ? (String(r.province ?? '').trim() || undefined) : undefined,
      item:     normalizeAr(itemName),
      company:  (r.company && !isPlaceholderCompanyValue(r.company)) ? normalizeAr(r.company) : undefined,
      customer: r.pharmacy ? normalizeAr(cleanPharmacyName(r.pharmacy)) : undefined, // pharmacy = buyer = Customer (strip prefixes)
      quantity,
      totalValue,
      date:     r.date ? parseExcelDate(r.date) : undefined,
      rawData,
    });
  }

  if (validRows.length === 0) {
    throw new AppError('لا توجد صفوف صالحة للحفظ — كل صف يحتاج اسم مادة وكمية أكبر من صفر.', 422, 'NO_VALID_MANUAL_ROWS');
  }

  // ── 2. Company fuzzy-normalization (same as _finishProcessing) ──
  let sciCompanyIds = [];
  if (userId) {
    const userCompanies = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    sciCompanyIds = userCompanies.map(c => c.companyId);
    const existingCompanies = await getAllCompanies(userId);
    const incomingCompanies = [...new Set(validRows.map(r => r.company).filter(Boolean))];
    const companyDedup = buildNormalizationMap(incomingCompanies, existingCompanies.map(c => c.name), 'company');
    if (companyDedup.log.length > 0) {
      for (const row of validRows) {
        if (row.company && companyDedup.map[row.company]) row.company = companyDedup.map[row.company];
      }
    }
  }

  // ايتم اختاره المستخدم بمعرّفه من كتالوج المكتب («مطابقة الأسماء» في لكوديشن
  // المحافظات) يُحفَظ عليه حرفياً — المطابقة بالاسم قد تقع على ايتم مكرَّر الاسم في
  // شركة أخرى، أو على ايتم خارج شركات الرافع فيُنشأ مؤقتاً ويسقط من المقارنة.
  // يُقبل فقط ايتم كتالوج حقيقي من شركات الرافع أو مكتبه.
  const pickedIds = [...new Set(validRows.map(r => r.itemId).filter(Boolean))];
  if (pickedIds.length) {
    const officeId = userId ? (await prisma.user.findUnique({ where: { id: userId }, select: { officeId: true } }))?.officeId ?? null : null;
    const ok = new Set((await prisma.item.findMany({
      where: {
        id: { in: pickedIds }, isTemp: false,
        OR: [
          { scientificCompanyId: { in: sciCompanyIds } },
          ...(officeId != null ? [{ scientificCompany: { officeId } }] : []),
        ],
      },
      select: { id: true },
    })).map(i => i.id));
    for (const r of validRows) if (r.itemId && !ok.has(r.itemId)) r.itemId = null;
  }
  const itemIdOf = r => r.itemId ?? itemMap[r.item];

  // ── 3. Resolve/create entities (de-duped) ──
  // المحافظة تُكتب على Area لا على Sale — تُشتق لاحقاً عبر Area.provinceId
  const areaProvinceMap = await buildAreaProvinceMap(validRows);
  const uniqueAreas     = [...new Set(validRows.map(r => r.area))];
  // صف بمعرّف ايتم محسوم لا يُطابَق بالاسم (وإلا أُنشئ له ايتم مؤقت بلا داعٍ).
  const uniqueItems     = [...new Set(validRows.filter(r => !r.itemId).map(r => r.item))];
  const uniqueReps      = [...new Set(validRows.map(r => r.repName))];
  const uniqueCustomers = [...new Set(validRows.map(r => r.customer).filter(Boolean))];
  const uniqueCompanies = [...new Set(validRows.map(r => r.company).filter(Boolean))];

  const itemCtx = sciCompanyIds.length > 0
    ? await loadResolutionContext({ scientificCompanyIds: sciCompanyIds, userId })
    : null;

  const [areaMap, itemMap, repMap, customerMap, companyMap] = await Promise.all([
    resolveEntities(uniqueAreas,     name => findOrCreateArea(name, userId, areaProvinceMap[name] ?? null)),
    resolveEntities(uniqueItems,     name => findOrCreateItem(name, userId, sciCompanyIds, itemCtx)),
    resolveEntities(uniqueReps,      name => findOrCreateRep(name, userId)),
    resolveEntities(uniqueCustomers, name => findOrCreateCustomer(name, userId)),
    resolveEntities(uniqueCompanies, name => findOrCreateCompany(name, userId)),
  ]);

  // Track temp/unknown items (catalog users only)
  const unknownItems = [];
  if (sciCompanyIds.length > 0) {
    const resolvedItemIds = Object.values(itemMap).filter(Boolean);
    const tempItems = await prisma.item.findMany({ where: { id: { in: resolvedItemIds }, isTemp: true }, select: { name: true } });
    unknownItems.push(...tempItems.map(i => i.name));
  }

  // Link each item to its company (first row that maps item → company)
  if (uniqueCompanies.length > 0) {
    const itemCompanyMap = {};
    for (const row of validRows) {
      if (row.company && row.item && !itemCompanyMap[row.item]) itemCompanyMap[row.item] = row.company;
    }
    await Promise.all(Object.entries(itemCompanyMap).map(([itemName, companyName]) => {
      const itemId = itemMap[itemName], companyId = companyMap[companyName];
      if (itemId && companyId) return prisma.item.updateMany({ where: { id: itemId, companyId: null }, data: { companyId } });
    }).filter(Boolean));
  }

  // ── 4. Currency ──
  let detectedCurrency;
  if (target.sourceCurrency === 'IQD' || target.sourceCurrency === 'USD') {
    detectedCurrency = target.sourceCurrency;
  } else {
    const nonZero = validRows.map(r => r.totalValue || 0).filter(v => v > 0).sort((a, b) => a - b);
    const median = nonZero.length ? nonZero[Math.floor(nonZero.length / 2)] : 0;
    detectedCurrency = median >= 100000 ? 'IQD' : 'USD';
  }

  // ── 5. Resolve destination file (existing → merge, else create new) ──
  let uploadedFile;
  let merged = false;
  if (target.condition && !target.fileId) {
    // ملف الكوديشن: حاوية تراكمية واحدة لكل (حساب × عملة)، مصدرها ميركاتو كي
    // تُحتسب في كل مؤشرات ميركاتو، لكنها تُفعَّل/تُعطَّل وحدها.
    ({ file: uploadedFile } = await resolveCumulativeTarget({
      userId, sourceSystem: 'mercato', detectedCurrency, variant: CONDITION_VARIANT,
    }));
    merged = true;
  } else if (target.fileId) {
    uploadedFile = await prisma.uploadedFile.findFirst({ where: { id: Number(target.fileId), userId } });
    if (!uploadedFile) throw new AppError('الملف المحدد غير موجود أو لا يخصّك.', 404, 'FILE_NOT_FOUND');
    merged = true;
  } else {
    const name = String(target.newFileName || '').trim() || `مبيعات يدوية ${new Date().toLocaleDateString('en-GB')}`;
    uploadedFile = await createUploadedFile({
      filename:         `${Date.now()}_manual`,
      originalName:     name,
      rowCount:         validRows.length,
      uploadedBy:       uploadedBy || null,
      userId,
      fileType:         'sales',
      detectedCurrency,
      currencyMode:     detectedCurrency,
      // مبيعات مذاخر أُدخلت لتعويض نقص ملف ميركاتو تُعلَّم sourceSystem='mercato'
      // صراحةً كي تُحتسب مع بقية ملفات ميركاتو في كل تقارير المناديب العلميين
      // (bySource.mercato في scientific-reps.service.js) بدل أن تُحسب "مكتب".
      sourceSystem:     target.sourceSystem === 'mercato' ? 'mercato' : null,
    });
  }

  // ── 6. Bulk insert (all treated as sales) ──
  const built = validRows.map(r => ({
    representativeId: repMap[r.repName],
    areaId:           areaMap[r.area],
    itemId:           itemIdOf(r),
    customerId:       r.customer ? (customerMap[r.customer] ?? null) : null,
    quantity:         r.quantity,
    totalValue:       r.totalValue,
    saleDate:         r.date ?? null,
    rawData:          r.rawData,
  }));

  // الإدخال اليدوي/فاتورة الصورة داخل ملف تراكمي يمرّ بنفس بوّابة منع التكرار:
  // نفس الفاتورة إن حُفظت مرتين (تبويب أُعيد إرساله، أو طلبية بوت رُوجعت مرتين)
  // تُسقَط صفوفها الثانية بدل أن تُضاعف المبيع. rawData هنا يحمل invoiceNumber
  // وpharmacy بمفاتيح إنجليزية، وهي ضمن أسماء البصمة البديلة أصلاً.
  let manualAdded = built.length;
  let manualSkipped = 0;
  if (uploadedFile.isCumulative) {
    const batch = await openMergeBatch({
      fileId:       uploadedFile.id,
      originalName: `إدخال يدوي — ${new Date().toLocaleDateString('en-GB')}`,
      uploadedBy:   uploadedBy || null,
      fileType:     'sales',
    });
    const res = await appendRowsToCumulative({ fileId: uploadedFile.id, batchId: batch.id, saleRows: built, userId });
    await closeMergeBatch(batch.id, { rowsAdded: res.added, rowsSkipped: res.skipped, monthsLabel: res.monthsLabel });
    await refreshCumulativeFile(uploadedFile.id);
    manualAdded = res.added;
    manualSkipped = res.skipped;
  } else {
    await bulkCreateSales(built, uploadedFile.id, userId, 'sale');
  }

  // ── 7. Auto-assign areas & items to each rep ──
  const repAreaPairs = [...new Map(validRows.map(r => [`${repMap[r.repName]}-${areaMap[r.area]}`, { representativeId: repMap[r.repName], areaId: areaMap[r.area] }])).values()];
  const repItemPairs = [...new Map(validRows.map(r => [`${repMap[r.repName]}-${itemIdOf(r)}`, { representativeId: repMap[r.repName], itemId: itemIdOf(r) }])).values()];
  await Promise.all([
    repAreaPairs.length > 0
      ? prisma.representativeArea.createMany({ data: repAreaPairs, skipDuplicates: true })
      : Promise.resolve(),
    repItemPairs.length > 0
      ? prisma.representativeItem.createMany({ data: repItemPairs, skipDuplicates: true })
      : Promise.resolve(),
  ]);

  // ── 7ب. ربط المندوبين التجاريين الجدد بأي مندوب علمي مناطقه تتقاطع معهم ──
  // بلا هذا، صفوف تُضاف إلى ملف مفعّل أصلاً تبقى غائبة عن «تحليل المندوبين
  // العلميين» حتى يُعاد تفعيل/تعطيل ملف ما (وهو ما يُطلق المزامنة الكاملة
  // في الواجهة) — إضافة فقط، لا تحذف أي رابط قائم.
  await syncCommercialsForNewSales(repAreaPairs).catch(() => {}); // لا يُفشل الحفظ لو تعذّرت المزامنة

  // Merging into an existing file → keep its rowCount accurate.
  // الملف التراكمي حُدِّث عدده فعلياً في refreshCumulativeFile أعلاه (عدّ حقيقي
  // لا زيادة عمياء)، فزيادته هنا كانت ستحتسب حتى الصفوف المُسقطة كمكررة.
  if (merged && !uploadedFile.isCumulative) {
    await prisma.uploadedFile
      .update({ where: { id: uploadedFile.id }, data: { rowCount: { increment: validRows.length } } })
      .catch(() => {});
  }

  // ── 8. حفظ قرارات التوحيد التي أكّدها المستخدم ──
  // «هذا الاسم هو نفسه ذاك» يُسأل مرة واحدة فقط: القاعدة تُخزَّن بنطاق الشركة
  // العلمية للايتم الهدف، فتصير المطابقة تالياً بثقة alias بلا سؤال — في هذا
  // المسار وفي رفع الإكسل معاً.
  let rememberedCount = 0;
  for (const link of (Array.isArray(rememberItems) ? rememberItems : [])) {
    const toItemId = Number(link?.toItemId);
    const fromKey  = normalizeItemKey(link?.from ?? '');
    if (!fromKey || !Number.isFinite(toItemId)) continue;
    const target = await prisma.item.findUnique({
      where: { id: toItemId }, select: { id: true, name: true, scientificCompanyId: true },
    });
    // بلا شركة علمية لا نطاق للقاعدة — نتخطّاها بدل كتابة قاعدة عامة تخصّ الجميع
    if (!target?.scientificCompanyId) continue;
    if (normalizeItemKey(target.name) === fromKey) continue; // الاسمان متطابقان أصلاً
    await prisma.itemMergeRule.upsert({
      where:  { scientificCompanyId_fromKey: { scientificCompanyId: target.scientificCompanyId, fromKey } },
      update: { fromName: String(link.from), toName: target.name, toItemId: target.id },
      create: { scientificCompanyId: target.scientificCompanyId, fromKey, fromName: String(link.from), toName: target.name, toItemId: target.id, userId },
    }).catch(() => {}); // تذكّر القرار رفاهية — لا يُفشل حفظ المبيعات
    rememberedCount++;
  }

  return {
    addedCount:   manualAdded,
    skippedCount: manualSkipped,
    merged,
    unknownItems,
    rememberedCount,
    // الايتمات المحفوظة — لمشاركة ملف الكوديشن مع من أُسنِدت لهم (طلبيات البوت).
    itemIds: [...new Set(validRows.map(itemIdOf).filter(Boolean))],
    uploadedFile: { id: uploadedFile.id, originalName: uploadedFile.originalName, isCumulative: uploadedFile.isCumulative ?? false },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// تعديل صف داخل «ملف الكوديشن» (كل الخانات) وحذفه — للمالك ولمن شورك الملف معه
// من غير المندوبين (مدير الشركة/التيم ليدر/المكتب). الكيانات الجديدة (ايتم،
// صيدلية، منطقة، مندوب) تُنشأ باسم **مالك الملف** لا المُعدِّل — المنطقة لكل حساب،
// ومنطقة باسم المُعدِّل كانت ستُخرج الصف من تقارير الحساب المالك.
// الصف مخزَّن بشكلين متزامنين: أعمدة Sale (كمية/قيمة/تاريخ/ايتم/منطقة/زبون/مندوب)
// وrawData (مفاتيح إنجليزية + ترويسات ميركاتو). التعديل يُحدّث الاثنين معاً، وإلا
// عرض المحرّر/التصدير يقرأ rawData فيُظهر القيمة القديمة. dedupKey لا يُمسّ عمداً:
// تغييره كان سيُسقط الصف أو يُكرّره عند إعادة إدخال الأصل.
// ═══════════════════════════════════════════════════════════════════════════

const CONDITION_READONLY_ROLES = new Set(['scientific_rep', 'commercial_rep']);

/** هل يعدّل هذا المستخدم ملف الكوديشن؟ المالك، أو مَن شورك معه وليس مندوباً. */
export async function canEditConditionFile(fileId, user) {
  if (!user?.id) return false;
  const file = await prisma.uploadedFile.findFirst({
    where: { id: fileId, OR: [{ userId: user.id }, { fileShares: { some: { userId: user.id } } }] },
    select: { userId: true, mergeGroup: true },
  });
  if (!file || !String(file.mergeGroup || '').endsWith(`|${CONDITION_VARIANT}`)) return false;
  return file.userId === user.id || !CONDITION_READONLY_ROLES.has(user.role);
}

async function loadEditableConditionRow(fileId, saleId, user) {
  if (!(await canEditConditionFile(fileId, user))) {
    throw new AppError('ملف اللكوديشن غير موجود أو لا تملك تعديله.', 404, 'FILE_NOT_FOUND');
  }
  const sale = await prisma.sale.findFirst({ where: { id: saleId, uploadedFileId: fileId } });
  if (!sale) throw new AppError('الصف غير موجود.', 404, 'ROW_NOT_FOUND');
  const { userId: ownerId } = await prisma.uploadedFile.findUnique({ where: { id: fileId }, select: { userId: true } });
  return { sale, ownerId };
}

export async function updateConditionRow({ fileId, saleId, user, fields }) {
  const { sale, ownerId } = await loadEditableConditionRow(fileId, saleId, user);
  const userId = ownerId; // الكيانات الجديدة باسم المالك (راجع أعلاه)
  const f = fields || {};
  const has = k => Object.prototype.hasOwnProperty.call(f, k);
  const str = k => String(f[k] ?? '').trim();
  const numOf = k => { const n = Number(String(f[k] ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

  let raw = {}; try { raw = JSON.parse(sale.rawData || '{}') || {}; } catch { /* */ }
  const h = await resolveMercatoHeaders({ fileId }, userId);
  const data = {};
  const setRaw = (key, val) => { raw[key] = val; };

  // الكمية والقيمة والسعر
  let qty = sale.quantity, total = sale.totalValue;
  if (has('quantity')) { const n = numOf('quantity'); if (n == null || n <= 0) throw new AppError('الكمية يجب أن تكون أكبر من صفر.', 422, 'BAD_QTY'); qty = n; data.quantity = n; }
  if (has('total'))    { const n = numOf('total');    if (n == null || n < 0)  throw new AppError('القيمة غير صالحة.', 422, 'BAD_TOTAL'); total = n; data.totalValue = n; }
  if (has('unitPrice') && !has('total')) {
    const n = numOf('unitPrice');
    if (n == null || n < 0) throw new AppError('السعر غير صالح.', 422, 'BAD_PRICE');
    total = Math.round(n * qty * 100) / 100; data.totalValue = total;
  }
  if (has('quantity') || has('total') || has('unitPrice')) {
    const price = has('unitPrice') ? numOf('unitPrice') : (qty ? Math.round((total / qty) * 100) / 100 : 0);
    raw.unitPrice = price || null;
    if (h) { setRaw(h.quantity, qty); setRaw(h.totalValue, total); setRaw(h.unitPrice, price || ''); }
  }
  if (has('bonus')) { const n = numOf('bonus') ?? 0; raw.bonus = n; if (h) setRaw(h.bonusQty, n); }

  // التاريخ
  if (has('date')) {
    const v = str('date');
    const d = v ? parseExcelDate(v) : null;
    if (v && !(d instanceof Date && !isNaN(d))) throw new AppError('التاريخ غير صالح.', 422, 'BAD_DATE');
    data.saleDate = d ?? UNDATED_SENTINEL;
    if (h) setRaw(h.date, d ? d.toISOString().slice(0, 10) : '');
  }
  if (has('invoice'))   { raw.invoiceNumber = str('invoice') || null; if (h) setRaw(h.orderNumber, str('invoice')); }
  if (has('warehouse')) { raw.warehouse = str('warehouse') || null;   if (h) setRaw(h.warehouse, str('warehouse')); }
  if (has('company'))   { raw.company = str('company') || null; }

  // الكيانات
  if (has('item')) {
    const name = str('item');
    if (!name) throw new AppError('اسم الايتم مطلوب.', 422, 'BAD_ITEM');
    // شركات المالك والمُعدِّل معاً: حساب الكروب المالك قد لا تُسنَد له شركات.
    const userCompanies = await prisma.userCompanyAssignment.findMany({ where: { userId: { in: [userId, user.id] } }, select: { companyId: true } });
    const ids = [...new Set(userCompanies.map(c => c.companyId))];
    const ctx = ids.length ? await loadResolutionContext({ scientificCompanyIds: ids, userId }) : null;
    const item = await findOrCreateItem(name, userId, ids, ctx);
    data.itemId = item.id;
    if (h) { setRaw(h.item, item.name); setRaw(h.company, item.name); }
  }
  if (has('pharmacy')) {
    const name = cleanPharmacyName(str('pharmacy'));
    raw.pharmacy = name || null;
    data.customerId = name ? (await findOrCreateCustomer(name, userId)).id : null;
    if (h) setRaw(h.customer, name);
  }
  if (has('area')) {
    const name = str('area');
    const a = await findOrCreateArea(name || 'غير محدد', userId, null);
    data.areaId = a.id;
    if (h) setRaw(h.area, name);
  }
  if (has('rep')) {
    const name = str('rep');
    if (!name) throw new AppError('اسم المندوب مطلوب.', 422, 'BAD_REP');
    const idx = await loadFileRepIndex(fileId).catch(() => null);
    const aligned = alignRepToFile(name, idx) || name;
    raw.scientificRep = aligned;
    data.representativeId = (await findOrCreateRep(aligned, userId)).id;
    if (h) setRaw(h.repName, aligned);
  }

  data.rawData = JSON.stringify(raw);
  await prisma.sale.update({ where: { id: saleId }, data });
  return { id: saleId };
}

export async function deleteConditionRow({ fileId, saleId, user }) {
  await loadEditableConditionRow(fileId, saleId, user);
  await prisma.sale.delete({ where: { id: saleId } });
  await refreshCumulativeFile(fileId);
  return { id: saleId };
}
