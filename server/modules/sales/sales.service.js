/**
 * Sales Service
 * Business logic for parsing Excel files and inserting sales data.
 * Orchestrates repository calls — no direct DB access here.
 */

import XLSX from 'xlsx';
import { readFileSync } from 'fs';
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
  const { uploadedBy, columnMapping = {}, userId = null, fileType = 'sales' } = options;

  // ── 1. Parse workbook ────────────────────────────────────
  const fileBuffer = file.buffer || readFileSync(file.path);
  const workbook   = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });

  // Decide which sheets to process and whether they are forced-return sheets
  const sheetsToProcess = [];
  console.log(`[upload] fileType="${fileType}" | sheets in workbook:`, workbook.SheetNames);
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

  // ── Auto-detect currency from median totalValue ──────────
  // Iraq pharma: IQD row totals typically 50,000 – 10,000,000 IQD
  // USD row totals typically $5 – $5,000 → well below 100,000
  const CURRENCY_THRESHOLD = 100000;
  const nonZeroValues = validRows.map(r => r.totalValue || 0).filter(v => v > 0).sort((a, b) => a - b);
  const median = nonZeroValues.length > 0
    ? nonZeroValues[Math.floor(nonZeroValues.length / 2)]
    : 0;
  const detectedCurrency = median >= CURRENCY_THRESHOLD ? 'IQD' : 'USD';

  // ── 5. Record the file upload ────────────────────────────
  // multer stores originalname as latin1 — decode to UTF-8 for Arabic filenames
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  // For 'auto' mode store a descriptive fileType
  const storedFileType = fileType === 'auto'
    ? (salesRows.length > 0 && returnsRows.length > 0 ? 'auto' : returnsRows.length > 0 ? 'returns' : 'sales')
    : fileType;
  const uploadedFile = await createUploadedFile({
    filename:         file.filename || file.originalname,
    originalName:     originalName,
    rowCount:         validRows.length,
    uploadedBy:       uploadedBy || null,
    userId,
    fileType:         storedFileType,
    detectedCurrency: detectedCurrency,
    currencyMode:     detectedCurrency, // default display = detected
  });

  // ── 6. Bulk insert (split sales/returns) ────────────────
  const buildInsert = (rows) => rows.map(r => ({
    representativeId: repMap[r.repName],
    areaId:           areaMap[r.area],
    itemId:           itemMap[r.item],
    customerId:       r.customer ? (customerMap[r.customer] ?? null) : null,
    quantity:         r.quantity,
    totalValue:       r.totalValue,
    saleDate:         r.date ?? undefined,   // undefined → Prisma uses @default(now())
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
  // Build unique (repId, areaId) and (repId, itemId) pairs from this file's data
  const repAreaPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${areaMap[r.area]}`, { representativeId: repMap[r.repName], areaId: areaMap[r.area] }])
  ).values()];

  const repItemPairs = [...new Map(
    validRows.map(r => [`${repMap[r.repName]}-${itemMap[r.item]}`, { representativeId: repMap[r.repName], itemId: itemMap[r.item] }])
  ).values()];

  // Upsert into junction tables (SQLite-compatible — upsert each pair)
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
