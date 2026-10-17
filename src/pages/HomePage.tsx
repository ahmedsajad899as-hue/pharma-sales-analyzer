// ════════════════════════════════════════════════════════════════════════════
// HomePage — «الرئيسية»: صافي كمية (مبيع − إرجاع) الايتمات المتابَعة في شهر واحد،
// بلا أي قيمة مالية (طلب صريح — لا تُعِد عرض الفلوس)،
// من ملفات مبيع المكتب وحدها (لا ميركاتو — طلب صريح)، بأبسط عرض ممكن.
//
// • اختيار الشهر (قائمة واحدة) + سطر ملخّص واحد + بطاقة لكل ايتم (القيمة،
//   الكمية، التغيّر عن الشهر السابق). الضغط على بطاقة يعرض مبيعه بالمحافظات.
// • الايتمات المتابَعة يختارها المدير (تُحفظ لكل حساب في المتصفح). قبل أن يختار
//   شيئاً تُعرض تلقائياً الأعلى مبيعاً في الشهر.
// • المصدر: GET /api/reports/home-items (+ /:itemId/provinces) — نفس نطاق
//   «التحليل الشامل» (server/modules/reports/homeItems.js). القيم تصل بالدولار
//   دائماً، وتُعرض بعملة الملف (currencyMode) بسعر صرفه.
// ⚠️ طلب صريح: الصفحة مختصرة — لا تُضِف إليها جداول/مؤشرات/أزرار تبديل.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { PageId } from '../App';

const API = import.meta.env.VITE_API_URL || '';

type Cell = [number, number, number, number]; // [مبيع كمية، مبيع قيمة، إرجاع كمية، إرجاع قيمة]
interface HomeItem {
  id: number; name: string; company: string | null; m: Record<string, Cell>;
  /** الشهر P حتى آخر يوم بيانات في الشهر التالي له فقط — أساس مقارنة «نفس الفترة» */
  p?: Record<string, Cell>;
}
interface HomeData {
  months: string[];
  /** آخر يوم فيه بيانات لكل شهر */
  cutDay?: Record<string, number>;
  items: HomeItem[];
  source?: 'office' | 'mercato';
  currencyMode?: 'USD' | 'IQD';
  exchangeRate?: number;
  /** مدير شركة بلا ايتمات مُسنَدة في «الايتمات» عند السوبر أدمن */
  noItems?: boolean;
}
interface ProvRow { name: string; m: Record<string, Cell> }

interface Props { activeFileIds: number[]; onNavigate: (p: PageId) => void }

const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const monthName = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${AR_MONTHS[m - 1]} ${y}`; };
const prevYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const AUTO_PIN_COUNT = 6;

// ذاكرة مؤقتة على مستوى الوحدة: العودة للصفحة فورية بلا انتظار.
const dataCache = new Map<string, HomeData>();
const provCache = new Map<string, ProvRow[]>();

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
/** تطبيع للبحث: حروف صغيرة + توحيد الهمزات والتاء المربوطة والياء */
const normAr = (t: string) => t.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
/** الصافي = مبيع − إرجاع (الإرجاع مخزَّن موجباً) */
const netQ = (c?: Cell) => (c ? c[0] - c[2] : 0);

export default function HomePage({ activeFileIds, onNavigate }: Props) {
  const { token, user } = useAuth();
  const fileKey = [...activeFileIds].sort((a, b) => a - b).join(',');

  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [month, setMonth] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [query, setQuery] = useState('');
  const [compare, setCompare] = useState(false);

  // ── الايتمات المتابَعة (لكل حساب) ──────────────────────────────────────────
  const pinKey = `homePinnedItems_${user?.id ?? ''}`;
  const [pinned, setPinned] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(pinKey) || '[]'); } catch { return []; }
  });
  const savePinned = (ids: number[]) => {
    setPinned(ids);
    try { localStorage.setItem(pinKey, JSON.stringify(ids)); } catch { /* تخزين محجوب */ }
  };

  // ── الجلب ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !fileKey) { setData(null); return; }
    const hit = dataCache.get(fileKey);
    if (hit) setData(hit);
    const ac = new AbortController();
    if (!hit) setLoading(true);
    setErr('');
    fetch(`${API}/api/reports/home-items?fileIds=${fileKey}&source=office`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل البيانات');
        dataCache.set(fileKey, j.data);
        setData(j.data);
      })
      .catch(e => { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل البيانات'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [token, fileKey]);

  const months = data?.months ?? [];
  const activeMonth = month && months.includes(month) ? month : (months[months.length - 1] ?? '');
  const prevMonth = activeMonth ? prevYm(activeMonth) : '';
  const hasPrev = months.includes(prevMonth);

  const itemsById = useMemo(() => new Map((data?.items ?? []).map(i => [i.id, i])), [data]);
  // الترتيب المعروض دائماً أبجدي (طلب صريح) — لا حسب الكمية. الكمية تُستعمل فقط
  // لاختيار «أعلى الايتمات» تلقائياً قبل أن يختار المدير ايتماته.
  const byName = (a: HomeItem, b: HomeItem) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
  const ranked = useMemo(() => [...(data?.items ?? [])].sort(byName), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const validPinned = pinned.filter(id => itemsById.has(id));
  const isAuto = validPinned.length === 0;
  const watched: HomeItem[] = isAuto
    ? [...ranked].filter(i => (i.m[activeMonth]?.[0] ?? 0) > 0)
        .sort((a, b) => netQ(b.m[activeMonth]) - netQ(a.m[activeMonth])).slice(0, AUTO_PIN_COUNT).sort(byName)
    : validPinned.map(id => itemsById.get(id)!).sort(byName);

  // بقية الايتمات (غير المعروضة أعلاه) التي لها حركة في الشهر — تُفتح بسهم أسفل القائمة
  const watchedIds = new Set(watched.map(i => i.id));
  const rest = ranked.filter(i => !watchedIds.has(i.id) && i.m[activeMonth]);

  // البحث: باسم الايتم أو اسم الشركة (كل ايتمات تلك الشركة) — يحلّ محلّ القائمة
  // والملخّص معاً ما دام فيه نص.
  const needle = normAr(query);
  const searching = needle.length > 0;
  const matches = searching
    ? ranked.filter(i => normAr(i.name).includes(needle) || normAr(i.company ?? '').includes(needle))
    : [];
  const shown = searching ? matches : watched;

  const cut = data?.cutDay?.[activeMonth];

  // ════════════════════════════════════════════════════════════════════════
  if (!fileKey) {
    return (
      <div className="page hp">
        <HomeStyles />
        <div className="hp-empty">
          <div className="hp-empty-title">لا توجد ملفات مبيعات مفعّلة</div>
          <div className="hp-muted">فعّل ملف المبيعات من «تحليل المبيعات» لتظهر هنا مبيعات الايتمات.</div>
          <button className="btn btn-primary" onClick={() => onNavigate('rep-analysis')}>الذهاب إلى تحليل المبيعات</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page hp">
      <HomeStyles />

      <div className="hp-head">
        <select className="form-input hp-month" value={activeMonth} onChange={e => { setMonth(e.target.value); setOpenId(null); }} disabled={!months.length}>
          {[...months].reverse().map(ym => <option key={ym} value={ym}>{monthName(ym)}</option>)}
        </select>
        <input className="form-input hp-search" type="search" placeholder="🔍 بحث عن ايتم أو شركة…"
          value={query} onChange={e => { setQuery(e.target.value); setOpenId(null); }} />
        <button className={`btn ${compare ? 'btn-primary' : ''}`} onClick={() => setCompare(v => !v)}
          title="جدول مقارنة كمية هذا الشهر بالشهر السابق">⇄ مقارنة</button>
        <button className="btn" onClick={() => setShowPicker(true)}>⭐ اختيار الايتمات</button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {loading && !data && <div className="hp-muted hp-center">جاري التحميل…</div>}
      {data?.noItems && (
        <div className="hp-empty">
          <div className="hp-empty-title">لم تُسنَد لك ايتمات بعد</div>
          <div className="hp-muted">تظهر هنا مبيعات ايتماتك فقط — اطلب من السوبر أدمن إسنادها لك من تبويب «الايتمات».</div>
        </div>
      )}
      {data && !data.noItems && data.source === 'mercato' && (
        <div className="hp-empty">
          <div className="hp-empty-title">لا يوجد ملف مبيع مكتب مفعّل</div>
          <div className="hp-muted">هذه الصفحة تعرض صافي مبيع ملف المكتب فقط — فعّله من «تحليل المبيعات».</div>
        </div>
      )}
      {data && !data.noItems && data.source !== 'mercato' && months.length === 0 && !loading && (
        <div className="hp-empty"><div className="hp-empty-title">لا يوجد مبيع في الملفات المفعّلة</div></div>
      )}

      {months.length > 0 && data?.source !== 'mercato' && (
        <>
          {compare ? (
            <CompareTable
              items={searching ? matches : ranked.filter(i => i.m[activeMonth] || i.p?.[prevMonth])}
              month={activeMonth} prevMonth={prevMonth} cut={cut} />
          ) : (
          <div className="hp-list">
            {[...shown, ...(showRest && !searching ? rest : [])].map((it, i) => {
              const c = it.m[activeMonth];
              const open = openId === it.id;
              return (
                <div key={it.id} className={`hp-item ${open ? 'is-open' : ''} ${!searching && i === watched.length ? 'is-rest-start' : ''}`}>
                  <button className="hp-item-row" onClick={() => setOpenId(open ? null : it.id)}>
                    <span className="hp-item-name">{it.name}</span>
                    <span className="hp-item-val">{fmt(netQ(c))} <small>قطعة</small></span>
                    <span className="hp-item-delta">{hasPrev ? <Delta now={netQ(c)} prev={netQ(it.p?.[prevMonth])} /> : null}</span>
                    <span className="hp-chev">{open ? '▴' : '▾'}</span>
                  </button>
                  {open && (
                    <Provinces itemId={it.id} ym={activeMonth} fileKey={fileKey} source={data?.source} token={token} />
                  )}
                </div>
              );
            })}
            {shown.length === 0 && <div className="hp-muted hp-center">{searching ? 'لا يوجد ايتم أو شركة بهذا الاسم.' : 'لا يوجد مبيع لهذه الايتمات في هذا الشهر.'}</div>}
            {!searching && rest.length > 0 && (
              <button className="hp-more" onClick={() => setShowRest(v => !v)}
                title={showRest ? 'إخفاء بقية الايتمات' : `عرض بقية الايتمات (${rest.length})`}>
                {showRest ? '▴' : <>▾ <span>بقية الايتمات ({rest.length})</span></>}
              </button>
            )}
          </div>
          )}
          {isAuto && !searching && !compare && <div className="hp-muted hp-center">تُعرض تلقائياً الأعلى مبيعاً — اضغط «⭐ اختيار الايتمات» لتحديد ايتماتك.</div>}
        </>
      )}

      {showPicker && data && (
        <ItemPicker items={ranked} pinned={validPinned}
          onSave={ids => { savePinned(ids); setShowPicker(false); }}
          onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
function Delta({ now, prev }: { now: number; prev: number }) {
  if (!prev) return now ? <span className="hp-delta is-up">جديد</span> : null;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span className={`hp-delta ${up ? 'is-up' : 'is-down'}`} title="مقارنة بنفس الفترة من الشهر السابق">
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Provinces({ itemId, ym, fileKey, source, token }: {
  itemId: number; ym: string; fileKey: string; source?: string; token: string | null;
}) {
  const key = `${fileKey}|${source ?? ''}|${itemId}`;
  const [rows, setRows] = useState<ProvRow[] | null>(provCache.get(key) ?? null);
  useEffect(() => {
    if (provCache.has(key) || !token) return;
    const ac = new AbortController();
    const p = new URLSearchParams({ fileIds: fileKey });
    if (source) p.set('source', source);
    fetch(`${API}/api/reports/home-items/${itemId}/provinces?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => { if (j.success) { provCache.set(key, j.data.provinces); setRows(j.data.provinces); } })
      .catch(() => { /* إلغاء أو شبكة */ });
    return () => ac.abort();
  }, [key, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <div className="hp-prov hp-muted">جاري التحميل…</div>;
  const list = rows.map(r => ({ name: r.name, q: netQ(r.m[ym]), active: !!r.m[ym] }))
    // المحافظات بلا مبيع ولا إرجاع تظهر أيضاً (صفر) — في آخر القائمة
    .sort((a, b) => Number(!a.active) - Number(!b.active) || b.q - a.q || a.name.localeCompare(b.name, 'ar'));
  if (!list.length) return <div className="hp-prov hp-muted">لا مبيع في هذا الشهر.</div>;
  const max = Math.max(...list.map(r => r.q), 1);
  // نسبة المحافظة من إجمالي صافي هذا الايتم (مجموع المحافظات)
  const total = list.reduce((sum, r) => sum + r.q, 0);
  const pctOf = (q: number) => {
    if (total <= 0 || !q) return '';
    const v = (q / total) * 100;
    return v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`;
  };
  return (
    <div className="hp-prov">
      {list.map(r => (
        <div key={r.name} className={`hp-prov-row ${r.active ? '' : 'is-zero'}`}>
          <span className="hp-prov-name">{r.name}{pctOf(r.q) && <small className="hp-prov-pct">{pctOf(r.q)}</small>}</span>
          <span className="hp-prov-track"><span style={{ width: `${r.q > 0 ? Math.max(2, (r.q / max) * 100) : 0}%` }} /></span>
          <span className="hp-prov-val">{fmt(r.q)} قطعة</span>
        </div>
      ))}
    </div>
  );
}

function CompareTable({ items, month, prevMonth, cut }: {
  items: HomeItem[]; month: string; prevMonth: string; cut?: number;
}) {
  // الشهر السابق = نفس الفترة (1–cut) — نفس أساس الأسهم في بقية الصفحة
  const rows = items.map(it => ({ id: it.id, name: it.name, now: netQ(it.m[month]), prev: netQ(it.p?.[prevMonth]) }));
  const sumNow = rows.reduce((s, r) => s + r.now, 0);
  const sumPrev = rows.reduce((s, r) => s + r.prev, 0);
  if (!rows.length) return <div className="hp-muted hp-center">لا توجد ايتمات للمقارنة.</div>;
  return (
    <div className="hp-cmp-table">
      <table>
        <thead>
          <tr>
            <th>الايتم</th>
            <th className="num">{monthName(month)}</th>
            <th className="num">{monthName(prevMonth)}{cut ? ` (1–${cut})` : ''}</th>
            <th className="num">التغيّر</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="num">{fmt(r.now)}</td>
              <td className="num prev">{fmt(r.prev)}</td>
              <td className="num"><Delta now={r.now} prev={r.prev} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>المجموع</td>
            <td className="num">{fmt(sumNow)}</td>
            <td className="num">{fmt(sumPrev)}</td>
            <td className="num"><Delta now={sumNow} prev={sumPrev} /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ItemPicker({ items, pinned, onSave, onClose }: {
  items: HomeItem[]; pinned: number[]; onSave: (ids: number[]) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState<number[]>(pinned);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = items.filter(it => !needle || it.name.toLowerCase().includes(needle));
  const toggle = (id: number) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hp-picker" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>اختر الايتمات التي تتابعها</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '12px 20px 4px' }}>
          <input className="form-input" autoFocus placeholder="بحث…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="hp-picker-list">
          {list.map(it => (
            <label key={it.id} className={`hp-picker-row ${sel.includes(it.id) ? 'is-on' : ''}`}>
              <input type="checkbox" checked={sel.includes(it.id)} onChange={() => toggle(it.id)} />
              <span>{it.name}</span>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          {sel.length > 0 && <button className="btn" onClick={() => setSel([])}>مسح الاختيار</button>}
          <button className="btn btn-primary" onClick={() => onSave(sel)}>حفظ ({sel.length})</button>
        </div>
      </div>
    </div>
  );
}

function HomeStyles() {
  return <style>{`
.hp { display: flex; flex-direction: column; gap: 14px; max-width: 820px; margin: 0 auto; width: 100%; }
.hp-muted { color: var(--c-text-muted); font-size: 13px; }
.hp-center { text-align: center; padding: 8px; }
.hp-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.hp-month { max-width: 200px; font-weight: 700; }
.hp-search { flex: 1; min-width: 0; }


.hp-delta { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; direction: ltr; white-space: nowrap; }
.hp-delta.is-up { background: var(--c-success-bg); color: var(--c-success); }
.hp-delta.is-down { background: var(--c-danger-bg); color: var(--c-danger); }

.hp-list { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); overflow: hidden; }
.hp-item + .hp-item { border-top: 1px solid var(--c-border-light); }
.hp-item-row { width: 100%; display: grid; grid-template-columns: 1fr auto 64px 16px; gap: 14px; align-items: center;
  padding: 14px 18px; background: none; border: 0; cursor: pointer; font-family: inherit; text-align: right; color: var(--c-text-primary); }
.hp-item-row:hover, .hp-item.is-open .hp-item-row { background: var(--c-accent-light); }
.hp-item-name { font-weight: 700; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-item-val { font-weight: 800; font-size: 15px; white-space: nowrap; }
.hp-item-val small { font-size: 11.5px; color: var(--c-text-muted); font-weight: 600; }
.hp-item-delta { text-align: left; }
.hp-chev { color: var(--c-text-muted); font-size: 12px; }
.hp-item.is-rest-start { border-top: 2px dashed var(--c-border); }
.hp-more { width: 100%; border: 0; border-top: 1px solid var(--c-border-light); background: none; cursor: pointer; padding: 8px;
  color: var(--c-text-muted); font-family: inherit; font-size: 13px; }
.hp-more span { font-size: 12px; }
.hp-more:hover { background: var(--c-accent-light); color: var(--c-accent); }

.hp-prov { padding: 6px 18px 16px; display: flex; flex-direction: column; gap: 8px; background: var(--c-accent-light); }
.hp-prov-row { display: grid; grid-template-columns: 140px 1fr auto; gap: 12px; align-items: center; font-size: 13px; }
.hp-prov-row.is-zero { color: var(--c-text-muted); }
.hp-prov-row.is-zero .hp-prov-val { font-weight: 500; }
.hp-prov-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-prov-pct { font-weight: 500; font-size: 11px; color: var(--c-text-muted); margin-inline-start: 6px; direction: ltr; unicode-bidi: isolate; }
.hp-prov-track { height: 8px; background: rgba(26,86,219,.12); border-radius: 4px; overflow: hidden; display: flex; }
.hp-prov-track > span { background: var(--c-accent); border-radius: 4px; }
.hp-prov-val { font-weight: 700; white-space: nowrap; min-width: 90px; text-align: left; }

.hp-cmp-table { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); overflow: auto; max-height: 70vh; }
.hp-cmp-table table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.hp-cmp-table th { position: sticky; top: 0; background: var(--c-bg); color: var(--c-text-secondary); font-weight: 700;
  font-size: 12.5px; padding: 10px 14px; text-align: right; white-space: nowrap; }
.hp-cmp-table td { padding: 10px 14px; border-top: 1px solid var(--c-border-light); white-space: nowrap; }
.hp-cmp-table td:first-child { white-space: normal; font-weight: 600; }
.hp-cmp-table .num { text-align: center; font-weight: 700; }
.hp-cmp-table td.prev { color: var(--c-text-secondary); font-weight: 600; }
.hp-cmp-table tfoot td { position: sticky; bottom: 0; background: var(--c-bg); font-weight: 800; border-top: 2px solid var(--c-border); }
.hp-empty { text-align: center; padding: 50px 20px; background: var(--c-surface); border: 1px dashed var(--c-border);
  border-radius: var(--radius-lg); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.hp-empty-title { font-size: 16px; font-weight: 700; }

.hp-picker { max-width: 460px; width: 100%; display: flex; flex-direction: column; max-height: 85vh; }
.hp-picker-list { overflow-y: auto; padding: 4px 20px 8px; flex: 1; }
.hp-picker-row { display: flex; gap: 10px; align-items: center; padding: 9px 6px; border-bottom: 1px solid var(--c-border-light);
  cursor: pointer; font-size: 13.5px; border-radius: 6px; }
.hp-picker-row.is-on { background: var(--c-accent-light); font-weight: 600; }

@media (max-width: 600px) {
  .hp-head { flex-wrap: wrap; }
  .hp-search { order: 3; flex-basis: 100%; }
  .hp-item-row { gap: 10px; padding: 12px 14px; grid-template-columns: 1fr auto 58px 12px; }
  .hp-prov-row { grid-template-columns: 110px 1fr auto; }
  .hp-cmp-table th, .hp-cmp-table td { padding: 8px 10px; }
}
`}</style>;
}
