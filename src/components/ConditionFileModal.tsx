// ════════════════════════════════════════════════════════════════════════════
// ConditionFileModal — فتح «ملف الكوديشن» داخل التطبيق: شيت (تبويب) لكل مندوب
// بمبيعاته من طلبيات البوت وإكسل الكوديشن، + ملخّص، + تصدير إكسل بنفس الشيتات.
// الخادم: GET /api/files/:id/condition-view و GET /api/files/:id/condition-export.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

type Row = {
  id: number; date: string; invoice: string; pharmacy: string; area: string; warehouse: string;
  item: string; company: string; quantity: number; bonus: number; unitPrice: number; total: number; source: string;
  rep?: string;
  /** طلبية ترانزيت من ملف المكتب — للقراءة فقط هنا */
  transit?: boolean; note?: string;
};
type Sheet = { rep: string; rows: Row[]; quantity: number; total: number; orders: number; all?: boolean };
type Month = { ym: string; label: string; count: number };

interface Props {
  fileId: number;
  fileName: string;
  currency: string;
  token: string | null;
  /** مالك الملف فقط يعدّل ويحذف */
  canEdit?: boolean;
  onClose: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const SUMMARY = '__summary__';
// شيت «كل مبيعات الشركة» — كل صفوف ايتمات الشركة مهما كان المندوب (ومنها «بلا مندوب»).
const COMPANY = '__company__';
const NO_REP = 'بلا مندوب';
// عمود الصف ← حقل التعديل في PATCH /api/files/:id/condition-rows/:saleId
const EDIT_COLS: { key: string; label: string; w: number; num?: boolean }[] = [
  { key: 'date', label: 'التاريخ', w: 128 }, { key: 'invoice', label: 'رقم الفاتورة', w: 90 },
  { key: 'pharmacy', label: 'الصيدلية', w: 150 }, { key: 'area', label: 'المنطقة', w: 100 },
  { key: 'warehouse', label: 'المذخر', w: 130 }, { key: 'item', label: 'الايتم', w: 160 },
  { key: 'company', label: 'الشركة', w: 100 }, { key: 'rep', label: 'المندوب', w: 120 },
  { key: 'quantity', label: 'الكمية', w: 64, num: true }, { key: 'bonus', label: 'البونص', w: 56, num: true },
  { key: 'unitPrice', label: 'السعر', w: 76, num: true }, { key: 'total', label: 'القيمة', w: 90, num: true },
];

export default function ConditionFileModal({ fileId, fileName, currency, token, canEdit = false, onClose }: Props) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [companySheet, setCompanySheet] = useState<Sheet | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [month, setMonth] = useState('all');
  const [tab, setTab] = useState(SUMMARY);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [savingCell, setSavingCell] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch(`/api/files/${fileId}/condition-view?month=${encodeURIComponent(month)}`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'تعذّر فتح الملف');
        if (!alive) return;
        setSheets(j.data.sheets);
        setCompanySheet(j.data.companySheet ?? null);
        setMonths(j.data.months?.months ?? []);
      } catch (e: any) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [fileId, token, month, reload]);

  // تبويب مندوب لم يعد موجوداً بعد تغيير الشهر ← الملخص.
  useEffect(() => {
    if (tab !== SUMMARY && tab !== COMPANY && !sheets.some(s => s.rep === tab)) setTab(SUMMARY);
  }, [sheets, tab]);

  const totals = useMemo(() => sheets.reduce(
    (a, s) => ({ orders: a.orders + s.orders, rows: a.rows + s.rows.length, quantity: a.quantity + s.quantity, total: a.total + s.total }),
    { orders: 0, rows: 0, quantity: 0, total: 0 },
  ), [sheets]);

  const exportExcel = async () => {
    setExporting(true); setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-export?month=${encodeURIComponent(month)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'تعذّر التصدير'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `الكوديشن${month !== 'all' ? `_${month}` : ''}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); }
    finally { setExporting(false); }
  };

  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const saveCell = async (row: Row, key: string, value: string) => {
    setSavingCell(`${row.id}:${key}`); setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-rows/${row.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ [key]: value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذّر الحفظ');
      setReload(n => n + 1);
    } catch (e: any) { setError(e.message); setReload(n => n + 1); }
    finally { setSavingCell(null); }
  };
  const deleteRow = async (row: Row) => {
    if (!window.confirm(`حذف هذا الصف نهائياً؟
${row.item} — ${row.pharmacy || ''}`)) return;
    setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/condition-rows/${row.id}`, { method: 'DELETE', headers: authJson });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'تعذّر الحذف');
      setReload(n => n + 1);
    } catch (e: any) { setError(e.message); }
  };

  const current = tab === COMPANY ? companySheet : sheets.find(s => s.rep === tab);
  const hasData = sheets.length > 0 || (companySheet?.rows.length ?? 0) > 0;
  const th: CSSProperties = { padding: '6px 8px', background: '#f1f5f9', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap', textAlign: 'center', position: 'sticky', top: 0 };
  const td: CSSProperties = { padding: '5px 8px', borderTop: '1px solid #e2e8f0', fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' };
  const tabBtn = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? 'var(--c-accent)' : '#e2e8f0'}`, background: active ? 'var(--c-accent-light)' : '#fff',
    color: active ? 'var(--c-accent)' : '#334155', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 14, width: 'min(1100px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: '1 1 200px' }}>📋 {fileName}</h3>
          <select value={month} onChange={e => setMonth(e.target.value)} style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: '5px 8px', fontSize: 12 }}>
            <option value="all">كل الأشهر</option>
            {months.map(m => <option key={m.ym} value={m.ym}>{m.label}</option>)}
          </select>
          <button onClick={exportExcel} disabled={exporting || loading || !hasData}
            style={{ border: '1px solid var(--c-success-border)', background: 'var(--c-success-bg)', color: 'var(--c-success)', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {exporting ? '⏳ جاري التصدير…' : '⬇️ تصدير إكسل (شيت لكل مندوب)'}
          </button>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {error && <div style={{ color: 'var(--c-danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>جاري التحميل…</div>
        ) : !hasData ? (
          <div style={{ color: '#94a3b8', fontSize: 13, background: '#f8fafc', borderRadius: 8, padding: 20, textAlign: 'center' }}>
            لا توجد مبيعات في ملف الكوديشن{month !== 'all' ? ' لهذا الشهر' : ''} بعد. تُضاف إليه طلبيات بوت تلكرام عند حفظها وإكسل الكوديشن عند رفعه، وطلبيات الترانزيت من ملف المكتب المفعّل.
          </div>
        ) : (
          <>
            {/* الشيتات: ملخّص + مندوب لكل تبويب */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #e2e8f0' }}>
              <button onClick={() => setTab(SUMMARY)} style={tabBtn(tab === SUMMARY)}>📊 الملخص</button>
              {companySheet && (
                <button onClick={() => setTab(COMPANY)} style={tabBtn(tab === COMPANY)}
                  title="كل مبيعات الشركة في الملف مهما كان المندوب — ومنها الطلبيات المحفوظة بلا مندوب">
                  🏢 كل مبيعات الشركة <span style={{ color: '#94a3b8', fontWeight: 400 }}>({companySheet.rows.length})</span>
                </button>
              )}
              {sheets.map(s => (
                <button key={s.rep} onClick={() => setTab(s.rep)} style={tabBtn(tab === s.rep)}>
                  {s.rep} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({s.rows.length})</span>
                </button>
              ))}
            </div>

            <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
              {tab === SUMMARY || !current ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0' }}>
                  <thead>
                    <tr>
                      <th style={th}>المندوب</th><th style={th}>عدد الطلبيات</th><th style={th}>الصفوف</th>
                      <th style={th}>الكمية</th><th style={th}>القيمة ({currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheets.map(s => (
                      <tr key={s.rep} onClick={() => setTab(s.rep)} style={{ cursor: 'pointer' }}>
                        <td style={{ ...td, fontWeight: 700, textAlign: 'right' }}>{s.rep}</td>
                        <td style={td}>{fmt(s.orders)}</td>
                        <td style={td}>{fmt(s.rows.length)}</td>
                        <td style={td}>{fmt(s.quantity)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmt(s.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800, textAlign: 'right' }}>المجموع</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.orders)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.rows)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.quantity)}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(totals.total)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0' }}>
                  <thead>
                    <tr>
                      {EDIT_COLS.map(c => <th key={c.key} style={th}>{c.label}</th>)}
                      <th style={th}>المصدر</th>
                      {canEdit && <th style={th} />}
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows.map(r => {
                      // صف الترانزيت يعيش في ملف المكتب — لا يُعدَّل ولا يُحذف من هنا.
                      const editable = canEdit && !r.transit;
                      return (
                      <tr key={r.id} style={r.transit ? { background: '#f0f9ff' } : undefined} title={r.transit ? r.note : undefined}>
                        {EDIT_COLS.map(c => {
                          const val = c.key === 'rep' ? (current.all ? (r.rep || NO_REP) : current.rep) : String((r as any)[c.key] ?? '');
                          const busy = savingCell === `${r.id}:${c.key}`;
                          return (
                            <td key={c.key} style={{ ...td, padding: editable ? 2 : td.padding, opacity: busy ? 0.5 : 1,
                              ...(c.key === 'rep' && val === NO_REP ? { background: '#fef3c7', color: '#92400e', fontWeight: 700 } : null) }}>
                              {editable ? (
                                <input
                                  defaultValue={(val === '0' && (c.key === 'bonus' || c.key === 'unitPrice')) || (c.key === 'rep' && val === NO_REP) ? '' : val}
                                  placeholder={c.key === 'rep' && val === NO_REP ? NO_REP : undefined}
                                  key={`${r.id}-${c.key}-${val}`}
                                  type={c.key === 'date' ? 'date' : 'text'}
                                  inputMode={c.num ? 'decimal' : undefined}
                                  onBlur={e => { if (e.target.value.trim() !== (c.key === 'rep' && val === NO_REP ? '' : val.trim()) && !(c.num && !e.target.value.trim() && (val === '0' || val === ''))) saveCell(r, c.key, e.target.value); }}
                                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                  style={{ width: c.w, border: '1px solid transparent', borderRadius: 6, padding: '4px 6px', fontSize: 12, textAlign: c.num ? 'center' : 'right', background: 'transparent' }}
                                  onFocus={e => { e.target.style.border = '1px solid var(--c-accent)'; e.target.style.background = '#fff'; }}
                                  onBlurCapture={e => { e.target.style.border = '1px solid transparent'; e.target.style.background = 'transparent'; }}
                                />
                              ) : (c.num ? (val && val !== '0' ? fmt(Number(val)) : '—') : (val || '—'))}
                            </td>
                          );
                        })}
                        <td style={{ ...td, color: '#64748b' }}>
                          {r.transit
                            ? <span style={{ background: '#e0f2fe', color: '#0369a1', border: '1px solid #7dd3fc', borderRadius: 6, padding: '1px 8px', fontWeight: 700 }}>🔁 ترانزيت</span>
                            : (r.source || '—')}
                        </td>
                        {canEdit && (
                          <td style={td}>
                            {!r.transit && <button onClick={() => deleteRow(r)} title="حذف الصف" style={{ border: '1px solid var(--c-danger-border)', background: 'var(--c-danger-bg)', color: 'var(--c-danger)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>×</button>}
                          </td>
                        )}
                      </tr>
                      );
                    })}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800 }} colSpan={8}>المجموع — {fmt(current.orders)} طلبية</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.quantity)}</td>
                      <td style={td} colSpan={2} />
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.total)}</td>
                      <td style={td} colSpan={canEdit ? 2 : 1} />
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
