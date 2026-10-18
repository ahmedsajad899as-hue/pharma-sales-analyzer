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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  const [tabSlot, setTabSlot] = useState<HTMLDivElement | null>(null);

  // ── الواجهة: قائمة (الحالية) أو لوحة إعلانية — تُحفظ لكل حساب ──────────────
  const viewKey = `homeView_${user?.id ?? ''}`;
  const [view, setView] = useState<'list' | 'board'>(() => {
    try { return localStorage.getItem(viewKey) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
  });
  // اختلاف المنظر (parallax) لخلفية اللوحة: موضع الماوس يُكتب كمتغيّرات CSS مباشرةً
  // على الجذر — بلا setState، فلا إعادة رسم للصفحة مع كل حركة.
  const rootRef = useRef<HTMLDivElement>(null);
  const onSkyMove = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty('--mx', String(e.clientX / window.innerWidth - 0.5));
    el.style.setProperty('--my', String(e.clientY / window.innerHeight - 0.5));
  };
  const toggleView = () => {
    const next = view === 'board' ? 'list' : 'board';
    setView(next);
    try { localStorage.setItem(viewKey, next); } catch { /* تخزين محجوب */ }
  };

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
    <div className={`page hp ${view === 'board' ? 'is-board' : ''}`} ref={rootRef}
      onPointerMove={view === 'board' ? onSkyMove : undefined}>
      <HomeStyles />
      {view === 'board' && <Sky />}

      <div className="hp-head">
        <select className="form-input hp-month" value={activeMonth} onChange={e => { setMonth(e.target.value); setOpenId(null); e.target.blur(); /* كي لا تبقى القائمة تلتقط أسهم ←/→ فتغيّر الشهر بدل تحريك اللوحة */ }} disabled={!months.length}>
          {[...months].reverse().map(ym => <option key={ym} value={ym}>{monthName(ym)}</option>)}
        </select>
        {view === 'list' ? (
          <>
            <input className="form-input hp-search" type="search" placeholder="🔍 بحث عن ايتم أو شركة…"
              value={query} onChange={e => { setQuery(e.target.value); setOpenId(null); }} />
            <button className={`btn ${compare ? 'btn-primary' : ''}`} onClick={() => setCompare(v => !v)}
              title="جدول مقارنة كمية هذا الشهر بالشهر السابق">⇄ مقارنة</button>
            <button className="btn" onClick={() => setShowPicker(true)}>⭐ اختيار الايتمات</button>
          </>
        ) : <><span style={{ flex: 1 }} /><div className="hp-tab-slot" ref={setTabSlot} /></>}
        <button className="btn hp-view-btn" onClick={toggleView} title="التبديل بين القائمة واللوحة الإعلانية">
          {view === 'board' ? '☰ قائمة' : '🖥️ لوحة'}
        </button>
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

      {/* نفس ايتمات القائمة المختارة (watched) — وليس كل الايتمات — حتى تطابق اللوحة اختيار المستخدم من «⭐ اختيار الايتمات» */}
      {months.length > 0 && data?.source !== 'mercato' && view === 'board' && (
        <Billboard items={watched} month={activeMonth} prevMonth={prevMonth} hasPrev={hasPrev}
          fileKey={fileKey} source={data?.source} token={token} tabSlot={tabSlot} />
      )}

      {months.length > 0 && data?.source !== 'mercato' && view === 'list' && (
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

// ════════════════════════════════════════════════════════════════════════════
// واجهة «اللوحة الإعلانية»: لوحتان دوّارتان (أعلى 6 ايتمات، أعلى 6 محافظات).
// البطاقة النشطة في الوسط والبقية على الجانبين أصغر وشفّافة (هرم إعلاني)،
// وتتقلّب كل 3 ثوانٍ. الضغط على البطاقة النشطة يفتح تفصيلها؛ الضغط على بطاقة
// جانبية يجلبها للوسط. الدوران يتوقف عند مرور الماوس أو فتح التفصيل.
// المحافظات من GET /api/reports/home-provinces (نفس النطاق والمقارنة).
// ════════════════════════════════════════════════════════════════════════════
interface ProvSummary { name: string; now: Cell; prev: Cell; items: { id: number; name: string; company: string | null; now: Cell }[] }
const provSummaryCache = new Map<string, ProvSummary[]>();
const BOARD_COUNT = 6;
const ROTATE_MS = 13000;
/** تكبير العنصر المعروض في الوسط كي يتركّز عليه النظر (الجانبية 0.74 و0.54) */
const CF_ACTIVE_SCALE = 1.38;
/** أقصى مدة يوقف فيها مرورُ الماوس فوق البطاقة المعروضة الدورانَ */
const HOVER_PAUSE_MAX_MS = 60_000;

/**
 * صور علب الايتمات (public/items/) — مطابقة بالاسم المطبَّع لأن نفس الدواء له عدة
 * صفوف Item بأسماء متقاربة. تجربة أولى على ايتم واحد؛ الباقي بلا صورة.
 */
// الصورة = الوجه الأمامي لعلبة ثلاثية الأبعاد (Box3D). depth = عمق العلبة نسبةً إلى
// ارتفاع وجهها — يحاكي العلبة الحقيقية: شريط 10 حبات رفيع، و28 حبة أعمق.
// faces = صور الأوجه الحقيقية من تصوير العلبة من كل الجهات، مصحَّحة المنظور إلى
// مستطيلات (front عرض×ارتفاع، left/right عمق×ارتفاع، top عرض×عمق). اتجاهها:
// left — عمودها الأيمن يلي الوجه الأمامي؛ right — عمودها الأيسر يليه؛ top — حافتها
// السفلى تلي الوجه الأمامي. الوجه الناقص يُلوَّن من حواف الصورة الأمامية.
interface BoxFaces { left?: string; right?: string; top?: string }
// scale = تكبير المجسّم داخل البطاقة (1 = الافتراضي) — للعلب الواقفة التي يحدّها الارتفاع فتبدو صغيرة
interface ItemImage { match: (n: string) => boolean; src: string; depth: number; faces?: BoxFaces; scale?: number }
const ITEM_IMAGES: ItemImage[] = [
  {
    match: n => n.includes('amoklavin') && n.includes('1000'),
    src: '/items/amoklavin-1000/front.jpg', depth: 0.33,
    faces: { left: '/items/amoklavin-1000/left.jpg', right: '/items/amoklavin-1000/right.jpg', top: '/items/amoklavin-1000/top.jpg' },
  },
  texturedBox(n => n.includes('amoklavin') && n.includes('625'), 'amoklavin-625', 0.33),
  texturedBox(n => n.includes('ziver'), 'ziver-3', 0.38),
  texturedBox(n => n.includes('pantactive') && /\b20\b|20\s*mg/.test(n), 'pantactive-20', 0.17),
  texturedBox(n => n.includes('pantactive') && /\b40\b|40\s*mg/.test(n), 'pantactive-40', 0.17),
  // ⚠️ depth نسبةً إلى **ارتفاع** الوجه لا عرضه. علبة الشراب واقفة (عرض≈نصف الارتفاع) ومقطعها
  // مربّع تقريباً، فعمقها ≈ عرضها ≈ 0.5 من الارتفاع — كانت 0.95 فبدت الجوانب ضعف حجمها.
  // Mantazol: طرفها في الصور ≈ نصف ارتفاعها (كانت 0.86 فكبر الطرف والسقف عن الواقع).
  texturedBox(n => n.includes('amoklavin') && /457|syr/.test(n), 'amoklavin-457-syrup', 0.5, 1.35),
  texturedBox(n => n.includes('mantazol'), 'mantazol', 0.5),
];
/** علبة بصور أوجهها الأربعة في public/items/<dir>/{front,left,right,top}.jpg */
function texturedBox(match: (n: string) => boolean, dir: string, depth: number, scale?: number): ItemImage {
  const p = (f: string) => `/items/${dir}/${f}.jpg`;
  return { match, src: p('front'), depth, scale, faces: { left: p('left'), right: p('right'), top: p('top') } };
}
const itemImage = (name: string) => ITEM_IMAGES.find(x => x.match(name.toLowerCase())) ?? null;

/** صور معالم المحافظات (public/provinces/*.webp) — بالاسم الرسمي + أسماء المراكز الشائعة. */
const PROVINCE_IMAGES: Record<string, string> = {
  'بغداد': 'baghdad', 'البصرة': 'basra', 'بصرة': 'basra', 'نينوى': 'nineveh', 'الموصل': 'nineveh',
  'أربيل': 'erbil', 'اربيل': 'erbil', 'هولير': 'erbil', 'السليمانية': 'sulaymaniyah', 'سليمانية': 'sulaymaniyah',
  'دهوك': 'duhok', 'كركوك': 'kirkuk', 'ديالى': 'diyala', 'ديالي': 'diyala', 'بعقوبة': 'diyala',
  'الأنبار': 'anbar', 'الانبار': 'anbar', 'الرمادي': 'anbar', 'بابل': 'babil', 'الحلة': 'babil',
  'كربلاء': 'karbala', 'النجف': 'najaf', 'نجف': 'najaf', 'واسط': 'wasit', 'الكوت': 'wasit',
  'صلاح الدين': 'salahaddin', 'تكريت': 'salahaddin', 'سامراء': 'salahaddin',
  'القادسية': 'qadisiyah', 'الديوانية': 'qadisiyah', 'ميسان': 'maysan', 'العمارة': 'maysan',
  'ذي قار': 'dhiqar', 'الناصرية': 'dhiqar', 'المثنى': 'muthanna', 'السماوة': 'muthanna',
};
const provinceImage = (name: string) => {
  const k = PROVINCE_IMAGES[name.trim()];
  return k ? `/provinces/${k}.webp` : null;
};

function Billboard({ items, month, prevMonth, hasPrev, fileKey, source, token, tabSlot }: {
  /** ايتمات اللوحة = نفس ايتمات القائمة المختارة بالضبط (watched في الصفحة الأم) — لا
   *  إعادة احتساب «الأعلى مبيعاً» هنا، وإلا تختلف اللوحة عن اختيار المستخدم الصريح. */
  items: HomeItem[]; month: string; prevMonth: string; hasPrev: boolean;
  fileKey: string; source?: string; token: string | null;
  /** خانة في شريط الرأس تُنقل إليها أزرار الايتمات/المحافظات */
  tabSlot?: HTMLElement | null;
}) {
  // ترتيب عرض فقط (الأعلى كمية أولاً) — بلا فلترة ولا حدّ أقصى، كي يطابق العدد اختيار المستخدم حرفياً.
  const topItems = useMemo(() =>
    [...items].sort((a, b) => netQ(b.m[month]) - netQ(a.m[month])),
  [items, month]);

  const provKey = `${fileKey}|${source ?? ''}|${month}`;
  const [provs, setProvs] = useState<ProvSummary[] | null>(provSummaryCache.get(provKey) ?? null);
  useEffect(() => {
    const hit = provSummaryCache.get(provKey);
    setProvs(hit ?? null);
    if (hit || !token || !month) return;
    const ac = new AbortController();
    const p = new URLSearchParams({ fileIds: fileKey, month });
    if (source) p.set('source', source);
    fetch(`${API}/api/reports/home-provinces?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => { if (j.success) { provSummaryCache.set(provKey, j.data.provinces); setProvs(j.data.provinces); } })
      .catch(() => { /* إلغاء أو شبكة */ });
    return () => ac.abort();
  }, [provKey, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const topProvs = useMemo(() =>
    (provs ?? []).filter(p => p.name !== 'غير محدد' && netQ(p.now) > 0)
      .sort((a, b) => netQ(b.now) - netQ(a.now)).slice(0, BOARD_COUNT),
  [provs]);

  const [detail, setDetail] = useState<{ kind: 'item'; item: HomeItem } | { kind: 'prov'; prov: ProvSummary } | null>(null);
  // لوحة واحدة تملأ الشاشة في كل مرة (طلب صريح) — تبديل بين الايتمات والمحافظات
  const [board, setBoard] = useState<'items' | 'prov'>('items');

  // أزرار الايتمات/المحافظات صغيرة جداً في رأس الصفحة يساراً (طلب صريح) — تُنقل إلى خانة
  // في الشريط العلوي عبر portal، وإلا تُعرض هنا احتياطاً.
  const tabs = (
      <div className="bb-tabs" role="tablist">
        <button role="tab" aria-selected={board === 'items'} className={board === 'items' ? 'is-on' : ''} onClick={() => setBoard('items')}>
          💊 الايتمات <small>({topItems.length})</small>
        </button>
        <button role="tab" aria-selected={board === 'prov'} className={board === 'prov' ? 'is-on' : ''} onClick={() => setBoard('prov')}>
          📍 المحافظات <small>({topProvs.length})</small>
        </button>
      </div>
  );

  return (
    <div className="bb">
      {tabSlot ? createPortal(tabs, tabSlot) : tabs}

      {board === 'items' && <section className="bb-section">
        {topItems.length === 0 ? <div className="hp-muted hp-center">لا يوجد مبيع في هذا الشهر.</div> : (
          <Coverflow paused={!!detail} count={topItems.length} variant="item"
            render={(i) => {
              const it = topItems[i];
              const img = itemImage(it.name);
              // ايتم له صورة: علبة ثلاثية الأبعاد واقعية (الصورة وجهها الأمامي) تتمايل
              // وتميل مع الماوس، والترتيب والسهم أعلى، والكمية شارة على البطاقة.
              if (img) return (
                <div className="bb-card bb-card-item has-photo">
                  <Box3D src={img.src} depth={img.depth} faces={img.faces} scale={img.scale} label={it.name} />
                  <div className="bb-photo-pill">
                    {fmt(netQ(it.m[month]))} <small>قطعة</small>
                  </div>
                </div>
              );
              // بلا صورة: الاسم والسهم أعلى، رسمة العلبة داخل إطار في الوسط، الكمية أسفل
              return (
                <div className="bb-card bb-card-item">
                  <div className="bb-item-head">
                    <span className="bb-item-name" title={it.name}>{it.name}</span>
                  </div>
                  <div className="bb-card-sub bb-center">{it.company ?? '—'}</div>
                  <div className="bb-frame">
                    <ItemArt name={it.name} company={it.company} />
                  </div>
                  <div className="bb-card-qty bb-center">{fmt(netQ(it.m[month]))} <small>قطعة</small></div>
                </div>
              );
            }}
            onOpen={(i) => setDetail({ kind: 'item', item: topItems[i] })} />
        )}
      </section>}

      {board === 'prov' && <section className="bb-section">
        {!provs ? <div className="hp-muted hp-center">جاري التحميل…</div>
          : topProvs.length === 0 ? <div className="hp-muted hp-center">لا يوجد مبيع في هذا الشهر.</div> : (
          <Coverflow paused={!!detail} count={topProvs.length} variant="prov"
            render={(i) => {
              const pr = topProvs[i];
              const pimg = provinceImage(pr.name);
              if (pimg) return (
                <div className="bb-card bb-card-prov has-pimg">
                  <img className="bb-pimg" src={pimg} alt="" loading="lazy" draggable={false} />
                  <div className="bb-pimg-shade" />
                  <div className="bb-photo-top">
                    <span className="bb-rank">#{i + 1}</span>
                    {hasPrev && <Delta now={netQ(pr.now)} prev={netQ(pr.prev)} />}
                  </div>
                  <div className="bb-pimg-text">
                    <div className="bb-pimg-name">{pr.name}</div>
                    <div className="bb-pimg-qty">{fmt(netQ(pr.now))} <small>قطعة</small></div>
                  </div>
                </div>
              );
              return (
                <div className="bb-card bb-card-prov">
                  <div className="bb-card-top">
                    <span className="bb-rank">#{i + 1}</span>
                    {hasPrev && <Delta now={netQ(pr.now)} prev={netQ(pr.prev)} />}
                  </div>
                  <div className="bb-card-icon">📍</div>
                  <div className="bb-card-name">{pr.name}</div>
                  <div className="bb-card-qty">{fmt(netQ(pr.now))} <small>قطعة</small></div>
                </div>
              );
            }}
            onOpen={(i) => setDetail({ kind: 'prov', prov: topProvs[i] })} />
        )}
      </section>}

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal bb-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header bb-modal-head">
              <div style={{ minWidth: 0 }}>
                <h3 style={{ margin: 0 }}>{detail.kind === 'item' ? detail.item.name : `📍 ${detail.prov.name}`}</h3>
                <div className="hp-muted">
                  {detail.kind === 'item' ? `${detail.item.company ?? '—'} · ${monthName(month)}` : monthName(month)}
                </div>
              </div>
              {/* الإجمالي بخط كبير في المساحة بين العنوان وزر الإغلاق */}
              <div className="bb-modal-total">
                {fmt(detail.kind === 'item' ? netQ(detail.item.m[month]) : netQ(detail.prov.now))}
                <small>قطعة</small>
              </div>
              <button className="modal-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="bb-modal-body">
              <div className="hp-sub-title">{detail.kind === 'item' ? 'مبيعه في المحافظات' : 'مبيعها من الايتمات'}</div>
              {detail.kind === 'item'
                ? <Provinces itemId={detail.item.id} ym={month} fileKey={fileKey} source={source} token={token} />
                : <ProvinceItems prov={detail.prov} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * علبة دواء ثلاثية الأبعاد (CSS 3D بلا مكتبات) من صورة وجهها الأمامي:
 * - أبعاد الوجه من نسبة الصورة نفسها، والعمق من `depth` — فتحاكي العلبة الحقيقية.
 * - ألوان الجوانب والسقف تُستخرج من حواف الصورة (canvas) مع تظليل إضاءة.
 * - تتمايل ببطء وحدها، وتميل مع مؤشر الماوس عند المرور فوقها.
 * الصور من نفس النطاق (/items) فقراءة بكسلاتها مسموحة.
 */
type RGB = [number, number, number];
interface BoxMeta { aspect: number; top: RGB; bottom: RGB; left: RGB; right: RGB }
const boxMetaCache = new Map<string, BoxMeta>();
function loadBoxMeta(src: string): Promise<BoxMeta> {
  const hit = boxMetaCache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const S = 48;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      if (!ctx) return reject(new Error('no canvas'));
      ctx.drawImage(im, 0, 0, S, S);
      const avg = (x: number, y: number, w: number, h: number): RGB => {
        const d = ctx.getImageData(x, y, w, h).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; }
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      };
      const meta: BoxMeta = {
        aspect: im.naturalWidth / im.naturalHeight,
        top: avg(0, 0, S, 3), bottom: avg(0, S - 3, S, 3), left: avg(0, 0, 3, S), right: avg(S - 3, 0, 3, S),
      };
      boxMetaCache.set(src, meta);
      resolve(meta);
    };
    im.onerror = reject;
    im.src = src;
  });
}
const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function Box3D({ src, depth, faces, scale = 1, label }: { src: string; depth: number; faces?: BoxFaces; scale?: number; label: string }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<BoxMeta | null>(boxMetaCache.get(src) ?? null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tilt, setTilt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    loadBoxMeta(src).then(m => { if (alive) setMeta(m); }).catch(() => { /* تبقى بلا علبة */ });
    return () => { alive = false; };
  }, [src]);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // الوجه الأمامي يأخذ أكبر مقاس يتّسع في البطاقة مع ترك مكان للعمق والشارات
  let W = size.w * 0.6 * scale, H = meta ? W / meta.aspect : 0;
  if (meta && H > size.h * 0.6 * scale) { H = size.h * 0.6 * scale; W = H * meta.aspect; }
  const D = H * depth;

  const onMove = (e: React.PointerEvent) => {
    // الميل مع الماوس للبطاقة المعروضة في الوسط فقط — الجانبية تبقى ساكنة (بدل فرض وضع ثابت
    // بـCSS كان يُرجع المجسّم فجأةً لحظة التنقّل بالأسهم والماوس فوقه)
    if (!e.currentTarget.closest('.cf-slot')?.classList.contains('is-active')) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5..0.5
    const py = (e.clientY - r.top) / r.height - 0.5;
    // متماثل حول الوسط: الماوس يساراً يُظهر الطرف الأيسر كاملاً، ويميناً الأيمن، وأعلى/أسفل يكشف السقف
    setTilt({ x: -16 - py * 24, y: px * 100 });
  };

  const face = (style: React.CSSProperties, child: ReactNode) => <div className="b3d-face" style={style}>{child}</div>;
  const side = (c: RGB, overlay: string) => <div style={{ width: '100%', height: '100%', background: `${overlay}, ${rgb(c)}` }} />;
  // وجه بصورته الحقيقية + طبقة إضاءة خفيفة (الجوانب أظلم قليلاً، السقف مضاء) كي يبقى إحساس العمق
  const tex = (url: string, overlay: string) => (
    <><img src={url} alt="" draggable={false} /><div className="b3d-light" style={{ background: overlay }} /></>
  );

  return (
    <div className="b3d-scene" ref={sceneRef} onPointerMove={onMove} onPointerLeave={() => setTilt(null)}>
      {meta && W > 0 && (
        <>
          <div className="b3d-glow" style={{ width: W * 1.6, height: H * 1.6 }} />
          <div className="b3d-shadow" style={{ width: W * 1.15 }} />
          {/* طبقة الطفو: العلبة تعلو وتهبط ببطء (والظل يصغر معها) — مستقلة عن التمايل/الميل */}
          <div className="b3d-bob">
          <div className={`b3d ${tilt ? 'is-tilt' : ''}`} role="img" aria-label={label}
            style={{ width: W, height: H, ...(tilt ? { transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` } : {}) }}>
            {face({ width: W, height: H, transform: `translateZ(${D / 2}px)` },
              <><img src={src} alt="" draggable={false} /><div className="b3d-sheen" /></>)}
            {face({ width: W, height: H, transform: `rotateY(180deg) translateZ(${D / 2}px)` },
              side(meta.bottom, 'linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.35))'))}
            {face({ width: D, height: H, left: (W - D) / 2, transform: `rotateY(90deg) translateZ(${W / 2}px)` },
              faces?.right
                ? tex(faces.right, 'linear-gradient(to right, rgba(0,0,0,.03), rgba(0,0,0,.14))')
                : side(meta.right, 'linear-gradient(to right, rgba(0,0,0,.15), rgba(0,0,0,.4))'))}
            {face({ width: D, height: H, left: (W - D) / 2, transform: `rotateY(-90deg) translateZ(${W / 2}px)` },
              faces?.left
                ? tex(faces.left, 'linear-gradient(to left, rgba(0,0,0,.02), rgba(0,0,0,.12))')
                : side(meta.left, 'linear-gradient(to left, rgba(0,0,0,.1), rgba(0,0,0,.32))'))}
            {face({ width: W, height: D, top: (H - D) / 2, transform: `rotateX(90deg) translateZ(${H / 2}px)` },
              faces?.top
                ? tex(faces.top, 'linear-gradient(to top, rgba(255,255,255,.2), rgba(255,255,255,.04))')
                : side(meta.top, 'linear-gradient(to top, rgba(255,255,255,.28), rgba(255,255,255,.06))'))}
            {face({ width: W, height: D, top: (H - D) / 2, transform: `rotateX(-90deg) translateZ(${H / 2}px)` },
              side(meta.bottom, 'linear-gradient(rgba(0,0,0,.45), rgba(0,0,0,.45))'))}
          </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * رسمة علبة دواء مولَّدة للايتم الذي لا صورة له: علبة ثلاثية الأبعاد بلون ثابت
 * لكل ايتم (مشتق من اسمه، ضمن ألوان أوردين)، عليها اسم الماركة وشريط الجرعة
 * والشركة وأيقونة الشكل الصيدلاني (حبوب/كبسول/شراب/أمبول/كريم/قطرة).
 */
const ART_HUES = ['#1a56db', '#0891b2', '#4f46e5', '#0f766e', '#2563eb', '#0e7490', '#6d28d9', '#1e40af'];
function ItemArt({ name, company }: { name: string; company: string | null }) {
  const hash = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const hue = ART_HUES[hash % ART_HUES.length];
  const strength = /(\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|g|iu|%))/i.exec(name)?.[1]?.replace(/\s+/g, '').toUpperCase() ?? '';
  // الماركة = الكلمات قبل أول رقم/قوس، ثم تُقصّ بالكلمات حتى ~12 حرفاً كي لا تخرج من وجه العلبة
  const words = (name.split(/\s+\d|\s*\(|,/)[0] || name).trim().toUpperCase().split(/\s+/);
  let brand = words[0] ?? '';
  for (const w of words.slice(1)) { if ((brand + ' ' + w).length > 12) break; brand += ' ' + w; }
  const n = name.toLowerCase();
  const form = /syrup|susp|شراب/.test(n) ? 'syrup'
    : /amp|vial|inj|\bim\b|\biv\b/.test(n) ? 'amp'
    : /cream|gel|oint|كريم/.test(n) ? 'tube'
    : /drop|damla|قطر/.test(n) ? 'drop'
    : /cap/.test(n) ? 'cap' : 'tab';
  const brandSize = Math.max(11, Math.min(22, 140 / Math.max(brand.length * 0.68, 1)));
  // أمان إضافي: لو بقي العرض المقدَّر أعرض من الوجه يُضغط النص إلى عرضه
  const fitText = brand.length * brandSize * 0.68 > 144 ? { textLength: 144, lengthAdjust: 'spacingAndGlyphs' as const } : {};
  const gid = `ia${hash}`;
  return (
    <svg className="bb-art" viewBox="0 0 240 160" role="img" aria-label={name}>
      <defs>
        <linearGradient id={`${gid}f`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#eef2fb" />
        </linearGradient>
        <clipPath id={`${gid}c`}><rect x="30" y="40" width="160" height="102" /></clipPath>
      </defs>
      {/* ظل أرضي */}
      <ellipse cx="125" cy="148" rx="92" ry="7" fill="#0f1e35" opacity=".12" />
      {/* الوجه العلوي والجانبي */}
      <polygon points="30,40 58,20 218,20 190,40" fill={hue} opacity=".28" />
      <polygon points="190,40 218,20 218,122 190,142" fill={hue} opacity=".85" />
      {/* الوجه الأمامي */}
      <rect x="30" y="40" width="160" height="102" fill={`url(#${gid}f)`} stroke="#0f1e35" strokeOpacity=".08" />
      {/* أقواس زخرفية مثل علب الأدوية */}
      <g fill="none" stroke={hue} strokeOpacity=".18" strokeWidth="5" clipPath={`url(#${gid}c)`}>
        <circle cx="178" cy="52" r="16" /><circle cx="178" cy="52" r="28" /><circle cx="178" cy="52" r="40" />
      </g>
      {/* الشركة */}
      <text x="38" y="54" fontSize="8.5" fontWeight="700" fill={hue} direction="ltr" style={{ textTransform: 'uppercase' }}>
        {(company ?? '').slice(0, 22)}
      </text>
      {/* أيقونة الشكل الصيدلاني */}
      <g transform="translate(152,50)" fill={hue}>
        {form === 'tab' && <><circle cx="8" cy="10" r="7" /><circle cx="24" cy="10" r="7" opacity=".55" /></>}
        {form === 'cap' && <><rect x="0" y="4" width="30" height="12" rx="6" opacity=".55" /><rect x="0" y="4" width="15" height="12" rx="6" /></>}
        {form === 'syrup' && <><rect x="9" y="0" width="12" height="5" rx="1" /><rect x="5" y="5" width="20" height="18" rx="4" opacity=".8" /></>}
        {form === 'amp' && <><rect x="11" y="0" width="8" height="6" rx="2" /><rect x="8" y="6" width="14" height="18" rx="3" opacity=".8" /></>}
        {form === 'tube' && <><rect x="0" y="8" width="24" height="10" rx="2" opacity=".8" /><rect x="24" y="10" width="7" height="6" rx="1" /></>}
        {form === 'drop' && <path d="M15 0 C 15 0, 4 12, 4 18 a 11 11 0 0 0 22 0 C 26 12, 15 0, 15 0 Z" opacity=".8" />}
      </g>
      {/* اسم الماركة */}
      <text x="38" y="98" fontSize={brandSize} fontWeight="900" fill="#0f1e35" direction="ltr" letterSpacing=".3" {...fitText}>{brand}</text>
      {/* شريط الجرعة */}
      <rect x="30" y="108" width="160" height="22" fill={hue} />
      <text x="38" y="123.5" fontSize="11" fontWeight="800" fill="#fff" direction="ltr">{strength || 'Rx'}</text>
      <rect x="30" y="130" width="160" height="12" fill={hue} opacity=".12" />
    </svg>
  );
}

/**
 * خلفية واجهة اللوحة: نفس أزرق بطاقة الايتم ممتدّاً على الصفحة كلها، مع بقع ضوء
 * هادئة تنجرف ببطء وتتحرّك قليلاً مع الماوس (--mx/--my)، وذرّات ضوء خافتة تطفو.
 * ثابتة خلف المحتوى (position: fixed) فتغطي مساحة الصفحة كاملة.
 */
const SKY_DOTS = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 37) % 100, top: (i * 53 + 11) % 100, size: 2 + (i % 3), delay: (i * 0.9) % 12, dur: 14 + (i % 5) * 3,
}));
function Sky() {
  return (
    <div className="hp-sky" aria-hidden="true">
      <span className="hp-sky-blob b1" />
      <span className="hp-sky-blob b2" />
      <span className="hp-sky-blob b3" />
      {SKY_DOTS.map((d, i) => (
        <span key={i} className="hp-sky-dot"
          style={{ left: `${d.left}%`, top: `${d.top}%`, width: d.size, height: d.size, animationDelay: `${-d.delay}s`, animationDuration: `${d.dur}s` }} />
      ))}
    </div>
  );
}

/** دوّار بطاقات: النشطة في الوسط، ±1 و±2 على الجانبين أصغر وأشفّ. */
function Coverflow({ count, render, onOpen, paused, offsetMs = 0, variant }: {
  count: number; render: (i: number) => ReactNode; onOpen: (i: number) => void; paused?: boolean; offsetMs?: number;
  /** يحدّد مقاس البطاقة: item (أطول — فيها صورة) أو prov */
  variant: 'item' | 'prov';
}) {
  const [active, setActive] = useState(0);
  // كل اختيار يدوي يعيد ضبط العدّاد كي لا تقفز البطاقة فور اختيارها
  const [kick, setKick] = useState(0);
  const pick = (i: number) => { setActive(i); setKick(k => k + 1); };
  // الإيقاف عند المرور: فقط حين يدخل الماوس البطاقة المعروضة في الوسط (لا أي مكان في
  // اللوحة — كان ذلك يبدو توقفاً دائماً)، ويُستأنف بخروجه أو بعد دقيقة كحدّ أقصى.
  // بعد انقضاء الدقيقة لا يعود المرور يوقف الدوران حتى يغادر الماوس اللوحة كلها،
  // وإلا لأوقفته البطاقة التالية فور وصولها تحت الماوس الساكن.
  const [hoverPause, setHoverPause] = useState(false);
  const hoverCapped = useRef(false);
  useEffect(() => {
    if (!hoverPause) return;
    const t = setTimeout(() => { hoverCapped.current = true; setHoverPause(false); }, HOVER_PAUSE_MAX_MS);
    return () => clearTimeout(t);
  }, [hoverPause]);
  const stop = paused || count < 2 || hoverPause;
  useEffect(() => { if (active >= count) setActive(0); }, [count, active]);

  // ── التحريك بأسهم الكيبورد ←/→ ─────────────────────────────────────────────
  // الاتجاه بصري: البطاقات التالية تقع على يسار الوسط (translateX سالب)، فسهم اليسار
  // يجلب التالية للوسط وسهم اليمين يجلب السابقة. يعيد ضبط عدّاد التقليب التلقائي.
  // ── هندسة الجانبيين: المسافة تُحسب بالبكسل من عرض اللوحة الفعلي كي تظهر البطاقة الجانبية
  // كاملة دائماً (بنسبة ثابتة كانت تُقصّ عند حواف الشاشة الأضيق). ±2 تُخفى إن لم تتّسع.
  const stageRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ stage: 0, card: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const slot = el.querySelector<HTMLElement>('.cf-slot');
      setGeo({ stage: el.clientWidth, card: slot?.offsetWidth ?? 0 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  const S1 = 0.74, S2 = 0.54, GAP = 14;
  const step = geo.card
    ? Math.max(geo.card * 0.5, Math.min(geo.card * 0.84, geo.stage / 2 - (geo.card * S1) / 2 - GAP))
    : 0;
  const fitsSecond = geo.card > 0 && 2 * step + (geo.card * S2) / 2 + GAP <= geo.stage / 2;

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (paused || count < 2) return;                      // نافذة التفاصيل مفتوحة أو بطاقة واحدة
      const el = rootRef.current;
      // الصفحة الرئيسية تبقى محمّلة (display:none) عند زيارة صفحة أخرى — لا نلتقط الأسهم حينها
      if (!el || el.getClientRects().length === 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // لا نسرق الكتابة
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? 1 : -1;
      setActive(a => (a + dir + count) % count);
      setKick(k => k + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, count]);
  useEffect(() => {
    if (stop) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    // إزاحة بدء للوحة الثانية كي لا تتقلّب اللوحتان في نفس اللحظة
    const start = setTimeout(() => {
      setActive(a => (a + 1) % count);
      interval = setInterval(() => setActive(a => (a + 1) % count), ROTATE_MS);
    }, kick ? ROTATE_MS : (offsetMs || ROTATE_MS));
    return () => { clearTimeout(start); if (interval) clearInterval(interval); };
  }, [stop, count, offsetMs, kick]);

  return (
    <div className={`cf cf-${variant} ${hoverPause ? 'is-paused' : ''}`} ref={rootRef}
      onPointerLeave={() => { hoverCapped.current = false; setHoverPause(false); }}>
      <div className="cf-stage" ref={stageRef}>
        {Array.from({ length: count }, (_, i) => {
          // أقصر مسافة دائرية من النشطة: -2..+2 ظاهرة، والباقي مخفي خلفها
          let off = i - active;
          if (off > count / 2) off -= count;
          if (off < -count / 2) off += count;
          const abs = Math.abs(off);
          const hidden = abs > 2 || (abs === 2 && !fitsSecond);
          return (
            <button key={i} type="button" className={`cf-slot ${off === 0 ? 'is-active' : ''}`}
              aria-hidden={hidden} tabIndex={hidden ? -1 : 0}
              style={{
                transform: `translateX(${step ? `${-off * step}px` : `${off * -84}%`}) scale(${abs === 0 ? CF_ACTIVE_SCALE : abs === 1 ? S1 : S2})`,
                opacity: hidden ? 0 : abs === 0 ? 1 : abs === 1 ? 0.55 : 0.25,
                zIndex: 10 - abs,
                pointerEvents: hidden ? 'none' : 'auto',
                filter: abs ? `blur(${abs * 0.7}px)` : undefined,
              }}
              onPointerEnter={() => { if (off === 0 && !hoverCapped.current) setHoverPause(true); }}
              onPointerLeave={() => { if (off === 0) setHoverPause(false); }}
              onClick={() => (off === 0 ? onOpen(i) : pick(i))}
              title={off === 0 ? 'اضغط لعرض التفاصيل' : undefined}>
              {render(i)}
            </button>
          );
        })}
      </div>
      <div className="cf-dots">
        {Array.from({ length: count }, (_, i) => (
          <button key={i} type="button" className={`cf-dot ${i === active ? 'is-on' : ''}`} onClick={() => pick(i)} aria-label={`بطاقة ${i + 1}`} />
        ))}
      </div>
    </div>
  );
}

function ProvinceItems({ prov }: { prov: ProvSummary }) {
  const list = prov.items.map(it => ({ ...it, q: netQ(it.now) })).filter(r => r.q !== 0).sort((a, b) => b.q - a.q);
  if (!list.length) return <div className="hp-muted">لا مبيع.</div>;
  const total = list.reduce((s, r) => s + r.q, 0);
  const max = Math.max(...list.map(r => r.q), 1);
  return (
    <div className="hp-prov bb-prov">
      {list.map(r => (
        <div key={r.id} className="hp-prov-row bb-prov-row">
          <span className="hp-prov-name" title={r.name}>
            {r.name}
            {total > 0 && r.q > 0 && <small className="hp-prov-pct">{(r.q / total) * 100 < 1 ? '<1%' : `${Math.round((r.q / total) * 100)}%`}</small>}
          </span>
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
.hp-view-btn { white-space: nowrap; }

/* ── اللوحة الإعلانية ── */
.bb { display: flex; flex-direction: column; gap: 14px; }
.bb-tabs { display: inline-flex; align-self: center; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 999px; padding: 4px; gap: 4px; box-shadow: var(--shadow-sm); }
.bb-tabs button { border: 0; background: none; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 700; color: var(--c-text-secondary);
  padding: 8px 22px; border-radius: 999px; transition: background .2s, color .2s; }
.bb-tabs button small { font-weight: 600; opacity: .7; }
.bb-tabs button.is-on { background: var(--c-accent); color: #fff; }
.bb-section { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--radius-lg); padding: 14px 10px 10px; overflow: hidden; }
.bb-title { font-weight: 800; font-size: 14.5px; color: var(--c-text-primary); display: flex; align-items: center; gap: 8px; padding: 0 8px 4px; }
.bb-title-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-accent); box-shadow: 0 0 0 4px var(--c-accent-light); }
.bb-title-dot.is-prov { background: #0891b2; box-shadow: 0 0 0 4px #cffafe; }

.cf { position: relative; }
.cf { --w: min(340px, 72vw); --h: 230px; }
/* بطاقة الايتم عريضة (≈16:9) لتطابق صور العلب العريضة فتغطيها الصورة بأقل قصّ */
.cf-item { --w: min(480px, 84vw); --h: 280px; }
.cf-stage { position: relative; height: calc(var(--h) + 30px); perspective: 1000px; }
.cf-slot { position: absolute; top: 14px; left: calc(50% - var(--w) / 2); width: var(--w); height: var(--h);
  padding: 0; border: 0; background: none; cursor: pointer; font-family: inherit; text-align: right;
  transition: transform .6s cubic-bezier(.2,.8,.2,1), opacity .6s ease, filter .6s ease; }
.cf-slot:focus-visible { outline: 3px solid var(--c-accent); outline-offset: 3px; border-radius: 18px; }
@media (prefers-reduced-motion: reduce) { .cf-slot { transition: none; } }
.cf-dots { display: flex; justify-content: center; gap: 6px; padding-top: 6px; }
.cf-dot { width: 7px; height: 7px; border-radius: 4px; border: 0; padding: 0; background: var(--c-border); cursor: pointer; transition: width .3s, background .3s; }
.cf-dot.is-on { width: 20px; background: var(--c-accent); }

.bb-card { position: relative; height: 100%; border-radius: 18px; padding: 16px 18px; color: #fff;
  display: flex; flex-direction: column; gap: 4px; box-shadow: 0 10px 28px rgba(15,30,53,.22); }
/* التوهّج داخل الخلفية (لا عنصر زائف) كي تبقى البطاقة بلا overflow:hidden فتبرز صورة العلبة خارج حافتها */
.bb-card-item { background: radial-gradient(circle at 92% 108%, rgba(255,255,255,.18), transparent 38%),
  linear-gradient(140deg, var(--c-primary) 0%, var(--c-primary-mid) 35%, var(--c-accent) 100%); }
.bb-card-prov { background: radial-gradient(circle at 92% 108%, rgba(255,255,255,.18), transparent 38%),
  linear-gradient(140deg, var(--c-primary) 0%, #0e3a5c 40%, #0891b2 100%); }
/* بطاقة الايتم: رأس (ترتيب + اسم + سهم) ثم إطار الصورة في الوسط ثم الكمية */
.bb-item-head { display: flex; align-items: center; gap: 8px; }
.bb-item-name { flex: 1; min-width: 0; font-size: 16px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  direction: ltr; text-align: center; }
.bb-center { text-align: center; }
.bb-frame { flex: 1; min-height: 0; margin: 8px 6px 6px; border-radius: 14px; padding: 8px;
  background: rgba(255,255,255,.96); box-shadow: inset 0 0 0 1px rgba(15,30,53,.08), 0 10px 24px rgba(0,0,0,.28);
  display: flex; align-items: center; justify-content: center; overflow: hidden; }
.bb-frame img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; pointer-events: none; user-select: none;
  transition: transform .6s ease; }
.cf-slot.is-active .bb-frame img { transform: scale(1.03); }
/* بطاقة بعلبة ثلاثية الأبعاد */
.bb-card.has-photo { padding: 0; overflow: hidden;
  background: radial-gradient(circle at 50% 115%, rgba(255,255,255,.24), transparent 55%),
    linear-gradient(140deg, var(--c-primary) 0%, var(--c-primary-mid) 35%, var(--c-accent) 100%); }
.b3d-scene { position: absolute; inset: 0 0 34px 0; perspective: 900px; display: flex; align-items: center; justify-content: center; }
.b3d { position: relative; transform-style: preserve-3d; transform: rotateX(-10deg) rotateY(-26deg);
  animation: b3d-sway 9s ease-in-out infinite alternate; transition: transform .25s ease-out; }
.b3d.is-tilt { animation: none; }
/* تمايل متماثل من جهة لأخرى: يُظهر الطرفين الأيسر والأيمن كاملين، مع ميل للأسفل
   يكشف شيئاً من الوجه العلوي */
@keyframes b3d-sway {
  0%   { transform: rotateX(-18deg) rotateY(-46deg); }
  100% { transform: rotateX(-14deg) rotateY(46deg); }
}
@media (prefers-reduced-motion: reduce) { .b3d { animation: none; } }
.b3d-face { position: absolute; top: 0; left: 0; backface-visibility: hidden; overflow: hidden; }
.b3d-face img { width: 100%; height: 100%; object-fit: fill; display: block; pointer-events: none; user-select: none; }
.b3d-light { position: absolute; inset: 0; pointer-events: none; }
.b3d-sheen { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(115deg, rgba(255,255,255,.42) 0%, rgba(255,255,255,0) 40%, rgba(0,0,0,.03) 100%); }
.b3d-shadow { position: absolute; left: 50%; bottom: 8%; height: 26px; transform: translateX(-50%);
  background: radial-gradient(ellipse, rgba(0,0,0,.55), transparent 70%); filter: blur(7px); pointer-events: none; }
.cf-slot:not(.is-active) .b3d { animation-play-state: paused; }

/* طفو العلبة: صعود وهبوط هادئ، والظل يصغر ويبهت حين تعلو */
.b3d-bob { transform-style: preserve-3d; animation: b3d-bob 5.5s ease-in-out infinite; }
@keyframes b3d-bob { 0%, 100% { transform: translateY(6px); } 50% { transform: translateY(-12px); } }
.b3d-shadow { animation: b3d-shadow 5.5s ease-in-out infinite; }
@keyframes b3d-shadow { 0%, 100% { transform: translateX(-50%) scale(1); opacity: .9; } 50% { transform: translateX(-50%) scale(.72); opacity: .5; } }
.b3d-glow { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(96,165,250,.32), transparent 65%); filter: blur(12px); opacity: 0; transition: opacity .8s ease; }
.cf-slot.is-active .b3d-glow { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .b3d-bob, .b3d-shadow { animation: none; } }

/* ══ واجهة اللوحة: خلفية فاتحة قريبة من الأبيض، والعناصر طافية بلا حدود ══ */
.hp.is-board { --mx: 0; --my: 0; position: relative; z-index: 0; max-width: 1240px; }
.hp-sky { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none;
  background: radial-gradient(ellipse at 50% 110%, #dbe7fb 0%, transparent 60%),
    linear-gradient(160deg, #fbfdff 0%, #f3f7fe 40%, #eaf1fc 75%, #e1ebfa 100%); }
.hp-sky-blob { position: absolute; border-radius: 50%; filter: blur(80px); will-change: transform; }
/* translate = اختلاف المنظر مع الماوس، transform = الانجراف البطيء — خاصيتان منفصلتان فلا تتعارضان */
.hp-sky-blob.b1 { width: 44vw; height: 44vw; left: 6%; top: 8%; background: #bfd5fb; opacity: .55;
  translate: calc(var(--mx) * -46px) calc(var(--my) * -34px); animation: sky-drift 28s ease-in-out infinite alternate; }
.hp-sky-blob.b2 { width: 38vw; height: 38vw; right: 4%; bottom: -6%; background: #c4ecf5; opacity: .5;
  translate: calc(var(--mx) * 38px) calc(var(--my) * 30px); animation: sky-drift 34s ease-in-out infinite alternate-reverse; }
.hp-sky-blob.b3 { width: 30vw; height: 30vw; left: 38%; top: -10%; background: #d6dcfb; opacity: .5;
  translate: calc(var(--mx) * 24px) calc(var(--my) * -20px); animation: sky-drift 40s ease-in-out infinite alternate; }
@keyframes sky-drift { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(6vw, 5vh) scale(1.18); } }
.hp-sky-dot { position: absolute; border-radius: 50%; background: rgba(26,86,219,.28); box-shadow: 0 0 6px rgba(26,86,219,.25);
  translate: calc(var(--mx) * 16px) calc(var(--my) * 16px); animation: sky-float linear infinite; opacity: 0; }
@keyframes sky-float { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: .7; } 85% { opacity: .7; } 100% { transform: translateY(-110px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .hp-sky-blob, .hp-sky-dot { animation: none; } .hp-sky-dot { opacity: .5; } }

.hp.is-board .hp-month, .hp.is-board .hp-view-btn { background: rgba(255,255,255,.7); color: var(--c-primary);
  border: 1px solid rgba(15,30,53,.08); backdrop-filter: blur(8px); box-shadow: 0 2px 10px rgba(15,30,53,.05); }
.hp.is-board .hp-view-btn:hover { background: #fff; }
.hp.is-board .bb-tabs { background: rgba(255,255,255,.65); border-color: rgba(15,30,53,.06); backdrop-filter: blur(10px); }
.hp.is-board .bb-section { background: none; border: 0; box-shadow: none; overflow: visible; padding: 4px 0 0; }
.hp.is-board .bb-title { justify-content: center; }
.hp.is-board .cf { overflow-x: clip; overflow-y: visible; }
.hp.is-board .cf-dot { background: rgba(15,30,53,.14); }
.cf.is-paused .cf-dot.is-on { opacity: .45; }
/* البطاقات بلا غلاف: لا خلفية ولا ظل — العلبة والنصوص تطفو مباشرةً فوق الصفحة، بنصوص داكنة */
.hp.is-board .bb-card, .hp.is-board .bb-card.has-photo, .hp.is-board .cf-slot.is-active .bb-card { background: none; box-shadow: none; color: var(--c-primary); }
.hp.is-board .bb-card .bb-rank { background: rgba(15,30,53,.08); color: var(--c-primary); }
.hp.is-board .bb-photo-top .bb-rank { background: var(--c-primary); color: #fff; }
.hp.is-board .bb-card .hp-delta { box-shadow: 0 2px 8px rgba(15,30,53,.08); }
.hp.is-board .bb-card-item:not(.has-photo) .bb-frame { background: none; box-shadow: none; }
.hp.is-board .bb-card-prov .bb-card-name { text-shadow: 0 4px 22px rgba(26,86,219,.18); }
.hp.is-board .bb-card-prov .bb-card-qty { color: var(--c-accent); }
.hp.is-board .bb-photo-pill { background: var(--c-primary); color: #fff; border: 0; box-shadow: 0 10px 24px rgba(15,30,53,.25); }
.hp.is-board .b3d-shadow { background: radial-gradient(ellipse, rgba(15,30,53,.35), transparent 70%); }
.hp.is-board .b3d-glow { background: radial-gradient(circle, rgba(26,86,219,.16), transparent 65%); }

/* ── الطفو للعنصر المعروض في الوسط فقط ── */
.hp.is-board .cf-slot .bb-card-item:not(.has-photo) .bb-frame { animation: b3d-bob 5.5s ease-in-out infinite; }
.hp.is-board .cf-slot .bb-card-prov:not(.has-pimg) { animation: b3d-bob 6.5s ease-in-out infinite; }
/* البطاقات الجانبية ساكنة تماماً — لكن بـ«إيقاف مؤقت» لا بإلغاء الحركة: الإلغاء (animation:none)
   كان يُرجع المجسّم فجأةً لوضعه الابتدائي لحظة التنقّل (رجفة/ارتداد)، والبطاقة الجديدة تقفز لأول
   إطار. الإيقاف يجمّد المجسّم على وضعه الحالي، ويستأنف من نفس الوضع حين يعود للوسط. */
.cf-slot:not(.is-active) .b3d,
.cf-slot:not(.is-active) .b3d-bob,
.cf-slot:not(.is-active) .b3d-shadow,
.hp.is-board .cf-slot:not(.is-active) .bb-frame,
.hp.is-board .cf-slot:not(.is-active) .bb-card-prov { animation-play-state: paused; }

/* العنصر المعروض أكبر — المرحلة تتّسع لتكبيره (CF_ACTIVE_SCALE) */
.hp.is-board .cf-stage { height: calc(var(--h) * 1.4 + 120px); }
.hp.is-board .cf-slot { top: calc(var(--h) * 0.2 + 14px); }
/* الكمية تنزل تحت المجسّم (خارج حدود البطاقة) كي يبقى التركيز على العلبة، والعلبة تأخذ ارتفاع البطاقة كله */
.hp.is-board .bb-card.has-photo { overflow: visible; }
.hp.is-board .bb-card.has-photo .b3d-scene { inset: 0; }
.hp.is-board .bb-photo-pill { bottom: -70px; font-size: 20px; padding: 3px 14px; }
.hp.is-board .bb-photo-pill small { font-size: 11px; }
.hp.is-board .cf-dots { padding-top: 26px; }
.hp.is-board .cf-slot:focus-visible { outline-color: var(--c-accent); }

/* شاشة صافية: أزرار الرأس صغيرة جداً، وأزرار الايتمات/المحافظات يساراً بجانب «قائمة» */
.hp.is-board .hp-head { gap: 8px; }
.hp.is-board .hp-month { max-width: 150px; height: 30px; padding: 2px 10px; font-size: 12px; border-radius: 8px; }
.hp.is-board .hp-view-btn { height: 30px; padding: 2px 10px; font-size: 12px; border-radius: 8px; }
.hp-tab-slot { display: flex; }
.hp.is-board .hp-tab-slot .bb-tabs { align-self: auto; padding: 2px; gap: 2px; box-shadow: none; }
.hp.is-board .hp-tab-slot .bb-tabs button { font-size: 11.5px; padding: 4px 10px; font-weight: 700; }
.hp.is-board .hp-tab-slot .bb-tabs button small { font-size: 10px; }
.bb-photo-top { position: absolute; top: 12px; left: 12px; right: 12px; z-index: 1; display: flex; justify-content: space-between; align-items: center; }
.bb-photo-top .bb-rank { background: rgba(15,30,53,.75); backdrop-filter: blur(4px); }
.bb-photo-top .hp-delta { box-shadow: 0 2px 8px rgba(0,0,0,.2); }
/* شارة الكمية الزجاجية مكتوبة على الصورة نفسها */
.bb-photo-pill { position: absolute; bottom: 12px; z-index: 1; padding: 6px 14px; border-radius: 14px;
  background: rgba(15,30,53,.78); backdrop-filter: blur(6px); box-shadow: 0 6px 18px rgba(0,0,0,.3);
  font-size: 28px; font-weight: 800; white-space: nowrap; line-height: 1.2; }
.bb-photo-pill { left: 50%; transform: translateX(-50%); bottom: 10px; font-size: 24px; padding: 4px 14px; }
.bb-photo-pill small { font-size: 12px; font-weight: 600; opacity: .8; }
.bb-art { width: 100%; height: 100%; display: block; transition: transform .6s ease; }
.cf-slot.is-active .bb-art { transform: scale(1.03); }
.bb-card-item .bb-card-qty { margin-top: 0; font-size: 32px; }
.cf-slot.is-active .bb-card { box-shadow: 0 16px 40px rgba(26,86,219,.35); }
.bb-card-top { display: flex; justify-content: space-between; align-items: center; }
.bb-rank { font-size: 12px; font-weight: 800; background: rgba(255,255,255,.16); border-radius: 999px; padding: 2px 10px; }
.bb-card .hp-delta { background: rgba(255,255,255,.95); }
.bb-card-name { font-size: 17px; font-weight: 800; margin-top: 10px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; direction: ltr; text-align: right; }
.bb-card-prov .bb-card-name { direction: rtl; font-size: 20px; margin-top: 0; }
.bb-card-icon { font-size: 22px; margin-top: 6px; }
/* بطاقة محافظة بصورة معلم: الصورة تملأ البطاقة وتدرّج داكن أسفلها يُبرز الاسم والكمية */
.bb-card.has-pimg, .hp.is-board .bb-card.has-pimg { padding: 0; overflow: hidden; color: #fff; background: var(--c-primary);
  box-shadow: 0 10px 28px rgba(15,30,53,.22); }
.hp.is-board .cf-slot.is-active .bb-card.has-pimg { box-shadow: 0 16px 40px rgba(26,86,219,.35); animation: none; }
.bb-pimg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; user-select: none; }
.bb-pimg-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(15,30,53,.28) 0%, rgba(15,30,53,0) 30%, rgba(15,30,53,.82) 100%); }
.bb-pimg-text { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 18px; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; direction: rtl; }
.bb-pimg-name { font-size: 24px; font-weight: 800; text-shadow: 0 2px 10px rgba(0,0,0,.55); }
.bb-pimg-qty { font-size: 24px; font-weight: 800; direction: rtl; text-shadow: 0 2px 10px rgba(0,0,0,.55); }
.bb-pimg-qty small { font-size: 12px; font-weight: 600; opacity: .85; }
.hp.is-board .bb-card.has-pimg .bb-rank { background: rgba(15,30,53,.75); color: #fff; }
.bb-card-sub { font-size: 12px; opacity: .75; }
.bb-card-qty { margin-top: auto; font-size: 30px; font-weight: 800; letter-spacing: -.5px; }
.bb-card-qty small { font-size: 13px; font-weight: 600; opacity: .75; }

.bb-modal { max-width: 560px; width: 100%; display: flex; flex-direction: column; max-height: 85vh; }
.bb-modal-head { gap: 14px; align-items: center; }
.bb-modal-total { margin-inline-start: auto; font-size: 34px; font-weight: 800; color: var(--c-accent); line-height: 1;
  white-space: nowrap; display: flex; align-items: baseline; gap: 6px; }
.bb-modal-total small { font-size: 13px; font-weight: 600; color: var(--c-text-muted); }
.bb-modal-body { padding: 12px 20px 18px; overflow-y: auto; }
.bb-modal .hp-prov { background: none; padding: 0; }
.bb-prov-row { grid-template-columns: minmax(0, 190px) 1fr auto; }
.bb-prov-row .hp-prov-name { direction: ltr; text-align: right; }

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
