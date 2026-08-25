import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Row {
  id: number;
  repName: string; areaName: string; itemName: string; customerName: string;
  quantity: number; totalValue: number; saleDate: string; recordType: string;
  extra: Record<string, any>;
}
interface CoreCol { key: string; label: string }

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
  const [coreCols, setCoreCols] = useState<CoreCol[]>([]);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const [edited, setEdited]     = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [search, setSearch]     = useState('');

  // تغييرات معلّقة
  const [pending, setPending]       = useState<Map<string, Edit>>(new Map());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [deletedCols, setDeletedCols] = useState<Set<string>>(new Set());
  const [newRows, setNewRows]       = useState<any[]>([]);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    setLoading(true); setErr('');
    fetch(`${API}/api/files/${fileId}/rows`, { headers: H() })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل الصفوف');
        setRows(j.data.rows || []);
        setCoreCols(j.data.coreColumns || []);
        setExtraCols(j.data.extraColumns || []);
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

  const visibleExtra = useMemo(() => extraCols.filter(c => !deletedCols.has(c)), [extraCols, deletedCols]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const live = rows.filter(r => !deletedIds.has(r.id));
    if (!q) return live;
    return live.filter(r =>
      [r.repName, r.areaName, r.itemName, r.customerName, String(r.quantity), String(r.totalValue), r.saleDate]
        .some(v => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [rows, deletedIds, search]);

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
      extra: Object.fromEntries(visibleExtra.map(c => [c, ''])),
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

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>⏳ جاري تحميل الصفوف...</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 34 }} />
                  <th style={{ ...TH, width: 46 }}>#</th>
                  {coreCols.map(c => <th key={c.key} style={TH}>{c.label}</th>)}
                  {visibleExtra.map(c => (
                    <th key={c} style={TH}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {c}
                        <button
                          onClick={() => { if (confirm('حذف عمود «' + c + '» من كل صفوف الملف؟')) setDeletedCols(p => new Set(p).add(c)); }}
                          title="حذف هذا العمود من كل الصفوف"
                          style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}
                        >✕</button>
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
                    {coreCols.map(c => (
                      <td key={c.key} style={TD}>
                        <input value={nr[c.key] ?? ''} onChange={e => setNewVal(nr._tmp, c.key, e.target.value)}
                          style={{ width: '100%', minWidth: 90, border: '1px solid #ddd6fe', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                      </td>
                    ))}
                    {visibleExtra.map(c => (
                      <td key={c} style={TD}>
                        <input value={nr.extra?.[c] ?? ''} onChange={e => setNewVal(nr._tmp, c, e.target.value)}
                          style={{ width: '100%', minWidth: 90, border: '1px solid #ddd6fe', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                      </td>
                    ))}
                  </tr>
                ))}
                {filtered.map((row, idx) => (
                  <tr key={row.id} style={{ background: idx % 2 ? '#fafbfc' : '#fff' }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => setDeletedIds(p => new Set(p).add(row.id))}
                        title="حذف هذا الصف" style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer' }}>✕</button>
                    </td>
                    <td style={{ ...TD, color: '#94a3b8' }}>{idx + 1}</td>
                    {[...coreCols.map(c => c.key), ...visibleExtra].map(field => {
                      const k = cellKey(row.id, field);
                      const changed = pending.has(k);
                      const val = getValue(row, field);
                      return (
                        <td key={field}
                          onClick={() => { setEditingCell(k); requestAnimationFrame(() => inputRef.current?.focus()); }}
                          style={{ ...TD, background: changed ? '#ecfdf5' : undefined, fontWeight: changed ? 700 : 400 }}>
                          {editingCell === k ? (
                            <input ref={inputRef} defaultValue={val ?? ''}
                              onBlur={e => { setValue(row.id, field, e.target.value); setEditingCell(null); }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { setValue(row.id, field, (e.target as HTMLInputElement).value); setEditingCell(null); }
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                              style={{ width: '100%', minWidth: 90, border: '1px solid #6366f1', borderRadius: 4, padding: '2px 4px', fontSize: 12, direction: 'rtl' }} />
                          ) : (
                            String(val ?? '')
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
      </div>
    </div>
  );
}
