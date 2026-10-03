import { useMemo, useState, useEffect } from 'react';
import { Icon } from '../config/icons';
import { SRC_STYLE, type Src } from './PharmacySourceBits';

// نافذة «مقارنة بيانات المبيع» — تُعرض عند الضغط على الزر الأخضر في تحليل الكولات.
// تصميم هادئ: خلفية بيضاء، حدود رفيعة، لون واحد للتمييز. المصدر يُصفّى تفاعلياً.

export interface NetPharm {
  name: string; key?: string; areaName: string;
  totalOrders: number; totalValue: number;
  returnsValue: number; lastOrder: string | null;
}

export interface PharmOrder { date: string; qty: number; value: number; rep: string; type: string; source?: Src }
export interface PharmItem { name: string; orders: PharmOrder[]; totalQty: number; totalValue: number }
export interface PharmDetail {
  byItem: PharmItem[];
  totalOrders: number;
  sourceTotals?: Record<Src, { orders: number; sales: number; returns: number }>;
  mergedFrom?: { id: number; fromName: string }[];
}

export interface ComparePopupState {
  docName: string; pharmName: string; areaName: string | null;
  exact: NetPharm | null; similar: NetPharm[];
}

interface Props {
  popup: ComparePopupState;
  detail: PharmDetail | null;
  detailLoading: boolean;
  detailFor: string | null;
  onClose: () => void;
  /** معاينة صيدلية متشابهة دون أن تستبدل تفاصيل الصيدلية الأساسية */
  onPreview: (name: string) => Promise<PharmDetail | null>;
  onMerge: (fromName: string, toName: string) => Promise<boolean>;
  onUnmerge: (id: number) => Promise<boolean>;
  fmtDate: (d: string) => string;
}

type Filter = 'all' | Src;

const C = {
  ink: '#0f172a', ink2: '#334155', muted: '#64748b', faint: '#94a3b8',
  line: '#e7ecf3', soft: '#f6f8fb', teal: '#0f766e', rose: '#be123c', amber: '#92400e',
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease', flexShrink: 0 }}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const money = (n: number) => `${Math.round(n).toLocaleString()} د.ع`;

export default function PharmacyComparePopup({
  popup, detail, detailLoading, detailFor, onClose, onPreview, onMerge, onUnmerge, fmtDate,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ name: string; detail: PharmDetail | null; loading: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exact = popup.exact;
  const isCurrent = !!exact && detailFor === exact.name && !detailLoading;

  // الإيتمات بعد تصفية المصدر والبحث — تُحسب من التفاصيل الخام
  const visibleItems = useMemo(() => {
    if (!detail) return [];
    const q = query.trim().toLowerCase();
    return detail.byItem
      .filter(it => !q || it.name.toLowerCase().includes(q))
      .map(it => {
        const orders = filter === 'all' ? it.orders : it.orders.filter(o => (o.source ?? 'office') === filter);
        const net = orders.reduce((a, o) => a + (o.type === 'return' ? -o.value : o.value), 0);
        const qty = orders.reduce((a, o) => a + o.qty, 0);
        return { name: it.name, orders, net, qty };
      })
      .filter(it => it.orders.length > 0);
  }, [detail, filter, query]);

  // أول إيتم مفتوح تلقائياً عند وصول التفاصيل لصيدلية جديدة
  useEffect(() => {
    if (detail && detail.byItem.length) setOpen(new Set([detail.byItem[0].name]));
    setFilter('all'); setQuery('');
  }, [detail]);

  const counts = useMemo(() => {
    const st = detail?.sourceTotals;
    return {
      all: (st?.office.orders ?? 0) + (st?.mercato.orders ?? 0),
      office: st?.office.orders ?? 0,
      mercato: st?.mercato.orders ?? 0,
    };
  }, [detail]);

  const hasBothSources = counts.office > 0 && counts.mercato > 0;
  const shownNet = visibleItems.reduce((a, it) => a + it.net, 0);

  const toggle = (name: string) => setOpen(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3500); };

  const doMerge = async (from: string, to: string) => {
    if (!window.confirm(`دمج «${from}» ضمن «${to}»؟\nسيُحفظ القرار ولن يُسأل عنه مرة أخرى.`)) return;
    setBusy(true);
    const ok = await onMerge(from, to);
    setBusy(false);
    if (ok) flash(`تم دمج «${from}» ضمن «${to}»`);
  };

  const doUnmerge = async (id: number, from: string) => {
    if (!window.confirm(`فكّ دمج «${from}»؟`)) return;
    setBusy(true);
    const ok = await onUnmerge(id);
    setBusy(false);
    if (ok) flash(`تم فكّ دمج «${from}»`);
  };

  const status = exact
    ? { text: 'مطابقة تامة', fg: '#047857', bg: '#ecfdf5', bd: '#a7f3d0' }
    : popup.similar.length
      ? { text: 'اقتراحات دمج', fg: C.amber, bg: '#fffbeb', bd: '#fde68a' }
      : { text: 'غير موجودة', fg: C.muted, bg: '#f1f5f9', bd: '#e2e8f0' };

  const kpis = exact ? [
    { label: 'عدد الطلبيات', value: String(exact.totalOrders), color: C.ink, bar: '#94a3b8' },
    { label: 'صافي المبيع', value: money(exact.totalValue), color: C.teal, bar: C.teal },
    { label: 'الارجاع', value: exact.returnsValue > 0 ? money(exact.returnsValue) : '—', color: C.rose, bar: C.rose },
    { label: 'آخر طلبية', value: exact.lastOrder ? fmtDate(exact.lastOrder) : '—', color: C.ink2, bar: '#cbd5e1' },
  ] : [];

  const segBtn = (key: Filter, label: string, n: number, disabled = false) => {
    const active = filter === key;
    return (
      <button key={key} type="button" disabled={disabled} onClick={() => setFilter(key)}
        style={{
          flex: 1, border: 'none', cursor: disabled ? 'default' : 'pointer', borderRadius: 8,
          padding: '6px 8px', fontSize: 12, fontWeight: active ? 700 : 500,
          color: active ? C.ink : C.muted, background: active ? '#fff' : 'transparent',
          boxShadow: active ? '0 1px 2px rgba(15,23,42,.08)' : 'none',
          opacity: disabled ? 0.45 : 1, transition: 'all .15s ease',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
        {key !== 'all' && <span style={{ width: 7, height: 7, borderRadius: 2, background: SRC_STYLE[key as Src].fg }} />}
        {label}
        <span style={{ fontSize: 10.5, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      </button>
    );
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.40)', zIndex: 1200 }} />
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="مقارنة بيانات المبيع"
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          background: '#fff', borderRadius: 18, border: `1px solid ${C.line}`,
          boxShadow: '0 24px 60px rgba(15,23,42,0.20)', zIndex: 1201,
          width: 'min(94vw, 560px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
          direction: 'rtl', overflow: 'hidden', fontFamily: 'inherit',
        }}>

        {/* ── الرأس ── */}
        <div style={{ padding: '16px 20px 14px', borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="navSalesData" size={12} /> مقارنة بيانات المبيع
              </div>
              <div style={{ fontSize: 14, color: C.ink, fontWeight: 700, marginTop: 4 }}>د. {popup.docName}</div>
            </div>
            <button onClick={onClose} aria-label="إغلاق"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.faint, display: 'flex', padding: 4, borderRadius: 8 }}>
              <Icon name="close" size={18} />
            </button>
          </div>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: C.soft, border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="pharmacy" size={15} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {exact ? exact.name : popup.pharmName}
              </div>
              {popup.areaName && (
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="location" size={10} /> {popup.areaName}
                </div>
              )}
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: status.fg, background: status.bg, border: `1px solid ${status.bd}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {status.text}
            </span>
          </div>
        </div>

        {/* ── المحتوى ── */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {notice && (
            <div style={{ fontSize: 12, color: '#047857', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '8px 12px' }}>
              {notice}
            </div>
          )}

          {exact ? (
            <>
              {/* بطاقات الأرقام */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {kpis.map(k => (
                  <div key={k.label} style={{ position: 'relative', background: '#fbfcfd', border: `1px solid ${C.line}`, borderRadius: 12, padding: '11px 14px 11px 16px', overflow: 'hidden' }}>
                    <span style={{ position: 'absolute', right: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: k.bar }} />
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{k.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: k.color, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
                  </div>
                ))}
              </div>

              {/* الأسماء المدموجة هنا */}
              {detail?.mergedFrom && detail.mergedFrom.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>أسماء مدموجة هنا:</span>
                  {detail.mergedFrom.map(m => (
                    <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.ink2, background: C.soft, border: `1px solid ${C.line}`, borderRadius: 999, padding: '2px 4px 2px 10px' }}>
                      {m.fromName}
                      <button type="button" disabled={busy} onClick={() => doUnmerge(m.id, m.fromName)} title="فكّ الدمج"
                        style={{ border: 'none', background: '#e2e8f0', color: C.ink2, width: 17, height: 17, borderRadius: 999, cursor: 'pointer', fontSize: 11, lineHeight: '17px', padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}

              {/* توزيع المصدر + فلتر تفاعلي */}
              {detail && counts.all > 0 && (
                <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.ink2 }}>المصدر</span>
                    <span style={{ fontSize: 11, color: C.faint }}>اختر لعرض طلبيات مصدر واحد</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, background: C.soft, borderRadius: 10, padding: 3 }}>
                    {segBtn('all', 'الكل', counts.all)}
                    {segBtn('office', SRC_STYLE.office.label, counts.office, counts.office === 0)}
                    {segBtn('mercato', SRC_STYLE.mercato.label, counts.mercato, counts.mercato === 0)}
                  </div>
                  {hasBothSources && detail.sourceTotals && (() => {
                    const o = detail.sourceTotals.office, m = detail.sourceTotals.mercato;
                    const ov = Math.max(o.sales - o.returns, 0), mv = Math.max(m.sales - m.returns, 0);
                    const tot = ov + mv || 1;
                    return (
                      <>
                        <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: C.line, margin: '12px 0 8px' }}>
                          <div style={{ width: `${(ov / tot) * 100}%`, background: SRC_STYLE.office.fg, opacity: 0.8 }} />
                          <div style={{ width: `${(mv / tot) * 100}%`, background: SRC_STYLE.mercato.fg, opacity: 0.8 }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.muted, gap: 8, flexWrap: 'wrap' }}>
                          <span>{SRC_STYLE.office.label}: <b style={{ color: C.ink2, fontVariantNumeric: 'tabular-nums' }}>{money(ov)}</b></span>
                          <span>{SRC_STYLE.mercato.label}: <b style={{ color: C.ink2, fontVariantNumeric: 'tabular-nums' }}>{money(mv)}</b></span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* الإيتمات */}
              {detailLoading && detailFor === exact.name ? (
                <div style={{ textAlign: 'center', padding: '18px 0', color: C.muted, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Icon name="loading" size={12} className="icon-spin" /> جاري تحميل تفاصيل الطلبيات…
                </div>
              ) : isCurrent && detail && detail.byItem.length > 0 ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.ink2 }}>
                      الإيتمات <span style={{ color: C.faint, fontWeight: 500 }}>({visibleItems.length})</span>
                    </span>
                    <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {filter === 'all' ? 'الصافي' : 'صافي المصدر'}: <b style={{ color: C.ink2 }}>{money(shownNet)}</b>
                    </span>
                  </div>
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="ابحث عن إيتم…"
                    style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${C.line}`, borderRadius: 10, padding: '7px 11px', fontSize: 12, outline: 'none', marginBottom: 8, color: C.ink, background: '#fff' }} />

                  {visibleItems.length === 0 && (
                    <div style={{ textAlign: 'center', color: C.faint, fontSize: 12, padding: '14px 0' }}>لا توجد طلبيات مطابقة</div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {visibleItems.map(it => {
                      const isOpen = open.has(it.name);
                      return (
                        <div key={it.name} style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
                          <button type="button" onClick={() => toggle(it.name)}
                            style={{ width: '100%', border: 'none', background: isOpen ? '#fbfcfd' : '#fff', cursor: 'pointer', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                              <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                                {it.orders.length} طلبية · كمية {it.qty}
                              </div>
                            </div>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: it.net < 0 ? C.rose : C.teal, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {money(it.net)}
                            </span>
                            <Chevron open={isOpen} />
                          </button>

                          {isOpen && (
                            <div style={{ borderTop: `1px solid ${C.line}`, padding: '4px 12px 8px' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1.05fr .7fr .9fr 1.1fr', gap: 8, fontSize: 10, color: C.faint, fontWeight: 600, padding: '6px 0', borderBottom: `1px solid ${C.soft}` }}>
                                <span>التاريخ</span><span>الكمية</span><span>المصدر</span><span style={{ textAlign: 'left' }}>القيمة</span>
                              </div>
                              {it.orders.map((o, i) => {
                                const src = (o.source ?? 'office') as Src;
                                const isRet = o.type === 'return';
                                return (
                                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.05fr .7fr .9fr 1.1fr', gap: 8, alignItems: 'center', fontSize: 11.5, padding: '7px 0', borderBottom: i < it.orders.length - 1 ? `1px solid ${C.soft}` : 'none' }}>
                                    <span style={{ color: C.ink2, fontVariantNumeric: 'tabular-nums' }}>{fmtDate(o.date)}</span>
                                    <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{o.qty}</span>
                                    <span>
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: SRC_STYLE[src].fg }}>
                                        <span style={{ width: 6, height: 6, borderRadius: 2, background: SRC_STYLE[src].fg }} />
                                        {SRC_STYLE[src].label}
                                      </span>
                                    </span>
                                    <span style={{ textAlign: 'left', fontWeight: 700, color: isRet ? C.rose : C.ink, fontVariantNumeric: 'tabular-nums' }}>
                                      {isRet ? '−' : ''}{money(o.value)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ fontSize: 12, color: C.amber, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '11px 14px' }}>
              لم تُعثر على هذه الصيدلية مباشرة في بيانات المبيع
            </div>
          )}

          {/* الصيدليات المتشابهة — اقتراحات دمج قابلة للحفظ */}
          {popup.similar.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 8 }}>
                صيدليات متشابهة في الاسم <span style={{ color: C.faint, fontWeight: 500 }}>({popup.similar.length})</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {popup.similar.map(p => {
                  const previewing = preview?.name === p.name;
                  const pd = previewing ? preview!.detail : null;
                  return (
                    <div key={p.name} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '10px 12px', background: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: C.muted, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
                            <span>{p.totalOrders} طلبية</span>
                            <span>صافي {money(p.totalValue)}</span>
                            {p.areaName && <span>{p.areaName}</span>}
                          </div>
                        </div>
                        <button type="button" onClick={async () => {
                          if (previewing) { setPreview(null); return; }
                          setPreview({ name: p.name, detail: null, loading: true });
                          const d = await onPreview(p.name);
                          setPreview({ name: p.name, detail: d, loading: false });
                        }}
                          style={{ background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '4px 10px', fontSize: 11, color: C.ink2, cursor: 'pointer', flexShrink: 0 }}>
                          {previewing ? 'إخفاء' : 'معاينة'}
                        </button>
                        {exact && (
                          <button type="button" disabled={busy} onClick={() => doMerge(p.name, exact.name)}
                            title={`دمج «${p.name}» ضمن «${exact.name}»`}
                            style={{ background: C.ink, border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: 11, color: '#fff', cursor: 'pointer', flexShrink: 0, opacity: busy ? 0.6 : 1 }}>
                            دمج
                          </button>
                        )}
                      </div>

                      {previewing && (
                        <div style={{ marginTop: 10, borderTop: `1px solid ${C.soft}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {preview!.loading && <div style={{ fontSize: 11.5, color: C.faint }}>جاري التحميل…</div>}
                          {!preview!.loading && !pd && <div style={{ fontSize: 11.5, color: C.faint }}>تعذّر تحميل المعاينة</div>}
                          {pd && pd.byItem.slice(0, 8).map(it => (
                            <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: C.ink2, gap: 8 }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                              <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{it.orders.length} طلبية · {money(it.totalValue)}</span>
                            </div>
                          ))}
                          {pd && pd.byItem.length > 8 && (
                            <div style={{ fontSize: 10.5, color: C.faint }}>+ {pd.byItem.length - 8} إيتم آخر</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!exact && (
                <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
                  الدمج يتطلب صيدلية مطابقة تامة في المبيعات كنقطة هدف.
                </div>
              )}
            </div>
          )}

          {!exact && popup.similar.length === 0 && (
            <div style={{ textAlign: 'center', color: C.faint, padding: '18px 0', fontSize: 12.5 }}>
              لا توجد بيانات مبيع مرتبطة بهذه الصيدلية
            </div>
          )}
        </div>
      </div>
    </>
  );
}
