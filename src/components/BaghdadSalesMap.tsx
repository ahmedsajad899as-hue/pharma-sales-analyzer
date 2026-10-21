// ════════════════════════════════════════════════════════════════════════════
// BaghdadSalesMap — خريطة بغداد الحقيقية (صورة قمر صناعي) لـ«علمي محافظات» → بغداد.
// الأقضية ملوّنة بحدود صفراء، النواحي بحدود متقطعة واسم ومبيع كل ناحية، وفوقها
// فقاعات مناطق المبيع (حجمها = صافي المبيع، موقعها من سيرفي المندوب).
// يُحمَّل كسولاً من IraqRepsMap كي لا تدخل Leaflet وحدود النواحي حزمة التقارير.
// الحدود: OCHA COD-AB (src/data/baghdadAdmin.ts) — الإسناد ظاهر في زاوية الخريطة.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BAGHDAD_QADHAS, BAGHDAD_NAHIYAS } from '../data/baghdadAdmin';

export interface BaghdadMapArea { name: string; value: number; lat: number; lng: number }

interface Props {
  areas: BaghdadMapArea[];                 // المناطق ذات الموقع فقط
  nahiyaTotals: Map<string, number>;
  selNahiya: string | null;
  onSelectNahiya: (n: string | null) => void;
  selArea: string | null;
  onSelectArea: (a: string | null) => void;
  showBubbles: boolean;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  height: number;
}

// لون فئوي لكل قضاء (كما في خرائط الأقضية المعتادة) — شفاف فوق صورة القمر الصناعي
const QADHA_COLOR: Record<string, string> = {
  'الكاظمية': '#a0522d', 'الأعظمية': '#43a047', 'الثورة': '#7e57c2', 'الرصافة': '#d4a72c',
  'الكرخ': '#64748b', 'المدائن': '#0d9488', 'المحمودية': '#ea580c',
};
const CITY_BOUNDS: L.LatLngBoundsExpression = [[33.2, 44.24], [33.46, 44.56]];

const LABEL_CSS = `
.bgm-label { background: none; border: none; }
.bgm-label div { transform: translate(-50%, -50%); white-space: nowrap; text-align: center; font-family: Tajawal, 'Segoe UI', sans-serif; pointer-events: none; }
.bgm-q { color: #fde047; font-weight: 900; font-size: 15px; text-shadow: 0 0 3px #000, 0 0 6px #000; }
.bgm-n { color: #e0f2fe; font-weight: 800; font-size: 11.5px; text-shadow: 0 0 3px #000, 0 0 5px #000; line-height: 1.25; }
.bgm-n b { color: #7dd3fc; font-size: 11px; }
.bgm-a { color: #fff; font-weight: 800; font-size: 10.5px; text-shadow: 0 0 3px #000, 0 0 4px #000; }
`;

export default function BaghdadSalesMap({ areas, nahiyaTotals, selNahiya, onSelectNahiya, selArea, onSelectArea, showBubbles, fmtVal, currencyLabel, height }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const nahiyaLayers = useRef(new Map<string, L.Polygon>());
  const nahiyaLabels = useRef<L.LayerGroup | null>(null);
  const bubbles = useRef<L.LayerGroup | null>(null);
  const cb = useRef({ onSelectNahiya, onSelectArea });
  cb.current = { onSelectNahiya, onSelectArea };

  // ── إنشاء الخريطة مرة واحدة: أساس + أقضية + نواحي ─────────────────────────
  useEffect(() => {
    if (!elRef.current) return;
    if (!document.getElementById('bgm-css')) {
      const st = document.createElement('style'); st.id = 'bgm-css'; st.textContent = LABEL_CSS; document.head.appendChild(st);
    }
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: true, minZoom: 9, maxZoom: 17, zoomSnap: 0.5 });
    map.fitBounds(CITY_BOUNDS);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, attribution: 'Imagery © Esri · حدود: OCHA (CC BY-IGO)',
    }).addTo(map);

    for (const q of BAGHDAD_QADHAS) {
      L.polygon(q.rings, { color: '#facc15', weight: 2.5, fillColor: QADHA_COLOR[q.name] ?? '#64748b', fillOpacity: 0.38, interactive: false }).addTo(map);
    }
    for (const n of BAGHDAD_NAHIYAS) {
      const poly = L.polygon(n.rings, { color: '#ffffff', weight: 1.2, dashArray: '5 5', fillOpacity: 0, fill: true })
        .on('click', () => cb.current.onSelectNahiya(n.name))
        .addTo(map);
      nahiyaLayers.current.set(n.name, poly);
    }
    for (const q of BAGHDAD_QADHAS) {
      L.marker(q.c, { interactive: false, icon: L.divIcon({ className: 'bgm-label', html: `<div class="bgm-q">قضاء ${q.name}</div>`, iconSize: [0, 0] }) }).addTo(map);
    }
    nahiyaLabels.current = L.layerGroup().addTo(map);
    bubbles.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      // نقرة على أرض خارج أي ناحية = إلغاء التحديد
      if ((e.originalEvent.target as HTMLElement)?.tagName !== 'path') cb.current.onSelectNahiya(null);
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; nahiyaLayers.current.clear(); };
  }, []);

  useEffect(() => { mapRef.current?.invalidateSize(); }, [height]);

  // ── أسماء النواحي + مبيعها، وإبراز الناحية المختارة ───────────────────────
  useEffect(() => {
    const grp = nahiyaLabels.current; if (!grp) return;
    grp.clearLayers();
    for (const n of BAGHDAD_NAHIYAS) {
      const v = nahiyaTotals.get(n.name) ?? 0;
      const on = selNahiya === n.name;
      nahiyaLayers.current.get(n.name)?.setStyle(on
        ? { color: '#fde047', weight: 3.5, dashArray: undefined, fillColor: '#fde047', fillOpacity: 0.18 }
        : { color: '#ffffff', weight: 1.2, dashArray: '5 5', fillOpacity: 0 });
      nahiyaLayers.current.get(n.name)?.unbindTooltip().bindTooltip(`ناحية ${n.name}${v ? ` — ${fmtVal(v)} ${currencyLabel}` : ''}`, { sticky: true, direction: 'top' });
      L.marker(n.c, { interactive: false, icon: L.divIcon({ className: 'bgm-label', html: `<div class="bgm-n">ناحية ${n.name}${v ? `<br><b>${fmtVal(v)}</b>` : ''}</div>`, iconSize: [0, 0] }) }).addTo(grp);
    }
  }, [nahiyaTotals, selNahiya, fmtVal, currencyLabel]);

  // ── فقاعات المناطق ────────────────────────────────────────────────────────
  useEffect(() => {
    const grp = bubbles.current; if (!grp) return;
    grp.clearLayers();
    if (!showBubbles) return;
    const max = Math.max(1, ...areas.map(a => a.value));
    const top = new Set([...areas].sort((a, b) => b.value - a.value).slice(0, 8).map(a => a.name));
    for (const a of [...areas].sort((x, y) => y.value - x.value)) {
      const on = selArea === a.name;
      const r = 5 + 20 * Math.sqrt(a.value / max);
      L.circleMarker([a.lat, a.lng], { radius: r, color: on ? '#fde047' : '#ffffff', weight: on ? 3 : 1.5, fillColor: '#2563eb', fillOpacity: 0.72 })
        .bindTooltip(`${a.name} — ${fmtVal(a.value)} ${currencyLabel}`, { direction: 'top' })
        .on('click', (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectArea(on ? null : a.name); })
        .addTo(grp);
      if (top.has(a.name) || on) {
        L.marker([a.lat, a.lng], { interactive: false, icon: L.divIcon({ className: 'bgm-label', html: `<div class="bgm-a" style="margin-top:${r + 12}px">${a.name}</div>`, iconSize: [0, 0] }) }).addTo(grp);
      }
    }
  }, [areas, selArea, showBubbles, fmtVal, currencyLabel]);

  return <div ref={elRef} dir="ltr" style={{ width: '100%', height, borderRadius: 14, overflow: 'hidden', background: '#1e293b' }} />;
}
