// ════════════════════════════════════════════════════════════════════════════
// IraqRepsMap — خريطة العراق التفاعلية: لكل محافظة (عدا بغداد) عدد الشركات العاملة
// فيها، ومبيع كل شركة، والمندوبون العلميون التابعون لكل شركة.
//
// الحدود SVG مُسقَطة مسبقاً (src/data/iraqProvinces.ts) فلا مكتبة خرائط ولا بلاطات.
// المصادر:
//   • /api/reports/overall (مبيع − إرجاع) ← byProvince + byProvinceCompany: مبيع الشركات
//     بالمحافظة من الملفات نفسها — يعمل حتى قبل إنشاء حسابات المندوبين.
//   • مدير الشركة (company_manager) يرى مبيع تيمه وحده: teamManagerId = حسابه، نفس
//     فلتر شريحة «الشركة الرئيسية» في التحليل الشامل (ايتمات التيم المُسنَدة له).
//     بقية الأدوار ترى كل تيمات المكتب.
//   • بغداد: الضغط عليها يفتح خريطتها — خريطة حقيقية بالأقضية والنواحي (Leaflet،
//     BaghdadSalesMap) أو مخطط الكرخ/الرصافة (Area.subProvince). موقع كل منطقة من
//     سيرفي المندوب (/api/reports/baghdad-area-points)، وناحيتها = الناحية التي
//     تقع فيها تلك النقطة (nahiyaAt في src/data/baghdadAdmin.ts).
//   • /api/scientific-reps/province-map ← المندوبون العلميون بكل محافظة؛ تُنسَب الشركة
//     من `company` (الشركة الرئيسية لحساب المندوب) في قائمة reps الممرَّرة.
//
// ⚠️ الجلب يتحرّك بالملفات + الشهر فقط. حقلا التواريخ في ReportsPage يتبدّلان
// تلقائياً (فارغ↔مملوء)، وإدخالهما في الاعتماديات سبّب حلقة جلب لا تنتهي.
// ════════════════════════════════════════════════════════════════════════════

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { IRAQ_PROVINCE_SHAPES, IRAQ_MAP_VIEWBOX } from '../data/iraqProvinces';
import ProvinceTeamsDirectory from './ProvinceTeamsDirectory';
import { BAGHDAD_SIDE_SHAPES, BAGHDAD_MAP_VIEWBOX } from '../data/baghdadSides';
import { nahiyaAt } from '../data/baghdadAdmin';
// Leaflet + صورة القمر الصناعي تُحمَّل فقط عند فتح بغداد
const BaghdadSalesMap = lazy(() => import('./BaghdadSalesMap'));
import { useAuth } from '../context/AuthContext';

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
// bga = مناطق بغداد: a اسم المنطقة، s قسمها (الكرخ/الرصافة أو null)، v صافي المبيع
type SalesRows = { prov: Map<string, { name: string; value: number }>; pc: { p: string; c: string; v: number }[]; bga: { a: string; s: string | null; v: number }[] };
type CacheEntry = { v: any; t: number };
const MEM = new Map<string, CacheEntry>();
const LS_PREFIX = 'iqmap:v3:';
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
const packSales = (r: SalesRows) => ({ prov: [...r.prov], pc: r.pc, bga: r.bga });
const unpackSales = (v: any): SalesRows => ({ prov: new Map(v?.prov ?? []), pc: v?.pc ?? [], bga: v?.bga ?? [] });
const EMPTY_SALES: SalesRows = { prov: new Map(), pc: [], bga: [] };

const RAMP = ['#e0ecff', '#c7dbff', '#a3c2fb', '#78a3f5', '#4f84ea', '#2f66d6', '#1f4fb4', '#173a85'];
const VB = IRAQ_MAP_VIEWBOX;
const BVB = BAGHDAD_MAP_VIEWBOX;
// مفتاح اسم المنطقة — يطابق areaKey في reports.routes.js (مواقع السيرفي)
const areaKey = (s: string) => norm(s).replace(/ٱ/g, 'ا').replace(/ـ/g, '').replace(/^حي /, '');
const sideOf = (sub: string | null) => !sub ? null : norm(sub).includes('كرخ') ? 'الكرخ' : norm(sub).includes('رصاف') ? 'الرصافة' : null;
// مواقع مناطق بغداد لا تتغيّر بالشهر/الملف — تُجلب مرة لكل جلسة
let BAGHDAD_POINTS: Promise<Map<string, { lat: number; lng: number; n: number }>> | null = null;
// البطاقة الداكنة أعلى يمين الخريطة — معطّلة مؤقتاً بطلب المستخدم؛ true لإرجاعها.
const SHOW_HOVER_CARD = false;

// ── خلفية شبكية تفاعلية: نقاط تسبح ببطء وتتصل بخطوط فيما بينها، وتنجذب وتتوهّج
// قرب المؤشر. canvas خلف الخريطة بلا pointer-events — الماوس يُلتقط من العنصر الأب.
// تتوقف عند خروج الخريطة من الشاشة / إخفاء التبويب، وتُعطَّل مع «تقليل الحركة».
function PlexusBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; const host = cv?.parentElement; if (!cv || !host) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const LINK = 80, MOUSE_R = 140;
    let w = 0, h = 0, raf = 0, visible = true;
    let pts: { x: number; y: number; vx: number; vy: number }[] = [];
    const mouse = { x: -1e4, y: -1e4, on: false };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = host.clientWidth; h = host.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, Math.max(30, (w * h) / 9000)));
      pts = Array.from({ length: n }, (_, i) => pts[i] ?? {
        x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
      });
    };

    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        let nearMouse = false;
        if (mouse.on) {
          const dx = mouse.x - p.x, dy = mouse.y - p.y, d = Math.hypot(dx, dy);
          if (d < MOUSE_R && d > 1) { nearMouse = true; p.vx += (dx / d) * 0.0012; p.vy += (dy / d) * 0.0012; }
        }
        // سقف سرعة منخفض، وأخفض قرب المؤشر: التجمّع حوله والتفرّق بعده بطيئان جداً
        const cap = nearMouse ? 0.18 : 0.4;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > cap) { p.vx *= cap / sp; p.vy *= cap / sp; }
        else if (sp < 0.12) { p.vx += (Math.random() - 0.5) * 0.04; p.vy += (Math.random() - 0.5) * 0.04; }
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) { p.vx *= -1; p.x = Math.max(0, Math.min(w, p.x)); }
        if (p.y < 0 || p.y > h) { p.vy *= -1; p.y = Math.max(0, Math.min(h, p.y)); }
      }
      // خطوط بين النقاط المتقاربة — أوضح كلما اقتربت من المؤشر
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > LINK) continue;
          const near = mouse.on ? Math.max(0, 1 - Math.hypot((a.x + b.x) / 2 - mouse.x, (a.y + b.y) / 2 - mouse.y) / MOUSE_R) : 0;
          ctx.strokeStyle = `rgba(47,102,214,${(1 - d / LINK) * (0.09 + near * 0.35)})`;
          ctx.lineWidth = 0.8 + near * 0.6;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      // خطوط من المؤشر إلى النقاط القريبة
      if (mouse.on) {
        for (const p of pts) {
          const d = Math.hypot(p.x - mouse.x, p.y - mouse.y); if (d > MOUSE_R) continue;
          ctx.strokeStyle = `rgba(31,79,180,${(1 - d / MOUSE_R) * 0.4})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
      }
      for (const p of pts) {
        const near = mouse.on ? Math.max(0, 1 - Math.hypot(p.x - mouse.x, p.y - mouse.y) / MOUSE_R) : 0;
        ctx.fillStyle = `rgba(31,79,180,${0.35 + near * 0.55})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.6 + near * 1.6, 0, Math.PI * 2); ctx.fill();
      }
      if (!still && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };

    const onMove = (e: MouseEvent) => { const r = host.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.on = true; if (still) kick(); };
    const onLeave = () => { mouse.on = false; if (still) kick(); };
    const onVis = () => { if (!document.hidden && visible) kick(); };
    const ro = new ResizeObserver(() => { resize(); kick(); });
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) kick(); });
    ro.observe(host); io.observe(host);
    host.addEventListener('mousemove', onMove, { passive: true });
    host.addEventListener('mouseleave', onLeave);
    document.addEventListener('visibilitychange', onVis);
    resize(); kick();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      host.removeEventListener('mousemove', onMove); host.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return <canvas ref={ref} aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }} />;
}

export default function IraqRepsMap({ reps, token, fileIds, applyMonth, months = [], ready = true, monthKey, fromDate, toDate, fmtVal, currencyLabel }: Props) {
  const { user } = useAuth();
  // مدير الشركة: مبيع تيمه فقط — لا بقية شركات المكتب
  const ownTeamId = user?.role === 'company_manager' ? user.id : null;
  const [repData, setRepData] = useState<RepProvinceRow[]>([]);
  const [salesRows, setSalesRows] = useState<SalesRows>(EMPTY_SALES);
  // خريطة بغداد: مفتوحة؟ + طريقة العرض + قسم/منطقة مختارة
  const [bgOpen, setBgOpen] = useState(false);
  const [bgMode, setBgMode] = useState<'map' | 'sides'>('map');
  const [bgBubbles, setBgBubbles] = useState(true);
  const [bgNahiya, setBgNahiya] = useState<string | null>(null);
  const [bgSide, setBgSide] = useState<string | null>(null);
  const [bgArea, setBgArea] = useState<string | null>(null);
  const [bgPoints, setBgPoints] = useState<Map<string, { lat: number; lng: number; n: number }> | null>(null);
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [teamsOpen, setTeamsOpen] = useState(false);
  // محافظة ضُغطت من الخريطة → النافذة تفتح على فريقها مباشرة (null = كل الفرق)
  const [dirProvince, setDirProvince] = useState<string | null>(null);
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
    if (ownTeamId) p.set('teamManagerId', String(ownTeamId));
    return p;
  };
  const prefetchMonths = () => [...monthsRef.current].filter(m => /^\d{4}-\d{2}$/.test(m) && m !== monthKey).sort().reverse().slice(0, 3);

  // ── مبيع المحافظات (لا ينتظر قائمة المندوبين) ──────────────────────────────
  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    const cacheable = monthKey !== 'custom';
    const keyOf = (mk: string) => `s|${tok}|${ownTeamId ?? ''}|${fileKey}|${mk}`;
    const hit = cacheable ? cacheGet(keyOf(monthKey)) : undefined;
    if (hit) setSalesRows(unpackSales(hit.v));
    // قبل حسم الشهر الافتراضي لا نجلب شيئاً — كان طلب «الكل» يُطلق ثم يُلغى ويهدر وقت السيرفر.
    if (!ready || !fileIds.length) {
      if (!fileIds.length) setSalesRows(EMPTY_SALES);
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
      const bgaMap = new Map<string, { a: string; s: string | null; v: number }>();
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
        for (const row of d.byBaghdadArea ?? []) {
          if (!row.areaName) continue;
          const cur = bgaMap.get(row.areaName) ?? { a: row.areaName, s: row.subProvince ?? null, v: 0 };
          cur.v += sign * (row.totalValue ?? 0); bgaMap.set(row.areaName, cur);
        }
      };
      await Promise.all([add(saleRes, 1), add(retRes, -1)]);
      return { prov, pc: [...pcMap.values()], bga: [...bgaMap.values()] };
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
  }, [fileKey, monthKey, tok, ready, ownTeamId]);

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

  const totals = useMemo(() => {
    const cos = new Set<string>(); const rp = new Set<number>(); let v = 0;
    for (const c of list) { v += c.total; c.companies.forEach(x => { cos.add(norm(x.name)); x.reps.forEach(r => rp.add(r.id)); }); }
    return { value: v, companies: cos.size, reps: rp.size, provinces: list.filter(c => c.total !== 0 || c.repCount > 0).length };
  }, [list]);

  // مواقع المناطق — عند أول فتح لعرض الفقاعات فقط
  useEffect(() => {
    if (!bgOpen || bgPoints) return;
    type Pt = { lat: number; lng: number; n: number };
    const req: Promise<Map<string, Pt>> = BAGHDAD_POINTS ?? fetch('/api/reports/baghdad-area-points', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => new Map<string, Pt>((j.data ?? []).map((p: any) => [p.key as string, { lat: p.lat, lng: p.lng, n: p.n }])))
      .catch(() => { BAGHDAD_POINTS = null; return new Map<string, Pt>(); });
    BAGHDAD_POINTS = req;
    let dead = false;
    req.then(m => { if (!dead) setBgPoints(m); });
    return () => { dead = true; };
  }, [bgOpen, bgPoints, token]);

  const bg = useMemo(() => {
    const areas = salesRows.bga.map(x => {
      const pt = bgPoints?.get(areaKey(x.a));
      const nh = pt ? nahiyaAt(pt.lat, pt.lng) : null;
      return { name: x.a, side: sideOf(x.s), value: x.v, lat: pt?.lat, lng: pt?.lng, nahiya: nh?.name ?? null };
    }).sort((a, b) => b.value - a.value);
    const sideTotals = new Map<string, number>();
    const nahiyaTotals = new Map<string, number>();
    for (const a of areas) {
      if (a.side) sideTotals.set(a.side, (sideTotals.get(a.side) ?? 0) + a.value);
      if (a.nahiya) nahiyaTotals.set(a.nahiya, (nahiyaTotals.get(a.nahiya) ?? 0) + a.value);
    }
    const total = areas.reduce((t, a) => t + a.value, 0);
    return { areas, sideTotals, nahiyaTotals, total };
  }, [salesRows.bga, bgPoints]);

  const side = wrapW >= 940;

  const pickProvince = (name: string) => { setSel(name); setDirProvince(name); setTeamsOpen(true); };
  const openBaghdad = () => { setBgOpen(true); setBgSide(null); setBgNahiya(null); setBgArea(null); setHover(null); };

  const companyPanel = (c: ProvinceCell) => {
    const cmax = Math.max(1, ...c.companies.map(x => Math.abs(x.value)));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {c.companies.length === 0 && <div style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد شركات مسجّلة في هذه المحافظة للفترة المختارة.</div>}
        {c.companies.map(co => (
          <div key={co.name} style={{ border: '1px solid #e6ebf2', borderRadius: 10, padding: '6px 9px', background: '#fbfcfe' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 12, color: '#0f172a' }}>{co.name}</span>
              <span style={{ fontWeight: 800, fontSize: 12, color: co.value < 0 ? '#be123c' : '#1f4fb4', direction: 'ltr' }}>{fmtVal(co.value)}</span>
            </div>
            <div style={{ height: 4, borderRadius: 4, background: '#e9eef5', margin: '5px 0' }}>
              <div style={{ height: '100%', width: `${Math.max(3, (Math.abs(co.value) / cmax) * 100)}%`, background: 'linear-gradient(90deg,#2f66d6,#78a3f5)', borderRadius: 5 }} />
            </div>
            {co.reps.length === 0
              ? <span style={{ fontSize: 10.5, color: '#94a3b8' }}>لا يوجد مندوب علمي بعد</span>
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

  // ── بغداد: خريطة حقيقية بالأقضية/النواحي (افتراضي) أو مخطط الكرخ/الرصافة ──
  const renderBaghdadMap = () => {
    const sideMax = Math.max(1, ...[...bg.sideTotals.values()].map(Math.abs));
    // قسمان فقط: الأعلى بدرجة 5، والآخر بنسبته منه — كي يظهر الفرق بينهما
    const sideIdx = (v: number) => v <= 0 ? -1 : 2 + Math.round(3 * v / sideMax);
    const sideFill = (v: number) => sideIdx(v) < 0 ? '#edf1f7' : RAMP[sideIdx(v)];
    const chip = (on: boolean): React.CSSProperties => ({ border: 'none', cursor: 'pointer', padding: '6px 14px', fontSize: 12, fontWeight: 700, background: on ? '#0f172a' : 'transparent', color: on ? '#fff' : '#475569' });
    const located = bg.areas.filter(a => a.lat != null && a.value > 0);
    return (
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8, paddingInline: 6 }}>
          <button type="button" onClick={() => setBgOpen(false)}
            style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#0f172a' }}>
            → خريطة العراق
          </button>
          <span style={{ fontSize: 16, fontWeight: 900, color: '#0f172a' }}>بغداد</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#1f4fb4', direction: 'ltr' }}>{fmtVal(bg.total)} {currencyLabel}</span>
          <span style={{ flex: 1 }} />
          {bgMode === 'map' && (
            <button type="button" onClick={() => setBgBubbles(v => !v)}
              style={{ border: '1px solid #cbd5e1', borderRadius: 999, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: bgBubbles ? '#eef3fd' : '#fff', color: bgBubbles ? '#1f4fb4' : '#64748b' }}>
              {bgBubbles ? '● ' : '○ '}فقاعات المناطق
            </button>
          )}
          <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 999, overflow: 'hidden', background: '#fff' }}>
            <button type="button" style={chip(bgMode === 'map')} onClick={() => { setBgMode('map'); setBgSide(null); }}>خريطة بغداد</button>
            <button type="button" style={chip(bgMode === 'sides')} onClick={() => { setBgMode('sides'); setBgNahiya(null); }}>الكرخ / الرصافة</button>
          </div>
        </div>
        {bgMode === 'map' ? (
          <>
            <Suspense fallback={<div style={{ height: side ? 600 : 460, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 13 }}>جاري تحميل خريطة بغداد…</div>}>
              <BaghdadSalesMap
                areas={located.map(a => ({ name: a.name, value: a.value, lat: a.lat!, lng: a.lng! }))}
                nahiyaTotals={bg.nahiyaTotals}
                selNahiya={bgNahiya} onSelectNahiya={n => { setBgNahiya(n); setBgArea(null); }}
                selArea={bgArea} onSelectArea={setBgArea}
                showBubbles={bgBubbles} fmtVal={fmtVal} currencyLabel={currencyLabel}
                height={side ? 600 : 460} />
            </Suspense>
            <div style={{ textAlign: 'center', fontSize: 11.5, color: '#64748b', marginTop: 6 }}>
              {!bgPoints ? 'جاري تحميل مواقع المناطق…'
                : `اضغط على ناحية لعرض مناطقها · مبيع الناحية = مناطقها ذات الموقع في سيرفي المندوب · ${located.length} من ${bg.areas.filter(a => a.value > 0).length} منطقة لها موقع`}
            </div>
          </>
        ) : (
          <>
            <div style={{ width: side ? '78%' : '100%', maxWidth: 760, marginInline: 'auto' }}>
              <svg viewBox={`-20 -20 ${BVB.w + 40} ${BVB.h + 40}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="خريطة بغداد — الكرخ والرصافة">
                <g filter="url(#iqMapShadow)">
                  {BAGHDAD_SIDE_SHAPES.map(sh => {
                    const v = bg.sideTotals.get(sh.name) ?? 0;
                    const on = bgSide === sh.name;
                    return (
                      <path key={sh.name} d={sh.d} fillRule="evenodd" fill={sideFill(v)}
                        stroke={on ? '#0f172a' : '#ffffff'} strokeWidth={on ? 4 : 3} strokeLinejoin="round"
                        style={{ cursor: 'pointer', transition: 'fill .25s' }}
                        onClick={() => { setBgSide(on ? null : sh.name); setBgArea(null); }} />
                    );
                  })}
                </g>
                {BAGHDAD_SIDE_SHAPES.map(sh => {
                  const v = bg.sideTotals.get(sh.name) ?? 0;
                  const dark = sideIdx(v) >= 4;
                  const n = bg.areas.filter(a => a.side === sh.name).length;
                  return (
                    <g key={sh.name} style={{ pointerEvents: 'none' }}>
                      <text x={sh.cx} y={sh.cy - 18} textAnchor="middle" style={{ fontSize: 34, fontWeight: 900, fill: dark ? '#fff' : '#0f172a', paintOrder: 'stroke', stroke: dark ? 'rgba(15,23,42,.35)' : 'rgba(255,255,255,.85)', strokeWidth: 4 }}>{sh.name}</text>
                      <text x={sh.cx} y={sh.cy + 22} textAnchor="middle" style={{ fontSize: 26, fontWeight: 800, fill: dark ? '#fff' : '#1f4fb4', paintOrder: 'stroke', stroke: dark ? 'rgba(15,23,42,.35)' : 'rgba(255,255,255,.9)', strokeWidth: 4 }}>{fmtVal(v)}</text>
                      <text x={sh.cx} y={sh.cy + 54} textAnchor="middle" style={{ fontSize: 20, fontWeight: 700, fill: dark ? '#e2e8f0' : '#475569' }}>{n} منطقة</text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div style={{ textAlign: 'center', fontSize: 11.5, color: '#64748b', marginTop: 6 }}>اضغط على الكرخ أو الرصافة لعرض مناطقه في القائمة</div>
          </>
        )}
      </div>
    );
  };

  const renderBaghdadPanel = () => {
    const rows = bg.areas.filter(a => bgMode === 'map' ? (!bgNahiya || a.nahiya === bgNahiya) : (!bgSide || a.side === bgSide));
    const max = Math.max(1, ...rows.map(a => Math.abs(a.value)));
    const sub = rows.reduce((t, a) => t + a.value, 0);
    const title = bgMode === 'map' ? (bgNahiya ? `ناحية ${bgNahiya}` : 'كل المناطق') : (bgSide ?? 'كل المناطق');
    const pill = (on: boolean): React.CSSProperties => ({ fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: '4px 12px', cursor: 'pointer', border: 'none', background: on ? '#1f4fb4' : '#eef3fd', color: on ? '#fff' : '#1f4fb4' });
    const nahiyaList = [...bg.nahiyaTotals.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
    return (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 600 }}>بغداد</div>
            <div style={{ fontSize: 17, fontWeight: 900, color: '#0f172a', lineHeight: 1.2 }}>{title}</div>
          </div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>صافي المبيع</div>
            <div style={{ fontSize: 15, fontWeight: 900, color: sub < 0 ? '#be123c' : '#1f4fb4' }}>{fmtVal(sub)} <span style={{ fontSize: 12, color: '#64748b' }}>{currencyLabel}</span></div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {bgMode === 'map' ? (
            <>
              <button type="button" style={pill(!bgNahiya)} onClick={() => { setBgNahiya(null); setBgArea(null); }}>الكل</button>
              {nahiyaList.map(([n, v]) => (
                <button key={n} type="button" style={pill(bgNahiya === n)} onClick={() => { setBgNahiya(bgNahiya === n ? null : n); setBgArea(null); }}>{n} · {fmtVal(v)}</button>
              ))}
            </>
          ) : ([null, 'الكرخ', 'الرصافة'] as (string | null)[]).map(sd => (
            <button key={sd ?? 'all'} type="button" style={pill(bgSide === sd)} onClick={() => { setBgSide(sd); setBgArea(null); }}>
              {sd ?? 'الكل'}{sd ? ` · ${fmtVal(bg.sideTotals.get(sd) ?? 0)}` : ''}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 520, overflowY: 'auto' }}>
          {rows.length === 0 && <div style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد مبيعات هنا في الفترة المختارة.</div>}
          {rows.map(a => {
            const on = bgArea === a.name;
            const tag = bgMode === 'map' ? (a.nahiya ? null : 'بلا موقع') : (a.side ? null : 'بلا قسم');
            return (
              <div key={a.name} onClick={() => setBgArea(on ? null : a.name)}
                style={{ border: `1px solid ${on ? '#1f4fb4' : '#e6ebf2'}`, borderRadius: 10, padding: '6px 9px', background: on ? '#eef3fd' : '#fbfcfe', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 12, color: '#0f172a' }}>{a.name}
                    {tag && <span style={{ fontWeight: 600, fontSize: 10, color: '#94a3b8' }}> · {tag}</span>}
                    {bgMode === 'map' && !bgNahiya && a.nahiya && <span style={{ fontWeight: 600, fontSize: 10, color: '#64748b' }}> · {a.nahiya}</span>}
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 12, color: a.value < 0 ? '#be123c' : '#1f4fb4', direction: 'ltr' }}>{fmtVal(a.value)}</span>
                </div>
                <div style={{ height: 4, borderRadius: 4, background: '#e9eef5', marginTop: 5 }}>
                  <div style={{ height: '100%', width: `${Math.max(2, (Math.abs(a.value) / max) * 100)}%`, background: 'linear-gradient(90deg,#2f66d6,#78a3f5)', borderRadius: 4 }} />
                </div>
              </div>
            );
          })}
        </div>
      </>
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
        <button type="button" onClick={() => { setDirProvince(null); setTeamsOpen(true); }}
          style={{ border: '1px solid #cbd5e1', background: '#0f172a', color: '#fff', borderRadius: 999, padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          👥 فرق المحافظات (التيم ليدر والمندوبون)
        </button>
      </div>
      {teamsOpen && (
        <ProvinceTeamsDirectory initialProvince={dirProvince} token={token} fileIds={fileIds} applyMonth={applyMonth} fmtVal={fmtVal} currencyLabel={currencyLabel} onClose={() => setTeamsOpen(false)} />
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
          <PlexusBackground />
          {bgOpen ? renderBaghdadMap() : (
          <div style={{ position: 'relative', zIndex: 1, width: side ? '82%' : '100%', maxWidth: 820, marginLeft: 0, marginRight: side ? 'auto' : 'auto' }}>
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
                      style={{ cursor: 'pointer', transition: 'fill .25s, opacity .2s' }}
                      opacity={active && !on && !isB ? 0.82 : 1}
                      onMouseEnter={() => !isB && setHover(s.name)} onMouseLeave={() => setHover(null)}
                      onClick={() => isB ? openBaghdad() : pickProvince(s.name)} />
                  );
                })}
              </g>
              {/* دبابيس المحافظات: عدد الشركات + الاسم + المبيع */}
              {IRAQ_PROVINCE_SHAPES.map(s => {
                const k = norm(s.name);
                const [dx, dy] = LABEL_NUDGE[k] ?? [0, 0];
                const x = s.cx + dx, y = s.cy + dy;
                if (k === BAGHDAD) {
                  return (
                    <g key={s.name} style={{ cursor: 'pointer' }} onClick={openBaghdad}>
                      <rect x={x - 40} y={y - 16} width={80} height={32} rx={16} fill="#0f172a" stroke="#fff" strokeWidth={2} />
                      <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 16, fontWeight: 800, fill: '#fff', pointerEvents: 'none' }}>بغداد ‹</text>
                    </g>
                  );
                }
                const c = cells.get(k);
                const n = c?.companies.length ?? 0;
                const on = active && norm(active) === k;
                const dark = !!c && c.total > 0 && Math.sqrt(c.total / maxVal) > 0.55;
                return (
                  <g key={s.name} style={{ cursor: 'pointer' }} onMouseEnter={() => setHover(s.name)} onMouseLeave={() => setHover(null)} onClick={() => pickProvince(s.name)}>
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
          )}

          {/* بطاقة ثابتة أعلى يمين الخريطة: تعرض المحافظة تحت المؤشر، وإلا المختارة */}
          {SHOW_HOVER_CARD && activeCell && (
            <div dir="rtl" style={{
              position: 'absolute', top: 12, right: 12, zIndex: 4, width: 190, maxHeight: '50%', overflowY: 'auto',
              background: 'rgba(15,23,42,.95)', color: '#fff', borderRadius: 12, padding: '8px 10px',
              boxShadow: '0 12px 30px rgba(15,23,42,.28)', fontSize: 11,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontWeight: 800, fontSize: 13, marginBottom: 2 }}>
                <span>{activeCell.name}</span><span style={{ direction: 'ltr', color: '#93c5fd' }}>{fmtVal(activeCell.total)}</span>
              </div>
              <div style={{ color: '#94a3b8', fontSize: 10, marginBottom: 4 }}>{activeCell.companies.length} شركات · {activeCell.companies.reduce((n, x) => n + x.reps.length, 0)} مندوب علمي</div>
              {activeCell.companies.map(co => (
                <div key={co.name} style={{ padding: '3px 0', borderTop: '1px solid rgba(148,163,184,.2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: 700 }}>
                    <span>{co.name}</span><span style={{ direction: 'ltr' }}>{fmtVal(co.value)}</span>
                  </div>
                  {co.reps.map(r => (
                    <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: '#5eead4', fontSize: 10, paddingTop: 1 }}>
                      <span>• {r.name}</span><span style={{ direction: 'ltr' }}>{fmtVal(r.netValue)}</span>
                    </div>
                  ))}
                </div>
              ))}
              {activeCell.companies.length === 0 && <div style={{ color: '#94a3b8' }}>لا شركات بعد</div>}
            </div>
          )}

          {/* مفتاح */}
          {!bgOpen && <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 14, fontSize: 11.5, color: '#64748b', marginTop: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              أقل <span style={{ display: 'inline-flex', borderRadius: 5, overflow: 'hidden' }}>{RAMP.map(c => <span key={c} style={{ width: 16, height: 9, background: c }} />)}</span> أعلى مبيعاً
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 16, height: 16, borderRadius: '50%', background: '#0f172a', color: '#fff', fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>n</span> عدد الشركات
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 16, height: 10, borderRadius: 3, background: 'repeating-linear-gradient(45deg,#f1f5f9 0 3px,#cbd5e1 3px 5px)' }} /> بغداد: اضغطها لعرض مناطقها
            </span>
          </div>}
        </div>

        {/* ── لوحة المحافظة المختارة ── */}
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 18, padding: 11, position: side ? 'sticky' : 'static', top: 12 }}>
          {bgOpen ? renderBaghdadPanel() : activeCell ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 600 }}>المحافظة</div>
                  <div style={{ fontSize: 17, fontWeight: 900, color: '#0f172a', lineHeight: 1.2 }}>{activeCell.name}</div>
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 600 }}>صافي المبيع</div>
                  <div style={{ fontSize: 15, fontWeight: 900, color: activeCell.total < 0 ? '#be123c' : '#1f4fb4' }}>{fmtVal(activeCell.total)} <span style={{ fontSize: 12, color: '#64748b' }}>{currencyLabel}</span></div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, background: '#eef3fd', color: '#1f4fb4', borderRadius: 999, padding: '4px 12px' }}>{activeCell.companies.length} شركات</span>
                <span style={{ fontSize: 12, fontWeight: 700, background: '#f3efff', color: '#6d28d9', borderRadius: 999, padding: '4px 12px' }}>{activeCell.companies.reduce((s, x) => s + x.reps.length, 0)} مندوب علمي</span>
              </div>
              {companyPanel(activeCell)}
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
