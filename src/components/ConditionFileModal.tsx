// ════════════════════════════════════════════════════════════════════════════
// ConditionFileModal — فتح «ملف الكوديشن» داخل التطبيق: شيت (تبويب) لكل مندوب
// بمبيعاته من طلبيات البوت وإكسل الكوديشن، + ملخّص، + تصدير إكسل بنفس الشيتات.
// الخادم: GET /api/files/:id/condition-view و GET /api/files/:id/condition-export.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

type Row = {
  id: number; date: string; invoice: string; pharmacy: string; area: string; warehouse: string;
  item: string; company: string; quantity: number; bonus: number; unitPrice: number; total: number; source: string;
};
type Sheet = { rep: string; rows: Row[]; quantity: number; total: number; orders: number };
type Month = { ym: string; label: string; count: number };

interface Props {
  fileId: number;
  fileName: string;
  currency: string;
  token: string | null;
  onClose: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const SUMMARY = '__summary__';

export default function ConditionFileModal({ fileId, fileName, currency, token, onClose }: Props) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [months, setMonths] = useState<Month[]>([]);
  const [month, setMonth] = useState('all');
  const [tab, setTab] = useState(SUMMARY);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

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
        setMonths(j.data.months?.months ?? []);
      } catch (e: any) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [fileId, token, month]);

  // تبويب مندوب لم يعد موجوداً بعد تغيير الشهر ← الملخص.
  useEffect(() => {
    if (tab !== SUMMARY && !sheets.some(s => s.rep === tab)) setTab(SUMMARY);
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

  const current = sheets.find(s => s.rep === tab);
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
          <button onClick={exportExcel} disabled={exporting || loading || sheets.length === 0}
            style={{ border: '1px solid var(--c-success-border)', background: 'var(--c-success-bg)', color: 'var(--c-success)', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {exporting ? '⏳ جاري التصدير…' : '⬇️ تصدير إكسل (شيت لكل مندوب)'}
          </button>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {error && <div style={{ color: 'var(--c-danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>جاري التحميل…</div>
        ) : sheets.length === 0 ? (
          <div style={{ color: '#94a3b8', fontSize: 13, background: '#f8fafc', borderRadius: 8, padding: 20, textAlign: 'center' }}>
            لا توجد مبيعات في ملف الكوديشن{month !== 'all' ? ' لهذا الشهر' : ''} بعد. تُضاف إليه طلبيات بوت تلكرام عند حفظها وإكسل الكوديشن عند رفعه.
          </div>
        ) : (
          <>
            {/* الشيتات: ملخّص + مندوب لكل تبويب */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #e2e8f0' }}>
              <button onClick={() => setTab(SUMMARY)} style={tabBtn(tab === SUMMARY)}>📊 الملخص</button>
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
                      <th style={th}>التاريخ</th><th style={th}>رقم الفاتورة</th><th style={th}>الصيدلية</th><th style={th}>المنطقة</th>
                      <th style={th}>المذخر</th><th style={th}>الايتم</th><th style={th}>الكمية</th><th style={th}>البونص</th>
                      <th style={th}>السعر</th><th style={th}>القيمة</th><th style={th}>المصدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.rows.map(r => (
                      <tr key={r.id}>
                        <td style={td}>{r.date || '—'}</td>
                        <td style={td}>{r.invoice || '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{r.pharmacy || '—'}</td>
                        <td style={td}>{r.area || '—'}</td>
                        <td style={td}>{r.warehouse || '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{r.item}</td>
                        <td style={td}>{fmt(r.quantity)}</td>
                        <td style={td}>{r.bonus ? fmt(r.bonus) : '—'}</td>
                        <td style={td}>{r.unitPrice ? fmt(r.unitPrice) : '—'}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmt(r.total)}</td>
                        <td style={{ ...td, color: '#64748b' }}>{r.source || '—'}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f8fafc' }}>
                      <td style={{ ...td, fontWeight: 800 }} colSpan={6}>المجموع — {fmt(current.orders)} طلبية</td>
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.quantity)}</td>
                      <td style={td} colSpan={2} />
                      <td style={{ ...td, fontWeight: 800 }}>{fmt(current.total)}</td>
                      <td style={td} />
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
