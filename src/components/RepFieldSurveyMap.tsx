import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Entry } from '../pages/RepFieldSurveyPage';

// ════════════════════════════════════════════════════════════════════════════
// RepFieldSurveyMap — خريطة سجلات سيرفي المندوب العلمي + ملاحة حيّة
// ────────────────────────────────────────────────────────────────────────────
// تعرض كل نقطة مسجَّلة (طبيب/صيدلية) بلون حسب النوع فقط — ليس حسب المنطقة،
// لأن عدد المناطق قد يتجاوز بسهولة ما يمكن تمييزه بالألوان لعين عمياء الألوان
// (راجع مهارة dataviz: اللون الفئوي يُقاس لا يُخمَّن، وأكثر من 2-3 فئات بلون
// واحد في سياق "كل زوج قد يتجاور" كالخريطة يفشل اختبار التمييز). المنطقة هنا
// تُفهم من موقعها الجغرافي الفعلي + لوحة جانبية بالاسم والعدد، لا من اللون.
// ════════════════════════════════════════════════════════════════════════════

// نفس الحقلين الأولين (slot 1 أزرق / slot 2 برتقالي) من اللوحة الفئوية المعتمدة
// في مهارة dataviz — مُتحقَّق منهما بـ validate_palette.js (كل الفحوص PASS).
const COLOR_DOCTOR = '#2a78d6';
const COLOR_PHARMACY = '#eb6834';
const COLOR_ME = '#1baf7a';
const COLOR_ROUTE = '#1a73e8';
const COLOR_ROUTE_DONE = '#9bb0c9';

const EARTH_M_PER_DEG = 111320;
// تحت هذا التقريب تُرسم النقاط دوائرَ على Canvas واحد (آلاف النقاط بكلفة رسم
// صورة واحدة، والتكبير يحرّك طبقة واحدة لا مئات العناصر)؛ عنده وفوقه — حيث
// النقاط داخل الشاشة قليلة — تُعرض الدبابيس الكاملة برموزها 🩺/💊.
const DETAIL_ZOOM = 15;
// خارج المسار بأكثر من هذا (متر) = المستخدم غيّر الطريق فعلاً، لا مجرّد خطأ GPS
const OFF_ROUTE_M = 45;
const ARRIVE_M = 30;
const REROUTE_COOLDOWN_MS = 8000;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// حدود تأطير منطقة تتجاهل النقاط الشاذّة: سجلّ واحد التُقط موقعه من مكان آخر
// كان يمدّ حدود منطقة صغيرة على بغداد كلها. الشاذّ = أبعد من 4 أضعاف وسيط
// البُعد عن المركز الوسيط (وبحد أدنى 1.5 كم). يؤثر على التأطير فقط لا العرض.
function coreBounds(pts: [number, number][]): L.LatLngBounds {
  if (pts.length < 4) return L.latLngBounds(pts);
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const cLat = median(pts.map(p => p[0]));
  const cLng = median(pts.map(p => p[1]));
  const dist = pts.map(p => haversineMeters(cLat, cLng, p[0], p[1]));
  const limit = Math.max(1500, median(dist) * 4);
  const core = pts.filter((_, i) => dist[i] <= limit);
  return L.latLngBounds(core.length ? core : pts);
}

function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`;
}

function fmtDuration(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} د`;
  return `${Math.floor(min / 60)} س ${min % 60} د`;
}

// أقرب نقطة على المسار المرسوم + بُعدها بالمتر. الإسقاط مستوٍ محلي (كافٍ تماماً
// على مقاييس بضعة كيلومترات) ويُستعمل في: كشف الخروج عن المسار، حساب المتبقّي،
// وتظليل الجزء المقطوع من الطريق.
function nearestOnPath(lat: number, lng: number, path: [number, number][]) {
  const kx = Math.cos((lat * Math.PI) / 180) * EARTH_M_PER_DEG;
  const px = lng * kx;
  const py = lat * EARTH_M_PER_DEG;
  let best = { index: 0, dist: Infinity, point: [lat, lng] as [number, number] };
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][1] * kx, ay = path[i][0] * EARTH_M_PER_DEG;
    const bx = path[i + 1][1] * kx, by = path[i + 1][0] * EARTH_M_PER_DEG;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best.dist) best = { index: i, dist: d, point: [cy / EARTH_M_PER_DEG, cx / kx] };
  }
  return best;
}

// طول ما تبقّى من المسار ابتداءً من نقطة على القطعة رقم idx وحتى untilIndex
function remainingAlongPath(
  path: [number, number][],
  idx: number,
  point: [number, number],
  untilIndex = path.length - 1,
): number {
  if (!path.length) return 0;
  const end = Math.min(untilIndex, path.length - 1);
  if (idx >= end) return haversineMeters(point[0], point[1], path[end][0], path[end][1]);
  let total = haversineMeters(point[0], point[1], path[idx + 1][0], path[idx + 1][1]);
  for (let i = idx + 1; i < end; i++) total += haversineMeters(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
  return total;
}

const MODIFIER_AR: Record<string, string> = {
  'uturn': 'استدر عائداً',
  'sharp right': 'انعطف يميناً بحدّة',
  'right': 'انعطف يميناً',
  'slight right': 'مِل يميناً',
  'straight': 'واصل مستقيماً',
  'slight left': 'مِل يساراً',
  'left': 'انعطف يساراً',
  'sharp left': 'انعطف يساراً بحدّة',
};

const MODIFIER_GLYPH: Record<string, string> = {
  'uturn': '🔄',
  'sharp right': '↪️',
  'right': '➡️',
  'slight right': '↗️',
  'straight': '⬆️',
  'slight left': '↖️',
  'left': '⬅️',
  'sharp left': '↩️',
};

function stepText(s: any): string {
  const road = s?.name ? ` نحو ${s.name}` : '';
  const type = s?.maneuver?.type as string | undefined;
  const mod = s?.maneuver?.modifier as string | undefined;
  const turn = (mod && MODIFIER_AR[mod]) || 'واصل';
  if (type === 'depart') return `انطلق${road}`;
  if (type === 'arrive') return 'وصلت إلى الوجهة';
  if (type === 'roundabout' || type === 'rotary') {
    return `ادخل الدوّار${s?.maneuver?.exit ? ` واخرج عند المخرج ${s.maneuver.exit}` : ''}${road}`;
  }
  if (type === 'merge') return `اندمج ${turn}${road}`;
  if (type === 'on ramp') return `اسلك المدخل${road}`;
  if (type === 'off ramp') return `اسلك المخرج${road}`;
  if (type === 'fork') return `عند التفرّع: ${turn}${road}`;
  if (type === 'end of road') return `في نهاية الطريق: ${turn}${road}`;
  if (type === 'continue') return `${turn}${road}`;
  return `${turn}${road}`;
}

function stepGlyph(s: any): string {
  const type = s?.maneuver?.type as string | undefined;
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '🚗';
  if (type === 'roundabout' || type === 'rotary') return '🔃';
  const mod = s?.maneuver?.modifier as string | undefined;
  return (mod && MODIFIER_GLYPH[mod]) || '⬆️';
}

interface NavStep { text: string; glyph: string; distance: number; atIndex: number }
interface NavRoute { path: [number, number][]; steps: NavStep[]; distanceM: number; durationS: number }
interface NavState extends NavRoute { entryId: number; toName: string; toLat: number; toLng: number }

/**
 * OSRM العام (بلا مفتاح API — نفس نهج بلاطات OpenStreetMap هنا) مع steps=true
 * للحصول على تعليمات الانعطاف خطوة بخطوة لا مجرّد خط على الخريطة.
 */
async function fetchRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<NavRoute> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`
    + '?overview=full&geometries=geojson&steps=true&annotations=false';
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j.code !== 'Ok' || !j.routes?.length) throw new Error('تعذّر حساب الطريق حالياً. حاول مجدداً.');
  const route = j.routes[0];
  const path = (route.geometry.coordinates as [number, number][]).map(c => [c[1], c[0]] as [number, number]);
  const steps: NavStep[] = (route.legs?.[0]?.steps ?? []).map((s: any) => {
    const loc = s?.maneuver?.location as [number, number] | undefined;
    return {
      text: stepText(s),
      glyph: stepGlyph(s),
      distance: Number(s?.distance) || 0,
      atIndex: loc ? nearestOnPath(loc[1], loc[0], path).index : 0,
    };
  });
  return { path, steps, distanceM: Number(route.distance) || 0, durationS: Number(route.duration) || 0 };
}

// صيدلية أُنشئت تلقائياً من "قريب" طبيب (أو العكس) ترث نفس إحداثيات الأصل
// حرفياً (راجع ensureOwnPharmacies في الخادم) — فيقع الدبوسان على نفس
// البكسل بالضبط ويختفي أحدهما خلف الآخر تماماً. التوزيع بإزاحة صغيرة يحلّ ذلك،
// ويُحسب من مجموعة البيانات الكاملة لا من المرئي حالياً، وإلا تغيّر موضع الدبوس
// كلما دخل/خرج جاره من الشاشة. (للعرض فقط — الملاحة والمسافة وروابط الخرائط
// تستعمل إحداثيات السجل الأصلية.)
function offsetLatLng(lat: number, lng: number, index: number, total: number, radiusMeters = 9): [number, number] {
  if (total <= 1) return [lat, lng];
  const angle = (2 * Math.PI * index) / total;
  const dLat = (radiusMeters * Math.sin(angle)) / EARTH_M_PER_DEG;
  const dLng = (radiusMeters * Math.cos(angle)) / (EARTH_M_PER_DEG * Math.cos((lat * Math.PI) / 180) || 1);
  return [lat + dLat, lng + dLng];
}

const gmapsNavUrl = (from: { lat: number; lng: number }, lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${lat},${lng}&travelmode=driving&dir_action=navigate`;
// نفس رابط الملاحة لكن بلا origin — يُستعمل من نافذة أي نقطة مباشرة بلا شرط
// توفّر موقعي الحي (me)؛ يفتح Google Maps محدّداً الوجهة فقط وهو نفسه يعتمد
// موقع الجهاز الحالي كنقطة انطلاق للملاحة.
const gmapsNavUrlAuto = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving&dir_action=navigate`;
const wazeNavUrl = (lat: number, lng: number) => `https://waze.com/ul?ll=${lat}%2C${lng}&navigate=yes`;

// دبوس خريطة كلاسيكي (دائرة + رأس مدبَّب) بلون النوع ورمز داخله — الهوية لا
// تعتمد على اللون وحده، فكل نوع له رمزه الخاص أيضاً.
function pinIcon(color: string, glyph: string, size = 34): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative; width:${size}px; height:${size}px;">
        <div style="position:absolute; inset:0; background:${color}; width:${size * 0.74}px; height:${size * 0.74}px;
          border-radius:50% 50% 50% 0; transform:rotate(-45deg); margin:0 auto;
          box-shadow:0 3px 8px rgba(15,30,53,0.35); border:2px solid #fff;"></div>
        <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          font-size:${size * 0.4}px; line-height:1; transform:translateY(-15%);">${glyph}</div>
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size * 0.92],
    popupAnchor: [0, -size * 0.8],
  });
}

// الأيقونتان ثابتتان دائماً (لون/رمز كل نوع لا يتغيران) — تُبنيان مرة واحدة هنا
// بدل استدعاء pinIcon() من جديد لكل دبوس في حلقة الرسم.
const DOCTOR_ICON = pinIcon(COLOR_DOCTOR, '🩺');
const PHARMACY_ICON = pinIcon(COLOR_PHARMACY, '💊');

function meIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative; width:22px; height:22px;">
        <div class="rfs-map-pulse" style="position:absolute; inset:-10px; border-radius:50%; background:${COLOR_ME}33;"></div>
        <div style="position:absolute; inset:0; border-radius:50%; background:${COLOR_ME};
          border:3px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>
      </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

interface AreaGroup { area: string; doctors: number; pharmacies: number; lat: number; lng: number; }

type BaseStyle = 'standard' | 'formal';
const BASE_STYLE_KEY = 'rfsMapBaseStyle';
function readBaseStyle(): BaseStyle {
  try { return localStorage.getItem(BASE_STYLE_KEY) === 'formal' ? 'formal' : 'standard'; } catch { return 'standard'; }
}

interface Props { entries: Entry[]; onEdit?: (entry: Entry) => void; }

// محتوى النافذة المنبثقة. أزرار "ملاحة"/"تعديل" تحمل data-rfs-nav/data-rfs-edit
// لتُربط بمستمع نقر بعد إدراج النافذة في الصفحة (المحتوى HTML خام، فلا يمكن
// تمرير onClick من React مباشرة). "ص" تُسبق كل اسم صيدلية قريبة من الطبيب —
// حرف دلالة لا كلمة، فلا يُثقل السطر مع تعدد الأسماء.
function buildPopupHtml(e: Entry, me: { lat: number; lng: number } | null): string {
  const dist = me ? haversineMeters(me.lat, me.lng, e.latitude, e.longitude) : null;
  const detailsLine = e.kind === 'doctor'
    ? [e.specialty, e.className, e.nearPharmacies.length ? e.nearPharmacies.map(p => `ص ${p}`).join('، ') : ''].filter(Boolean).join(' · ')
    : e.notes ?? '';
  return `
    <div style="min-width:210px; font-family:inherit; direction:rtl; text-align:right;">
      <div style="font-weight:700; font-size:14px; margin-bottom:2px;">${e.kind === 'doctor' ? '🩺' : '💊'} ${escapeHtml(e.name)}</div>
      <div style="color:#5a6a8a; font-size:12.5px; margin-bottom:4px;">${escapeHtml(e.areaName)}${e.repName ? ' · ' + escapeHtml(e.repName) : ''}</div>
      ${detailsLine ? `<div style="font-size:12.5px; color:#1a2332; margin-bottom:4px;">${escapeHtml(detailsLine)}</div>` : ''}
      ${dist != null ? `<div style="font-size:12.5px; font-weight:700; color:${COLOR_ME}; margin-bottom:4px;">📍 يبعد عنك ${fmtDistance(dist)}</div>` : ''}
      <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
        <button type="button" data-rfs-nav="1" style="font-size:12.5px; font-weight:700; color:#fff; background:${COLOR_ROUTE}; border:0; border-radius:6px; padding:5px 11px; cursor:pointer;">🧭 ابدأ الملاحة (داخل الخريطة)</button>
        ${e.canEdit ? `<button type="button" data-rfs-edit="1" style="font-size:12.5px; font-weight:700; color:${COLOR_ROUTE}; background:#fff; border:1px solid ${COLOR_ROUTE}; border-radius:6px; padding:4px 11px; cursor:pointer;">✎ تعديل</button>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px; margin-top:6px; flex-wrap:wrap;">
        <a href="${wazeNavUrl(e.latitude, e.longitude)}" target="_blank" rel="noreferrer" style="display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:700; color:#fff; background:#05c8f7; border-radius:6px; padding:4px 10px; text-decoration:none;">Waze ↗</a>
        <a href="${gmapsNavUrlAuto(e.latitude, e.longitude)}" target="_blank" rel="noreferrer" style="display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:700; color:${COLOR_ROUTE}; background:#fff; border:1px solid ${COLOR_ROUTE}; border-radius:6px; padding:3px 10px; text-decoration:none;">Google Maps ↗</a>
      </div>
    </div>`;
}

export default function RepFieldSurveyMap({ entries, onEdit }: Props) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<number, L.Marker>>(new Map());
  const meMarkerRef = useRef<L.Marker | null>(null);
  const meCircleRef = useRef<L.Circle | null>(null);
  const routeLayerRef = useRef<L.Polyline | null>(null);
  const routeDoneRef = useRef<L.Polyline | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const kindBtnsRef = useRef<{ doctorBtn: HTMLElement; pharmacyBtn: HTMLElement } | null>(null);
  const dotLayerRef = useRef<L.LayerGroup | null>(null);
  const dotRendererRef = useRef<L.Canvas | null>(null);
  const tileLayersRef = useRef<Record<BaseStyle, L.Layer> | null>(null);
  const [baseStyle, setBaseStyle] = useState<BaseStyle>(readBaseStyle);

  const [me, setMe] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [geoError, setGeoError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  // أول تثبيت لموقعي فقط يُدخَل في حساب الحدود الابتدائية — التحديثات اللاحقة
  // لموقعي الحي لا يجب أن "تسحب" الخريطة بعيداً عن تصفّح المستخدم (إلا في وضع
  // الملاحة، حيث المتابعة مقصودة وتتوقف فور سحب المستخدم للخريطة يدوياً).
  const meFittedOnceRef = useRef(false);
  const meRef = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);

  // فلتر سريع من داخل الخريطة نفسها (زرّا 🩺/💊 قرب أزرار التكبير)
  const [mapKind, setMapKind] = useState<'all' | 'doctor' | 'pharmacy'>('all');
  // فلتر منطقة من قائمة السهم المنسدلة — منطقة واحدة أو الكل (null)
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const [areaMenuOpen, setAreaMenuOpen] = useState(false);
  const areaMenuRef = useRef<HTMLDivElement | null>(null);

  // بلا فلتر المنطقة نفسه — تُستعمل لتعبئة قائمة السهم المنسدلة فتبقى كل
  // المناطق قابلة للاختيار دوماً، حتى بعد تضييق العرض على منطقة واحدة.
  const locatedByKind = useMemo(
    () => entries.filter(e => Number.isFinite(e.latitude) && Number.isFinite(e.longitude) && (mapKind === 'all' || e.kind === mapKind)),
    [entries, mapKind],
  );
  const located = useMemo(
    () => (areaFilter ? locatedByKind.filter(e => e.areaName.trim() === areaFilter) : locatedByKind),
    [locatedByKind, areaFilter],
  );
  const locatedRef = useRef<Entry[]>(located);
  locatedRef.current = located;

  const allAreaGroups = useMemo<AreaGroup[]>(() => {
    const map = new Map<string, AreaGroup & { sumLat: number; sumLng: number; n: number }>();
    for (const e of locatedByKind) {
      const key = e.areaName.trim();
      const g = map.get(key) ?? { area: key, doctors: 0, pharmacies: 0, lat: 0, lng: 0, sumLat: 0, sumLng: 0, n: 0 };
      if (e.kind === 'doctor') g.doctors++; else g.pharmacies++;
      g.sumLat += e.latitude; g.sumLng += e.longitude; g.n++;
      map.set(key, g);
    }
    return [...map.values()]
      .map(g => ({ area: g.area, doctors: g.doctors, pharmacies: g.pharmacies, lat: g.sumLat / g.n, lng: g.sumLng / g.n }))
      .sort((a, b) => a.area.localeCompare(b.area, 'ar'));
  }, [locatedByKind]);

  // تصفير فلتر المنطقة تلقائياً لو اختفت المنطقة المختارة من البيانات (تغيّر
  // ملف/فلتر آخر) حتى لا تبقى الخريطة فارغة بصمت بمنطقة لم تعد موجودة.
  useEffect(() => {
    if (areaFilter && !allAreaGroups.some(g => g.area === areaFilter)) setAreaFilter(null);
  }, [areaFilter, allAreaGroups]);

  // إغلاق قائمة المناطق عند الضغط خارجها
  useEffect(() => {
    if (!areaMenuOpen) return;
    const onDocClick = (ev: MouseEvent) => {
      if (areaMenuRef.current && !areaMenuRef.current.contains(ev.target as Node)) setAreaMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [areaMenuOpen]);

  // مواضع العرض (مع إزاحة المتطابقات) — تُحسب من كامل البيانات مرة واحدة فتبقى
  // ثابتة مهما تحرّكت الشاشة.
  const displayPos = useMemo(() => {
    const groups = new Map<string, Entry[]>();
    for (const e of located) {
      const key = `${e.latitude.toFixed(6)},${e.longitude.toFixed(6)}`;
      const g = groups.get(key);
      if (g) g.push(e); else groups.set(key, [e]);
    }
    const pos = new Map<number, [number, number]>();
    for (const group of groups.values()) {
      group.forEach((e, i) => pos.set(e.id, offsetLatLng(e.latitude, e.longitude, i, group.length)));
    }
    return pos;
  }, [located]);
  const displayPosRef = useRef(displayPos);
  displayPosRef.current = displayPos;

  const areaGroups = useMemo<AreaGroup[]>(() => {
    const map = new Map<string, AreaGroup & { sumLat: number; sumLng: number; n: number }>();
    for (const e of located) {
      const key = e.areaName.trim();
      const g = map.get(key) ?? { area: key, doctors: 0, pharmacies: 0, lat: 0, lng: 0, sumLat: 0, sumLng: 0, n: 0 };
      if (e.kind === 'doctor') g.doctors++; else g.pharmacies++;
      g.sumLat += e.latitude; g.sumLng += e.longitude; g.n++;
      map.set(key, g);
    }
    return [...map.values()]
      .map(g => ({ area: g.area, doctors: g.doctors, pharmacies: g.pharmacies, lat: g.sumLat / g.n, lng: g.sumLng / g.n }))
      .sort((a, b) => (b.doctors + b.pharmacies) - (a.doctors + a.pharmacies));
  }, [located]);

  // ── حالة الملاحة ─────────────────────────────────────────────────────────
  const [nav, setNav] = useState<NavState | null>(null);
  const navRef = useRef<NavState | null>(null);
  navRef.current = nav;
  const [navProgress, setNavProgress] = useState<{
    remainingM: number; remainingS: number; stepText: string; stepGlyph: string;
    stepDistM: number; offRoute: boolean; arrived: boolean;
  } | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState('');
  const [rerouted, setRerouted] = useState(false);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const lastRerouteRef = useRef(0);
  const offRouteCountRef = useRef(0);

  const renderRouteLines = (path: [number, number][], near: { index: number; point: [number, number] } | null) => {
    const map = mapRef.current;
    if (!map || path.length < 2) return;
    const remaining = near ? [near.point, ...path.slice(near.index + 1)] : path;
    if (routeLayerRef.current) routeLayerRef.current.setLatLngs(remaining);
    else routeLayerRef.current = L.polyline(remaining, { color: COLOR_ROUTE, weight: 6, opacity: 0.9, lineJoin: 'round' }).addTo(map);

    const done = near ? [...path.slice(0, near.index + 1), near.point] : [];
    if (done.length > 1) {
      if (routeDoneRef.current) routeDoneRef.current.setLatLngs(done);
      else routeDoneRef.current = L.polyline(done, { color: COLOR_ROUTE_DONE, weight: 5, opacity: 0.65 }).addTo(map);
    } else if (routeDoneRef.current) {
      routeDoneRef.current.remove();
      routeDoneRef.current = null;
    }
  };

  const updateProgress = (pos: { lat: number; lng: number }) => {
    const n = navRef.current;
    if (!n || n.path.length < 2) return;
    const near = nearestOnPath(pos.lat, pos.lng, n.path);
    renderRouteLines(n.path, near);
    const remainingM = remainingAlongPath(n.path, near.index, near.point);
    const ratio = n.distanceM > 0 ? Math.min(1, remainingM / n.distanceM) : 0;
    const step = n.steps.find(s => s.atIndex > near.index) ?? n.steps[n.steps.length - 1] ?? null;
    setNavProgress({
      remainingM,
      remainingS: n.durationS * ratio,
      stepText: step?.text ?? '',
      stepGlyph: step?.glyph ?? '',
      stepDistM: step ? remainingAlongPath(n.path, near.index, near.point, step.atIndex) : 0,
      offRoute: near.dist > OFF_ROUTE_M,
      arrived: haversineMeters(pos.lat, pos.lng, n.toLat, n.toLng) <= ARRIVE_M,
    });
  };

  const startNav = async (e: Entry) => {
    const start = meRef.current;
    if (!start) {
      setNavError('فعّل تحديد موقعك الحالي أولاً (زر «اذهب إلى موقعي») لبدء الملاحة.');
      return;
    }
    setNavError('');
    setNavLoading(true);
    try {
      const r = await fetchRoute(start, { lat: e.latitude, lng: e.longitude });
      const state: NavState = { ...r, entryId: e.id, toName: e.name, toLat: e.latitude, toLng: e.longitude };
      navRef.current = state;
      setNav(state);
      renderRouteLines(r.path, null);
      const map = mapRef.current;
      if (map) {
        if (destMarkerRef.current) destMarkerRef.current.remove();
        destMarkerRef.current = L.marker([e.latitude, e.longitude], {
          icon: L.divIcon({ className: '', html: '<div style="font-size:26px; line-height:1;">🏁</div>', iconSize: [26, 26], iconAnchor: [13, 24] }),
          zIndexOffset: 900,
        }).addTo(map);
        map.closePopup();
        map.setView([start.lat, start.lng], Math.max(map.getZoom(), 16));
      }
      setFollow(true);
      offRouteCountRef.current = 0;
      lastRerouteRef.current = Date.now();
      updateProgress(start);
      startWatch(); // تردد أعلى أثناء الملاحة
    } catch (err: any) {
      setNavError(err?.message || 'تعذّر حساب الطريق حالياً. تحقّق من الاتصال وحاول مجدداً.');
    } finally {
      setNavLoading(false);
    }
  };

  // إعادة حساب المسار من الموقع الحالي — تُستدعى تلقائياً عند الخروج عن الطريق
  // المرسوم، وأيضاً يدوياً من زر في لوحة الملاحة.
  const recalcRoute = async () => {
    const n = navRef.current;
    const start = meRef.current;
    if (!n || !start) return;
    try {
      const r = await fetchRoute(start, { lat: n.toLat, lng: n.toLng });
      const next: NavState = { ...n, ...r };
      navRef.current = next;
      setNav(next);
      renderRouteLines(r.path, null);
      updateProgress(start);
      setRerouted(true);
      window.setTimeout(() => setRerouted(false), 4000);
    } catch {
      // نُبقي المسار السابق معروضاً بدل إفراغ الشاشة عند فشل مؤقت في الشبكة
    }
  };

  const stopNav = () => {
    navRef.current = null;
    setNav(null);
    setNavProgress(null);
    setNavError('');
    if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null; }
    if (routeDoneRef.current) { routeDoneRef.current.remove(); routeDoneRef.current = null; }
    if (destMarkerRef.current) { destMarkerRef.current.remove(); destMarkerRef.current = null; }
    startWatch(); // رجوع لتردد الموقع الاعتيادي
  };

  // ── مزامنة الدبابيس: إضافة/إزالة فقط، بلا هدم وإعادة بناء ────────────────
  // السبب: layer.clearLayers() عند كل moveend كان يحذف الدبوس الذي فُتحت نافذته
  // للتو — وفتح أي نافذة يُحرّك الخريطة قليلاً (autoPan) فيُطلق moveend — فكانت
  // التفاصيل تومض وتختفي إلا إذا كان التقريب كبيراً بما يكفي ليتسع للنافذة بلا
  // تحريك. المزامنة التفاضلية تُبقي الدبوس المفتوح (وكل الدبابيس القائمة) حياً،
  // وهي أخف أيضاً لأنها لا تُنشئ مئات العناصر من جديد مع كل حركة.
  // المحتوى دالة تُقيَّم عند الفتح فقط: لا يُبنى HTML النافذة لآلاف النقاط مسبقاً،
  // والمسافة "يبعد عنك" تُحسب من موقعي الحالي لحظة الفتح.
  const bindEntryPopup = (layer: L.Marker | L.CircleMarker, e: Entry) => {
    layer.bindPopup(() => buildPopupHtml(e, meRef.current), { autoPan: true, autoPanPadding: [40, 40] });
    layer.on('popupopen', () => {
      const popupEl = layer.getPopup()?.getElement();
      const navBtn = popupEl?.querySelector('[data-rfs-nav]') as HTMLButtonElement | null;
      if (navBtn) navBtn.onclick = ev => { ev.preventDefault(); startNav(e); };
      const editBtn = popupEl?.querySelector('[data-rfs-edit]') as HTMLButtonElement | null;
      if (editBtn) editBtn.onclick = ev => { ev.preventDefault(); onEdit?.(e); };
    });
  };

  const rebuildDots = () => {
    const dots = dotLayerRef.current;
    const renderer = dotRendererRef.current;
    if (!dots || !renderer) return;
    dots.clearLayers();
    const pos = displayPosRef.current;
    for (const e of locatedRef.current) {
      const p = pos.get(e.id) ?? ([e.latitude, e.longitude] as [number, number]);
      const dot = L.circleMarker(p, {
        renderer,
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: e.kind === 'doctor' ? COLOR_DOCTOR : COLOR_PHARMACY,
        fillOpacity: 1,
      });
      bindEntryPopup(dot, e);
      dots.addLayer(dot);
    }
  };

  function syncMarkersImpl(rebuild = false) {
    const map = mapRef.current;
    const layer = layerRef.current;
    const dots = dotLayerRef.current;
    if (!map || !layer || !dots) return;
    if (rebuild) {
      layer.clearLayers();
      markersRef.current.clear();
      rebuildDots();
    }
    if (map.getZoom() < DETAIL_ZOOM) {
      if (!map.hasLayer(dots)) dots.addTo(map);
      if (markersRef.current.size) {
        layer.clearLayers();
        markersRef.current.clear();
      }
      return;
    }
    if (map.hasLayer(dots)) dots.remove();
    const pos = displayPosRef.current;
    const list = locatedRef.current;
    const view = map.getBounds().pad(0.5);

    const want = new Map<number, Entry>();
    for (const e of list) {
      const p = pos.get(e.id) ?? ([e.latitude, e.longitude] as [number, number]);
      if (view.contains(p)) want.set(e.id, e);
    }

    for (const [id, marker] of markersRef.current) {
      if (want.has(id) || marker.isPopupOpen()) continue;
      layer.removeLayer(marker);
      markersRef.current.delete(id);
    }

    for (const [id, e] of want) {
      if (markersRef.current.has(id)) continue;
      const p = pos.get(id) ?? ([e.latitude, e.longitude] as [number, number]);
      const marker = L.marker(p, { icon: e.kind === 'doctor' ? DOCTOR_ICON : PHARMACY_ICON, riseOnHover: true }).addTo(layer);
      bindEntryPopup(marker, e);
      markersRef.current.set(id, marker);
    }
  }
  const syncMarkersRef = useRef(syncMarkersImpl);
  syncMarkersRef.current = syncMarkersImpl;

  // ── إنشاء الخريطة مرة واحدة ──────────────────────────────────────────────
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    // fadeAnimation معطّل عمداً: تلاشي البلاطات عند كل سحب/تكبير هو ما يُشعر
    // بالتقطّع على هواتف متوسطة الأداء؛ تعطيله يجعل التنقل يبدو فورياً وأخف.
    const map = L.map(mapDivRef.current, {
      zoomControl: true,
      attributionControl: true,
      fadeAnimation: false,
      markerZoomAnimation: true,
      wheelPxPerZoomLevel: 90,
      inertia: true,
    });
    map.setView([33.3152, 44.3661], 11); // بغداد افتراضياً حتى تُحسب الحدود
    // خرائط OpenStreetMap القياسية — مجانية بالكامل بلا مفتاح API (نفس مزوّد
    // RepTrackingMap.tsx في هذا المشروع). خلفية CARTO الملوّنة أُزيلت لأن CARTO
    // أوقفت السماح المجاني بخلفيتها الرصدية بلا مفتاح API.
    // keepBuffer أكبر + updateWhenZooming معطّل: بلاطات الجوار تبقى محمَّلة
    // سلفاً فلا تُرى مربعات فارغة أثناء السحب السريع.
    // «رسمي»: Esri Light Gray Canvas — رمادي هادئ بلا ألوان ولا كتابات، يعمل
    // بلا مفتاح API (تُحقِّق منه 2026-10-09؛ بديل CARTO Positron صار يُرجع
    // بلاطة "API KEY REQUIRED"). بلاطاته الأصلية حتى تقريب 16 وتُكبَّر بعدها.
    const tiles = {
      standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        keepBuffer: 6,
        updateWhenZooming: false,
      }),
      formal: L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
          className: 'rfs-tiles-formal',
          maxNativeZoom: 16,
          maxZoom: 19,
          keepBuffer: 6,
          updateWhenZooming: false,
        }),
        // طبقة الطرق الشفافة من Esri (مصنَّفة: الطرق السريعة أعرض) — تُحوَّل
        // رمادية بالـCSS فتبرز الطرق السريعة والجسور خطوطاً داكنة، والشوارع
        // الفرعية تذوب في شوارع الأساس البيضاء. تحمل أسماء الطرق الرئيسية.
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
          className: 'rfs-tiles-formal-roads',
          maxZoom: 19,
          keepBuffer: 6,
          updateWhenZooming: false,
          zIndex: 2,
        }),
      ]),
    };
    tiles[baseStyle].addTo(map);
    tileLayersRef.current = tiles;
    layerRef.current = L.layerGroup().addTo(map);
    // tolerance: يوسّع مساحة اللمس حول كل دائرة صغيرة — النقر بالإصبع على الهاتف
    dotRendererRef.current = L.canvas({ padding: 0.5, tolerance: 8 });
    dotLayerRef.current = L.layerGroup();

    // زرّا فلترة سريعة (🩺 أطباء / 💊 صيدليات) قرب أزرار التكبير/التصغير
    const KindControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar rfs-map-kind-control');
        const doctorBtn = L.DomUtil.create('a', 'rfs-map-kind-btn', box);
        doctorBtn.href = '#';
        doctorBtn.title = 'عرض الأطباء فقط';
        doctorBtn.innerHTML = '🩺';
        const pharmacyBtn = L.DomUtil.create('a', 'rfs-map-kind-btn', box);
        pharmacyBtn.href = '#';
        pharmacyBtn.title = 'عرض الصيدليات فقط';
        pharmacyBtn.innerHTML = '💊';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(doctorBtn, 'click', (ev: Event) => { L.DomEvent.preventDefault(ev); setMapKind(k => (k === 'doctor' ? 'all' : 'doctor')); });
        L.DomEvent.on(pharmacyBtn, 'click', (ev: Event) => { L.DomEvent.preventDefault(ev); setMapKind(k => (k === 'pharmacy' ? 'all' : 'pharmacy')); });
        kindBtnsRef.current = { doctorBtn, pharmacyBtn };
        return box;
      },
    });
    new KindControl().addTo(map);

    // moveend وحده يكفي: كل تكبير يُطلق moveend أيضاً، و'zoomend' معه كان يضاعف المزامنة
    const onMoveEnd = () => syncMarkersRef.current();
    map.on('moveend', onMoveEnd);
    // سحب المستخدم يدوياً أثناء الملاحة يوقف المتابعة التلقائية — فلا تتصارع
    // الخريطة معه، ويظهر زر لاستئنافها متى شاء.
    const onDragStart = () => { if (navRef.current) setFollow(false); };
    map.on('dragstart', onDragStart);

    mapRef.current = map;
    return () => {
      map.off('moveend', onMoveEnd);
      map.off('dragstart', onDragStart);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      dotLayerRef.current = null;
      dotRendererRef.current = null;
      tileLayersRef.current = null;
      markersRef.current.clear();
      meMarkerRef.current = null;
      meCircleRef.current = null;
      routeLayerRef.current = null;
      routeDoneRef.current = null;
      destMarkerRef.current = null;
      kindBtnsRef.current = null;
    };
  }, []);

  // ── تبديل شكل الخريطة (عادي ملوّن ↔ رسمي رمادي) + حفظ الاختيار على الجهاز ──
  useEffect(() => {
    const map = mapRef.current;
    const tiles = tileLayersRef.current;
    if (!map || !tiles) return;
    const on = tiles[baseStyle];
    const off = tiles[baseStyle === 'formal' ? 'standard' : 'formal'];
    if (!map.hasLayer(on)) on.addTo(map);
    if (map.hasLayer(off)) off.remove();
    try { localStorage.setItem(BASE_STYLE_KEY, baseStyle); } catch { /* تخزين غير متاح — يبقى للجلسة فقط */ }
  }, [baseStyle]);

  // ── تفعيل زرّي الفلترة السريعة بصرياً حسب mapKind ─────────────────────────
  useEffect(() => {
    const btns = kindBtnsRef.current;
    if (!btns) return;
    btns.doctorBtn.classList.toggle('rfs-map-kind-btn--active', mapKind === 'doctor');
    btns.pharmacyBtn.classList.toggle('rfs-map-kind-btn--active', mapKind === 'pharmacy');
  }, [mapKind]);

  // ── ضبط حدود العرض عند تغيّر بيانات السجلات (أو الفلتر) ──────────────────
  // لا يعتمد على `me` حتى لا يتكرر مع كل نبضة GPS ويسحب الخريطة أثناء التصفّح.
  // أثناء الملاحة لا تُعاد المواءمة إطلاقاً حتى لا تقفز الشاشة بعيداً عن الطريق.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (located.length && !navRef.current) {
      const pts = located.map(e => [e.latitude, e.longitude] as [number, number]);
      if (areaFilter) {
        // منطقة مختارة: تأطير نقاطها وحدها — بلا موقعي (لو كنت بعيداً عنها
        // كان يوسّع الإطار لبغداد كلها) وبلا النقاط الشاذّة
        map.fitBounds(coreBounds(pts), { padding: [40, 40], maxZoom: 16 });
      } else {
        const bounds = L.latLngBounds(pts);
        if (meRef.current) bounds.extend([meRef.current.lat, meRef.current.lng]);
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
      }
    }
    syncMarkersRef.current(true); // إعادة بناء كاملة: البيانات نفسها تغيّرت
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [located]);

  // ── أول تثبيت لموقعي فقط يُعيد ضبط الحدود لتشمله ─────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !me || meFittedOnceRef.current || navRef.current) return;
    meFittedOnceRef.current = true;
    if (areaFilter) return; // لا نسحب الإطار بعيداً عن المنطقة المختارة
    if (located.length) {
      const bounds = L.latLngBounds(located.map(e => [e.latitude, e.longitude] as [number, number]));
      bounds.extend([me.lat, me.lng]);
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    } else {
      map.setView([me.lat, me.lng], 14);
    }
    syncMarkersRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // ── الملاحة الحيّة: تقدّم على المسار + متابعة + تصحيح تلقائي عند تغيير الطريق
  useEffect(() => {
    const n = navRef.current;
    const map = mapRef.current;
    if (!n || !me || !map) return;
    updateProgress(me);
    // متابعة بالتحريك فقط (panTo) لا setView بمستوى تكبير ثابت: لو غيّر المستخدم
    // التكبير أثناء الملاحة يبقى على اختياره ولا تُعيده كل نبضة GPS قسراً.
    if (followRef.current) map.panTo([me.lat, me.lng], { animate: true, duration: 0.6 });
    const near = nearestOnPath(me.lat, me.lng, n.path);
    if (near.dist > OFF_ROUTE_M) {
      offRouteCountRef.current += 1;
      // قراءتان متتاليتان خارج المسار (لا واحدة) حتى لا يُعاد الحساب لمجرد قفزة
      // GPS عابرة، مع فترة تهدئة بين كل إعادة حساب وأخرى.
      if (offRouteCountRef.current >= 2 && Date.now() - lastRerouteRef.current > REROUTE_COOLDOWN_MS) {
        lastRerouteRef.current = Date.now();
        offRouteCountRef.current = 0;
        recalcRoute();
      }
    } else {
      offRouteCountRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // ── موقعي الحالي: تتبّع مستمر + دائرة الدقة ──────────────────────────────
  // دالة قابلة لإعادة الاستدعاء من زر صريح بنقرة المستخدم: المتصفحات تتعامل
  // مع طلب موقع ناتج عن نقرة فعلية بثقة أكبر من طلب تلقائي عند فتح الصفحة.
  // أثناء الملاحة نطلب قراءات أحدث (maximumAge منخفض) ليكون التتبّع سلساً.
  const startWatch = () => {
    if (!navigator.geolocation) { setGeoError('المتصفح لا يدعم تحديد الموقع.'); return; }
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = navigator.geolocation.watchPosition(
      p => { setMe({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); setGeoError(''); },
      err => {
        if (err.code === 1) setGeoError('لم يُسمح بالوصول لموقعك. فعّله من أيقونة القفل/الموقع بجانب عنوان الصفحة، ثم اضغط «إعادة المحاولة».');
        else if (err.code === 3) setGeoError('انتهت مهلة تحديد الموقع. تأكد من تفعيل GPS وحاول مجدداً.');
        else setGeoError('تعذّر تحديد موقعك الحالي. حاول مجدداً.');
      },
      { enableHighAccuracy: true, maximumAge: navRef.current ? 1000 : 10000, timeout: 20000 },
    );
  };

  useEffect(() => {
    startWatch();
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !me) return;
    if (!meMarkerRef.current) {
      meMarkerRef.current = L.marker([me.lat, me.lng], { icon: meIcon(), zIndexOffset: 1000 }).bindPopup('أنت هنا').addTo(map);
    } else {
      meMarkerRef.current.setLatLng([me.lat, me.lng]);
    }
    if (!meCircleRef.current) {
      meCircleRef.current = L.circle([me.lat, me.lng], { radius: me.accuracy, color: COLOR_ME, weight: 1, fillOpacity: 0.08 }).addTo(map);
    } else {
      meCircleRef.current.setLatLng([me.lat, me.lng]).setRadius(me.accuracy);
    }
  }, [me]);

  const flyToArea = (g: AreaGroup) => {
    const map = mapRef.current;
    if (!map) return;
    const pts = locatedByKind.filter(e => e.areaName.trim() === g.area).map(e => [e.latitude, e.longitude] as [number, number]);
    if (pts.length > 1) map.fitBounds(coreBounds(pts), { padding: [48, 48], maxZoom: 16 });
    else map.setView([g.lat, g.lng], 16);
  };

  const recenterOnMe = () => {
    if (me && mapRef.current) mapRef.current.setView([me.lat, me.lng], 16);
  };

  const goToMyLocation = () => { if (me) recenterOnMe(); else startWatch(); };

  const selectAreaFilter = (area: string | null) => {
    setAreaFilter(area);
    setAreaMenuOpen(false);
  };

  // ── وضع ملء الشاشة: يحوّل حاوية الخريطة لتغطية الشاشة كاملة (كبرنامج ملاحة
  // مستقل). Leaflet يحسب أبعاد اللوحة عند الإنشاء فقط، فيجب استدعاء
  // invalidateSize() بعد تغيّر أبعاد الحاوية فعلياً في الـDOM (بعد إطار واحد
  // على الأقل)، وإلا تبقى المناطق الجديدة من الخريطة فارغة حتى أول سحب/تكبير.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize(), 80);
    return () => window.clearTimeout(t);
  }, [fullscreen, panelOpen]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('rfs-map-fullscreen-lock');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('rfs-map-fullscreen-lock');
    };
  }, [fullscreen]);

  const totalDoctors = located.filter(e => e.kind === 'doctor').length;
  const totalPharmacies = located.filter(e => e.kind === 'pharmacy').length;

  return (
    <div className={`rfs-map-shell ${fullscreen ? 'rfs-map-shell--fullscreen' : ''}`}>
      <div className={`rfs-map-panel ${panelOpen ? '' : 'rfs-map-panel--collapsed'}`}>
        <button className="rfs-map-panel-toggle" onClick={() => setPanelOpen(v => !v)}>
          {panelOpen ? '‹ طيّ' : 'المناطق ›'}
        </button>
        {panelOpen && (
          <div className="rfs-map-panel-body">
            <div className="rfs-map-legend">
              <span><i style={{ background: COLOR_DOCTOR }} /> {totalDoctors} طبيب</span>
              <span><i style={{ background: COLOR_PHARMACY }} /> {totalPharmacies} صيدلية</span>
            </div>
            {mapKind !== 'all' && (
              <div className="rfs-muted">
                عرض {mapKind === 'doctor' ? 'الأطباء' : 'الصيدليات'} فقط (من أزرار الخريطة) ·{' '}
                <button className="rfs-map-link-btn" onClick={() => setMapKind('all')}>عرض الكل</button>
              </div>
            )}
            {areaFilter && (
              <div className="rfs-muted">
                تصفية بمنطقة «{areaFilter}» (من ▾ أعلى الخريطة) ·{' '}
                <button className="rfs-map-link-btn" onClick={() => setAreaFilter(null)}>عرض كل المناطق</button>
              </div>
            )}

            {/* ── لوحة الملاحة ── */}
            {navLoading && <div className="rfs-map-route-info">جارٍ حساب الطريق…</div>}
            {navError && <div className="rfs-map-geo-error"><div>{navError}</div></div>}
            {nav && navProgress && (
              <div className="rfs-nav-card">
                <div className="rfs-nav-step">
                  <span className="rfs-nav-glyph">{navProgress.arrived ? '🏁' : navProgress.stepGlyph}</span>
                  <span>
                    <strong>{navProgress.arrived ? `وصلت إلى «${nav.toName}»` : navProgress.stepText}</strong>
                    {!navProgress.arrived && navProgress.stepDistM > 0 && (
                      <div className="rfs-muted">بعد {fmtDistance(navProgress.stepDistM)}</div>
                    )}
                  </span>
                </div>
                <div className="rfs-nav-meta">
                  <span>🏁 {nav.toName}</span>
                  <span>{fmtDistance(navProgress.remainingM)} · {fmtDuration(navProgress.remainingS)}</span>
                </div>
                {navProgress.offRoute && <div className="rfs-nav-warn">خارج المسار — يُعاد حساب الطريق تلقائياً…</div>}
                {rerouted && <div className="rfs-nav-ok">تم تصحيح المسار حسب طريقك الجديد.</div>}
                <div className="rfs-nav-actions">
                  {!follow && <button className="rfs-map-me-btn" onClick={() => setFollow(true)}>🎯 استئناف المتابعة</button>}
                  <button className="rfs-map-retry-btn" onClick={recalcRoute}>🔄 إعادة حساب المسار</button>
                  <button className="rfs-map-retry-btn" onClick={stopNav}>✕ إيقاف الملاحة</button>
                </div>
                {me && (
                  <div className="rfs-nav-external">
                    للملاحة الصوتية خطوة بخطوة:{' '}
                    <a href={gmapsNavUrl(me, nav.toLat, nav.toLng)} target="_blank" rel="noreferrer">Google Maps ↗</a>
                    {' · '}
                    <a href={wazeNavUrl(nav.toLat, nav.toLng)} target="_blank" rel="noreferrer">Waze ↗</a>
                  </div>
                )}
              </div>
            )}

            {geoError && (
              <div className="rfs-map-geo-error">
                <div>{geoError}</div>
                <button className="rfs-map-retry-btn" onClick={startWatch}>🔄 إعادة المحاولة</button>
              </div>
            )}
            {me && !nav && (
              <button className="rfs-map-me-btn" onClick={recenterOnMe}>
                📍 اذهب إلى موقعي (دقة ±{Math.round(me.accuracy)} م)
              </button>
            )}
            <div className="rfs-map-area-title">المناطق ({areaGroups.length})</div>
            <div className="rfs-map-area-list">
              {areaGroups.map(g => (
                <button key={g.area} className="rfs-map-area-row" onClick={() => flyToArea(g)}>
                  <span className="rfs-map-area-name">{g.area}</span>
                  <span className="rfs-map-area-counts">
                    {g.doctors > 0 && <span className="rfs-map-count rfs-map-count--doctor">{g.doctors}</span>}
                    {g.pharmacies > 0 && <span className="rfs-map-count rfs-map-count--pharmacy">{g.pharmacies}</span>}
                  </span>
                </button>
              ))}
              {areaGroups.length === 0 && <div className="rfs-muted" style={{ padding: 8 }}>لا توجد نقاط لعرضها.</div>}
            </div>
          </div>
        )}
      </div>
      <div className="rfs-map-canvas-wrap">
        <div className="rfs-map-canvas" ref={mapDivRef} />
        {/* زر وحيد بالزاوية اليمنى العلوية الفعلية للخريطة (right الفيزيائي لا
            inset-inline-end) — عكس زاوية أزرار Leaflet الأصلية (تكبير/تصغير +
            فلترة 🩺/💊) التي تلتصق دوماً بزاوية الخريطة اليسرى الفعلية بصرف النظر
            عن اتجاه الصفحة RTL، فلا تداخل مع تلك المجموعة. خياري Waze/Google Maps
            انتقلا إلى داخل نافذة كل نقطة نفسها (buildPopupHtml) بدل هنا: الفكرة
            أن يفتحا فور الضغط على اسم الطبيب/الصيدلية وعرض تفاصيله، لا أن يبقيا
            معطّلين بانتظار بدء الملاحة الداخلية أولاً — وهذا أيضاً يمنع تراكبهما
            بصرياً مع صندوق النافذة المنبثقة نفسه. */}
        <div className="rfs-map-toolbar">
          {/* زر التكبير وسهم فلترة المناطق مُجمَّعان بصرياً (فجوة أصغر بينهما)
              فيبدوان عنصراً واحداً ذا سهم ثانوي أسفله، والقائمة المنسدلة تفتح
              من أسفل هذا السهم تحديداً. */}
          <div className="rfs-map-tool-group" ref={areaMenuRef}>
            <button
              type="button"
              className="rfs-map-tool-btn"
              onClick={() => setFullscreen(v => {
                const next = !v;
                if (next) setPanelOpen(false); // أقصى مساحة للخريطة عند الدخول لملء الشاشة — يبقى قابلاً للفتح يدوياً
                return next;
              })}
              title={fullscreen ? 'تصغير الخريطة' : 'تكبير الخريطة لملء الشاشة'}
            >
              {fullscreen ? '✕' : '⛶'}
            </button>
            <button
              type="button"
              className="rfs-map-tool-btn rfs-map-tool-btn--caret"
              onClick={() => setAreaMenuOpen(v => !v)}
              title="تصفية حسب المنطقة"
              aria-expanded={areaMenuOpen}
            >
              {areaMenuOpen ? '▴' : '▾'}
            </button>
            {areaMenuOpen && (
              <div className="rfs-map-area-menu">
                <button
                  className={`rfs-map-area-row ${!areaFilter ? 'rfs-map-area-row--active' : ''}`}
                  onClick={() => selectAreaFilter(null)}
                >
                  <span className="rfs-map-area-name">كل المناطق</span>
                  <span className="rfs-muted">{locatedByKind.length}</span>
                </button>
                {allAreaGroups.map(g => (
                  <button
                    key={g.area}
                    className={`rfs-map-area-row ${areaFilter === g.area ? 'rfs-map-area-row--active' : ''}`}
                    onClick={() => selectAreaFilter(g.area)}
                  >
                    <span className="rfs-map-area-name">{g.area}</span>
                    <span className="rfs-map-area-counts">
                      {g.doctors > 0 && <span className="rfs-map-count rfs-map-count--doctor">{g.doctors}</span>}
                      {g.pharmacies > 0 && <span className="rfs-map-count rfs-map-count--pharmacy">{g.pharmacies}</span>}
                    </span>
                  </button>
                ))}
                {allAreaGroups.length === 0 && <div className="rfs-muted" style={{ padding: 8 }}>لا توجد مناطق.</div>}
              </div>
            )}
          </div>
          <button
            type="button"
            className="rfs-map-tool-btn"
            onClick={goToMyLocation}
            title={me ? 'الانتقال إلى موقعي الحالي' : 'تفعيل تحديد موقعي'}
          >
            📍
          </button>
          <button
            type="button"
            className={`rfs-map-tool-btn ${baseStyle === 'formal' ? 'rfs-map-tool-btn--on' : ''}`}
            onClick={() => setBaseStyle(s => (s === 'formal' ? 'standard' : 'formal'))}
            title={baseStyle === 'formal' ? 'الرجوع لشكل الخريطة الملوّن' : 'شكل رسمي هادئ بلا ألوان ولا كتابات'}
          >
            🗺️
          </button>
          {nav && (
            <button
              type="button"
              className="rfs-map-tool-btn rfs-map-tool-btn--stop"
              onClick={stopNav}
              title="إيقاف الملاحة"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
