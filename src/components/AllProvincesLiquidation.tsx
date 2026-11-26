// ════════════════════════════════════════════════════════════════════════════
// AllProvincesLiquidation — «لكوديشن كل المحافظات» سطراً سطراً، من زر بجانب العملة في
// «مندوبين المحافظات». محافظة ← مندوب ← سطوره (كنافذة لكوديشن المندوب الواحد).
// GET /api/province-teams/all-lines: نفس سطور rep-lines لكل مندوب في جدول الأسماء، فمجموع
// المندوب = رقم «اللكوديشن» أمامه. الفترة: شهر الصفحة أو يوم واحد (اليوم افتراضاً بزرّه).
// الفلاتر (محافظة / مندوب / ايتم / بحث) في المتصفح. القيم بالدولار و fmtVal تحوّلها.
// ════════════════════════════════════════════════════════════════════════════

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

interface Line {
  date: string; invoice: string; pharmacy: string; area: string; province: string; warehouse: string;
  itemId: number | null; item: string; company: string; quantity: number; bonus: number; usd: number; source: string;
  repUserId: number; repName: string; leaderName: string;
}

interface Props {
  token: string | null;
  fileIds: number[];
  applyMonth: (p: URLSearchParams) => void;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  onClose: () => void;
}

const nf = (n: number) => Math.round(n).toLocaleString('en-US');
const todayBaghdad = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
const SOURCE_STYLE: Record<string, React.CSSProperties> = {
  'ميركاتو':          { background: '#ede9fe', color: '#6d28d9', borderColor: '#c4b5fd' },
  'مبيعات المندوب':   { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' },
  'إرجاع':            { background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' },
};
const DEFAULT_SOURCE: React.CSSProperties = { background: '#e0f2fe', color: '#0369a1', borderColor: '#7dd3fc' };
const COLS = 12;

type Sum = { qty: number; bonus: number; usd: number; orders: Set<string> };
const newSum = (): Sum => ({ qty: 0, bonus: 0, usd: 0, orders: new Set() });
const addTo = (s: Sum, r: Line) => { s.qty += r.quantity; s.bonus += r.bonus || 0; s.usd += r.usd; s.orders.add(r.invoice || `${r.date}|${r.pharmacy}`); };

export default function AllProvincesLiquidation({ token, fileIds, applyMonth, fmtVal, currencyLabel, onClose }: Props) {
  // '' = فترة الصفحة (الشهر المختار)، وإلا يوم واحد YYYY-MM-DD
  const [day, setDay] = useState<string>('');
  const [rows, setRows] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [province, setProvince] = useState('');
  const [repId, setRepId] = useState<number | ''>('');
  const [item, setItem] = useState('');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const today = todayBaghdad();

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setErr('');
    (async () => {
      try {
        const p = new URLSearchParams();
        if (day) p.set('day', day); else applyMonth(p);
        if (fileIds.length) p.set('fileIds', fileIds.join(','));
        const r = await fetch(`/api/province-teams/all-lines?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        const j = await r.json();
        if (!r.ok || j.success === false) throw new Error(j.message || 'تعذّر تحميل اللكوديشن');
        setRows(j.rows ?? []);
      } catch (e: any) { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل اللكوديشن'); }
      finally { if (!ac.signal.aborted) setLoading(false); }
    })();
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // خيارات الفلاتر من السطور المحمّلة (المندوب والايتم يتقيّدان بما فوقهما)
  const provinces = useMemo(() => [...new Set(rows.map(r => r.province))].sort((a, b) => a.localeCompare(b, 'ar')), [rows]);
  const reps = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (!province || r.province === province) m.set(r.repUserId, r.repName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'ar'));
  }, [rows, province]);
  const items = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if ((!province || r.province === province) && (repId === '' || r.repUserId === repId)) s.add(r.item);
    return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [rows, province, repId]);

  const shown = useMemo(() => {
    const s = q.trim();
    return rows.filter(r =>
      (!province || r.province === province) &&
      (repId === '' || r.repUserId === repId) &&
      (!item || r.item === item) &&
      (!s || [r.pharmacy, r.item, r.area, r.warehouse, r.invoice, r.company, r.source, r.date].some(x => (x || '').includes(s))));
  }, [rows, province, repId, item, q]);

  // محافظة ← مندوب، الأكبر قيمةً أولاً
  const groups = useMemo(() => {
    const byProv = new Map<string, { province: string; leader: string; sum: Sum; reps: Map<number, { repUserId: number; repName: string; sum: Sum; lines: Line[] }> }>();
    for (const r of shown) {
      let g = byProv.get(r.province);
      if (!g) { g = { province: r.province, leader: r.leaderName, sum: newSum(), reps: new Map() }; byProv.set(r.province, g); }
      addTo(g.sum, r);
      let rp = g.reps.get(r.repUserId);
      if (!rp) { rp = { repUserId: r.repUserId, repName: r.repName, sum: newSum(), lines: [] }; g.reps.set(r.repUserId, rp); }
      addTo(rp.sum, r); rp.lines.push(r);
    }
    return [...byProv.values()].sort((a, b) => b.sum.usd - a.sum.usd)
      .map(g => ({ ...g, reps: [...g.reps.values()].sort((a, b) => b.sum.usd - a.sum.usd) }));
  }, [shown]);
  const total = useMemo(() => { const s = newSum(); for (const r of shown) addTo(s, r); return s; }, [shown]);

  const toggle = (k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allKeys = groups.flatMap(g => [`p:${g.province}`]);
  const anyOpen = allKeys.some(k => !collapsed.has(k));

  const th: React.CSSProperties = { padding: '8px 8px', fontSize: 12, fontWeight: 800, color: '#334155', background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12.5, color: '#0f172a', borderBottom: '1px solid #eef2f7', whiteSpace: 'nowrap' };
  const num: React.CSSProperties = { ...td, textAlign: 'left', direction: 'ltr', fontVariantNumeric: 'tabular-nums' };
  const dash = <span style={{ color: '#cbd5e1' }}>—</span>;
  const sel: React.CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 999, padding: '6px 10px', fontSize: 12.5, background: '#fff', maxWidth: 220 };
  const chip = (on: boolean): React.CSSProperties => ({ border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12.5, cursor: 'pointer', background: on ? '#fff' : 'transparent', color: on ? '#0f172a' : '#64748b', fontWeight: on ? 800 : 600, boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none' });
  const sumLine = (s: Sum) => (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'baseline', fontSize: 12, color: '#475569', fontWeight: 700 }}>
      <span>{nf(s.orders.size)} طلبية</span>
      <span>· كمية {nf(s.qty)}</span>
      <bdi dir="ltr" style={{ fontWeight: 900, color: s.usd < 0 ? '#be123c' : '#0f766e', fontSize: 13 }}>{fmtVal(s.usd)} {currencyLabel}</bdi>
    </span>
  );

  return (
    <div dir="rtl" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(1500px, 100%)', height: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 8px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: '#0f172a' }}>لكوديشن كل المحافظات</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>كل مندوب: مبيعاته المؤكدة + ميركاتو وملف اللكوديشن باسمه، بلا تكرار</div>
          </div>
          <span style={{ flex: 1 }} />
          {!loading && !err && (
            <span style={{ fontSize: 12.5, color: '#334155', fontWeight: 700 }}>
              {nf(groups.length)} محافظة · {nf(total.orders.size)} طلبية · {nf(shown.length)} سطر · <bdi dir="ltr">{fmtVal(total.usd)} {currencyLabel}</bdi>
            </span>
          )}
          <button type="button" onClick={onClose} style={{ border: 'none', background: '#f1f5f9', borderRadius: 999, width: 32, height: 32, cursor: 'pointer', fontSize: 16 }} aria-label="إغلاق">✕</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', gap: 2, background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
            <button type="button" style={chip(day === '')} onClick={() => setDay('')} title="كل أيام الشهر المختار في الصفحة">كل الأيام</button>
            <button type="button" style={chip(day === today)} onClick={() => setDay(today)}>اليوم</button>
          </div>
          <input type="date" value={day} max={today} onChange={e => setDay(e.target.value)} title="يوم معيّن"
            style={{ ...sel, padding: '5px 10px', direction: 'ltr' }} />
          <select value={province} onChange={e => { setProvince(e.target.value); setRepId(''); setItem(''); }} style={sel}>
            <option value="">كل المحافظات</option>
            {provinces.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={repId === '' ? '' : String(repId)} onChange={e => { setRepId(e.target.value ? Number(e.target.value) : ''); setItem(''); }} style={sel}>
            <option value="">كل المندوبين</option>
            {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={item} onChange={e => setItem(e.target.value)} style={{ ...sel, direction: item ? 'ltr' : 'rtl' }}>
            <option value="">كل الايتمات</option>
            {items.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث: صيدلية / منطقة / مذخر / فاتورة"
            style={{ ...sel, flex: 1, minWidth: 180, maxWidth: 'none', padding: '6px 14px' }} />
          {(province || repId !== '' || item || q) && (
            <button type="button" onClick={() => { setProvince(''); setRepId(''); setItem(''); setQ(''); }}
              style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' }}>مسح الفلاتر</button>
          )}
          {groups.length > 1 && (
            <button type="button" onClick={() => setCollapsed(anyOpen ? new Set(allKeys) : new Set())}
              style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer' }}>{anyOpen ? 'طيّ الكل' : 'فتح الكل'}</button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
          {loading && <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>جاري التحميل…</div>}
          {err && <div style={{ color: '#be123c', padding: 12 }}>{err}</div>}
          {!loading && !err && shown.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>
              {rows.length ? 'لا نتائج لهذه الفلاتر.' : day ? `لا يوجد لكوديشن يوم ${day}.` : 'لا يوجد لكوديشن للفترة المختارة.'}
            </div>
          )}
          {!loading && !err && shown.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>التاريخ</th>
                  <th style={th}>رقم الفاتورة</th>
                  <th style={th}>الصيدلية</th>
                  <th style={th}>المنطقة</th>
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
              {groups.map(g => {
                const pk = `p:${g.province}`;
                const pOpen = !collapsed.has(pk);
                return (
                  <tbody key={pk}>
                    <tr onClick={() => toggle(pk)} style={{ cursor: 'pointer' }}>
                      <td colSpan={COLS} style={{ padding: '9px 10px', background: '#e8eefb', borderTop: '2px solid #c7d4f0', borderBottom: '1px solid #c7d4f0' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 15, fontWeight: 900, color: '#1f4fb4' }}>{pOpen ? '▾' : '◂'} {g.province}</span>
                          {g.leader && <span style={{ fontSize: 12, color: '#475569' }}>التيم ليدر: <b>{g.leader}</b></span>}
                          <span style={{ fontSize: 12, color: '#64748b' }}>{nf(g.reps.length)} مندوب</span>
                          <span style={{ flex: 1 }} />
                          {sumLine(g.sum)}
                        </span>
                      </td>
                    </tr>
                    {pOpen && g.reps.map(rp => {
                      const rk = `r:${g.province}|${rp.repUserId}`;
                      const rOpen = !collapsed.has(rk);
                      return [
                        <tr key={rk} onClick={() => toggle(rk)} style={{ cursor: 'pointer' }}>
                          <td colSpan={COLS} style={{ padding: '7px 10px 7px 10px', paddingRight: 22, background: '#f5f3fb', borderBottom: '1px solid #e4e0f2' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13.5, fontWeight: 800, color: '#4c1d95' }}>{rOpen ? '▾' : '◂'} {rp.repName}</span>
                              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{nf(rp.lines.length)} سطر</span>
                              <span style={{ flex: 1 }} />
                              {sumLine(rp.sum)}
                            </span>
                          </td>
                        </tr>,
                        ...(rOpen ? rp.lines.map((r, i) => (
                          <tr key={`${rk}#${i}`} style={{ background: i % 2 ? '#fbfcfe' : '#fff' }}>
                            <td style={{ ...num, textAlign: 'right' }}>{r.date || dash}</td>
                            <td style={{ ...td, direction: 'ltr', textAlign: 'right' }}>{r.invoice || dash}</td>
                            <td style={{ ...td, whiteSpace: 'normal', minWidth: 140 }}>{r.pharmacy || dash}</td>
                            <td style={td}>{r.area || dash}</td>
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
                        )) : []),
                      ];
                    })}
                  </tbody>
                );
              })}
              <tfoot>
                <tr style={{ fontWeight: 900 }}>
                  <td colSpan={7} style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1', textAlign: 'center' }}>المجموع — {nf(total.orders.size)} طلبية</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{nf(total.qty)}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{total.bonus ? nf(total.bonus) : ''}</td>
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                  <td style={{ ...num, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }}>{fmtVal(total.usd)}</td>
                  <td style={{ ...td, background: '#f1f5f9', borderTop: '2px solid #cbd5e1' }} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
