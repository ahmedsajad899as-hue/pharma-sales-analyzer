/**
 * Sales Service
 * Business logic for parsing Excel files and inserting sales data.
 * Orchestrates repository calls — no direct DB access here.
 */

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
} from './sales.repository.js';
import { buildNormalizationMap } from '../../lib/fuzzyMatch.js';
import { ExcelRowSchema } from './sales.dto.js';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';

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
const COLUMN_ALIASES = {
  repName:    [
    'representative name', 'rep name', 'rep', 'sales rep', 'salesman', 'agent',
    'مندوب', 'اسم المندوب', 'المندوب', 'اسم الممثل', 'الممثل', 'البائع',
    'اسم البائع', 'موظف المبيعات', 'مندوب المبيعات',
  ],
  area:       [
    'area', 'region', 'territory', 'zone', 'city', 'location', 'district',
    'منطقة', 'المنطقة', 'المدينة', 'مدينة', 'المنطقه', 'منطقه',
    'المحافظة', 'محافظة', 'الفرع', 'فرع', 'الموقع',
  ],
  item:       [
    'item', 'drug', 'product', 'medicine', 'brand', 'trade name', 'item name',
    'product name', 'drug name',
    'صنف', 'الصنف', 'مادة', 'دواء', 'منتج', 'المنتج', 'اسم المنتج',
    'اسم الدواء', 'اسم الصنف', 'الدواء', 'المادة', 'اسم العلاج', 'بند',
    'الايتم', 'ايتم', 'آيتم', 'الآيتم', 'اسم المادة', 'اسم الدواء', 'المستحضر',
    'اسم المستحضر', 'اسم الايتم', 'Item Name', 'material', 'name of item',
  ],
  quantity:   [
    'quantity', 'qty', 'units', 'boxes', 'packs', 'count', 'no', 'pieces',
    'كمية', 'الكمية', 'عدد', 'العدد', 'الوحدات', 'عدد الوحدات',
    'كميه', 'الكميه', 'حجم', 'الحجم',
  ],
  totalValue: [
    'total value', 'totalvalue', 'value', 'total', 'amount',
    'sales value', 'net value', 'net amount', 'total sales', 'revenue',
    'قيمة المبيعات', 'إجمالي المبيعات', 'اجمالي المبيعات',
    'القيمة الإجمالية', 'قيمة الطلب', 'الإجمالي', 'إجمالي', 'اجمالي',
    'قيمة', 'القيمة', 'قيمه', 'القيمه',
    'المجموع الكلي', 'مجموع كلي', 'المجموع', 'مجموع', 'الإجمالي الكلي',
    'اجمالي كلي', 'total amount', 'grand total', 'net total',
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
  const { uploadedBy, columnMapping = {}, userId = null, fileType = 'sales', sourceCurrency = null } = options;

  // ── 0. filter_page — just store the file, skip all sales processing ──────────
  if (fileType === 'filter_page') {
    const fileBuffer = file.buffer || readFileSync(file.path);
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    ensureExcelUploadsDir();
    const safeOriginalName = originalName.replace(/[^a-zA-Z0-9\u0600-\u06FF._-]/g, '_');
    const savedFilename = `${Date.now()}_${safeOriginalName}`;
    const savedFilePath = path.join(EXCEL_UPLOADS_DIR, savedFilename);
    try { writeFileSync(savedFilePath, fileBuffer); } catch (e) {
      console.warn('[upload] could not save filter_page file to disk:', e.message);
    }
    const uploadedFile = await createUploadedFile({
      filename:     savedFilename,
      originalName: originalName,
      rowCount:     0,
      uploadedBy:   uploadedBy || null,
      userId,
      fileType:     'filter_page',
    });
    return { rowCount: 0, skipped: 0, uploadedFile, normalizationLog: [] };
  }

  // ── 1. Parse workbook ────────────────────────────────────
  const fileBuffer = file.buffer || readFileSync(file.path);
  const workbook   = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });

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
    // Single-sheet: always use first sheet
    sheetsToProcess.push({ sheetName: workbook.SheetNames[0], forceReturn: false });
  }

  // Collect all raw rows with their sheet-level return flag + per-sheet colMap
  const allRawEntries = [];
  let totalRows = 0;
  for (const { sheetName, forceReturn } of sheetsToProcess) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    if (rows.length === 0) continue;
    // Resolve columns independently per sheet (each sheet may have different header names)
    const sheetHeaders = Object.keys(rows[0]);
    const sheetColMap  = resolveColumns(sheetHeaders, columnMapping);
    console.log(`[upload] Sheet: "${sheetName}" | forceReturn=${forceReturn} | rows=${rows.length} | cols:`, sheetColMap);
    for (const row of rows) allRawEntries.push({ raw: row, forceReturn, colMap: sheetColMap });
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
      rowRecordType = fileType === 'returns' ? 'return' : 'sale';
    }

    const parsed = {
      repName:    String(raw[rc.repName]    || '').trim() || 'غير محدد',
      area:       String(raw[rc.area]       || '').trim() || 'غير محدد',
      item:       String(raw[rc.item]       || '').trim() || 'غير محدد',
      company:    (String(raw[rc.company]   || '').trim()) || undefined,
      quantity:   qty,
      totalValue: totalVal,
      customer:   (String(raw[rc.customer] || '').trim()) || undefined,
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
  return _finishProcessing({ salesRows, returnsRows, skippedRows, file, uploadedBy, userId, fileType, sourceCurrency });
}

// ─── _finishProcessing ─────────────────────────────────────────────────────────
// Everything from fuzzy normalisation to bulk insert — shared by both the
// standard tabular path and the matrix (cross-tabular) path.
async function _finishProcessing({ salesRows, returnsRows, skippedRows, file, uploadedBy, userId, fileType, sourceCurrency }) {
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

  const uniqueAreas     = [...new Set(validRows.map(r => r.area))];
  const uniqueItems     = [...new Set(validRows.map(r => r.item))];
  const uniqueReps      = [...new Set(validRows.map(r => r.repName))];
  const uniqueCustomers = [...new Set(validRows.map(r => r.customer).filter(Boolean))];
  const uniqueCompanies = [...new Set(validRows.map(r => r.company).filter(Boolean))];

  const [areaMap, itemMap, repMap, customerMap, companyMap] = await Promise.all([
    resolveEntities(uniqueAreas,     name => findOrCreateArea(name, userId)),
    resolveEntities(uniqueItems,     name => findOrCreateItem(name, userId, sciCompanyIds)),
    resolveEntities(uniqueReps,      name => findOrCreateRep(name, userId)),
    resolveEntities(uniqueCustomers, name => findOrCreateCustomer(name, userId)),
    resolveEntities(uniqueCompanies, name => findOrCreateCompany(name, userId)),
  ]);

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
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const storedFileType = fileType === 'auto'
    ? (salesRows.length > 0 && returnsRows.length > 0 ? 'auto' : returnsRows.length > 0 ? 'returns' : 'sales')
    : (fileType === 'matrix' ? 'sales' : fileType);

  // ── Save original file to disk so we can serve it later ──
  ensureExcelUploadsDir();
  const safeOriginalName = originalName.replace(/[^a-zA-Z0-9\u0600-\u06FF._-]/g, '_');
  const savedFilename = `${Date.now()}_${safeOriginalName}`;
  const savedFilePath = path.join(EXCEL_UPLOADS_DIR, savedFilename);
  try {
    writeFileSync(savedFilePath, fileBuffer);
  } catch (e) {
    console.warn('[upload] could not save original file to disk:', e.message);
  }

  const uploadedFile = await createUploadedFile({
    filename:         savedFilename,
    originalName:     originalName,
    rowCount:         validRows.length,
    uploadedBy:       uploadedBy || null,
    userId,
    fileType:         storedFileType,
    detectedCurrency: detectedCurrency,
    currencyMode:     detectedCurrency,
  });

  // ── 6. Bulk insert (split sales/returns) ────────────────
  const buildInsert = (rows) => rows.map(r => ({
    representativeId: repMap[r.repName],
    areaId:           areaMap[r.area],
    itemId:           itemMap[r.item],
    customerId:       r.customer ? (customerMap[r.customer] ?? null) : null,
    quantity:         r.quantity,
    totalValue:       r.totalValue,
    saleDate:         r.date ?? undefined,
    uploadedFileId:   uploadedFile.id,
    rawData:          r.rawData ?? null,
  }));

  if (salesRows.length > 0) {
    await bulkCreateSales(buildInsert(salesRows), uploadedFile.id, userId, 'sale');
  }
  if (returnsRows.length > 0) {
    await bulkCreateSales(buildInsert(returnsRows), uploadedFile.id, userId, 'return');
  }

  // ── 7. Auto-assign areas & items to each rep ────────────
  const repAreaPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${areaMap[r.area]}`, { representativeId: repMap[r.repName], areaId: areaMap[r.area] }])
  ).values()];

  const repItemPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${itemMap[r.item]}`, { representativeId: repMap[r.repName], itemId: itemMap[r.item] }])
  ).values()];

  await Promise.all([
    ...repAreaPairs.map(p => prisma.representativeArea.upsert({
      where:  { representativeId_areaId: p },
      update: {},
      create: p,
    })),
    ...repItemPairs.map(p => prisma.representativeItem.upsert({
      where:  { representativeId_itemId: p },
      update: {},
      create: p,
    })),
  ]);

  return {
    rowCount:       validRows.length,
    salesCount:     salesRows.length,
    returnsCount:   returnsRows.length,
    skipped:        skippedRows,
    normalizations: normalizationLog,
    unknownItems:   tempItemNames,
    uploadedFile: {
      id:           uploadedFile.id,
      originalName: uploadedFile.originalName,
      uploadedAt:   uploadedFile.uploadedAt,
    },
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
 * Robustly parse a numeric value coming from Excel.
 * Handles: Arabic numerals, comma-thousands separators, spaces, currency symbols.
 */
function parseNumeric(val) {
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
function parseExcelDate(val) {
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
  if (!code) return '';
  // Take the leading alphabetic sequence before / - N _ or digit
  const match = String(code).match(/^([A-Za-z\u0600-\u06FF]+)/);
  return match ? match[1].trim() : '';
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

/**
 * Resolve column headers from the Excel file against known aliases.
 * @param {string[]} headers   - Actual Excel column headers
 * @param {object}   overrides - Manual overrides from request
 */
function resolveColumns(headers, overrides) {
  const result = {};
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // 1. Manual override takes priority
    if (overrides[field] && headers.includes(overrides[field])) {
      result[field] = overrides[field];
      continue;
    }
    // 2. Exact alias match (no exclusions — if user named it exactly, use it)
    const exactMatch = aliases.find(alias =>
      lowerHeaders.includes(alias.toLowerCase())
    );
    if (exactMatch) {
      result[field] = headers[lowerHeaders.indexOf(exactMatch.toLowerCase())];
      continue;
    }
    // 3. Partial / contains match — skip headers that look like status/notes/ID columns
    const partialIdx = lowerHeaders.findIndex((h, idx) => {
      if (isExcludedHeader(headers[idx])) return false; // skip status/notes columns
      return aliases.some(alias => h.includes(alias.toLowerCase()) || alias.toLowerCase().includes(h));
    });
    if (partialIdx !== -1) {
      result[field] = headers[partialIdx];
      continue;
    }
    // 4. Final fallback: use the field name itself (may be undefined in the row)
    result[field] = field;
  }
  return result;
}

/**
 * Resolve a list of entity names to their DB IDs, creating missing ones.
 * Returns a { name → id } map.
 * @param {string[]} names
 * @param {Function} upsertFn
 */
async function resolveEntities(names, upsertFn) {
  const entries = await Promise.all(names.map(async name => [name, (await upsertFn(name)).id]));
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
