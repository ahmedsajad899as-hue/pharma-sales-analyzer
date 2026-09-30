import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../config/icons';

const API = import.meta.env.VITE_API_URL || '';

interface NetPharm {
  name: string; areaName: string;
  totalOrders: number; totalValue: number;
  returnsQty: number; returnsValue: number;
  lastOrder: string | null;
}
interface OrderEntry { date: string; qty: number; value: number; rep: string; type: string }
interface ByItem { name: string; orders: OrderEntry[]; totalQty: number; totalValue: number }
interface Detail { byItem: ByItem[]; totalOrders: number }

// نفس تطبيع أسماء الصيدليات المستعمل في تحليل الكولات — لتطابق أسماء السيرفي مع ملف المبيع
function norm(s: string | null | undefined) {
  let r = String(s || '').trim()
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْٰ]/g, '').replace(/ـ/g, '')
    .replace(/\s+/g, ' ').toLowerCase();
  r = r.replace(/^(الصيدليه|صيدليه|العميل|الزبون|الاسم)\s*/, '').trim();
  r = r.replace(/^ص(?!\p{L})[\s/\\.,،:;*\-]*/u, '').trim();
  return r;
}

const fmtDate = (d: string) => { try { return new Date(d).toLocaleDateString('en-GB'); } catch { return d; } };

/** يحمّل صيدليات «الصيدليات نت» مرة واحدة ويوفّر مطابقة سريعة باسم الصيدلية. */
export function usePharmacyNet(token: string) {
  const [pharmacies, setPharmacies] = useState<NetPharm[]>([]);
  const [fileIds, setFileIds] = useState('');

  useEffect(() => {
    let cancelled = false;
    const H = { Authorization: `Bearer ${token}` };
    (async () => {
      try {
        const fr = await fetch(`${API}/api/files?context=pharmacy_net`, { headers: H });
        const { data } = fr.ok ? await fr.json() : { data: [] };
        const ids = (Array.isArray(data) ? data : []).map((f: { id: number }) => f.id).join(',');
        if (!ids) return;
        const pr = await fetch(`${API}/api/pharmacy-analysis/pharmacies?fileIds=${ids}`, { headers: H });
        const d = pr.ok ? await pr.json() : { pharmacies: [] };
        if (!cancelled) { setFileIds(ids); setPharmacies(d.pharmacies || []); }
      } catch { /* الزر يختفي ببساطة إن لم تتوفر بيانات */ }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const exactMap = useMemo(() => {
    const m = new Map<string, NetPharm>();
    for (const p of pharmacies) m.set(norm(p.name), p);
    return m;
  }, [pharmacies]);

  const byArea = useMemo(() => {
    const m = new Map<string, NetPharm[]>();
    for (const p of pharmacies) {
      const k = norm(p.areaName);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return m;
  }, [pharmacies]);

  const find = useCallback((pharmName: string, areaName?: string | null) => {
    const q = norm(pharmName);
    const exact = exactMap.get(q) ?? null;
    const pool = areaName ? (byArea.get(norm(areaName)) ?? []) : pharmacies;
    const similar = pool.filter(p => { const n = norm(p.name); return n !== q && (n.includes(q) || q.includes(n)); }).slice(0, 6);
    return { exact, similar };
  }, [exactMap, byArea, pharmacies]);

  /** مطابقة تامة فقط — رخيصة بما يكفي لتُستدعى لكل صيدلية عند الفلترة بالمبيع. */
  const lookup = useCallback((pharmName: string) => exactMap.get(norm(pharmName)) ?? null, [exactMap]);

  return useMemo(
    () => ({ find, lookup, fileIds, ready: pharmacies.length > 0 }),
    [find, lookup, fileIds, pharmacies.length],
  );
}

type Net = ReturnType<typeof usePharmacyNet>;

function ItemsDetail({ detail, small }: { detail: Detail; small?: boolean }) {
  const fs = small ? 11 : 12;
  return (
    <div>
      {detail.byItem.map((item, idx) => {
        const sales = item.orders.filter(o => o.type !== 'return');
        const rets = item.orders.filter(o => o.type === 'return');
        const row = (o: OrderEntry, i: number, bg: string, c: string) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 8px', background: bg, borderRadius: 6, marginBottom: 2 }}>
            <span style={{ color: 'var(--c-text-secondary)' }}>{fmtDate(o.date)}</span>
            <span style={{ color: 'var(--c-text-secondary)' }}>كمية: {o.qty}</span>
            <span style={{ color: c, fontWeight: 600 }}>{o.value.toLocaleString()} د.ع</span>
          </div>
        );
        return (
          <div key={idx} style={{ background: 'var(--c-bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 8, border: '1px solid var(--c-border)' }}>
            <div style={{ fontSize: fs, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="drug" size={11} /> {item.name}
            </div>
            {sales.length > 0 && (
              <div style={{ marginBottom: rets.length ? 6 : 0 }}>
                <div style={{ fontSize: 10, color: 'var(--c-success)', fontWeight: 700, marginBottom: 3 }}>مبيع ({sales.length})</div>
                {sales.map((o, i) => row(o, i, 'var(--c-success-bg)', 'var(--c-success)'))}
              </div>
            )}
            {rets.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: 'var(--c-danger)', fontWeight: 700, marginBottom: 3 }}>ارجاع ({rets.length})</div>
                {rets.map((o, i) => row(o, i, 'var(--c-danger-bg)', 'var(--c-danger)'))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * الزر الأخضر بجانب اسم الصيدلية (نفس زر تحليل الكولات): يفتح نافذة بمبيعات
 * الصيدلية وتفصيل الإيتمات المباعة. لا يظهر إن لم توجد أي مطابقة في ملف المبيع.
 */
export default function PharmacySalesButton({
  token, net, pharmName, areaName,
}: {
  token: string; net: Net; pharmName: string; areaName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { exact, similar } = useMemo(() => net.find(pharmName, areaName), [net, pharmName, areaName]);

  const loadDetail = useCallback(async (name: string) => {
    setLoading(true); setDetail(null); setDetailFor(name);
    try {
      const fileParam = net.fileIds ? `?fileIds=${net.fileIds}` : '';
      const r = await fetch(`${API}/api/pharmacy-analysis/pharmacy/${encodeURIComponent(name)}${fileParam}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setDetail(await r.json());
    } catch { /* تبقى البطاقات الملخّصة ظاهرة */ }
    finally { setLoading(false); }
  }, [token, net.fileIds]);

  useEffect(() => {
    if (open && exact) loadDetail(exact.name);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exact?.name]);

  if (!exact && similar.length === 0) return null;
  const c = exact ? (exact.totalValue > 0 ? 'var(--c-success)' : 'var(--c-warning)') : 'var(--c-accent)';

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        title="مبيعات هذه الصيدلية"
        style={{ background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `2px solid ${c}`, borderRadius: 7, padding: '2px 7px', fontSize: 11, color: c, cursor: 'pointer', flexShrink: 0, lineHeight: 1.4, fontWeight: 700, display: 'inline-flex' }}
      >
        <Icon name="navSalesData" size={12} />
      </button>

      {open && (
        <div onClick={e => e.stopPropagation()}>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1200 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: 'var(--c-surface, #fff)', borderRadius: 16, border: '1px solid var(--c-border)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', zIndex: 1201, width: 'min(94vw,440px)', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', direction: 'rtl', overflow: 'hidden',
          }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--c-border-light)', background: 'var(--c-bg)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="navSalesData" size={13} /> مبيعات الصيدلية
                </div>
                <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', display: 'flex' }}>
                  <Icon name="close" size={20} />
                </button>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderRadius: 6, padding: '2px 8px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="pharmacy" size={11} /> {pharmName}
                </span>
                {areaName && (
                  <span style={{ fontSize: 11, background: 'var(--c-bg)', color: 'var(--c-text-secondary)', borderRadius: 6, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="location" size={11} /> {areaName}
                  </span>
                )}
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 16px 16px' }}>
              {exact ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                    {[
                      { label: 'عدد الطلبيات', value: String(exact.totalOrders), color: 'var(--c-accent)', bg: 'var(--c-accent-light)' },
                      { label: 'إجمالي المبيع', value: exact.totalValue > 0 ? `${exact.totalValue.toLocaleString()} د.ع` : '—', color: 'var(--c-success)', bg: 'var(--c-success-bg)' },
                      { label: 'إجمالي الارجاع', value: exact.returnsValue > 0 ? `${exact.returnsValue.toLocaleString()} د.ع` : '—', color: 'var(--c-danger)', bg: 'var(--c-danger-bg)' },
                      { label: 'آخر طلبية', value: exact.lastOrder ? fmtDate(exact.lastOrder) : '—', color: 'var(--c-warning)', bg: 'var(--c-warning-bg)' },
                    ].map(card => (
                      <div key={card.label} style={{ background: card.bg, borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, color: 'var(--c-text-muted)', marginBottom: 3 }}>{card.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: card.color }}>{card.value}</div>
                      </div>
                    ))}
                  </div>
                  {loading && detailFor === exact.name ? (
                    <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--c-text-muted)', fontSize: 12 }}>جاري تحميل تفاصيل الطلبيات...</div>
                  ) : detail && detailFor === exact.name && detail.byItem.length > 0 ? (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-secondary)', marginBottom: 8 }}>تفاصيل الإيتمات والطلبيات</div>
                      <ItemsDetail detail={detail} />
                    </>
                  ) : null}
                </>
              ) : (
                <div style={{ padding: 12, background: 'var(--c-warning-bg)', borderRadius: 10, marginBottom: 12, fontSize: 12, color: 'var(--c-warning)' }}>
                  لم يتم العثور على هذه الصيدلية بشكل مباشر في بيانات المبيع
                </div>
              )}

              {similar.length > 0 && (
                <div style={{ marginTop: exact ? 8 : 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-accent)', marginBottom: 8 }}>صيدليات مشابهة في الاسم ({similar.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {similar.map(p => (
                      <div key={p.name} style={{ background: 'var(--c-bg)', borderRadius: 10, padding: '10px 12px', border: '1px solid var(--c-border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-primary)' }}>{p.name}</div>
                          <button onClick={() => loadDetail(p.name)} style={{ background: detailFor === p.name ? 'var(--c-accent-light)' : 'none', border: '1px solid var(--c-accent)', borderRadius: 6, padding: '2px 8px', fontSize: 10, color: 'var(--c-accent)', cursor: 'pointer' }}>
                            {detailFor === p.name && loading ? '...' : 'تفاصيل'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {p.totalValue > 0 && <span style={{ fontSize: 11, color: 'var(--c-success)', fontWeight: 600 }}>مبيع: {p.totalValue.toLocaleString()} د.ع</span>}
                          {p.returnsValue > 0 && <span style={{ fontSize: 11, color: 'var(--c-danger)', fontWeight: 600 }}>ارجاع: {p.returnsValue.toLocaleString()} د.ع</span>}
                          {p.areaName && <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{p.areaName}</span>}
                        </div>
                        {detailFor === p.name && !loading && detail && detail.byItem.length > 0 && (
                          <div style={{ marginTop: 6 }}><ItemsDetail detail={detail} small /></div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
