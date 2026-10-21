// ════════════════════════════════════════════════════════════════════════════
// BaghdadSalesMap — خريطة بغداد الحقيقية لـ«علمي محافظات» → بغداد.
// أساسان قابلان للتبديل: قمر صناعي + أسماء الشوارع الرئيسية (Esri)، أو خريطة شوارع
// OpenStreetMap بأسماء الأحياء والشوارع بالعربية. فوقهما فقاعات مناطق المبيع
// (حجمها = صافي المبيع، موقعها من سيرفي المندوب) مع اسم كل منطقة.
// بلا تقسيم أقضية/نواحي — بطلب صريح. يُحمَّل كسولاً من IraqRepsMap كي لا
// تدخل Leaflet حزمة التقارير.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// approx = موقع مستنتج من اسم المنطقة (دليل الأماكن) لا من نقاط GPS فعلية
export interface BaghdadMapArea { name: string; value: number; lat: number; lng: number; approx?: boolean }

interface Props {
  areas: BaghdadMapArea[];                 // المناطق ذات الموقع فقط
  selArea: string | null;
  onSelectArea: (a: string | null) => void;
  showBubbles: boolean;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  height: number;
}

const CITY_BOUNDS: L.LatLngBoundsExpression = [[33.2, 44.24], [33.46, 44.56]];

const LABEL_CSS = `
.bgm-label { background: none; border: none; }
.bgm-label div { transform: translate(-50%, 0); white-space: nowrap; text-align: center; font-family: Tajawal, 'Segoe UI', sans-serif; pointer-events: none; }
.bgm-a { color: #fff; font-weight: 800; font-size: 12px; text-shadow: 0 0 3px #000, 0 0 5px #000, 0 0 2px #000; }
.bgm-street .bgm-a { color: #0f172a; text-shadow: 0 0 3px #fff, 0 0 5px #fff, 0 0 2px #fff; }
`;

export default function BaghdadSalesMap({ areas, selArea, onSelectArea, showBubbles, fmtVal, currencyLabel, height }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const bubbles = useRef<L.LayerGroup | null>(null);
  const cb = useRef({ onSelectArea });
  cb.current = { onSelectArea };

  // ── إنشاء الخريطة مرة واحدة ───────────────────────────────────────────────
  useEffect(() => {
    if (!elRef.current) return;
    if (!document.getElementById('bgm-css')) {
      const st = document.createElement('style'); st.id = 'bgm-css'; st.textContent = LABEL_CSS; document.head.appendChild(st);
    }
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: true, minZoom: 9, maxZoom: 18, zoomSnap: 0.5 });
    map.fitBounds(CITY_BOUNDS);
    // قمر صناعي + طبقة النقل من Esri (أسماء الشوارع الرئيسية بالعربية)
    const satellite = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, attribution: 'Imagery © Esri',
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, opacity: 0.9,
      }),
    ]);
    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    satellite.addTo(map);
    L.control.layers({ 'قمر صناعي': satellite, 'خريطة شوارع': streets }, undefined, { position: 'topleft' }).addTo(map);
    // أسماء المناطق داكنة فوق خريطة الشوارع الفاتحة، بيضاء فوق القمر الصناعي
    map.on('baselayerchange', (e: L.LayersControlEvent) => {
      elRef.current?.classList.toggle('bgm-street', e.layer === streets);
    });
    bubbles.current = L.layerGroup().addTo(map);
    map.on('click', () => cb.current.onSelectArea(null));
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => { mapRef.current?.invalidateSize(); }, [height]);

  // ── فقاعات المناطق + أسماؤها ──────────────────────────────────────────────
  useEffect(() => {
    const grp = bubbles.current; if (!grp) return;
    grp.clearLayers();
    const max = Math.max(1, ...areas.map(a => a.value));
    for (const a of [...areas].sort((x, y) => y.value - x.value)) {
      const on = selArea === a.name;
      const r = 5 + 20 * Math.sqrt(a.value / max);
      if (showBubbles) {
        L.circleMarker([a.lat, a.lng], { radius: r, color: on ? '#fde047' : '#ffffff', weight: on ? 3 : 1.5, dashArray: a.approx ? '4 3' : undefined, fillColor: '#2563eb', fillOpacity: a.approx ? 0.5 : 0.7 })
          .bindTooltip(`${a.name} — ${fmtVal(a.value)} ${currencyLabel}${a.approx ? ' · موقع تقريبي من اسم المنطقة' : ''}`, { direction: 'top' })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectArea(on ? null : a.name); })
          .addTo(grp);
      }
      L.marker([a.lat, a.lng], {
        interactive: false,
        icon: L.divIcon({ className: 'bgm-label', html: `<div class="bgm-a" style="margin-top:${showBubbles ? r + 2 : -8}px">${a.name}</div>`, iconSize: [0, 0] }),
      }).addTo(grp);
    }
  }, [areas, selArea, showBubbles, fmtVal, currencyLabel]);

  return <div ref={elRef} dir="ltr" style={{ width: '100%', height, borderRadius: 14, overflow: 'hidden', background: '#1e293b' }} />;
}
