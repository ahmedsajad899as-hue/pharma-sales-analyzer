import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

interface SciRep  { id: number; name: string; }
interface Item    { id: number; name: string; }
interface FmsPlanItem { id?: number; itemId: number | null; itemName: string; quantity: number; }
interface FmsPlan {
  id: number;
  month: number;
  year: number;
  notes: string | null;
  scientificRepId: number;
  scientificRep: SciRep;
  items: FmsPlanItem[];
}

const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

/* ─────────────────────────────────────────────────────────
   FMSExcelPreviewModal — editable preview before export
───────────────────────────────────────────────────────── */
interface FmsPreviewSheet { name: string; rows: string[][]; }

function FMSExcelPreviewModal({ sheets: initSheets, onClose, fileName }: {
  sheets: FmsPreviewSheet[];
  onClose: () => void;
  fileName: string;
}) {
  const [sheets, setSheets]           = useState<FmsPreviewSheet[]>(initSheets);
  const [activeIdx, setActiveIdx]     = useState(0);
  const [editCell, setEditCell]       = useState<{ r: number; c: number } | null>(null);
  const [editVal, setEditVal]         = useState('');
  const [focusedCell, setFocusedCell] = useState<{ r: number; c: number } | null>(null);
  const [dragCol, setDragCol]         = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<number | null>(null);
  const [selStart, setSelStart]       = useState<{ r: number; c: number } | null>(null);
  const [selEnd, setSelEnd]           = useState<{ r: number; c: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const inputRef      = useRef<HTMLInputElement>(null);
  const gridRef       = useRef<HTMLDivElement>(null);
  const committingRef = useRef(false);

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
  const setRows = (rows: string[][]) =>
    setSheets(prev => prev.map((s, i) => i === activeIdx ? { ...s, rows } : s));

  const colCount = sheet.rows[0]?.length ?? 0;

  const startEdit = (r: number, c: number, initialVal?: string) => {
    setFocusedCell({ r, c });
    setEditCell({ r, c });
    const val = initialVal !== undefined ? initialVal : (sheet.rows[r]?.[c] ?? '');
    setEditVal(val);
    setTimeout(() => {
      if (initialVal !== undefined) inputRef.current?.focus();
      else inputRef.current?.select();
    }, 0);
  };

  const commitEdit = () => {
    if (!editCell || committingRef.current) return;
    committingRef.current = true;
    setRows(sheet.rows.map((row, ri) =>
      ri === editCell.r ? row.map((v, ci) => ci === editCell.c ? editVal : v) : row
    ));
    setEditCell(null);
    committingRef.current = false;
  };

  // Commit + move to adjacent cell (keyboard Enter / Tab / Arrow from input)
  const commitAndMove = (dr: number, dc: number) => {
    if (!editCell || committingRef.current) return;
    committingRef.current = true;
    const newRows = sheet.rows.map((row, ri) =>
      ri === editCell.r ? row.map((v, ci) => ci === editCell.c ? editVal : v) : row
    );
    setRows(newRows);
    const rowCount = newRows.length;
    const nr = Math.max(0, Math.min(rowCount - 1, editCell.r + dr));
    const nc = Math.max(0, Math.min(colCount - 1, editCell.c + dc));
    setFocusedCell({ r: nr, c: nc });
    setSelStart({ r: nr, c: nc });
    setSelEnd({ r: nr, c: nc });
    setEditCell(null);
    setTimeout(() => { committingRef.current = false; gridRef.current?.focus(); }, 0);
  };

  // Arrow-key navigation when not editing
  const moveCell = (dr: number, dc: number) => {
    const cur = focusedCell;
    if (!cur) return;
    const rowCount = sheet.rows.length;
    const nr = Math.max(0, Math.min(rowCount - 1, cur.r + dr));
    const nc = Math.max(0, Math.min(colCount - 1, cur.c + dc));
    setFocusedCell({ r: nr, c: nc });
    setSelStart({ r: nr, c: nc });
    setSelEnd({ r: nr, c: nc });
  };

  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editCell) return; // input handles its own keys
    if (!focusedCell) return;
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); moveCell(-1, 0); break;
      case 'ArrowDown':  e.preventDefault(); moveCell(1, 0); break;
      case 'ArrowLeft':  e.preventDefault(); moveCell(0, 1); break;
      case 'ArrowRight': e.preventDefault(); moveCell(0, -1); break;
      case 'Tab':        e.preventDefault(); moveCell(0, e.shiftKey ? 1 : -1); break;
      case 'Enter':
      case 'F2':         e.preventDefault(); startEdit(focusedCell.r, focusedCell.c); break;
      case 'Delete':
      case 'Backspace':  e.preventDefault();
        setRows(sheet.rows.map((row, ri) =>
          ri === focusedCell.r ? row.map((v, ci) => ci === focusedCell.c ? '' : v) : row
        )); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          startEdit(focusedCell.r, focusedCell.c, e.key);
        }
    }
  };

  const deleteRow = (ri: number) => setRows(sheet.rows.filter((_, i) => i !== ri));
  const deleteCol = (ci: number) => setRows(sheet.rows.map(row => row.filter((_, i) => i !== ci)));

  const onDragStart = (ci: number) => setDragCol(ci);
  const onDragOver  = (e: React.DragEvent, ci: number) => { e.preventDefault(); setDragOverCol(ci); };
  const onDrop      = (ci: number) => {
    if (dragCol === null || dragCol === ci) { setDragCol(null); setDragOverCol(null); return; }
    setRows(sheet.rows.map(row => {
      const r = [...row];
      const [removed] = r.splice(dragCol, 1);
      r.splice(ci, 0, removed);
      return r;
    }));
    setDragCol(null); setDragOverCol(null);
  };

  const exportModified = () => {
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => {
      const ws = XLSX.utils.aoa_to_sheet(s.rows);
      if (s.rows[0]) ws['!cols'] = s.rows[0].map((_, ci) => ({ wch: ci === 0 ? 30 : 14 }));
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    });
    XLSX.writeFile(wb, fileName);
    onClose();
  };

  useEffect(() => { setSelStart(null); setSelEnd(null); setFocusedCell(null); }, [activeIdx]);

  const isInSel = (r: number, c: number) => {
    if (!selStart || !selEnd) return false;
    return r >= Math.min(selStart.r, selEnd.r) && r <= Math.max(selStart.r, selEnd.r)
        && c >= Math.min(selStart.c, selEnd.c) && c <= Math.max(selStart.c, selEnd.c);
  };

  const colTotals: (number | null)[] = Array.from({ length: colCount }, (_, ci) =>
    sheet.rows.slice(1).reduce((acc, row) => {
      const v = parseFloat(row[ci] ?? '');
      return acc + (isNaN(v) ? 0 : v);
    }, 0)
  );

  const selNums: number[] = [];
  if (selStart && selEnd) {
    for (let r = Math.min(selStart.r, selEnd.r); r <= Math.max(selStart.r, selEnd.r); r++)
      for (let c = Math.min(selStart.c, selEnd.c); c <= Math.max(selStart.c, selEnd.c); c++) {
        const v = parseFloat(sheet.rows[r]?.[c] ?? '');
        if (!isNaN(v)) selNums.push(v);
      }
  }
  const selSum = selNums.reduce((a, b) => a + b, 0);
  const selNumericCount = selNums.length;
  const selCellCount = selStart && selEnd
    ? (Math.abs(selStart.r - selEnd.r) + 1) * (Math.abs(selStart.c - selEnd.c) + 1) : 0;

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, width: '96vw', maxWidth: 1300,
        maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 25px 60px rgba(0,0,0,.25)', overflow: 'hidden',
      }}>
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
            <button onClick={exportModified} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 13 }}>📥 تصدير Excel</button>
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
              color: i === activeIdx ? '#1e293b' : '#64748b', marginBottom: -1,
            }}>{s.name}</button>
          ))}
        </div>
        {/* Hints */}
        <div style={{ padding: '6px 16px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: 11, color: '#92400e', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>⬆⬇⬅➡ التنقل بالأسهم بين الخلايا</span>
          <span>⌨️ اكتب مباشرة لتعديل الخلية</span>
          <span>↔️ اسحب رأس العمود لإعادة الترتيب</span>
          <span>✕ حذف الصف / العمود</span>
          <span>🖱️ اسحب بالماوس لتحديد خلايا ومعرفة مجموعها</span>
        </div>
        {/* Grid */}
        <div ref={gridRef} tabIndex={0} style={{ flex: 1, overflow: 'auto', outline: 'none' }}
          onMouseUp={() => setIsSelecting(false)}
          onMouseLeave={() => setIsSelecting(false)}
          onMouseMove={handleGridMouseMove}
          onKeyDown={handleGridKeyDown}>
          <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', position: 'sticky', top: 0, zIndex: 10 }}>
                <th style={{ width: 28, minWidth: 28, borderRight: '1px solid #e5e7eb', background: '#f8fafc' }} />
                {Array.from({ length: colCount }, (_, ci) => (
                  <th key={ci} draggable onDragStart={() => onDragStart(ci)} onDragOver={e => onDragOver(e, ci)} onDrop={() => onDrop(ci)} onDragEnd={() => { setDragCol(null); setDragOverCol(null); }}
                    style={{ padding: '4px 6px', border: '1px solid #e5e7eb', textAlign: 'center', cursor: 'grab', userSelect: 'none', whiteSpace: 'nowrap', background: dragOverCol === ci ? '#dbeafe' : ci === dragCol ? '#fef3c7' : '#f1f5f9', position: 'relative', minWidth: ci === 0 ? 160 : 80 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <span style={{ color: '#94a3b8', fontSize: 10 }}>⠿</span>
                      <span>{String.fromCharCode(65 + ci)}</span>
                      <button onClick={() => deleteCol(ci)} title="حذف العمود" style={{ padding: '0 3px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10, lineHeight: '14px', marginRight: 2 }}>✕</button>
                    </div>
                  </th>
                ))}
              </tr>
              <tr style={{ background: '#e0f2fe', position: 'sticky', top: 28, zIndex: 9 }}>
                <td style={{ width: 28, minWidth: 28, borderRight: '1px solid #e5e7eb', textAlign: 'center', background: '#f8fafc' }}>
                  <button onClick={() => deleteRow(0)} title="حذف السطر" style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
                </td>
                {(sheet.rows[0] ?? []).map((cell, ci) => (
                  <td key={ci}
                    onMouseDown={() => { setFocusedCell({ r: 0, c: ci }); setSelStart({ r: 0, c: ci }); setSelEnd({ r: 0, c: ci }); setIsSelecting(true); setEditCell(null); setTimeout(() => gridRef.current?.focus(), 0); }}
                    onMouseEnter={() => { if (isSelecting) setSelEnd({ r: 0, c: ci }); }}
                    style={{ padding: '4px 8px', border: focusedCell?.r === 0 && focusedCell?.c === ci && !editCell ? '2px solid #22c55e' : `1px solid ${isInSel(0, ci) ? '#93c5fd' : '#bae6fd'}`, fontWeight: 700, color: '#0c4a6e', cursor: 'cell', whiteSpace: 'nowrap', background: isInSel(0, ci) ? '#bfdbfe' : '#e0f2fe', userSelect: 'none' }}>
                    {editCell?.r === 0 && editCell.c === ci ? (
                      <input ref={inputRef} value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitAndMove(1, 0); } else if (e.key === 'Tab') { e.preventDefault(); commitAndMove(0, e.shiftKey ? 1 : -1); } else if (e.key === 'ArrowDown') { e.preventDefault(); commitAndMove(1, 0); } else if (e.key === 'ArrowUp') { e.preventDefault(); commitAndMove(-1, 0); } else if (e.key === 'Escape') { setEditCell(null); gridRef.current?.focus(); } }} style={{ border: '1.5px solid #3b82f6', borderRadius: 4, padding: '1px 4px', width: '100%', minWidth: 60, fontSize: 12 }} autoFocus />
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
                      <td key={ci}
                        onMouseDown={() => { setFocusedCell({ r: actualRi, c: ci }); setSelStart({ r: actualRi, c: ci }); setSelEnd({ r: actualRi, c: ci }); setIsSelecting(true); setEditCell(null); setTimeout(() => gridRef.current?.focus(), 0); }}
                        onMouseEnter={() => { if (isSelecting) setSelEnd({ r: actualRi, c: ci }); }}
                        style={{ padding: '3px 8px', border: focusedCell?.r === actualRi && focusedCell?.c === ci && !editCell ? '2px solid #22c55e' : `1px solid ${isInSel(actualRi, ci) ? '#93c5fd' : '#e5e7eb'}`, cursor: 'cell', whiteSpace: 'nowrap', userSelect: 'none', background: editCell?.r === actualRi && editCell.c === ci ? '#eff6ff' : isInSel(actualRi, ci) ? '#dbeafe' : undefined }}>
                        {editCell?.r === actualRi && editCell.c === ci ? (
                          <input ref={inputRef} value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitAndMove(1, 0); } else if (e.key === 'Tab') { e.preventDefault(); commitAndMove(0, e.shiftKey ? 1 : -1); } else if (e.key === 'ArrowDown') { e.preventDefault(); commitAndMove(1, 0); } else if (e.key === 'ArrowUp') { e.preventDefault(); commitAndMove(-1, 0); } else if (e.key === 'Escape') { setEditCell(null); gridRef.current?.focus(); } }} style={{ border: '1.5px solid #3b82f6', borderRadius: 4, padding: '1px 4px', width: '100%', minWidth: 60, fontSize: 12 }} autoFocus />
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
                    {total !== 0 ? total!.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '−'}
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
              خلايا: {selCellCount} · أرقام: {selNumericCount} · المجموع: {selSum.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          )}
          <button onClick={exportModified} style={{ padding: '7px 22px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 13 }}>📥 تصدير هذا الملف</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Bulk-picker sub-component ─── */
function BulkItemPicker({ items, existing, onAdd, onClose }: {
  items: Item[];
  existing: FmsPlanItem[];
  onAdd: (rows: FmsPlanItem[]) => void;
  onClose: () => void;
}) {
  const [search,   setSearch]   = useState('');
  const [checked,  setChecked]  = useState<Set<number>>(new Set());
  const [defQty,   setDefQty]   = useState(1);

  const existingIds = new Set(existing.map(r => r.itemId).filter(Boolean));
  const filtered = items.filter(it =>
    !existingIds.has(it.id) &&
    it.name.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id: number) => setChecked(p => {
    const s = new Set(p);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const toggleAll = () => {
    if (checked.size === filtered.length) setChecked(new Set());
    else setChecked(new Set(filtered.map(it => it.id)));
  };

  const confirm = () => {
    const rows: FmsPlanItem[] = [...checked].map(id => {
      const it = items.find(x => x.id === id)!;
      return { itemId: it.id, itemName: it.name, quantity: defQty };
    });
    onAdd(rows);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 500, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>📋 اختيار أصناف متعددة</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>✕</button>
        </div>
        {/* Search + default qty */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث..."
            style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            كمية افتراضية:
            <input type="number" min="1" value={defQty} onChange={e => setDefQty(parseInt(e.target.value) || 1)}
              style={{ width: 60, padding: '6px 8px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          </label>
        </div>
        {/* Select all row */}
        <div style={{ padding: '6px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={checked.size === filtered.length && filtered.length > 0}
            onChange={toggleAll} style={{ width: 15, height: 15, cursor: 'pointer' }} />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            تحديد الكل ({filtered.length} صنف) {checked.size > 0 && `— محدد: ${checked.size}`}
          </span>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0
            ? <div style={{ padding: '30px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>لا توجد أصناف</div>
            : filtered.map(it => (
              <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', cursor: 'pointer', borderBottom: '1px solid #f9fafb', background: checked.has(it.id) ? '#eef2ff' : undefined }}>
                <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)}
                  style={{ width: 15, height: 15, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: checked.has(it.id) ? 600 : 400, color: checked.has(it.id) ? '#4f46e5' : '#1e293b' }}>{it.name}</span>
              </label>
            ))
          }
        </div>
        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{checked.size} صنف محدد</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>إلغاء</button>
            <button onClick={confirm} disabled={checked.size === 0}
              style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: checked.size === 0 ? 'not-allowed' : 'pointer', background: checked.size === 0 ? '#c7d2fe' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
              ✅ إضافة {checked.size > 0 ? `(${checked.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FMSPage() {
  const { token } = useAuth();
  const authH = useCallback(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token]);

  const [sciReps, setSciReps]   = useState<SciRep[]>([]);
  const [items,   setItems]     = useState<Item[]>([]);
  const [plans,   setPlans]     = useState<FmsPlan[]>([]);
  const [loading, setLoading]   = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState('');
  const [success, setSuccess]   = useState('');

  const [filterMonth, setFilterMonth] = useState<string>(String(new Date().getMonth() + 1));
  const [filterYear,  setFilterYear]  = useState<string>(String(new Date().getFullYear()));

  const [showForm,    setShowForm]    = useState(false);
  const [showPicker,  setShowPicker]  = useState(false);
  const [editPlan,    setEditPlan]    = useState<FmsPlan | null>(null);
  const [formRepId,   setFormRepId]   = useState('');
  const [formRepIds,  setFormRepIds]  = useState<Set<number>>(new Set());
  const [formMonth,   setFormMonth]   = useState(String(new Date().getMonth() + 1));
  const [formYear,    setFormYear]    = useState(String(new Date().getFullYear()));
  const [formNotes,   setFormNotes]   = useState('');
  const [formItems,   setFormItems]   = useState<FmsPlanItem[]>([{ itemId: null, itemName: '', quantity: 0 }]);

  useEffect(() => {
    fetch('/api/scientific-reps', { headers: authH() })
      .then(r => r.json())
      .then(j => setSciReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
    fetch('/api/items', { headers: authH() })
      .then(r => r.json())
      .then(j => setItems(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  }, [authH]);

  const loadPlans = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams({ month: filterMonth, year: filterYear });
      const r = await fetch(`/api/fms?${q}`, { headers: authH() });
      const j = await r.json();
      setPlans(j.data ?? []);
    } catch {
      setError('فشل في تحميل البيانات');
    } finally { setLoading(false); }
  }, [authH, filterMonth, filterYear]);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const openNew = () => {
    setEditPlan(null);
    setFormRepId('');
    setFormRepIds(new Set());
    setFormMonth(filterMonth);
    setFormYear(filterYear);
    setFormNotes('');
    setFormItems([{ itemId: null, itemName: '', quantity: 0 }]);
    setShowForm(true);
  };

  const openEdit = (plan: FmsPlan) => {
    setEditPlan(plan);
    setFormRepId(String(plan.scientificRepId));
    setFormMonth(String(plan.month));
    setFormYear(String(plan.year));
    setFormNotes(plan.notes ?? '');
    setFormItems(plan.items.length > 0 ? plan.items.map(it => ({ ...it })) : [{ itemId: null, itemName: '', quantity: 0 }]);
    setShowForm(true);
  };

  const addRow = () => setFormItems(p => [...p, { itemId: null, itemName: '', quantity: 0 }]);
  const removeRow = (i: number) => setFormItems(p => p.filter((_, idx) => idx !== i));
  const setRowItem = (i: number, itemId: number | null, itemName: string) =>
    setFormItems(p => p.map((r, idx) => idx === i ? { ...r, itemId, itemName } : r));
  const setRowQty = (i: number, qty: number) =>
    setFormItems(p => p.map((r, idx) => idx === i ? { ...r, quantity: qty } : r));

  const handleItemSelect = (i: number, val: string) => {
    const found = items.find(it => it.name === val);
    if (found) setRowItem(i, found.id, found.name);
    else       setRowItem(i, null, val);
  };

  const handleBulkAdd = (rows: FmsPlanItem[]) => {
    setFormItems(prev => {
      const cleaned = prev.filter(r => r.itemName.trim() !== '' || r.quantity > 0);
      return [...cleaned, ...rows];
    });
  };

  const savePlan = async () => {
    if (editPlan && !formRepId) { setError('اختر مندوباً'); return; }
    if (!editPlan && formRepIds.size === 0) { setError('اختر مندوباً على الأقل'); return; }
    const validItems = formItems.filter(it => it.itemName.trim() && it.quantity > 0);
    if (validItems.length === 0) { setError('أضف صنفاً واحداً على الأقل بكمية أكبر من صفر'); return; }
    setSaving(true); setError('');
    try {
      if (editPlan) {
        const body = { scientificRepId: formRepId, month: formMonth, year: formYear, notes: formNotes, items: validItems };
        const r = await fetch('/api/fms', { method: 'POST', headers: authH(), body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'خطأ في الحفظ');
        setSuccess('تم الحفظ بنجاح ✓');
      } else {
        const repIds = [...formRepIds];
        await Promise.all(repIds.map(repId => {
          const body = { scientificRepId: String(repId), month: formMonth, year: formYear, notes: formNotes, items: validItems };
          return fetch('/api/fms', { method: 'POST', headers: authH(), body: JSON.stringify(body) });
        }));
        setSuccess(`تم حفظ ${repIds.length} ${repIds.length === 1 ? 'خطة' : 'خطط'} بنجاح ✓`);
      }
      setShowForm(false);
      loadPlans();
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  // ── Grid state ────────────────────────────────────────────
  const allItemNames = useMemo(
    () => Array.from(new Set(plans.flatMap(p => p.items.map(it => it.itemName)))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [plans]
  );

  const [isMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  const [editingCell, setEditingCell] = useState<{ planId: number; itemName: string } | null>(null);
  const [editingVal,  setEditingVal]  = useState('');
  const [selection,   setSelection]  = useState<Set<string>>(new Set());
  const [fillVal,     setFillVal]    = useState('');

  // Always-fresh refs so commitEdit never reads stale closure
  const editingCellRef = useRef<{ planId: number; itemName: string } | null>(null);
  const editingValRef  = useRef('');
  editingCellRef.current = editingCell;
  editingValRef.current  = editingVal;

  const selAnchor   = useRef<{ ri: number; ci: number } | null>(null);
  const isSelecting = useRef(false);

  const cellKey = (planId: number, itemName: string) => `${planId}|${itemName}`;

  const rectSelection = useCallback((r1: number, c1: number, r2: number, c2: number, currentPlans: FmsPlan[], currentItems: string[]) => {
    const s = new Set<string>();
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        if (currentItems[r] && currentPlans[c]) s.add(cellKey(currentPlans[c].id, currentItems[r]));
      }
    }
    return s;
  }, []);

  const patchCell = useCallback(async (planId: number, itemName: string, quantity: number) => {
    setPlans(prev => prev.map(p => {
      if (p.id !== planId) return p;
      const has = p.items.find(it => it.itemName === itemName);
      if (quantity <= 0) return { ...p, items: p.items.filter(it => it.itemName !== itemName) };
      if (has) return { ...p, items: p.items.map(it => it.itemName === itemName ? { ...it, quantity } : it) };
      return { ...p, items: [...p.items, { itemName, quantity, itemId: null }] };
    }));
    try {
      await fetch('/api/fms/cell', { method: 'PATCH', headers: authH(), body: JSON.stringify({ planId, itemName, quantity }) });
    } catch { /* silent */ }
  }, [authH]);

  // Use refs so onBlur always sees freshest cell even with batched state updates
  const commitEdit = useCallback(() => {
    const cell = editingCellRef.current;
    if (!cell) return;
    patchCell(cell.planId, cell.itemName, parseInt(editingValRef.current) || 0);
    setEditingCell(null);
  }, [patchCell]);

  const applyFill = () => {
    const qty = parseInt(fillVal) || 0;
    selection.forEach(key => {
      const idx = key.indexOf('|');
      patchCell(parseInt(key.slice(0, idx)), key.slice(idx + 1), qty);
    });
    setSelection(new Set());
    setFillVal('');
  };

  // No e.preventDefault() so touch-scroll still works on mobile
  const onCellMouseDown = (ri: number, ci: number, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    isSelecting.current = true;
    selAnchor.current = { ri, ci };
    setFocusedCell({ ri, ci });
    setSelection(rectSelection(ri, ci, ri, ci, plans, allItemNames));
    setEditingCell(null);
    setTimeout(() => mainGridRef.current?.focus(), 0);
  };
  const onCellMouseEnter = (ri: number, ci: number) => {
    if (!isSelecting.current || !selAnchor.current) return;
    setSelection(rectSelection(selAnchor.current.ri, selAnchor.current.ci, ri, ci, plans, allItemNames));
  };
  const onMouseUp = () => { isSelecting.current = false; };

  const mainGridRef = useRef<HTMLDivElement>(null);
  const [focusedCell, setFocusedCell] = useState<{ ri: number; ci: number } | null>(null);

  const commitEditAndMove = (dr: number, dc: number) => {
    const cell = editingCellRef.current;
    if (!cell) return;
    patchCell(cell.planId, cell.itemName, parseInt(editingValRef.current) || 0);
    setEditingCell(null);
    const curRi = allItemNames.indexOf(cell.itemName);
    const curCi = plans.findIndex(p => p.id === cell.planId);
    const nr = Math.max(0, Math.min(allItemNames.length - 1, curRi + dr));
    const nc = Math.max(0, Math.min(plans.length - 1, curCi + dc));
    setFocusedCell({ ri: nr, ci: nc });
    setTimeout(() => mainGridRef.current?.focus(), 0);
  };

  const handleMainGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingCell) return;
    if (!focusedCell) return;
    const { ri, ci } = focusedCell;
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); setFocusedCell({ ri: Math.max(0, ri - 1), ci }); break;
      case 'ArrowDown':  e.preventDefault(); setFocusedCell({ ri: Math.min(allItemNames.length - 1, ri + 1), ci }); break;
      case 'ArrowLeft':  e.preventDefault(); setFocusedCell({ ri, ci: Math.min(plans.length - 1, ci + 1) }); break;
      case 'ArrowRight': e.preventDefault(); setFocusedCell({ ri, ci: Math.max(0, ci - 1) }); break;
      case 'Tab':        e.preventDefault(); setFocusedCell({ ri, ci: Math.max(0, Math.min(plans.length - 1, ci + (e.shiftKey ? 1 : -1))) }); break;
      case 'Enter':
      case 'F2': {
        e.preventDefault();
        const plan = plans[ci]; const itemName = allItemNames[ri];
        if (plan && itemName) { const qty = plan.items.find(it => it.itemName === itemName)?.quantity ?? 0; setEditingCell({ planId: plan.id, itemName }); setEditingVal(qty > 0 ? String(qty) : ''); setSelection(new Set([cellKey(plan.id, itemName)])); }
        break;
      }
      case 'Delete':
      case 'Backspace': { e.preventDefault(); const plan = plans[ci]; if (plan) patchCell(plan.id, allItemNames[ri], 0); break; }
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const plan = plans[ci]; const itemName = allItemNames[ri];
          if (plan && itemName) { setEditingCell({ planId: plan.id, itemName }); setEditingVal(e.key); setSelection(new Set([cellKey(plan.id, itemName)])); }
        }
    }
  };

  const deletePlan = async (id: number) => {
    if (!confirm('هل تريد حذف هذه الخطة؟')) return;
    try {
      await fetch(`/api/fms/${id}`, { method: 'DELETE', headers: authH() });
      setPlans(p => p.filter(x => x.id !== id));
    } catch { setError('فشل في الحذف'); }
  };

  const [showExcelPreview, setShowExcelPreview] = useState(false);
  const [previewSheets, setPreviewSheets] = useState<FmsPreviewSheet[]>([]);
  const [previewFileName, setPreviewFileName] = useState('');

  const exportExcel = () => {
    // ── Sheet 1: Pivot table — items × reps ──────────────────
    const allItems = Array.from(new Set(plans.flatMap(p => p.items.map(it => it.itemName)))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const headerRow = ['اسم المادة', ...plans.map(p => p.scientificRep.name), 'الإجمالي'];
    const dataRows = allItems.map(itemName => {
      const qtys = plans.map(p => {
        const it = p.items.find(r => r.itemName === itemName);
        return it ? String(it.quantity) : '';
      });
      const total = plans.reduce((s, p) => {
        const it = p.items.find(r => r.itemName === itemName);
        return s + (it?.quantity ?? 0);
      }, 0);
      return [itemName, ...qtys, total > 0 ? String(total) : ''];
    });
    const totalsRow = ['الإجمالي',
      ...plans.map(p => String(p.items.reduce((s, it) => s + it.quantity, 0))),
      String(plans.reduce((s, p) => s + p.items.reduce((ss, it) => ss + it.quantity, 0), 0))
    ];
    const pivotRows = [headerRow, ...dataRows, totalsRow];

    // ── Sheet 2: Per-rep detail ───────────────────────────────
    const detailRows: string[][] = [['المندوب', 'الشهر', 'السنة', 'الصنف', 'الكمية']];
    plans.forEach(p => {
      p.items.forEach(it => detailRows.push([p.scientificRep.name, MONTHS[p.month - 1], String(p.year), it.itemName, String(it.quantity)]));
    });

    const fname = `FMS_${MONTHS[parseInt(filterMonth) - 1]}_${filterYear}.xlsx`;
    setPreviewSheets([
      { name: `${MONTHS[parseInt(filterMonth) - 1]} ${filterYear}`, rows: pivotRows.map(r => r.map(String)) },
      { name: 'تفصيل', rows: detailRows },
    ]);
    setPreviewFileName(fname);
    setShowExcelPreview(true);
  };

  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - 2 + i));

  return (
    <div style={{ padding: '20px 16px', maxWidth: 1100, margin: '0 auto', direction: 'rtl', fontFamily: 'inherit' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {plans.length > 0 && (
            <button onClick={exportExcel} title="تصدير Excel" style={{ padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: 16 }}>📥</button>
          )}
          <button onClick={openNew} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>+ خطة جديدة</button>
        </div>
      </div>

      {error   && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #fecaca' }}>{error}</div>}
      {success && <div style={{ background: '#f0fdf4', color: '#15803d', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #bbf7d0' }}>{success}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          الشهر:
          <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          السنة:
          <select value={filterYear} onChange={e => setFilterYear(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {years.map(y => <option key={y}>{y}</option>)}
          </select>
        </label>
      </div>

      {/* Plans matrix */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>جاري التحميل...</div>
      ) : plans.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧪</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>لا توجد خطط لهذا الشهر</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>اضغط "+ خطة جديدة" لإضافة خطة</div>
        </div>
      ) : isMobile ? (
        /* ── Mobile: card-per-plan view ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plans.map(plan => (
            <div key={plan.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)' }}>
                <div style={{ color: '#fff' }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{plan.scientificRep.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.85 }}>{MONTHS[plan.month - 1]} {plan.year} — {plan.items.length} صنف / {plan.items.reduce((s, it) => s + it.quantity, 0)} وحدة</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => openEdit(plan)} style={{ padding: '5px 10px', borderRadius: 7, border: 'none', background: 'rgba(255,255,255,0.2)', color: '#fff', cursor: 'pointer', fontSize: 13 }}>✏️</button>
                  <button onClick={() => deletePlan(plan.id)} style={{ padding: '5px 10px', borderRadius: 7, border: 'none', background: 'rgba(255,255,255,0.2)', color: '#fff', cursor: 'pointer', fontSize: 13 }}>🗑️</button>
                </div>
              </div>
              {/* Items list */}
              <div>
                {allItemNames.map((itemName, i) => {
                  const it = plan.items.find(r => r.itemName === itemName);
                  const qty = it?.quantity ?? 0;
                  const isEditing = editingCell?.planId === plan.id && editingCell?.itemName === itemName;
                  return (
                    <div key={itemName} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500, flex: 1, paddingLeft: 10 }}>{itemName}</span>
                      {isEditing ? (
                        <input
                          autoFocus type="number" min="0" value={editingVal}
                          onChange={e => setEditingVal(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingCell(null); }}
                          style={{ width: 80, padding: '6px 8px', borderRadius: 7, border: '2px solid #6366f1', textAlign: 'center', fontSize: 14, outline: 'none' }}
                        />
                      ) : (
                        <span
                          onClick={() => { setEditingCell({ planId: plan.id, itemName }); setEditingVal(qty > 0 ? String(qty) : ''); }}
                          style={{ background: qty > 0 ? '#dbeafe' : '#f1f5f9', color: qty > 0 ? '#1d4ed8' : '#94a3b8', borderRadius: 8, padding: '5px 18px', fontWeight: 700, fontSize: 14, minWidth: 50, textAlign: 'center', cursor: 'pointer', display: 'inline-block' }}
                        >
                          {qty > 0 ? qty : '—'}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', background: '#f0fdf4', fontWeight: 700 }}>
                  <span style={{ color: '#15803d', fontSize: 13 }}>الإجمالي</span>
                  <span style={{ background: '#bbf7d0', color: '#15803d', borderRadius: 8, padding: '4px 18px', fontWeight: 700, fontSize: 14 }}>{plan.items.reduce((s, it) => s + it.quantity, 0)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
          <div
            ref={mainGridRef}
            tabIndex={0}
            data-no-sidebar-swipe
            style={{ overflowX: 'auto', background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', userSelect: 'none', outline: 'none' }}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onKeyDown={handleMainGridKeyDown}
          >
            {/* Fill toolbar */}
            {selection.size > 0 && (
              <div style={{ padding: '8px 14px', background: '#eef2ff', borderBottom: '1px solid #c7d2fe', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#4f46e5', fontWeight: 600 }}>✅ {selection.size} خلية محددة</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>اكتب القيمة واضغط تطبيق:</span>
                <input
                  type="number" min="0" value={fillVal}
                  onChange={e => setFillVal(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyFill()}
                  placeholder="الكمية..."
                  style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '1px solid #818cf8', fontSize: 13, textAlign: 'center' }}
                />
                <button onClick={applyFill} style={{ padding: '4px 14px', borderRadius: 6, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>✅ تطبيق</button>
                <button onClick={() => { setSelection(new Set()); setFillVal(''); }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #c7d2fe', background: '#fff', color: '#4f46e5', fontSize: 12, cursor: 'pointer' }}>✕ إلغاء</button>
              </div>
            )}
            <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#dbeafe', borderBottom: '2px solid #93c5fd' }}>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#1e40af', borderLeft: '1px solid #bfdbfe', minWidth: 200, position: 'sticky', right: 0, background: '#dbeafe', zIndex: 2 }}>
                    اسم المادة
                  </th>
                  {plans.map(plan => (
                    <th key={plan.id} style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#1e40af', borderLeft: '1px solid #bfdbfe', minWidth: 110 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 4, whiteSpace: 'nowrap' }}>{plan.scientificRep.name}</div>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        <button onClick={() => openEdit(plan)} title="تعديل" style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid #c7d2fe', background: 'rgba(255,255,255,0.7)', color: '#4f46e5', cursor: 'pointer', fontSize: 11 }}>✏️</button>
                        <button onClick={() => deletePlan(plan.id)} title="حذف" style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid #fecaca', background: 'rgba(255,255,255,0.7)', color: '#dc2626', cursor: 'pointer', fontSize: 11 }}>🗑️</button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allItemNames.map((itemName, ri) => (
                  <tr key={itemName} style={{ borderBottom: '1px solid #f1f5f9', background: ri % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '7px 14px', fontWeight: 500, color: '#1e293b', borderLeft: '1px solid #f1f5f9', position: 'sticky', right: 0, background: ri % 2 === 0 ? '#fff' : '#fafafa', zIndex: 1 }}>{itemName}</td>
                    {plans.map((plan, ci) => {
                      const it = plan.items.find(r => r.itemName === itemName);
                      const qty = it?.quantity ?? 0;
                      const key = cellKey(plan.id, itemName);
                      const isSelected = selection.has(key);
                      const isFocused = focusedCell?.ri === ri && focusedCell?.ci === ci;
                      const isEditing = editingCell?.planId === plan.id && editingCell?.itemName === itemName;
                      return (
                        <td
                          key={plan.id}
                          style={{
                            padding: '4px 10px', textAlign: 'right', borderLeft: '1px solid #f1f5f9',
                            background: isSelected ? '#eef2ff' : undefined,
                            outline: isFocused && !isEditing ? '2px solid #22c55e' : isSelected ? '2px solid #818cf8' : 'none',
                            outlineOffset: '-2px', cursor: 'cell',
                          }}
                          onMouseDown={e => onCellMouseDown(ri, ci, e)}
                          onMouseEnter={() => onCellMouseEnter(ri, ci)}
                        >
                          {isEditing ? (
                            <input
                              autoFocus type="number" min="0" value={editingVal}
                              onChange={e => setEditingVal(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); commitEditAndMove(1, 0); }
                                else if (e.key === 'Tab') { e.preventDefault(); commitEditAndMove(0, e.shiftKey ? 1 : -1); }
                                else if (e.key === 'ArrowDown') { e.preventDefault(); commitEditAndMove(1, 0); }
                                else if (e.key === 'ArrowUp') { e.preventDefault(); commitEditAndMove(-1, 0); }
                                else if (e.key === 'ArrowLeft') { e.preventDefault(); commitEditAndMove(0, 1); }
                                else if (e.key === 'ArrowRight') { e.preventDefault(); commitEditAndMove(0, -1); }
                                else if (e.key === 'Escape') { setEditingCell(null); mainGridRef.current?.focus(); }
                              }}
                              style={{ width: 70, padding: '3px 6px', borderRadius: 5, border: '2px solid #6366f1', textAlign: 'right', fontSize: 13, outline: 'none' }}
                            />
                          ) : qty > 0 ? (
                            <span style={{ color: '#1e293b', fontSize: 13 }}>{qty}</span>
                          ) : (
                            <span style={{ color: '#d1d5db', fontSize: 13 }}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f0fdf4', borderTop: '2px solid #bbf7d0', fontWeight: 700 }}>
                  <td style={{ padding: '8px 14px', color: '#15803d', fontWeight: 700, position: 'sticky', right: 0, background: '#f0fdf4', zIndex: 1 }}>الإجمالي</td>
                  {plans.map(plan => (
                    <td key={plan.id} style={{ padding: '8px 10px', textAlign: 'right', color: '#15803d', fontWeight: 700, fontSize: 13 }}>
                      {plan.items.reduce((s, it) => s + it.quantity, 0)}
                    </td>
                  ))}
                </tr>
                {plans.some(p => p.notes) && (
                  <tr style={{ background: '#fffbeb', borderTop: '1px solid #fde68a' }}>
                    <td style={{ padding: '6px 14px', fontSize: 11, color: '#92400e', position: 'sticky', right: 0, background: '#fffbeb', zIndex: 1 }}>📝 ملاحظات</td>
                    {plans.map(plan => (
                      <td key={plan.id} style={{ padding: '6px 10px', fontSize: 11, color: '#92400e', textAlign: 'center' }}>{plan.notes ?? ''}</td>
                    ))}
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
      )}

      {/* Bulk picker */}
      {showPicker && (
        <BulkItemPicker
          items={items}
          existing={formItems}
          onAdd={handleBulkAdd}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* Form Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setShowForm(false)}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 700, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{editPlan ? '✏️ تعديل الخطة' : '➕ خطة جديدة'}</div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>✕</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {error && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

              {editPlan ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                    المندوب العلمي
                    <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f8fafc', fontSize: 13, color: '#374151' }}>
                      {sciReps.find(r => r.id === parseInt(formRepId))?.name ?? '—'}
                    </div>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                    الشهر *
                    <select value={formMonth} onChange={e => setFormMonth(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                      {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                    السنة *
                    <select value={formYear} onChange={e => setFormYear(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                      {years.map(y => <option key={y}>{y}</option>)}
                    </select>
                  </label>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                        المندوبون العلميون *{formRepIds.size > 0 && <span style={{ color: '#6366f1', marginRight: 4 }}>({formRepIds.size} محدد)</span>}
                      </span>
                      <button type="button"
                        onClick={() => setFormRepIds(formRepIds.size === sciReps.length ? new Set() : new Set(sciReps.map(r => r.id)))}
                        style={{ fontSize: 11, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                        {formRepIds.size === sciReps.length ? 'إلغاء الكل' : 'تحديد الكل'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb', maxHeight: 150, overflowY: 'auto' }}>
                      {sciReps.map(rep => (
                        <label key={rep.id} style={{
                          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 20, cursor: 'pointer',
                          background: formRepIds.has(rep.id) ? '#eef2ff' : '#fff',
                          border: `1px solid ${formRepIds.has(rep.id) ? '#818cf8' : '#e5e7eb'}`,
                          color: formRepIds.has(rep.id) ? '#4f46e5' : '#374151',
                          fontWeight: formRepIds.has(rep.id) ? 600 : 400,
                          fontSize: 12, userSelect: 'none',
                        }}>
                          <input type="checkbox" checked={formRepIds.has(rep.id)}
                            onChange={() => setFormRepIds(prev => { const s = new Set(prev); s.has(rep.id) ? s.delete(rep.id) : s.add(rep.id); return s; })}
                            style={{ width: 13, height: 13 }} />
                          {rep.name}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                      الشهر *
                      <select value={formMonth} onChange={e => setFormMonth(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                        {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                      السنة *
                      <select value={formYear} onChange={e => setFormYear(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                        {years.map(y => <option key={y}>{y}</option>)}
                      </select>
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>الأصناف والكميات ({formItems.filter(r => r.itemName.trim()).length})</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setShowPicker(true)}
                    style={{ fontSize: 12, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 600 }}>
                    📋 اختيار متعدد
                  </button>
                  <button onClick={addRow}
                    style={{ fontSize: 12, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}>
                    + إضافة صف
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {formItems.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 18, textAlign: 'center' }}>{i + 1}</span>
                    <div style={{ flex: 2 }}>
                      <input
                        list={`items-list-${i}`}
                        value={row.itemName}
                        onChange={e => handleItemSelect(i, e.target.value)}
                        placeholder="اسم الصنف..."
                        style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                      />
                      <datalist id={`items-list-${i}`}>
                        {items.map(it => <option key={it.id} value={it.name} />)}
                      </datalist>
                    </div>
                    <input type="number" min="1" value={row.quantity || ''} onChange={e => setRowQty(i, parseInt(e.target.value) || 0)}
                      placeholder="الكمية"
                      style={{ width: 90, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
                    {formItems.length > 1 && (
                      <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>✕</button>
                    )}
                  </div>
                ))}
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                ملاحظات (اختياري)
                <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={2}
                  placeholder="ملاحظات عامة..."
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical' }} />
              </label>
            </div>

            <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>إلغاء</button>
              <button onClick={savePlan} disabled={saving}
                style={{ padding: '8px 22px', borderRadius: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
                {saving ? '⏳ جاري الحفظ...' : editPlan ? '✅ حفظ' : `✅ حفظ${!editPlan && formRepIds.size > 1 ? ` (${formRepIds.size} خطط)` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Excel Preview Modal ── */}
      {showExcelPreview && (
        <FMSExcelPreviewModal
          sheets={previewSheets}
          fileName={previewFileName}
          onClose={() => setShowExcelPreview(false)}
        />
      )}
    </div>
  );
}
