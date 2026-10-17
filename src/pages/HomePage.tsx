// ════════════════════════════════════════════════════════════════════════════
// HomePage — «الرئيسية»: آخر تطورات مبيع الايتمات المتابَعة شهراً بشهر.
//
// • الايتمات المتابَعة يختارها المدير (تُحفظ لكل حساب في المتصفح). قبل أن يختار
//   شيئاً تُعرض تلقائياً الأعلى مبيعاً في آخر شهر.
// • لكل ايتم: مبيع الشهر (كمية + قيمة)، الإرجاع، التغيّر عن الشهر السابق، ومنحنى
//   الأشهر. الضغط على ايتم يفتح تفصيله: أعمدة الأشهر + توزيعه على المحافظات +
//   جدول محافظة × شهر.
// • المصدر: GET /api/reports/home-items (+ /:itemId/provinces) — نفس نطاق
//   «التحليل الشامل» (server/modules/reports/homeItems.js). القيم تصل بالدولار
//   دائماً، والتحويل للدينار للعرض فقط بسعر صرف الملف.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { PageId } from '../App';

const API = import.meta.env.VITE_API_URL || '';

type Cell = [number, number, number, number]; // [مبيع كمية، مبيع قيمة، إرجاع كمية، إرجاع قيمة]
interface HomeItem { id: number; name: string; company: string | null; m: Record<string, Cell> }
interface HomeData {
  months: string[];
  items: HomeItem[];
  sources: ('office' | 'mercato')[];
  source?: 'office' | 'mercato';
  files: { id: number; name: string }[];
  currencyMode?: 'USD' | 'IQD';
  exchangeRate?: number;
}
interface ProvRow { name: string; m: Record<string, Cell> }

type Basis = 'sale' | 'net';
type Metric = 'value' | 'qty';

interface Props { activeFileIds: number[]; onNavigate: (p: PageId) => void }

const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const monthName = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${AR_MONTHS[m - 1]} ${y}`; };
const monthShort = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${AR_MONTHS[m - 1]} ${String(y).slice(2)}`; };
const prevYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const EMPTY: Cell = [0, 0, 0, 0];
const AUTO_PIN_COUNT = 8;
const SPARK_MONTHS = 6;

// ذاكرة مؤقتة على مستوى الوحدة: العودة للصفحة فورية بلا انتظار.
const dataCache = new Map<string, HomeData>();
const provCache = new Map<string, ProvRow[]>();

const fmtFull = (n: number) => Math.round(n).toLocaleString('en-US');
function fmtCompact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  return fmtFull(n);
}

export default function HomePage({ activeFileIds, onNavigate }: Props) {
  const { token, user } = useAuth();
  const fileKey = [...activeFileIds].sort((a, b) => a - b).join(',');

  const [source, setSource] = useState<'office' | 'mercato' | ''>('');
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [month, setMonth] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'IQD' | ''>('');
  const [basis, setBasis] = useState<Basis>('sale');
  const [metric, setMetric] = useState<Metric>('value');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [boardQuery, setBoardQuery] = useState('');

  // ── الايتمات المتابَعة (لكل حساب) ──────────────────────────────────────────
  const pinKey = `homePinnedItems_${user?.id ?? ''}`;
  const [pinned, setPinned] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(pinKey) || '[]'); } catch { return []; }
  });
  const savePinned = (ids: number[]) => {
    setPinned(ids);
    try { localStorage.setItem(pinKey, JSON.stringify(ids)); } catch { /* تخزين محجوب */ }
  };
  const togglePin = (id: number) => savePinned(pinned.includes(id) ? pinned.filter(x => x !== id) : [...pinned, id]);

  // ── الجلب ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !fileKey) { setData(null); return; }
    const key = `${fileKey}|${source}`;
    const hit = dataCache.get(key);
    if (hit) setData(hit);
    const ac = new AbortController();
    if (!hit) setLoading(true);
    setErr('');
    const p = new URLSearchParams({ fileIds: fileKey });
    if (source) p.set('source', source);
    fetch(`${API}/api/reports/home-items?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل البيانات');
        dataCache.set(key, j.data);
        setData(j.data);
      })
      .catch(e => { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل البيانات'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [token, fileKey, source]);

  const months = data?.months ?? [];
  const latest = months[months.length - 1] ?? '';
  const activeMonth = month && months.includes(month) ? month : latest;
  const prevMonth = activeMonth ? prevYm(activeMonth) : '';
  const cur = currency || data?.currencyMode || 'IQD';
  const rate = data?.exchangeRate || 1470;
  const money = (usd: number) => (cur === 'IQD' ? usd * rate : usd);
  const curLabel = cur === 'IQD' ? 'د.ع' : '$';

  /** قيمة الخلية حسب الأساس (مبيع/صافي) والمقياس (قيمة/كمية) */
  const pick = (c: Cell | undefined, m: Metric = metric): number => {
    const x = c ?? EMPTY;
    if (m === 'qty') return basis === 'net' ? x[0] - x[2] : x[0];
    return money(basis === 'net' ? x[1] - x[3] : x[1]);
  };
  const fmtMetric = (n: number, m: Metric = metric, compact = false) =>
    m === 'qty' ? `${(compact ? fmtCompact : fmtFull)(n)}` : `${(compact ? fmtCompact : fmtFull)(n)} ${curLabel}`;

  const itemsById = useMemo(() => new Map((data?.items ?? []).map(i => [i.id, i])), [data]);

  // الترتيب في الشهر المختار — مصدر «تلقائي» ولوحة كل الايتمات
  const ranked = useMemo(() =>
    [...(data?.items ?? [])].sort((a, b) => (b.m[activeMonth]?.[1] ?? 0) - (a.m[activeMonth]?.[1] ?? 0)),
  [data, activeMonth]);

  const validPinned = pinned.filter(id => itemsById.has(id));
  const isAuto = validPinned.length === 0;
  const watched: HomeItem[] = isAuto
    ? ranked.filter(i => (i.m[activeMonth]?.[1] ?? 0) > 0).slice(0, AUTO_PIN_COUNT)
    : validPinned.map(id => itemsById.get(id)!);

  useEffect(() => {
    if (selectedId != null && itemsById.has(selectedId)) return;
    setSelectedId(watched[0]?.id ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsById, watched[0]?.id]);

  // ── مؤشرات الايتمات المتابَعة في الشهر المختار ────────────────────────────
  const sumCells = (list: HomeItem[], ym: string): Cell => list.reduce<Cell>((acc, it) => {
    const c = it.m[ym]; if (!c) return acc;
    return [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2], acc[3] + c[3]];
  }, [0, 0, 0, 0]);
  const totNow = sumCells(watched, activeMonth);
  const totPrev = sumCells(watched, prevMonth);
  const hasPrev = months.includes(prevMonth);

  // ── تفصيل المحافظات للايتم المختار ─────────────────────────────────────────
  const [provRows, setProvRows] = useState<ProvRow[] | null>(null);
  const [provLoading, setProvLoading] = useState(false);
  useEffect(() => {
    if (!token || !fileKey || selectedId == null || !data) { setProvRows(null); return; }
    const key = `${fileKey}|${data.source ?? ''}|${selectedId}`;
    const hit = provCache.get(key);
    if (hit) { setProvRows(hit); return; }
    setProvRows(null);
    setProvLoading(true);
    const ac = new AbortController();
    const p = new URLSearchParams({ fileIds: fileKey });
    if (data.source) p.set('source', data.source);
    fetch(`${API}/api/reports/home-items/${selectedId}/provinces?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => { if (j.success) { provCache.set(key, j.data.provinces); setProvRows(j.data.provinces); } })
      .catch(() => { /* إلغاء أو شبكة — تبقى الحالة فارغة */ })
      .finally(() => { if (!ac.signal.aborted) setProvLoading(false); });
    return () => ac.abort();
  }, [token, fileKey, selectedId, data]);

  const selected = selectedId != null ? itemsById.get(selectedId) ?? null : null;

  // ════════════════════════════════════════════════════════════════════════
  if (!fileKey) {
    return (
      <div className="page hp">
        <HomeStyles />
        <div className="hp-empty">
          <div className="hp-empty-icon">📂</div>
          <div className="hp-empty-title">لا توجد ملفات مبيعات مفعّلة</div>
          <div className="hp-empty-sub">فعّل ملف المبيعات من صفحة «تحليل المبيعات» لتظهر هنا آخر تطورات الايتمات.</div>
          <button className="btn btn-primary" onClick={() => onNavigate('rep-analysis')}>الذهاب إلى تحليل المبيعات</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page hp">
      <HomeStyles />

      {/* ── شريط التحكم ── */}
      <div className="hp-toolbar">
        <div className="hp-months" role="tablist" aria-label="الشهر">
          {[...months].reverse().map(ym => (
            <button key={ym} role="tab" aria-selected={ym === activeMonth}
              className={`hp-chip ${ym === activeMonth ? 'is-on' : ''}`} onClick={() => setMonth(ym)}>
              {monthName(ym)}
            </button>
          ))}
          {loading && months.length === 0 && <span className="hp-muted">جاري التحميل…</span>}
        </div>
        <div className="hp-controls">
          {(data?.sources?.length ?? 0) > 1 && (
            <Segmented value={data?.source ?? 'office'} onChange={v => setSource(v as 'office' | 'mercato')}
              options={[['office', 'المكتب'], ['mercato', 'ميركاتو']]} />
          )}
          <Segmented value={basis} onChange={v => setBasis(v as Basis)} options={[['sale', 'مبيع'], ['net', 'صافي']]} />
          <Segmented value={cur} onChange={v => setCurrency(v as 'USD' | 'IQD')} options={[['IQD', 'دينار'], ['USD', 'دولار']]} />
          <button className="btn hp-manage" onClick={() => setShowPicker(true)}>⭐ اختيار الايتمات</button>
        </div>
      </div>

      {err && <div className="alert alert-error" style={{ marginBottom: 12 }}>{err}</div>}

      {data && months.length === 0 && !loading && (
        <div className="hp-empty"><div className="hp-empty-title">لا يوجد مبيع مؤرَّخ في الملفات المفعّلة</div></div>
      )}

      {months.length > 0 && (
        <>
          {/* ── المؤشرات ── */}
          <div className="hp-kpis">
            <Kpi label={`${basis === 'net' ? 'صافي' : 'مبيع'} ${monthName(activeMonth)}`}
              value={fmtMetric(pick(totNow, 'value'), 'value')}
              delta={hasPrev ? pctChange(pick(totNow, 'value'), pick(totPrev, 'value')) : null} accent />
            <Kpi label="الكمية" value={fmtFull(pick(totNow, 'qty'))}
              delta={hasPrev ? pctChange(pick(totNow, 'qty'), pick(totPrev, 'qty')) : null} />
            <Kpi label="الإرجاع" value={`${fmtFull(money(totNow[3]))} ${curLabel}`} sub={`${fmtFull(totNow[2])} قطعة`} />
            <Kpi label="الايتمات المتابَعة" value={String(watched.length)}
              sub={isAuto ? 'تلقائياً: الأعلى مبيعاً' : 'من اختيارك'} />
          </div>

          {/* ── بطاقات الايتمات ── */}
          <div className="hp-section-head">
            <h2 className="section-title" style={{ margin: 0 }}>الايتمات المتابَعة</h2>
            {isAuto && <span className="hp-muted">اضغط ⭐ على أي ايتم لتثبيته هنا</span>}
          </div>
          <div className="hp-cards">
            {watched.map(it => {
              const nowV = pick(it.m[activeMonth], 'value');
              const prevV = pick(it.m[prevMonth], 'value');
              const nowQ = pick(it.m[activeMonth], 'qty');
              const share = pick(totNow, 'value') > 0 ? nowV / pick(totNow, 'value') : 0;
              const idx = months.indexOf(activeMonth);
              const spark = months.slice(Math.max(0, idx - SPARK_MONTHS + 1), idx + 1);
              return (
                <button key={it.id} className={`hp-card ${it.id === selectedId ? 'is-on' : ''}`} onClick={() => setSelectedId(it.id)}>
                  <div className="hp-card-top">
                    <div style={{ minWidth: 0 }}>
                      <div className="hp-card-name" title={it.name}>{it.name}</div>
                      {it.company && <div className="hp-card-co">{it.company}</div>}
                    </div>
                    <span className={`hp-star ${pinned.includes(it.id) ? 'is-on' : ''}`} role="button" tabIndex={0}
                      title={pinned.includes(it.id) ? 'إلغاء المتابعة' : 'متابعة'}
                      onClick={e => { e.stopPropagation(); togglePin(it.id); }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); togglePin(it.id); } }}>
                      {pinned.includes(it.id) ? '★' : '☆'}
                    </span>
                  </div>
                  <div className="hp-card-value">{fmtCompact(nowV)} <small>{curLabel}</small></div>
                  <div className="hp-card-row">
                    <span>{fmtFull(nowQ)} قطعة</span>
                    {hasPrev && <Delta pct={pctChange(nowV, prevV)} />}
                  </div>
                  <Sparkline values={spark.map(ym => pick(it.m[ym], 'value'))} />
                  <div className="hp-share" title={`حصته من الايتمات المتابَعة: ${(share * 100).toFixed(1)}%`}>
                    <div style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </div>
                </button>
              );
            })}
            {watched.length === 0 && <div className="hp-muted">لا يوجد مبيع في هذا الشهر.</div>}
          </div>

          {/* ── تفصيل الايتم المختار ── */}
          {selected && (
            <div className="card hp-detail">
              <div className="hp-detail-head">
                <div>
                  <div className="hp-detail-title">{selected.name}</div>
                  <div className="hp-muted">{selected.company ?? '—'} · {basis === 'net' ? 'صافي (مبيع − إرجاع)' : 'المبيع'}</div>
                </div>
                <div className="hp-controls">
                  <Segmented value={metric} onChange={v => setMetric(v as Metric)} options={[['value', 'القيمة'], ['qty', 'الكمية']]} />
                  <button className="btn" onClick={() => togglePin(selected.id)}>
                    {pinned.includes(selected.id) ? '★ متابَع' : '☆ متابعة'}
                  </button>
                </div>
              </div>

              <div className="hp-detail-grid">
                <div>
                  <div className="hp-sub-title">الأشهر</div>
                  <MonthBars months={months} active={activeMonth} onPick={setMonth}
                    values={months.map(ym => pick(selected.m[ym]))}
                    fmt={n => fmtMetric(n)} />
                </div>
                <div>
                  <div className="hp-sub-title">المحافظات — {monthName(activeMonth)}</div>
                  <ProvinceBars rows={provRows} loading={provLoading} ym={activeMonth} pick={pick} fmt={n => fmtMetric(n)} />
                </div>
              </div>

              {provRows && provRows.length > 0 && (
                <ProvinceMonthTable rows={provRows} months={months} active={activeMonth} pick={pick} />
              )}
            </div>
          )}

          {/* ── كل الايتمات في الشهر ── */}
          <div className="card hp-board">
            <div className="hp-section-head" style={{ marginTop: 0 }}>
              <h2 className="section-title" style={{ margin: 0 }}>كل الايتمات — {monthName(activeMonth)}</h2>
              <input className="form-input hp-search" placeholder="بحث عن ايتم…" value={boardQuery} onChange={e => setBoardQuery(e.target.value)} />
            </div>
            <div className="table-wrapper">
              <table className="data-table hp-table">
                <thead>
                  <tr><th style={{ width: 36 }}></th><th>#</th><th>الايتم</th><th>الشركة</th><th>الكمية</th><th>القيمة ({curLabel})</th><th>الإرجاع</th><th>عن الشهر السابق</th></tr>
                </thead>
                <tbody>
                  {ranked
                    .filter(it => !boardQuery.trim() || it.name.toLowerCase().includes(boardQuery.trim().toLowerCase()) || (it.company ?? '').toLowerCase().includes(boardQuery.trim().toLowerCase()))
                    .filter(it => it.m[activeMonth])
                    .slice(0, 60)
                    .map((it, i) => (
                      <tr key={it.id} className={it.id === selectedId ? 'is-on' : ''} onClick={() => setSelectedId(it.id)} style={{ cursor: 'pointer' }}>
                        <td><span className={`hp-star ${pinned.includes(it.id) ? 'is-on' : ''}`} onClick={e => { e.stopPropagation(); togglePin(it.id); }}>{pinned.includes(it.id) ? '★' : '☆'}</span></td>
                        <td className="hp-muted">{i + 1}</td>
                        <td style={{ fontWeight: 600 }}>{it.name}</td>
                        <td className="hp-muted">{it.company ?? '—'}</td>
                        <td>{fmtFull(pick(it.m[activeMonth], 'qty'))}</td>
                        <td style={{ fontWeight: 600 }}>{fmtFull(pick(it.m[activeMonth], 'value'))}</td>
                        <td className="hp-muted">{fmtFull(it.m[activeMonth]?.[2] ?? 0)}</td>
                        <td>{hasPrev ? <Delta pct={pctChange(pick(it.m[activeMonth], 'value'), pick(it.m[prevMonth], 'value'))} /> : '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showPicker && data && (
        <ItemPicker items={ranked} month={activeMonth} pinned={validPinned}
          onSave={ids => { savePinned(ids); setShowPicker(false); }}
          onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
function pctChange(now: number, prev: number): number | null {
  if (!prev) return now ? Infinity : null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="hp-delta is-flat">—</span>;
  if (pct === Infinity) return <span className="hp-delta is-up">جديد</span>;
  const up = pct >= 0;
  return <span className={`hp-delta ${up ? 'is-up' : 'is-down'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%</span>;
}

function Kpi({ label, value, sub, delta, accent }: { label: string; value: string; sub?: string; delta?: number | null; accent?: boolean }) {
  return (
    <div className={`hp-kpi ${accent ? 'is-accent' : ''}`}>
      <div className="hp-kpi-label">{label}</div>
      <div className="hp-kpi-value">{value}</div>
      <div className="hp-kpi-sub">
        {delta !== undefined && <><Delta pct={delta ?? null} /> <span>عن الشهر السابق</span></>}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="hp-seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={v === value} className={v === value ? 'is-on' : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="hp-spark" />;
  const w = 120, h = 32, pad = 3;
  const max = Math.max(...values, 0), min = Math.min(...values, 0);
  const span = max - min || 1;
  // RTL: الأقدم يميناً والأحدث يساراً — يطابق اتجاه قراءة الأشهر في الصفحة
  const pts = values.map((v, i) => [w - pad - (i * (w - 2 * pad)) / (values.length - 1), h - pad - ((v - min) / span) * (h - 2 * pad)]);
  const line = pts.map(p => p.join(',')).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className="hp-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`${pts[0][0]},${h} ${line} ${last[0]},${h}`} className="hp-spark-area" />
      <polyline points={line} className="hp-spark-line" />
      <circle cx={last[0]} cy={last[1]} r="3" className="hp-spark-dot" />
    </svg>
  );
}

function MonthBars({ months, values, active, onPick, fmt }: {
  months: string[]; values: number[]; active: string; onPick: (ym: string) => void; fmt: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...values.map(v => Math.max(0, v)), 1);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ left: -1e6 }); }, [months.length]);
  return (
    <div className="hp-bars-wrap" ref={scroller}>
      <div className="hp-bars" style={{ minWidth: months.length * 46 }}>
        {months.map((ym, i) => {
          const v = values[i];
          const hPct = Math.max(0, v) / max * 100;
          return (
            <button key={ym} className={`hp-bar ${ym === active ? 'is-on' : ''}`} onClick={() => onPick(ym)}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              aria-label={`${monthName(ym)}: ${fmt(v)}`}>
              {hover === i && <span className="hp-tip">{monthName(ym)}<b>{fmt(v)}</b></span>}
              <span className="hp-bar-track"><span className="hp-bar-fill" style={{ height: `${hPct}%` }} /></span>
              <span className="hp-bar-label">{monthShort(ym)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProvinceBars({ rows, loading, ym, pick, fmt }: {
  rows: ProvRow[] | null; loading: boolean; ym: string; pick: (c: Cell | undefined) => number; fmt: (n: number) => string;
}) {
  if (loading && !rows) return <div className="hp-muted" style={{ padding: 16 }}>جاري تحميل المحافظات…</div>;
  const list = (rows ?? []).map(r => ({ name: r.name, v: pick(r.m[ym]) })).filter(r => r.v !== 0).sort((a, b) => b.v - a.v);
  if (list.length === 0) return <div className="hp-muted" style={{ padding: 16 }}>لا مبيع لهذا الايتم في هذا الشهر.</div>;
  const total = list.reduce((s, r) => s + r.v, 0);
  const max = Math.max(...list.map(r => r.v), 1);
  return (
    <div className="hp-prov">
      {list.map(r => (
        <div key={r.name} className="hp-prov-row" title={`${r.name}: ${fmt(r.v)}`}>
          <span className="hp-prov-name">{r.name}</span>
          <span className="hp-prov-track"><span style={{ width: `${Math.max(1, (Math.max(0, r.v) / max) * 100)}%` }} /></span>
          <span className="hp-prov-val">{fmt(r.v)}</span>
          <span className="hp-prov-pct">{total > 0 ? `${((r.v / total) * 100).toFixed(0)}%` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function ProvinceMonthTable({ rows, months, active, pick }: {
  rows: ProvRow[]; months: string[]; active: string; pick: (c: Cell | undefined, m?: Metric) => number;
}) {
  const idx = months.indexOf(active);
  const cols = months.slice(Math.max(0, idx - 5), idx + 1).reverse();
  const sorted = [...rows].sort((a, b) => pick(b.m[active]) - pick(a.m[active]));
  const max = Math.max(...sorted.flatMap(r => cols.map(c => pick(r.m[c]))), 1);
  return (
    <div style={{ marginTop: 18 }}>
      <div className="hp-sub-title">المحافظة × الشهر <span className="hp-muted">(الكمية · القيمة)</span></div>
      <div className="table-wrapper">
        <table className="data-table hp-table hp-heat">
          <thead><tr><th>المحافظة</th>{cols.map(c => <th key={c} className={c === active ? 'is-on' : ''}>{monthShort(c)}</th>)}</tr></thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.name}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                {cols.map(c => {
                  const v = pick(r.m[c]);
                  const a = Math.max(0, v) / max;
                  return (
                    <td key={c} style={{ background: v ? `rgba(26,86,219,${0.06 + a * 0.32})` : undefined }}>
                      {r.m[c] ? <><b>{fmtFull(pick(r.m[c], 'qty'))}</b><small>{fmtCompact(pick(r.m[c], 'value'))}</small></> : <span className="hp-muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemPicker({ items, month, pinned, onSave, onClose }: {
  items: HomeItem[]; month: string; pinned: number[]; onSave: (ids: number[]) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState<number[]>(pinned);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = items.filter(it => !needle || it.name.toLowerCase().includes(needle) || (it.company ?? '').toLowerCase().includes(needle));
  const toggle = (id: number) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hp-picker" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>اختيار الايتمات المتابَعة</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '12px 20px 0' }}>
          <input className="form-input" autoFocus placeholder="بحث بالاسم أو الشركة…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="hp-muted" style={{ margin: '8px 0' }}>
            المختار: {sel.length} · بدون اختيار تُعرض تلقائياً الأعلى مبيعاً
            {sel.length > 0 && <button className="hp-link" onClick={() => setSel([])}>مسح الكل</button>}
          </div>
        </div>
        <div className="hp-picker-list">
          {list.map(it => (
            <label key={it.id} className={`hp-picker-row ${sel.includes(it.id) ? 'is-on' : ''}`}>
              <input type="checkbox" checked={sel.includes(it.id)} onChange={() => toggle(it.id)} />
              <span className="hp-picker-name">{it.name}</span>
              <span className="hp-muted">{it.company ?? ''}</span>
              <span className="hp-picker-qty">{it.m[month] ? `${fmtFull(it.m[month][0])} قطعة` : '—'}</span>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>إلغاء</button>
          <button className="btn btn-primary" onClick={() => onSave(sel)}>حفظ</button>
        </div>
      </div>
    </div>
  );
}

function HomeStyles() {
  return <style>{`
.hp { display: flex; flex-direction: column; gap: 16px; }
.hp-muted { color: var(--c-text-muted); font-size: 12.5px; }
.hp-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); padding: 12px 14px; box-shadow: var(--shadow-sm); }
.hp-months { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; min-width: 0; flex: 1 1 320px; }
.hp-chip { flex: none; border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-text-secondary);
  border-radius: 999px; padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s; }
.hp-chip:hover { border-color: var(--c-accent); color: var(--c-accent); }
.hp-chip.is-on { background: var(--c-accent); border-color: var(--c-accent); color: #fff; }
.hp-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.hp-seg { display: inline-flex; background: var(--c-bg); border-radius: 10px; padding: 3px; gap: 2px; }
.hp-seg button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
  color: var(--c-text-secondary); cursor: pointer; font-family: inherit; }
.hp-seg button.is-on { background: var(--c-surface); color: var(--c-accent); box-shadow: var(--shadow-sm); }
.hp-manage { white-space: nowrap; }

.hp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.hp-kpi { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); padding: 14px 16px; box-shadow: var(--shadow-sm); }
.hp-kpi.is-accent { background: linear-gradient(135deg, var(--c-primary), var(--c-accent)); border-color: transparent; color: #fff; }
.hp-kpi-label { font-size: 12.5px; color: var(--c-text-secondary); font-weight: 600; }
.hp-kpi.is-accent .hp-kpi-label, .hp-kpi.is-accent .hp-kpi-sub { color: rgba(255,255,255,.8); }
.hp-kpi-value { font-size: 24px; font-weight: 800; margin: 6px 0 4px; letter-spacing: -.3px; direction: ltr; text-align: right; }
.hp-kpi-sub { font-size: 12px; color: var(--c-text-muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.hp-kpi.is-accent .hp-delta { background: rgba(255,255,255,.18); color: #fff; }

.hp-delta { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; direction: ltr; }
.hp-delta.is-up { background: var(--c-success-bg); color: var(--c-success); }
.hp-delta.is-down { background: var(--c-danger-bg); color: var(--c-danger); }
.hp-delta.is-flat { color: var(--c-text-muted); }

.hp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
.hp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.hp-card { text-align: right; font-family: inherit; cursor: pointer; background: var(--c-surface); border: 1.5px solid var(--c-border);
  border-radius: var(--radius-lg); padding: 14px; display: flex; flex-direction: column; gap: 6px; transition: border-color .15s, box-shadow .15s, transform .15s; color: var(--c-text-primary); }
.hp-card:hover { border-color: #b9cdf5; box-shadow: var(--shadow-md); transform: translateY(-1px); }
.hp-card.is-on { border-color: var(--c-accent); box-shadow: 0 0 0 3px var(--c-accent-light); }
.hp-card-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.hp-card-name { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-card-co { font-size: 11.5px; color: var(--c-text-muted); margin-top: 2px; }
.hp-card-value { font-size: 22px; font-weight: 800; direction: ltr; text-align: right; }
.hp-card-value small { font-size: 12px; font-weight: 600; color: var(--c-text-muted); }
.hp-card-row { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; color: var(--c-text-secondary); }
.hp-star { cursor: pointer; font-size: 18px; color: var(--c-text-muted); line-height: 1; user-select: none; }
.hp-star.is-on { color: #f59e0b; }
.hp-spark { width: 100%; height: 34px; display: block; }
.hp-spark-line { fill: none; stroke: var(--c-accent); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.hp-spark-area { fill: var(--c-accent-light); }
.hp-spark-dot { fill: var(--c-accent); stroke: var(--c-surface); stroke-width: 2; }
.hp-share { height: 4px; background: var(--c-border-light); border-radius: 4px; overflow: hidden; }
.hp-share > div { height: 100%; background: var(--c-accent); border-radius: 4px; }

.hp-detail { padding: 18px; }
.hp-detail-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; margin-bottom: 14px; }
.hp-detail-title { font-size: 18px; font-weight: 800; color: var(--c-text-primary); }
.hp-detail-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 22px; }
@media (max-width: 900px) { .hp-detail-grid { grid-template-columns: 1fr; } }
.hp-sub-title { font-size: 13px; font-weight: 700; color: var(--c-text-secondary); margin-bottom: 10px; }

.hp-bars-wrap { overflow-x: auto; scrollbar-width: thin; }
.hp-bars { display: flex; align-items: flex-end; gap: 6px; height: 220px; padding-top: 44px; }
.hp-bar { flex: 1 1 0; min-width: 36px; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px;
  background: none; border: 0; cursor: pointer; position: relative; font-family: inherit; padding: 0; }
.hp-bar-track { flex: 1; width: 100%; max-width: 30px; display: flex; align-items: flex-end; }
.hp-bar-fill { width: 100%; background: #b9cdf5; border-radius: 4px 4px 0 0; min-height: 2px; transition: background .15s, height .3s; }
.hp-bar:hover .hp-bar-fill { background: #7fa3ea; }
.hp-bar.is-on .hp-bar-fill { background: var(--c-accent); }
.hp-bar-label { font-size: 11px; color: var(--c-text-muted); white-space: nowrap; }
.hp-bar.is-on .hp-bar-label { color: var(--c-accent); font-weight: 700; }
.hp-tip { position: absolute; top: -40px; left: 50%; transform: translateX(-50%); background: var(--c-primary); color: #fff;
  font-size: 11.5px; padding: 5px 9px; border-radius: 8px; white-space: nowrap; z-index: 2; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
.hp-tip b { font-size: 12.5px; direction: ltr; }

.hp-prov { display: flex; flex-direction: column; gap: 7px; max-height: 260px; overflow-y: auto; padding-left: 4px; }
.hp-prov-row { display: grid; grid-template-columns: 92px 1fr auto 38px; gap: 8px; align-items: center; font-size: 12.5px; }
.hp-prov-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-prov-track { height: 10px; background: var(--c-border-light); border-radius: 5px; overflow: hidden; display: flex; }
.hp-prov-track > span { background: var(--c-accent); border-radius: 5px; }
.hp-prov-val { font-weight: 700; direction: ltr; white-space: nowrap; }
.hp-prov-pct { color: var(--c-text-muted); font-size: 11.5px; text-align: left; }

.hp-table tr.is-on td { background: var(--c-accent-light); }
.hp-heat th.is-on { color: var(--c-accent); }
.hp-heat td b { display: block; font-size: 13px; }
.hp-heat td small { display: block; font-size: 11px; color: var(--c-text-secondary); direction: ltr; }
.hp-search { max-width: 240px; }
.hp-board { padding: 18px; }

.hp-empty { text-align: center; padding: 60px 20px; background: var(--c-surface); border: 1px dashed var(--c-border); border-radius: var(--radius-lg);
  display: flex; flex-direction: column; align-items: center; gap: 10px; }
.hp-empty-icon { font-size: 40px; }
.hp-empty-title { font-size: 16px; font-weight: 700; color: var(--c-text-primary); }
.hp-empty-sub { color: var(--c-text-secondary); font-size: 13.5px; max-width: 420px; }

.hp-picker { max-width: 560px; width: 100%; display: flex; flex-direction: column; max-height: 85vh; }
.hp-picker-list { overflow-y: auto; padding: 0 20px 8px; flex: 1; }
.hp-picker-row { display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; padding: 8px 6px;
  border-bottom: 1px solid var(--c-border-light); cursor: pointer; font-size: 13px; border-radius: 6px; }
.hp-picker-row.is-on { background: var(--c-accent-light); }
.hp-picker-name { font-weight: 600; }
.hp-picker-qty { font-size: 12px; color: var(--c-text-secondary); white-space: nowrap; }
.hp-link { background: none; border: 0; color: var(--c-accent); cursor: pointer; font-family: inherit; font-size: 12.5px; margin-inline-start: 8px; }

@media (max-width: 600px) {
  .hp-toolbar { padding: 10px; }
  .hp-kpi-value { font-size: 20px; }
  .hp-cards { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .hp-prov-row { grid-template-columns: 76px 1fr auto; }
  .hp-prov-pct { display: none; }
  .hp-search { max-width: none; width: 100%; }
}
`}</style>;
}
