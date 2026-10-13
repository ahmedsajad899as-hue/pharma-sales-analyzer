// ════════════════════════════════════════════════════════════════════════════
// IraqRepsMap — خريطة العراق: المندوبون العلميون بالمحافظات (بلا بغداد) + صافي مبيعهم.
//
// الحدود SVG مُسقَطة مسبقاً (src/data/iraqProvinces.ts) فلا مكتبة خرائط ولا بلاطات
// تُحمَّل. تلوين المحافظة تدرّج لون واحد حسب صافي المبيع، وكل محافظة فيها مندوبون
// تُرسَم لها بطاقة (اسم المندوب + مبيعه) متصلة بمركزها بخط رفيع. البطاقات تُوزَّع
// على جانبَي الخريطة وتُرتَّب عمودياً بلا تداخل. الشاشات الضيقة تعرض القائمة فقط.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { IRAQ_PROVINCE_SHAPES, IRAQ_MAP_VIEWBOX } from '../data/iraqProvinces';

export interface ProvinceRepRow { id: number; name: string; netValue: number; netQty: number }
export interface ProvinceMapRow { provinceName: string; totalValue: number; reps: ProvinceRepRow[] }

interface Props {
  reps: { id: number; company?: string | null }[];
  token: string | null;
  fileIds: number[];
  /** يضيف month/تواريخ الشهر المختار إلى الطلب — نفس دالة الصفحة. */
  applyMonth: (p: URLSearchParams) => void;
  /** يتغيّر مع الشهر لإعادة الجلب. */
  monthKey: string;
  fromDate: string;
  toDate: string;
  fmtVal: (n: number) => string;
  currencyLabel: string;
}

// توحيد اسم المحافظة للمطابقة (أ/إ/آ→ا، ى→ي، ة→ه)
const norm = (s: string) => String(s || '').trim().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ');

// الجانب الذي تُعلَّق عليه بطاقة كل محافظة (يقلّل تقاطع الخطوط)
const LEFT_SIDE = new Set(['نينوى', 'دهوك', 'الأنبار', 'صلاح الدين', 'كربلاء', 'النجف', 'بابل', 'المثنى'].map(norm));

const STAGE_W = 1700, MAP_X = 350;           // الخريطة عرضها 1000 تبدأ عند x=350
const CARD_W = 270, CARD_GAP = 14, HEAD_H = 40, ROW_H = 26, MAX_ROWS = 5;
const STAGE_H = IRAQ_MAP_VIEWBOX.h;

// تدرّج أزرق أحادي اللون (فاتح→داكن)
const RAMP = ['#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e3a8a'];

interface Card { key: string; row: ProvinceMapRow; side: 'L' | 'R'; x: number; y: number; h: number; ax: number; ay: number; shown: ProvinceRepRow[]; more: number }

export default function IraqRepsMap({ reps, token, fileIds, applyMonth, monthKey, fromDate, toDate, fmtVal, currencyLabel }: Props) {
  const [data, setData] = useState<ProvinceMapRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(1200);
  const repIdsKey = reps.map(r => r.id).join(',');
  const companyOf = useMemo(() => new Map(reps.map(r => [r.id, r.company || ''])), [reps]);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el); setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!repIdsKey) { setData([]); return; }
    let dead = false;
    (async () => {
      setLoading(true); setErr('');
      try {
        const p = new URLSearchParams();
        p.set('repIds', repIdsKey);
        if (fromDate) p.set('startDate', fromDate);
        if (toDate) p.set('endDate', toDate);
        if (fileIds.length > 0) p.set('fileIds', fileIds.join(','));
        applyMonth(p);
        const res = await fetch(`/api/scientific-reps/province-map?${p}`, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'تعذّر تحميل الخريطة');
        if (!dead) setData(json.data ?? []);
      } catch (e: any) { if (!dead) { setErr(e.message); setData([]); } }
      finally { if (!dead) setLoading(false); }
    })();
    return () => { dead = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repIdsKey, fileIds.join(','), monthKey, fromDate, toDate, token]);

  const byProv = useMemo(() => new Map((data ?? []).map(r => [norm(r.provinceName), r])), [data]);
  const maxVal = useMemo(() => Math.max(1, ...(data ?? []).map(r => r.totalValue)), [data]);
  const fillOf = (row?: ProvinceMapRow) => {
    if (!row) return '#eef2f7';
    if (row.totalValue <= 0) return '#e2e8f0';
    const t = Math.sqrt(row.totalValue / maxVal);         // sqrt: يُظهر الفروق بين القيم الصغيرة
    return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))];
  };

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const s of IRAQ_PROVINCE_SHAPES) {
      const row = byProv.get(norm(s.name));
      if (!row || row.reps.length === 0) continue;
      const shown = row.reps.slice(0, MAX_ROWS);
      const more = row.reps.length - shown.length;
      const h = HEAD_H + shown.length * ROW_H + (more > 0 ? 20 : 0) + 8;
      const side: 'L' | 'R' = LEFT_SIDE.has(norm(s.name)) ? 'L' : 'R';
      out.push({ key: s.name, row, side, x: side === 'L' ? 6 : STAGE_W - CARD_W - 6, y: 0, h, ax: MAP_X + s.cx, ay: s.cy, shown, more });
    }
    for (const side of ['L', 'R'] as const) {
      const col = out.filter(c => c.side === side).sort((a, b) => a.ay - b.ay);
      let prev = -CARD_GAP;
      for (const c of col) { c.y = Math.max(c.ay - c.h / 2, prev + CARD_GAP); prev = c.y + c.h; }
      let limit = STAGE_H;                                  // تمرير عكسي: لا تخرج عن الإطار
      for (let i = col.length - 1; i >= 0; i--) { const c = col[i]; if (c.y + c.h > limit) c.y = limit - c.h; limit = c.y - CARD_GAP; }
      if (col.length && col[0].y < 0) { let y = 0; for (const c of col) { c.y = Math.max(c.y, y); y = c.y + c.h + CARD_GAP; } }
    }
    return out;
  }, [byProv]);

  const totals = useMemo(() => {
    const rows = data ?? [];
    return { value: rows.reduce((s, r) => s + r.totalValue, 0), reps: new Set(rows.flatMap(r => r.reps.map(x => x.id))).size, provinces: rows.length };
  }, [data]);
  const ranking = useMemo(() => [...(data ?? [])].sort((a, b) => b.totalValue - a.totalValue), [data]);

  const wide = wrapW >= 980;
  const scale = wrapW / STAGE_W;
  const active = sel ?? hover;
  const activeRow = active ? byProv.get(norm(active)) : undefined;

  const rankList = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ranking.map((r, i) => (
        <div key={r.provinceName} onMouseEnter={() => setHover(r.provinceName)} onMouseLeave={() => setHover(null)}
          onClick={() => setSel(s => s === r.provinceName ? null : r.provinceName)}
          style={{ background: '#fff', border: `1px solid ${active && norm(active) === norm(r.provinceName) ? '#2563eb' : '#e2e8f0'}`, borderRadius: 12, padding: '10px 12px', cursor: 'pointer' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 800, fontSize: 13, color: '#0f172a' }}><span style={{ color: '#94a3b8', fontWeight: 600, marginInlineEnd: 6 }}>{i + 1}</span>{r.provinceName}</span>
            <span style={{ fontWeight: 800, fontSize: 13, color: r.totalValue < 0 ? '#be123c' : '#1d4ed8' }}>{fmtVal(r.totalValue)}</span>
          </div>
          <div style={{ height: 4, borderRadius: 4, background: '#eef2f7', margin: '7px 0' }}>
            <div style={{ height: '100%', width: `${Math.max(2, Math.min(100, (r.totalValue / maxVal) * 100))}%`, background: fillOf(r) === '#dbeafe' ? '#93c5fd' : fillOf(r), borderRadius: 4 }} />
          </div>
          {r.reps.map(p => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569', padding: '1px 0' }}>
              <span>{p.name}{companyOf.get(p.id) ? <span style={{ color: '#94a3b8' }}> · {companyOf.get(p.id)}</span> : null}</span>
              <span style={{ fontWeight: 700, color: '#0f172a' }}>{fmtVal(p.netValue)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      {/* شريط ملخص */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {[
          ['صافي مبيع المحافظات', `${fmtVal(totals.value)} ${currencyLabel}`, '#1d4ed8'],
          ['المندوبون العلميون', String(totals.reps), '#0f766e'],
          ['المحافظات المغطّاة', `${totals.provinces} / 17`, '#7c3aed'],
        ].map(([l, v, c]) => (
          <div key={l} style={{ flex: '1 1 160px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: '10px 14px', borderTop: `3px solid ${c}` }}>
            <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>

      {err && <div style={{ color: '#be123c', fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <div ref={wrapRef} style={{ background: 'radial-gradient(1200px 600px at 50% 0%, #f8fafc 0%, #eef2f7 100%)', border: '1px solid #e2e8f0', borderRadius: 20, padding: wide ? 0 : 12, position: 'relative', overflow: 'hidden', minHeight: 200 }}>
        {loading && <div style={{ position: 'absolute', top: 10, insetInlineEnd: 14, fontSize: 12, color: '#64748b', zIndex: 5 }}>جاري التحميل…</div>}
        {!loading && data && data.length === 0 && !err && (
          <div style={{ padding: 40, textAlign: 'center', color: '#64748b', fontSize: 14 }}>لا يوجد مندوبون علميون بمناطق في المحافظات (خارج بغداد) ضمن النطاق الحالي.</div>
        )}

        {wide ? (
          <div style={{ height: STAGE_H * scale, position: 'relative' }}>
            <div style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'absolute', left: 0, top: 0 }}>
              <svg width={STAGE_W} height={STAGE_H} style={{ position: 'absolute', inset: 0 }}>
                <defs>
                  <filter id="iqShadow" x="-5%" y="-5%" width="110%" height="115%"><feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#0f172a" floodOpacity="0.14" /></filter>
                </defs>
                <g transform={`translate(${MAP_X} 0)`} filter="url(#iqShadow)">
                  {IRAQ_PROVINCE_SHAPES.map(s => {
                    const row = byProv.get(norm(s.name));
                    const isBaghdad = norm(s.name) === norm('بغداد');
                    const on = active && norm(active) === norm(s.name);
                    return (
                      <path key={s.name} d={s.d} fillRule="evenodd"
                        fill={isBaghdad ? '#f1f5f9' : fillOf(row)}
                        stroke={on ? '#0f172a' : '#fff'} strokeWidth={on ? 3 : 2} strokeLinejoin="round"
                        style={{ cursor: row ? 'pointer' : 'default', transition: 'fill .2s, stroke-width .2s', opacity: active && !on ? 0.78 : 1 }}
                        onMouseEnter={() => row && setHover(s.name)} onMouseLeave={() => setHover(null)}
                        onClick={() => row && setSel(v => v === s.name ? null : s.name)}>
                        <title>{s.name}</title>
                      </path>
                    );
                  })}
                </g>
                {/* أسماء المحافظات التي بلا بطاقة */}
                {IRAQ_PROVINCE_SHAPES.filter(s => !cards.some(c => c.key === s.name)).map(s => (
                  <text key={s.name} x={MAP_X + s.cx} y={s.cy} textAnchor="middle" dominantBaseline="middle"
                    style={{ fontSize: 15, fontWeight: 700, fill: norm(s.name) === norm('بغداد') ? '#94a3b8' : '#94a3b8', pointerEvents: 'none' }}>{s.name}{norm(s.name) === norm('بغداد') ? ' (مستثناة)' : ''}</text>
                ))}
                {/* خطوط الربط */}
                {cards.map(c => {
                  const ex = c.side === 'L' ? c.x + CARD_W : c.x;
                  const ey = c.y + HEAD_H / 2;
                  const on = active && norm(active) === norm(c.key);
                  return (
                    <g key={c.key} style={{ pointerEvents: 'none' }}>
                      <path d={`M${ex} ${ey} C ${(ex + c.ax) / 2} ${ey}, ${(ex + c.ax) / 2} ${c.ay}, ${c.ax} ${c.ay}`} fill="none" stroke={on ? '#0f172a' : '#64748b'} strokeWidth={on ? 2 : 1.2} strokeDasharray={on ? '' : '4 4'} opacity={on ? 1 : 0.7} />
                      <circle cx={c.ax} cy={c.ay} r={6} fill="#fff" stroke="#0f172a" strokeWidth={2.5} />
                    </g>
                  );
                })}
              </svg>

              {cards.map(c => {
                const on = active && norm(active) === norm(c.key);
                return (
                  <div key={c.key} dir="rtl"
                    onMouseEnter={() => setHover(c.key)} onMouseLeave={() => setHover(null)}
                    onClick={() => setSel(v => v === c.key ? null : c.key)}
                    style={{
                      position: 'absolute', left: c.x, top: c.y, width: CARD_W, height: c.h, boxSizing: 'border-box',
                      background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(6px)',
                      border: `1.5px solid ${on ? '#0f172a' : '#dbe3ee'}`, borderRadius: 14,
                      boxShadow: on ? '0 10px 28px rgba(15,23,42,.22)' : '0 3px 12px rgba(15,23,42,.08)',
                      transition: 'box-shadow .2s, border-color .2s', cursor: 'pointer', overflow: 'hidden',
                    }}>
                    <div style={{ height: HEAD_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', borderBottom: '1px solid #eef2f7', background: '#f8fafc' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 800, fontSize: 15, color: '#0f172a' }}>
                        <span style={{ width: 11, height: 11, borderRadius: 4, background: fillOf(c.row), border: '1px solid rgba(15,23,42,.15)' }} />{c.key}
                      </span>
                      <span style={{ fontWeight: 800, fontSize: 14, color: c.row.totalValue < 0 ? '#be123c' : '#1d4ed8' }}>{fmtVal(c.row.totalValue)}</span>
                    </div>
                    {c.shown.map(p => (
                      <div key={p.id} style={{ height: ROW_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 12px', fontSize: 13 }}>
                        <span style={{ color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={companyOf.get(p.id) || undefined}>{p.name}</span>
                        <span style={{ fontWeight: 700, color: p.netValue < 0 ? '#be123c' : p.netValue === 0 ? '#94a3b8' : '#0f172a', flexShrink: 0 }}>{fmtVal(p.netValue)}</span>
                      </div>
                    ))}
                    {c.more > 0 && <div style={{ height: 20, padding: '0 12px', fontSize: 12, color: '#64748b' }}>+{c.more} مندوب آخر</div>}
                  </div>
                );
              })}

              {/* مفتاح الألوان */}
              <div style={{ position: 'absolute', left: MAP_X + 20, top: STAGE_H - 46, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#64748b' }}>
                <span>أقل</span>
                <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #fff' }}>{RAMP.map(c => <span key={c} style={{ width: 22, height: 10, background: c }} />)}</div>
                <span>أعلى مبيعاً</span>
              </div>
            </div>
          </div>
        ) : (
          rankList
        )}
      </div>

      {/* تفاصيل المحافظة المختارة تحت الخريطة (للعرض العريض) */}
      {wide && activeRow && (
        <div style={{ marginTop: 12, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: '12px 16px' }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>{activeRow.provinceName} — {fmtVal(activeRow.totalValue)} {currencyLabel}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {activeRow.reps.map(p => (
              <span key={p.id} style={{ background: '#f1f5f9', borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>
                {p.name}{companyOf.get(p.id) ? ` · ${companyOf.get(p.id)}` : ''} — <b>{fmtVal(p.netValue)}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
