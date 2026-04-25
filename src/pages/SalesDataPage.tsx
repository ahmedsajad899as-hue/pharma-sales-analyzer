import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

// ── Types ──────────────────────────────────────────────────────────────────────
interface ColMeta {
  key: string;
  label: string;
  region: string;
  colIdx: number;
}

interface SalesFile {
  id: string;
  name: string;
  uploadedAt: string;
  fixedCols: string[];
  areaCols: ColMeta[];
  rows: Record<string, string>[];
  regions: string[];
  sourceFileIds?: string[]; // set on merged files only
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mergeDebug?: { file: string; companyCol: string; itemCol: string; rows: number }[];
}

type RegionTotalCol = { key: string; label: string; region: string; colIdx: -1; isRegionTotal: true; cols: ColMeta[] };
type ViewCol = ColMeta | RegionTotalCol;
function isRT(col: ViewCol): col is RegionTotalCol { return 'isRegionTotal' in col; }

// ── API helpers (server-side persistence — synced across devices) ─────────────
const API = import.meta.env.VITE_API_URL || '';
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function toLocalFile(f: any): SalesFile {
  return {
    id: String(f.id),
    name: f.name,
    uploadedAt: typeof f.uploadedAt === 'string' ? f.uploadedAt : new Date(f.uploadedAt).toISOString(),
    fixedCols: f.fixedCols || [],
    areaCols: f.areaCols || [],
    rows: f.rows || [],
    regions: f.regions || [],
    sourceFileIds: Array.isArray(f.sourceFileIds) ? f.sourceFileIds.map(String) : undefined,
  };
}
async function apiListFiles(): Promise<SalesFile[]> {
  try {
    const r = await fetch(`${API}/api/sales-data-files`, { headers: authHeaders() });
    const j = await r.json();
    if (!j.success) return [];
    return (j.data as any[]).map(toLocalFile);
  } catch { return []; }
}
async function apiCreateFile(f: SalesFile): Promise<SalesFile | null> {
  try {
    const r = await fetch(`${API}/api/sales-data-files`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: f.name,
        uploadedAt: f.uploadedAt,
        fixedCols: f.fixedCols,
        areaCols: f.areaCols,
        rows: f.rows,
        regions: f.regions,
        sourceFileIds: f.sourceFileIds ?? null,
      }),
    });
    const j = await r.json();
    return j.success ? toLocalFile(j.data) : null;
  } catch { return null; }
}
async function apiDeleteFile(id: string): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/sales-data-files/${id}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtDate = (iso: string) => { const d = new Date(iso); return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`; };
const toNum = (v: string) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const fmtNum = (n: number) => n === 0 ? '—' : n.toLocaleString('en');

// ── Pure helpers (module-level for stable useMemo deps) ───────────────────────
function cellVal(row: Record<string, string>, col: ViewCol): number {
  if (isRT(col)) return col.cols.reduce((s, ac) => s + toNum(row[ac.key] ?? ''), 0);
  return toNum(row[col.key] ?? '');
}
function rowTotal(row: Record<string, string>, cols: ViewCol[]): number {
  return cols.reduce((s, col) => s + cellVal(row, col), 0);
}

// ── Excel Parser ───────────────────────────────────────────────────────────────
function parseExcel(buffer: ArrayBuffer, filename: string): SalesFile | string {
  try {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    if (raw.length < 2) return 'الملف لا يحتوي على بيانات كافية';

    // Find warehouse header row (most non-empty cells in first 10 rows)
    let wRowIdx = 0, bestFill = 0;
    raw.slice(0, 10).forEach((r, i) => {
      const c = (r as unknown[]).filter(v => v !== '' && v != null).length;
      if (c > bestFill) { bestFill = c; wRowIdx = i; }
    });

    const rRowIdx = wRowIdx > 0 ? wRowIdx - 1 : -1;
    const wRow = raw[wRowIdx] as unknown[];
    const rRow = rRowIdx >= 0 ? raw[rRowIdx] as unknown[] : [];

    // Assign region names directly from raw[rRowIdx].
    // When xlsx reads merged cells with {header:1}, only the FIRST cell of each
    // merge gets the value — the rest are ''. So non-empty cells in rRow are
    // exactly the starts of each region group. We span each region from its
    // column up to (but not including) the next non-empty region cell.
    // This never bleeds and requires no sheet-coordinate arithmetic.
    const regionByCol: string[] = new Array(wRow.length).fill('');
    if (rRowIdx >= 0) {
      const regionCells: { ci: number; name: string }[] = [];
      for (let ci = 0; ci < wRow.length; ci++) {
        const rv = String(rRow[ci] ?? '').trim();
        if (rv) regionCells.push({ ci, name: rv });
      }
      for (let ei = 0; ei < regionCells.length; ei++) {
        const { ci: start, name } = regionCells[ei];
        const end = regionCells[ei + 1]?.ci ?? wRow.length;
        // Skip assigning region name if it's a total/sum header
        if (/مجموع|اجمالي|إجمالي|الاجمالي|الإجمالي|مجموع كلي|الكلي|grand.?total|total.?iraq|total.?all|sub.?total|subtotal|overall/i.test(name)) continue;
        for (let ci = start; ci < end; ci++) regionByCol[ci] = name;
      }
    }

    // Detect where area/quantity columns start.
    // Primary: first column in regionByCol that has a region name.
    // Fallback for single-row headers (no region row): first mostly-numeric col >= 3.
    let areaStart = Math.min(3, wRow.length);
    if (rRowIdx >= 0) {
      const firstRegCol = regionByCol.findIndex(r => r !== '');
      if (firstRegCol > 0) {
        areaStart = firstRegCol;
      } else {
        // Region row exists but no region names found — fall back to numeric
        for (let ci = 3; ci < wRow.length; ci++) {
          let hits = 0, checked = 0;
          for (let ri = wRowIdx + 1; ri < Math.min(wRowIdx + 8, raw.length); ri++) {
            const v = String((raw[ri] as unknown[])[ci] ?? '').replace(/,/g, '');
            if (v !== '') { checked++; if (!isNaN(Number(v))) hits++; }
          }
          if (checked >= 2 && hits / checked >= 0.6) { areaStart = ci; break; }
        }
      }
    } else {
      // No region row — single-row header
      for (let ci = 3; ci < wRow.length; ci++) {
        let hits = 0, checked = 0;
        for (let ri = wRowIdx + 1; ri < Math.min(wRowIdx + 8, raw.length); ri++) {
          const v = String((raw[ri] as unknown[])[ci] ?? '').replace(/,/g, '');
          if (v !== '') { checked++; if (!isNaN(Number(v))) hits++; }
        }
        if (checked >= 2 && hits / checked >= 0.6) { areaStart = ci; break; }
      }
    }

    // Build fixed columns
    const fixedCols: string[] = [];
    for (let ci = 0; ci < areaStart; ci++) {
      const wv = String(wRow[ci] ?? '').trim();
      const rv = String(rRow[ci] ?? '').trim();
      fixedCols.push(wv || rv || `col_${ci + 1}`);
    }

    // Build area columns (deduplicate labels).
    // Columns with no region assigned are price/total/info cols — skip them.
    // EXCEPTION: for single-row header files (no region row), use a fallback
    // region name so warehouse columns are not accidentally dropped.
    const defaultRegion = rRowIdx < 0 ? (filename.replace(/\.[^.]+$/, '') || 'مذاخر') : '';

    const isTotalLabel = (s: string) =>
      /مجموع|اجمالي|إجمالي|الاجمالي|الإجمالي|مجموع كلي|الكلي|grand.?total|total.?iraq|total.?all|sub.?total|subtotal|overall/i
        .test(s);
    const isExpiry = (s: string) =>
      /اكسباير|اكسبير|expir|صلاحي|انتهاء|تاريخ/i.test(s);

    const labelCount: Record<string, number> = {};
    const areaCols: ColMeta[] = [];
    for (let ci = areaStart; ci < wRow.length; ci++) {
      const wv = String(wRow[ci] ?? '').trim();
      const reg = regionByCol[ci] || defaultRegion;
      if (!reg) continue; // no region header → not a warehouse/quantity col
      if (!wv && !reg) continue;
      if (isTotalLabel(wv) || isTotalLabel(reg)) continue; // skip total columns
      if (isExpiry(wv)) continue; // skip expiry/date columns
      const rawLabel = wv || `${reg}_${ci}`;
      labelCount[rawLabel] = (labelCount[rawLabel] ?? 0) + 1;
      const label = labelCount[rawLabel] > 1 ? `${rawLabel}_${labelCount[rawLabel]}` : rawLabel;
      areaCols.push({ key: `c${ci}`, label, region: reg, colIdx: ci });
    }

    // Build data rows
    const rows: Record<string, string>[] = [];
    for (let ri = wRowIdx + 1; ri < raw.length; ri++) {
      const arr = raw[ri] as unknown[];
      if (arr.slice(0, Math.min(4, arr.length)).every(v => v === '' || v == null)) continue;
      const obj: Record<string, string> = {};
      fixedCols.forEach((c, ci) => { obj[c] = String(arr[ci] ?? ''); });
      areaCols.forEach(ac => { obj[ac.key] = String(arr[ac.colIdx] ?? ''); });
      rows.push(obj);
    }

    if (rows.length === 0) return 'لم يتم العثور على صفوف بيانات';

    return {
      id: uid(),
      name: filename.replace(/\.[^.]+$/, ''),
      uploadedAt: new Date().toISOString(),
      fixedCols,
      areaCols,
      rows,
      regions: [...new Set(areaCols.map(ac => ac.region).filter(Boolean))],
    };
  } catch (err) {
    console.error(err);
    return 'فشل قراءة الملف — تأكد أنه Excel أو CSV صحيح';
  }
}

// ── Multi-sheet Stock File Parser ────────────────────────────────────────────
// Format: file = one region, sheets = companies, row0 = title, row1 = headers
//         (المادة in col A, warehouse names in cols B+, skip مذخر+number cols)
const IGNORE_WH_PAT = /^مذخر\s*\d+$|^مخزن\s*\d+$|^warehouse\s*\d+$|اكسباير|اكسبير|expir|صلاحي|انتهاء|تاريخ/i;

function parseMultiSheetStock(buffer: ArrayBuffer, filename: string): SalesFile | 'NO' | string {
  try {
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    if (!wb.SheetNames.length) return 'NO';

    // Peek at first sheet to detect format
    const firstRaw = XLSX.utils.sheet_to_json<unknown[]>(
      wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }
    );
    if (firstRaw.length < 3) return 'NO';

    // Row index 1 must have an item-like label in col 0
    const hRow = firstRaw[1] as string[];
    const col0 = String(hRow[0] ?? '').trim();
    const isItemFormat = ['المادة','المواد','مادة','item','الايتم','ايتم','اسم المادة','المنتج']
      .some(k => col0.toLowerCase().includes(k.toLowerCase()));
    if (!isItemFormat) return 'NO';

    // Region name from title row (row 0), first non-empty cell
    const titleRow = firstRaw[0] as string[];
    const regionName = titleRow.map(v => String(v ?? '').trim()).find(Boolean)
      || filename.replace(/\.[^.]+$/, '');

    // Build master warehouse list from first-sheet header row
    interface WHEntry { ci: number; name: string; key: string; }
    const masterWH: WHEntry[] = [];
    for (let ci = 1; ci < hRow.length; ci++) {
      const name = String(hRow[ci] ?? '').trim();
      if (!name || IGNORE_WH_PAT.test(name)) continue;
      masterWH.push({ ci, name, key: `w${masterWH.length}` });
    }
    if (!masterWH.length) return 'NO';

    const areaCols: ColMeta[] = masterWH.map(wc => ({
      key: wc.key, label: wc.name, region: regionName, colIdx: wc.ci,
    }));

    const allRows: Record<string, string>[] = [];

    for (const sheetName of wb.SheetNames) {
      const raw = XLSX.utils.sheet_to_json<unknown[]>(
        wb.Sheets[sheetName], { header: 1, defval: '' }
      );
      if (raw.length < 3) continue;

      // Build name→colIdx map for this sheet (handles different column order per sheet)
      const sheetHRow = raw[1] as string[];
      const nameToCI: Record<string, number> = {};
      for (let ci = 1; ci < sheetHRow.length; ci++) {
        const name = String(sheetHRow[ci] ?? '').trim();
        if (!name || IGNORE_WH_PAT.test(name)) continue;
        nameToCI[name] = ci;
      }

      // Data rows start at index 2
      for (let ri = 2; ri < raw.length; ri++) {
        const arr = raw[ri] as string[];
        const itemName = String(arr[0] ?? '').trim();
        if (!itemName) continue;

        const obj: Record<string, string> = { 'الشركة': sheetName, 'المادة': itemName };
        for (const wc of masterWH) {
          const srcCi = nameToCI[wc.name];
          obj[wc.key] = srcCi !== undefined ? String(arr[srcCi] ?? '') : '';
        }
        allRows.push(obj);
      }
    }

    if (!allRows.length) return 'لم يتم العثور على بيانات في الملف';

    return {
      id: uid(),
      name: filename.replace(/\.[^.]+$/, ''),
      uploadedAt: new Date().toISOString(),
      fixedCols: ['الشركة', 'المادة'],
      areaCols,
      rows: allRows,
      regions: [regionName],
    };
  } catch (err) {
    console.error(err);
    return 'فشل قراءة الملف';
  }
}

// ── Merge helper: detect company col in a SalesFile ───────────────────────────
const COMPANY_KW = ['company','comp','شركة','الشركة','شركه','الشركه','vendor','supplier','brand','manufacture','principal','item code','itemcode'];
const ITEM_KW_EXACT = ['item','الايتم','اسم الايتم','اسم المادة','اسم الماده','المادة','المادة','مادة','مادة','المواد','مواد','name','product','منتج','المنتج','الاصناف','اصناف','صنف','الدواء','دواء'];
const ITEM_KW_PART  = ['item','الايتم','اسم','نام','name','product','مادة','مادة','دواء','صنف'];

const PRICE_KW = ['price', 'سعر', 'السعر', 'unit price', 'سعر الوحدة', 'سعر الوحده', 'cost', 'تكلفة'];

// Normalize a column header the same way we normalize item/company values
function normColHeader(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[\u064B-\u065F\u0670]/g, '')           // strip tashkeel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef variants → ا
    .replace(/\u0629/g, '\u0647')                     // ة → ه
    .replace(/\u0649/g, '\u064A')                     // ى → ي
    .replace(/\s+/g, ' ');
}

function detectCompanyCol(f: SalesFile): string {
  const normed = f.fixedCols.map(c => normColHeader(c));
  const kwNormed = COMPANY_KW.map(normColHeader);
  return f.fixedCols.find((_, i) => kwNormed.some(k => normed[i].includes(k))) ?? '';
}

function detectItemNameCol(f: SalesFile): string {
  const normed = f.fixedCols.map(c => normColHeader(c));
  const exactN = ITEM_KW_EXACT.map(normColHeader);
  const partN  = ITEM_KW_PART.map(normColHeader);
  const exact = f.fixedCols.find((_, i) => exactN.some(k => normed[i] === k));
  if (exact) return exact;
  return (
    f.fixedCols.find((_, i) =>
      partN.some(k => normed[i].includes(k)) &&
      !normed[i].includes('code') && !normed[i].includes('كود') && !normed[i].includes('id')
    ) ?? f.fixedCols[1] ?? f.fixedCols[0] ?? ''
  );
}

function detectPriceCol(f: SalesFile): string {
  const lower = f.fixedCols.map(c => c.toLowerCase().trim());
  return f.fixedCols.find((_, i) => PRICE_KW.some(k => lower[i].includes(k))) ?? '';
}

// ── Name normalization: strip country/origin suffixes so variant spellings merge ─
function stripMergeSuffix(s: string): string {
  let n = s.trim();
  // e.g. "RAM PharmaJordanN/A" → "RAM"
  const RE_PHAR    = /\s+(phar|pharma)\s*(iraq|iraqi|turkey|jordan|egypt|italy|canadian|cyprus|iran|lebanon|germany|france|syria)?\s*(n\/a)?\s*$/i;
  // e.g. "ALBALSAMIraqiN/A" or "ALBALSAM Iraq N/A" → "ALBALSAM"
  const RE_COUNTRY = /\s*(iraq|iraqi|turkey|jordan|egypt|italy|canadian|cyprus|iran|lebanon|germany|france|syria)\s*(n\/a)?\s*$/i;
  // standalone N/A
  const RE_NA      = /\s*n\/a\s*$/i;
  let prev = '';
  while (n !== prev) {
    prev = n;
    n = n.replace(RE_PHAR, '').replace(RE_COUNTRY, '').replace(RE_NA, '').trim();
  }
  return n || s.trim(); // never return empty
}
function normalMergeKey(s: string): string {
  return stripMergeSuffix(s)
    .toLowerCase()
    // ── Arabic normalization ──────────────────────────────────────────────
    .replace(/[\u064B-\u065F\u0670]/g, '')              // strip tashkeel (diacritics)
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')   // alef variants → ا
    .replace(/\u0629/g, '\u0647')                        // ta marbuta ة → ه
    .replace(/\u0649/g, '\u064A')                        // alef maqsoura ى → ي
    // ── Punctuation → space ──────────────────────────────────────────────
    .replace(/[.\-\/\\,+()[\]'"]/g, ' ')
    // ── Normalize unit spacing: "500 mg" → "500mg" ───────────────────────
    .replace(/(\d)\s+(mg|mcg|ml|iu|gm|g\b|mm|cm|tabs?|caps?|amp)/gi,
      (_, n, u) => n + u.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}

// ── buildMergedFile: combine multiple SalesFiles into one ─────────────────────
function buildMergedFile(selectedFiles: SalesFile[], names: string[]): SalesFile {
  // Union of areaCols — preserve each column's ORIGINAL region (from parsing)
  // so warehouses stay grouped under their actual region after merge, instead of
  // being all reassigned to the source file's name.
  // Key by ORIGINAL_REGION + label to dedupe across files that share the same region.
  const colMap = new Map<string, ColMeta>();
  for (const f of selectedFiles) {
    for (const ac of f.areaCols) {
      const region = (ac.region && ac.region.trim()) ? ac.region.trim() : f.name;
      const mapKey = `${region}||${ac.label}`;
      if (!colMap.has(mapKey)) {
        colMap.set(mapKey, { key: `m_${colMap.size}`, label: ac.label, region, colIdx: -1 });
      }
    }
  }
  const mergedAreaCols = [...colMap.values()];
  // regions list = union of actual regions present in merged area columns
  const allRegions = [...new Set(mergedAreaCols.map(c => c.region).filter(Boolean))];

  // Pass 1: build canonical name maps — shortest clean version wins
  const canonCompany = new Map<string, string>(); // normKey → display name
  const canonItem    = new Map<string, string>();
  function updateCanon(map: Map<string, string>, raw: string) {
    const key   = normalMergeKey(raw);
    const clean = stripMergeSuffix(raw);
    if (!map.has(key) || clean.length < map.get(key)!.length) map.set(key, clean);
  }
  for (const f of selectedFiles) {
    const cCol = detectCompanyCol(f);
    const iCol = detectItemNameCol(f);
    for (const row of f.rows) {
      const rawC = cCol ? String(row[cCol] ?? '').trim() : f.name;
      const rawI = iCol ? String(row[iCol] ?? '').trim() : '';
      if (!rawI) continue;
      updateCanon(canonCompany, rawC);
      updateCanon(canonItem, rawI);
    }
  }

  // Pass 2: group rows by canonical (company, item), accumulate area values
  const rowMap = new Map<string, Record<string, string>>();
  for (const f of selectedFiles) {
    const cCol = detectCompanyCol(f);
    const iCol = detectItemNameCol(f);
    const pCol = detectPriceCol(f);
    // Map each source areaCol key → merged areaCol key, using the SAME
    // (region || file name) key the mergedAreaCols were built with.
    const acKeyToMerged = new Map<string, string>();
    for (const ac of f.areaCols) {
      const region = (ac.region && ac.region.trim()) ? ac.region.trim() : f.name;
      const m = colMap.get(`${region}||${ac.label}`);
      if (m) acKeyToMerged.set(ac.key, m.key);
    }
    // All distinct regions a row from this file COULD belong to
    const fileRegions = [...new Set(f.areaCols.map(ac =>
      (ac.region && ac.region.trim()) ? ac.region.trim() : f.name
    ))];
    for (const row of f.rows) {
      const rawC = cCol ? String(row[cCol] ?? '').trim() : f.name;
      const rawI = iCol ? String(row[iCol] ?? '').trim() : '';
      if (!rawI) continue;
      const company = canonCompany.get(normalMergeKey(rawC)) ?? stripMergeSuffix(rawC);
      const item    = canonItem.get(normalMergeKey(rawI))    ?? stripMergeSuffix(rawI);
      const rowKey  = `${normalMergeKey(rawC)}||${normalMergeKey(rawI)}`;
      if (!rowMap.has(rowKey)) {
        rowMap.set(rowKey, { 'الشركة': company, 'المادة': item, '_regions': fileRegions.join(',') });
      } else {
        const obj = rowMap.get(rowKey)!;
        const seen = new Set(obj['_regions'].split(',').filter(Boolean));
        for (const r of fileRegions) seen.add(r);
        obj['_regions'] = [...seen].join(',');
      }
      // Accumulate numeric area column values
      const obj = rowMap.get(rowKey)!;
      for (const ac of f.areaCols) {
        const mk = acKeyToMerged.get(ac.key);
        if (mk) obj[mk] = String(toNum(obj[mk] ?? '') + toNum(String(row[ac.key] ?? '')));
      }
      // Copy price — first non-zero value wins
      if (pCol && !obj['السعر'] && toNum(String(row[pCol] ?? '')) > 0) {
        obj['السعر'] = String(row[pCol]);
      }
    }
  }

  const hasPriceInAnyFile = selectedFiles.some(f => detectPriceCol(f));

  // Build debug info: which column was detected for each source file
  const _mergeDebug = selectedFiles.map(f => ({
    file: f.name,
    companyCol: detectCompanyCol(f) || `(لم يُعثر — استخدم اسم الملف)`,
    itemCol:    detectItemNameCol(f),
    rows:       f.rows.length,
  }));

  const shortNames = names.map(n => n.length > 12 ? n.slice(0, 12) + '…' : n).join(' + ');
  return {
    id: uid(),
    name: `دمج: ${shortNames}`,
    uploadedAt: new Date().toISOString(),
    fixedCols: hasPriceInAnyFile ? ['الشركة', 'المادة', 'السعر'] : ['الشركة', 'المادة'],
    areaCols: mergedAreaCols,
    rows: [...rowMap.values()],
    regions: allRegions,
    sourceFileIds: selectedFiles.map(f => f.id),
    _mergeDebug,
  };
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function SalesDataPage() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [files, setFiles]           = useState<SalesFile[]>([]);
  const [activeId, setActiveId]     = useState<string>('');
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting]   = useState(false);
  const [importErr, setImportErr]   = useState('');

  // Fetch files from server on mount / when user changes
  useEffect(() => {
    let alive = true;
    setLoadingFiles(true);
    apiListFiles().then(list => {
      if (!alive) return;
      setFiles(list);
      setActiveId(prev => prev || (list[0]?.id ?? ''));
      setLoadingFiles(false);
    });
    return () => { alive = false; };
  }, [userId]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [itemQuery, setItemQuery]         = useState('');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [regionFilter, setRegionFilter]   = useState('all');
  const [warehouseKeys, setWarehouseKeys] = useState<Set<string>>(new Set());
  const [page, setPage]           = useState(1);
  const [tab, setTab]             = useState<'table' | 'analysis'>('table');
  const [showValue, setShowValue] = useState(false);
  const [colFilters, setColFilters]       = useState<Record<string, string[]>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [filterSearch, setFilterSearch]   = useState('');
  const [showMergePanel, setShowMergePanel] = useState(false);
  const [mergeChecked, setMergeChecked]     = useState<Set<string>>(new Set());
  const [showAddToMerge, setShowAddToMerge] = useState(false);
  const [addChecked, setAddChecked]         = useState<Set<string>>(new Set());
  const [showItemPills, setShowItemPills]   = useState(false);

  // ── Shortage Radar ─────────────────────────────────────────────
  const [showShortages, setShowShortages]         = useState(false);
  const [shortageOnlyMode, setShortageOnlyMode]   = useState(false);
  const [shortageThreshold, setShortageThreshold] = useState<number>(() => {
    const v = parseInt(localStorage.getItem('sd_shortage_threshold') || '30', 10);
    return Number.isFinite(v) && v >= 0 ? v : 30;
  });
  const [highlightLow, setHighlightLow] = useState<boolean>(() => localStorage.getItem('sd_highlight_low') === '1');
  const [shortageView, setShortageView] = useState<'by-region' | 'by-item' | 'by-warehouse' | 'by-company'>('by-region');
  useEffect(() => { localStorage.setItem('sd_shortage_threshold', String(shortageThreshold)); }, [shortageThreshold]);
  useEffect(() => { localStorage.setItem('sd_highlight_low', highlightLow ? '1' : '0'); }, [highlightLow]);

  // ── Warehouse Classification (A/B/C) ──────────────────────────
  type WarehouseCategory = 'A' | 'B' | 'C';
  type WarehouseClass = { region: string; warehouse: string; category: WarehouseCategory };
  const [warehouseClasses, setWarehouseClasses] = useState<WarehouseClass[]>(() => {
    try { return JSON.parse(localStorage.getItem('sd_warehouse_classes') || '[]'); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem('sd_warehouse_classes', JSON.stringify(warehouseClasses)); }, [warehouseClasses]);
  const [showClassifyModal, setShowClassifyModal] = useState(false);
  const [classifyUploadMsg, setClassifyUploadMsg] = useState('');
  const classifyFileRef = useRef<HTMLInputElement>(null);
  const [focusCategoryA, setFocusCategoryA] = useState(false);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const normName = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const classifyMap = useMemo(() => {
    const m: Record<string, WarehouseCategory> = {};
    for (const c of warehouseClasses) {
      m[`${normName(c.region)}||${normName(c.warehouse)}`] = c.category;
      m[`||${normName(c.warehouse)}`] = c.category; // fallback: match by warehouse name alone
    }
    return m;
  }, [warehouseClasses]);
  const getCategory = useCallback((region: string, warehouse: string): WarehouseCategory | null => {
    const k = `${normName(region)}||${normName(warehouse)}`;
    return classifyMap[k] ?? classifyMap[`||${normName(warehouse)}`] ?? null;
  }, [classifyMap]);

  const handleClassifyUpload = (file: File) => {
    setClassifyUploadMsg('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        const parsed: WarehouseClass[] = [];
        for (const r of rows) {
          const region    = String(r['المنطقة'] ?? r['منطقة'] ?? r['region'] ?? r['Region'] ?? '').trim();
          const warehouse = String(r['المخزن'] ?? r['مخزن'] ?? r['اسم المخزن'] ?? r['warehouse'] ?? r['Warehouse'] ?? '').trim();
          const catRaw    = String(r['التصنيف'] ?? r['الفئة'] ?? r['category'] ?? r['Category'] ?? '').trim().toUpperCase();
          if (!warehouse) continue;
          if (!['A', 'B', 'C'].includes(catRaw)) continue;
          parsed.push({ region, warehouse, category: catRaw as WarehouseCategory });
        }
        if (parsed.length === 0) {
          setClassifyUploadMsg('⚠ لم يتم العثور على بيانات صالحة. تأكد من الأعمدة: المنطقة / المخزن / التصنيف (A أو B أو C).');
          return;
        }
        setWarehouseClasses(parsed);
        setClassifyUploadMsg(`✓ تم استيراد ${parsed.length} مخزن.`);
      } catch (err: any) {
        setClassifyUploadMsg('⚠ فشل قراءة الملف: ' + (err?.message ?? ''));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const downloadClassifyTemplate = () => {
    const data = [
      { 'المنطقة': 'najaf', 'المخزن': 'ابن سينا', 'التصنيف': 'A' },
      { 'المنطقة': 'najaf', 'المخزن': 'سما دجلة', 'التصنيف': 'B' },
      { 'المنطقة': 'najaf', 'المخزن': 'المعتصم', 'التصنيف': 'C' },
    ];
    const ws = XLSX.utils.json_to_sheet(data);
    (ws as any)['!views'] = [{ RTL: true }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'تصنيف المذاخر');
    XLSX.writeFile(wb, 'warehouse_classification_template.xlsx');
  };

  // All warehouses present in the currently-active file (for match report)
  // NOTE: defined later in this component, after `activeFile` is declared.

  // Back button: close open overlays/panels
  useBackHandler([
    [showShortages,           () => setShowShortages(false)],
    [showImport,              () => { setShowImport(false); setImportErr(''); }],
    [openFilterCol !== null,  () => setOpenFilterCol(null)],
    [showClassifyModal,       () => setShowClassifyModal(false)],
  ]);
  const PAGE_SIZE = 50;

  const activeFile = files.find(f => f.id === activeId);

  // All warehouses present in the currently-active file (for match report)
  const activeWarehousesAll = useMemo(() => {
    if (!activeFile) return [] as { region: string; warehouse: string; key: string }[];
    return activeFile.areaCols.map(ac => ({ region: ac.region, warehouse: ac.label, key: ac.key }));
  }, [activeFile]);

  // ── Export rendered table (preserving inline styles) ──────────────────────
  const buildStyledTableHTML = useCallback((): string | null => {
    const container = tableContainerRef.current;
    if (!container) return null;
    const table = container.querySelector('table');
    if (!table) return null;
    const clone = table.cloneNode(true) as HTMLTableElement;
    // Strip interactive controls (filter buttons, dropdowns) from cloned headers
    clone.querySelectorAll('button, input, [data-col-filter] > div').forEach(el => {
      const hostCell = el.closest('th, td');
      const tagged = (el as HTMLElement).getAttribute && (el as HTMLElement).getAttribute('data-col-filter');
      if (tagged && hostCell) (el as HTMLElement).remove();
      else if ((el as HTMLElement).tagName === 'BUTTON') (el as HTMLElement).remove();
      else if ((el as HTMLElement).tagName === 'INPUT') (el as HTMLElement).remove();
    });
    // Strip cells/sections marked for export omission (الشامل column + المجموع footer)
    clone.querySelectorAll('[data-export="omit"]').forEach(el => el.remove());
    // Force solid borders on all cells for Word/Excel readability
    clone.style.borderCollapse = 'collapse';
    clone.querySelectorAll('th, td').forEach(c => {
      const el = c as HTMLElement;
      if (!el.style.border) el.style.border = '1px solid #e2e8f0';
      el.style.padding = el.style.padding || '6px 8px';
    });
    return clone.outerHTML;
  }, []);

  const exportTableToExcel = useCallback(() => {
    const tableHTML = buildStyledTableHTML();
    if (!tableHTML) { alert('لا يوجد جدول للتصدير'); return; }
    const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head>
<meta charset="utf-8"/>
<!--[if gte mso 9]><xml>
 <x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
  <x:Name>بيانات المبيعات</x:Name>
  <x:WorksheetOptions><x:DisplayRightToLeft/></x:WorksheetOptions>
 </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
<style>body{font-family:Arial,Tahoma,sans-serif;direction:rtl}table{border-collapse:collapse}</style>
</head><body dir="rtl">${tableHTML}</body></html>`;
    const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales_${activeFile?.name?.replace(/\.[^.]+$/, '') || 'data'}_${new Date().toISOString().slice(0, 10)}.xls`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [activeFile, buildStyledTableHTML]);

  const exportTableToWord = useCallback(() => {
    const tableHTML = buildStyledTableHTML();
    if (!tableHTML) { alert('لا يوجد جدول للتصدير'); return; }
    const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head>
<meta charset="utf-8"/>
<title>بيانات المبيعات</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>90</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
@page{size:A3 landscape;margin:1cm}
body{font-family:Arial,Tahoma,sans-serif;direction:rtl}
table{border-collapse:collapse;width:100%}
</style>
</head><body dir="rtl">${tableHTML}</body></html>`;
    const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales_${activeFile?.name?.replace(/\.[^.]+$/, '') || 'data'}_${new Date().toISOString().slice(0, 10)}.doc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [activeFile, buildStyledTableHTML]);

  const exportTableToPDF = useCallback(async () => {
    const container = tableContainerRef.current;
    if (!container) { alert('لا يوجد جدول للتصدير'); return; }
    const table = container.querySelector('table');
    if (!table) { alert('لا يوجد جدول للتصدير'); return; }

    // Clone the table off-screen with sticky positioning reset, so the
    // rendered image matches the visual layout exactly.
    const clone = table.cloneNode(true) as HTMLTableElement;
    clone.querySelectorAll('button, input').forEach(el => (el as HTMLElement).remove());
    clone.querySelectorAll('[data-export="omit"]').forEach(el => el.remove());
    clone.style.borderCollapse = 'collapse';
    clone.style.background = '#fff';
    clone.querySelectorAll('th, td').forEach(c => {
      const el = c as HTMLElement;
      el.style.position = 'static';
      if (!el.style.border) el.style.border = '1px solid #e2e8f0';
      el.style.padding = el.style.padding || '6px 8px';
    });

    const wrap = document.createElement('div');
    wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText = 'position:fixed;top:0;left:-99999px;background:#fff;padding:12px;font-family:Arial,Tahoma,sans-serif;';
    wrap.appendChild(clone);
    document.body.appendChild(wrap);

    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(wrap, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/png'));
      if (!blob) throw new Error('تعذّر إنشاء الصورة');

      let copied = false;
      try {
        if (navigator.clipboard && (window as any).ClipboardItem) {
          await navigator.clipboard.write([new (window as any).ClipboardItem({ 'image/png': blob })]);
          copied = true;
        }
      } catch { /* fall through */ }

      if (copied) {
        alert('✅ تم نسخ صورة الجدول إلى الحافظة — الصقها مباشرة (Ctrl+V)');
      } else {
        const a = document.createElement('a');
        const fname = `sales_${activeFile?.name?.replace(/\.[^.]+$/, '') || 'data'}_${new Date().toISOString().slice(0, 10)}.png`;
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        alert('تعذّر النسخ التلقائي — تم تحميل الصورة بدلاً من ذلك');
      }
    } catch (err) {
      console.error(err);
      alert('فشل تحويل الجدول إلى صورة: ' + (err as Error).message);
    } finally {
      document.body.removeChild(wrap);
    }
  }, [activeFile]);

  // Display columns: region totals when all, else individual warehouse cols
  const displayCols = useMemo<ViewCol[]>(() => {
    if (!activeFile) return [];
    if (regionFilter === 'all') {
      const groups: Record<string, ColMeta[]> = {};
      activeFile.areaCols.forEach(ac => {
        if (!groups[ac.region]) groups[ac.region] = [];
        groups[ac.region].push(ac);
      });
      return Object.entries(groups).map(([region, cols]) => ({
        key: `rt_${region}`, label: region, region, colIdx: -1 as const,
        isRegionTotal: true as const, cols,
      }));
    }
    const colsInRegion = activeFile.areaCols.filter(ac => ac.region === regionFilter);
    if (warehouseKeys.size > 0) return colsInRegion.filter(ac => warehouseKeys.has(ac.key));
    return colsInRegion;
  }, [activeFile, regionFilter, warehouseKeys]);

  // Auto-detect company column
  const companyCol = useMemo(() => {
    if (!activeFile) return '';
    const keywords = ['company', 'comp', 'شركة', 'الشركة', 'vendor', 'supplier', 'brand', 'manufacture', 'principal', 'item code', 'itemcode'];
    const lower = activeFile.fixedCols.map(c => c.toLowerCase().trim());
    return activeFile.fixedCols.find((_, i) => keywords.some(k => lower[i].includes(k))) ?? '';
  }, [activeFile]);

  // Unique company values for pills
  const companies = useMemo(() => {
    if (!activeFile || !companyCol) return [];
    let rows = activeFile.rows;
    if (regionFilter !== 'all') {
      const hasTags = rows.some(r => r['_regions'] || r['_sourceFile']);
      if (hasTags) rows = rows.filter(r => {
        if (r['_regions'])    return r['_regions'].split(',').includes(regionFilter);
        if (r['_sourceFile']) return r['_sourceFile'] === regionFilter;
        return true;
      });
    }
    return [...new Set(rows.map(r => String(r[companyCol] ?? '').trim()).filter(Boolean))].sort();
  }, [activeFile, companyCol, regionFilter]);

  // Filtered rows by item selection / text query + company filter + column filters
  const filteredRows = useMemo(() => {
    if (!activeFile) return [];
    let rows = activeFile.rows;
    if (regionFilter !== 'all') {
      const hasTags = rows.some(r => r['_regions'] || r['_sourceFile']);
      if (hasTags) rows = rows.filter(row => {
        if (row['_regions'])    return row['_regions'].split(',').includes(regionFilter);
        if (row['_sourceFile']) return row['_sourceFile'] === regionFilter;
        return true;
      });
    }
    if (selectedItems.length > 0) {
      rows = rows.filter(row =>
        selectedItems.some(sel => activeFile.fixedCols.some(c => String(row[c] ?? '').trim() === sel))
      );
    } else {
      const q = itemQuery.trim().toLowerCase();
      if (q) rows = rows.filter(row => activeFile.fixedCols.some(c => String(row[c] ?? '').toLowerCase().includes(q)));
    }
    if (companyFilter !== 'all' && companyCol) rows = rows.filter(row => String(row[companyCol] ?? '').trim() === companyFilter);
    Object.entries(colFilters).forEach(([col, vals]) => {
      if (vals.length > 0) rows = rows.filter(row => vals.includes(String(row[col] ?? '').trim()));
    });
    return rows;
  }, [activeFile, selectedItems, itemQuery, companyFilter, companyCol, colFilters, regionFilter]);

  // Grand totals per display column
  const grandTotals = useMemo(() => {
    const map: Record<string, number> = {};
    filteredRows.forEach(row => {
      displayCols.forEach(col => { map[col.key] = (map[col.key] ?? 0) + cellVal(row, col); });
    });
    return map;
  }, [filteredRows, displayCols]);

  const grandTotal = Object.values(grandTotals).reduce((s, v) => s + v, 0);

  // Top 15 items by visible total
  const topItems = useMemo(() => {
    if (!activeFile) return [];
    return [...filteredRows]
      .map(row => ({ row, total: rowTotal(row, displayCols) }))
      .filter(x => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);
  }, [filteredRows, displayCols, activeFile]);

  // Detect price column (for monetary value mode)
  const priceCol = useMemo(() => {
    if (!activeFile) return '';
    const lower = activeFile.fixedCols.map(c => c.toLowerCase());
    return (
      activeFile.fixedCols.find((_, i) =>
        ['price', 'سعر', 'السعر', 'unit price', 'سعر الوحدة', 'سعر الوحده', 'cost', 'تكلفة'].some(k => lower[i].includes(k))
      ) ?? ''
    );
  }, [activeFile]);

  // Detect item name column
  const itemNameCol = useMemo(() => {
    if (!activeFile) return '';
    const lower = activeFile.fixedCols.map(c => c.toLowerCase().trim());
    // Prefer exact match first, then partial match — to avoid "Item Code" beating "Item"
    const exactKeywords = ['item', 'الايتم', 'اسم الايتم', 'اسم المادة', 'اسم الماده', 'المادة', 'مادة', 'المواد', 'name', 'product', 'منتج', 'المنتج'];
    const exactMatch = activeFile.fixedCols.find((_, i) =>
      exactKeywords.some(k => lower[i] === k)
    );
    if (exactMatch) return exactMatch;
    const partialKeywords = ['item', 'الايتم', 'اسم', 'نام', 'name', 'product'];
    return (
      activeFile.fixedCols.find((_, i) =>
        partialKeywords.some(k => lower[i].includes(k)) && !lower[i].includes('code') && !lower[i].includes('كود') && !lower[i].includes('id')
      ) ??
      activeFile.fixedCols[1] ?? activeFile.fixedCols[0] ?? ''
    );
  }, [activeFile]);

  // Detect item code column
  const itemCodeCol = useMemo(() => {
    if (!activeFile) return '';
    const lower = activeFile.fixedCols.map(c => c.toLowerCase());
    return activeFile.fixedCols.find((_, i) => ['code', 'كود', 'رمز', 'barcode', 'sku'].some(k => lower[i].includes(k))) ?? '';
  }, [activeFile]);

  // Returns display value: if showValue is on, multiply qty by price
  const cellDisplay = useCallback((row: Record<string, string>, col: ViewCol): number => {
    const qty = cellVal(row, col);
    if (!showValue || !priceCol) return qty;
    const price = toNum(row[priceCol] ?? '');
    return price > 0 ? qty * price : qty;
  }, [showValue, priceCol]);

  const rowDisplay = useCallback((row: Record<string, string>, cols: ViewCol[]): number =>
    cols.reduce((s, col) => s + cellDisplay(row, col), 0)
  , [cellDisplay]);

  // ── Expose active sales data on window so the AI Assistant can query it ──
  // Stores the full active file plus a digest with column hints. Cleared on unmount.
  useEffect(() => {
    if (!activeFile) {
      delete (window as any).__salesData;
      delete (window as any).__salesDataDigest;
      return;
    }
    const items = itemNameCol
      ? [...new Set(activeFile.rows.map(r => String(r[itemNameCol] ?? '').trim()).filter(Boolean))]
      : [];
    const comps = companyCol
      ? [...new Set(activeFile.rows.map(r => String(r[companyCol] ?? '').trim()).filter(Boolean))]
      : [];
    const regions = [...new Set(activeFile.areaCols.map(ac => ac.region))];
    const warehouses = [...new Set(activeFile.areaCols.map(ac => ac.label))];
    (window as any).__salesData = {
      file: activeFile,
      itemNameCol,
      companyCol,
      priceCol,
    };
    (window as any).__salesDataDigest = {
      fileName: activeFile.name,
      items,
      companies: comps,
      regions,
      warehouses,
    };
    return () => {
      delete (window as any).__salesData;
      delete (window as any).__salesDataDigest;
    };
  }, [activeFile, itemNameCol, companyCol, priceCol]);

  // ── Shortage Radar: per-item analysis over filtered rows ──────────────────
  // Tracks both region totals and individual warehouse columns.
  const shortages = useMemo(() => {
    if (!activeFile) return { out: [], critical: [], low: [], totalCount: 0, allRegions: [] as string[] };
    const groups: Record<string, ColMeta[]> = {};
    // When a region is selected, only include warehouses of that region
    const relevantCols = regionFilter === 'all'
      ? activeFile.areaCols
      : activeFile.areaCols.filter(ac => ac.region === regionFilter);
    relevantCols.forEach(ac => { (groups[ac.region] ||= []).push(ac); });
    const regionCols: RegionTotalCol[] = Object.entries(groups).map(([region, cols]) => ({
      key: `rt_${region}`, label: region, region, colIdx: -1 as const, isRegionTotal: true as const, cols,
    }));
    const allRegions = regionCols.map(r => r.region);

    const T = Math.max(0, shortageThreshold || 0);
    const half = Math.max(1, Math.floor(T / 2));

    const sevOf = (qty: number): 'out' | 'critical' | 'low' | null => {
      if (qty === 0) return 'out';
      if (T > 0 && qty < half) return 'critical';
      if (T > 0 && qty < T) return 'low';
      return null;
    };

    type LowRegion    = { region: string; qty: number; sev: 'out' | 'critical' | 'low' };
    type LowWarehouse = { warehouse: string; region: string; qty: number; sev: 'out' | 'critical' | 'low' };
    type Entry = {
      row: Record<string, string>;
      name: string;
      company: string;
      total: number;
      perRegion: { region: string; qty: number }[];
      lowRegions: LowRegion[];
      lowWarehouses: LowWarehouse[];
      severity: 'out' | 'critical' | 'low';
    };

    const out: Entry[] = [];
    const critical: Entry[] = [];
    const low: Entry[] = [];

    for (const row of filteredRows) {
      const perRegion = regionCols.map(col => ({ region: col.region, qty: cellVal(row, col) }));
      const total = perRegion.reduce((s, r) => s + r.qty, 0);

      const lowRegions: LowRegion[] = perRegion
        .map(r => { const sev = sevOf(r.qty); return sev ? { region: r.region, qty: r.qty, sev } : null; })
        .filter((x): x is LowRegion => !!x);

      const lowWarehouses: LowWarehouse[] = relevantCols
        .map(ac => { const qty = toNum(row[ac.key] ?? ''); const sev = sevOf(qty); return sev ? { warehouse: ac.label, region: ac.region, qty, sev } : null; })
        .filter((x): x is LowWarehouse => !!x);

      let severity: Entry['severity'] | null = null;
      if (lowWarehouses.some(w => w.sev === 'out')) severity = 'out';
      else if (lowWarehouses.some(w => w.sev === 'critical')) severity = 'critical';
      else if (lowWarehouses.some(w => w.sev === 'low')) severity = 'low';

      if (!severity) continue;

      const name = itemNameCol ? String(row[itemNameCol] ?? '').trim() : '';
      const company = companyCol ? String(row[companyCol] ?? '').trim() : '';
      const entry: Entry = { row, name, company, total, perRegion, lowRegions, lowWarehouses, severity };
      // An item appears in every bucket it has at least one warehouse in.
      // (Previously we placed each item in only its WORST bucket, which left
      //  the "حرج" and "منخفض" lists nearly empty whenever the item had any
      //  zero warehouse anywhere.)
      if (lowWarehouses.some(w => w.sev === 'out'))      out.push(entry);
      if (lowWarehouses.some(w => w.sev === 'critical')) critical.push(entry);
      if (lowWarehouses.some(w => w.sev === 'low'))      low.push(entry);
    }

    out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    critical.sort((a, b) => a.total - b.total);
    low.sort((a, b) => a.total - b.total);

    // Total count = unique items across all buckets
    const uniq = new Set<string>();
    for (const e of [...out, ...critical, ...low]) uniq.add(e.name + '|' + e.company);
    return { out, critical, low, totalCount: uniq.size, allRegions };
  }, [activeFile, filteredRows, shortageThreshold, itemNameCol, companyCol, regionFilter]);

  // Unique values for the currently-open filter column
  const colUniqueVals = useMemo(() => {
    if (!activeFile || !openFilterCol) return [];
    return [...new Set(activeFile.rows.map(r => String(r[openFilterCol] ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  }, [activeFile, openFilterCol]);

  // Reset column filters when switching files
  useEffect(() => { setColFilters({}); setOpenFilterCol(null); }, [activeId]);

  // Close col-filter dropdown on outside click
  useEffect(() => {
    if (!openFilterCol) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-col-filter]')) setOpenFilterCol(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openFilterCol]);

  const totalPages = 1;
  // Sort: by total desc when showValue active, else by company → item name
  const pageRows = useMemo(() => {
    const rows = [...filteredRows];
    return rows.sort((a, b) => {
      const ca = String(a[companyCol] ?? '').toLowerCase();
      const cb = String(b[companyCol] ?? '').toLowerCase();
      if (ca !== cb) return ca.localeCompare(cb, 'ar');
      const ia = String(a[itemNameCol] ?? '').toLowerCase();
      const ib = String(b[itemNameCol] ?? '').toLowerCase();
      return ia.localeCompare(ib, 'ar');
    });
  }, [filteredRows, companyCol, itemNameCol]);

  // Handlers
  const handleFile = useCallback((file: File): Promise<{ ok: boolean; err?: string; saved?: SalesFile }> => {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = async e => {
        const buf = e.target!.result as ArrayBuffer;
        const multiResult = parseMultiSheetStock(buf, file.name);
        const result = multiResult === 'NO' ? parseExcel(buf, file.name) : multiResult;
        if (typeof result === 'string') {
          resolve({ ok: false, err: `${file.name}: ${result}` });
          return;
        }
        const saved = await apiCreateFile(result as SalesFile);
        if (!saved) { resolve({ ok: false, err: `${file.name}: فشل حفظ الملف على الخادم` }); return; }
        resolve({ ok: true, saved });
      };
      reader.onerror = () => resolve({ ok: false, err: `${file.name}: فشل قراءة الملف` });
      reader.readAsArrayBuffer(file);
    });
  }, []);

  // Multi-file batch import (sequential to avoid server race)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const handleFilesList = useCallback(async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (arr.length === 0) return;
    setImportErr('');
    setImporting(true);
    const errors: string[] = [];
    const savedFiles: SalesFile[] = [];
    for (let i = 0; i < arr.length; i++) {
      setImportProgress({ current: i + 1, total: arr.length, name: arr[i].name });
      const r = await handleFile(arr[i]);
      if (r.ok && r.saved) savedFiles.push(r.saved);
      else if (r.err) errors.push(r.err);
    }
    if (savedFiles.length > 0) {
      setFiles(prev => [...prev, ...savedFiles]);
      setActiveId(savedFiles[0].id);
      setSelectedItems([]); setItemQuery(''); setCompanyFilter('all'); setRegionFilter('all'); setWarehouseKeys(new Set()); setColFilters({}); setPage(1);
      setShowImport(false);
    }
    if (errors.length > 0) setImportErr(errors.join('\n'));
    setImporting(false);
    setImportProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [handleFile]);

  // Opens native file picker directly
  const openFilePicker = useCallback(() => {
    setImportErr('');
    if (fileRef.current) {
      fileRef.current.value = '';
      fileRef.current.click();
    }
  }, []);

  const deleteFile = async (id: string) => {
    if (!confirm('حذف هذا الملف؟')) return;
    const ok = await apiDeleteFile(id);
    if (!ok) { alert('فشل حذف الملف من الخادم'); return; }

    // Remove the deleted file and any merged files that depended on it (server-side too)
    const current = files;
    let next = current.filter(f => f.id !== id);

    // Find merged files that depended on the deleted source and need rebuilding/removal
    const toRebuild: { oldId: string; rebuilt: SalesFile | null }[] = [];
    for (const f of next) {
      if (!f.sourceFileIds?.includes(id)) continue;
      const remainingSources = next.filter(s => f.sourceFileIds!.includes(s.id));
      if (remainingSources.length >= 2) {
        const rebuilt = buildMergedFile(remainingSources, remainingSources.map(s => s.name));
        toRebuild.push({ oldId: f.id, rebuilt });
      } else {
        toRebuild.push({ oldId: f.id, rebuilt: null });
      }
    }

    // Apply rebuilds: delete old merged file, create new one (if rebuilt)
    for (const { oldId, rebuilt } of toRebuild) {
      await apiDeleteFile(oldId);
      next = next.filter(f => f.id !== oldId);
      if (rebuilt) {
        const saved = await apiCreateFile(rebuilt);
        if (saved) next = [...next, saved];
      }
    }

    setFiles(next);
    if (!next.find(f => f.id === activeId)) setActiveId(next[0]?.id ?? '');
  };

  const selectRegion = (r: string) => { setRegionFilter(r); setWarehouseKeys(new Set()); setPage(1); };
  const selectCompany = (c: string) => { setCompanyFilter(c); setSelectedItems([]); setItemQuery(''); setPage(1); };
  const toggleWH = (key: string) => {
    setWarehouseKeys(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    setPage(1);
  };

  const resetFilters = () => {
    selectRegion('all'); setSelectedItems([]); setItemQuery(''); setCompanyFilter('all'); setColFilters({}); setPage(1);
  };

  const doMerge = async () => {
    const selected = files.filter(f => mergeChecked.has(f.id));
    if (selected.length < 2) return;
    const merged = buildMergedFile(selected, selected.map(f => f.name));
    const saved = await apiCreateFile(merged);
    if (!saved) { alert('فشل حفظ الملف المدمج على الخادم'); return; }
    setFiles(prev => [...prev, saved]);
    setActiveId(saved.id);
    resetFilters();
    setShowMergePanel(false);
    setMergeChecked(new Set());
  };

  const doAddToMerge = async () => {
    if (!activeFile?.sourceFileIds || addChecked.size < 1) return;
    // Reconstruct original source files (those still in files list)
    const sourceFiles = files.filter(f => activeFile.sourceFileIds!.includes(f.id));
    const newFiles    = files.filter(f => addChecked.has(f.id));
    const allFiles    = [...sourceFiles, ...newFiles];
    if (allFiles.length < 2) return;
    const merged = buildMergedFile(allFiles, allFiles.map(f => f.name));
    const oldId = activeFile.id;
    const saved = await apiCreateFile(merged);
    if (!saved) { alert('فشل حفظ الملف المدمج على الخادم'); return; }
    await apiDeleteFile(oldId);
    setFiles(prev => [...prev.filter(f => f.id !== oldId), saved]);
    setActiveId(saved.id);
    resetFilters();
    setShowAddToMerge(false);
    setAddChecked(new Set());
  };

  // Rebuild existing merged file using current source files (re-applies latest normalization)
  const doRebuildMerge = async () => {
    if (!activeFile?.sourceFileIds) return;
    const sourceFiles = files.filter(f => activeFile.sourceFileIds!.includes(f.id));
    if (sourceFiles.length < 2) { alert('لا توجد ملفات مصدر كافية لإعادة البناء'); return; }
    const merged = buildMergedFile(sourceFiles, sourceFiles.map(f => f.name));
    const oldId = activeFile.id;
    const saved = await apiCreateFile(merged);
    if (!saved) { alert('فشل حفظ الملف المدمج على الخادم'); return; }
    await apiDeleteFile(oldId);
    setFiles(prev => [...prev.filter(f => f.id !== oldId), saved]);
    setActiveId(saved.id);
    resetFilters();
  };

  return (
    <div style={{ padding: '16px 14px 80px', maxWidth: 1300, margin: '0 auto', direction: 'rtl' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1e293b' }}>📊 بيانات المبيعات</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: '#94a3b8' }}>تحليل ملفات Excel مع البحث المتعدد — مناطق · مخازن · ايتمات</p>
        </div>
        <button onClick={openFilePicker} disabled={importing}
          style={{ padding: '8px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: importing ? 'default' : 'pointer', background: '#6366f1', color: '#fff', border: 'none', boxShadow: '0 2px 8px rgba(99,102,241,0.3)', opacity: importing ? 0.7 : 1 }}>
          ＋ استيراد Excel
        </button>
      </div>

      {/* Hidden file input — supports multi-file selection */}
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" multiple disabled={importing}
        onChange={e => { if (e.target.files && e.target.files.length > 0) handleFilesList(e.target.files); }}
        style={{ display: 'none' }} />

      {/* Import progress / errors */}
      {(importing || importErr) && (
        <div style={{ background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 14, padding: '12px 16px', marginBottom: 14 }}>
          {importing && importProgress && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', marginBottom: 6 }}>
                ⏳ جاري استيراد الملفات ({importProgress.current} / {importProgress.total}) — {importProgress.name}
              </div>
              <div style={{ height: 6, borderRadius: 99, background: '#e2e8f0', overflow: 'hidden' }}>
                <div style={{ width: `${(importProgress.current / importProgress.total) * 100}%`, height: '100%', background: '#6366f1', transition: 'width 0.3s' }} />
              </div>
            </div>
          )}
          {importErr && (
            <div style={{ marginTop: importing ? 10 : 0, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c', whiteSpace: 'pre-line' }}>
              ⚠️ {importErr}
            </div>
          )}
        </div>
      )}

      {/* File tabs */}
      {files.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {files.map(f => (
              <div key={f.id} style={{ display: 'flex' }}>
                <button onClick={() => { setActiveId(f.id); selectRegion('all'); setSelectedItems([]); setItemQuery(''); setCompanyFilter('all'); setPage(1); }}
                  style={{ padding: '5px 12px', borderRadius: '20px 0 0 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1.5px solid ${activeId === f.id ? '#6366f1' : '#e2e8f0'}`, borderLeft: 'none',
                    background: activeId === f.id ? '#eef2ff' : '#f8fafc', color: activeId === f.id ? '#4338ca' : '#64748b',
                    maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={`${f.name} · ${f.rows.length} صف · ${f.areaCols.length} مخزن · ${fmtDate(f.uploadedAt)}`}>
                  {f.name.startsWith('دمج:') ? '🔗' : '📄'} {f.name}
                </button>
                {f.sourceFileIds && files.filter(sf => f.sourceFileIds!.includes(sf.id)).length >= 2 && (
                  <button onClick={() => { if (activeId !== f.id) { setActiveId(f.id); } setTimeout(doRebuildMerge, 0); }}
                    title="إعادة بناء الملف المدمج بأحدث التحسينات"
                    style={{ padding: '5px 8px', fontSize: 11, cursor: 'pointer',
                      border: `1.5px solid ${activeId === f.id ? '#6366f1' : '#e2e8f0'}`, borderLeft: 'none', borderRight: 'none',
                      background: activeId === f.id ? '#eef2ff' : '#f8fafc', color: '#7c3aed' }}>🔄</button>
                )}
                <button onClick={() => deleteFile(f.id)} title="حذف"
                  style={{ padding: '5px 9px', borderRadius: '0 20px 20px 0', fontSize: 11, cursor: 'pointer',
                    border: `1.5px solid ${activeId === f.id ? '#6366f1' : '#e2e8f0'}`, borderRight: 'none',
                    background: activeId === f.id ? '#eef2ff' : '#f8fafc', color: '#ef4444' }}>×</button>
              </div>
            ))}
            {/* Merge toggle button — only when 2+ files */}
            {files.length >= 2 && (
              <button
                onClick={() => { setShowMergePanel(v => !v); setMergeChecked(new Set()); setShowAddToMerge(false); }}
                style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1.5px solid ${showMergePanel ? '#8b5cf6' : '#e2e8f0'}`,
                  background: showMergePanel ? '#ede9fe' : '#f8fafc',
                  color: showMergePanel ? '#7c3aed' : '#64748b' }}>
                🔗 دمج ملفات
              </button>
            )}
            {/* Add file to existing merge — only when active file is merged */}
            {activeFile?.sourceFileIds && (
              <button
                onClick={() => { setShowAddToMerge(v => !v); setAddChecked(new Set()); setShowMergePanel(false); }}
                style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1.5px solid ${showAddToMerge ? '#0891b2' : '#e2e8f0'}`,
                  background: showAddToMerge ? '#e0f2fe' : '#f8fafc',
                  color: showAddToMerge ? '#0e7490' : '#64748b' }}>
                ➕ إضافة ملف للدمج
              </button>
            )}
          </div>

          {/* Merge panel */}
          {showMergePanel && (
            <div style={{ marginTop: 10, background: '#faf5ff', border: '1.5px solid #ddd6fe', borderRadius: 12, padding: '12px 16px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', marginBottom: 10 }}>اختر الملفات المراد دمجها:</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {files.map(f => (
                  <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    background: mergeChecked.has(f.id) ? '#ede9fe' : '#fff',
                    border: `1.5px solid ${mergeChecked.has(f.id) ? '#8b5cf6' : '#e2e8f0'}`,
                    borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: mergeChecked.has(f.id) ? 700 : 400,
                    color: mergeChecked.has(f.id) ? '#7c3aed' : '#475569', transition: 'all 0.1s' }}>
                    <input type="checkbox" checked={mergeChecked.has(f.id)}
                      onChange={() => setMergeChecked(prev => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; })}
                      style={{ accentColor: '#8b5cf6' }} />
                    {f.name}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={doMerge} disabled={mergeChecked.size < 2}
                  style={{ padding: '6px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: mergeChecked.size < 2 ? 'not-allowed' : 'pointer',
                    background: mergeChecked.size < 2 ? '#e2e8f0' : '#7c3aed', color: mergeChecked.size < 2 ? '#94a3b8' : '#fff', border: 'none' }}>
                  🔗 دمج المحدد ({mergeChecked.size})
                </button>
                <button onClick={() => { setShowMergePanel(false); setMergeChecked(new Set()); }}
                  style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0', fontWeight: 600 }}>
                  إلغاء
                </button>
              </div>
            </div>
          )}

          {/* Add-to-merge panel */}
          {showAddToMerge && activeFile?.sourceFileIds && (() => {
            const alreadyIn = new Set(activeFile.sourceFileIds);
            const available = files.filter(f => !alreadyIn.has(f.id) && f.id !== activeFile.id);
            return (
              <div style={{ marginTop: 10, background: '#f0f9ff', border: '1.5px solid #bae6fd', borderRadius: 12, padding: '12px 16px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#0e7490', marginBottom: 6 }}>
                  ➕ إضافة ملفات إلى الدمج الحالي
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                  الملفات المدمجة حالياً: {activeFile.regions.join(' · ')}
                </div>
                {available.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>لا توجد ملفات إضافية متاحة للإضافة.</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                      {available.map(f => (
                        <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                          background: addChecked.has(f.id) ? '#e0f2fe' : '#fff',
                          border: `1.5px solid ${addChecked.has(f.id) ? '#0891b2' : '#e2e8f0'}`,
                          borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: addChecked.has(f.id) ? 700 : 400,
                          color: addChecked.has(f.id) ? '#0e7490' : '#475569', transition: 'all 0.1s' }}>
                          <input type="checkbox" checked={addChecked.has(f.id)}
                            onChange={() => setAddChecked(prev => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; })}
                            style={{ accentColor: '#0891b2' }} />
                          {f.name}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={doAddToMerge} disabled={addChecked.size < 1}
                        style={{ padding: '6px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: addChecked.size < 1 ? 'not-allowed' : 'pointer',
                          background: addChecked.size < 1 ? '#e2e8f0' : '#0891b2', color: addChecked.size < 1 ? '#94a3b8' : '#fff', border: 'none' }}>
                        ➕ إضافة المحدد ({addChecked.size})
                      </button>
                      <button onClick={() => { setShowAddToMerge(false); setAddChecked(new Set()); }}
                        style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0', fontWeight: 600 }}>
                        إلغاء
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Empty state */}
      {files.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#94a3b8', background: '#f8fafc', borderRadius: 16, border: '2px dashed #e2e8f0' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>📊</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>لا توجد بيانات بعد</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>ارفع ملف Excel يحتوي على بيانات المبيعات</div>
          <button onClick={openFilePicker} disabled={importing}
            style={{ padding: '10px 24px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: importing ? 'default' : 'pointer', background: '#6366f1', color: '#fff', border: 'none', boxShadow: '0 2px 8px rgba(99,102,241,0.3)', opacity: importing ? 0.7 : 1 }}>
            ＋ استيراد ملف Excel
          </button>
          <div style={{ marginTop: 10, fontSize: 11, color: '#94a3b8' }}>يمكنك اختيار أكثر من ملف في نفس الوقت</div>
        </div>
      )}

      {/* Main content */}
      {activeFile && !showMergePanel && (
        <>
          {/* Merge debug panel — visible only for merged files that have _mergeDebug */}
          {activeFile._mergeDebug && (
            <div style={{ background: '#fffbeb', border: '1.5px solid #fde68a', borderRadius: 12, padding: '10px 14px', marginBottom: 12, fontSize: 12 }}>
              <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 6 }}>
                🔎 تشخيص الدمج — الأعمدة المكتشفة لكل ملف:
                <span style={{ fontWeight: 400, color: '#78350f', marginRight: 6 }}>إذا ظهر "(لم يُعثر)" في عمود الشركة، يعني الملف ما فيه عمود شركة معروف → راح يستخدم اسم الملف كشركة → ايتمات مكررة!</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeFile._mergeDebug.map((d, i) => {
                  const warn = d.companyCol.includes('لم يُعثر');
                  return (
                    <div key={i} style={{ background: warn ? '#fee2e2' : '#f0fdf4', border: `1px solid ${warn ? '#fca5a5' : '#bbf7d0'}`, borderRadius: 8, padding: '6px 10px', minWidth: 160 }}>
                      <div style={{ fontWeight: 700, color: '#1e293b', marginBottom: 2 }}>📄 {d.file} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({d.rows} صف)</span></div>
                      <div style={{ color: warn ? '#dc2626' : '#16a34a' }}>🏢 شركة: <strong>{d.companyCol}</strong></div>
                      <div style={{ color: '#64748b' }}>💊 ايتم: <strong>{d.itemCol}</strong></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              { icon: '💊', label: 'إجمالي الايتمات',      value: activeFile.rows.length },
              { icon: '📍', label: 'المناطق',               value: activeFile.regions.length },
              { icon: '🏪', label: 'المذاخر',               value: activeFile.areaCols.length },
              { icon: '🔢', label: showValue ? 'مجموع القيمة المالية' : 'مجموع المبيعات المرئية', value: fmtNum(showValue ? filteredRows.reduce((s, row) => s + rowDisplay(row, displayCols), 0) : grandTotal) },
            ].map(s => (
              <div key={s.label} style={{ flex: '1 1 120px', background: '#fff', borderRadius: 12, padding: '12px 16px', border: '1.5px solid #e2e8f0', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 20 }}>{s.icon}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#6366f1', lineHeight: 1.3 }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Filter Panel */}
          <div style={{ background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>

            {/* Item search — always at top */}
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: '#f8fafc', border: `1.5px solid ${itemQuery || selectedItems.length > 0 ? '#6366f1' : '#e2e8f0'}`, borderRadius: 10, padding: '7px 12px', boxShadow: itemQuery || selectedItems.length > 0 ? '0 0 0 3px rgba(99,102,241,0.08)' : 'none' }}>
                <span style={{ fontSize: 15 }}>🔍</span>
                <input
                  value={itemQuery}
                  onChange={e => { setItemQuery(e.target.value); setSelectedItems([]); setPage(1); setShowItemPills(true); }}
                  placeholder="ابحث عن ايتم..."
                  style={{ flex: 1, fontSize: 13, border: 'none', outline: 'none', background: 'transparent', direction: 'rtl', color: '#1e293b' }}
                />
                {(itemQuery || selectedItems.length > 0) && (
                  <button onMouseDown={e => { e.preventDefault(); setItemQuery(''); setSelectedItems([]); setShortageOnlyMode(false); setPage(1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
                )}
              </div>
              {(itemQuery || selectedItems.length > 0) && (
                <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700, whiteSpace: 'nowrap' }}>✓ {filteredRows.length} ايتم</span>
              )}
            </div>

            {/* Regions */}
            <div style={{ marginBottom: regionFilter !== 'all' ? 12 : 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>📍 المناطق</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => selectRegion('all')} style={fp(regionFilter === 'all')}>الكل</button>
                {activeFile.regions.map(region => (
                  <button key={region} onClick={() => selectRegion(region)} style={fp(regionFilter === region)}>{region}</button>
                ))}
              </div>
            </div>

            {/* Warehouses — only when region selected */}
            {regionFilter !== 'all' && (() => {
              const whInRegion = activeFile.areaCols.filter(ac => ac.region === regionFilter);
              return (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>
                  🏪 المخزن <span style={{ color: '#94a3b8', fontWeight: 600 }}>({whInRegion.length})</span>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <button onClick={() => { setWarehouseKeys(new Set()); setPage(1); }} style={fp(warehouseKeys.size === 0, true)}>الكل</button>
                  {whInRegion.map(ac => (
                    <button key={ac.key} onClick={() => toggleWH(ac.key)} style={fp(warehouseKeys.has(ac.key), true)}>{ac.label}</button>
                  ))}
                </div>
              </div>
              );
            })()}

            {/* Companies */}
            {companyCol && companies.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>🏢 الشركات</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => selectCompany('all')} style={fp(companyFilter === 'all')}>الكل</button>
                  {companies.map(c => (
                    <button key={c} onClick={() => selectCompany(c)} style={fp(companyFilter === c)}>{c}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Items — collapsible, shown after company selected or when no company col */}
            {activeFile && itemNameCol && ((!companyCol || companies.length === 0) || companyFilter !== 'all') && (() => {
              let sourceRows = activeFile.rows;
              if (regionFilter !== 'all') {
                const hasTags = sourceRows.some(r => r['_regions'] || r['_sourceFile']);
                if (hasTags) sourceRows = sourceRows.filter(r => {
                  if (r['_regions'])    return r['_regions'].split(',').includes(regionFilter);
                  if (r['_sourceFile']) return r['_sourceFile'] === regionFilter;
                  return true;
                });
              }
              if (companyCol && companyFilter !== 'all')
                sourceRows = sourceRows.filter(r => String(r[companyCol] ?? '').trim() === companyFilter);
              const allItems = [...new Set(
                sourceRows.map(r => String(r[itemNameCol] ?? '').trim()).filter(Boolean)
              )].sort((a, b) => a.localeCompare(b, 'ar'));
              const q = itemQuery.trim().toLowerCase();
              const visibleItems = q ? allItems.filter(name => name.toLowerCase().includes(q)) : allItems;
              const hasActive = selectedItems.length > 0 || !!itemQuery;
              return (
                <div style={{ marginBottom: 4 }}>
                  {/* Header row with toggle arrow */}
                  <div
                    onClick={() => setShowItemPills(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', marginBottom: showItemPills ? 8 : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: hasActive ? '#6366f1' : '#64748b' }}>💊 الايتمات</div>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 18, height: 18, borderRadius: '50%',
                        background: showItemPills ? '#ede9fe' : '#f1f5f9',
                        border: `1.5px solid ${showItemPills ? '#8b5cf6' : '#cbd5e1'}`,
                        color: showItemPills ? '#7c3aed' : '#64748b',
                        fontSize: 9, fontWeight: 900,
                        transform: showItemPills ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s, background 0.15s'
                      }}>▼</span>
                    </div>
                    {hasActive && (
                      <span style={{ fontSize: 10, color: '#10b981', fontWeight: 700 }}>
                        {selectedItems.length > 0 ? `(${selectedItems.length} محدد)` : '(بحث نشط)'}
                      </span>
                    )}
                    {selectedItems.length > 1 && (
                      <button
                        onClick={e => { e.stopPropagation(); setSelectedItems([]); setPage(1); }}
                        style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 10px', cursor: 'pointer', marginRight: 'auto' }}
                      >مسح الكل</button>
                    )}
                  </div>

                  {/* Expanded: pills only */}
                  {showItemPills && (
                    <>
                      {/* pills */}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button onClick={() => { setSelectedItems([]); setItemQuery(''); setPage(1); }} style={fp(selectedItems.length === 0 && !itemQuery)}>الكل</button>
                        {visibleItems.map(name => (
                          <button key={name}
                            onClick={() => { setSelectedItems(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]); setItemQuery(''); setPage(1); }}
                            style={fp(selectedItems.includes(name))}
                          >{name}</button>
                        ))}
                        {q && visibleItems.length === 0 && (
                          <span style={{ fontSize: 12, color: '#94a3b8' }}>لا نتائج لـ "{itemQuery}"</span>
                        )}
                      </div>
                      {selectedItems.length > 0 && (
                        <div style={{ fontSize: 11, color: '#10b981', marginTop: 6, fontWeight: 600 }}>✓ {filteredRows.length} صف مطابق ({selectedItems.length} ايتم)</div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Tab switcher + value toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            {([['table', '📋 الجدول'], ['analysis', '📈 التحليل']] as [string, string][]).map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id as 'table' | 'analysis')} style={fp(tab === id)}>{lbl}</button>
            ))}
            <button
              onClick={() => { setTab('table'); setShowValue(v => !v); }}
              title={showValue ? 'إخفاء القيمة المالية والعودة للكميات' : 'عرض القيمة المالية (الكمية × السعر)'}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: `1.5px solid ${showValue ? '#f59e0b' : '#e2e8f0'}`,
                background: showValue ? '#fffbeb' : '#f8fafc',
                color: showValue ? '#b45309' : '#64748b',
                boxShadow: showValue ? '0 2px 8px rgba(245,158,11,0.25)' : 'none',
                transition: 'all 0.15s',
              }}>💰 قيمة مالية{showValue ? ' ✓' : ''}</button>
            {/* Shortage Radar button */}
            <button
              onClick={() => setShowShortages(true)}
              title={`رادار النقص · الحد الحالي ${shortageThreshold} قطعة`}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: '1.5px solid #e2e8f0',
                background: '#f8fafc',
                color: '#64748b',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              النقص
              {shortages.totalCount > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 20, padding: '0 6px', height: 18,
                  borderRadius: 10, fontSize: 10, fontWeight: 700,
                  background: '#dc2626', color: '#fff',
                }}>{shortages.totalCount}</span>
              )}
            </button>
            {/* Warehouse Classification button */}
            <button
              onClick={() => setShowClassifyModal(true)}
              title="تصنيف المذاخر (A/B/C)"
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: '1.5px solid #e2e8f0',
                background: '#f8fafc',
                color: '#64748b',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              🏷️ تصنيف المذاخر
              {warehouseClasses.length > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 20, padding: '0 6px', height: 18,
                  borderRadius: 10, fontSize: 10, fontWeight: 700,
                  background: '#6366f1', color: '#fff',
                }}>{warehouseClasses.length}</span>
              )}
            </button>
            {/* Export styled table */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setExportMenuOpen(o => !o)}
                title="تصدير الجدول"
                style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: '1.5px solid #e2e8f0',
                  background: exportMenuOpen ? '#eef2ff' : '#f8fafc',
                  color: exportMenuOpen ? '#4338ca' : '#64748b',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >⬇ تصدير {exportMenuOpen ? '▲' : '▼'}</button>
              {exportMenuOpen && (
                <>
                  <div onClick={() => setExportMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                    minWidth: 160, background: '#fff', border: '1.5px solid #e2e8f0',
                    borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
                    zIndex: 60, overflow: 'hidden',
                  }}>
                    {[
                      { label: '📊 Excel', onClick: exportTableToExcel },
                      { label: '📝 Word',  onClick: exportTableToWord  },
                      { label: '�️ صورة (نسخ)', onClick: exportTableToPDF   },
                    ].map(item => (
                      <button key={item.label}
                        onClick={() => { setExportMenuOpen(false); item.onClick(); }}
                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '8px 14px', background: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#475569' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                      >{item.label}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {/* TABLE VIEW */}
          {tab === 'table' && (
            <>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{filteredRows.length} ايتم{regionFilter !== 'all' && ` · ${regionFilter}`}{warehouseKeys.size > 0 && ` · ${warehouseKeys.size} مخزن`} · {displayCols.length} عمود</span>
                {shortageOnlyMode && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '2px 8px', color: '#dc2626', fontWeight: 700, fontSize: 11 }}>
                    🔴 عرض النقص فقط
                    <button onClick={() => setShortageOnlyMode(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 13, padding: 0, lineHeight: 1, fontWeight: 700 }}>✕</button>
                  </span>
                )}
              </div>

              <div ref={tableContainerRef} style={{ overflow: 'auto', height: 'calc(100vh - 60px)', borderRadius: 12, border: '1.5px solid #e2e8f0', background: '#fff', marginBottom: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 3 }}>
                      <th style={thS}>#</th>
                      {activeFile.fixedCols.map((c, i) => {
                        if (shortageOnlyMode && c === priceCol) return null;
                        const isFilterable = c !== priceCol;
                        const activeVals = colFilters[c] ?? [];
                        const hasFilter = activeVals.length > 0;
                        const visibleVals = colUniqueVals.filter(v => !filterSearch || v.toLowerCase().includes(filterSearch.toLowerCase()));
                        const allSelected = activeVals.length === 0;
                        return (
                          <th key={i} style={{ ...thS, position: 'relative' }} data-col-filter={isFilterable ? c : undefined}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'center' }}>
                              <span>{c}</span>
                              {isFilterable && (
                                <button
                                  onClick={e => { e.stopPropagation(); setOpenFilterCol(openFilterCol === c ? null : c); setFilterSearch(''); }}
                                  title="فلتر"
                                  style={{ background: hasFilter ? '#eef2ff' : 'none', border: hasFilter ? '1px solid #a5b4fc' : 'none', borderRadius: 4, cursor: 'pointer', padding: '1px 4px', color: hasFilter ? '#4338ca' : '#94a3b8', fontSize: 11, lineHeight: 1 }}
                                >
                                  {hasFilter ? `▼ ${activeVals.length}` : '▽'}
                                </button>
                              )}
                            </div>
                            {/* Filter Dropdown */}
                            {isFilterable && openFilterCol === c && (
                              <div data-col-filter={c} style={{ position: 'absolute', top: '100%', right: 0, zIndex: 200, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: 230, display: 'flex', flexDirection: 'column', direction: 'rtl', overflow: 'hidden' }}>
                                {/* Search */}
                                <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
                                  <input
                                    autoFocus
                                    value={filterSearch}
                                    onChange={e => setFilterSearch(e.target.value)}
                                    placeholder="بحث في القيم..."
                                    onClick={e => e.stopPropagation()}
                                    style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
                                  />
                                </div>
                                {/* Select all / clear */}
                                <div style={{ padding: '5px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 10, alignItems: 'center' }}>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', fontWeight: allSelected ? 700 : 400, color: allSelected ? '#4338ca' : '#475569' }}>
                                    <input type="checkbox" checked={allSelected} onChange={() => setColFilters(prev => { const n = { ...prev }; delete n[c]; return n; })} />
                                    الكل
                                  </label>
                                  {hasFilter && (
                                    <button onClick={() => setColFilters(prev => { const n = { ...prev }; delete n[c]; return n; })} style={{ fontSize: 11, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 'auto' }}>
                                      مسح الفلتر ✕
                                    </button>
                                  )}
                                </div>
                                {/* Values list */}
                                <div style={{ overflowY: 'auto', maxHeight: 220 }}>
                                  {visibleVals.length === 0
                                    ? <div style={{ padding: '12px 14px', color: '#94a3b8', fontSize: 12 }}>لا توجد نتائج</div>
                                    : visibleVals.map(val => {
                                      const checked = activeVals.includes(val);
                                      return (
                                        <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', cursor: 'pointer', background: checked ? '#eef2ff' : undefined, fontSize: 12 }}>
                                          <input type="checkbox" checked={checked} onChange={() => {
                                            setColFilters(prev => {
                                              const cur = prev[c] ?? [];
                                              const next = cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val];
                                              const n = { ...prev };
                                              if (next.length === 0) delete n[c]; else n[c] = next;
                                              return n;
                                            });
                                          }} />
                                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val}</span>
                                        </label>
                                      );
                                    })
                                  }
                                </div>
                                {/* Close */}
                                <div style={{ padding: '6px 10px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'flex-end' }}>
                                  <button onClick={() => setOpenFilterCol(null)} style={{ padding: '4px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>تطبيق</button>
                                </div>
                              </div>
                            )}
                          </th>
                        );
                      })}
                      {displayCols.map(col => {
                        const cat = !isRT(col) ? getCategory((col as ColMeta).region, (col as ColMeta).label) : null;
                        const dim = focusCategoryA && !isRT(col) && cat !== 'A';
                        const focusA = focusCategoryA && cat === 'A';
                        return (
                        <th key={col.key} style={{ ...thA, background: focusA ? '#f1f5f9' : (isRT(col) ? '#eef2ff' : '#f8fafc'), color: dim ? '#cbd5e1' : (isRT(col) ? '#4338ca' : '#1e293b'), borderRight: focusA ? '1.5px solid #cbd5e1' : (isRT(col) ? '2px solid #c7d2fe' : undefined), borderLeft: focusA ? '1.5px solid #cbd5e1' : (isRT(col) ? '2px solid #c7d2fe' : undefined), opacity: dim ? 0.4 : 1 }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                            <span>{col.label}</span>
                            {!isRT(col) && cat && (() => {
                              const colors = { A: { bg: '#f1f5f9', fg: '#334155', br: '#cbd5e1' }, B: { bg: '#f1f5f9', fg: '#64748b', br: '#cbd5e1' }, C: { bg: '#f1f5f9', fg: '#94a3b8', br: '#cbd5e1' } }[cat];
                              return (
                                <span title={cat === 'A' ? 'مفتوح — يمكن التجهيز' : cat === 'B' ? 'يحتاج موافقة وترتيب التجاري' : 'لا يجهز حالياً'}
                                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, fontSize: 9, fontWeight: 700, background: colors.bg, color: colors.fg, border: `1px solid ${colors.br}` }}>
                                  {cat}
                                </span>
                              );
                            })()}
                          </div>
                        </th>
                        );
                      })}
                      <th data-export="omit" style={{ ...thA, background: '#f0fdf4', color: '#065f46', minWidth: 80, position: 'sticky', left: 0, zIndex: 2, borderRight: '2px solid #bbf7d0' }}>المجموع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0
                      ? <tr><td colSpan={activeFile.fixedCols.length + displayCols.length + 2} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>لا توجد نتائج</td></tr>
                      : pageRows.map((row, idx) => {
                        const rt = rowDisplay(row, displayCols);
                        return (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                            onMouseLeave={e => (e.currentTarget.style.background = '')}>
                            <td style={{ ...tdS, color: '#94a3b8', fontSize: 11 }}>{idx + 1}</td>
                            {activeFile.fixedCols.map((c, ci) => {
                              if (shortageOnlyMode && c === priceCol) return null;
                              const val = row[c] ?? '';
                              const hi = itemQuery && val.toLowerCase().includes(itemQuery.toLowerCase());
                              const display = c === priceCol ? (toNum(val) > 0 ? fmtNum(toNum(val)) : (val || '—')) : val;
                              return (
                                <td key={ci} style={{ ...tdS, ...(ci === 1 ? { minWidth: 180, maxWidth: 280, fontWeight: 600 } : {}), ...(ci === 2 ? { color: '#1e293b' } : {}) }}>
                                  {hi ? <span style={{ background: '#fef9c3', borderRadius: 3, padding: '1px 4px' }}>{display}</span> : (display || <span style={{ color: '#d1d5db' }}>—</span>)}
                                </td>
                              );
                            })}
                            {displayCols.map(col => {
                              const v = cellDisplay(row, col);
                              const T = shortageThreshold ?? 0;
                              const isAbove = shortageOnlyMode && !isRT(col) && v > 0 && (T === 0 || v >= T);
                              const isLow = highlightLow && !isRT(col) && (v === 0 || (T > 0 && v < T));
                              const showZero = shortageOnlyMode && !isRT(col) && v === 0;
                              const cat = !isRT(col) ? getCategory((col as ColMeta).region, (col as ColMeta).label) : null;
                              const dim = focusCategoryA && !isRT(col) && cat !== 'A';
                              const focusA = focusCategoryA && cat === 'A';
                              const aGap  = focusA && v === 0;                  // empty A cell
                              const aLow  = focusA && v > 0 && T > 0 && v < T;  // low (non-zero) in A
                              // Base color logic kept simple: red only for A-gaps; everything else neutral.
                              const color = aGap
                                ? '#dc2626'
                                : (isAbove ? '#d1d5db'
                                : (showZero ? '#dc2626'
                                : (v > 0 ? (showValue ? '#92400e' : '#1e293b')
                                : '#cbd5e1')));
                              return (
                                <td key={col.key} style={{
                                  ...tdA,
                                  background: aGap || aLow ? '#fef2f2' : (focusA ? '#f8fafc' : undefined),
                                  color,
                                  fontWeight: aGap || aLow || v > 0 || showZero ? 700 : 400,
                                  borderRight: focusA ? '1.5px solid #cbd5e1' : (isRT(col) ? '2px solid #e2e8f0' : undefined),
                                  borderLeft:  focusA ? '1.5px solid #cbd5e1' : (isRT(col) ? '2px solid #e2e8f0' : undefined),
                                  opacity: dim ? 0.3 : 1,
                                }}>
                                  {isAbove ? '✓' : (showZero ? '0' : fmtNum(v))}
                                </td>
                              );
                            })}
                            <td data-export="omit" style={{ ...tdA, color: rt > 0 ? '#065f46' : '#e2e8f0', fontWeight: 800, position: 'sticky', left: 0, background: '#f0fdf4', borderRight: '2px solid #bbf7d0', zIndex: 1 }}>{rt > 0 ? fmtNum(rt) : '—'}</td>
                          </tr>
                        );
                      })
                    }
                  </tbody>
                  <tfoot data-export="omit">
                    <tr style={{ background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>
                      <td style={{ ...tdS, color: '#475569', fontSize: 11, fontWeight: 700, position: 'sticky', bottom: 0, background: '#f1f5f9' }} colSpan={activeFile.fixedCols.length + 1}>
                        المجموع ({filteredRows.length} ايتم)
                      </td>
                      {displayCols.map(col => (
                        <td key={col.key} style={{ ...tdA, color: '#1e293b', fontWeight: 800, position: 'sticky', bottom: 0, background: '#f1f5f9' }}>{fmtNum(filteredRows.reduce((s, row) => s + cellDisplay(row, col), 0))}</td>
                      ))}
                      <td style={{ ...tdA, color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, left: 0, background: '#e7fdf0', borderRight: '2px solid #bbf7d0' }}>{fmtNum(filteredRows.reduce((s, row) => s + rowDisplay(row, displayCols), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>


            </>
          )}

          {/* ANALYSIS VIEW */}
          {tab === 'analysis' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Top items */}
              <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #e2e8f0', padding: '16px 18px' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 14 }}>
                  🏆 أعلى الايتمات مبيعاً
                  {regionFilter !== 'all' && <span style={{ fontSize: 11, color: '#6366f1', marginRight: 8, fontWeight: 400 }}>— {regionFilter}</span>}
                  {(selectedItems.length > 0 || itemQuery) && <span style={{ fontSize: 11, color: '#10b981', marginRight: 8, fontWeight: 400 }}>({filteredRows.length} نتيجة)</span>}
                </div>
                {topItems.length === 0
                  ? <div style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد بيانات</div>
                  : (() => {
                    const mx = topItems[0]?.total ?? 1;
                    return topItems.map(({ row, total }, idx) => {
                      const name = row[itemNameCol] ?? '';
                      const pct  = Math.round(total / mx * 100);
                      const bar  = idx === 0 ? '#6366f1' : idx < 3 ? '#8b5cf6' : '#a5b4fc';
                      return (
                        <div key={idx} style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ width: 22, height: 22, background: bar, color: '#fff', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{name}</span>
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 800, color: bar }}>{fmtNum(total)}</span>
                          </div>
                          <div style={{ height: 6, borderRadius: 99, background: '#f1f5f9', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: bar, borderRadius: 99, transition: 'width 0.4s' }} />
                          </div>
                        </div>
                      );
                    });
                  })()
                }
              </div>

              {/* Regional comparison */}
              {regionFilter === 'all' && activeFile.regions.length > 0 && (
                <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #e2e8f0', padding: '16px 18px' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 14 }}>🗺️ مبيعات المناطق</div>
                  {(() => {
                    const regionTotals = activeFile.regions.map(region => {
                      const cols = activeFile.areaCols.filter(ac => ac.region === region);
                      const total = filteredRows.reduce((s, row) => s + cols.reduce((ss, ac) => ss + toNum(row[ac.key] ?? ''), 0), 0);
                      return { region, total, wCount: cols.length };
                    }).sort((a, b) => b.total - a.total);
                    const mx    = regionTotals[0]?.total ?? 1;
                    const gtAll = regionTotals.reduce((s, r) => s + r.total, 0);
                    return regionTotals.map(({ region, total, wCount }) => {
                      const pct   = Math.round(total / mx * 100);
                      const share = gtAll > 0 ? Math.round(total / gtAll * 100) : 0;
                      return (
                        <div key={region} style={{ marginBottom: 14 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>📍</span>
                              <button onClick={() => { selectRegion(region); setTab('table'); }}
                                style={{ fontSize: 13, fontWeight: 700, color: '#4338ca', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline dotted' }}>
                                {region}
                              </button>
                              <span style={{ fontSize: 11, color: '#94a3b8' }}>{wCount} مخزن</span>
                              <span style={{ fontSize: 11, color: '#64748b', background: '#f1f5f9', borderRadius: 10, padding: '1px 7px' }}>{share}%</span>
                            </div>
                            <span style={{ fontSize: 14, fontWeight: 800, color: '#6366f1' }}>{fmtNum(total)}</span>
                          </div>
                          <div style={{ height: 8, borderRadius: 99, background: '#f1f5f9', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: '#6366f1', borderRadius: 99, transition: 'width 0.4s' }} />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}

              {/* Item coverage diagnostic — only for merged files */}
              {activeFile.sourceFileIds && activeFile.rows.some(r => r['_regions']) && (() => {
                const totalR = activeFile.regions.length;
                const orphaned = activeFile.rows
                  .filter(r => (r['_regions']?.split(',').length ?? 0) === 1)
                  .sort((a, b) => (a['المادة'] ?? '').localeCompare(b['المادة'] ?? '', 'ar'));
                const partial  = activeFile.rows.filter(r => { const n = r['_regions']?.split(',').length ?? 0; return n > 1 && n < totalR; });
                const full     = activeFile.rows.filter(r => (r['_regions']?.split(',').length ?? 0) >= totalR);
                return (
                  <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #fde68a', padding: '16px 18px' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#92400e', marginBottom: 10 }}>
                      🔍 تغطية الايتمات
                      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400, marginRight: 8 }}>— يكشف الايتمات التي قد تكون مكررة بأسماء مختلفة</span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                      <div style={{ background: '#dcfce7', borderRadius: 10, padding: '8px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: '#16a34a' }}>{full.length}</div>
                        <div style={{ fontSize: 11, color: '#166534' }}>✅ في كل المناطق ({totalR}/{totalR})</div>
                      </div>
                      <div style={{ background: '#fef9c3', borderRadius: 10, padding: '8px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: '#ca8a04' }}>{partial.length}</div>
                        <div style={{ fontSize: 11, color: '#713f12' }}>⚠️ في بعض المناطق</div>
                      </div>
                      <div style={{ background: '#fee2e2', borderRadius: 10, padding: '8px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626' }}>{orphaned.length}</div>
                        <div style={{ fontSize: 11, color: '#7f1d1d' }}>❌ منطقة واحدة فقط</div>
                      </div>
                    </div>
                    {orphaned.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#7f1d1d', marginBottom: 8 }}>
                          ❌ ايتمات ظهرت في منطقة واحدة فقط — غالباً مكررة بأسم مختلف في الملفات الأخرى:
                        </div>
                        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #fecaca', borderRadius: 8 }}>
                          {orphaned.map((row, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '5px 10px', borderBottom: i < orphaned.length - 1 ? '1px solid #fff1f2' : 'none',
                              background: i % 2 === 0 ? '#fffbfb' : '#fff', fontSize: 12 }}>
                              <span style={{ color: '#1e293b', fontWeight: 600 }}>
                                {row['المادة']}
                                <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 11 }}> ({row['الشركة']})</span>
                              </span>
                              <span style={{ color: '#dc2626', fontSize: 11, background: '#fee2e2', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                                📍 {row['_regions']}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Item detail breakdown (when 1-5 items match search) */}
              {(selectedItems.length > 0 || itemQuery) && filteredRows.length > 0 && filteredRows.length <= 5 && (
                <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #e2e8f0', padding: '16px 18px' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 14 }}>
                    🔎 تفاصيل بالمناطق
                  </div>
                  {filteredRows.map((row, ri) => {
                    const name = row[itemNameCol] ?? '';
                    const breakdown = activeFile.regions.map(region => {
                      const cols  = activeFile.areaCols.filter(ac => ac.region === region);
                      const total = cols.reduce((s, ac) => s + toNum(row[ac.key] ?? ''), 0);
                      return { region, total, cols };
                    }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
                    if (breakdown.length === 0) return null;
                    const itemGrand = breakdown.reduce((s, x) => s + x.total, 0);
                    return (
                      <div key={ri} style={{ marginBottom: ri < filteredRows.length - 1 ? 24 : 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#4338ca', marginBottom: 12 }}>
                          💊 {name} <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 12 }}>— إجمالي: {fmtNum(itemGrand)}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: regionFilter !== 'all' ? 12 : 0 }}>
                          {breakdown.map(({ region, total }) => (
                            <div key={region}
                              style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '10px 16px', minWidth: 110, textAlign: 'center', cursor: 'pointer' }}
                              onClick={() => { selectRegion(region); setTab('table'); }}>
                              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>📍 {region}</div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: '#4338ca' }}>{fmtNum(total)}</div>
                              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{itemGrand > 0 ? Math.round(total / itemGrand * 100) : 0}%</div>
                            </div>
                          ))}
                        </div>
                        {regionFilter !== 'all' && (
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>تفاصيل مخازن {regionFilter}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {activeFile.areaCols
                                .filter(ac => ac.region === regionFilter && toNum(row[ac.key] ?? '') > 0)
                                .sort((a, b) => toNum(row[b.key] ?? '') - toNum(row[a.key] ?? ''))
                                .map(ac => (
                                  <div key={ac.key} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: 11, color: '#64748b' }}>{ac.label}</div>
                                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{fmtNum(toNum(row[ac.key] ?? ''))}</div>
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* 🏷️ WAREHOUSE CLASSIFICATION — A/B/C catalog                            */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {showClassifyModal && (
        <div
          onClick={() => setShowClassifyModal(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, width: 'min(820px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1.5px solid #e2e8f0', boxShadow: '0 10px 30px rgba(15,23,42,0.12)' }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1.5px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#1e293b' }}>🏷️ تصنيف المذاخر</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                  A = مفتوح · B = يحتاج موافقة · C = لا يجهز حالياً
                </div>
              </div>
              <button onClick={() => setShowClassifyModal(false)} style={{ width: 30, height: 30, borderRadius: 8, border: '1.5px solid #e2e8f0', background: '#fff', color: '#64748b', fontSize: 14, cursor: 'pointer', fontWeight: 700 }}>✕</button>
            </div>

            <div style={{ padding: '14px 18px', borderBottom: '1px solid #e2e8f0', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input ref={classifyFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleClassifyUpload(f); if (classifyFileRef.current) classifyFileRef.current.value = ''; }} />
              <button onClick={() => classifyFileRef.current?.click()}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #6366f1', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                📥 رفع ملف Excel
              </button>
              <button onClick={downloadClassifyTemplate}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0', background: '#fff', color: '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                ⬇ تحميل نموذج
              </button>
              <button
                onClick={() => setFocusCategoryA(v => !v)}
                title="إبراز مذاخر التصنيف A وتوضيح فجواتها وتعتيم باقي المذاخر"
                style={{
                  padding: '6px 14px', borderRadius: 8,
                  border: `1.5px solid ${focusCategoryA ? '#16a34a' : '#bbf7d0'}`,
                  background: focusCategoryA ? '#16a34a' : '#f0fdf4',
                  color: focusCategoryA ? '#fff' : '#166534',
                  fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}>
                🎯 تركيز على A {focusCategoryA ? '✓' : ''}
              </button>
              {warehouseClasses.length > 0 && (
                <button onClick={() => { if (confirm('مسح كل التصنيفات؟')) { setWarehouseClasses([]); setClassifyUploadMsg(''); } }}
                  style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #fecaca', background: '#fff', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginInlineStart: 'auto' }}>
                  🗑 مسح الكل
                </button>
              )}
            </div>

            {classifyUploadMsg && (
              <div style={{ padding: '8px 18px', fontSize: 12, color: classifyUploadMsg.startsWith('✓') ? '#166534' : '#9a3412', background: classifyUploadMsg.startsWith('✓') ? '#f0fdf4' : '#fff7ed', borderBottom: '1px solid #e2e8f0' }}>
                {classifyUploadMsg}
              </div>
            )}

            <div style={{ padding: '12px 18px', borderBottom: '1px solid #e2e8f0', fontSize: 11, color: '#64748b' }}>
              الأعمدة المطلوبة في الملف: <strong>المنطقة</strong> · <strong>المخزن</strong> · <strong>التصنيف</strong> (A أو B أو C).
              المطابقة تتم بحسب الاسم بعد تجاهل الفراغات وحالة الأحرف.
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
              {!activeFile ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '40px 0' }}>
                  لا يوجد ملف ستوك نشط لعرض المذاخر.
                </div>
              ) : (() => {
                const setCat = (region: string, warehouse: string, cat: WarehouseCategory | null) => {
                  setWarehouseClasses(prev => {
                    const filtered = prev.filter(c => !(normName(c.warehouse) === normName(warehouse) && (!c.region || normName(c.region) === normName(region))));
                    return cat ? [...filtered, { region, warehouse, category: cat }] : filtered;
                  });
                };
                // Group active warehouses by region
                const byRegion: Record<string, { region: string; warehouse: string }[]> = {};
                for (const w of activeWarehousesAll) (byRegion[w.region] ||= []).push(w);
                // Match counters
                const matchedKeys = new Set<string>();
                let matchedCount = 0;
                for (const c of warehouseClasses) {
                  const hit = activeWarehousesAll.find(w => normName(w.warehouse) === normName(c.warehouse) && (!c.region || normName(w.region) === normName(c.region)));
                  if (hit) { matchedKeys.add(`${normName(hit.region)}||${normName(hit.warehouse)}`); matchedCount++; }
                }
                const unmatchedClasses = warehouseClasses.filter(c => {
                  const hit = activeWarehousesAll.find(w => normName(w.warehouse) === normName(c.warehouse) && (!c.region || normName(w.region) === normName(c.region)));
                  return !hit;
                });
                const unclassifiedCount = activeWarehousesAll.filter(w => !matchedKeys.has(`${normName(w.region)}||${normName(w.warehouse)}`)).length;

                const catColors: Record<WarehouseCategory | '', { bg: string; fg: string; br: string }> = {
                  A: { bg: '#f0fdf4', fg: '#166534', br: '#86efac' },
                  B: { bg: '#fefce8', fg: '#854d0e', br: '#fde047' },
                  C: { bg: '#fef2f2', fg: '#991b1b', br: '#fca5a5' },
                  '': { bg: '#f8fafc', fg: '#94a3b8', br: '#e2e8f0' },
                };
                const renderSelect = (region: string, warehouse: string) => {
                  const cur = getCategory(region, warehouse) ?? '';
                  const c = catColors[cur as WarehouseCategory | ''];
                  return (
                    <select
                      value={cur}
                      onChange={e => setCat(region, warehouse, (e.target.value || null) as WarehouseCategory | null)}
                      style={{ background: c.bg, color: c.fg, fontWeight: 700, border: `1px solid ${c.br}`, borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', minWidth: 70 }}
                    >
                      <option value="">— غير مصنّف</option>
                      <option value="A">A — مفتوح</option>
                      <option value="B">B — يحتاج موافقة</option>
                      <option value="C">C — لا يجهز</option>
                    </select>
                  );
                };

                return (
                  <>
                    {/* Match summary */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 14, fontSize: 12, flexWrap: 'wrap' }}>
                      <span style={{ background: '#f0fdf4', color: '#166534', padding: '4px 10px', borderRadius: 8, fontWeight: 700, border: '1px solid #bbf7d0' }}>✓ مصنّف: {matchedCount}</span>
                      {unclassifiedCount > 0 && <span style={{ background: '#f8fafc', color: '#475569', padding: '4px 10px', borderRadius: 8, fontWeight: 700, border: '1px solid #e2e8f0' }}>غير مصنّف: {unclassifiedCount}</span>}
                      {unmatchedClasses.length > 0 && <span style={{ background: '#fff7ed', color: '#9a3412', padding: '4px 10px', borderRadius: 8, fontWeight: 700, border: '1px solid #fed7aa' }}>⚠ خارج الستوك: {unmatchedClasses.length}</span>}
                    </div>

                    {/* Regions & warehouses */}
                    {Object.entries(byRegion).map(([region, list]) => (
                      <div key={region} style={{ marginBottom: 16, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                        <div style={{ background: '#f8fafc', padding: '8px 12px', fontSize: 13, fontWeight: 800, color: '#1e293b', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <span>📍 {region} <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400, marginInlineStart: 6 }}>({list.length} مخزن)</span></span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {(['A', 'B', 'C'] as WarehouseCategory[]).map(cat => (
                              <button key={cat} title={`تطبيق ${cat} على كل مذاخر ${region}`}
                                onClick={() => list.forEach(w => setCat(w.region, w.warehouse, cat))}
                                style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: `1px solid ${catColors[cat].br}`, background: catColors[cat].bg, color: catColors[cat].fg, fontWeight: 700, cursor: 'pointer' }}>
                                {cat}
                              </button>
                            ))}
                            <button title={`مسح تصنيفات ${region}`}
                              onClick={() => list.forEach(w => setCat(w.region, w.warehouse, null))}
                              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', fontWeight: 700, cursor: 'pointer' }}>
                              مسح
                            </button>
                          </div>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                          <tbody>
                            {list.map(w => (
                              <tr key={`${w.region}__${w.warehouse}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '8px 12px', fontWeight: 600, color: '#1e293b' }}>{w.warehouse}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'left', width: 200 }}>{renderSelect(w.region, w.warehouse)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}

                    {/* Extra entries from uploaded file (not in active stock) */}
                    {unmatchedClasses.length > 0 && (
                      <div style={{ marginBottom: 16, border: '1px dashed #fed7aa', borderRadius: 10, overflow: 'hidden' }}>
                        <div style={{ background: '#fff7ed', padding: '8px 12px', fontSize: 13, fontWeight: 800, color: '#9a3412', borderBottom: '1px solid #fed7aa' }}>
                          ⚠ تصنيفات خارج ملف الستوك الحالي ({unmatchedClasses.length})
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                          <tbody>
                            {unmatchedClasses.map((c, i) => (
                              <tr key={`${c.region}-${c.warehouse}-${i}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '8px 12px', color: '#475569', width: 140 }}>{c.region || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                                <td style={{ padding: '8px 12px', fontWeight: 600, color: '#1e293b' }}>{c.warehouse}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'left', width: 200 }}>{renderSelect(c.region, c.warehouse)}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'center', width: 50 }}>
                                  <button onClick={() => setWarehouseClasses(prev => prev.filter(x => !(normName(x.warehouse) === normName(c.warehouse) && normName(x.region) === normName(c.region))))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 14 }} title="حذف">🗑</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* 📡 SHORTAGE RADAR — Low-stock dashboard                                 */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {showShortages && activeFile && (
        <div
          onClick={() => setShowShortages(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14,
            animation: 'sdFadeIn 0.15s ease-out',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 14, width: 'min(860px, 100%)', maxHeight: '90vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              border: '1.5px solid #e2e8f0',
              boxShadow: '0 10px 30px rgba(15,23,42,0.12)',
            }}
          >
            {/* Header */}
            <div style={{
              padding: '14px 18px', borderBottom: '1.5px solid #e2e8f0', background: '#f8fafc',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#1e293b' }}>📡 رادار النقص</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                  {shortages.totalCount === 0
                    ? 'لا توجد نواقص حالياً'
                    : `تم رصد ${fmtNum(shortages.totalCount)} ايتم يحتاج انتباه`}
                </div>
              </div>
              <button onClick={() => setShowShortages(false)} style={{
                width: 30, height: 30, borderRadius: 8, border: '1.5px solid #e2e8f0',
                background: '#fff', color: '#64748b', fontSize: 14, cursor: 'pointer', fontWeight: 700,
              }}>✕</button>
            </div>

            {/* Threshold controls */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>الحد الأدنى للتذكير:</span>
                <input
                  type="number" min={0} step={1}
                  value={shortageThreshold}
                  onChange={e => setShortageThreshold(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{
                    width: 80, padding: '5px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0',
                    fontSize: 13, fontWeight: 700, color: '#1e293b', textAlign: 'center', outline: 'none',
                    background: '#f8fafc',
                  }}
                />
                <span style={{ fontSize: 12, color: '#64748b' }}>قطعة</span>
                <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {[0, 10, 30, 50, 100].map(v => (
                    <button key={v} onClick={() => setShortageThreshold(v)} style={fp(shortageThreshold === v, true)}>
                      {v === 0 ? 'صفر فقط' : `<${v}`}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: '#94a3b8' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#64748b' }}>
                  <input type="checkbox" checked={highlightLow} onChange={e => setHighlightLow(e.target.checked)} />
                  تلوين الخلايا المنخفضة في الجدول
                </label>
              </div>
            </div>

            {/* Summary row + actions */}
            <div style={{ padding: '12px 18px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid #e2e8f0' }}>
              {([
                ['نفد', shortages.out.length, '#dc2626'],
                ['حرج', shortages.critical.length, '#d97706'],
                ['منخفض', shortages.low.length, '#65a30d'],
              ] as [string, number, string][]).map(([lbl, n, c]) => (
                <div key={lbl} style={{
                  flex: '1 1 100px', minWidth: 90, padding: '8px 12px', borderRadius: 10,
                  background: '#f8fafc', border: '1.5px solid #e2e8f0',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: c, display: 'inline-block' }} />
                    {lbl}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: '#1e293b' }}>{fmtNum(n)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    const lines: string[] = [];
                    const sev2label: Record<string, string> = { out: 'نفد', critical: 'حرج', low: 'منخفض' };
                    [...shortages.out, ...shortages.critical, ...shortages.low].forEach(e => {
                      const regs = e.lowRegions.map(r => `${r.region}=${r.qty}`).join(' · ');
                      lines.push(`[${sev2label[e.severity]}] ${e.name}${e.company ? ` (${e.company})` : ''} · إجمالي ${fmtNum(e.total)}${regs ? ` · ${regs}` : ''}`);
                    });
                    navigator.clipboard.writeText(lines.join('\n'))
                      .then(() => alert('تم نسخ القائمة'))
                      .catch(() => alert('تعذّر النسخ'));
                  }}
                  disabled={shortages.totalCount === 0}
                  style={{ ...fp(false, true), cursor: shortages.totalCount === 0 ? 'default' : 'pointer', opacity: shortages.totalCount === 0 ? 0.5 : 1 }}
                >نسخ القائمة</button>
                <button
                  onClick={() => {
                    if (shortages.totalCount === 0) return;
                    const sev2label: Record<string, string> = { out: 'نفد', critical: 'حرج', low: 'منخفض' };
                    const all = [...shortages.out, ...shortages.critical, ...shortages.low];

                    // Sheet 1: Summary — one column per region + one column for its warehouses
                    const allRegions = [...new Set(
                      (regionFilter === 'all'
                        ? activeFile!.areaCols
                        : activeFile!.areaCols.filter(ac => ac.region === regionFilter)
                      ).map(ac => ac.region)
                    )];
                    const summaryRows = all.map(e => {
                      const row: Record<string, any> = {
                        'الحالة': sev2label[e.severity],
                        'الايتم': e.name || '(بدون اسم)',
                        'الشركة': e.company || '',
                      };
                      allRegions.forEach(region => {
                        const rd = e.lowRegions.find(r => r.region === region);
                        const whs = e.lowWarehouses.filter(w => w.region === region);
                        row[region] = rd ? (rd.qty === 0 ? 'نفد' : rd.qty) : '';
                        row[`مذاخر ${region}`] = whs.length > 0
                          ? whs.map(w => `${w.warehouse}${w.qty === 0 ? ' (نفد)' : `=${w.qty}`}`).join(', ')
                          : (rd ? '(إجمالي المنطقة)' : '');
                      });
                      return row;
                    });

                    // Sheet 2: Detail (one row per warehouse shortage — for pivoting)
                    const detailRows: any[] = [];
                    all.forEach(e => {
                      if (e.lowWarehouses.length === 0) {
                        // Fall back to region-level rows if no warehouse detail
                        e.lowRegions.forEach(r => {
                          detailRows.push({
                            'الحالة': sev2label[e.severity],
                            'الايتم': e.name || '(بدون اسم)',
                            'الشركة': e.company || '',
                            'المنطقة': r.region,
                            'المخزن': '(إجمالي المنطقة)',
                            'الكمية': r.qty,
                            'شدة النقص': sev2label[r.sev],
                          });
                        });
                      } else {
                        e.lowWarehouses.forEach(w => {
                          detailRows.push({
                            'الحالة': sev2label[e.severity],
                            'الايتم': e.name || '(بدون اسم)',
                            'الشركة': e.company || '',
                            'المنطقة': w.region,
                            'المخزن': w.warehouse,
                            'الكمية': w.qty,
                            'شدة النقص': sev2label[w.sev],
                          });
                        });
                      }
                    });

                    const wb = XLSX.utils.book_new();
                    const ws1 = XLSX.utils.json_to_sheet(summaryRows);
                    const ws2 = XLSX.utils.json_to_sheet(detailRows);
                    // Column widths — 3 fixed cols + 2 cols per region
                    const ws1Cols = [{ wch: 10 }, { wch: 32 }, { wch: 18 }];
                    allRegions.forEach(() => { ws1Cols.push({ wch: 12 }, { wch: 45 }); });
                    ws1['!cols'] = ws1Cols;
                    ws2['!cols'] = [{ wch: 10 }, { wch: 32 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 10 }, { wch: 12 }];
                    // RTL
                    (ws1 as any)['!views'] = [{ RTL: true }];
                    (ws2 as any)['!views'] = [{ RTL: true }];
                    XLSX.utils.book_append_sheet(wb, ws1, 'ملخص النقص');
                    XLSX.utils.book_append_sheet(wb, ws2, 'تفصيل حسب المخزن');
                    const fname = `shortages_${activeFile?.name.replace(/\.[^.]+$/, '') || 'report'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
                    XLSX.writeFile(wb, fname);
                  }}
                  disabled={shortages.totalCount === 0}
                  style={{
                    ...fp(shortages.totalCount > 0, true),
                    cursor: shortages.totalCount === 0 ? 'default' : 'pointer',
                    opacity: shortages.totalCount === 0 ? 0.5 : 1,
                    background: shortages.totalCount > 0 ? '#10b981' : undefined,
                    color: shortages.totalCount > 0 ? '#fff' : undefined,
                    borderColor: shortages.totalCount > 0 ? '#10b981' : undefined,
                  }}
                  title="تصدير النقص إلى ملف إكسل بورقتين: ملخص وتفصيل لكل مخزن"
                >⬇ تصدير Excel</button>
                <button
                  onClick={() => {
                    if (shortages.totalCount === 0) return;
                    const names = [...shortages.out, ...shortages.critical, ...shortages.low].map(e => e.name).filter(Boolean);
                    setSelectedItems([...new Set(names)]);
                    setItemQuery('');
                    setShowItemPills(true);
                    setShowShortages(false);
                    setTab('table');
                    setShortageOnlyMode(true);
                  }}
                  disabled={shortages.totalCount === 0}
                  style={{ ...fp(shortages.totalCount > 0, true), cursor: shortages.totalCount === 0 ? 'default' : 'pointer', opacity: shortages.totalCount === 0 ? 0.5 : 1 }}
                >عرضها في الجدول</button>
              </div>
            </div>

            {/* View toggle */}
            <div style={{ padding: '10px 18px 0', display: 'flex', gap: 6 }}>
              {([
                ['by-region',    'حسب المنطقة'],
                ['by-warehouse', 'حسب المخزن'],
                ['by-company',   'حسب الشركة'],
                ['by-item',      'حسب الايتم'],
              ] as [typeof shortageView, string][]).map(([id, lbl]) => (
                <button key={id} onClick={() => setShortageView(id)} style={fp(shortageView === id, true)}>{lbl}</button>
              ))}
            </div>

            {/* List body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px 18px' }}>
              {shortages.totalCount === 0 ? (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: '#94a3b8' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#64748b' }}>لا توجد نواقص</div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>كل الايتمات فوق الحد المحدد ({shortageThreshold} قطعة)</div>
                </div>
              ) : shortageView === 'by-item' ? (
                <>
                  {([
                    ['out',      'نفد تماماً',   '#dc2626'],
                    ['critical', 'حالة حرجة',   '#d97706'],
                    ['low',      'مستوى منخفض', '#65a30d'],
                  ] as ['out' | 'critical' | 'low', string, string][]).map(([key, title, c]) => {
                    const list = shortages[key];
                    if (list.length === 0) return null;
                    return (
                      <div key={key} style={{ marginBottom: 14 }}>
                        <div style={{
                          padding: '6px 10px', fontSize: 12, fontWeight: 700, marginBottom: 8,
                          color: '#1e293b', borderInlineStart: `3px solid ${c}`, background: '#f8fafc',
                          borderRadius: 6,
                        }}>{title} · {list.length}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {list.map((e, i) => {
                            // Group warehouses by region for this item
                            const whByRegion: Record<string, typeof e.lowWarehouses> = {};
                            e.lowWarehouses.forEach(w => { (whByRegion[w.region] ||= []).push(w); });
                            // Regions list: union of lowRegions + regions that have lowWarehouses
                            const regionOrder: string[] = [];
                            e.lowRegions.forEach(r => { if (!regionOrder.includes(r.region)) regionOrder.push(r.region); });
                            Object.keys(whByRegion).forEach(r => { if (!regionOrder.includes(r)) regionOrder.push(r); });
                            const regionQty = (r: string) => e.lowRegions.find(x => x.region === r);

                            return (
                              <div key={i} style={{
                                padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0',
                                background: '#fff', display: 'flex', flexDirection: 'column', gap: 8,
                                borderInlineStart: `3px solid ${c}`,
                              }}>
                                {/* Header row: name + company + total */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
                                      {e.name || <span style={{ color: '#94a3b8' }}>(بدون اسم)</span>}
                                    </div>
                                    {e.company && (
                                      <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 500 }}>الشركة:</span>
                                        {e.company}
                                      </div>
                                    )}
                                  </div>
                                  <div style={{
                                    padding: '4px 12px', borderRadius: 6, border: `1.5px solid ${c}`, color: c,
                                    fontSize: 12, fontWeight: 800, minWidth: 60, textAlign: 'center', background: '#fff',
                                  }}>الإجمالي: {fmtNum(e.total)}</div>
                                </div>

                                {/* Regions + warehouses breakdown */}
                                {regionOrder.length > 0 && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 6, borderTop: '1px dashed #e2e8f0' }}>
                                    {regionOrder.map(reg => {
                                      const rq = regionQty(reg);
                                      const rc = rq ? (rq.sev === 'out' ? '#dc2626' : rq.sev === 'critical' ? '#d97706' : '#65a30d') : '#94a3b8';
                                      const whs = whByRegion[reg] || [];
                                      return (
                                        <div key={reg} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                                          <span style={{
                                            padding: '2px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                                            background: '#f1f5f9', color: '#1e293b',
                                            display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 110,
                                          }}>
                                            <span style={{ width: 7, height: 7, borderRadius: 99, background: rc }} />
                                            {reg}
                                            {rq && <span style={{ color: rc, fontWeight: 800, marginInlineStart: 4 }}>
                                              {rq.qty === 0 ? 'نفد' : fmtNum(rq.qty)}
                                            </span>}
                                          </span>
                                          {whs.length > 0 ? (
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                                              {whs.map((w, k) => {
                                                const wc = w.sev === 'out' ? '#dc2626' : w.sev === 'critical' ? '#d97706' : '#65a30d';
                                                return (
                                                  <span key={k} style={{
                                                    padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                                                    background: '#fff', border: `1px solid ${wc}40`, color: '#334155',
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                  }}>
                                                    <span style={{ width: 5, height: 5, borderRadius: 99, background: wc }} />
                                                    {w.warehouse}:
                                                    <span style={{ color: wc, fontWeight: 800 }}>{w.qty === 0 ? '—' : fmtNum(w.qty)}</span>
                                                  </span>
                                                );
                                              })}
                                            </div>
                                          ) : (
                                            <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>المجموع منخفض (كل مخزن ضمن الحد)</span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                // Group-based views: by-region / by-warehouse / by-company
                <>
                  {(() => {
                    const allEntries = [...shortages.out, ...shortages.critical, ...shortages.low];
                    type Item = { entry: typeof allEntries[0]; qty: number; sev: string; subLabel?: string };
                    const groups: Record<string, Item[]> = {};

                    if (shortageView === 'by-region') {
                      allEntries.forEach(e => {
                        e.lowRegions.forEach(r => {
                          (groups[r.region] ||= []).push({ entry: e, qty: r.qty, sev: r.sev });
                        });
                      });
                    } else if (shortageView === 'by-warehouse') {
                      allEntries.forEach(e => {
                        e.lowWarehouses.forEach(w => {
                          const key = `${w.warehouse}  ·  ${w.region}`;
                          (groups[key] ||= []).push({ entry: e, qty: w.qty, sev: w.sev, subLabel: w.region });
                        });
                      });
                    } else if (shortageView === 'by-company') {
                      allEntries.forEach(e => {
                        const key = e.company || '(بدون شركة)';
                        (groups[key] ||= []).push({ entry: e, qty: e.total, sev: e.severity });
                      });
                    }

                    const emptyMsg =
                      shortageView === 'by-warehouse' ? 'لا توجد نواقص على مستوى أي مخزن'
                      : shortageView === 'by-company' ? 'لا توجد شركات بها نواقص'
                      : 'لا توجد نواقص على مستوى أي منطقة — الإجماليات منخفضة فقط';

                    const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
                    if (keys.length === 0) return (
                      <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8', fontSize: 12 }}>
                        {emptyMsg}
                      </div>
                    );

                    const unit =
                      shortageView === 'by-warehouse' ? 'ايتم'
                      : shortageView === 'by-company' ? 'ايتم'
                      : 'ايتم';

                    return keys.map(key => {
                      const list = groups[key];
                      // For warehouse key format "warehouse · region", split display
                      const parts = shortageView === 'by-warehouse' ? key.split('  ·  ') : null;
                      return (
                        <div key={key} style={{ marginBottom: 14 }}>
                          <div style={{
                            padding: '7px 12px', borderRadius: 8, background: '#f8fafc',
                            color: '#1e293b', fontSize: 13, fontWeight: 700, marginBottom: 6,
                            display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e2e8f0',
                          }}>
                            {parts ? (
                              <>
                                <span>{parts[0]}</span>
                                {parts[1] && <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600, background: '#eef2ff', padding: '1px 7px', borderRadius: 10 }}>{parts[1]}</span>}
                              </>
                            ) : key}
                            <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>({list.length} {unit})</span>
                            <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
                              {(['out', 'critical', 'low'] as const).map(s => {
                                const n = list.filter(x => x.sev === s).length;
                                if (n === 0) return null;
                                const c = s === 'out' ? '#dc2626' : s === 'critical' ? '#d97706' : '#65a30d';
                                const lbl = s === 'out' ? 'نفد' : s === 'critical' ? 'حرج' : 'منخفض';
                                return <span key={s} style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, fontWeight: 600, color: '#64748b',
                                }}>
                                  <span style={{ width: 7, height: 7, borderRadius: 99, background: c }} />
                                  {lbl} {n}
                                </span>;
                              })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {list.sort((a, b) => a.qty - b.qty).map((x, i) => {
                              const c = x.sev === 'out' ? '#dc2626' : x.sev === 'critical' ? '#d97706' : '#65a30d';
                              return (
                                <div key={i} style={{
                                  padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0',
                                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
                                  borderInlineStart: `3px solid ${c}`, background: '#fff',
                                }}>
                                  <span style={{ flex: 1, fontWeight: 600, color: '#1e293b' }}>
                                    {x.entry.name || '(بدون اسم)'}
                                    {shortageView !== 'by-company' && x.entry.company && (
                                      <span style={{ color: '#94a3b8', fontSize: 10, marginInlineStart: 6, fontWeight: 500 }}>· {x.entry.company}</span>
                                    )}
                                  </span>
                                  <span style={{ color: c, fontWeight: 700 }}>
                                    {x.qty === 0 ? 'نفد' : fmtNum(x.qty)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </>
              )}
            </div>
          </div>

          <style>{`
            @keyframes sdFadeIn { from { opacity: 0 } to { opacity: 1 } }
          `}</style>
        </div>
      )}
    </div>
  );
}

// Style helpers
function fp(active: boolean, small = false): React.CSSProperties {
  return { padding: small ? '3px 11px' : '5px 14px', borderRadius: 20, fontSize: small ? 11 : 12, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${active ? '#6366f1' : '#e2e8f0'}`, background: active ? '#eef2ff' : '#f8fafc', color: active ? '#4338ca' : '#64748b' };
}
const thS: React.CSSProperties = { padding: '10px 14px', fontWeight: 700, color: '#1e293b', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap', background: '#f8fafc' };
const thA: React.CSSProperties = { padding: '10px 10px', fontWeight: 700, fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap', minWidth: 70 };
const tdS: React.CSSProperties = { padding: '9px 14px', color: '#1e293b', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' };
const tdA: React.CSSProperties = { padding: '8px 8px', fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' };
function pgBtn(disabled: boolean): React.CSSProperties {
  return { padding: '5px 10px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer', border: '1.5px solid #e2e8f0', background: '#f8fafc', color: disabled ? '#d1d5db' : '#374151' };
}
