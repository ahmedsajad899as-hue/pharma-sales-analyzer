import { useState, useRef, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';

// ── Types ────────────────────────────────────────────────────────────
interface SalesFile {
  id: string;
  name: string;
  uploadedAt: string;
  columns: string[];
  rows: Record<string, string>[];
}

// ── Storage helpers ──────────────────────────────────────────────────
const STORE_KEY = 'independent_sales_data';

function loadFiles(): SalesFile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as SalesFile[]) : [];
  } catch {
    return [];
  }
}
function saveFiles(files: SalesFile[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(files));
}

// ── Helpers ──────────────────────────────────────────────────────────
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

// ── Component ────────────────────────────────────────────────────────
export default function SalesDataPage() {
  const [files, setFiles]         = useState<SalesFile[]>(() => loadFiles());
  const [activeFileId, setActiveFileId] = useState<string | 'all'>('all');
  const [search, setSearch]       = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [sortCol, setSortCol]     = useState('');
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('asc');
  const [page, setPage]           = useState(1);
  const PAGE_SIZE = 50;
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Active rows ──────────────────────────────────────────────────
  const activeRows = useMemo(() => {
    if (activeFileId === 'all') return files.flatMap(f => f.rows.map(r => ({ ...r, _file: f.name })));
    const f = files.find(x => x.id === activeFileId);
    return f ? f.rows : [];
  }, [files, activeFileId]);

  const activeColumns = useMemo(() => {
    if (activeFileId === 'all') {
      const seen = new Set<string>();
      const cols: string[] = [];
      files.forEach(f => f.columns.forEach(c => { if (!seen.has(c)) { seen.add(c); cols.push(c); } }));
      if (files.length > 1) cols.unshift('_file');
      return cols;
    }
    return files.find(x => x.id === activeFileId)?.columns ?? [];
  }, [files, activeFileId]);

  // ── Search + Sort ────────────────────────────────────────────────
  // Columns whose NAME matches the search query
  const matchedColumns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(activeColumns.filter(c => c.toLowerCase().includes(q)));
  }, [search, activeColumns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeRows;

    // 1. Rows where any CELL VALUE matches
    const cellMatches = activeRows.filter(row =>
      Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q))
    );

    // 2. If the query matches a COLUMN NAME, also include ALL rows
    //    (the matched column will be highlighted in the table)
    if (matchedColumns.size > 0 && cellMatches.length === 0) {
      // sort: rows with non-empty value in matched column first
      return [...activeRows].sort((a, b) => {
        const matchedCol = [...matchedColumns][0];
        const av = String(a[matchedCol] ?? '');
        const bv = String(b[matchedCol] ?? '');
        if (av && !bv) return -1;
        if (!av && bv) return 1;
        return 0;
      });
    }

    // 3. Combine both (rows that matched a cell value OR are in a matched column)
    const cellMatchSet = new Set(cellMatches.map((_, i) => i));
    let rows = cellMatches;
    if (matchedColumns.size > 0) {
      // also include all rows, but put cell-match rows first
      const colOnlyRows = activeRows.filter(row =>
        !cellMatches.includes(row)
      );
      rows = [...cellMatches, ...colOnlyRows];
    }

    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        const av = String(a[sortCol] ?? '');
        const bv = String(b[sortCol] ?? '');
        const n = av.localeCompare(bv, 'ar', { numeric: true });
        return sortDir === 'asc' ? n : -n;
      });
    }
    return rows;
  }, [activeRows, search, sortCol, sortDir, matchedColumns]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Detect stale files imported before smart header fix (columns named EMPTY_x__)
  const activeFile = files.find(f => f.id === activeFileId);
  const hasStaleColumns = (activeFileId === 'all' ? files : activeFile ? [activeFile] : [])
    .some(f => f.columns.some(c => /^EMPTY_\d+__?$/.test(c)));

  // ── Summary counts ───────────────────────────────────────────────
  const summary = useMemo(() => {
    const colLower = (key: string) => activeColumns.find(c => c.toLowerCase().includes(key.toLowerCase()));
    const uniqueVals = (col?: string) => col ? new Set(activeRows.map(r => r[col]).filter(Boolean)).size : 0;
    return {
      rows: activeRows.length,
      items:     uniqueVals(colLower('ايتم') ?? colLower('item') ?? colLower('منتج') ?? colLower('product')),
      areas:     uniqueVals(colLower('منطقة') ?? colLower('area') ?? colLower('region')),
      companies: uniqueVals(colLower('شركة') ?? colLower('company')),
    };
  }, [activeRows, activeColumns]);

  // ── Import ───────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    setImportError('');
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data  = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb    = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];

        // Read as raw 2-D array first so we can find the real header row.
        // Excel files often have a decorative title row or merged cells in row 0
        // causing xlsx to name columns "__EMPTY_1", "__EMPTY_2", etc.
        const raw2d = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
        if (raw2d.length === 0) { setImportError('الملف لا يحتوي على بيانات'); setImporting(false); return; }

        // Find the row (within first 10 rows) that has the most non-empty cells.
        // That row is the real header row.
        let headerRowIdx = 0;
        let maxNonEmpty = 0;
        raw2d.slice(0, 10).forEach((row, idx) => {
          const count = (row as unknown[]).filter(v => v !== '' && v !== null && v !== undefined).length;
          if (count > maxNonEmpty) { maxNonEmpty = count; headerRowIdx = idx; }
        });

        const headerRow = raw2d[headerRowIdx] as unknown[];

        // Build column names: use cell value; fall back to a plain Col_N label
        const columns: string[] = headerRow.map((v, i) => {
          const s = String(v ?? '').trim();
          return s !== '' ? s : `عمود_${i + 1}`;
        });

        // Data rows = everything after the header row, skip completely empty rows
        const rows: Record<string, string>[] = [];
        for (let ri = headerRowIdx + 1; ri < raw2d.length; ri++) {
          const rowArr = raw2d[ri] as unknown[];
          const obj = Object.fromEntries(columns.map((c, ci) => [c, String(rowArr[ci] ?? '')]));
          // Skip rows where every value is empty
          if (Object.values(obj).every(v => v === '' || v === 'undefined')) continue;
          rows.push(obj);
        }

        if (rows.length === 0) { setImportError('لم يتم العثور على صفوف بيانات بعد الترويسة'); setImporting(false); return; }

        const entry: SalesFile = {
          id:         uid(),
          name:       file.name.replace(/\.[^.]+$/, ''),
          uploadedAt: new Date().toISOString(),
          columns,
          rows,
        };

        setFiles(prev => {
          const next = [...prev, entry];
          saveFiles(next);
          return next;
        });
        setActiveFileId(entry.id);
        setPage(1);
        setSearch('');
        setShowImport(false);
      } catch {
        setImportError('فشل قراءة الملف — تأكد أنه Excel أو CSV صحيح');
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const deleteFile = (id: string) => {
    if (!confirm('هل تريد حذف هذا الملف؟')) return;
    setFiles(prev => {
      const next = prev.filter(f => f.id !== id);
      saveFiles(next);
      if (activeFileId === id) setActiveFileId('all');
      return next;
    });
  };

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
    setPage(1);
  };

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div style={{ padding: '20px 16px 60px', maxWidth: 1100, margin: '0 auto', direction: 'rtl' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>📊 بيانات المبيعات</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: '#94a3b8' }}>استيراد ملفات Excel وعرض البيانات مع البحث الذكي</p>
        </div>
        <button
          onClick={() => { setShowImport(v => !v); setImportError(''); }}
          style={{
            padding: '8px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            background: '#6366f1', color: '#fff', border: 'none',
            boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
          }}>
          ＋ استيراد ملف Excel
        </button>
      </div>

      {/* Import Panel */}
      {showImport && (
        <div style={{
          background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 14,
          padding: '18px 20px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', marginBottom: 10 }}>📁 رفع ملف Excel / CSV</div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px', lineHeight: 1.7 }}>
            يمكنك رفع أي ملف Excel أو CSV يحتوي على بيانات مبيعات — مناطق، ايتمات، شركات، كميات، أي بيانات تريدها.
            <br />البيانات محفوظة محليًا فقط ولا تُرفع للسيرفر.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              disabled={importing}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              style={{ fontSize: 13 }}
            />
            {importing && <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 600 }}>⏳ جاري الاستيراد...</span>}
          </div>
          {importError && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
              ⚠️ {importError}
            </div>
          )}
        </div>
      )}

      {/* Stale columns warning */}
      {files.length > 0 && hasStaleColumns && (
        <div style={{
          background: '#fffbeb', border: '1.5px solid #fbbf24', borderRadius: 12,
          padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13, color: '#92400e', direction: 'rtl',
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <strong>أسماء الأعمدة غير صحيحة</strong> — هذا الملف رُفع قبل تحديث الاستيراد الذكي.
            يرجى <strong>حذف الملف وإعادة رفعه</strong> لتظهر أسماء المخازن والمناطق بشكل صحيح.
          </div>
          <button onClick={() => { if (activeFileId !== 'all') deleteFile(activeFileId); }} style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: '#fbbf24', color: '#fff', border: 'none', flexShrink: 0,
          }}>🗑 حذف وإعادة رفع</button>
        </div>
      )}

      {/* Matched column badge */}
      {search && matchedColumns.size > 0 && (
        <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>عمود مطابق:</span>
          {[...matchedColumns].map(col => (
            <span key={col} style={{
              background: '#fef9c3', border: '1.5px solid #fbbf24', borderRadius: 20,
              padding: '3px 12px', fontSize: 12, fontWeight: 700, color: '#92400e',
            }}>📌 {col}</span>
          ))}
        </div>
      )}

      {/* Files tab bar */}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            onClick={() => { setActiveFileId('all'); setPage(1); setSearch(''); }}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: `1.5px solid ${activeFileId === 'all' ? '#6366f1' : '#e2e8f0'}`,
              background: activeFileId === 'all' ? '#eef2ff' : '#f8fafc',
              color: activeFileId === 'all' ? '#4338ca' : '#64748b',
            }}>
            🗂 الكل ({files.reduce((s, f) => s + f.rows.length, 0)} صف)
          </button>
          {files.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
              <button
                onClick={() => { setActiveFileId(f.id); setPage(1); setSearch(''); }}
                style={{
                  padding: '5px 12px', borderRadius: '20px 0 0 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${activeFileId === f.id ? '#6366f1' : '#e2e8f0'}`,
                  borderLeft: 'none',
                  background: activeFileId === f.id ? '#eef2ff' : '#f8fafc',
                  color: activeFileId === f.id ? '#4338ca' : '#64748b',
                  maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={`${f.name} — ${fmtDate(f.uploadedAt)}`}>
                📄 {f.name}
              </button>
              <button
                onClick={() => deleteFile(f.id)}
                style={{
                  padding: '5px 8px', borderRadius: '0 20px 20px 0', fontSize: 11, cursor: 'pointer',
                  border: `1.5px solid ${activeFileId === f.id ? '#6366f1' : '#e2e8f0'}`,
                  borderRight: 'none',
                  background: activeFileId === f.id ? '#eef2ff' : '#f8fafc',
                  color: '#ef4444',
                }}
                title="حذف الملف">×</button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {files.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '80px 20px', color: '#94a3b8',
          background: '#f8fafc', borderRadius: 16, border: '2px dashed #e2e8f0',
        }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>📊</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>لا توجد بيانات بعد</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>ارفع ملف Excel أو CSV لعرض البيانات والبحث فيها</div>
          <button
            onClick={() => setShowImport(true)}
            style={{
              padding: '10px 24px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              background: '#6366f1', color: '#fff', border: 'none',
              boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
            }}>
            ＋ استيراد ملف Excel
          </button>
        </div>
      )}

      {/* Summary cards */}
      {files.length > 0 && activeRows.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { icon: '📋', label: 'إجمالي الصفوف',  value: summary.rows },
            { icon: '💊', label: 'ايتمات مختلفة',  value: summary.items     || '—' },
            { icon: '📍', label: 'مناطق مختلفة',   value: summary.areas     || '—' },
            { icon: '🏢', label: 'شركات مختلفة',   value: summary.companies || '—' },
          ].map(s => (
            <div key={s.label} style={{
              flex: '1 1 110px', background: '#fff', borderRadius: 12, padding: '12px 16px',
              border: '1.5px solid #e2e8f0', textAlign: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            }}>
              <div style={{ fontSize: 20 }}>{s.icon}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#6366f1', lineHeight: 1.2 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search bar */}
      {files.length > 0 && (
        <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 200 }}>
            <span style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 14, color: '#94a3b8', pointerEvents: 'none',
            }}>🔍</span>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="بحث في كل الأعمدة — منطقة، ايتم، شركة، أي قيمة..."
              style={{
                width: '100%', padding: '9px 34px 9px 12px', borderRadius: 10,
                border: '1.5px solid #e2e8f0', fontSize: 13, outline: 'none',
                boxSizing: 'border-box', direction: 'rtl',
                background: search ? '#f0fdf4' : '#fff',
              }}
            />
            {search && (
              <button onClick={() => { setSearch(''); setPage(1); }} style={{
                position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1,
              }}>×</button>
            )}
          </div>
          <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>
            {search
              ? matchedColumns.size > 0 && filtered.length === activeRows.length
                ? `عمود مطابق · ${activeRows.length} صف`
                : `${filtered.length} نتيجة`
              : `${activeRows.length} صف`}
            {activeColumns.length > 0 && ` · ${activeColumns.length} عمود`}
          </span>
        </div>
      )}

      {/* Table */}
      {files.length > 0 && activeColumns.length > 0 && (
        <>
          <div style={{ overflowX: 'auto', borderRadius: 12, border: '1.5px solid #e2e8f0', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, direction: 'rtl', minWidth: 400 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 700, color: '#64748b', fontSize: 11, textAlign: 'right', width: 40, whiteSpace: 'nowrap' }}>
                    #
                  </th>
                  {activeColumns.map(col => {
                    const isColMatch = matchedColumns.has(col);
                    return (
                    <th key={col}
                      onClick={() => handleSort(col)}
                      style={{
                        padding: '10px 14px', fontWeight: 700, color: isColMatch ? '#92400e' : '#1e293b', fontSize: 12,
                        textAlign: 'right', whiteSpace: 'nowrap', cursor: 'pointer',
                        userSelect: 'none',
                        background: isColMatch ? '#fef9c3' : sortCol === col ? '#eef2ff' : undefined,
                        boxShadow: isColMatch ? 'inset 0 -3px 0 #fbbf24' : undefined,
                      }}>
                      {col === '_file' ? '📄 الملف' : col}
                      {isColMatch && <span style={{ marginRight: 4, fontSize: 10 }}>📌</span>}
                      {sortCol === col && (
                        <span style={{ marginRight: 4, fontSize: 10 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={activeColumns.length + 1} style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>لا توجد نتائج مطابقة</td></tr>
                ) : pageRows.map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                    <td style={{ padding: '9px 14px', color: '#94a3b8', fontSize: 11, fontWeight: 600 }}>
                      {(page - 1) * PAGE_SIZE + idx + 1}
                    </td>
                    {activeColumns.map(col => {
                      const val = String(row[col] ?? '—');
                      const isCellMatch = search.trim() && val.toLowerCase().includes(search.trim().toLowerCase());
                      const isColMatch  = matchedColumns.has(col);
                      return (
                        <td key={col} style={{
                          padding: '9px 14px', color: '#1e293b', maxWidth: 220, verticalAlign: 'top',
                          background: isColMatch ? '#fffef0' : undefined,
                        }}>
                          {isCellMatch ? (
                            <span style={{ background: '#fef9c3', borderRadius: 3, padding: '1px 3px' }}>{val}</span>
                          ) : (
                            <span style={{ color: val === '—' ? '#d1d5db' : undefined }}>{val}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button onClick={() => setPage(1)} disabled={page === 1} style={paginBtn(page === 1)}>«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={paginBtn(page === 1)}>‹</button>
              {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                const mid = Math.max(4, Math.min(page, totalPages - 3));
                return i + mid - 3;
              }).filter(p => p >= 1 && p <= totalPages).map(p => (
                <button key={p} onClick={() => setPage(p)} style={{
                  ...paginBtn(false),
                  background: p === page ? '#6366f1' : '#f8fafc',
                  color:      p === page ? '#fff'   : '#374151',
                  border: `1.5px solid ${p === page ? '#6366f1' : '#e2e8f0'}`,
                  fontWeight: p === page ? 700 : 400,
                }}>{p}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={paginBtn(page === totalPages)}>›</button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} style={paginBtn(page === totalPages)}>»</button>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>صفحة {page} من {totalPages}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function paginBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '5px 11px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
    border: '1.5px solid #e2e8f0', background: '#f8fafc', color: disabled ? '#d1d5db' : '#374151',
    pointerEvents: disabled ? 'none' : 'auto',
  };
}
