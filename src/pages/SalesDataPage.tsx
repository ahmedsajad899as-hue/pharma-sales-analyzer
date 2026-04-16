import { useState, useRef, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';

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
const STORE_KEY = 'sales_data_v3';
function loadFiles(): SalesFile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as any[]).filter(f => 'fixedCols' in f) as SalesFile[];
  } catch { return []; }
}
function saveFiles(files: SalesFile[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(files)); } catch {}
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

    // Assign region names using Excel merge metadata so a region never bleeds
    // into columns that have no region header above them.
    // IMPORTANT: sheet cells use absolute Excel coordinates (from !ref origin),
    // while rRowIdx/ci are relative raw-array indices — must add the sheet offset.
    const regionByCol: string[] = new Array(wRow.length).fill('');
    if (rRowIdx >= 0) {
      const sheetRange = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
      const rowOffset = sheetRange.s.r; // absolute Excel row of raw[0]
      const colOffset = sheetRange.s.c; // absolute Excel col of raw[][0]
      const absRegRow = rowOffset + rRowIdx;
      const merges = ((sheet as any)['!merges'] ?? []) as { s: { r: number; c: number }; e: { r: number; c: number } }[];

      // Collect all region cells and their names
      const regionEntries: { absCol: number; name: string }[] = [];
      for (let ci = 0; ci < wRow.length; ci++) {
        const absCol = colOffset + ci;
        const cell = sheet[XLSX.utils.encode_cell({ r: absRegRow, c: absCol })];
        const rv = cell ? String(cell.v ?? '').trim() : '';
        if (rv) regionEntries.push({ absCol, name: rv });
      }

      // For each region cell, determine its exact column span
      for (let ei = 0; ei < regionEntries.length; ei++) {
        const { absCol, name } = regionEntries[ei];
        const merge = merges.find(m => m.s.r === absRegRow && m.s.c === absCol);
        let spanEnd: number;
        if (merge) {
          // Use the exact merge span — never bleeds beyond it
          spanEnd = merge.e.c;
        } else {
          // No merge cell: span only until just before the next region cell.
          // For the last region entry, it only covers its own column.
          spanEnd = regionEntries[ei + 1] !== undefined ? regionEntries[ei + 1].absCol - 1 : absCol;
        }
        for (let absC = absCol; absC <= spanEnd; absC++) {
          const relC = absC - colOffset;
          if (relC >= 0 && relC < wRow.length) regionByCol[relC] = name;
        }
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
    const labelCount: Record<string, number> = {};
    const areaCols: ColMeta[] = [];
    for (let ci = areaStart; ci < wRow.length; ci++) {
      const wv = String(wRow[ci] ?? '').trim();
      const reg = regionByCol[ci] || '';
      if (!reg) continue; // no region header → not a warehouse/quantity col
      if (!wv && !reg) continue;
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

// ── Component ──────────────────────────────────────────────────────────────────
export default function SalesDataPage() {
  const [files, setFiles]           = useState<SalesFile[]>(loadFiles);
  const [activeId, setActiveId]     = useState<string>(() => loadFiles()[0]?.id ?? '');
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting]   = useState(false);
  const [importErr, setImportErr]   = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [itemSearch, setItemSearch]       = useState('');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [regionFilter, setRegionFilter]   = useState('all');
  const [warehouseKeys, setWarehouseKeys] = useState<Set<string>>(new Set());
  const [page, setPage]           = useState(1);
  const [tab, setTab]             = useState<'table' | 'analysis'>('table');
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

  // Filtered rows by item search + company filter
  const filteredRows = useMemo(() => {
    if (!activeFile) return [];
    let rows = activeFile.rows;
    const q = itemSearch.trim().toLowerCase();
    if (q) rows = rows.filter(row => activeFile.fixedCols.some(c => String(row[c] ?? '').toLowerCase().includes(q)));
    if (companyFilter !== 'all' && companyCol) rows = rows.filter(row => String(row[companyCol] ?? '').trim() === companyFilter);
    return rows;
  }, [activeFile, itemSearch, companyFilter, companyCol]);

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

  // Detect item name column
  const itemNameCol = useMemo(() => {
    if (!activeFile) return '';
    const lower = activeFile.fixedCols.map(c => c.toLowerCase());
    return (
      activeFile.fixedCols.find((_, i) => ['item', 'الايتم', 'اسم', 'نام', 'name', 'product'].some(k => lower[i].includes(k))) ??
      activeFile.fixedCols[1] ?? activeFile.fixedCols[0] ?? ''
    );
  }, [activeFile]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows   = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Handlers
  const handleFile = useCallback((file: File) => {
    setImportErr('');
    setImporting(true);
    const reader = new FileReader();
    reader.onload = e => {
      const result = parseExcel(e.target!.result as ArrayBuffer, file.name);
      if (typeof result === 'string') {
        setImportErr(result);
        setImporting(false);
      } else {
        setFiles(prev => { const next = [...prev, result as SalesFile]; saveFiles(next); return next; });
        setActiveId((result as SalesFile).id);
        setItemSearch(''); setCompanyFilter('all'); setRegionFilter('all'); setWarehouseKeys(new Set()); setPage(1);
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
      saveFiles(next);
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
            البرنامج يدعم ملفات بترويسة صف واحد (كود · اسم · سعر · مخازن) أو صفين (منطقة مدمجة فوق أسماء المخازن). البيانات محفوظة محلياً في المتصفح.
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
              <button onClick={() => { setActiveId(f.id); selectRegion('all'); setItemSearch(''); setCompanyFilter('all'); setPage(1); }}
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
              { icon: '🏪', label: 'المخازن',               value: activeFile.areaCols.length },
              { icon: '🔢', label: 'مجموع المبيعات المرئية', value: fmtNum(grandTotal) },
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
            {/* Item search */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>🔍 البحث بالايتم</div>
              <div style={{ position: 'relative', maxWidth: 420 }}>
                <input value={itemSearch}
                  onChange={e => { setItemSearch(e.target.value); setPage(1); }}
                  placeholder="اكتب اسم الايتم أو الكود..."
                  style={{ width: '100%', padding: '8px 32px 8px 10px', borderRadius: 9, border: '1.5px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box', direction: 'rtl', background: itemSearch ? '#f0fdf4' : '#fff' }} />
                {itemSearch && (
                  <button onClick={() => { setItemSearch(''); setPage(1); }}
                    style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 15 }}>×</button>
                )}
              </div>
              {itemSearch && <div style={{ fontSize: 11, color: '#10b981', marginTop: 4, fontWeight: 600 }}>✓ {filteredRows.length} ايتم مطابق</div>}
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
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>📍 المنطقة</div>
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

          {/* Tab switcher */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {([['table', '📋 الجدول'], ['analysis', '📈 التحليل']] as [string, string][]).map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id as 'table' | 'analysis')} style={fp(tab === id)}>{lbl}</button>
            ))}
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
                      {activeFile.fixedCols.map((c, i) => <th key={i} style={thS}>{c}</th>)}
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
                        const rt = rowTotal(row, displayCols);
                        return (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                            onMouseLeave={e => (e.currentTarget.style.background = '')}>
                            <td style={{ ...tdS, color: '#94a3b8', fontSize: 11 }}>{(page - 1) * PAGE_SIZE + idx + 1}</td>
                            {activeFile.fixedCols.map((c, ci) => {
                              const val = row[c] ?? '';
                              const hi = itemSearch && val.toLowerCase().includes(itemSearch.toLowerCase());
                              return (
                                <td key={ci} style={{ ...tdS, ...(ci === 1 ? { minWidth: 180, maxWidth: 280, fontWeight: 600 } : {}), ...(ci === 2 ? { color: '#6366f1' } : {}) }}>
                                  {hi ? <span style={{ background: '#fef9c3', borderRadius: 3, padding: '1px 4px' }}>{val}</span> : (val || <span style={{ color: '#d1d5db' }}>—</span>)}
                                </td>
                              );
                            })}
                            {displayCols.map(col => {
                              const v = cellVal(row, col);
                              return (
                                <td key={col.key} style={{ ...tdA, background: isRT(col) && v > 0 ? '#f0fdf4' : undefined, color: v > 0 ? '#1e293b' : '#e2e8f0', fontWeight: v > 0 ? 700 : 400, borderRight: isRT(col) ? '2px solid #e2e8f0' : undefined, borderLeft: isRT(col) ? '2px solid #e2e8f0' : undefined }}>
                                  {fmtNum(v)}
                                </td>
                              );
                            })}
                            <td style={{ ...tdA, background: rt > 0 ? '#f0fdf4' : undefined, color: rt > 0 ? '#065f46' : '#e2e8f0', fontWeight: 700 }}>{fmtNum(rt)}</td>
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
                        <td key={col.key} style={{ ...tdA, color: '#1e293b', fontWeight: 800 }}>{fmtNum(grandTotals[col.key] ?? 0)}</td>
                      ))}
                      <td style={{ ...tdA, color: '#065f46', fontWeight: 800 }}>{fmtNum(grandTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => setPage(1)} disabled={page === 1} style={pgBtn(page === 1)}>«</button>
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={pgBtn(page === 1)}>‹</button>
                  {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                    const mid = Math.max(4, Math.min(page, totalPages - 3));
                    return i + mid - 3;
                  }).filter(p => p >= 1 && p <= totalPages).map(p => (
                    <button key={p} onClick={() => setPage(p)} style={{ ...pgBtn(false), background: p === page ? '#6366f1' : '#f8fafc', color: p === page ? '#fff' : '#374151', border: `1.5px solid ${p === page ? '#6366f1' : '#e2e8f0'}`, fontWeight: p === page ? 700 : 400 }}>{p}</button>
                  ))}
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={pgBtn(page === totalPages)}>›</button>
                  <button onClick={() => setPage(totalPages)} disabled={page === totalPages} style={pgBtn(page === totalPages)}>»</button>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>صفحة {page} من {totalPages}</span>
                </div>
              )}
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
                  {itemSearch && <span style={{ fontSize: 11, color: '#10b981', marginRight: 8, fontWeight: 400 }}>({filteredRows.length} نتيجة)</span>}
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
              {itemSearch && filteredRows.length > 0 && filteredRows.length <= 5 && (
                <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #e2e8f0', padding: '16px 18px' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 14 }}>
                    🔎 تفاصيل "{itemSearch}" بالمناطق
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
