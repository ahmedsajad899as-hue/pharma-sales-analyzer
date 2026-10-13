// ════════════════════════════════════════════════════════════════════════════
// IraqRepsMap — خريطة العراق التفاعلية: لكل محافظة (عدا بغداد) عدد الشركات العاملة
// فيها، ومبيع كل شركة، والمندوبون العلميون التابعون لكل شركة.
//
// الحدود SVG مُسقَطة مسبقاً (src/data/iraqProvinces.ts) فلا مكتبة خرائط ولا بلاطات.
// المصادر:
//   • /api/reports/overall (مبيع − إرجاع) ← byProvince + byProvinceCompany: مبيع الشركات
//     بالمحافظة من الملفات نفسها — يعمل حتى قبل إنشاء حسابات المندوبين.
//   • /api/scientific-reps/province-map ← المندوبون العلميون بكل محافظة؛ تُنسَب الشركة
//     من `company` (الشركة الرئيسية لحساب المندوب) في قائمة reps الممرَّرة.
//
// ⚠️ الجلب يتحرّك بالملفات + الشهر فقط. حقلا التواريخ في ReportsPage يتبدّلان
// تلقائياً (فارغ↔مملوء)، وإدخالهما في الاعتماديات سبّب حلقة جلب لا تنتهي.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { IRAQ_PROVINCE_SHAPES, IRAQ_MAP_VIEWBOX } from '../data/iraqProvinces';
import ProvinceTeamsDirectory from './ProvinceTeamsDirectory';

interface RepRow { id: number; name: string; netValue: number; netQty?: number }
interface RepProvinceRow { provinceName: string; totalValue: number; reps: RepRow[] }

interface Props {
  reps: { id: number; company?: string | null }[];
  token: string | null;
  fileIds: number[];
  applyMonth: (p: URLSearchParams) => void;
  months?: string[];
  /** الشهر الافتراضي حُسم (شرائح الأشهر حُمِّلت) — قبله لا جلب. */
  ready?: boolean;
  monthKey: string;
  fromDate: string;
  toDate: string;
  fmtVal: (n: number) => string;
  currencyLabel: string;
}

interface CompanyCell { name: string; value: number; reps: RepRow[] }
interface ProvinceCell { name: string; total: number; companies: CompanyCell[]; repCount: number }

const norm = (s: string) => String(s || '').trim().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
const BAGHDAD = norm('بغداد');
const UNASSIGNED = norm('غير مصنّف');
const NO_COMPANY = 'بدون شركة';

// إزاحة الدبوس للمحافظات المتلاصقة الصغيرة كي لا تتراكب الأسماء
const LABEL_NUDGE: Record<string, [number, number]> = {
  [norm('كربلاء')]: [-30, 0], [norm('بابل')]: [22, -2], [norm('دهوك')]: [0, 10],
  [norm('القادسية')]: [-4, 24], [norm('واسط')]: [18, 0],
};

// مخبأ بطبقتين: ذاكرة الوحدة (تبقى بعد مغادرة الصفحة) + localStorage (يبقى بعد
// إعادة تحميل المتصفح) — فالدخول للخريطة يعرض آخر بيانات فوراً ثم يُجدّدها بصمت.
type SalesRows = { prov: Map<string, { name: string; value: number }>; pc: { p: string; c: string; v: number }[] };
type CacheEntry = { v: any; t: number };
const MEM = new Map<string, CacheEntry>();
const LS_PREFIX = 'iqmap:v1:';
const LS_MAX = 24;
const FRESH_MS = 3 * 60 * 1000;
function cacheGet(k: string): CacheEntry | undefined {
  const m = MEM.get(k); if (m) return m;
  try {
    const s = localStorage.getItem(LS_PREFIX + k);
    if (s) { const e = JSON.parse(s) as CacheEntry; MEM.set(k, e); return e; }
  } catch { /* تخزين غير متاح */ }
  return undefined;
}
function cacheSet(k: string, v: any) {
  const e = { v, t: Date.now() }; MEM.set(k, e);
  try {
    localStorage.setItem(LS_PREFIX + k, JSON.stringify(e));
    const keys: { k: string; t: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_PREFIX)) { try { keys.push({ k: key, t: JSON.parse(localStorage.getItem(key) || '{}').t || 0 }); } catch { keys.push({ k: key, t: 0 }); } }
    }
    if (keys.length > LS_MAX) keys.sort((x, y) => x.t - y.t).slice(0, keys.length - LS_MAX).forEach(x => localStorage.removeItem(x.k));
  } catch { /* امتلاء/حظر — الذاكرة تكفي */ }
}
const packSales = (r: SalesRows) => ({ prov: [...r.prov], pc: r.pc });
const unpackSales = (v: any): SalesRows => ({ prov: new Map(v?.prov ?? []), pc: v?.pc ?? [] });

const RAMP = ['#e0ecff', '#c7dbff', '#a3c2fb', '#78a3f5', '#4f84ea', '#2f66d6', '#1f4fb4', '#173a85'];
const VB = IRAQ_MAP_VIEWBOX;

export default function IraqRepsMap({ reps, token, fileIds, applyMonth, months = [], ready = true, monthKey, fromDate, toDate, fmtVal, currencyLabel }: Props) {
  const [repData, setRepData] = useState<RepProvinceRow[]>([]);
  const [salesRows, setSalesRows] = useState<{ prov: Map<string, { name: string; value: number }>; pc: { p: string; c: string; v: number }[] }>({ prov: new Map(), pc: [] });
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(1200);

  const repIdsKey = reps.map(r => r.id).join(',');
  const companyOf = useMemo(() => new Map(reps.map(r => [r.id, (r.company || '').trim() || NO_COMPANY])), [reps]);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    // عتبة 24px: ظهور شريط تمرير الصفحة يغيّر العرض قليلاً — تجاهله لتفادي الاهتزاز.
    const ro = new ResizeObserver(() => setWrapW(prev => Math.abs(el.clientWidth - prev) > 24 ? el.clientWidth : prev));
    ro.observe(el); if (el.clientWidth > 0) setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const latest = useRef({ applyMonth, fromDate, toDate });
  latest.current = { applyMonth, fromDate, toDate };

  const monthsRef = useRef(months); monthsRef.current = months;
  const tok = (token || '').slice(-12);
  const fileKey = fileIds.join(',');
  const [loadingSales, setLoadingSales] = useState(false);
  const [loadingReps, setLoadingReps] = useState(false);
  const loading = loadingSales || loadingReps;

  const paramsFor = (mk: string) => {
    const p = new URLSearchParams();
    if (mk === 'custom') {
      if (latest.current.fromDate) p.set('startDate', latest.current.fromDate);
      if (latest.current.toDate) p.set('endDate', latest.current.toDate);
    } else if (mk && mk !== 'all') p.set('month', mk);
    if (fileIds.length > 0) p.set('fileIds', fileKey);
    return p;
  };
  const prefetchMonths = () => [...monthsRef.current].filter(m => /^\d{4}-\d{2}$/.test(m) && m !== monthKey).sort().reverse().slice(0, 3);

  // ── مبيع المحافظات (لا ينتظر قائمة المندوبين) ──────────────────────────────
  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    const cacheable = monthKey !== 'custom';
    const keyOf = (mk: string) => `s|${tok}|${fileKey}|${mk}`;
    const hit = cacheable ? cacheGet(keyOf(monthKey)) : undefined;
    if (hit) setSalesRows(unpackSales(hit.v));
    // قبل حسم الشهر الافتراضي لا نجلب شيئاً — كان طلب «الكل» يُطلق ثم يُلغى ويهدر وقت السيرفر.
    if (!ready || !fileIds.length) {
      if (!fileIds.length) setSalesRows({ prov: new Map(), pc: [] });
      return () => { dead = true; };
    }

    const H = { Authorization: `Bearer ${token}` };
    const fetchSales = async (p: URLSearchParams): Promise<SalesRows> => {
      const [saleRes, retRes] = await Promise.all([
        fetch(`/api/reports/overall?${p}&recordType=sale`, { headers: H, signal: ac.signal }),
        fetch(`/api/reports/overall?${p}&recordType=return`, { headers: H, signal: ac.signal }),
      ]);
      const prov = new Map<string, { name: string; value: number }>();
      const pcMap = new Map<string, { p: string; c: string; v: number }>();
      const add = async (r: Response, sign: number) => {
        if (!r.ok) return;
        const j = await r.json(); const d = j.data ?? j;
        for (const row of d.byProvince ?? []) {
          const name = row.provinceName ?? row.name; if (!name) continue;
          const cur = prov.get(norm(name)) ?? { name, value: 0 };
          cur.value += sign * (row.totalValue ?? 0); prov.set(norm(name), cur);
        }
        for (const row of d.byProvinceCompany ?? []) {
          if (!row.provinceName || !row.companyName) continue;
          const k = `${norm(row.provinceName)}::${norm(row.companyName)}`;
          const cur = pcMap.get(k) ?? { p: row.provinceName, c: row.companyName, v: 0 };
          cur.v += sign * (row.totalValue ?? 0); pcMap.set(k, cur);
        }
      };
      await Promise.all([add(saleRes, 1), add(retRes, -1)]);
      return { prov, pc: [...pcMap.values()] };
    };

    (async () => {
      if (!hit || Date.now() - hit.t >= FRESH_MS) {
        if (!hit) setLoadingSales(true);
        setErr('');
        try {
          const r = await fetchSales(paramsFor(monthKey));
          if (dead) return;
          if (cacheable) cacheSet(keyOf(monthKey), packSales(r));
          setSalesRows(r);
        } catch (e: any) { if (!dead && e?.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل الخريطة'); }
        finally { if (!dead) setLoadingSales(false); }
      }
      // تحميل مسبق هادئ لأحدث الأشهر الأخرى كي يكون التبديل بينها فورياً.
      if (dead || !cacheable) return;
      for (const ym of prefetchMonths()) {
        const c = cacheGet(keyOf(ym));
        if (c && Date.now() - c.t < FRESH_MS) continue;
        await new Promise(r => setTimeout(r, 1200));
        if (dead) return;
        try { const r = await fetchSales(paramsFor(ym)); if (dead) return; cacheSet(keyOf(ym), packSales(r)); } catch { return; }
      }
    })();
    return () => { dead = true; ac.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, monthKey, tok, ready]);

  // ── المندوبون العلميون بكل محافظة (بالتوازي مع المبيع) ─────────────────────
  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    const cacheable = monthKey !== 'custom';
    const keyOf = (mk: string) => `r|${tok}|${repIdsKey}|${fileKey}|${mk}`;
    const hit = cacheable && repIdsKey ? cacheGet(keyOf(monthKey)) : undefined;
    if (hit) setRepData(hit.v);
    if (!ready || !repIdsKey) {
      if (!repIdsKey && ready) setRepData([]);
      return () => { dead = true; };
    }

    const H = { Authorization: `Bearer ${token}` };
    const fetchReps = async (p: URLSearchParams): Promise<RepProvinceRow[]> => {
      p.set('repIds', repIdsKey);
      const r = await fetch(`/api/scientific-reps/province-map?${p}`, { headers: H, signal: ac.signal });
      if (!r.ok) return [];
      const j = await r.json();
      return j.data ?? [];
    };

    (async () => {
      if (!hit || Date.now() - hit.t >= FRESH_MS) {
        if (!hit) setLoadingReps(true);
        try {
          const r = await fetchReps(paramsFor(monthKey));
          if (dead) return;
          if (cacheable) cacheSet(keyOf(monthKey), r);
          setRepData(r);
        } catch (e: any) { if (!dead && e?.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل المندوبين'); }
        finally { if (!dead) setLoadingReps(false); }
      }
      if (dead || !cacheable) return;
      for (const ym of prefetchMonths()) {
        const c = cacheGet(keyOf(ym));
        if (c && Date.now() - c.t < FRESH_MS) continue;
        await new Promise(r => setTimeout(r, 1500));
        if (dead) return;
        try { const r = await fetchReps(paramsFor(ym)); if (dead) return; cacheSet(keyOf(ym), r); } catch { return; }
      }
    })();
    return () => { dead = true; ac.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repIdsKey, fileKey, monthKey, tok, ready]);

  // ── دمج: محافظة ← شركات (مبيع + مندوبون) ─────────────────────────────────
  const cells = useMemo(() => {
    const out = new Map<string, ProvinceCell>();
    const cell = (name: string) => {
      const k = norm(name);
      if (!out.has(k)) out.set(k, { name, total: 0, companies: [], repCount: 0 });
      return out.get(k)!;
    };
    const company = (pc: ProvinceCell, name: string) => {
      let c = pc.companies.find(x => norm(x.name) === norm(name));
      if (!c) { c = { name, value: 0, reps: [] }; pc.companies.push(c); }
      return c;
    };
    for (const [k, v] of salesRows.prov) { if (k !== BAGHDAD) cell(v.name).total = v.value; }
    for (const r of salesRows.pc) {
      if (norm(r.p) === BAGHDAD || norm(r.c) === UNASSIGNED) continue;
      company(cell(r.p), r.c).value += r.v;
    }
    for (const pr of repData) {
      if (norm(pr.provinceName) === BAGHDAD) continue;
      const pc = cell(pr.provinceName);
      for (const rep of pr.reps) company(pc, companyOf.get(rep.id) || NO_COMPANY).reps.push(rep);
      pc.repCount = pr.reps.length;
      if (!salesRows.prov.has(norm(pr.provinceName))) pc.total = pr.totalValue;
    }
    for (const pc of out.values()) pc.companies.sort((a, b) => b.value - a.value);
    return out;
  }, [salesRows, repData, companyOf]);

  const list = useMemo(() => [...cells.values()].sort((a, b) => b.total - a.total), [cells]);
  const maxVal = Math.max(1, ...list.map(c => c.total));
  const fillOf = (c?: ProvinceCell) => {
    if (!c || c.total <= 0) return '#edf1f7';
    const t = Math.sqrt(c.total / maxVal);
    return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))];
  };

  // اختيار افتراضي: أعلى محافظة مبيعاً — كي لا تبدو اللوحة فارغة عند الدخول
  useEffect(() => {
    if (sel && cells.has(norm(sel))) return;
    setSel(list[0]?.name ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const active = hover ?? sel;
  const activeCell = active ? cells.get(norm(active)) : undefined;
  const selCell = sel ? cells.get(norm(sel)) : undefined;

  const totals = useMemo(() => {
    const cos = new Set<string>(); const rp = new Set<number>(); let v = 0;
    for (const c of list) { v += c.total; c.companies.forEach(x => { cos.add(norm(x.name)); x.reps.forEach(r => rp.add(r.id)); }); }
    return { value: v, companies: cos.size, reps: rp.size, provinces: list.filter(c => c.total !== 0 || c.repCount > 0).length };
  }, [list]);

  const side = wrapW >= 940;

  const companyPanel = (c: ProvinceCell) => {
    const cmax = Math.max(1, ...c.companies.map(x => Math.abs(x.value)));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {c.companies.length === 0 && <div style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد شركات مسجّلة في هذه المحافظة للفترة المختارة.</div>}
        {c.companies.map(co => (
          <div key={co.name} style={{ border: '1px solid #e6ebf2', borderRadius: 14, padding: '10px 12px', background: '#fbfcfe' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>{co.name}</span>
              <span style={{ fontWeight: 800, fontSize: 14, color: co.value < 0 ? '#be123c' : '#1f4fb4', direction: 'ltr' }}>{fmtVal(co.value)}</span>
            </div>
            <div style={{ height: 5, borderRadius: 5, background: '#e9eef5', margin: '8px 0' }}>
              <div style={{ height: '100%', width: `${Math.max(3, (Math.abs(co.value) / cmax) * 100)}%`, background: 'linear-gradient(90deg,#2f66d6,#78a3f5)', borderRadius: 5 }} />
            </div>
            {co.reps.length === 0
              ? <span style={{ fontSize: 12, color: '#94a3b8' }}>لا يوجد مندوب علمي بعد</span>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {[...co.reps].sort((a, b) => b.netValue - a.netValue).map(r => {
                    // حصّة المندوب من مبيع الشركة بالمحافظة = إنتاجيته الفعلية
                    const share = co.value > 0 ? Math.max(0, Math.min(100, (r.netValue / co.value) * 100)) : 0;
                    return (
                      <div key={r.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#334155', fontWeight: 600 }}>
                            <span style={{ width: 17, height: 17, borderRadius: '50%', background: '#0f766e', color: '#fff', fontSize: 9.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{r.name.trim().charAt(0)}</span>
                            {r.name}
                          </span>
                          <span style={{ fontWeight: 800, color: r.netValue < 0 ? '#be123c' : '#0f766e' }}>{fmtVal(r.netValue)} <span style={{ color: '#94a3b8', fontWeight: 600 }}>· {share.toFixed(share >= 10 ? 0 : 1)}%</span></span>
                        </div>
                        <div style={{ height: 4, borderRadius: 4, background: '#e9eef5', marginTop: 4 }}>
                          <div style={{ height: '100%', width: `${share}%`, minWidth: share > 0 ? 3 : 0, background: 'linear-gradient(90deg,#0f766e,#5eead4)', borderRadius: 4 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ marginTop: 14 }}>
      {/* شريط ملخص */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
        {([
          ['صافي مبيع المحافظات', `${fmtVal(totals.value)} ${currencyLabel}`, '#2f66d6'],
          ['الشركات', String(totals.companies), '#0f766e'],
          ['المندوبون العلميون', String(totals.reps), '#7c3aed'],
          ['المحافظات النشطة', `${totals.provinces} / 17`, '#ea580c'],
        ] as const).map(([l, v, c]) => (
          <div key={l} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: '10px 14px', position: 'relative', overflow: 'hidden' }}>
            <span style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, width: 4, background: c }} />
            <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
        <button type="button" onClick={() => setTeamsOpen(true)}
          style={{ border: '1px solid #cbd5e1', background: '#0f172a', color: '#fff', borderRadius: 999, padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          👥 فرق المحافظات (التيم ليدر والمندوبون)
        </button>
      </div>
      {teamsOpen && (
        <ProvinceTeamsDirectory token={token} fileIds={fileIds} applyMonth={applyMonth} fmtVal={fmtVal} currencyLabel={currencyLabel} onClose={() => setTeamsOpen(false)} />
      )}

      {err && <div style={{ color: '#be123c', fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: side ? 'minmax(0, 1.55fr) minmax(300px, 1fr)' : '1fr', gap: 14, alignItems: 'start' }}>
        {/* ── الخريطة ── */}
        <div style={{ position: 'relative', background: 'radial-gradient(900px 500px at 40% 20%, #ffffff 0%, #eef3fa 70%)', border: '1px solid #e2e8f0', borderRadius: 22, padding: '14px 10px 10px', overflow: 'hidden' }}>
          {loading && (
            <div style={{ position: 'absolute', top: 12, insetInlineStart: 14, zIndex: 3, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', background: 'rgba(255,255,255,.9)', border: '1px solid #e2e8f0', borderRadius: 999, padding: '4px 10px' }}>
              جاري التحميل…
            </div>
          )}
          <div style={{ position: 'relative', width: side ? '82%' : '100%', maxWidth: 820, marginLeft: 0, marginRight: side ? 'auto' : 'auto' }}>
            <svg viewBox={`-20 -20 ${VB.w + 40} ${VB.h + 40}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="خريطة محافظات العراق">
              <defs>
                <filter id="iqMapShadow" x="-10%" y="-10%" width="120%" height="120%">
                  <feDropShadow dx="0" dy="8" stdDeviation="10" floodColor="#1e3a8a" floodOpacity="0.16" />
                </filter>
                <pattern id="iqHatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="10" height="10" fill="#f1f5f9" /><line x1="0" y1="0" x2="0" y2="10" stroke="#cbd5e1" strokeWidth="3" />
                </pattern>
              </defs>
              <g filter="url(#iqMapShadow)">
                {IRAQ_PROVINCE_SHAPES.map(s => {
                  const k = norm(s.name);
                  const c = cells.get(k);
                  const isB = k === BAGHDAD;
                  const on = active && norm(active) === k;
                  return (
                    <path key={s.name} d={s.d} fillRule="evenodd"
                      fill={isB ? 'url(#iqHatch)' : fillOf(c)}
                      stroke={on ? '#0f172a' : '#ffffff'} strokeWidth={on ? 3.5 : 2} strokeLinejoin="round"
                      style={{ cursor: isB ? 'default' : 'pointer', transition: 'fill .25s, opacity .2s' }}
                      opacity={active && !on && !isB ? 0.82 : 1}
                      onMouseEnter={() => !isB && setHover(s.name)} onMouseLeave={() => setHover(null)}
                      onClick={() => !isB && setSel(s.name)} />
                  );
                })}
              </g>
              {/* دبابيس المحافظات: عدد الشركات + الاسم + المبيع */}
              {IRAQ_PROVINCE_SHAPES.map(s => {
                const k = norm(s.name);
                const [dx, dy] = LABEL_NUDGE[k] ?? [0, 0];
                const x = s.cx + dx, y = s.cy + dy;
                if (k === BAGHDAD) {
                  return <text key={s.name} x={x} y={y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 13, fontWeight: 700, fill: '#94a3b8', pointerEvents: 'none' }}>بغداد</text>;
                }
                const c = cells.get(k);
                const n = c?.companies.length ?? 0;
                const on = active && norm(active) === k;
                const dark = !!c && c.total > 0 && Math.sqrt(c.total / maxVal) > 0.55;
                return (
                  <g key={s.name} style={{ cursor: 'pointer' }} onMouseEnter={() => setHover(s.name)} onMouseLeave={() => setHover(null)} onClick={() => setSel(s.name)}>
                    <text x={x} y={y - 30} textAnchor="middle" style={{ fontSize: 15, fontWeight: 800, fill: dark ? '#ffffff' : '#1e293b', paintOrder: 'stroke', stroke: dark ? 'rgba(15,23,42,.35)' : 'rgba(255,255,255,.85)', strokeWidth: 3, pointerEvents: 'none' }}>{s.name}</text>
                    <circle cx={x} cy={y} r={on ? 20 : 17} fill={n > 0 ? '#0f172a' : '#ffffff'} stroke={n > 0 ? '#ffffff' : '#94a3b8'} strokeWidth={3} />
                    <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 15, fontWeight: 800, fill: n > 0 ? '#ffffff' : '#94a3b8', pointerEvents: 'none' }}>{n}</text>
                    {c && c.total !== 0 && (
                      <text x={x} y={y + 38} textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: dark ? '#ffffff' : '#1f4fb4', paintOrder: 'stroke', stroke: dark ? 'rgba(15,23,42,.35)' : 'rgba(255,255,255,.9)', strokeWidth: 3, pointerEvents: 'none' }}>{fmtVal(c.total)}</text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* بطاقة ثابتة أعلى يمين الخريطة: تعرض المحافظة تحت المؤشر، وإلا المختارة */}
          {activeCell && (
            <div dir="rtl" style={{
              position: 'absolute', top: 12, right: 12, zIndex: 4, width: 250, maxHeight: '58%', overflowY: 'auto',
              background: 'rgba(15,23,42,.95)', color: '#fff', borderRadius: 16, padding: '12px 14px',
              boxShadow: '0 12px 30px rgba(15,23,42,.28)', fontSize: 12.5,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontWeight: 800, fontSize: 15, marginBottom: 2 }}>
                <span>{activeCell.name}</span><span style={{ direction: 'ltr', color: '#93c5fd' }}>{fmtVal(activeCell.total)}</span>
              </div>
              <div style={{ color: '#94a3b8', fontSize: 11.5, marginBottom: 8 }}>{activeCell.companies.length} شركات · {activeCell.companies.reduce((n, x) => n + x.reps.length, 0)} مندوب علمي</div>
              {activeCell.companies.map(co => (
                <div key={co.name} style={{ padding: '6px 0', borderTop: '1px solid rgba(148,163,184,.2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: 700 }}>
                    <span>{co.name}</span><span style={{ direction: 'ltr' }}>{fmtVal(co.value)}</span>
                  </div>
                  {co.reps.map(r => (
                    <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: '#5eead4', fontSize: 11.5, paddingTop: 2 }}>
                      <span>• {r.name}</span><span style={{ direction: 'ltr' }}>{fmtVal(r.netValue)}</span>
                    </div>
                  ))}
                </div>
              ))}
              {activeCell.companies.length === 0 && <div style={{ color: '#94a3b8' }}>لا شركات بعد</div>}
            </div>
          )}

          {/* مفتاح */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 14, fontSize: 11.5, color: '#64748b', marginTop: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              أقل <span style={{ display: 'inline-flex', borderRadius: 5, overflow: 'hidden' }}>{RAMP.map(c => <span key={c} style={{ width: 16, height: 9, background: c }} />)}</span> أعلى مبيعاً
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 16, height: 16, borderRadius: '50%', background: '#0f172a', color: '#fff', fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>n</span> عدد الشركات
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 16, height: 10, borderRadius: 3, background: 'repeating-linear-gradient(45deg,#f1f5f9 0 3px,#cbd5e1 3px 5px)' }} /> بغداد مستثناة
            </span>
          </div>
        </div>

        {/* ── لوحة المحافظة المختارة ── */}
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 22, padding: 16, position: side ? 'sticky' : 'static', top: 12 }}>
          {selCell ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>المحافظة</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a', lineHeight: 1.2 }}>{selCell.name}</div>
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>صافي المبيع</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: selCell.total < 0 ? '#be123c' : '#1f4fb4' }}>{fmtVal(selCell.total)} <span style={{ fontSize: 12, color: '#64748b' }}>{currencyLabel}</span></div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 12, fontWeight: 700, background: '#eef3fd', color: '#1f4fb4', borderRadius: 999, padding: '4px 12px' }}>{selCell.companies.length} شركات</span>
                <span style={{ fontSize: 12, fontWeight: 700, background: '#f3efff', color: '#6d28d9', borderRadius: 999, padding: '4px 12px' }}>{selCell.companies.reduce((s, x) => s + x.reps.length, 0)} مندوب علمي</span>
              </div>
              {companyPanel(selCell)}
            </>
          ) : (
            <div style={{ color: '#64748b', fontSize: 13, padding: 20, textAlign: 'center' }}>
              {loading ? 'جاري تحميل بيانات المحافظات…' : 'اضغط على محافظة في الخريطة لعرض شركاتها ومندوبيها ومبيعاتها.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
