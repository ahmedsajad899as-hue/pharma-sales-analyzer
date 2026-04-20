/**
 * Distributor Sales Service
 * Parses Excel files in distributor format:
 *   امازون | Item | شهر3 | شهر4 | ... | تاريخ البيع | كمية المباعة | اعادة الفوترة
 *
 * Team header rows are detected as rows where the quantity columns are all empty
 * and a non-empty string appears in the first cell area.
 */

import * as XLSX from 'xlsx';
import { createRequire } from 'module';

// ─── Arabic text normalisation ────────────────────────────────
function normalizeArabic(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْ]/g, '') // strip diacritics
    .replace(/\s+/g, ' ');
}

// ─── Column alias detection ───────────────────────────────────
const COL_ALIASES = {
  distributor: ['امازون', 'amazon', 'الموزع', 'distributor', 'موزع', 'وكيل', 'amazon/n/a', 'n/a'],
  item:        ['item', 'ايتم', 'منتج', 'product', 'الدواء', 'اسم المادة', 'مادة', 'اسم المنتج', 'drug', 'medicine'],
  saleDate:    ['تاريخ البيع', 'sale date', 'تاريخ', 'date', 'last sale', 'اخر بيع'],
  totalQty:    ['كمية المباعة', 'كمية المبيعات', 'total qty', 'total sold', 'مبيعات', 'كمية', 'qty sold', 'sold'],
  reinvoicing: ['اعادة الفوترة', 'اعاده الفوترة', 'reinvoicing', 're-invoice', 'reorder', 'اعادة', 'فوترة'],
};

function matchCol(header, type) {
  const h = normalizeArabic(String(header)).toLowerCase();
  return COL_ALIASES[type].some(alias => h.includes(normalizeArabic(alias).toLowerCase()));
}

// ─── Month column detection ───────────────────────────────────
// Detects columns like "شهر3", "شهر 3", "month3", "month 3", "م3", "3شهر"
function isMonthCol(header) {
  const h = normalizeArabic(String(header || '')).toLowerCase();
  return /شهر\s*\d+|month\s*\d+|م\s*\d+|\d+\s*شهر|\d+\s*month/.test(h);
}

function getMonthNumber(header) {
  const h = normalizeArabic(String(header || ''));
  const m = h.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Value helpers ────────────────────────────────────────────
function toFloat(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function parseExcelDate(val) {
  if (!val) return null;
  // Excel serial number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return new Date(d.y, d.m - 1, d.d);
  }
  // String date
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Team header detection ────────────────────────────────────
// A row is a team header ONLY if all numeric columns are empty/zero AND
// the row text explicitly matches a team keyword (Team, فريق, etc.)
// We do NOT use string length as a criterion to avoid false positives.
function isTeamHeaderRow(row, numericColKeys) {
  const hasNoNumbers = numericColKeys.every(k => {
    const v = row[k];
    return v === null || v === undefined || v === '' || v === 0;
  });
  if (!hasNoNumbers) return false;

  // Must have at least one non-empty string cell
  const vals = Object.values(row).filter(v => typeof v === 'string' && v.trim().length > 0);
  if (vals.length === 0) return false;

  // STRICT: only treat as team header if it explicitly contains team keyword
  const rowText = vals.join(' ');
  return /team|فريق|مجموعه|مجموعة/i.test(rowText);
}

function extractTeamName(row) {
  for (const val of Object.values(row)) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return 'Unknown Team';
}

// ─── Main parser ──────────────────────────────────────────────
/**
 * Parse a distributor sales Excel buffer.
 * Returns { records, warnings }
 * Each record: { teamName, distributorName, itemName, month3Qty, month4Qty,
 *                saleDate, totalQtySold, reinvoicingCount, extraMonths }
 */
export function parseDistributorExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });

  const records = [];
  const warnings = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Use raw rows to detect structure
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rawRows.length < 2) continue;

    // ── Find header row ─────────────────────────────────────
    // Strategy: find the row that has the most matching column aliases.
    // Minimum: must match at least distributor OR item alias.
    let headerRowIdx = -1;
    let headers = [];
    let bestScore = 0;

    for (let i = 0; i < Math.min(rawRows.length, 25); i++) {
      const row = rawRows[i];
      const rowStr = row.map(c => normalizeArabic(String(c || ''))).join(' ').toLowerCase();

      const hasDistributor = COL_ALIASES.distributor.some(a =>
        rowStr.includes(normalizeArabic(a).toLowerCase())
      );
      const hasItem = COL_ALIASES.item.some(a =>
        rowStr.includes(normalizeArabic(a).toLowerCase())
      );
      const hasMonth = row.some(c => isMonthCol(String(c || '')));
      const hasQty = COL_ALIASES.totalQty.some(a =>
        rowStr.includes(normalizeArabic(a).toLowerCase())
      );

      // Score: how many alias types matched
      const score = (hasDistributor ? 2 : 0) + (hasItem ? 2 : 0) + (hasMonth ? 1 : 0) + (hasQty ? 1 : 0);

      if (score > bestScore && (hasDistributor || hasItem)) {
        bestScore = score;
        headerRowIdx = i;
        headers = row.map(c => String(c || '').trim());
      }
    }

    // Fallback: if still no header found, try the first non-empty row
    if (headerRowIdx === -1) {
      for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
        const row = rawRows[i];
        if (row.some(c => String(c || '').trim().length > 0)) {
          headerRowIdx = i;
          headers = row.map(c => String(c || '').trim());
          warnings.push(`Sheet "${sheetName}": header auto-detected at row ${i + 1} (fallback mode)`);
          break;
        }
      }
    }

    if (headerRowIdx === -1) {
      warnings.push(`Sheet "${sheetName}": no header row found (expected امازون + Item columns)`);
      continue;
    }

    // ── Map column indices ──────────────────────────────────
    let distributorCol = -1;
    let itemCol = -1;
    let saleDateCol = -1;
    let totalQtyCol = -1;
    let reinvoicingCol = -1;
    const monthCols = []; // { idx, monthNum, header }

    headers.forEach((h, idx) => {
      // Use independent ifs (not else-if) so each header gets checked for all types
      if (distributorCol === -1 && matchCol(h, 'distributor')) { distributorCol = idx; return; }
      if (itemCol === -1 && matchCol(h, 'item')) { itemCol = idx; return; }
      if (isMonthCol(h)) { monthCols.push({ idx, monthNum: getMonthNumber(h), header: h }); return; }
      if (saleDateCol === -1 && matchCol(h, 'saleDate')) { saleDateCol = idx; return; }
      if (totalQtyCol === -1 && matchCol(h, 'totalQty')) { totalQtyCol = idx; return; }
      if (reinvoicingCol === -1 && matchCol(h, 'reinvoicing')) { reinvoicingCol = idx; return; }
    });

    if (distributorCol === -1 || itemCol === -1) {
      warnings.push(`Sheet "${sheetName}": could not find distributor or item column`);
      continue;
    }

    // Sort month columns by month number
    monthCols.sort((a, b) => (a.monthNum || 0) - (b.monthNum || 0));

    const month3Col = monthCols.find(m => m.monthNum === 3)?.idx ?? -1;
    const month4Col = monthCols.find(m => m.monthNum === 4)?.idx ?? -1;
    const extraMonthCols = monthCols.filter(m => m.monthNum !== 3 && m.monthNum !== 4);

    // Numeric column keys for team header detection
    const numericColKeys = [
      month3Col, month4Col, totalQtyCol, reinvoicingCol,
      ...extraMonthCols.map(m => m.idx),
    ].filter(i => i !== -1);

    // ── Parse data rows ─────────────────────────────────────
    let currentTeam = sheetName; // default team = sheet name

    for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
      const rawRow = rawRows[i];

      // Build a simple object for easier processing
      const row = {};
      rawRow.forEach((val, idx) => { row[idx] = val; });

      // Check if this is a team header row
      if (isTeamHeaderRow(row, numericColKeys)) {
        currentTeam = extractTeamName(row);
        continue;
      }

      const distributorName = String(row[distributorCol] || '').trim();
      const itemName = String(row[itemCol] || '').trim();

      // Skip completely empty rows
      if (!distributorName && !itemName) continue;
      // Skip if both are empty or look like a sub-header
      if (!distributorName || !itemName) continue;

      const month3Qty = month3Col !== -1 ? toFloat(row[month3Col]) : 0;
      const month4Qty = month4Col !== -1 ? toFloat(row[month4Col]) : 0;
      const saleDate = saleDateCol !== -1 ? parseExcelDate(row[saleDateCol]) : null;
      const totalQtySold = totalQtyCol !== -1 ? toFloat(row[totalQtyCol]) : 0;
      const reinvoicingCount = reinvoicingCol !== -1 ? toFloat(row[reinvoicingCol]) : 0;

      // Extra months as JSON
      const extraMonths = {};
      for (const em of extraMonthCols) {
        const val = toFloat(row[em.idx]);
        if (val !== 0) extraMonths[em.header] = val;
      }

      records.push({
        teamName: currentTeam,
        distributorName,
        itemName,
        month3Qty,
        month4Qty,
        saleDate,
        totalQtySold,
        reinvoicingCount,
        extraMonths: Object.keys(extraMonths).length > 0 ? JSON.stringify(extraMonths) : null,
      });
    }
  }

  return { records, warnings };
}

// ─── PDF parser ───────────────────────────────────────────────
/**
 * Extract text from PDF, convert to a 2D array of rows/cells,
 * then delegate to the same column-mapping logic used for Excel.
 *
 * Strategy:
 *  1. Extract raw text via pdf-parse.
 *  2. Split into lines, strip blank lines.
 *  3. Each line is a potential row — split on 2+ spaces or tab to get cells.
 *  4. Wrap into a fake XLSX workbook sheet and call the shared row-parser.
 */
async function parsePdfToRows(buffer) {
  const _require = createRequire(import.meta.url);
  const pdfParse = _require('pdf-parse');
  const data = await pdfParse(buffer);

  const rawLines = data.text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Smart split: try 2+ spaces first; if that gives only 1 cell, fall back to single space
  const splitLine = (line) => {
    const byMultiSpace = line.split(/\t| {2,}/).map(c => c.trim()).filter(c => c.length > 0);
    if (byMultiSpace.length >= 2) return byMultiSpace;
    // Fallback: split by single space (works when PDF doesn't preserve column gaps)
    return line.split(/\s+/).map(c => c.trim()).filter(c => c.length > 0);
  };

  const rows = rawLines.map(splitLine);

  // If no row looks like a header, also try treating the whole file as one big
  // string split by common Arabic column name separators (|, /)
  const allText = rawLines.join(' ');
  const hasAnyHeader = rows.some(row => {
    const s = row.join(' ').toLowerCase();
    return COL_ALIASES.distributor.some(a => s.includes(normalizeArabic(a).toLowerCase())) ||
           COL_ALIASES.item.some(a => s.includes(normalizeArabic(a).toLowerCase()));
  });

  if (!hasAnyHeader) {
    // Try pipe / slash split
    const byPipe = rawLines.map(l => l.split(/[|\/]/).map(c => c.trim()).filter(c => c.length > 0));
    const hasPipeHeader = byPipe.some(row => {
      const s = row.join(' ').toLowerCase();
      return COL_ALIASES.distributor.some(a => s.includes(normalizeArabic(a).toLowerCase()));
    });
    if (hasPipeHeader) return byPipe;
  }

  return rows;
}

/**
 * Build records from a 2D array of rows (same logic as Excel parser).
 * Returns { records, warnings }
 */
function parseRowsToRecords(rawRows, sourceName) {
  const records = [];
  const warnings = [];

  if (rawRows.length < 2) {
    warnings.push(`${sourceName}: insufficient rows in PDF text`);
    return { records, warnings };
  }

  // Find header row
  let headerRowIdx = -1;
  let headers = [];

  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i];
    const rowStr = row.map(c => normalizeArabic(String(c || ''))).join(' ').toLowerCase();
    const hasDistributor = COL_ALIASES.distributor.some(a =>
      rowStr.includes(normalizeArabic(a).toLowerCase())
    );
    const hasItem = COL_ALIASES.item.some(a =>
      rowStr.includes(normalizeArabic(a).toLowerCase())
    );
    if (hasDistributor && hasItem) {
      headerRowIdx = i;
      headers = row.map(c => String(c || '').trim());
      break;
    }
  }

  if (headerRowIdx === -1) {
    // Include first 3 extracted rows in warning for debugging
    const preview = rawRows.slice(0, 3).map((r, i) => `R${i}: [${r.join(' | ')}]`).join(' // ');
    warnings.push(`${sourceName}: no header row found in PDF (expected امازون + Item columns). Preview: ${preview}`);
    return { records, warnings };
  }

  // Map columns
  let distributorCol = -1, itemCol = -1, saleDateCol = -1, totalQtyCol = -1, reinvoicingCol = -1;
  const monthCols = [];

  headers.forEach((h, idx) => {
    if (distributorCol === -1 && matchCol(h, 'distributor')) distributorCol = idx;
    else if (itemCol === -1 && matchCol(h, 'item')) itemCol = idx;
    else if (saleDateCol === -1 && matchCol(h, 'saleDate')) saleDateCol = idx;
    else if (totalQtyCol === -1 && matchCol(h, 'totalQty')) totalQtyCol = idx;
    else if (reinvoicingCol === -1 && matchCol(h, 'reinvoicing')) reinvoicingCol = idx;
    else if (isMonthCol(h)) monthCols.push({ idx, monthNum: getMonthNumber(h), header: h });
  });

  if (distributorCol === -1 || itemCol === -1) {
    warnings.push(`${sourceName}: could not find distributor or item column in PDF`);
    return { records, warnings };
  }

  monthCols.sort((a, b) => (a.monthNum || 0) - (b.monthNum || 0));
  const month3Col = monthCols.find(m => m.monthNum === 3)?.idx ?? -1;
  const month4Col = monthCols.find(m => m.monthNum === 4)?.idx ?? -1;
  const extraMonthCols = monthCols.filter(m => m.monthNum !== 3 && m.monthNum !== 4);

  const numericColKeys = [month3Col, month4Col, totalQtyCol, reinvoicingCol,
    ...extraMonthCols.map(m => m.idx)].filter(i => i !== -1);

  let currentTeam = sourceName;

  for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
    const cells = rawRows[i];
    const row = {};
    cells.forEach((val, idx) => { row[idx] = val; });

    if (isTeamHeaderRow(row, numericColKeys)) {
      currentTeam = extractTeamName(row);
      continue;
    }

    const distributorName = String(cells[distributorCol] || '').trim();
    const itemName = String(cells[itemCol] || '').trim();
    if (!distributorName || !itemName) continue;

    const month3Qty = month3Col !== -1 ? toFloat(cells[month3Col]) : 0;
    const month4Qty = month4Col !== -1 ? toFloat(cells[month4Col]) : 0;
    const saleDate = saleDateCol !== -1 ? parseExcelDate(cells[saleDateCol]) : null;
    const totalQtySold = totalQtyCol !== -1 ? toFloat(cells[totalQtyCol]) : 0;
    const reinvoicingCount = reinvoicingCol !== -1 ? toFloat(cells[reinvoicingCol]) : 0;

    const extraMonths = {};
    for (const em of extraMonthCols) {
      const val = toFloat(cells[em.idx]);
      if (val !== 0) extraMonths[em.header] = val;
    }

    records.push({
      teamName: currentTeam,
      distributorName,
      itemName,
      month3Qty,
      month4Qty,
      saleDate,
      totalQtySold,
      reinvoicingCount,
      extraMonths: Object.keys(extraMonths).length > 0 ? JSON.stringify(extraMonths) : null,
    });
  }

  return { records, warnings };
}

// ─── Unified entry point ──────────────────────────────────────
/**
 * Parse a distributor sales file (Excel OR PDF) from a buffer.
 * Returns { records, warnings }
 */
export async function parseDistributorFile(buffer, filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase();

  if (ext === 'pdf') {
    const rows = await parsePdfToRows(buffer);
    return parseRowsToRecords(rows, filename);
  }

  // Excel / CSV — use synchronous Excel parser
  return parseDistributorExcel(buffer);
}
