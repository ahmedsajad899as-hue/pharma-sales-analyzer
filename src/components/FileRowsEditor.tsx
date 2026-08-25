import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Row {
  id: number;
  repName: string; areaName: string; itemName: string; customerName: string;
  quantity: number; totalValue: number; saleDate: string; recordType: string;
  extra: Record<string, any>;
}
interface Col { key: string; label: string; kind: 'core' | 'extra' }

type Edit = { id: number; field: string; value: any };

/**
 * محرّر صفوف الملف المرفوع.
 *
 * التقارير والتصدير تُبنى على صفوف المبيعات لا على ملف الإكسل نفسه، فالتعديل
 * هنا يُطبَّق على تلك الصفوف مباشرةً — أي ينعكس فوراً في كل مكان بلا مزامنة.
 * التعديلات تُجمَّع محلياً ولا تُرسل إلا عند «حفظ»، كي لا يُرسَل طلب لكل خلية.
 */
export default function FileRowsEditor({ fileId, fileName, onClose, onSaved }: {
  fileId: number; fileName: string; onClose: () => void; onSaved?: () => void;
}) {
  const { token } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const [rows, setRows]         = useState<Row[]>([]);
  // ترتيب الأعمدة يأتي من السيرفر مطابقاً لترتيب الملف الأصلي
  const [columns, setColumns] = useState<Col[]>([]);
  // الترتيب الأبجدي: ضغطة على الترويسة ترتّب، وضغطة ثانية تُرجع ترتيب الملف
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [edited, setEdited]     = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [search, setSearch]     = useState('');

  // تغييرات معلّقة
  const [pending, setPending]       = useState<Map<string, Edit>>(new Map());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [deletedCols, setDeletedCols] = useState<Set<string>>(new Set());
  const [newRows, setNewRows]       = useState<any[]>([]);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  // تحديد مستطيل من الخلايا لمعرفة مجموعها (مثل الإكسل)
  const [selStart, setSelStart]     = useState<{ r: number; c: number } | null>(null);
  const [selEnd, setSelEnd]         = useState<{ r: number; c: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const dragMovedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    setLoading(true); setErr('');
    fetch(`${API}/api/files/${fileId}/rows`, { headers: H() })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل الصفوف');
        setRows(j.data.rows || []);
        setColumns(j.data.columns || []);
        setEdited(!!j.data.edited);
        setSnapshotAt(j.data.snapshotAt ?? null);
      })
      .catch(e => setErr(e instanceof Error ? e.message : 'خطأ'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [fileId]);

  const dirty = pending.size > 0 || deletedIds.size > 0 || deletedCols.size > 0 || newRows.length > 0;

  const cellKey = (id: number, field: string) => `${id}|${field}`;

  const getValue = (row: Row, field: string) => {
    const p = pending.get(cellKey(row.id, field));
    if (p) return p.value;
    if (field in row) return (row as any)[field];
    return row.extra?.[field] ?? '';
  };

  const setValue = (id: number, field: string, value: any) => {
    setPending(prev => {
      const next = new Map(prev);
      next.set(cellKey(id, field), { id, field, value });
      return next;
    });
  };

  const visibleCols = useMemo(() => columns.filter(c => !deletedCols.has(c.key)), [columns, deletedCols]);

  /**
   * تنظيف ضجيج الفاصلة العشرية الناتج عن تحويل العملة:
   * 121140.0000000001 ← 121140 و 71579.99999999999 ← 71580.
   * التقريب لخانتين ثم إسقاط الأصفار الزائدة.
   */
  const fmtVal = (v: any): string => {
    if (v === null || v === undefined || v === '') return '';
    const n = typeof v === 'number' ? v : (/^-?d*.?d+$/.test(String(v).trim()) ? Number(v) : NaN);
    if (!Number.isFinite(n)) return String(v);
    return String(Number(n.toFixed(2)));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const live = rows.filter(r => !deletedIds.has(r.id));
    if (!q) return live;
    return live.filter(r =>
      [r.repName, r.areaName, r.itemName, r.customerName, String(r.quantity), String(r.totalValue), r.saleDate]
        .some(v => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [rows, deletedIds, search]);

  const sortedRows = useMemo(() => {
    if (!sortCol) return filtered; // بلا فرز = ترتيب الملف كما رُفع
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = getValue(a, sortCol);
      const bv = getValue(b, sortCol);
      const an = Number(av), bn = Number(bv);
      const bothNumeric = av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn);
      // الأعمدة الرقمية تُرتَّب رقمياً — الترتيب النصي يضع 100 قبل 9
      if (bothNumeric) return an - bn;
      return String(av ?? '').localeCompare(String(bv ?? ''), 'ar');
    });
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortCol, pending]);
  const numOf = (v: any): number => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * المجاميع الحيّة: تُحسب من الصفوف الظاهرة فعلاً بعد الحذف والإضافة
   * والتعديلات المعلّقة — فليست رقماً جامداً من وقت التحميل.
   */
  const liveTotals = useMemo(() => {
    const numericCols = visibleCols.filter(c => c.key === 'totalValue' || c.key === 'quantity');
    const out: Record<string, number> = {};
    for (const c of numericCols) out[c.key] = 0;
    for (const row of sortedRows) {
      for (const c of numericCols) out[c.key] += numOf(getValue(row, c.key));
    }
    for (const nr of newRows) {
      for (const c of numericCols) out[c.key] += numOf(nr[c.key]);
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, newRows, visibleCols, pending]);

  // مجموع الخلايا المحدَّدة — القيم غير الرقمية تُتجاهل
  const selection = useMemo(() => {
    if (!selStart || !selEnd) return null;
    const r1 = Math.min(selStart.r, selEnd.r), r2 = Math.max(selStart.r, selEnd.r);
    const c1 = Math.min(selStart.c, selEnd.c), c2 = Math.max(selStart.c, selEnd.c);
    let sum = 0, numeric = 0, cells = 0;
    for (let r = r1; r <= r2; r++) {
      const row = sortedRows[r];
      if (!row) continue;
      for (let c = c1; c <= c2; c++) {
        const col = visibleCols[c];
        if (!col) continue;
        cells++;
        const raw = getValue(row, col.key);
        const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, ''));
        if (String(raw ?? '').trim() !== '' && Number.isFinite(n)) { sum += n; numeric++; }
      }
    }
    return { sum, numeric, cells };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStart, selEnd, sortedRows, visibleCols, pending]);

  const inSel = (r: number, c: number) => {
    if (!selStart || !selEnd) return false;
    return r >= Math.min(selStart.r, selEnd.r) && r <= Math.max(selStart.r, selEnd.r)
        && c >= Math.min(selStart.c, selEnd.c) && c <= Math.max(selStart.c, selEnd.c);
  };
  const save = async () => {
    if (!dirty) return;
    setSaving(true); setErr('');
    try {
      const body = {
        updates: [...pending.values()],
        deletedRowIds: [...deletedIds],
        deletedColumns: [...deletedCols],
        newRows,
      };
      const r = await fetch(`${API}/api/files/${fileId}/rows`, {
        method: 'PUT', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل الحفظ');
      const s = j.summary || {};
      const msg = `✅ تم الحفظ\n\n• خلايا معدّلة: ${s.updated ?? 0}\n• صفوف محذوفة: ${s.deleted ?? 0}\n• صفوف مضافة: ${s.added ?? 0}\n• أعمدة محذوفة: ${s.columnsRemoved ?? 0}`
        + (s.errors?.length ? `\n\n⚠️ ${s.errors.slice(0, 5).join('\n')}` : '');
      alert(msg);
      setPending(new Map()); setDeletedIds(new Set()); setDeletedCols(new Set()); setNewRows([]);
      load();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشل الحفظ');
    }
    setSaving(false);
  };

  const restore = async () => {
    if (!confirm('سيُرجَع الملف إلى حالته وقت الرفع، وتُلغى كل التعديلات التي أُجريت عليه. متابعة؟')) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch(`${API}/api/files/${fileId}/restore`, { method: 'POST', headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل الاسترجاع');
      alert(`✅ تم إرجاع الملف كما رُفع (${j.restored} صف)`);
      setPending(new Map()); setDeletedIds(new Set()); setDeletedCols(new Set()); setNewRows([]);
      load();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'فشل الاسترجاع');
    }
    setSaving(false);
  };

  const addRow = () => {
    const blank: any = {
      _tmp: `new-${Date.now()}-${newRows.length}`,
      repName: '', areaName: '', itemName: '', customerName: '',
      quantity: 0, totalValue: 0,
      saleDate: new Date().toISOString().slice(0, 10),
      recordType: 'sale',
      extra: Object.fromEntries(visibleCols.filter(c => c.kind === 'extra').map(c => [c.key, ''])),
    };
    setNewRows(prev => [...prev, blank]);
  };

  const setNewVal = (tmp: string, field: string, value: any) => {
    setNewRows(prev => prev.map(r => {
      if (r._tmp !== tmp) return r;
      if (field in r) return { ...r, [field]: value };
      return { ...r, extra: { ...r.extra, [field]: value } };
    }));
  };

  const TH: React.CSSProperties = {
    padding: '6px 8px', borderBottom: '2px solid #cbd5e1', borderInlineEnd: '1px solid #e2e8f0',
    background: '#f1f5f9', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2,
  };
  const TD: React.CSSProperties = {
    padding: '3px 6px', borderBottom: '1px solid #f1f5f9', borderInlineEnd: '1px solid #f1f5f9',
    fontSize: 12, whiteSpace: 'nowrap', cursor: 'text',
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 4000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 14, width: 'min(1400px, 98vw)', height: '92vh',
        display: 'flex', flexDirection: 'column', direction: 'rtl', overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: '#0f172a' }}>📝 تعديل الملف — {fileName}</strong>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            {filtered.length} صف{deletedIds.size > 0 ? ` · ${deletedIds.size} محذوف` : ''}{newRows.length > 0 ? ` · ${newRows.length} جديد` : ''}
          </span>
          {edited && (
            <span title={snapshotAt ? `نسخة أصلية محفوظة بتاريخ ${new Date(snapshotAt).toLocaleString('ar-IQ')}` : ''}
              style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 20, padding: '2px 8px' }}>
              مُعدَّل — نسخة أصلية محفوظة
            </span>
          )}
          <button onClick={onClose} style={{ marginInlineStart: 'auto', background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}>✕</button>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid #eef2f7', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#f8fafc' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث في الصفوف..."
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 12, minWidth: 200 }} />
          <button onClick={addRow} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            ＋ صف جديد
          </button>
          <button onClick={save} disabled={!dirty || saving}
            style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: dirty ? '#059669' : '#cbd5e1', color: '#fff', fontSize: 12, fontWeight: 800, cursor: dirty && !saving ? 'pointer' : 'not-allowed' }}>
            {saving ? '⏳ جاري الحفظ...' : dirty ? '💾 حفظ التعديلات' : '💾 لا تغييرات'}
          </button>
          {edited && (
            <button onClick={restore} disabled={saving}
              title="يُرجع الملف إلى حالته وقت الرفع ويلغي كل التعديلات"
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ↩️ استرجاع كما رُفع
            </button>
          )}
          <span style={{ fontSize: 11, color: '#94a3b8', marginInlineStart: 'auto' }}>
            انقر على أي خلية لتعديلها · التعديل ينعكس في التقارير والتصدير بعد الحفظ
          </span>
        </div>

        {err && <div style={{ padding: '8px 16px', background: '#fef2f2', color: '#b91c1c', fontSize: 12 }}>⚠️ {err}</div>}

        <div style={{ flex: 1, overflow: 'auto' }}
          onMouseUp={() => setIsSelecting(false)}
          onMouseLeave={() => setIsSelecting(false)}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>⏳ جاري تحميل الصفوف...</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 34 }} />
                  <th style={{ ...TH, width: 46 }}>#</th>
                  {visibleCols.map(c => (
                    <th key={c.key} style={TH}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <button
                          onClick={() => setSortCol(prev => (prev === c.key ? null : c.key))}
                          title={sortCol === c.key ? 'إلغاء الترتيب — رجوع لترتيب الملف' : 'ترتيب حسب هذا العمود'}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 800, color: sortCol === c.key ? '#4f46e5' : '#0f172a', padding: 0, fontFamily: 'inherit' }}
                        >
                          {c.label}{sortCol === c.key ? ' ▲' : ''}
                        </button>
                        {c.kind === 'extra' && (
                          <button
                            onClick={() => { if (confirm('حذف عمود «' + c.label + '» من كل صفوف الملف؟')) setDeletedCols(p => new Set(p).add(c.key)); }}
                            title="حذف هذا العمود من كل الصفوف"
                            style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}
                          >✕</button>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {newRows.map((nr, i) => (
                  <tr key={nr._tmp} style={{ background: '#f5f3ff' }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => setNewRows(p => p.filter(x => x._tmp !== nr._tmp))}
                        title="إزالة الصف الجديد" style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>✕</button>
                    </td>
                    <td style={{ ...TD, color: '#7c3aed', fontWeight: 700 }}>جديد {i + 1}</td>
                    {visibleCols.map(c => (
                      <td key={c.key} style={TD}>
                        <input
                          value={(c.kind === 'core' ? nr[c.key] : nr.extra?.[c.key]) ?? ''}
                          onChange={e => setNewVal(nr._tmp, c.key, e.target.value)}
                          style={{ width: '100%', minWidth: 90, border: '1px solid #ddd6fe', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                      </td>
                    ))}
                  </tr>
                ))}
                {sortedRows.map((row, idx) => (
                  <tr key={row.id} style={{ background: idx % 2 ? '#fafbfc' : '#fff' }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => setDeletedIds(p => new Set(p).add(row.id))}
                        title="حذف هذا الصف" style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>✕</button>
                    </td>
                    <td style={{ ...TD, color: '#94a3b8' }}>{idx + 1}</td>
                    {visibleCols.map(({ key: field }, ci) => {
                      const k = cellKey(row.id, field);
                      const changed = pending.has(k);
                      const val = getValue(row, field);
                      const selected = inSel(idx, ci);
                      return (
                        <td key={field}
                          onMouseDown={() => {
                            // بداية تحديد محتمل — نميّز النقرة عن السحب في mouseUp
                            dragMovedRef.current = false;
                            setIsSelecting(true);
                            setSelStart({ r: idx, c: ci });
                            setSelEnd({ r: idx, c: ci });
                          }}
                          onMouseEnter={() => {
                            if (!isSelecting) return;
                            dragMovedRef.current = true;
                            setSelEnd({ r: idx, c: ci });
                          }}
                          onMouseUp={() => {
                            setIsSelecting(false);
                            // نقرة بلا سحب = تعديل الخلية، والسحب = تحديد فقط
                            if (!dragMovedRef.current) {
                              setSelStart(null); setSelEnd(null);
                              setEditingCell(k);
                              requestAnimationFrame(() => inputRef.current?.focus());
                            }
                          }}
                          style={{ ...TD, userSelect: 'none', cursor: 'cell',
                            background: changed ? '#ecfdf5' : selected ? '#dbeafe' : undefined,
                            outline: selected ? '1px solid #93c5fd' : undefined,
                            fontWeight: changed ? 700 : 400 }}>
                          {editingCell === k ? (
                            <input ref={inputRef} defaultValue={fmtVal(val)}
                              onBlur={e => { setValue(row.id, field, e.target.value); setEditingCell(null); }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { setValue(row.id, field, (e.target as HTMLInputElement).value); setEditingCell(null); }
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                              style={{ width: '100%', minWidth: 90, border: '1px solid #6366f1', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                          ) : (
                            fmtVal(val)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── شريط المجاميع — يتغيّر مع كل حذف/إضافة/تعديل ── */}
        <div style={{
          borderTop: '2px solid #e2e8f0', background: '#f8fafc', padding: '8px 16px',
          display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12,
        }}>
          <span style={{ fontWeight: 800, color: '#0f172a' }}>
            📊 الصفوف: <span style={{ color: '#2563eb' }}>{sortedRows.length + newRows.length}</span>
          </span>

          {liveTotals.totalValue !== undefined && (
            <span style={{ fontWeight: 800, color: '#0f172a' }}>
              المجموع الكلي للمبلغ:{' '}
              <span style={{ color: '#059669', fontSize: 14 }}>
                {Number(liveTotals.totalValue.toFixed(2)).toLocaleString('en-US')}
              </span>
            </span>
          )}

          {liveTotals.quantity !== undefined && (
            <span style={{ fontWeight: 700, color: '#475569' }}>
              مجموع الكمية:{' '}
              <span style={{ color: '#7c3aed' }}>
                {Number(liveTotals.quantity.toFixed(2)).toLocaleString('en-US')}
              </span>
            </span>
          )}

          {selection && selection.cells > 1 && (
            <span style={{
              marginInlineStart: 'auto', background: '#dbeafe', border: '1px solid #93c5fd',
              borderRadius: 8, padding: '4px 12px', fontWeight: 800, color: '#1e40af',
            }}>
              🖱️ المحدَّد: {selection.cells} خلية · {selection.numeric} رقمية · المجموع{' '}
              <span style={{ fontSize: 14 }}>
                {Number(selection.sum.toFixed(2)).toLocaleString('en-US')}
              </span>
              <button onClick={() => { setSelStart(null); setSelEnd(null); }}
                title="إلغاء التحديد"
                style={{ marginInlineStart: 8, border: 'none', background: 'none', color: '#1e40af', cursor: 'pointer', fontWeight: 800 }}>✕</button>
            </span>
          )}

          {(!selection || selection.cells <= 1) && (
            <span style={{ marginInlineStart: 'auto', color: '#94a3b8', fontSize: 11 }}>
              اسحب بالماوس فوق الخلايا لمعرفة مجموعها
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
