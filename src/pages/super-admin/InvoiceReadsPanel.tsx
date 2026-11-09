import { useEffect, useState } from 'react';
import { Spinner, ErrBox, UI } from './OfficesPage';

// «🖼️ الصور المحلَّلة» — صورة لكل قراءة فاتورة مع المرسل والتاريخ والتوكنز والكلفة.
// المصدر: InvoiceReadLog (server/lib/invoiceReadLog.js). الصور محمية بتوكن الماستر
// فتُجلب blob وتُعرض بـ object URL (وسم <img> لا يرسل ترويسة Authorization).

interface ReadLog {
  id: number; createdAt: string; source: string;
  userName: string | null; senderName: string | null; chatTitle: string | null;
  warehouse: string | null; card: string | null; mode: string | null; retried: boolean;
  pharmacy: string | null; area: string | null; rowCount: number;
  calls: number; promptTokens: number; outputTokens: number; costUsd: number; durationMs: number;
  ok: boolean; error: string | null; hasImage: boolean;
}
interface ListResp { rows: ReadLog[]; total: number; page: number; pageSize: number; sums: { images: number; calls: number; tokens: number; costUsd: number } }

const SOURCE: Record<string, string> = {
  telegram: '✈️ تلكرام', whatsapp: '🟢 واتساب', 'wa-groups': '👥 كروب واتساب', viber: '🟣 فايبر',
  site: '🌐 الموقع', 'rep-orders': '📦 طلبيات المذاخر', 'warehouse-group': '🚚 كروب مذخر',
};
// «telegram (مبيعي)» ← «✈️ تلكرام (مبيعي)»
const sourceLabel = (s: string) => { const base = s.split(' ')[0]; return (SOURCE[base] || base) + s.slice(base.length); };
const MODE: Record<string, { t: string; c: string }> = {
  strong: { t: '💪 الأقوى', c: '#4f46e5' }, lite: { t: '💰 الأرخص', c: '#0891b2' }, auto: { t: '🧠 تلقائي', c: '#16a34a' },
};
const fmt = (n: number) => (n ?? 0).toLocaleString('en-US');
const usd = (n: number) => `$${(n ?? 0).toFixed(4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Baghdad', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function useAuthImage(url: string | null, token: string | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true, obj: string | null = null;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : null))
      .then(b => { if (b && alive) { obj = URL.createObjectURL(b); setSrc(obj); } })
      .catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url, token]);
  return src;
}

function Thumb({ id, token, onOpen }: { id: number; token: string | null; onOpen: (src: string) => void }) {
  const src = useAuthImage(`/api/sa/ai-usage/invoices/${id}/image`, token);
  return (
    <div onClick={() => src && onOpen(src)} title="تكبير"
      style={{ width: 54, height: 54, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', overflow: 'hidden', cursor: src ? 'zoom-in' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 18, color: '#cbd5e1' }}>🖼️</span>}
    </div>
  );
}

const th: React.CSSProperties = { padding: '9px 10px', fontSize: 11.5, fontWeight: 700, color: '#64748b', textAlign: 'start', whiteSpace: 'nowrap', background: '#f8fafc', borderBottom: '1px solid #e9edf3' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12.5, color: UI.ink, borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

export default function InvoiceReadsPanel({ token, days }: { token: string | null; days: number }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [big, setBig] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [days]);
  useEffect(() => {
    setLoading(true); setErr('');
    fetch(`/api/sa/ai-usage/invoices?days=${days}&page=${page}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setData(d.data); else setErr(d.error || 'خطأ'); })
      .catch(() => setErr('تعذّر الاتصال'))
      .finally(() => setLoading(false));
  }, [days, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const avg = data && data.sums.images ? data.sums.costUsd / data.sums.images : 0;

  return (
    <div>
      {err && <ErrBox msg={err} />}
      {data && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {[
            ['🖼️ صور محلَّلة', fmt(data.sums.images)],
            ['📞 نداءات', fmt(data.sums.calls)],
            ['🔢 توكنز', fmt(data.sums.tokens)],
            ['💵 الكلفة', usd(data.sums.costUsd)],
            ['📊 معدّل الصورة', usd(avg)],
          ].map(([l, v]) => (
            <div key={l} style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: '10px 14px', minWidth: 120 }}>
              <div style={{ fontSize: 11.5, color: UI.faint }}>{l}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: UI.ink, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: UI.faint, marginBottom: 10, lineHeight: 1.6 }}>
        كل صورة فاتورة قُرئت بالذكاء منذ تفعيل هذا السجل، بكل نداءاتها مجموعة (الاتجاه + القراءة + الإعادة بالأقوى + سطر الزبون). الكلفة تقديرية بأسعار Gemini الحالية. الصور تُحفظ مصغّرة 60 يوماً.
      </div>

      {loading ? <Spinner /> : data && (
        data.rows.length === 0
          ? <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 24, textAlign: 'center', color: UI.faint, fontSize: 13 }}>لا توجد صور محلَّلة في هذه الفترة بعد — أرسل صورة فاتورة للبوت وستظهر هنا.</div>
          : (
            <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                <thead>
                  <tr>
                    {['الصورة', 'التاريخ', 'الحساب', 'المصدر / المرسل', 'المذخر', 'الصيدلية', 'أصناف', 'النموذج', 'نداءات', 'توكنز (إدخال/إخراج)', 'الكلفة', 'الحالة'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.id} style={{ background: r.ok ? undefined : '#fff7f7' }}>
                      <td style={td}>{r.hasImage ? <Thumb id={r.id} token={token} onOpen={setBig} /> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', direction: 'ltr', textAlign: 'end' }}>{when(r.createdAt)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{r.userName || '—'}</td>
                      <td style={td}>
                        <div style={{ whiteSpace: 'nowrap' }}>{sourceLabel(r.source)}</div>
                        {(r.senderName || r.chatTitle) && <div style={{ fontSize: 11.5, color: UI.faint }}>{[r.senderName, r.chatTitle && `(${r.chatTitle})`].filter(Boolean).join(' ')}</div>}
                      </td>
                      <td style={td}>
                        <div>{r.warehouse || '—'}</div>
                        {r.card && <span title="قُرئت ببطاقة المذخر" style={{ fontSize: 10.5, fontWeight: 700, color: '#7c3aed', background: '#f5f3ff', borderRadius: 999, padding: '1px 7px' }}>🗂️ بطاقة</span>}
                      </td>
                      <td style={td}>
                        <div>{r.pharmacy || '—'}</div>
                        {r.area && <div style={{ fontSize: 11.5, color: UI.faint }}>{r.area}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.rowCount}</td>
                      <td style={td}>
                        {r.mode && MODE[r.mode] ? <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: MODE[r.mode].c, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{MODE[r.mode].t}</span> : '—'}
                        {r.retried && <div style={{ fontSize: 10.5, color: '#b45309', marginTop: 3, whiteSpace: 'nowrap' }}>🔁 أُعيدت بالأقوى</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.calls}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <b>{fmt(r.promptTokens + r.outputTokens)}</b>
                        <div style={{ fontSize: 11, color: UI.faint }}>{fmt(r.promptTokens)} / {fmt(r.outputTokens)}</div>
                      </td>
                      <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap', color: r.costUsd > 0.008 ? '#b91c1c' : '#15803d' }}>{usd(r.costUsd)}</td>
                      <td style={td} title={r.error || ''}>{r.ok ? '✅' : <span style={{ color: '#b91c1c', fontSize: 12 }}>❌ {r.error ? r.error.slice(0, 40) : ''}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {data && pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 12, fontSize: 13 }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: page > 1 ? 'pointer' : 'default' }}>→ السابق</button>
          <span style={{ color: UI.muted }}>صفحة {page} من {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: page < pages ? 'pointer' : 'default' }}>التالي ←</button>
        </div>
      )}

      {big && (
        <div onClick={() => setBig(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out' }}>
          <img src={big} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,.4)' }} />
        </div>
      )}
    </div>
  );
}
