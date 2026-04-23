import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { PageId } from '../App';

/* ─────────────────────────────────────────────────────────────────────────────
   ExcelPreviewModal — spreadsheet-like editor before export
───────────────────────────────────────────────────────────────────────────── */
interface PreviewSheet { name: string; rows: string[][]; }

function ExcelPreviewModal({ sheets: initSheets, onClose, fileName }: {
  sheets: PreviewSheet[];
  onClose: () => void;
  fileName: string;
}) {
  const [sheets, setSheets]           = useState<PreviewSheet[]>(initSheets);
  const [activeIdx, setActiveIdx]     = useState(0);
  const [editCell, setEditCell]       = useState<{ r: number; c: number } | null>(null);
  const [editVal, setEditVal]         = useState('');
  const [dragCol, setDragCol]         = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<number | null>(null);
  const [selStart, setSelStart]       = useState<{ r: number; c: number } | null>(null);
  const [selEnd, setSelEnd]           = useState<{ r: number; c: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef  = useRef<HTMLDivElement>(null);

  // ── Auto-scroll while dragging selection near edges ──────
  const handleGridMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting || !gridRef.current) return;
    const el = gridRef.current;
    const rect = el.getBoundingClientRect();
    const thr = 50; const spd = 14;
    if      (e.clientY < rect.top    + thr) el.scrollTop  -= spd;
    else if (e.clientY > rect.bottom - thr) el.scrollTop  += spd;
    if      (e.clientX < rect.left   + thr) el.scrollLeft -= spd;
    else if (e.clientX > rect.right  - thr) el.scrollLeft += spd;
  };

  const sheet = sheets[activeIdx];

  // ── Sync summary sheet after any edit to a data sheet ────
  const recalcSummary = (sheetIdx: number, newRows: string[][], prev: PreviewSheet[]): PreviewSheet[] => {
    const updated = prev.map((s, i) => i === sheetIdx ? { ...s, rows: newRows } : s);
    if (sheetIdx === 0 || !prev[0]) return updated;

    const header  = newRows[0] ?? [];
    const rtCol   = header.findIndex(h => /نوع.*سجل|record.?type/i.test(h));
    const qtyCol  = header.findIndex(h => /كمية|qty|quantity/i.test(h));
    const valCol  = header.findIndex(h =>
      !/سعر.*وحد|unit.?price/i.test(h) && /قيمة|إجمالي|total.*val|val.*total/i.test(h));

    const dataRows = newRows.slice(1);
    const sum = (col: number) => col < 0 ? null : dataRows.reduce((s, row) => {
      const v = parseFloat(row[col] ?? ''); if (isNaN(v)) return s;
      const isRet = rtCol >= 0 && /↩|ارجاع|return/i.test(row[rtCol] ?? '');
      return s + (isRet ? -Math.abs(v) : Math.abs(v));
    }, 0);

    const tQty = sum(qtyCol);
    const tVal = sum(valCol);

    const summaryRows = prev[0].rows.map((row, ri) => {
      if (ri !== sheetIdx) return row;
      return row.map((v, ci) =>
        ci === 3 && tQty !== null ? String(Math.round(tQty)) :
        ci === 4 && tVal !== null ? String(Math.round(tVal)) : v
      );
    });

    // Recalc grand total row (col 0 is empty)
    const newSummary = [...summaryRows];
    const gtIdx = newSummary.findIndex((row, ri) => ri > 0 && row[0] === '');
    if (gtIdx >= 0) {
      const gQty = newSummary.slice(1, gtIdx).reduce((s, r) => s + (Number(r[3]) || 0), 0);
      const gVal = newSummary.slice(1, gtIdx).reduce((s, r) => s + (Number(r[4]) || 0), 0);
      newSummary[gtIdx] = newSummary[gtIdx].map((v, ci) =>
        ci === 3 ? String(Math.round(gQty)) : ci === 4 ? String(Math.round(gVal)) : v
      );
    }

    return updated.map((s, i) => i === 0 ? { ...s, rows: newSummary } : s);
  };

  const setRows = (rows: string[][]) =>
    setSheets(prev => recalcSummary(activeIdx, rows, prev));

  // ── Cell edit ────────────────────────────────────────────
  const startEdit = (r: number, c: number) => {
    setEditCell({ r, c });
    setEditVal(sheet.rows[r]?.[c] ?? '');
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commitEdit = () => {
    if (!editCell) return;
    const newRows = sheet.rows.map((row, ri) =>
      ri === editCell.r ? row.map((v, ci) => ci === editCell.c ? editVal : v) : row
    );
    setRows(newRows);
    setEditCell(null);
  };

  // ── Delete row / col ─────────────────────────────────────
  const deleteRow = (ri: number) => setRows(sheet.rows.filter((_, i) => i !== ri));
  const deleteCol = (ci: number) => setRows(sheet.rows.map(row => row.filter((_, i) => i !== ci)));

  // ── Column drag-reorder ───────────────────────────────────
  const onDragStart = (ci: number) => setDragCol(ci);
  const onDragOver  = (e: React.DragEvent, ci: number) => { e.preventDefault(); setDragOverCol(ci); };
  const onDrop      = (ci: number) => {
    if (dragCol === null || dragCol === ci) { setDragCol(null); setDragOverCol(null); return; }
    const newRows = sheet.rows.map(row => {
      const r = [...row];
      const [removed] = r.splice(dragCol, 1);
      r.splice(ci, 0, removed);
      return r;
    });
    setRows(newRows);
    setDragCol(null);
    setDragOverCol(null);
  };

  // ── Export modified data ──────────────────────────────────
  const exportModified = () => {
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => {
      const ws = XLSX.utils.aoa_to_sheet(s.rows);
      if (s.rows[0]) ws['!cols'] = s.rows[0].map(() => ({ wch: 22 }));
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    });
    XLSX.writeFile(wb, fileName);
  };

  const colCount = sheet.rows[0]?.length ?? 0;

  // Clear selection when switching sheets
  useEffect(() => { setSelStart(null); setSelEnd(null); }, [activeIdx]);

  const isInSel = (r: number, c: number) => {
    if (!selStart || !selEnd) return false;
    return r >= Math.min(selStart.r, selEnd.r) && r <= Math.max(selStart.r, selEnd.r)
        && c >= Math.min(selStart.c, selEnd.c) && c <= Math.max(selStart.c, selEnd.c);
  };

  // Column totals — sum numeric values in data rows
  // Skip: unit-price columns, and grand-total rows (first cell is empty string)
  const colTotals: (number | null)[] = Array.from({ length: colCount }, (_, ci) => {
    const header = (sheet.rows[0]?.[ci] ?? '');
    if (/\bسعر.*الوحد|الوحد.*سعر|unit.?price|price.?per\b/i.test(header)) return null;
    return sheet.rows.slice(1)
      .filter(row => row[0] !== '')        // skip grand-total rows (empty # cell)
      .reduce((acc, row) => {
        const v = parseFloat(row[ci] ?? '');
        return acc + (isNaN(v) ? 0 : v);
      }, 0);
  });

  // Selection stats
  const selNums: number[] = [];
  if (selStart && selEnd) {
    for (let r = Math.min(selStart.r, selEnd.r); r <= Math.max(selStart.r, selEnd.r); r++) {
      for (let c = Math.min(selStart.c, selEnd.c); c <= Math.max(selStart.c, selEnd.c); c++) {
        const v = parseFloat(sheet.rows[r]?.[c] ?? '');
        if (!isNaN(v)) selNums.push(v);
      }
    }
  }
  const selSum = selNums.reduce((a, b) => a + b, 0);
  const selNumericCount = selNums.length;
  const selCellCount = selStart && selEnd
    ? (Math.abs(selStart.r - selEnd.r) + 1) * (Math.abs(selStart.c - selEnd.c) + 1)
    : 0;

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: '96vw', maxWidth: 1200,
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,.25)', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>📊</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>معاينة وتحرير بيانات التصدير</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{fileName}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={exportModified}
              style={{
                padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              📥 تصدير Excel
            </button>
            <button onClick={onClose} className="modal-close" style={{ position: 'static' }}>✕</button>
          </div>
        </div>

        {/* Sheet Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 16px 0', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', overflowX: 'auto', flexShrink: 0 }}>
          {sheets.map((s, i) => (
            <button key={i} onClick={() => setActiveIdx(i)} style={{
              padding: '5px 14px', borderRadius: '8px 8px 0 0', border: '1px solid',
              borderBottomColor: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600,
              background: i === activeIdx ? '#fff' : '#f1f5f9',
              borderColor: i === activeIdx ? '#e5e7eb' : 'transparent',
              color: i === activeIdx ? '#1e293b' : '#64748b',
              marginBottom: -1,
            }}>
              {s.name}
            </button>
          ))}
        </div>

        {/* Hints */}
        <div style={{ padding: '6px 16px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: 11, color: '#92400e', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>✏️ انقر على خلية للتعديل</span>
          <span>↔️ اسحب رأس العمود لإعادة الترتيب</span>
          <span>✕ حذف الصف / العمود</span>
          <span>🖱️ اسحب بالماوس لتحديد خلايا ومعرفة مجموعها</span>
        </div>

        {/* Grid */}
        <div
          ref={gridRef}
          style={{ flex: 1, overflow: 'auto', padding: '0' }}
          onMouseUp={() => setIsSelecting(false)}
          onMouseLeave={() => setIsSelecting(false)}
          onMouseMove={handleGridMouseMove}
        >
          <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', position: 'sticky', top: 0, zIndex: 10 }}>
                {/* Row-delete gutter */}
                <th style={{ width: 28, minWidth: 28, borderRight: '1px solid #e5e7eb', background: '#f8fafc' }} />
                {/* Col number header */}
                {Array.from({ length: colCount }, (_, ci) => (
                  <th
                    key={ci}
                    draggable
                    onDragStart={() => onDragStart(ci)}
                    onDragOver={e => onDragOver(e, ci)}
                    onDrop={() => onDrop(ci)}
                    onDragEnd={() => { setDragCol(null); setDragOverCol(null); }}
                    style={{
                      padding: '4px 6px', border: '1px solid #e5e7eb', textAlign: 'center',
                      cursor: 'grab', userSelect: 'none', whiteSpace: 'nowrap',
                      background: dragOverCol === ci ? '#dbeafe' : ci === dragCol ? '#fef3c7' : '#f1f5f9',
                      position: 'relative', minWidth: 80,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <span style={{ color: '#94a3b8', fontSize: 10 }}>⠿</span>
                      <span>{String.fromCharCode(65 + ci)}</span>
                      <button
                        onClick={() => deleteCol(ci)}
                        title="حذف العمود"
                        style={{ padding: '0 3px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10, lineHeight: '14px', marginRight: 2 }}
                      >✕</button>
                    </div>
                  </th>
                ))}
              </tr>
              {/* Actual header row (row 0) */}
              <tr style={{ background: '#e0f2fe', position: 'sticky', top: 28, zIndex: 9 }}>
                <td style={{ width: 28, minWidth: 28, borderRight: '1px solid #e5e7eb', textAlign: 'center', background: '#f8fafc' }}>
                  <button onClick={() => deleteRow(0)} title="حذف السطر" style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
                </td>
                {(sheet.rows[0] ?? []).map((cell, ci) => (
                  <td
                    key={ci}
                    onDoubleClick={() => startEdit(0, ci)}
                    onMouseDown={() => { setSelStart({ r: 0, c: ci }); setSelEnd({ r: 0, c: ci }); setIsSelecting(true); setEditCell(null); }}
                    onMouseEnter={() => { if (isSelecting) setSelEnd({ r: 0, c: ci }); }}
                    style={{ padding: '4px 8px', border: `1px solid ${isInSel(0, ci) ? '#93c5fd' : '#bae6fd'}`, fontWeight: 700, color: '#0c4a6e', cursor: 'cell', whiteSpace: 'nowrap', background: isInSel(0, ci) ? '#bfdbfe' : '#e0f2fe', userSelect: 'none' }}
                  >
                    {editCell?.r === 0 && editCell.c === ci ? (
                      <input
                        ref={inputRef}
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditCell(null); }}
                        style={{ border: '1.5px solid #3b82f6', borderRadius: 4, padding: '1px 4px', width: '100%', minWidth: 60, fontSize: 12 }}
                        autoFocus
                      />
                    ) : String(cell ?? '')}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.slice(1).map((row, ri) => {
                const actualRi = ri + 1;
                return (
                  <tr key={actualRi} style={{ background: actualRi % 2 === 0 ? '#f8fafc' : '#fff' }}>
                    <td style={{ width: 28, minWidth: 28, textAlign: 'center', borderRight: '1px solid #e5e7eb', color: '#9ca3af', fontSize: 10 }}>
                      <button onClick={() => deleteRow(actualRi)} title="حذف السطر" style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
                    </td>
                    {Array.from({ length: colCount }, (_, ci) => (
                      <td
                        key={ci}
                        onDoubleClick={() => startEdit(actualRi, ci)}
                        onMouseDown={() => { setSelStart({ r: actualRi, c: ci }); setSelEnd({ r: actualRi, c: ci }); setIsSelecting(true); setEditCell(null); }}
                        onMouseEnter={() => { if (isSelecting) setSelEnd({ r: actualRi, c: ci }); }}
                        style={{ padding: '3px 8px', border: `1px solid ${isInSel(actualRi, ci) ? '#93c5fd' : '#e5e7eb'}`, cursor: 'cell', whiteSpace: 'nowrap', userSelect: 'none',
                          background: editCell?.r === actualRi && editCell.c === ci ? '#eff6ff' : isInSel(actualRi, ci) ? '#dbeafe' : undefined }}
                      >
                        {editCell?.r === actualRi && editCell.c === ci ? (
                          <input
                            ref={inputRef}
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditCell(null); }}
                            style={{ border: '1.5px solid #3b82f6', borderRadius: 4, padding: '1px 4px', width: '100%', minWidth: 60, fontSize: 12 }}
                            autoFocus
                          />
                        ) : String(row[ci] ?? '')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                <td style={{ width: 28, minWidth: 28, borderRight: '1px solid #e5e7eb', background: '#dcfce7', textAlign: 'center', fontSize: 11, color: '#16a34a', padding: '4px 0' }}>Σ</td>
                {colTotals.map((total, ci) => (
                  <td key={ci} style={{ padding: '4px 8px', border: '1px solid #bbf7d0', textAlign: 'right', color: total !== 0 ? '#15803d' : '#d1d5db', whiteSpace: 'nowrap', fontSize: 12, direction: 'ltr' }}>
                    {total === null ? '' : total !== 0 ? total.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '−'}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#6b7280', gap: 8, flexWrap: 'wrap' }}>
          <span>📋 {sheet.rows.length > 0 ? sheet.rows.length - 1 : 0} صف · {colCount} عمود</span>
          {selNumericCount > 0 && (
            <span style={{ color: '#1d4ed8', fontWeight: 600, background: '#dbeafe', padding: '3px 10px', borderRadius: 6 }}>
              خلايا: {selCellCount} &nbsp;·&nbsp; أرقام: {selNumericCount} &nbsp;·&nbsp; المجموع: {selSum.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          )}
          <button
            onClick={exportModified}
            style={{
              padding: '7px 22px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 13,
            }}
          >
            📥 تصدير هذا الملف
          </button>
        </div>
      </div>
    </div>
  );
}

/** Quantity cell — hidden by default, click to reveal, click again to hide.
 *  forceReveal overrides local state when provided (used by global toggle). */
function HiddenQty({ value, fmt, style, signed, forceReveal }: { value: number; fmt: (n: number) => string; style?: React.CSSProperties; signed?: boolean; forceReveal?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  // global forceReveal OR individual click — either one shows the value
  const show = !!forceReveal || revealed;
  const formatted = signed
    ? (value >= 0 ? `+${fmt(Math.abs(value))}` : `-${fmt(Math.abs(value))}`)
    : fmt(value);
  return (
    <span
      onClick={() => setRevealed(r => !r)}
      title={show ? 'انقر للإخفاء' : 'انقر لعرض الكمية'}
      style={{ cursor: 'pointer', userSelect: 'none', ...style }}
    >
      {show ? formatted : (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          background: '#f1f5f9', borderRadius: 6,
          padding: '1px 8px', fontSize: 12,
          color: '#94a3b8', letterSpacing: 2,
        }}>
          •••
        </span>
      )}
    </span>
  );
}

interface Rep { id: number; name: string; }
interface BreakdownRow { name: string; repName?: string; totalQty: number; totalValue: number; isZero?: boolean; }
interface CommReport {
  repName: string;
  totalQty: number;
  totalValue: number;
  byArea: BreakdownRow[];
  byItem: BreakdownRow[];
}
interface SciReport {
  repName: string;
  totalQty: number;
  totalValue: number;
  assignedAreas: Rep[];
  assignedItems: Rep[];
  assignedCommercialReps: Rep[];
  byArea: BreakdownRow[];
  byItem: BreakdownRow[];
  byRep: BreakdownRow[];
}

type Mode = 'commercial' | 'scientific' | 'overall';
type ReportView = 'sales' | 'returns' | 'net';
interface AreaItemRow { areaName: string; itemName: string; totalQty: number; totalValue: number; }
interface OverallReport { totalQuantity: number; totalValue: number; byItem: BreakdownRow[]; byArea: BreakdownRow[]; byAreaItem: AreaItemRow[]; minDate?: string | null; maxDate?: string | null; recordCount?: number; }

interface Props { activeFileIds: number[]; onNavigate?: (page: PageId) => void; }

export default function ReportsPage({ activeFileIds, onNavigate }: Props) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [mode, setMode]           = useState<Mode>(() => (sessionStorage.getItem('rpt_mode') as Mode) || 'scientific');

  // Commercial
  const [commReps, setCommReps]   = useState<Rep[]>([]);
  const [commRepId, setCommRepId] = useState(() => sessionStorage.getItem('rpt_commRepId') || '');
  const [commReport, setCommReport]                   = useState<CommReport | null>(null);
  const [commReturnsReport, setCommReturnsReport]     = useState<CommReport | null>(null);

  // Scientific
  const [sciReps, setSciReps]     = useState<Rep[]>([]);
  const [sciRepId, setSciRepId]   = useState(() => sessionStorage.getItem('rpt_sciRepId') || '');
  const [sciReport, setSciReport]                     = useState<SciReport | null>(null);
  const [sciReturnsReport, setSciReturnsReport]       = useState<SciReport | null>(null);

  // Shared
  const [fromDate, setFromDate]   = useState(() => sessionStorage.getItem('rpt_fromDate') || '');
  const [toDate, setToDate]       = useState(() => sessionStorage.getItem('rpt_toDate') || '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'area' | 'item' | 'rep'>('area');
  const [showInfoTags, setShowInfoTags] = useState(false);
  const [reportView, setReportView] = useState<ReportView>(() => (sessionStorage.getItem('rpt_view') as ReportView) || 'sales');
  const [exporting, setExporting]           = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selCommIds, setSelCommIds]           = useState<Set<number>>(new Set());
  const [selSciIds, setSelSciIds]             = useState<Set<number>>(new Set());
  const [exportProgress, setExportProgress]   = useState('');
  const [commViewMode, setCommViewMode] = useState<'qty' | 'value'>('value');
  const [sciViewMode,  setSciViewMode]  = useState<'qty' | 'value'>('value');

  // Overall / comprehensive analysis
  const [overallSales, setOverallSales]     = useState<OverallReport | null>(null);
  const [overallReturns, setOverallReturns] = useState<OverallReport | null>(null);
  const [overallSearch, setOverallSearch]   = useState('');
  const [overallSuggOpen, setOverallSuggOpen] = useState(false);
  const [overallSelectedTags, setOverallSelectedTags] = useState<{name: string; type: 'item'|'area'}[]>([]);
  const [overallTab, setOverallTab]         = useState<'area' | 'item'>('area');
  const [overallViewMode, setOverallViewMode] = useState<'qty' | 'value'>('value');
  const [overallFileId, setOverallFileId]   = useState<string>('');
  const [availableFiles, setAvailableFiles] = useState<{id: number; filename: string; rowCount?: number; uploadedAt?: string}[]>([]);

  // Preview modal state
  const [showPreviewModal, setShowPreviewModal]   = useState(false);
  const [previewSheets, setPreviewSheets]         = useState<PreviewSheet[]>([]);
  const [previewLoading, setPreviewLoading]       = useState(false);
  const previewFileName = `تقرير_${new Date().toISOString().slice(0,10)}.xlsx`;

  // Currency conversion — loaded from active file settings
  const [fileCurrencyMode, setFileCurrencyMode] = useState<'IQD' | 'USD'>('IQD');
  const [fileSourceCurrency, setFileSourceCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [fileExchangeRate, setFileExchangeRate] = useState<number>(1500);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-export-report') setShowExportModal(true);
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

// Always load scientific reps — doctor-visit reports don't require uploaded Excel files
  useEffect(() => {
    fetch(`/api/scientific-reps`, { headers: authH() })
      .then(r => r.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
        setSciReps(list);
      }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (activeFileIds.length === 0) {
      setCommReps([]);
      setCommRepId('');
      setCommReport(null);
      setSciReport(null);
      setFileCurrencyMode('IQD');
      setFileSourceCurrency('IQD');
      setFileExchangeRate(1500);
      return;
    }
    // Load currency settings from the first active file
    fetch(`/api/files`, { headers: authH() })
      .then(r => r.json())
      .then((json: any) => {
        const allFiles: any[] = Array.isArray(json.data) ? json.data : [];
        // Filter to only active files and store for overall mode file picker
        const activeFiles = allFiles.filter((f: any) => activeFileIds.includes(f.id));
        setAvailableFiles(activeFiles.map((f: any) => ({
          id: f.id,
          filename: f.originalName || f.filename || `ملف ${f.id}`,
          rowCount: f._count?.sales ?? f.rowCount,
          uploadedAt: f.uploadedAt,
        })));
        // Default overallFileId to most recent active file (array is desc by uploadedAt)
        if (activeFiles.length > 0 && !overallFileId) {
          setOverallFileId(String(activeFiles[0].id));
        }
        const activeFile = allFiles.find((f: any) => activeFileIds.includes(f.id));
        if (activeFile) {
          setFileCurrencyMode(activeFile.currencyMode === 'USD' ? 'USD' : 'IQD');
          setFileSourceCurrency(activeFile.detectedCurrency === 'USD' ? 'USD' : 'IQD');
          setFileExchangeRate(activeFile.exchangeRate || 1500);
        } else {
          setFileCurrencyMode('IQD');
          setFileSourceCurrency('IQD');
          setFileExchangeRate(1500);
        }
      }).catch(() => {});

    const repsUrl = `/api/representatives?fileIds=${activeFileIds.join(',')}`;
    fetch(repsUrl, { headers: authH() })
      .then(r => r.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
        setCommReps(list);
      }).catch(() => {});
  }, [activeFileIds.join(',')]);

  // Persist key state to sessionStorage whenever it changes
  useEffect(() => { sessionStorage.setItem('rpt_mode', mode); }, [mode]);
  useEffect(() => { sessionStorage.setItem('rpt_commRepId', commRepId); }, [commRepId]);
  useEffect(() => { sessionStorage.setItem('rpt_sciRepId', sciRepId); }, [sciRepId]);
  useEffect(() => { sessionStorage.setItem('rpt_fromDate', fromDate); }, [fromDate]);
  useEffect(() => { sessionStorage.setItem('rpt_toDate', toDate); }, [toDate]);
  useEffect(() => { sessionStorage.setItem('rpt_view', reportView); }, [reportView]);

  // Auto-reload last report after page refresh (once reps list is loaded)
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current) return;
    if (mode === 'commercial' && commRepId && commReps.length > 0) {
      autoLoaded.current = true;
      loadCommReport(commRepId);
    } else if (mode === 'scientific' && sciRepId && sciReps.length > 0) {
      autoLoaded.current = true;
      loadSciReport(sciRepId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commReps, sciReps]);

  const loadCommReport = async (repIdOverride?: string) => {
    const id = repIdOverride ?? commRepId;
    if (!id) { setError(t.reports.errSelectComm); return; }
    setError(''); setLoading(true); setCommReport(null); setCommReturnsReport(null);
    try {
      const params = new URLSearchParams();
      if (fromDate)    params.set('startDate', fromDate);
      if (toDate)      params.set('endDate', toDate);
      if (activeFileIds.length > 0) params.set('fileIds', activeFileIds.join(','));

      const parseReport = (d: any): CommReport => ({
        repName:    d.representative?.name ?? '—',
        totalQty:   d.summary?.totalQuantity ?? 0,
        totalValue: d.summary?.totalValue    ?? 0,
        byArea: (d.byArea ?? []).map((r: any) => ({ name: r.areaName ?? r.name, repName: r.repName ?? undefined, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        byItem: (d.byItem ?? []).map((r: any) => ({ name: r.itemName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
      });

      const [salesRes, returnsRes] = await Promise.all([
        fetch(`/api/reports/representative/${id}?${params}&recordType=sale`, { headers: authH() }),
        fetch(`/api/reports/representative/${id}?${params}&recordType=return`, { headers: authH() }),
      ]);
      const [salesJson, returnsJson] = await Promise.all([salesRes.json(), returnsRes.json()]);
      if (!salesRes.ok) throw new Error(salesJson.message || t.reports.errLoad);
      setCommReport(parseReport(salesJson.data ?? salesJson));
      setCommReturnsReport(returnsRes.ok ? parseReport(returnsJson.data ?? returnsJson) : null);
      setReportView('sales');
      setActiveTab('area');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const loadSciReport = async (repIdOverride?: string) => {
    const id = repIdOverride ?? sciRepId;
    if (!id) { setError(t.reports.errSelectSci); return; }
    setError(''); setLoading(true); setSciReport(null); setSciReturnsReport(null);
    try {
      const params = new URLSearchParams();
      if (fromDate)    params.set('startDate', fromDate);
      if (toDate)      params.set('endDate', toDate);
      if (activeFileIds.length > 0) params.set('fileIds', activeFileIds.join(','));

      const parseSciReport = (d: any): SciReport => {
        const salesItems = (d.byItem ?? []).map((r: any) => ({ name: r.itemName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 }));
        const assignedItemsList: Rep[] = d.assignedItems ?? [];
        const salesItemNames = new Set(salesItems.map((r: BreakdownRow) => r.name));
        const zeroItems: BreakdownRow[] = assignedItemsList
          .filter(i => !salesItemNames.has(i.name))
          .map(i => ({ name: i.name, totalQty: 0, totalValue: 0, isZero: true }));

        const salesAreas = (d.byArea ?? []).map((r: any) => ({ name: r.areaName ?? r.name, repName: r.repName ?? undefined, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 }));
        const assignedAreasList: Rep[] = d.assignedAreas ?? [];
        const salesAreaNames = new Set(salesAreas.map((r: BreakdownRow) => r.name));
        const zeroAreas: BreakdownRow[] = assignedAreasList
          .filter(a => !salesAreaNames.has(a.name))
          .map(a => ({ name: a.name, totalQty: 0, totalValue: 0, isZero: true }));

        return {
          repName:    d.scientificRep?.name ?? '—',
          totalQty:   d.summary?.totalQuantity ?? 0,
          totalValue: d.summary?.totalValue    ?? 0,
          assignedAreas:          assignedAreasList,
          assignedItems:          assignedItemsList,
          assignedCommercialReps: d.assignedCommercialReps ?? [],
          byArea: [...salesAreas, ...zeroAreas],
          byItem: [...salesItems, ...zeroItems],
          byRep:  (d.byRep  ?? []).map((r: any) => ({ name: r.repName  ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        };
      };

      const [salesRes, returnsRes] = await Promise.all([
        fetch(`/api/scientific-reps/${id}/report?${params}&recordType=sale`, { headers: authH() }),
        fetch(`/api/scientific-reps/${id}/report?${params}&recordType=return`, { headers: authH() }),
      ]);
      const [salesJson, returnsJson] = await Promise.all([salesRes.json(), returnsRes.json()]);
      if (!salesRes.ok) throw new Error(salesJson.message || t.reports.errLoad);
      setSciReport(parseSciReport(salesJson.data ?? salesJson));
      setSciReturnsReport(returnsRes.ok ? parseSciReport(returnsJson.data ?? returnsJson) : null);
      setReportView('sales');
      setActiveTab('area');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const loadOverallReport = async () => {
    const fid = overallFileId || (activeFileIds.length > 0 ? String(activeFileIds[activeFileIds.length - 1]) : '');
    if (!fid) { setError('يرجى اختيار ملف للتحليل'); return; }
    setError(''); setLoading(true); setOverallSales(null); setOverallReturns(null);
    try {
      const parseOverall = (d: any): OverallReport => ({
        totalQuantity: d.totalQuantity ?? 0,
        totalValue:    d.totalValue    ?? 0,
        byItem: (d.byItem ?? []).map((r: any) => ({ name: r.itemName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        byArea: (d.byArea ?? []).map((r: any) => ({ name: r.areaName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        byAreaItem: (d.byAreaItem ?? []).map((r: any) => ({ areaName: r.areaName ?? '', itemName: r.itemName ?? '', totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        minDate: d.minDate ?? null,
        maxDate: d.maxDate ?? null,
        recordCount: d.recordCount ?? null,
      });
      const params = new URLSearchParams();
      if (fromDate) params.set('startDate', fromDate);
      if (toDate)   params.set('endDate', toDate);
      // Always scope to a single selected file to avoid summing multiple files
      if (overallFileId) {
        params.set('fileIds', overallFileId);
      } else if (activeFileIds.length > 0) {
        params.set('fileIds', String(activeFileIds[activeFileIds.length - 1]));
      }
      const [salesRes, returnsRes] = await Promise.all([
        fetch(`/api/reports/overall?${params}&recordType=sale`,   { headers: authH() }),
        fetch(`/api/reports/overall?${params}&recordType=return`, { headers: authH() }),
      ]);
      const [salesJson, returnsJson] = await Promise.all([salesRes.json(), returnsRes.json()]);
      if (!salesRes.ok) throw new Error(salesJson.message || salesJson.error || 'فشل تحميل البيانات');
      const salesData = salesJson.data ?? salesJson;
      // Auto-populate date inputs from file's actual date range when no filter was set
      if (!fromDate && !toDate) {
        if (salesData.minDate) setFromDate(salesData.minDate.slice(0, 10));
        if (salesData.maxDate) setToDate(salesData.maxDate.slice(0, 10));
      }
      setOverallSales(parseOverall(salesData));
      setOverallReturns(returnsRes.ok ? parseOverall(returnsJson.data ?? returnsJson) : null);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const fmt = (n: number) => Math.round(n || 0).toLocaleString('ar-IQ-u-nu-latn');
  const fmtSigned = (n: number) => (n >= 0 ? '+' : '') + fmt(n);

  // Currency-aware value formatting
  // IQD file → USD display: divide by rate
  // USD file → IQD display: multiply by rate
  // same currency: no change
  const convertVal = (n: number) => {
    const v = n || 0;
    if (fileSourceCurrency === 'IQD' && fileCurrencyMode === 'USD') return v / fileExchangeRate;
    if (fileSourceCurrency === 'USD' && fileCurrencyMode === 'IQD') return v * fileExchangeRate;
    return v;
  };
  const fmtVal = (n: number) => {
    const v = convertVal(n || 0);
    return fileCurrencyMode === 'USD'
      ? Math.round(v).toLocaleString('en-US')
      : Math.round(v).toLocaleString('ar-IQ-u-nu-latn');
  };
  const fmtValSigned = (n: number) => n >= 0 ? `+${fmtVal(Math.abs(n))}` : `-${fmtVal(Math.abs(n))}`;
  const currColHeader  = fileCurrencyMode === 'USD' ? `القيمة ($)` : t.reports.colValDinar;
  const currStatTotal  = fileCurrencyMode === 'USD' ? `إجمالي القيمة ($)` : t.reports.statTotalVal;
  const currStatNet    = fileCurrencyMode === 'USD' ? `صافي القيمة ($)` : t.reports.statNetVal;

  /* ─── Net breakdown table ─── */
  const renderNetTable = (sales: BreakdownRow[], returns: BreakdownRow[], nameLabel: string, hideQtyCols = false, forceMode?: 'qty' | 'value' | 'both') => {
    const hasRep = sales.some(r => r.repName) || returns.some(r => r.repName);
    const rowKey = (r: BreakdownRow) => hasRep ? `${r.name}||${r.repName ?? ''}` : r.name;
    const salesMap  = Object.fromEntries(sales.map(r => [rowKey(r), r]));
    const retMap    = Object.fromEntries(returns.map(r => [rowKey(r), r]));
    // Remove rows where all four values are zero
    const allKeys = [...new Set([...sales.map(rowKey), ...returns.map(rowKey)])].filter(key => {
      const s = salesMap[key]  ?? { totalQty: 0, totalValue: 0 };
      const r = retMap[key]    ?? { totalQty: 0, totalValue: 0 };
      return s.totalQty !== 0 || s.totalValue !== 0 || r.totalQty !== 0 || r.totalValue !== 0;
    });
    // forceMode overrides hideQtyCols
    const effShowQty = forceMode ? (forceMode === 'qty' || forceMode === 'both') : !hideQtyCols;
    const effShowVal = forceMode ? (forceMode === 'value' || forceMode === 'both') : hideQtyCols;
    const colSpanEmpty = (hasRep ? 3 : 2) + 3;
    // Mobile: compact table with all cols visible — no horizontal scroll
    const mobileStyle: React.CSSProperties = {
      fontSize: 11,
      whiteSpace: 'normal',
      wordBreak: 'break-word',
    };
    const thMobile: React.CSSProperties = { fontSize: 10, padding: '5px 4px', whiteSpace: 'nowrap' };
    const tdMobile: React.CSSProperties = { fontSize: 11, padding: '5px 4px', textAlign: 'center' };
    const tdNameMobile: React.CSSProperties = { fontSize: 11, padding: '5px 4px', textAlign: 'right', wordBreak: 'break-word', whiteSpace: 'normal' };
    const tdRepMobile: React.CSSProperties = { fontSize: 10, padding: '5px 3px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1e293b', fontWeight: 600 };
    return (
      <>
      <div style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 22 }} />
            <col />
            {hasRep && <col style={{ width: 50 }} />}
            {effShowQty && <col style={{ width: 44 }} />}
            {effShowVal && <col style={{ width: 56 }} />}
            {effShowQty && <col style={{ width: 44 }} />}
            {effShowVal && <col style={{ width: 56 }} />}
            {effShowQty && <col style={{ width: 48 }} />}
            {effShowVal && <col style={{ width: 56 }} />}
          </colgroup>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ ...thMobile, textAlign: 'center' }}>#</th>
              <th style={{ ...thMobile, textAlign: 'right' }}>{nameLabel}</th>
              {hasRep && <th style={thMobile}>👤</th>}
              {effShowQty && <th style={{ ...thMobile, background: '#dbeafe', color: '#1e40af' }} title={t.reports.colSalesQty}>📈</th>}
              {effShowVal && <th style={{ ...thMobile, background: '#fffbeb', color: '#b45309' }} title={t.reports.colSalesVal}>💰</th>}
              {effShowQty && <th style={{ ...thMobile, background: '#fee2e2', color: '#991b1b' }} title={t.reports.colRetQty}>📉</th>}
              {effShowVal && <th style={{ ...thMobile, background: '#fffbeb', color: '#b45309' }} title={t.reports.colRetVal}>💸</th>}
              {effShowQty && <th style={{ ...thMobile, background: '#d1fae5', color: '#065f46' }} title={t.reports.colNetQty}>✅</th>}
              {effShowVal && <th style={{ ...thMobile, background: '#fffbeb', color: '#b45309' }} title={t.reports.colNetVal}>⚖️</th>}
            </tr>
          </thead>
          <tbody>
            {allKeys.map((key, i) => {
              const s = salesMap[key]  ?? { totalQty: 0, totalValue: 0 };
              const r = retMap[key]    ?? { totalQty: 0, totalValue: 0 };
              const row = salesMap[key] ?? retMap[key];
              const netQty = s.totalQty - r.totalQty;
              const netVal = s.totalValue - r.totalValue;
              return (
                <tr key={key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ ...tdMobile, color: '#94a3b8' }}>{i + 1}</td>
                  <td style={tdNameMobile}><strong>{row.name}</strong></td>
                  {hasRep && <td style={tdRepMobile}>{row.repName ?? '—'}</td>}
                  {effShowQty && <td style={{ ...tdMobile, color: '#1d4ed8' }}>{fmt(s.totalQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, background: '#fffbeb', color: '#92400e' }}>{fmtVal(s.totalValue)}</td>}
                  {effShowQty && <td style={{ ...tdMobile, color: '#dc2626' }}>{fmt(r.totalQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, background: '#fffbeb', color: '#92400e' }}>{fmtVal(r.totalValue)}</td>}
                  {effShowQty && <td style={{ ...tdMobile, fontWeight: 700, color: netQty >= 0 ? '#065f46' : '#991b1b' }}>{fmtSigned(netQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, fontWeight: 700, background: '#fffbeb', color: '#92400e' }}>{fmtValSigned(netVal)}</td>}
                </tr>
              );
            })}
            {allKeys.length === 0 && <tr><td colSpan={colSpanEmpty} className="empty-row">{t.reports.noDataTable}</td></tr>}
            {allKeys.length > 0 && (() => {
              const totSalesQty = sales.reduce((s, r) => s + r.totalQty, 0);
              const totSalesVal = sales.reduce((s, r) => s + r.totalValue, 0);
              const totRetQty   = returns.reduce((s, r) => s + r.totalQty, 0);
              const totRetVal   = returns.reduce((s, r) => s + r.totalValue, 0);
              return (
                <tr style={{ background: effShowVal ? '#fffbeb' : '#f0fdf4', fontWeight: 800, borderTop: '2px solid #86efac' }}>
                  <td style={tdMobile}></td><td style={{ ...tdMobile, textAlign: 'right' }}>{t.reports.totalLabel}</td>
                  {hasRep && <td></td>}
                  {effShowQty && <td style={{ ...tdMobile, color: '#1d4ed8' }}>{fmt(totSalesQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, background: '#fffbeb', color: '#92400e' }}>{fmtVal(totSalesVal)}</td>}
                  {effShowQty && <td style={{ ...tdMobile, color: '#dc2626' }}>{fmt(totRetQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, background: '#fffbeb', color: '#92400e' }}>{fmtVal(totRetVal)}</td>}
                  {effShowQty && <td style={{ ...tdMobile, color: totSalesQty - totRetQty >= 0 ? '#065f46' : '#991b1b' }}>{fmtSigned(totSalesQty - totRetQty)}</td>}
                  {effShowVal && <td style={{ ...tdMobile, fontWeight: 800, background: '#fffbeb', color: '#92400e' }}>{fmtValSigned(totSalesVal - totRetVal)}</td>}
                </tr>
              );
            })()}
          </tbody>
        </table>
      </div>
      </>
    );
  };

  /* ─── Report view toggle ─── */
  const renderViewToggle = (hasSales: boolean, hasReturns: boolean) => (
    <div style={{ display: 'flex', gap: 10, margin: '16px 0 0', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {[
        { key: 'sales'   as ReportView, icon: '�', label: t.reports.colSalesQty, bg: '#3b82f6', glow: '#3b82f644', border: '#1d4ed8' },
        { key: 'returns' as ReportView, icon: '📉', label: t.reports.colRetQty,  bg: '#ef4444', glow: '#ef444444', border: '#b91c1c' },
        { key: 'net'     as ReportView, icon: '⚖️', label: t.reports.viewNet,     bg: '#10b981', glow: '#10b98144', border: '#065f46' },
      ].map(({ key, icon, label, bg, glow, border }) => {
        const isActive = reportView === key;
        const isDisabled = key === 'returns' && !hasReturns;
        return (
          <button
            key={key}
            onClick={() => setReportView(key)}
            disabled={isDisabled}
            title={label + (isDisabled ? ' — لا يوجد بيانات ارجاعات' : '')}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              padding: isActive ? '10px 16px 8px' : '7px 12px 6px',
              borderRadius: 12,
              border: isActive ? `2.5px solid ${border}` : '2.5px solid transparent',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              background: isActive ? bg : '#f1f5f9',
              color: isActive ? '#fff' : '#64748b',
              opacity: isDisabled ? 0.4 : 1,
              boxShadow: isActive ? `0 4px 18px ${glow}, 0 2px 6px ${glow}` : '0 1px 3px #0001',
              transform: isActive ? 'scale(1.12) translateY(-3px)' : 'scale(1)',
              transition: 'all 0.2s cubic-bezier(.34,1.56,.64,1)',
              minWidth: 48,
              position: 'relative',
            }}>
            <span style={{ fontSize: isActive ? 24 : 17, lineHeight: 1, transition: 'font-size 0.2s' }}>{icon}</span>
            <span style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.2, marginTop: 2, opacity: isActive ? 1 : 0.7 }}>{label}</span>
            {isActive && (
              <span style={{
                position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)',
                width: 8, height: 8, borderRadius: '50%', background: border,
                boxShadow: `0 0 6px ${border}`,
              }} />
            )}
          </button>
        );
      })}
      {!hasReturns && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff7ed', border: '1px solid #fed7aa',
          borderRadius: 8, padding: '5px 10px', fontSize: 12, color: '#9a3412',
        }}>
          <span>↩️</span>
          <span>لا يوجد بيانات ارجاعات — ارفع ملف ارجاعات من <strong>رفع الملفات</strong></span>
        </div>
      )}
    </div>
  );

  /* ─── Build sheet AOA from raw sales (shared by doExport + buildPreviewData) ─── */
  const buildSheet = (sales: any[], sciRepName?: string): any[][] => {
    if (sales.length === 0) return [[t.reports.noDataTable]];
    const fmtDateCell = (v: any): any => {
      if (v instanceof Date) return v.toLocaleDateString('en-GB');
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        const d = new Date(v); return isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB');
      }
      if (typeof v === 'number' && v > 25000 && v < 60000) {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB');
      }
      return v;
    };
    const isDateKey = (k: string) => /تاريخ|date/i.test(k);
    const allKeys = new Set<string>();
    let hasRaw = false;
    sales.forEach(s => {
      if (s.rawData) { hasRaw = true; try { Object.keys(JSON.parse(s.rawData)).forEach((k: string) => allKeys.add(k)); } catch {} }
    });
    if (hasRaw && allKeys.size > 0) {
      const headers = [...allKeys];
      const sciCol = sciRepName ? [t.reports.exportColSciRep] : [];
      return [
        [...sciCol, t.reports.exportColRecordType, ...headers],
        ...sales.map(s => {
          let raw: any = {};
          try { if (s.rawData) raw = JSON.parse(s.rawData); } catch {}
          const typeLabel = s.recordType === 'return' ? t.reports.exportTypeReturn : t.reports.exportTypeSales;
          const dataRow = headers.map(h => { const v = raw[h]; if (isDateKey(h)) return fmtDateCell(v); if (typeof v !== 'number') return v ?? ''; const isPriceCol = /سعر|price|value|قيمة|total|مبلغ|cost|ثمن/i.test(h); return Math.round((isPriceCol ? convertVal(v) : v) * 100) / 100; });
          return sciRepName ? [sciRepName, typeLabel, ...dataRow] : [typeLabel, ...dataRow];
        }),
      ];
    }
    const sciCol = sciRepName ? [t.reports.exportColSciRep] : [];
    return [
      [...sciCol, t.reports.exportColRecordType, t.reports.exportColRepName, t.reports.colArea, t.reports.colItem, t.reports.colQty, t.reports.exportColValTotal, t.reports.exportColDate],
      ...sales.map(s => {
        const typeLabel = s.recordType === 'return' ? t.reports.exportTypeReturn : t.reports.exportTypeSales;
        const dataRow = [s.representative?.name ?? '', s.area?.name ?? '', s.item?.name ?? '', Math.round(s.quantity || 0), Math.round(convertVal(s.totalValue || 0)), fmtDateCell(s.saleDate)];
        return sciRepName ? [sciRepName, typeLabel, ...dataRow] : [typeLabel, ...dataRow];
      }),
    ];
  };

  /* ─── Build preview sheets for overall analysis ─── */
  const buildOverallPreviewSheets = (
    visibleAreas: { sales: BreakdownRow[]; returns: BreakdownRow[] },
    visibleItems: { sales: BreakdownRow[]; returns: BreakdownRow[] },
    searchLabel: string,
  ): PreviewSheet[] => {
    if (!overallSales) return [];
    const fileMeta = availableFiles.find(f => String(f.id) === overallFileId);
    const fileName = (fileMeta as any)?.originalName || fileMeta?.filename || `ملف ${overallFileId}`;
    const cur = fileCurrencyMode === 'USD' ? '$' : 'IQD';

    // ── helper: merge sales + returns into combined rows ──
    const mergeRows = (salesRows: BreakdownRow[], retRows: BreakdownRow[]): string[][] => {
      const retMap = Object.fromEntries(retRows.map(r => [r.name, r]));
      const rows = salesRows.map((s, i) => {
        const r = retMap[s.name] ?? { totalQty: 0, totalValue: 0 };
        return [
          String(i + 1), s.name,
          String(Math.round(s.totalQty)), fmtVal(s.totalValue),
          String(Math.round(r.totalQty)), fmtVal(r.totalValue),
          String(Math.round(s.totalQty - r.totalQty)), fmtValSigned(s.totalValue - r.totalValue),
        ];
      });
      // add total row
      const totSQ = salesRows.reduce((a, r) => a + r.totalQty, 0);
      const totSV = salesRows.reduce((a, r) => a + r.totalValue, 0);
      const totRQ = retRows.reduce((a, r) => a + r.totalQty, 0);
      const totRV = retRows.reduce((a, r) => a + r.totalValue, 0);
      rows.push(['', 'الإجمالي', String(Math.round(totSQ)), fmtVal(totSV), String(Math.round(totRQ)), fmtVal(totRV), String(Math.round(totSQ - totRQ)), fmtValSigned(totSV - totRV)]);
      return rows;
    };

    const header = (label: string): string[][] => [[
      '#', label,
      `كمية المبيعات`, `قيمة المبيعات (${cur})`,
      `كمية المرتجعات`, `قيمة المرتجعات (${cur})`,
      `صافي الكمية`, `صافي القيمة (${cur})`,
    ]];

    const isFiltered = searchLabel.trim() !== '';

    // ── Sheet 1: Summary ──
    const summaryRows: string[][] = [
      ['الملف', fileName],
      ['الفترة', fromDate && toDate ? `${fromDate} → ${toDate}` : fromDate || toDate || 'كل الفترات'],
      ...(isFiltered ? [['فلتر البحث', searchLabel]] : []),
      [''],
      ['إجمالي الكميات المباعة', String(Math.round(isFiltered ? visibleAreas.sales.reduce((a,r)=>a+r.totalQty,0)+visibleItems.sales.reduce((a,r)=>a+r.totalQty,0) : overallSales.totalQuantity))],
      ['إجمالي الكميات المرتجعة', String(Math.round(isFiltered ? visibleAreas.returns.reduce((a,r)=>a+r.totalQty,0)+visibleItems.returns.reduce((a,r)=>a+r.totalQty,0) : (overallReturns?.totalQuantity ?? 0)))],
      ['إجمالي قيمة المبيعات', fmtVal(isFiltered ? visibleAreas.sales.reduce((a,r)=>a+r.totalValue,0)+visibleItems.sales.reduce((a,r)=>a+r.totalValue,0) : overallSales.totalValue)],
      ['إجمالي قيمة المرتجعات', fmtVal(isFiltered ? visibleAreas.returns.reduce((a,r)=>a+r.totalValue,0)+visibleItems.returns.reduce((a,r)=>a+r.totalValue,0) : (overallReturns?.totalValue ?? 0))],
    ];

    // ── Sheet 2: By Area (visible) ──
    const areaRows = mergeRows(visibleAreas.sales, visibleAreas.returns);

    // ── Sheet 3: By Item (visible) ──
    const itemRows = mergeRows(visibleItems.sales, visibleItems.returns);

    const sheets: PreviewSheet[] = [
      { name: 'ملخص', rows: summaryRows },
      { name: 'حسب المنطقة', rows: [...header('المنطقة'), ...areaRows] },
      { name: 'حسب المادة', rows: [...header('المادة'), ...itemRows] },
    ];

    // ── Sheet 4: Area × Item breakdown — only when no search filter ──
    if (!isFiltered) {
      const areaItemHeader: string[][] = [['#', 'المنطقة', 'المادة', `كمية المبيعات`, `قيمة المبيعات (${cur})`, `كمية المرتجعات`, `قيمة المرتجعات (${cur})`, `صافي الكمية`, `صافي القيمة (${cur})`]];
      const retAIMap = Object.fromEntries((overallReturns?.byAreaItem ?? []).map(r => [`${r.areaName}::${r.itemName}`, r]));
      const areaItemRows: string[][] = overallSales.byAreaItem.map((s, i) => {
        const r = retAIMap[`${s.areaName}::${s.itemName}`] ?? { totalQty: 0, totalValue: 0 };
        return [String(i + 1), s.areaName, s.itemName, String(Math.round(s.totalQty)), fmtVal(s.totalValue), String(Math.round(r.totalQty)), fmtVal(r.totalValue), String(Math.round(s.totalQty - r.totalQty)), fmtValSigned(s.totalValue - r.totalValue)];
      });
      sheets.push({ name: 'تفصيل منطقة × مادة', rows: [...areaItemHeader, ...areaItemRows] });
    }

    return sheets;
  };

  /* ─── Build preview sheets (same data as export, returned as AOA) ─── */
  const buildPreviewData = async (): Promise<PreviewSheet[]> => {
    const qp = new URLSearchParams();
    if (fromDate)    qp.set('startDate', fromDate);
    if (toDate)      qp.set('endDate',   toDate);
    if (activeFileIds.length > 0) qp.set('fileIds', activeFileIds.join(','));
    const qStr = qp.toString();

    const result: PreviewSheet[] = [];
    const summaryData: string[][] = [
      ['#', t.reports.exportSumType, t.reports.exportColRepName, t.reports.exportSumTotalQty, t.reports.exportSumTotalVal]
    ];
    let idx = 1;

    for (const repId of Array.from(selCommIds)) {
      const rep = commReps.find(r => r.id === repId);
      const repName = rep?.name ?? `${t.reports.exportCommType} ${repId}`;
      const res  = await fetch(`/api/export/raw-sales?commRepIds=${repId}&${qStr}`, { headers: authH() });
      const json = await res.json();
      const sales: any[] = json.data ?? [];
      const netQty = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.quantity   || 0) : s + (r.quantity   || 0), 0);
      const netVal = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.totalValue || 0) : s + (r.totalValue || 0), 0);
      summaryData.push([String(idx++), t.reports.exportCommType, repName, String(Math.round(netQty)), String(Math.round(convertVal(netVal)))]);
      const rows = buildSheet(sales);
      result.push({ name: `${t.reports.exportCommPrefix}-${repName}`.slice(0, 31), rows: rows.map(r => r.map(v => String(v ?? ''))) });
    }

    for (const repId of Array.from(selSciIds)) {
      const rep = sciReps.find(r => r.id === repId);
      const rRes  = await fetch(`/api/scientific-reps/${repId}/report?${qStr}`, { headers: authH() });
      const rJson = await rRes.json();
      const d = rJson.data ?? rJson;
      const sciName       = d.scientificRep?.name ?? rep?.name ?? `${t.reports.exportSciType} ${repId}`;
      const assignedIds: number[] = (d.assignedCommercialReps ?? []).map((r: any) => r.id).filter(Boolean);
      let sales2: any[] = [];
      if (assignedIds.length > 0) {
        const sRes  = await fetch(`/api/export/raw-sales?commRepIds=${assignedIds.join(',')}&sciRepId=${repId}&${qStr}`, { headers: authH() });
        const sJson = await sRes.json();
        sales2 = sJson.data ?? [];
      }
      const netQty2 = sales2.reduce((s, r) => r.recordType === 'return' ? s - (r.quantity   || 0) : s + (r.quantity   || 0), 0);
      const netVal2 = sales2.reduce((s, r) => r.recordType === 'return' ? s - (r.totalValue || 0) : s + (r.totalValue || 0), 0);
      summaryData.push([String(idx++), t.reports.exportSciType, sciName, String(Math.round(netQty2)), String(Math.round(convertVal(netVal2)))]);
      const rows = buildSheet(sales2, sciName);
      result.push({ name: `${t.reports.exportSciPrefix}-${sciName}`.slice(0, 31), rows: rows.map(r => r.map(v => String(v ?? ''))) });
    }

    if (summaryData.length > 1) {
      const gQty = summaryData.slice(1).reduce((s, r) => s + Number(r[3] || 0), 0);
      const gVal = summaryData.slice(1).reduce((s, r) => s + Number(r[4] || 0), 0);
      summaryData.push(['', t.reports.exportGrandTotal, '', String(gQty), String(gVal)]);
    }
    result.unshift({ name: t.reports.exportSummarySheet, rows: summaryData });
    return result;
  };

  /* ─── Export with rep selection ─── */
  const doExport = async () => {
    if (selCommIds.size === 0 && selSciIds.size === 0) {
      setError(t.reports.exportSelectError); return;
    }
    setShowExportModal(false);
    setExporting(true);
    setExportProgress(t.reports.exportPreparing);
    try {
      const wb = XLSX.utils.book_new();

      const qp = new URLSearchParams();
      if (fromDate)    qp.set('startDate', fromDate);
      if (toDate)      qp.set('endDate',   toDate);
      if (activeFileIds.length > 0) qp.set('fileIds', activeFileIds.join(','));
      const qStr = qp.toString();

      const addSheet = (name: string, rows: any[][]) => {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if (rows[0]) ws['!cols'] = rows[0].map(() => ({ wch: 22 }));
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      };

      const summaryData: any[][] = [
        ['#', t.reports.exportSumType, t.reports.exportColRepName, t.reports.exportSumTotalQty, t.reports.exportSumTotalVal]
      ];
      let idx = 1;

      // ── Commercial reps ───────────────────────────────
      for (const repId of Array.from(selCommIds)) {
        const rep = commReps.find(r => r.id === repId);
        const repName = rep?.name ?? `${t.reports.exportCommType} ${repId}`;
        setExportProgress(`${t.reports.exportProgressMsg}: ${repName}...`);
        const res  = await fetch(`/api/export/raw-sales?commRepIds=${repId}&${qStr}`, { headers: authH() });
        const json = await res.json();
        const sales: any[] = json.data ?? [];
        const netQty = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.quantity   || 0) : s + (r.quantity   || 0), 0);
        const netVal = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.totalValue || 0) : s + (r.totalValue || 0), 0);
        summaryData.push([idx++, t.reports.exportCommType, repName, Math.round(netQty), Math.round(convertVal(netVal))]);
        addSheet(`${t.reports.exportCommPrefix}-${repName}`, buildSheet(sales));  // no sciRepName for commercial
      }

      // ── Scientific reps (show sales of their assigned commercial reps) ─
      for (const repId of Array.from(selSciIds)) {
        const rep = sciReps.find(r => r.id === repId);
        setExportProgress(`${t.reports.exportProgressMsg}: ${rep?.name ?? repId}...`);
        const rRes  = await fetch(`/api/scientific-reps/${repId}/report?${qStr}`, { headers: authH() });
        const rJson = await rRes.json();
        const d = rJson.data ?? rJson;
        const sciName       = d.scientificRep?.name ?? rep?.name ?? `${t.reports.exportSciType} ${repId}`;
        const assignedIds: number[] = (d.assignedCommercialReps ?? []).map((r: any) => r.id).filter(Boolean);
        let sales: any[] = [];
        if (assignedIds.length > 0) {
          const sRes  = await fetch(`/api/export/raw-sales?commRepIds=${assignedIds.join(',')}&sciRepId=${repId}&${qStr}`, { headers: authH() });
          const sJson = await sRes.json();
          sales = sJson.data ?? [];
        }
        const netQty = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.quantity   || 0) : s + (r.quantity   || 0), 0);
        const netVal = sales.reduce((s, r) => r.recordType === 'return' ? s - (r.totalValue || 0) : s + (r.totalValue || 0), 0);
        summaryData.push([idx++, t.reports.exportSciType, sciName, Math.round(netQty), Math.round(convertVal(netVal))]);
        addSheet(`${t.reports.exportSciPrefix}-${sciName}`, buildSheet(sales, sciName));  // pass sciRepName
      }

      // ── Grand total row ──────────────────────────────
      if (summaryData.length > 1) {
        const gQty = summaryData.slice(1).reduce((s, r) => s + (r[3] || 0), 0);
        const gVal = summaryData.slice(1).reduce((s, r) => s + (r[4] || 0), 0);
        summaryData.push(['', t.reports.exportGrandTotal, '', gQty, gVal]);
      }

      // ── Add summary sheet FIRST ─────────────────────────
      const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
      summaryWs['!cols'] = [{ wch: 4 }, { wch: 10 }, { wch: 30 }, { wch: 18 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, summaryWs, t.reports.exportSummarySheet);
      // Move summary to front
      const si = wb.SheetNames.indexOf(t.reports.exportSummarySheet);
      if (si > 0) { wb.SheetNames.splice(si, 1); wb.SheetNames.unshift(t.reports.exportSummarySheet); }

      setExportProgress(t.reports.exportSavingFile);
      XLSX.writeFile(wb, `${t.reports.exportFileName}_${new Date().toISOString().slice(0,10)}.xlsx`);
    } catch (e: any) {
      setError(t.reports.exportFailed + e.message);
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  };

  const renderBreakdownTable = (rows: BreakdownRow[], totalValue: number, nameLabel: string, hideQtyCols = false, forceMode?: 'qty' | 'value') => {
    const hasRep   = rows.some(r => r.repName);
    const salesRows = rows.filter(r => !r.isZero);
    const zeroRows  = rows.filter(r => r.isZero);
    const effShowQtyBD = forceMode ? forceMode === 'qty' : !hideQtyCols;
    const effShowValBD = forceMode ? forceMode === 'value' : hideQtyCols;
    const colCount = hasRep ? 4 : 3;
    const thBD: React.CSSProperties = { fontSize: 11, padding: '6px 5px', whiteSpace: 'nowrap' };
    const tdBD: React.CSSProperties = { fontSize: 12, padding: '6px 5px', textAlign: 'center' };
    const tdNameBD: React.CSSProperties = { fontSize: 12, padding: '6px 5px', wordBreak: 'break-word', whiteSpace: 'normal' };
    const tdRepBD: React.CSSProperties = { fontSize: 11, padding: '6px 4px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#4f46e5', fontWeight: 600 };
    return (
    <>
    <div style={{ overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 26 }} />
          <col />
          {hasRep && <col style={{ width: 60 }} />}
          {effShowQtyBD && <col style={{ width: 64 }} />}
          {effShowValBD && <col style={{ width: 80 }} />}
        </colgroup>
        <thead>
          <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
            <th style={{ ...thBD, textAlign: 'center', color: '#94a3b8' }}>#</th>
            <th style={{ ...thBD, textAlign: 'right' }}>{nameLabel}</th>
            {hasRep && <th style={{ ...thBD, textAlign: 'center' }}>👤</th>}
            {effShowQtyBD && <th style={{ ...thBD, background: '#dbeafe', color: '#1e40af' }}>{t.reports.colQty}</th>}
            {effShowValBD && <th style={{ ...thBD, background: '#fffbeb', color: '#b45309' }}>{currColHeader}</th>}
          </tr>
        </thead>
        <tbody>
          {salesRows.map((row, i) => {
            return (
              <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ ...tdBD, color: '#94a3b8' }}>{i + 1}</td>
                <td style={tdNameBD}><strong>{row.name}</strong></td>
                {hasRep && <td style={tdRepBD}>{row.repName ?? '—'}</td>}
                {effShowQtyBD && <td style={{ ...tdBD, color: '#1d4ed8' }}>{fmt(row.totalQty)}</td>}
                {effShowValBD && <td style={{ ...tdBD, background: '#fffbeb', color: '#92400e' }}>{fmtVal(row.totalValue)}</td>}
              </tr>
            );
          })}
          {salesRows.length === 0 && zeroRows.length === 0 && (
            <tr><td colSpan={colCount} style={{ textAlign: 'center', color: '#94a3b8', padding: '20px 8px', fontSize: 12 }}>{t.reports.noDataTable}</td></tr>
          )}

          {/* ─── Zero-sales divider row ─── */}
          {zeroRows.length > 0 && (
            <tr>
              <td colSpan={colCount} style={{
                padding: '10px 16px',
                background: 'linear-gradient(90deg, #f8fafc 0%, #f1f5f9 100%)',
                borderTop: '2px dashed #cbd5e1',
                borderBottom: '2px dashed #cbd5e1',
                color: '#64748b',
                fontSize: '12px',
                fontWeight: 700,
                textAlign: 'center',
                letterSpacing: '0.05em',
              }}>
                ⚠️ {t.reports.zeroItemsMsg} — {zeroRows.length} {t.reports.zeroItemsUnit}
              </td>
            </tr>
          )}
          {zeroRows.map((row, i) => (
            <tr key={`zero-${i}`} style={{ background: '#fafafa', opacity: 0.75, borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ ...tdBD, color: '#94a3b8' }}>{salesRows.length + i + 1}</td>
              <td style={tdNameBD}>
                <span style={{ color: '#475569', fontWeight: 500 }}>{row.name}</span>
                <span style={{ marginRight: '4px', fontSize: '10px', background: '#fee2e2', color: '#dc2626', borderRadius: '4px', padding: '1px 4px', fontWeight: 600 }}>
                  {t.reports.noSalesLabel}
                </span>
              </td>
              {hasRep && <td style={{ ...tdRepBD, color: '#94a3b8', fontWeight: 400 }}>—</td>}
              {effShowQtyBD && <td style={{ ...tdBD, color: '#94a3b8' }}>0</td>}
              {effShowValBD && <td style={{ ...tdBD, color: '#94a3b8' }}>0</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <div />
        <button
          onClick={() => setShowExportModal(true)}
          disabled={exporting}
          title={exporting ? exportProgress : t.reports.export}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 42, height: 42, borderRadius: '10px', border: 'none', cursor: exporting ? 'not-allowed' : 'pointer',
            background: exporting ? '#d1fae5' : 'linear-gradient(135deg,#10b981,#059669)',
            color: '#fff', fontWeight: 700, fontSize: '20px',
            boxShadow: exporting ? 'none' : '0 2px 8px rgba(16,185,129,.35)',
            transition: 'all .2s',
            opacity: exporting ? 0.75 : 1,
          }}
        >
          {exporting ? '⏳' : '📥'}
        </button>
      </div>

      {/* Mode toggle */}
      <div className="tabs" style={{ marginBottom: 0 }}>
        <button className={`tab ${mode === 'overall' ? 'tab--active' : ''}`} onClick={() => { setMode('overall'); setError(''); setOverallSales(null); setOverallReturns(null); }}>
          📊 تحليل شامل
        </button>
        <button className={`tab ${mode === 'scientific' ? 'tab--active' : ''}`} onClick={() => { setMode('scientific'); setError(''); setSciReport(null); }}>
          🔬 {t.reports.modeScientific}
        </button>
        <button className={`tab ${mode === 'commercial' ? 'tab--active' : ''}`} onClick={() => { setMode('commercial'); setError(''); setCommReport(null); }}>
          💰 {t.reports.modeCommercial}
        </button>
      </div>

      {/* Filters Card */}
      <div className="filter-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>

          {/* Rep selector — hidden in overall mode */}
          {mode === 'commercial' ? (
            <select className="form-input" style={{ flex: '1 1 160px', maxWidth: 280 }} value={commRepId}
              onChange={e => { setCommRepId(e.target.value); if (e.target.value) loadCommReport(e.target.value); }}>
              <option value="">-- {t.reports.selectCommRep} --</option>
              {commReps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ) : mode === 'scientific' ? (
            <select className="form-input" style={{ flex: '1 1 160px', maxWidth: 280 }} value={sciRepId}
              onChange={e => { setSciRepId(e.target.value); if (e.target.value) loadSciReport(e.target.value); }}>
              <option value="">-- {t.reports.selectSciRep} --</option>
              {sciReps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ) : (
            /* Overall mode: file selector */
            <select className="form-input" style={{ flex: '1 1 200px', maxWidth: 340 }} value={overallFileId}
              onChange={e => { setOverallFileId(e.target.value); setOverallSales(null); setOverallReturns(null); }}>
              <option value="">-- اختر ملف للتحليل --</option>
              {availableFiles.map(f => (
                <option key={f.id} value={f.id}>
                  {f.filename}{f.rowCount != null ? ` (صفوف: ${f.rowCount.toLocaleString()})` : ''}{f.uploadedAt ? ` — ${new Date(f.uploadedAt).toLocaleDateString('ar-IQ')}` : ''}
                </option>
              ))}
            </select>
          )}

          {/* Combined date range block — icon only, hidden inputs */}
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            <label
              title={fromDate && toDate ? `${fromDate} → ${toDate}` : fromDate ? `من ${fromDate}` : toDate ? `إلى ${toDate}` : `${t.reports.fromDate} / ${t.reports.toDate}`}
              style={{
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: (fromDate || toDate) ? '#6366f1' : '#f1f5f9',
                border: `1.5px solid ${(fromDate || toDate) ? '#6366f1' : '#e2e8f0'}`,
                boxShadow: (fromDate || toDate) ? '0 2px 8px #6366f144' : 'none',
                fontSize: 20, transition: 'all 0.2s',
              }}
            >
              📅
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
            </label>
            {(fromDate || toDate) && (
              <span onClick={() => { setFromDate(''); setToDate(''); }}
                style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#ef4444', color: '#fff', fontSize: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', fontWeight: 700, lineHeight: 1,
                }}>✕</span>
            )}
          </div>
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            <label
              title={toDate || t.reports.toDate}
              style={{
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: toDate ? '#6366f1' : '#f1f5f9',
                border: `1.5px solid ${toDate ? '#6366f1' : '#e2e8f0'}`,
                boxShadow: toDate ? '0 2px 8px #6366f144' : 'none',
                fontSize: 20, transition: 'all 0.2s',
              }}
            >
              📅
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
            </label>
          </div>

          {/* Generate icon button */}
          <button
            title={t.reports.generate}
            onClick={() => mode === 'commercial' ? loadCommReport() : mode === 'scientific' ? loadSciReport() : loadOverallReport()}
            disabled={loading}
            style={{
              width: 40, height: 40, borderRadius: 10, border: 'none', flexShrink: 0,
              background: loading ? '#a5b4fc' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
              color: '#fff', fontSize: 20, cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px #6366f144', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? '⏳' : '🔍'}
          </button>

        </div>
      </div>

      {error && (
        <div style={{
          background: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
          borderLeft: '4px solid #f43f5e',
          borderRadius: '0 14px 14px 0',
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 4px 20px rgba(244,63,94,0.12)',
          marginBottom: 4,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: '#fecdd3',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
          }}>⚠️</div>
          <span style={{ flex: 1, color: '#881337', fontSize: 13, fontWeight: 500 }}>{error}</span>
        </div>
      )}

      {/* ─── Overall / Comprehensive Analysis ─── */}
      {mode === 'overall' && overallSales && (() => {
        const salesQ  = overallSales.totalQuantity;
        const salesV  = overallSales.totalValue;
        const retQ    = overallReturns?.totalQuantity ?? 0;
        const retV    = overallReturns?.totalValue    ?? 0;
        const netQ    = salesQ - retQ;
        const netV    = salesV - retV;

        const handleOverallPreview = () => {
          const sheets = buildOverallPreviewSheets(
            { sales: salesAreasFiltered, returns: retAreasFiltered },
            { sales: salesItemsFiltered, returns: retItemsFiltered },
            overallSearch.trim(),
          );
          setPreviewSheets(sheets);
          setShowPreviewModal(true);
        };

        // Smart search filter (normalises Arabic)
        const normalise = (s: string) => s.trim()
          .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
          .replace(/\u0629/g, '\u0647')
          .replace(/\u0640/g, '')
          .replace(/[\u064B-\u065F]/g, '')
          .replace(/\s+/g, ' ')
          .toLowerCase();

        const hasTags = overallSelectedTags.length > 0;
        const tagItemNorms = overallSelectedTags.filter(t => t.type === 'item').map(t => normalise(t.name));
        const tagAreaNorms = overallSelectedTags.filter(t => t.type === 'area').map(t => normalise(t.name));

        // Text query — only active when no tags selected
        const q = hasTags ? '' : normalise(overallSearch);
        const filterRowsByText = (rows: BreakdownRow[]) =>
          q ? rows.filter(r => normalise(r.name).includes(q)) : rows;

        const allAreas = [...overallSales.byArea, ...(overallReturns?.byArea ?? [])];
        const areaMatch = !hasTags && q ? allAreas.some(a => normalise(a.name).includes(q)) : false;
        const itemMatch = !hasTags && q ? [...overallSales.byItem, ...(overallReturns?.byItem ?? [])].some(i => normalise(i.name).includes(q)) : false;

        // Single-text helpers (used in text mode)
        const buildItemsFromArea = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r => normalise(r.areaName).includes(q));
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.itemName)) map.set(r.itemName, { name: r.itemName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.itemName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };
        const buildAreasFromItem = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r => normalise(r.itemName).includes(q));
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.areaName)) map.set(r.areaName, { name: r.areaName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.areaName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };

        // Multi-tag helpers (used in tag mode)
        const buildAreasFromTagItems = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r => tagItemNorms.some(ni => normalise(r.itemName).includes(ni)));
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.areaName)) map.set(r.areaName, { name: r.areaName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.areaName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };
        const buildItemsFromTagAreas = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r => tagAreaNorms.some(na => normalise(r.areaName).includes(na)));
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.itemName)) map.set(r.itemName, { name: r.itemName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.itemName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };
        // Both item+area tags → intersection from byAreaItem
        const buildAreasFromBoth = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r =>
            tagAreaNorms.some(na => normalise(r.areaName).includes(na)) &&
            tagItemNorms.some(ni => normalise(r.itemName).includes(ni))
          );
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.areaName)) map.set(r.areaName, { name: r.areaName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.areaName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };
        const buildItemsFromBoth = (byAreaItem: AreaItemRow[]): BreakdownRow[] => {
          const filtered = byAreaItem.filter(r =>
            tagAreaNorms.some(na => normalise(r.areaName).includes(na)) &&
            tagItemNorms.some(ni => normalise(r.itemName).includes(ni))
          );
          const map = new Map<string, BreakdownRow>();
          for (const r of filtered) {
            if (!map.has(r.itemName)) map.set(r.itemName, { name: r.itemName, totalQty: 0, totalValue: 0 });
            const row = map.get(r.itemName)!; row.totalQty += r.totalQty; row.totalValue += r.totalValue;
          }
          return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
        };

        const bothTags = hasTags && tagItemNorms.length > 0 && tagAreaNorms.length > 0;

        // Area tab filtering
        const salesAreasFiltered = bothTags
          ? buildAreasFromBoth(overallSales.byAreaItem)
          : hasTags && tagItemNorms.length > 0
            ? buildAreasFromTagItems(overallSales.byAreaItem)
            : hasTags && tagAreaNorms.length > 0
              ? overallSales.byArea.filter(r => tagAreaNorms.some(na => normalise(r.name).includes(na)))
              : (overallTab === 'area' && itemMatch && !areaMatch)
                ? buildAreasFromItem(overallSales.byAreaItem)
                : filterRowsByText(overallSales.byArea);
        const retAreasFiltered = bothTags
          ? buildAreasFromBoth(overallReturns?.byAreaItem ?? [])
          : hasTags && tagItemNorms.length > 0
            ? buildAreasFromTagItems(overallReturns?.byAreaItem ?? [])
            : hasTags && tagAreaNorms.length > 0
              ? (overallReturns?.byArea ?? []).filter(r => tagAreaNorms.some(na => normalise(r.name).includes(na)))
              : (overallTab === 'area' && itemMatch && !areaMatch)
                ? buildAreasFromItem(overallReturns?.byAreaItem ?? [])
                : filterRowsByText(overallReturns?.byArea ?? []);

        // Item tab filtering
        const salesItemsFiltered = bothTags
          ? buildItemsFromBoth(overallSales.byAreaItem)
          : hasTags && tagAreaNorms.length > 0
            ? buildItemsFromTagAreas(overallSales.byAreaItem)
            : hasTags && tagItemNorms.length > 0
              ? overallSales.byItem.filter(r => tagItemNorms.some(ni => normalise(r.name).includes(ni)))
              : (overallTab === 'item' && areaMatch && !itemMatch)
                ? buildItemsFromArea(overallSales.byAreaItem)
                : filterRowsByText(overallSales.byItem);
        const retItemsFiltered = bothTags
          ? buildItemsFromBoth(overallReturns?.byAreaItem ?? [])
          : hasTags && tagAreaNorms.length > 0
            ? buildItemsFromTagAreas(overallReturns?.byAreaItem ?? [])
            : hasTags && tagItemNorms.length > 0
              ? (overallReturns?.byItem ?? []).filter(r => tagItemNorms.some(ni => normalise(r.name).includes(ni)))
              : (overallTab === 'item' && areaMatch && !itemMatch)
                ? buildItemsFromArea(overallReturns?.byAreaItem ?? [])
                : filterRowsByText(overallReturns?.byItem ?? []);

        return (
          <>
            {/* Summary cards — mobile-optimised layout */}
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              {/* Qty row: sales + returns side by side, net centered below */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="stat-card" style={{ borderTop: '4px solid #10b981', margin: 0 }}>
                  <div className="stat-card-icon" style={{ background: '#d1fae5', color: '#10b981', fontSize: 18 }}>📈</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: '#065f46', fontSize: 18 }}>{fmt(salesQ)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>كمية المبيع</div>
                    {overallSales.recordCount != null && <div style={{ fontSize: 10, color: '#6b7280' }}>{overallSales.recordCount.toLocaleString()} سجل</div>}
                  </div>
                </div>
                <div className="stat-card" style={{ borderTop: '4px solid #ef4444', margin: 0 }}>
                  <div className="stat-card-icon" style={{ background: '#fee2e2', color: '#ef4444', fontSize: 18 }}>📉</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: '#991b1b', fontSize: 18 }}>{fmt(retQ)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>كمية الارجاع</div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                <div className="stat-card" style={{ borderTop: '4px solid #6366f1', margin: 0, minWidth: 160 }}>
                  <div className="stat-card-icon" style={{ background: '#e0e7ff', color: '#6366f1', fontSize: 18 }}>✅</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: netQ >= 0 ? '#065f46' : '#991b1b', fontSize: 20 }}>{fmtSigned(netQ)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>صافي الكميات</div>
                  </div>
                </div>
              </div>
              {/* Divider */}
              <div style={{ borderTop: '2px dashed #e2e8f0', margin: '10px 0' }} />
              {/* Value row: sales + returns side by side, net centered below */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="stat-card" style={{ borderTop: '4px solid #f59e0b', margin: 0 }}>
                  <div className="stat-card-icon" style={{ background: '#fffbeb', color: '#b45309', fontSize: 18 }}>💰</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: '#92400e', fontSize: 16 }}>{fmtVal(salesV)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>قيمة المبيع</div>
                  </div>
                </div>
                <div className="stat-card" style={{ borderTop: '4px solid #ef4444', margin: 0 }}>
                  <div className="stat-card-icon" style={{ background: '#fee2e2', color: '#ef4444', fontSize: 18 }}>💸</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: '#991b1b', fontSize: 16 }}>{fmtVal(retV)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>قيمة الارجاع</div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                <div className="stat-card" style={{ borderTop: '4px solid #10b981', margin: 0, minWidth: 160 }}>
                  <div className="stat-card-icon" style={{ background: '#d1fae5', color: '#10b981', fontSize: 18 }}>⚖️</div>
                  <div className="stat-card-body">
                    <div className="stat-card-value" style={{ color: netV >= 0 ? '#065f46' : '#991b1b', fontSize: 20 }}>{fmtValSigned(netV)}</div>
                    <div className="stat-card-label" style={{ fontSize: 11 }}>{currStatNet}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Smart search with suggestions + multi-select chips */}
            {(() => {
              const allSuggItems = [...new Set([...overallSales.byItem, ...(overallReturns?.byItem ?? [])].map(i => i.name))];
              const allSuggAreas = [...new Set([...overallSales.byArea, ...(overallReturns?.byArea ?? [])].map(a => a.name))];
              const normaliseS = (s: string) => s.trim().replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627').replace(/\u0629/g, '\u0647').replace(/\u0640/g, '').replace(/[\u064B-\u065F]/g, '').replace(/\s+/g, ' ').toLowerCase();
              const sq = normaliseS(overallSearch);
              const alreadySelected = new Set(overallSelectedTags.map(t => t.type + t.name));
              const suggestions: { name: string; type: 'item' | 'area' }[] = !sq ? [] : [
                ...allSuggItems.filter(n => normaliseS(n).includes(sq) && !alreadySelected.has('item' + n)).slice(0, 6).map(n => ({ name: n, type: 'item' as const })),
                ...allSuggAreas.filter(n => normaliseS(n).includes(sq) && !alreadySelected.has('area' + n)).slice(0, 4).map(n => ({ name: n, type: 'area' as const })),
              ].slice(0, 8);
              return (
                <div style={{ margin: '12px 0 6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
                      <input
                        className="form-input"
                        style={{ width: '100%' }}
                        placeholder="🔍 بحث ذكي عن مادة أو منطقة..."
                        value={overallSearch}
                        onChange={e => { setOverallSearch(e.target.value); setOverallSuggOpen(true); }}
                        onFocus={() => setOverallSuggOpen(true)}
                        onBlur={() => setTimeout(() => setOverallSuggOpen(false), 150)}
                      />
                      {overallSuggOpen && suggestions.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 4, overflow: 'hidden' }}>
                          {suggestions.map(s => (
                            <div
                              key={s.type + s.name}
                              style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                            >
                              {/* Blue zone: add tag but keep dropdown open */}
                              <div
                                title="اضغط لإضافة والإبقاء على القائمة"
                                onMouseDown={e => {
                                  e.preventDefault(); // prevent input blur → keeps dropdown open
                                  setOverallSelectedTags(prev => [...prev, s]);
                                  // do NOT clear search → suggestions stay visible
                                }}
                                style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, borderLeft: '2px solid #bfdbfe', background: 'inherit' }}
                              >
                                <span style={{ fontSize: 15 }}>{s.type === 'item' ? '💊' : '📍'}</span>
                                <span style={{ fontSize: 11, color: '#94a3b8', userSelect: 'none' }}>{s.type === 'item' ? 'مادة' : 'منطقة'}</span>
                              </div>
                              {/* Red zone: add tag and close dropdown */}
                              <div
                                title="اضغط للاختيار وإغلاق القائمة"
                                onMouseDown={() => {
                                  setOverallSelectedTags(prev => [...prev, s]);
                                  setOverallSearch('');
                                  setOverallSuggOpen(false);
                                }}
                                style={{ flex: 1, padding: '8px 14px 8px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', background: 'inherit' }}
                              >
                                <span style={{ color: s.type === 'item' ? '#7c3aed' : '#0369a1', fontWeight: 600 }}>{s.name}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {overallSearch && (
                      <button onClick={() => { setOverallSearch(''); setOverallSuggOpen(false); }}
                        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f1f5f9', cursor: 'pointer', fontSize: 12, color: '#64748b' }}>
                        ✕ مسح
                      </button>
                    )}
                    <button
                      onClick={handleOverallPreview}
                      title="معاينة وتصدير التحليلات إلى Excel"
                      style={{ padding: '6px 14px', borderRadius: 8, border: '1.5px solid #10b981', background: '#f0fdf4', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#065f46', display: 'flex', alignItems: 'center', gap: 6 }}>
                      📊 تصدير
                    </button>
                  </div>
                  {/* Selected tags chips */}
                  {overallSelectedTags.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                      {overallSelectedTags.map(tag => (
                        <span key={tag.type + tag.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: tag.type === 'item' ? '#ede9fe' : '#e0f2fe', color: tag.type === 'item' ? '#7c3aed' : '#0369a1', borderRadius: 20, padding: '3px 8px 3px 10px', fontSize: 12, fontWeight: 600 }}>
                          {tag.type === 'item' ? '💊' : '📍'} {tag.name}
                          <button
                            onClick={() => setOverallSelectedTags(prev => prev.filter(t => !(t.name === tag.name && t.type === tag.type)))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 0 0 2px', fontSize: 14, lineHeight: 1, opacity: 0.7 }}
                          >×</button>
                        </span>
                      ))}
                      <button
                        onClick={() => setOverallSelectedTags([])}
                        style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: '1px solid #e2e8f0', borderRadius: 20, padding: '2px 10px', cursor: 'pointer' }}
                      >
                        مسح الكل
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Sub-tabs: area / item */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div className="tabs" style={{ margin: 0 }}>
                <button className={`tab ${overallTab === 'area' ? 'tab--active' : ''}`} onClick={() => setOverallTab('area')}>📍 {t.reports.colArea}</button>
                <button className={`tab ${overallTab === 'item' ? 'tab--active' : ''}`} onClick={() => setOverallTab('item')}>💊 {t.reports.colItem}</button>
              </div>
              {/* View mode toggle: qty ↔ value */}
              <button onClick={() => setOverallViewMode(v => v === 'qty' ? 'value' : 'qty')}
                style={{ padding: '5px 14px', borderRadius: 8, border: `1.5px solid ${overallViewMode === 'qty' ? '#3b82f6' : '#f59e0b'}`, background: overallViewMode === 'qty' ? '#eff6ff' : '#fffbeb', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: overallViewMode === 'qty' ? '#1e40af' : '#b45309' }}>
                {overallViewMode === 'qty' ? '🔢 كمية' : '💰 قيمة'}
              </button>
            </div>

            {overallTab === 'area' && renderNetTable(salesAreasFiltered, retAreasFiltered, t.reports.colArea, false, overallViewMode)}
            {overallTab === 'item' && renderNetTable(salesItemsFiltered, retItemsFiltered, t.reports.colItem, false, overallViewMode)}
          </>
        );
      })()}

      {/* ─── Commercial Rep Report ─── */}
      {mode === 'commercial' && commReport && (() => {
        const viewData    = reportView === 'returns' ? commReturnsReport! : commReport;
        const netQtyTotal = (commReport?.totalQty ?? 0) - (commReturnsReport?.totalQty ?? 0);
        const netValTotal = (commReport?.totalValue ?? 0) - (commReturnsReport?.totalValue ?? 0);
        const isNet = reportView === 'net';
        return (
        <>
          <div className="report-summary">

            {renderViewToggle(true, (commReturnsReport?.totalQty ?? 0) > 0)}
            <div style={{ marginTop: 16, maxWidth: 360 }}>
              <div className="stat-card" style={{ borderTop: `4px solid ${isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981'}` }}>
                <div className="stat-card-icon" style={{ background: isNet ? '#d1fae5' : reportView === 'returns' ? '#fee2e2' : '#d1fae5', color: isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981' }}>💰</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: isNet ? (netValTotal >= 0 ? '#065f46' : '#991b1b') : reportView === 'returns' ? '#ef4444' : '#10b981' }}>
                    {isNet ? fmtValSigned(netValTotal) : fmtVal(viewData?.totalValue ?? 0)}
                  </div>
                  <div className="stat-card-label">{isNet ? currStatNet : currStatTotal}</div>
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, margin: '8px 0' }}>
            <div className="tabs" style={{ margin: 0 }}>
              <button title={t.reports.tabByArea}   className={`tab ${activeTab === 'area' ? 'tab--active' : ''}`} onClick={() => setActiveTab('area')}>📍</button>
              <button title={t.reports.tabByItem}   className={`tab ${activeTab === 'item' ? 'tab--active' : ''}`} onClick={() => setActiveTab('item')}>💊</button>
            </div>
            <button onClick={() => setCommViewMode(v => v === 'qty' ? 'value' : 'qty')}
              style={{ padding: '5px 14px', borderRadius: 8, border: `1.5px solid ${commViewMode === 'qty' ? '#3b82f6' : '#f59e0b'}`, background: commViewMode === 'qty' ? '#eff6ff' : '#fffbeb', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: commViewMode === 'qty' ? '#1e40af' : '#b45309' }}>
              {commViewMode === 'qty' ? '🔢 كمية' : '💰 قيمة'}
            </button>
          </div>
          {isNet ? (
            <>
              {activeTab === 'area' && renderNetTable(commReport.byArea, commReturnsReport?.byArea ?? [], t.reports.colArea, false, commViewMode)}
              {activeTab === 'item' && renderNetTable(commReport.byItem, commReturnsReport?.byItem ?? [], t.reports.colItem, false, commViewMode)}
            </>
          ) : (
            <>
              {activeTab === 'area' && renderBreakdownTable(viewData?.byArea ?? [], viewData?.totalValue ?? 0, t.reports.colArea, false, commViewMode)}
              {activeTab === 'item' && renderBreakdownTable(viewData?.byItem ?? [], viewData?.totalValue ?? 0, t.reports.colItem, false, commViewMode)}
            </>
          )}
        </>
        );
      })()}

      {/* ─── Scientific Rep Report ─── */}
      {mode === 'scientific' && sciReport && (() => {
        const viewData    = reportView === 'returns' ? sciReturnsReport! : sciReport;
        const netQtyTotal = (sciReport?.totalQty ?? 0) - (sciReturnsReport?.totalQty ?? 0);
        const netValTotal = (sciReport?.totalValue ?? 0) - (sciReturnsReport?.totalValue ?? 0);
        const isNet = reportView === 'net';
        return (
        <>
          <div className="report-summary">


            {/* Info tags — hidden by default, toggle on click */}
            <div style={{ margin: '0.6rem 0' }}>
              <button
                onClick={() => setShowInfoTags(v => !v)}
                style={{
                  background: showInfoTags ? '#ede9fe' : '#f3f4f6',
                  border: `1px solid ${showInfoTags ? '#c4b5fd' : '#e5e7eb'}`,
                  borderRadius: 20, padding: '4px 14px', cursor: 'pointer',
                  fontSize: '1rem', color: showInfoTags ? '#6d28d9' : '#6b7280',
                }}
                title={showInfoTags ? 'إخفاء التفاصيل' : 'عرض المناطق والمندوبين والأيتمات'}
              >
                {showInfoTags ? '🔼' : '🔽'}
              </button>
              {showInfoTags && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.6rem' }}>
                  {sciReport.assignedCommercialReps.map(r => (
                    <span key={r.id} className="tag tag--green">💰 {r.name}</span>
                  ))}
                  {sciReport.assignedAreas.map(a => (
                    <span key={a.id} className="tag tag--purple">📍 {a.name}</span>
                  ))}
                  {sciReport.assignedItems.map(i => (
                    <span key={i.id} className="tag tag--orange">💊 {i.name}</span>
                  ))}
                  {sciReport.assignedCommercialReps.length === 0 && (
                    <span className="tag" style={{ background: '#fee2e2', color: '#dc2626' }}>⚠️ {t.reports.noCommRepsAssigned}</span>
                  )}
                </div>
              )}
            </div>

            {renderViewToggle(true, (sciReturnsReport?.totalQty ?? 0) > 0)}

            <div style={{ marginTop: 16, maxWidth: 360 }}>
              <div className="stat-card" style={{ borderTop: `4px solid ${isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981'}` }}>
                <div className="stat-card-icon" style={{ background: isNet ? '#d1fae5' : reportView === 'returns' ? '#fee2e2' : '#d1fae5', color: isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981' }}>💰</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: isNet ? (netValTotal >= 0 ? '#065f46' : '#991b1b') : reportView === 'returns' ? '#ef4444' : '#10b981' }}>
                    {isNet ? fmtValSigned(netValTotal) : fmtVal(viewData?.totalValue ?? 0)}
                  </div>
                  <div className="stat-card-label">{isNet ? currStatNet : currStatTotal}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, margin: '8px 0' }}>
            <div className="tabs" style={{ margin: 0 }}>
              <button title={t.reports.tabByArea}    className={`tab ${activeTab === 'area' ? 'tab--active' : ''}`} onClick={() => setActiveTab('area')}>📍</button>
              <button title={t.reports.tabByItem}    className={`tab ${activeTab === 'item' ? 'tab--active' : ''}`} onClick={() => setActiveTab('item')}>💊</button>
              <button title={t.reports.tabByCommRep} className={`tab ${activeTab === 'rep'  ? 'tab--active' : ''}`} onClick={() => setActiveTab('rep')}>👤</button>
            </div>
            <button onClick={() => setSciViewMode(v => v === 'qty' ? 'value' : 'qty')}
              style={{ padding: '5px 14px', borderRadius: 8, border: `1.5px solid ${sciViewMode === 'qty' ? '#3b82f6' : '#f59e0b'}`, background: sciViewMode === 'qty' ? '#eff6ff' : '#fffbeb', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: sciViewMode === 'qty' ? '#1e40af' : '#b45309' }}>
              {sciViewMode === 'qty' ? '🔢 كمية' : '💰 قيمة'}
            </button>
          </div>
          {isNet ? (
            <>
              {activeTab === 'area' && renderNetTable(sciReport.byArea, sciReturnsReport?.byArea ?? [], t.reports.colArea, false, sciViewMode)}
              {activeTab === 'item' && renderNetTable(sciReport.byItem, sciReturnsReport?.byItem ?? [], t.reports.colItem, false, sciViewMode)}
              {activeTab === 'rep'  && renderNetTable(sciReport.byRep,  sciReturnsReport?.byRep  ?? [], t.reports.colCommRep, false, sciViewMode)}
            </>
          ) : (
            <>
              {activeTab === 'area' && renderBreakdownTable(viewData?.byArea ?? [], viewData?.totalValue ?? 0, t.reports.colArea, false, sciViewMode)}
              {activeTab === 'item' && renderBreakdownTable(viewData?.byItem ?? [], viewData?.totalValue ?? 0, t.reports.colItem, false, sciViewMode)}
              {activeTab === 'rep'  && renderBreakdownTable(viewData?.byRep  ?? [], viewData?.totalValue ?? 0, t.reports.colCommRep, false, sciViewMode)}
            </>
          )}
        </>
        );
      })()}

      {/* ─── Export Selection Modal ─── */}
      {showExportModal && (
        <div className="modal-overlay" onClick={() => !exporting && setShowExportModal(false)}>
          <div className="modal modal--wide" style={{ maxWidth: 700 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">{t.reports.exportTitle}</h2>
              <button className="modal-close" onClick={() => setShowExportModal(false)}>✕</button>
            </div>

            <div style={{ padding: '12px 24px 4px', fontSize: 12, color: '#6b7280', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
              {t.reports.exportOldFileNote}
            </div>

            <div className="export-modal-grid" style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Scientific Reps */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ color: '#374151', fontSize: 14 }}>🔬 {t.reports.exportSciLabel} ({sciReps.length})</strong>
                  <button style={{ fontSize: 12, color: '#10b981', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                    onClick={() => {
                      const s = new Set(selSciIds);
                      sciReps.every(r => s.has(r.id)) ? sciReps.forEach(r => s.delete(r.id)) : sciReps.forEach(r => s.add(r.id));
                      setSelSciIds(s);
                    }}>
                    {sciReps.every(r => selSciIds.has(r.id)) && sciReps.length > 0 ? t.reports.exportDeselectAll : t.reports.exportSelectAll}
                  </button>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {sciReps.length === 0
                    ? <span style={{ color: '#9ca3af', fontSize: 13 }}>{t.reports.exportNoReps}</span>
                    : sciReps.map(r => (
                      <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', borderRadius: 8, background: selSciIds.has(r.id) ? '#f0fdf4' : '#f9fafb', border: `1px solid ${selSciIds.has(r.id) ? '#86efac' : '#e5e7eb'}` }}>
                        <input type="checkbox" checked={selSciIds.has(r.id)} onChange={e => {
                          const s = new Set(selSciIds);
                          e.target.checked ? s.add(r.id) : s.delete(r.id);
                          setSelSciIds(s);
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                      </label>
                    ))}
                </div>
              </div>

              {/* Commercial Reps */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ color: '#374151', fontSize: 14 }}>💼 {t.reports.exportCommLabel} ({commReps.length})</strong>
                  <button style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                    onClick={() => {
                      const s = new Set(selCommIds);
                      commReps.every(r => s.has(r.id)) ? commReps.forEach(r => s.delete(r.id)) : commReps.forEach(r => s.add(r.id));
                      setSelCommIds(s);
                    }}>
                    {commReps.every(r => selCommIds.has(r.id)) && commReps.length > 0 ? t.reports.exportDeselectAll : t.reports.exportSelectAll}
                  </button>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {commReps.length === 0
                    ? <span style={{ color: '#9ca3af', fontSize: 13 }}>{t.reports.exportNoReps}</span>
                    : commReps.map(r => (
                      <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', borderRadius: 8, background: selCommIds.has(r.id) ? '#eef2ff' : '#f9fafb', border: `1px solid ${selCommIds.has(r.id) ? '#a5b4fc' : '#e5e7eb'}` }}>
                        <input type="checkbox" checked={selCommIds.has(r.id)} onChange={e => {
                          const s = new Set(selCommIds);
                          e.target.checked ? s.add(r.id) : s.delete(r.id);
                          setSelCommIds(s);
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                      </label>
                    ))}
                </div>
              </div>
            </div>

            <div style={{ padding: '14px 24px', background: '#f9fafb', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                {(selCommIds.size + selSciIds.size) > 0
                  ? `✅ ${selCommIds.size + selSciIds.size} ${t.reports.exportSelectedCount}`
                  : t.reports.exportSelectHint}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--secondary" style={{ padding: '8px 16px' }} onClick={() => setShowExportModal(false)}>{t.reports.exportCancel}</button>
                <button
                  onClick={async () => {
                    if (selCommIds.size + selSciIds.size === 0) return;
                    setPreviewLoading(true);
                    try {
                      const sheets = await buildPreviewData();
                      setPreviewSheets(sheets);
                      setShowPreviewModal(true);
                    } catch (e: any) { setError('فشل تحميل المعاينة: ' + e.message); }
                    finally { setPreviewLoading(false); }
                  }}
                  disabled={selCommIds.size + selSciIds.size === 0 || previewLoading}
                  style={{
                    padding: '8px 18px', borderRadius: 8, border: '1.5px solid #6366f1',
                    cursor: (selCommIds.size + selSciIds.size) === 0 ? 'not-allowed' : 'pointer',
                    background: '#f5f3ff', color: '#4f46e5', fontWeight: 700, fontSize: 14,
                    display: 'flex', alignItems: 'center', gap: 6,
                    opacity: (selCommIds.size + selSciIds.size) === 0 ? 0.5 : 1,
                  }}
                >
                  {previewLoading ? '⏳' : '👁️'} معاينة
                </button>
                <button
                  onClick={doExport}
                  disabled={selCommIds.size + selSciIds.size === 0}
                  style={{
                    padding: '8px 22px', borderRadius: 8, border: 'none',
                    cursor: (selCommIds.size + selSciIds.size) === 0 ? 'not-allowed' : 'pointer',
                    background: (selCommIds.size + selSciIds.size) === 0 ? '#d1d5db' : 'linear-gradient(135deg,#10b981,#059669)',
                    color: '#fff', fontWeight: 700, fontSize: 14,
                  }}
                >
                  {t.reports.exportStart}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Excel Preview Modal ── */}
      {showPreviewModal && previewSheets.length > 0 && (
        <ExcelPreviewModal
          sheets={previewSheets}
          fileName={previewFileName}
          onClose={() => setShowPreviewModal(false)}
        />
      )}

      {/* ── Bottom warning bar when no file is active ── */}
      {activeFileIds.length === 0 && (
        <div style={{
          position: 'sticky', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #6d28d9 100%)',
          padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 13, color: '#e0e7ff', fontWeight: 500,
          zIndex: 100,
          boxShadow: '0 -6px 32px rgba(99,102,241,0.45)',
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, flexShrink: 0,
          }}>📊</div>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
              {t.reports.noActiveFileTitle}
            </div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              {t.reports.noActiveFileDesc}
            </div>
          </div>
          <div
            onClick={() => onNavigate?.('upload')}
            className="upload-badge-pulse"
            style={{
              padding: '7px 18px',
              backdropFilter: 'blur(8px)',
              borderRadius: 24,
              fontSize: 12, fontWeight: 700, color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)',
              whiteSpace: 'nowrap', letterSpacing: '0.3px',
              cursor: 'pointer',
            }}
          >{t.common.uploadPageBtn}</div>
        </div>
      )}
    </div>
  );
}
