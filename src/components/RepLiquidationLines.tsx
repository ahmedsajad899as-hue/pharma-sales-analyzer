// ════════════════════════════════════════════════════════════════════════════
// RepLiquidationLines — «لكوديشن المندوب» سطراً سطراً، من زر أعلى نافذة «فرق المحافظات».
// GET /api/province-teams/rep-lines: نفس بيانات رقم المندوب في النافذة (مبيعاته المؤكدة +
// ميركاتو وملف اللكوديشن باسمه، بلا تكرار)، فالمجموع يطابقه. القيم بالدولار و fmtVal تحوّلها.
// ════════════════════════════════════════════════════════════════════════════

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import FitToWidth from './FitToWidth';
import { useIsMobile } from '../hooks/useIsMobile';

interface Line {
  date: string; invoice: string; pharmacy: string; area: string; province: string; warehouse: string;
  itemId: number | null; item: string; company: string; quantity: number; bonus: number; usd: number; source: string;
}

interface Props {
  token: string | null;
  fileIds: number[];
  applyMonth: (p: URLSearchParams) => void;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  repUserId: number;
  repName: string;
  province: string;
  onClose: () => void;
}

const nf = (n: number) => Math.round(n).toLocaleString('en-US');
const SOURCE_STYLE: Record<string, React.CSSProperties> = {
  'ميركاتو':          { background: '#ede9fe', color: '#6d28d9', borderColor: '#c4b5fd' },
  'مبيعات المندوب':   { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' },
  'إرجاع':            { background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' },
};
const DEFAULT_SOURCE: React.CSSProperties = { background: '#e0f2fe', color: '#0369a1', borderColor: '#7dd3fc' };

export default function RepLiquidationLines({ token, fileIds, applyMonth, fmtVal, currencyLabel, repUserId, repName, province, onClose }: Props) {
  const [rows, setRows] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const isMobile = useIsMobile();

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const p = new URLSearchParams();
        applyMonth(p);
        if (fileIds.length) p.set('fileIds', fileIds.join(','));
        p.set('repUserId', String(repUserId));
        p.set('province', province);
        const r = await fetch(`/api/province-teams/rep-lines?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        const j = await r.json();
        if (!r.ok || j.success === false) throw new Error(j.message || 'تعذّر تحميل اللكوديشن');
        setRows(j.rows ?? []);
      } catch (e: any) { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل اللكوديشن'); }
      finally { if (!ac.signal.aborted) setLoading(false); }
    })();
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repUserId, province]);

  const shown = useMemo(() => {
    const s = q.trim();
    if (!s) return rows;
    return rows.filter(r => [r.pharmacy, r.item, r.area, r.warehouse, r.invoice, r.company, r.source, r.date].some(x => (x || '').includes(s)));
  }, [rows, q]);

  const total = useMemo(() => shown.reduce((a, r) => ({ qty: a.qty + r.quantity, bonus: a.bonus + (r.bonus || 0), usd: a.usd + r.usd }), { qty: 0, bonus: 0, usd: 0 }), [shown]);
  const orders = useMemo(() => new Set(shown.map(r => r.invoice || `${r.date}|${r.pharmacy}`)).size, [shown]);

  const th: React.CSSProperties = { padding: '8px 8px', fontSize: 12, fontWeight: 800, color: '#334155', background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'right', whiteSpace: isMobile ? 'normal' : 'nowrap', position: 'sticky', top: 0, zIndex: 1 };
  // الهاتف: النص يلتف والحشو أصغر كي يبقى الخط أكبر حين يُصغَّر الجدول ليلائم الشاشة
  const td: React.CSSProperties = { padding: isMobile ? '5px 4px' : '6px 8px', fontSize: 12.5, color: '#0f172a', borderBottom: '1px solid #eef2f7', whiteSpace: isMobile ? 'normal' : 'nowrap' };
  const num: React.CSSProperties = { ...td, textAlign: 'left', direction: 'ltr', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const dash = <span style={{ color: '#cbd5e1' }}>—</span>;

  return (
    <div dir="rtl" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(1400px, 100%)', height: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: '#0f172a' }}>لكوديشن {repName}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>{province} · مبيعاته المؤكدة + ميركاتو وملف اللكوديشن باسمه، بلا تكرار</div>
          </div>
          <span style={{ flex: 1 }} />
          {!loading && !err && (
            <span style={{ fontSize: 12.5, color: '#334155', fontWeight: 700 }}>
              {nf(orders)} طلبية · {nf(shown.length)} سطر · <bdi dir="ltr">{fmtVal(total.usd)} {currencyLabel}</bdi>
            </span>
          )}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث: صيدلية / ايتم / منطقة / مذخر / فاتورة"
            style={{ minWidth: 220, border: '1px solid #cbd5e1', borderRadius: 999, padding: '7px 14px', fontSize: 13 }} />
          <button type="button" onClick={onClose} style={{ border: 'none', background: '#f1f5f9', borderRadius: 999, width: 32, height: 32, cursor: 'pointer', fontSize: 16 }} aria-label="إغلاق">✕</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
          {loading && <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>جاري التحميل…</div>}
          {err && <div style={{ color: '#be123c', padding: 12 }}>{err}</div>}
          {!loading && !err && shown.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>{rows.length ? 'لا نتائج لهذا البحث.' : 'لا يوجد لكوديشن لهذا المندوب في هذه المحافظة للفترة المختارة.'}</div>
          )}
          {!loading && !err && shown.length > 0 && (
            <FitToWidth>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>التاريخ</th>
                  <th style={th}>رقم الفاتورة</th>
                  <th style={th}>الصيدلية</th>
                  <th style={th}>المنطقة</th>
                  <th style={th}>المحافظة</th>
                  <th style={th}>المذخر</th>
                  <th style={th}>الايتم</th>
                  <th style={th}>الشركة</th>
                  <th style={{ ...th, textAlign: 'left' }}>الكمية</th>
                  <th style={{ ...th, textAlign: 'left' }}>البونص</th>
                  <th style={{ ...th, textAlign: 'left' }}>السعر</th>
                  <th style={{ ...th, textAlign: 'left' }}>القيمة ({currencyLabel})</th>
                  <th style={th}>المصدر</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 ? '#fbfcfe' : '#fff' }}>
                    <td style={{ ...num, textAlign: 'right' }}>{r.date || dash}</td>
                    <td style={{ ...td, direction: 'ltr', textAlign: 'right' }}>{r.invoice || dash}</td>
                    <td style={{ ...td, whiteSpace: 'normal', minWidth: 140 }}>{r.pharmacy || dash}</td>
                    <td style={td}>{r.area || dash}</td>
                    <td style={td}>{r.province || dash}</td>
                    <td style={{ ...td, whiteSpace: 'normal' }}>{r.warehouse || dash}</td>
                    <td style={{ ...td, direction: 'ltr', textAlign: 'right', fontWeight: 600 }}>{r.item || dash}</td>
                    <td style={{ ...td, color: '#64748b' }}>{r.company || dash}</td>
                    <td style={{ ...num, color: r.quantity < 0 ? '#be123c' : undefined }}>{nf(r.quantity)}</td>
                    <td style={num}>{r.bonus ? nf(r.bonus) : dash}</td>
                    <td style={num}>{r.quantity ? fmtVal(r.usd / r.quantity) : dash}</td>
                    <td style={{ ...num, fontWeight: 700, color: r.usd < 0 ? '#be123c' : undefined }}>{fmtVal(r.usd)}</td>
                    <td style={td}>
                      <span style={{ border: '1px solid', borderRadius: 6, padding: '1px 8px', fontSize: 11.5, fontWeight: 700, ...(SOURCE_STYLE[r.source] ?? DEFAULT_SOURCE) }}>{r.source}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 900 }}>
                  <td colSpan={8} style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1', textAlign: 'center' }}>المجموع — {nf(orders)} طلبية</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{nf(total.qty)}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{total.bonus ? nf(total.bonus) : ''}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{fmtVal(total.usd)}</td>
                  <td style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                </tr>
              </tfoot>
            </table>
            </FitToWidth>
          )}
        </div>
      </div>
    </div>
  );
}
