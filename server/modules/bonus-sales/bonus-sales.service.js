/**
 * Bonus Sales Service
 * Parses Excel files for sales + compensation and runs matching logic.
 *
 * Sales file columns (flexible detection):
 *   اسم الشركة | الايتم | التاريخ | الرقم | العدد | السعر | البونص | المجموع | المندوب | الصيدلية | المذخر
 *
 * Compensation file has the same structure — rows here represent
 * compensation entries for invoices that originally had no bonus.
 *
 * Matching key: pharmacyName + invoiceNo + itemName + quantity (all normalized)
 */

import * as XLSX from 'xlsx';

// ─── Arabic normalisation ─────────────────────────────────────
function norm(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ─── Column alias lookup ──────────────────────────────────────
const COL_ALIASES = {
  companyName:  ['اسم الشركة', 'company', 'شركة', 'الشركه', 'اسم شركة', 'company name'],
  itemName:     ['الايتم', 'item', 'ايتم', 'المادة', 'اسم المادة', 'المنتج', 'product', 'drug', 'الدواء', 'اسم المنتج'],
  invoiceDate:  ['التاريخ', 'date', 'تاريخ', 'تاريخ الفاتورة', 'invoice date'],
  invoiceNo:    ['الرقم', 'رقم', 'رقم الفاتورة', 'invoice no', 'invoice number', 'no', 'invoice#', 'inv no'],
  quantity:     ['العدد', 'الكمية', 'عدد', 'كمية', 'qty', 'quantity', 'كميه', 'العدد/الكمية'],
  price:        ['السعر', 'price', 'سعر', 'unit price', 'سعر الوحدة'],
  bonusQty:     ['البونص', 'bonus', 'بونص', 'بونوس', 'هدية', 'gift', 'مجاني', 'كمية البونص', 'bonus qty'],
  bonusValue:   ['قيمة البونص', 'bonus value', 'bonus amount'],
  total:        ['المجموع', 'total', 'مجموع', 'الإجمالي', 'اجمالي', 'المبلغ'],
  repName:      ['المندوب', 'rep', 'مندوب', 'اسم المندوب', 'rep name', 'sales rep'],
  pharmacyName: ['الصيدلية', 'pharmacy', 'صيدلية', 'صيدليه', 'اسم الصيدلية', 'pharmacy name', 'customer'],
  warehouse:    ['المذخر', 'مذخر', 'warehouse', 'مستودع', 'depot', 'مخزن'],
};

function detectCol(headers, fieldKey) {
  const aliases = COL_ALIASES[fieldKey];
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    if (aliases.some(a => h.includes(norm(a)))) return i;
  }
  return -1;
}

// ─── Value helpers ────────────────────────────────────────────
function toFloat(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseExcelDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      if (d) return new Date(d.y, d.m - 1, d.d);
    } catch (_) { /* ignore */ }
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Parse a file buffer into row objects ─────────────────────
export function parseFile(buffer, originalName) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (raw.length < 2) return { rows: [], warnings: ['الملف فارغ أو لا يحتوي على بيانات'] };

  // Find header row (first row with >= 4 non-empty cells)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const nonEmpty = raw[i].filter(c => String(c).trim() !== '').length;
    if (nonEmpty >= 4) { headerIdx = i; break; }
  }

  const headers = raw[headerIdx].map(c => String(c ?? '').trim());

  // Detect columns
  const colMap = {};
  for (const key of Object.keys(COL_ALIASES)) {
    colMap[key] = detectCol(headers, key);
  }

  const warnings = [];
  if (colMap.itemName === -1)     warnings.push('لم يتم العثور على عمود الايتم');
  if (colMap.pharmacyName === -1) warnings.push('لم يتم العثور على عمود الصيدلية');
  if (colMap.invoiceNo === -1)    warnings.push('لم يتم العثور على عمود رقم الفاتورة');

  const knownIndices = new Set(Object.values(colMap).filter(v => v !== -1));
  const rows = [];

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    // Skip empty rows
    if (r.every(c => String(c ?? '').trim() === '')) continue;

    const get = (key) => {
      const idx = colMap[key];
      return idx === -1 ? null : (r[idx] ?? null);
    };

    // Collect extra columns not mapped to known fields
    const extra = {};
    for (let j = 0; j < headers.length; j++) {
      if (!knownIndices.has(j) && headers[j] && String(r[j] ?? '').trim()) {
        extra[headers[j]] = r[j];
      }
    }

    const bonusRaw = get('bonusQty');
    const bonusQty = toFloat(bonusRaw);
    const hasBonus = bonusQty !== null && bonusQty > 0;

    rows.push({
      companyName:  String(get('companyName') ?? '').trim() || null,
      itemName:     String(get('itemName')    ?? '').trim() || null,
      invoiceDate:  parseExcelDate(get('invoiceDate')),
      invoiceNo:    String(get('invoiceNo')   ?? '').trim() || null,
      quantity:     toFloat(get('quantity')),
      price:        toFloat(get('price')),
      hasBonus,
      bonusQty,
      bonusValue:   toFloat(get('bonusValue')),
      total:        toFloat(get('total')),
      repName:      String(get('repName')      ?? '').trim() || null,
      pharmacyName: String(get('pharmacyName') ?? '').trim() || null,
      warehouse:    String(get('warehouse')    ?? '').trim() || null,
      extraData:    Object.keys(extra).length ? JSON.stringify(extra) : null,
    });
  }

  return { rows, warnings };
}

// ─── Matching logic ───────────────────────────────────────────
// Returns a Set of salesRowId values that were matched by comp rows.
// Match key: norm(pharmacyName) + '|' + norm(invoiceNo) + '|' + norm(itemName) + '|' + qty
export function buildMatchKey(row) {
  return [
    norm(row.pharmacyName),
    norm(row.invoiceNo),
    norm(row.itemName),
    String(Math.round((row.quantity ?? 0) * 100)),
  ].join('|');
}
