import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Entry } from '../pages/RepFieldSurveyPage';

// ════════════════════════════════════════════════════════════════════════════
// RepFieldSurveyMap — خريطة سجلات سيرفي المندوب العلمي
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

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`;
}

function fmtDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} د`;
  return `${Math.floor(min / 60)} س ${min % 60} د`;
}

// صيدلية أُنشئت تلقائياً من "قريب" طبيب (أو العكس) ترث نفس إحداثيات الأصل
// حرفياً (راجع ensureOwnPharmacies في الخادم) — فيقع الدبوسان على نفس
// البكسل بالضبط ويختفي أحدهما خلف الآخر تماماً. بدمج النوعين معاً (زر "الكل")
// يتضاعف هذا التطابق فيبدو العدد الظاهر على الخريطة أقل من الحقيقي رغم أن كل
// نقطة مرسومة فعلياً. الحل: توزيع النقاط المتطابقة إحداثياً على دائرة صغيرة
// جداً حول نفس المكان الحقيقي (للعرض فقط — "فتح في خرائط Google" وحساب
// المسافة/الملاحة يستعملان إحداثيات السجل الأصلية غير المُزاحة).
function offsetLatLng(lat: number, lng: number, index: number, total: number, radiusMeters = 9): [number, number] {
  if (total <= 1) return [lat, lng];
  const angle = (2 * Math.PI * index) / total;
  const dLat = (radiusMeters * Math.sin(angle)) / 111320;
  const dLng = (radiusMeters * Math.cos(angle)) / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  return [lat + dLat, lng + dLng];
}

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

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
// بدل استدعاء pinIcon() من جديد لكل دبوس في حلقة الرسم (كان يُنشئ مئات عناصر
// L.DivIcon المتطابقة فعلياً عند كل إعادة رسم، وهو أثقل جزء في بناء الدبوس).
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

interface Props { entries: Entry[]; }

// محتوى النافذة المنبثقة — دالة منفصلة لأنها تُستدعى مرتين: عند إنشاء الدبوس
// (بآخر موقع معروف وقتها) وعند فتح النافذة فعلياً (بأحدث موقع، ليبقى "يبعد
// عنك" دقيقاً دون الحاجة لإعادة رسم كل الدبابيس حين يتحرك موقعي الحي). زر
// "ملاحة" يحمل data-rfs-nav ليُربط بمستمع نقر بعد إدراج النافذة في الصفحة
// (المحتوى HTML خام، فلا يمكن تمرير onClick من React مباشرة).
function buildPopupHtml(e: Entry, me: { lat: number; lng: number } | null): string {
  const dist = me ? haversineMeters(me.lat, me.lng, e.latitude, e.longitude) : null;
  const detailsLine = e.kind === 'doctor'
    ? [e.specialty, e.className, e.nearPharmacies.length ? `قرب: ${e.nearPharmacies.join('، ')}` : ''].filter(Boolean).join(' · ')
    : e.notes ?? '';
  return `
    <div style="min-width:200px; font-family:inherit; direction:rtl; text-align:right;">
      <div style="font-weight:700; font-size:14px; margin-bottom:2px;">${e.kind === 'doctor' ? '🩺' : '💊'} ${escapeHtml(e.name)}</div>
      <div style="color:#5a6a8a; font-size:12.5px; margin-bottom:4px;">${escapeHtml(e.areaName)}${e.repName ? ' · ' + escapeHtml(e.repName) : ''}</div>
      ${detailsLine ? `<div style="font-size:12.5px; color:#1a2332; margin-bottom:4px;">${escapeHtml(detailsLine)}</div>` : ''}
      ${dist != null ? `<div style="font-size:12.5px; font-weight:700; color:${COLOR_ME}; margin-bottom:4px;">📍 يبعد عنك ${fmtDistance(dist)}</div>` : ''}
      <div style="display:flex; align-items:center; gap:10px; margin-top:2px; flex-wrap:wrap;">
        <a href="${mapsUrl(e.latitude, e.longitude)}" target="_blank" rel="noreferrer" style="font-size:12px;">فتح في خرائط Google ↗</a>
        <button type="button" data-rfs-nav="1" style="font-size:12px; font-weight:700; color:${COLOR_ROUTE}; background:#eaf1fd; border:1px solid #c7dcfb; border-radius:6px; padding:3px 9px; cursor:pointer;">🧭 ملاحة</button>
      </div>
    </div>`;
}

export default function RepFieldSurveyMap({ entries }: Props) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const meMarkerRef = useRef<L.Marker | null>(null);
  const meCircleRef = useRef<L.Circle | null>(null);
  const routeLayerRef = useRef<L.Polyline | null>(null);
  const kindBtnsRef = useRef<{ doctorBtn: HTMLElement; pharmacyBtn: HTMLElement } | null>(null);

  const [me, setMe] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [geoError, setGeoError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const watchIdRef = useRef<number | null>(null);
  // أول تثبيت لموقعي فقط يُدخَل في حساب الحدود الابتدائية — التحديثات اللاحقة
  // لموقعي الحي (أثناء watchPosition) لا يجب أن "تسحب" الخريطة بعيداً عن مكان
  // تصفّح المستخدم الحالي؛ إعادة التركيز بعدها تتم فقط بزر «اذهب إلى موقعي».
  const meFittedOnceRef = useRef(false);
  // نسخة قابلة للقراءة الفورية من آخر موقع معروف — تُقرأ عند فتح نافذة أي
  // دبوس أو رسم مسار دون إدراج `me` ضمن تبعيات رسم الدبابيس.
  const meRef = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);

  // فلتر سريع من داخل الخريطة نفسها (زرّا 🩺/💊 قرب أزرار التكبير)، إضافة إلى
  // فلتر الصفحة الخارجي الذي يُحدِّد أصلاً ما يصل إلى entries.
  const [mapKind, setMapKind] = useState<'all' | 'doctor' | 'pharmacy'>('all');

  const located = useMemo(
    () => entries.filter(e => Number.isFinite(e.latitude) && Number.isFinite(e.longitude) && (mapKind === 'all' || e.kind === mapKind)),
    [entries, mapKind],
  );
  // نسخة فورية من located يقرأها الرسم الذي قد يُستدعى من مستمع حدث خريطة
  // (moveend/zoomend) مربوط مرة واحدة فقط عند إنشاء الخريطة.
  const locatedRef = useRef<Entry[]>(located);
  locatedRef.current = located;

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

  // ── الملاحة: جلب مسار من OSRM المجاني (بلا مفتاح API، نفس نهج بلاطات
  // OpenStreetMap في هذا الملف) ورسمه كخط على الخريطة ──────────────────────
  const [route, setRoute] = useState<{ toName: string; distanceM: number; durationS: number } | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');

  const clearRoute = () => {
    if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null; }
    setRoute(null);
    setRouteError('');
  };

  const drawRoute = async (e: Entry) => {
    const map = mapRef.current;
    const start = meRef.current;
    if (!map) return;
    if (!start) {
      setRouteError('فعّل تحديد موقعك الحالي أولاً (زر «اذهب إلى موقعي») لرسم طريق الوصول.');
      return;
    }
    setRouteError('');
    setRouteLoading(true);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${e.longitude},${e.latitude}?overview=full&geometries=geojson`;
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok || j.code !== 'Ok' || !j.routes?.length) throw new Error('تعذّر رسم الطريق حالياً. حاول مجدداً.');
      const latlngs = (j.routes[0].geometry.coordinates as [number, number][]).map(c => [c[1], c[0]] as [number, number]);
      if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null; }
      const line = L.polyline(latlngs, { color: COLOR_ROUTE, weight: 5, opacity: 0.85 }).addTo(map);
      routeLayerRef.current = line;
      map.fitBounds(line.getBounds(), { padding: [48, 48] });
      setRoute({ toName: e.name, distanceM: j.routes[0].distance, durationS: j.routes[0].duration });
    } catch (err: any) {
      setRouteError(err.message || 'تعذّر رسم الطريق حالياً. تحقّق من الاتصال وحاول مجدداً.');
    } finally {
      setRouteLoading(false);
    }
  };

  // ── رسم نقاط السجلات ضمن حدود العرض الحالية فقط (+ هامش) ─────────────────
  // لا تُرسم كل السجلات دائماً: عند التكبير على منطقة ضيقة لا حاجة لمئات
  // دبابيس خارج الشاشة في DOM — هذا يُخفّف العبء أثناء التفاعل. يُعاد بناء
  // هذه الدالة كل تصيير (closure حديث على located/me/drawRoute) وتُستدعى عبر
  // drawMarkersRef حتى يقرأها مستمع الخريطة المربوط مرة واحدة فقط بأحدث نسخة.
  function drawMarkersImpl() {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const viewBounds = map.getBounds().pad(0.5);
    const within = locatedRef.current.filter(e => viewBounds.contains([e.latitude, e.longitude]));

    // تجميع النقاط المتطابقة الإحداثيات حرفياً (دقة 6 منازل عشرية ≈ أقل من
    // متر) قبل الرسم، ثم توزيعها بإزاحة بصرية صغيرة إن تجاوز العدد واحداً.
    const groups = new Map<string, Entry[]>();
    for (const e of within) {
      const key = `${e.latitude.toFixed(6)},${e.longitude.toFixed(6)}`;
      const g = groups.get(key);
      if (g) g.push(e); else groups.set(key, [e]);
    }

    for (const group of groups.values()) {
      group.forEach((e, i) => {
        const [lat, lng] = offsetLatLng(e.latitude, e.longitude, i, group.length);
        const icon = e.kind === 'doctor' ? DOCTOR_ICON : PHARMACY_ICON;
        const marker = L.marker([lat, lng], { icon, riseOnHover: true }).addTo(layer);
        marker.bindPopup(buildPopupHtml(e, meRef.current), { autoPan: true });
        marker.on('popupopen', () => {
          marker.setPopupContent(buildPopupHtml(e, meRef.current));
          const popupEl = marker.getPopup()?.getElement();
          const navBtn = popupEl?.querySelector('[data-rfs-nav]') as HTMLButtonElement | null;
          if (navBtn) navBtn.onclick = ev => { ev.preventDefault(); drawRoute(e); };
        });
      });
    }
  }
  const drawMarkersRef = useRef(drawMarkersImpl);
  drawMarkersRef.current = drawMarkersImpl;

  // ── إنشاء الخريطة مرة واحدة ──────────────────────────────────────────────
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    // fadeAnimation معطّل عمداً: تلاشي البلاطات عند كل سحب/تكبير هو ما يُشعر
    // بالتقطّع على هواتف متوسطة الأداء؛ تعطيله يجعل التنقل يبدو فورياً وأخف.
    // wheelPxPerZoomLevel أصغر = استجابة أسرع لعجلة الفأرة بلا قفزات كبيرة.
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
    // أوقفت السماح المجاني بخلفيتها الرصدية بلا مفتاح API، فكانت تظهر عليها
    // علامة "API KEY REQUIRED" بدل الخريطة.
    // keepBuffer أكبر + updateWhenZooming معطّل: بلاطات الجوار تبقى محمَّلة
    // سلفاً فلا تُرى مربعات فارغة أثناء السحب السريع، ولا يُعاد طلب بلاطات
    // جديدة في منتصف حركة التكبير (فقط بعد استقرارها) فيبقى التفاعل سلساً.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      keepBuffer: 6,
      updateWhenZooming: false,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);

    // زرّا فلترة سريعة (🩺 أطباء / 💊 صيدليات) قرب أزرار التكبير/التصغير —
    // leaflet-bar يمنحهما نفس شكل أزرار التحكّم الجاهزة في الخريطة مباشرة.
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

    // يُعاد رسم الدبابيس بعد انتهاء كل سحب/تكبير (لا أثناءه) ليعكس حدود
    // العرض الجديدة — العمل الفعلي خفيف (تصفية + دبابيس ضمن الشاشة فقط).
    const onMoveEnd = () => drawMarkersRef.current();
    map.on('moveend zoomend', onMoveEnd);

    mapRef.current = map;
    return () => {
      map.off('moveend zoomend', onMoveEnd);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      meMarkerRef.current = null;
      meCircleRef.current = null;
      routeLayerRef.current = null;
      kindBtnsRef.current = null;
    };
  }, []);

  // ── تفعيل زرّي الفلترة السريعة بصرياً حسب mapKind ─────────────────────────
  useEffect(() => {
    const btns = kindBtnsRef.current;
    if (!btns) return;
    btns.doctorBtn.classList.toggle('rfs-map-kind-btn--active', mapKind === 'doctor');
    btns.pharmacyBtn.classList.toggle('rfs-map-kind-btn--active', mapKind === 'pharmacy');
  }, [mapKind]);

  // ── ضبط حدود العرض عند تغيّر بيانات السجلات (أو الفلتر) — يستدعي الرسم
  // فوراً، ولا يعتمد على `me` في تبعياته حتى لا يتكرر مع كل نبضة GPS لاحقة
  // من watchPosition ويسحب الخريطة بعيداً عن تصفّح المستخدم اليدوي ────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (located.length) {
      const bounds = L.latLngBounds(located.map(e => [e.latitude, e.longitude] as [number, number]));
      if (meRef.current) bounds.extend([meRef.current.lat, meRef.current.lng]);
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    }
    drawMarkersRef.current();
  }, [located]);

  // ── أول تثبيت لموقعي فقط يُعيد ضبط الحدود لتشمله — بعدها لا إعادة تركيز
  // تلقائية إطلاقاً؛ فقط زر «اذهب إلى موقعي» يفعل ذلك.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !me || meFittedOnceRef.current) return;
    meFittedOnceRef.current = true;
    if (located.length) {
      const bounds = L.latLngBounds(located.map(e => [e.latitude, e.longitude] as [number, number]));
      bounds.extend([me.lat, me.lng]);
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    } else {
      map.setView([me.lat, me.lng], 14);
    }
    drawMarkersRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // ── موقعي الحالي: تتبّع مستمر + دائرة الدقة ──────────────────────────────
  // دالة قابلة لإعادة الاستدعاء من زر صريح بنقرة المستخدم: المتصفحات تتعامل
  // مع طلب موقع ناتج عن نقرة فعلية بثقة أكبر من طلب تلقائي عند فتح الصفحة،
  // وقد يكون سبب الرفض الأول أن النافذة لم تظهر أصلاً عند التحميل التلقائي.
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
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  };

  useEffect(() => {
    startWatch();
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
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
    const pts = located.filter(e => e.areaName.trim() === g.area).map(e => [e.latitude, e.longitude] as [number, number]);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 16 });
    else map.setView([g.lat, g.lng], 16);
  };

  const recenterOnMe = () => {
    if (me && mapRef.current) mapRef.current.setView([me.lat, me.lng], 16);
  };

  const totalDoctors = located.filter(e => e.kind === 'doctor').length;
  const totalPharmacies = located.filter(e => e.kind === 'pharmacy').length;

  return (
    <div className="rfs-map-shell">
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
              <div className="rfs-muted">عرض {mapKind === 'doctor' ? 'الأطباء' : 'الصيدليات'} فقط (من أزرار الخريطة) · <button className="rfs-map-link-btn" onClick={() => setMapKind('all')}>عرض الكل</button></div>
            )}
            {geoError && (
              <div className="rfs-map-geo-error">
                <div>{geoError}</div>
                <button className="rfs-map-retry-btn" onClick={startWatch}>🔄 إعادة المحاولة</button>
              </div>
            )}
            {me && (
              <button className="rfs-map-me-btn" onClick={recenterOnMe}>
                📍 اذهب إلى موقعي (دقة ±{Math.round(me.accuracy)} م)
              </button>
            )}
            {routeLoading && <div className="rfs-map-route-info">جارٍ حساب الطريق…</div>}
            {routeError && (
              <div className="rfs-map-geo-error">
                <div>{routeError}</div>
              </div>
            )}
            {route && (
              <div className="rfs-map-route-info">
                <div><strong>🧭 الطريق إلى «{route.toName}»</strong></div>
                <div className="rfs-muted">{fmtDistance(route.distanceM)} · {fmtDuration(route.durationS)} تقريباً</div>
                <button className="rfs-map-retry-btn" onClick={clearRoute}>✕ إلغاء المسار</button>
              </div>
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
      <div className="rfs-map-canvas" ref={mapDivRef} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
