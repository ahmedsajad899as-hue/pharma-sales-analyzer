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
}

type RegionTotalCol = { key: string; label: string; region: string; colIdx: -1; isRegionTotal: true; cols: ColMeta[] };
type ViewCol = ColMeta | RegionTotalCol;
function isRT(col: ViewCol): col is RegionTotalCol { return 'isRegionTotal' in col; }

// ── Persistence ────────────────────────────────────────────────────────────────
const STORE_KEY_PREFIX = 'sales_data_v3';
function storeKey(userId: number | null | undefined) {
  return userId ? `${STORE_KEY_PREFIX}_${userId}` : STORE_KEY_PREFIX;
}
function loadFiles(userId: number | null | undefined): SalesFile[] {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    if (!raw) return [];
    return (JSON.parse(raw) as any[]).filter(f => 'fixedCols' in f) as SalesFile[];
  } catch { return []; }
}
function saveFiles(files: SalesFile[], userId: number | null | undefined) {
  try { localStorage.setItem(storeKey(userId), JSON.stringify(files)); } catch {}
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

    const labelCount: Record<string, number> = {};
    const areaCols: ColMeta[] = [];
    for (let ci = areaStart; ci < wRow.length; ci++) {
      const wv = String(wRow[ci] ?? '').trim();
      const reg = regionByCol[ci] || defaultRegion;
      if (!reg) continue; // no region header → not a warehouse/quantity col
      if (!wv && !reg) continue;
      if (isTotalLabel(wv) || isTotalLabel(reg)) continue; // skip total columns
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
const IGNORE_WH_PAT = /^مذخر\s*\d+$|^مخزن\s*\d+$|^warehouse\s*\d+$/i;

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

// ── Component ──────────────────────────────────────────────────────────────────
export default function SalesDataPage() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [files, setFiles]           = useState<SalesFile[]>(() => loadFiles(userId));
  const [activeId, setActiveId]     = useState<string>(() => loadFiles(userId)[0]?.id ?? '');
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting]   = useState(false);
  const [importErr, setImportErr]   = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [itemQuery, setItemQuery]         = useState('');
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const itemSearchRef = useRef<HTMLDivElement>(null);
  const [companyFilter, setCompanyFilter] = useState('all');
  const [regionFilter, setRegionFilter]   = useState('all');
  const [warehouseKeys, setWarehouseKeys] = useState<Set<string>>(new Set());
  const [page, setPage]           = useState(1);
  const [tab, setTab]             = useState<'table' | 'analysis'>('table');
  const [showValue, setShowValue] = useState(false);
  const [colFilters, setColFilters]       = useState<Record<string, string[]>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [filterSearch, setFilterSearch]   = useState('');

  // Back button: close open overlays/panels
  useBackHandler([
    [showImport,              () => { setShowImport(false); setImportErr(''); }],
    [showItemDropdown,        () => setShowItemDropdown(false)],
    [openFilterCol !== null,  () => setOpenFilterCol(null)],
  ]);
  const PAGE_SIZE = 50;

  const activeFile = files.find(f => f.id === activeId);

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
    const keywords = ['company', 'comp', 'شركة', 'الشركة', 'vendor', 'supplier', 'brand', 'manufacture', 'principal'];
    const lower = activeFile.fixedCols.map(c => c.toLowerCase());
    return activeFile.fixedCols.find((_, i) => keywords.some(k => lower[i].includes(k))) ?? '';
  }, [activeFile]);

  // Unique company values for pills
  const companies = useMemo(() => {
    if (!activeFile || !companyCol) return [];
    return [...new Set(activeFile.rows.map(r => String(r[companyCol] ?? '').trim()).filter(Boolean))].sort();
  }, [activeFile, companyCol]);

  // Filtered rows by item selection / text query + company filter + column filters
  const filteredRows = useMemo(() => {
    if (!activeFile) return [];
    let rows = activeFile.rows;
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
  }, [activeFile, selectedItems, itemQuery, companyFilter, companyCol, colFilters]);

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
    const lower = activeFile.fixedCols.map(c => c.toLowerCase());
    return (
      activeFile.fixedCols.find((_, i) => ['item', 'الايتم', 'اسم', 'نام', 'name', 'product'].some(k => lower[i].includes(k))) ??
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

  // Close item-search dropdown on outside click
  useEffect(() => {
    if (!showItemDropdown) return;
    const handler = (e: MouseEvent) => {
      if (!itemSearchRef.current?.contains(e.target as Node)) setShowItemDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showItemDropdown]);

  const totalPages = 1;
  const pageRows = showValue
    ? [...filteredRows].sort((a, b) => rowDisplay(b, displayCols) - rowDisplay(a, displayCols))
    : filteredRows;

  // Handlers
  const handleFile = useCallback((file: File) => {
    setImportErr('');
    setImporting(true);
    const reader = new FileReader();
    reader.onload = e => {
      const buf = e.target!.result as ArrayBuffer;
      // Try multi-sheet stock format first, fall back to existing parser
      const multiResult = parseMultiSheetStock(buf, file.name);
      const result = multiResult === 'NO' ? parseExcel(buf, file.name) : multiResult;
      if (typeof result === 'string') {
        setImportErr(result);
        setImporting(false);
      } else {
        setFiles(prev => { const next = [...prev, result as SalesFile]; saveFiles(next, userId); return next; });
        setActiveId((result as SalesFile).id);
        setSelectedItems([]); setItemQuery(''); setCompanyFilter('all'); setRegionFilter('all'); setWarehouseKeys(new Set()); setColFilters({}); setPage(1);
        setShowImport(false);
        setImporting(false);
      }
      if (fileRef.current) fileRef.current.value = '';
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const deleteFile = (id: string) => {
    if (!confirm('حذف هذا الملف؟')) return;
    setFiles(prev => {
      const next = prev.filter(f => f.id !== id);
      saveFiles(next, userId);
      if (activeId === id) setActiveId(next[0]?.id ?? '');
      return next;
    });
  };

  const selectRegion = (r: string) => { setRegionFilter(r); setWarehouseKeys(new Set()); setPage(1); };
  const selectCompany = (c: string) => { setCompanyFilter(c); setPage(1); };
  const toggleWH = (key: string) => {
    setWarehouseKeys(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    setPage(1);
  };

  return (
    <div style={{ padding: '16px 14px 80px', maxWidth: 1300, margin: '0 auto', direction: 'rtl' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1e293b' }}>📊 بيانات المبيعات</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: '#94a3b8' }}>تحليل ملفات Excel مع البحث المتعدد — مناطق · مخازن · ايتمات</p>
        </div>
        <button onClick={() => { setShowImport(v => !v); setImportErr(''); }}
          style={{ padding: '8px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: '#6366f1', color: '#fff', border: 'none', boxShadow: '0 2px 8px rgba(99,102,241,0.3)' }}>
          ＋ استيراد Excel
        </button>
      </div>

      {/* Import Panel */}
      {showImport && (
        <div style={{ background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 14, padding: '16px 18px', marginBottom: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>📁 رفع ملف Excel / CSV</div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px', lineHeight: 1.7 }}>
            يدعم نوعين من الملفات:<br/>
            <strong>١- ملف مذاخر متعدد الشيتات:</strong> كل شيت = شركة، الصف الثاني = اسم المادة + أسماء المذاخر (يتم تجاهل مذخر7 مذخر8 ... تلقائياً).<br/>
            <strong>٢- الصيغة العادية:</strong> صف واحد أو صفين (منطقة مدمجة + أسماء مذاخر).
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" disabled={importing}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              style={{ fontSize: 13 }} />
            {importing && <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 600 }}>⏳ جاري الاستيراد...</span>}
          </div>
          {importErr && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
              ⚠️ {importErr}
            </div>
          )}
        </div>
      )}

      {/* File tabs */}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {files.map(f => (
            <div key={f.id} style={{ display: 'flex' }}>
              <button onClick={() => { setActiveId(f.id); selectRegion('all'); setSelectedItems([]); setItemQuery(''); setCompanyFilter('all'); setPage(1); }}
                style={{ padding: '5px 12px', borderRadius: '20px 0 0 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${activeId === f.id ? '#6366f1' : '#e2e8f0'}`, borderLeft: 'none',
                  background: activeId === f.id ? '#eef2ff' : '#f8fafc', color: activeId === f.id ? '#4338ca' : '#64748b',
                  maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${f.name} · ${f.rows.length} صف · ${f.areaCols.length} مخزن · ${fmtDate(f.uploadedAt)}`}>
                📄 {f.name}
              </button>
              <button onClick={() => deleteFile(f.id)} title="حذف"
                style={{ padding: '5px 9px', borderRadius: '0 20px 20px 0', fontSize: 11, cursor: 'pointer',
                  border: `1.5px solid ${activeId === f.id ? '#6366f1' : '#e2e8f0'}`, borderRight: 'none',
                  background: activeId === f.id ? '#eef2ff' : '#f8fafc', color: '#ef4444' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {files.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#94a3b8', background: '#f8fafc', borderRadius: 16, border: '2px dashed #e2e8f0' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>📊</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>لا توجد بيانات بعد</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>ارفع ملف Excel يحتوي على بيانات المبيعات</div>
          <button onClick={() => setShowImport(true)}
            style={{ padding: '10px 24px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: '#6366f1', color: '#fff', border: 'none', boxShadow: '0 2px 8px rgba(99,102,241,0.3)' }}>
            ＋ استيراد ملف Excel
          </button>
        </div>
      )}

      {/* Main content */}
      {activeFile && (
        <>
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
            {/* Item search — inline dropdown */}
            <div style={{ marginBottom: 14, position: 'relative' }} ref={itemSearchRef}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>🔍 البحث بالايتم</div>
              {/* Input bar */}
              <div style={{
                maxWidth: 420, border: `1.5px solid ${showItemDropdown || selectedItems.length > 0 ? '#6366f1' : '#e2e8f0'}`,
                borderRadius: 9, background: selectedItems.length > 0 ? '#f5f3ff' : '#f8fafc',
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
                boxShadow: showItemDropdown ? '0 0 0 3px rgba(99,102,241,0.1)' : selectedItems.length > 0 ? '0 0 0 3px rgba(99,102,241,0.08)' : 'none',
              }}>
                <span>🔍</span>
                <input
                  value={itemQuery}
                  onChange={e => { setItemQuery(e.target.value); setShowItemDropdown(true); setPage(1); }}
                  onFocus={() => setShowItemDropdown(true)}
                  onKeyDown={e => { if (e.key === 'Escape') setShowItemDropdown(false); }}
                  placeholder={selectedItems.length > 0 ? `${selectedItems.length} ايتم مختار — اكتب للإضافة` : 'اكتب للبحث...'}
                  style={{ flex: 1, fontSize: 13, border: 'none', outline: 'none', background: 'transparent', direction: 'rtl', color: '#1e293b' }}
                />
                {(selectedItems.length > 0 || itemQuery) && (
                  <button
                    onMouseDown={e => { e.preventDefault(); setSelectedItems([]); setItemQuery(''); setShowItemDropdown(false); setPage(1); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 15, padding: 0, lineHeight: 1 }}
                  >×</button>
                )}
              </div>

              {/* Selected tags */}
              {selectedItems.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {selectedItems.map(name => (
                    <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#ede9fe', color: '#7c3aed', borderRadius: 20, padding: '3px 10px 3px 8px', fontSize: 12, fontWeight: 600 }}>
                      💊 {name}
                      <button
                        onClick={() => { setSelectedItems(prev => prev.filter(n => n !== name)); setPage(1); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 0 0 2px', fontSize: 14, lineHeight: 1, opacity: 0.7 }}
                      >×</button>
                    </span>
                  ))}
                  {selectedItems.length > 1 && (
                    <button
                      onClick={() => { setSelectedItems([]); setPage(1); }}
                      style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 10px', cursor: 'pointer' }}
                    >مسح الكل</button>
                  )}
                </div>
              )}

              {/* Inline dropdown */}
              {showItemDropdown && activeFile && (() => {
                const q = itemQuery.trim().toLowerCase();
                const suggestions = [...new Map(
                  activeFile.rows
                    .filter(row => {
                      if (!q) return true;
                      const itemName = String(row[itemNameCol] ?? '').toLowerCase();
                      const company  = companyCol ? String(row[companyCol] ?? '').toLowerCase() : '';
                      return itemName.includes(q) || company.includes(q);
                    })
                    .map(row => {
                      const name    = String(row[itemNameCol] ?? '').trim();
                      const company = companyCol ? String(row[companyCol] ?? '').trim() : '';
                      return [`${name}||${company}`, { name, company }];
                    })
                ).values()]
                  .filter(it => it.name && !selectedItems.includes(it.name))
                  .slice(0, 50);

                if (suggestions.length === 0 && !q) return null;

                return (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', right: 0, left: 0, maxWidth: 420,
                    zIndex: 500, background: '#fff', borderRadius: 12, border: '1.5px solid #e2e8f0',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.15)', overflow: 'hidden', direction: 'rtl',
                    maxHeight: 320, overflowY: 'auto',
                  }}>
                    {suggestions.length === 0 && q && (
                      <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>لا توجد نتائج</div>
                    )}
                    {suggestions.map(it => (
                      <div
                        key={it.name + '||' + it.company}
                        style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #f8fafc', fontSize: 13 }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        {/* Left: + icon — add + keep dropdown open */}
                        <div
                          title="اضغط لإضافة والإبقاء على القائمة مفتوحة"
                          onMouseDown={e => {
                            e.preventDefault();
                            if (!selectedItems.includes(it.name)) setSelectedItems(prev => [...prev, it.name]);
                            setItemQuery('');
                            setPage(1);
                          }}
                          style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, borderLeft: '2px solid #bfdbfe', cursor: 'pointer' }}
                        >
                          <span style={{ fontSize: 16 }}>💊</span>
                          <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 700 }}>+</span>
                        </div>
                        {/* Right: item name + company tag — add + close */}
                        <div
                          onMouseDown={() => {
                            if (!selectedItems.includes(it.name)) setSelectedItems(prev => [...prev, it.name]);
                            setItemQuery('');
                            setShowItemDropdown(false);
                            setPage(1);
                          }}
                          style={{ flex: 1, padding: '8px 14px 8px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, cursor: 'pointer' }}
                        >
                          <span style={{ color: '#4338ca', fontWeight: 600, fontSize: 13 }}>{it.name}</span>
                          {it.company && (
                            <span style={{ fontSize: 11, color: '#7c3aed', background: '#ede9fe', borderRadius: 6, padding: '1px 6px', alignSelf: 'flex-start', whiteSpace: 'nowrap' }}>
                              🏢 {it.company}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {(selectedItems.length > 0 || itemQuery) && (
                <div style={{ fontSize: 11, color: '#10b981', marginTop: selectedItems.length > 0 ? 6 : 4, fontWeight: 600 }}>✓ {filteredRows.length} ايتم مطابق</div>
              )}
            </div>

            {/* Company pills (shown only when a company column is detected) */}
            {companyCol && companies.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>🏢 الشركة</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => selectCompany('all')} style={fp(companyFilter === 'all')}>الكل</button>
                  {companies.map(c => (
                    <button key={c} onClick={() => selectCompany(c)} style={fp(companyFilter === c)}>{c}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Region pills */}
            <div style={{ marginBottom: regionFilter !== 'all' ? 12 : 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>📍 المذاخر</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => selectRegion('all')} style={fp(regionFilter === 'all')}>الكل</button>
                {activeFile.regions.map(region => (
                  <button key={region} onClick={() => selectRegion(region)} style={fp(regionFilter === region)}>{region}</button>
                ))}
              </div>
            </div>

            {/* Warehouse pills (only when region selected) */}
            {regionFilter !== 'all' && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>🏪 المخزن</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <button onClick={() => { setWarehouseKeys(new Set()); setPage(1); }} style={fp(warehouseKeys.size === 0, true)}>الكل</button>
                  {activeFile.areaCols.filter(ac => ac.region === regionFilter).map(ac => (
                    <button key={ac.key} onClick={() => toggleWH(ac.key)} style={fp(warehouseKeys.has(ac.key), true)}>{ac.label}</button>
                  ))}
                </div>
              </div>
            )}
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
          </div>
          {/* TABLE VIEW */}
          {tab === 'table' && (
            <>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
                {filteredRows.length} ايتم{regionFilter !== 'all' && ` · ${regionFilter}`}{warehouseKeys.size > 0 && ` · ${warehouseKeys.size} مخزن`} · {displayCols.length} عمود
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 12, border: '1.5px solid #e2e8f0', background: '#fff', marginBottom: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, direction: 'rtl' }}>
                  <thead>
                    {regionFilter === 'all' && (
                      <tr style={{ background: '#f1f5f9', borderBottom: '1px solid #e2e8f0' }}>
                        <td colSpan={activeFile.fixedCols.length + 1} style={{ padding: '6px 14px', color: '#94a3b8', fontSize: 10, fontWeight: 600 }}>الايتم</td>
                        {activeFile.regions.map(r => (
                          <td key={r} style={{ padding: '6px 12px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: '#4338ca', background: '#eef2ff', borderRight: '2px solid #c7d2fe', borderLeft: '2px solid #c7d2fe', whiteSpace: 'nowrap' }}>
                            📍 {r}
                          </td>
                        ))}
                        <td style={{ padding: '6px 10px', textAlign: 'center', background: '#f0fdf4', fontSize: 10, color: '#065f46', fontWeight: 600 }}>الإجمالي</td>
                      </tr>
                    )}
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                      <th style={thS}>#</th>
                      {activeFile.fixedCols.map((c, i) => {
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
                      {displayCols.map(col => (
                        <th key={col.key} style={{ ...thA, background: isRT(col) ? '#eef2ff' : '#f8fafc', color: isRT(col) ? '#4338ca' : '#1e293b', borderRight: isRT(col) ? '2px solid #c7d2fe' : undefined, borderLeft: isRT(col) ? '2px solid #c7d2fe' : undefined }}>
                          {col.label}
                        </th>
                      ))}
                      <th style={{ ...thA, background: '#f0fdf4', color: '#065f46', minWidth: 80 }}>الإجمالي</th>
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
                              const val = row[c] ?? '';
                              const hi = itemQuery && val.toLowerCase().includes(itemQuery.toLowerCase());
                              const display = c === priceCol ? (toNum(val) > 0 ? fmtNum(toNum(val)) : (val || '—')) : val;
                              return (
                                <td key={ci} style={{ ...tdS, ...(ci === 1 ? { minWidth: 180, maxWidth: 280, fontWeight: 600 } : {}), ...(ci === 2 ? { color: '#6366f1' } : {}) }}>
                                  {hi ? <span style={{ background: '#fef9c3', borderRadius: 3, padding: '1px 4px' }}>{display}</span> : (display || <span style={{ color: '#d1d5db' }}>—</span>)}
                                </td>
                              );
                            })}
                            {displayCols.map(col => {
                              const v = cellDisplay(row, col);
                              return (
                                <td key={col.key} style={{ ...tdA, background: isRT(col) && v > 0 ? (showValue ? '#fffbeb' : '#f0fdf4') : undefined, color: v > 0 ? (showValue ? '#92400e' : '#1e293b') : '#e2e8f0', fontWeight: v > 0 ? 700 : 400, borderRight: isRT(col) ? '2px solid #e2e8f0' : undefined, borderLeft: isRT(col) ? '2px solid #e2e8f0' : undefined }}>
                                  {fmtNum(v)}
                                </td>
                              );
                            })}
                            <td style={{ ...tdA, background: rt > 0 ? (showValue ? '#fffbeb' : '#f0fdf4') : undefined, color: rt > 0 ? (showValue ? '#92400e' : '#065f46') : '#e2e8f0', fontWeight: 700 }}>{fmtNum(rt)}</td>
                          </tr>
                        );
                      })
                    }
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                      <td style={{ ...tdS, color: '#64748b', fontSize: 11 }} colSpan={activeFile.fixedCols.length + 1}>
                        المجموع ({filteredRows.length} ايتم)
                      </td>
                      {displayCols.map(col => (
                        <td key={col.key} style={{ ...tdA, color: '#1e293b', fontWeight: 800 }}>{fmtNum(filteredRows.reduce((s, row) => s + cellDisplay(row, col), 0))}</td>
                      ))}
                      <td style={{ ...tdA, color: '#065f46', fontWeight: 800 }}>{fmtNum(filteredRows.reduce((s, row) => s + rowDisplay(row, displayCols), 0))}</td>
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
