import { Fragment, useEffect, useState } from 'react';
import { Spinner, ErrBox, UI } from './OfficesPage';
import { Seg, Stat, statGrid } from './saKit';

// «🖼️ الصور المحلَّلة» — صورة لكل قراءة فاتورة مع المرسل والتاريخ والتوكنز والكلفة.
// المصدر: InvoiceReadLog (server/lib/invoiceReadLog.js). الصور محمية بتوكن الماستر
// فتُجلب blob وتُعرض بـ object URL (وسم <img> لا يرسل ترويسة Authorization).

interface ReadLog {
  id: number; createdAt: string; source: string;
  userName: string | null; senderName: string | null; chatTitle: string | null;
  warehouse: string | null; card: string | null; mode: string | null; retried: boolean; retryPart: string | null;
  pharmacy: string | null; area: string | null; rowCount: number;
  calls: number; promptTokens: number; outputTokens: number; costUsd: number; durationMs: number;
  ok: boolean; error: string | null; hasImage: boolean;
  kind: 'photo' | 'text' | 'pdf'; sourceText: string | null; readBy: string | null;
  routedTo: { orderId: number | null; userId: number | null; name: string | null; forwarded: boolean }[] | null;
  details: {
    invoiceNumber: string | null; date: string | null; items: (string | number | null)[][];
    orient?: { deg: number; by: string; localWas?: number | null } | null;
    pdf?: { pages: number; how: string } | null;
    gate?: { best: number | null; how: string; open: number } | null;
    purpose?: string;
  } | null;
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
// «تلقائي»: ما أُعيد بالأقوى وحده
const RETRY_PART: Record<string, string> = {
  rows: 'أسطر فقط', customer: 'الزبون فقط', 'rows+customer': 'أسطر والزبون', full: 'كاملة', text: 'نص PDF',
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

/** ملف PDF محفوظ مع السجل: يُجلب بالتوكن ويُفتح في تبويب. */
function PdfTile({ id, token, has }: { id: number; token: string | null; has: boolean }) {
  const open = () => {
    if (!has) return;
    fetch(`/api/sa/ai-usage/invoices/${id}/image`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : null))
      .then(b => { if (b) window.open(URL.createObjectURL(b), '_blank', 'noopener'); })
      .catch(() => {});
  };
  return (
    <div onClick={open} title={has ? 'فتح ملف PDF' : 'ملف PDF'}
      style={{ width: 54, height: 54, borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, cursor: has ? 'pointer' : 'default' }}>
      PDF
    </div>
  );
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
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [kind, setKind] = useState<'' | 'photo' | 'text'>('');
  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  useEffect(() => { setPage(1); }, [days, kind]);
  useEffect(() => {
    setLoading(true); setErr('');
    fetch(`/api/sa/ai-usage/invoices?days=${days}&page=${page}${kind ? `&kind=${kind}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setData(d.data); else setErr(d.error || 'خطأ'); })
      .catch(() => setErr('تعذّر الاتصال'))
      .finally(() => setLoading(false));
  }, [days, page, kind]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const avg = data && data.sums.images ? data.sums.costUsd / data.sums.images : 0;

  return (
    <div>
      {err && <ErrBox msg={err} />}
      <div style={{ marginBottom: 10 }}>
        <Seg value={kind} onChange={setKind} options={[['', 'الكل'], ['photo', 'صور الفواتير'], ['text', 'المكتوبة']] as const} />
      </div>
      {data && (
        <div style={statGrid}>
          <Stat label="طلبيات محلَّلة" value={fmt(data.sums.images)} />
          <Stat label="نداءات" value={fmt(data.sums.calls)} />
          <Stat label="توكنز" value={fmt(data.sums.tokens)} />
          <Stat label="الكلفة" value={usd(data.sums.costUsd)} sub={`معدّل الطلبية ${usd(avg)}`} />
        </div>
      )}

      {loading ? <Spinner /> : data && (
        data.rows.length === 0
          ? <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 24, textAlign: 'center', color: UI.faint, fontSize: 13 }}>لا توجد طلبيات محلَّلة في هذه الفترة</div>
          : (
            <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1120 }}>
                <thead>
                  <tr>
                    {['الطلبية', 'التاريخ', 'الحساب', 'وصلت إلى', 'المصدر / المرسل', 'المذخر', 'الصيدلية', 'أصناف', 'النموذج', 'نداءات', 'توكنز (إدخال/إخراج)', 'الكلفة', 'الحالة', ''].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <Fragment key={r.id}>
                    <tr style={{ background: r.ok ? undefined : '#fff7f7' }}>
                      <td style={td}>
                        {r.kind === 'text'
                          ? <div title={r.sourceText || ''} onClick={() => toggle(r.id)} style={{ width: 54, height: 54, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f0f9ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, cursor: 'pointer' }}>💬</div>
                          : r.kind === 'pdf' ? <PdfTile id={r.id} token={token} has={r.hasImage} />
                          : r.hasImage ? <Thumb id={r.id} token={token} onOpen={setBig} /> : <span style={{ color: '#cbd5e1' }}>—</span>}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', direction: 'ltr', textAlign: 'end' }}>{when(r.createdAt)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{r.userName || '—'}</td>
                      <td style={td}>
                        {r.routedTo?.length ? r.routedTo.map((o, i) => (
                          <div key={i} style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                            {o.forwarded ? <span title="حُوِّلت لمدير الشركة صاحب الأصناف" style={{ color: '#7c3aed', fontWeight: 700 }}>↪️ {o.name || '—'}</span> : <span>{o.name || '—'}</span>}
                            {o.orderId && <span style={{ color: UI.faint, fontSize: 11 }}> #{o.orderId}</span>}
                          </div>
                        )) : r.readBy === 'gate'
                          ? <span title={`فحص سريع: لا تطابق أيّاً من الطلبيات المفتوحة${r.details?.gate?.open ? ` (${r.details.gate.open})` : ''} — بلا قراءة كاملة`} style={{ fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap' }}>🔎 لا تخصّ طلبية</span>
                          : <span style={{ color: '#cbd5e1' }}>—</span>}
                      </td>
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
                        {r.kind === 'text' ? (
                          <span title={r.mode ? `وضع الكروب: ${({ both: 'الاثنين', ai: 'الذكاء', parser: 'المحلل' } as Record<string, string>)[r.mode] || r.mode}` : ''}
                            style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: r.readBy === 'parser' ? '#0891b2' : '#2563eb', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                            {r.readBy === 'parser' ? '⚡ المحلل' : '🤖 الذكاء'}
                          </span>
                        ) : r.readBy === 'gate' ? (
                          <span title="قُرئ اسم الزبون والأصناف فقط (أرخص نموذج)" style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: '#64748b', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>🔎 فحص سريع</span>
                        ) : r.mode && MODE[r.mode] ? <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: MODE[r.mode].c, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{MODE[r.mode].t}</span> : '—'}
                        {r.retried && <div style={{ fontSize: 10.5, color: '#b45309', marginTop: 3, whiteSpace: 'nowrap' }}>🔁 بالأقوى: {RETRY_PART[r.retryPart || ''] || 'أُعيدت'}</div>}
                        {r.details?.orient?.by === 'local' && <div title={`الاتجاه حُسم محلياً بلا ذكاء (${r.details.orient.deg}°)`} style={{ fontSize: 10.5, color: '#0f766e', marginTop: 3, whiteSpace: 'nowrap' }}>🧭 اتجاه محلي</div>}
                        {r.kind === 'pdf' && r.details?.pdf && <div title={r.details.pdf.how === 'text' ? 'نصّ الملف قُرئ بلا صورة' : 'ملف ممسوح ضوئياً — قُرئ كصورة'} style={{ fontSize: 10.5, color: '#b91c1c', marginTop: 3, whiteSpace: 'nowrap' }}>📄 {r.details.pdf.how === 'text' ? 'نص PDF' : 'PDF ممسوح'}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>{r.calls}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <b>{fmt(r.promptTokens + r.outputTokens)}</b>
                        <div style={{ fontSize: 11, color: UI.faint }}>{fmt(r.promptTokens)} / {fmt(r.outputTokens)}</div>
                      </td>
                      <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap', color: r.costUsd > 0.008 ? '#b91c1c' : '#15803d' }}>{usd(r.costUsd)}</td>
                      <td style={td} title={r.error || ''}>{r.ok ? '✅' : <span style={{ color: '#b91c1c', fontSize: 12 }}>❌ {r.error ? r.error.slice(0, 40) : ''}</span>}</td>
                      <td style={td}>
                        {r.details?.items?.length || r.sourceText ? (
                          <button onClick={() => toggle(r.id)} style={{ padding: '4px 10px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: '1px solid #c7d2fe', background: open.has(r.id) ? '#4f46e5' : '#eef2ff', color: open.has(r.id) ? '#fff' : '#4338ca', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            📋 التفاصيل {open.has(r.id) ? '▴' : '▾'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open.has(r.id) && (r.details || r.sourceText) && (
                      <tr>
                        <td colSpan={14} style={{ padding: '4px 14px 14px', background: '#fafbff', borderBottom: '1px solid #e9edf3' }}>
                          {r.sourceText && (
                            <div style={{ margin: '8px 0', padding: '10px 12px', background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 8, fontSize: 13, color: UI.ink, whiteSpace: 'pre-wrap', lineHeight: 1.7, maxWidth: 520 }}>
                              <div style={{ fontSize: 11, color: UI.faint, marginBottom: 4 }}>💬 الرسالة الأصلية</div>
                              {r.sourceText}
                            </div>
                          )}
                          {r.details && <>
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: UI.muted, margin: '6px 0 8px' }}>
                            {r.kind !== 'text' && <span>🧾 رقم الفاتورة: <b style={{ color: UI.ink }}>{r.details.invoiceNumber || '—'}</b></span>}
                            <span>📅 التاريخ: <b style={{ color: UI.ink }}>{r.details.date || '—'}</b></span>
                            <span>🏬 المذخر: <b style={{ color: UI.ink }}>{r.warehouse || '—'}</b></span>
                            <span>💊 الصيدلية: <b style={{ color: UI.ink }}>{[r.pharmacy, r.area].filter(Boolean).join(' / ') || '—'}</b></span>
                          </div>
                          <table style={{ borderCollapse: 'collapse', background: '#fff', border: '1px solid #e9edf3', borderRadius: 8, minWidth: 520 }}>
                            <thead><tr>{['#', 'المادة', 'الكمية', 'البونص', 'سعر الوحدة', 'المجموع'].map(h => <th key={h} style={{ ...th, background: '#f1f5f9' }}>{h}</th>)}</tr></thead>
                            <tbody>
                              {r.details.items.map((it, i) => {
                                const n = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US'));
                                return (
                                  <tr key={i}>
                                    <td style={{ ...td, color: UI.faint }}>{i + 1}</td>
                                    <td style={{ ...td, direction: 'ltr', textAlign: 'start', fontWeight: 600 }}>{String(it[0] ?? '')}</td>
                                    <td style={{ ...td, textAlign: 'center' }}>{n(it[1])}</td>
                                    <td style={{ ...td, textAlign: 'center', color: Number(it[2]) ? '#15803d' : UI.faint }}>{n(it[2])}</td>
                                    <td style={td}>{n(it[3])}</td>
                                    <td style={{ ...td, fontWeight: 700 }}>{n(it[4])}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          </>}
                        </td>
                      </tr>
                    )}
                    </Fragment>
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
