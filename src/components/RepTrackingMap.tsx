import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface LocationPoint {
  id: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  trackedAt: string;
}

interface VisitMarker {
  lat: number;
  lng: number;
  label: string;
  time: string;
}

interface Props {
  repId: number;        // 0 = own rep (server resolves from JWT)
  repName: string;
  date: string;         // YYYY-MM-DD
  visitMarkers?: VisitMarker[];
  onClose: () => void;
  onBack?: () => void;  // if provided, button becomes "back" and restores previous page
}

// Fix Leaflet default icon path issue with bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function makeCircleIcon(color: string, size = 12) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};
      border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.45)"></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeEndpointIcon(emoji: string) {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:22px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5))">${emoji}</div>`,
    iconSize:   [26, 26],
    iconAnchor: [13, 13],
  });
}

function makeVisitIcon(label: string) {
  return L.divIcon({
    className: '',
    html: `<div style="background:#4f46e5;color:#fff;border-radius:8px;padding:3px 8px;
      font-size:11px;font-weight:700;border:2px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,0.4);white-space:nowrap;font-family:sans-serif;
      direction:rtl">${label}</div>`,
    iconSize:   [undefined as any, undefined as any],
    iconAnchor: [0, 12],
    popupAnchor:[0, -14],
  });
}

// Proxy ORS route through our backend (API key stays server-side)
async function fetchRouteSegment(coords: [number, number][]): Promise<[number, number][]> {
  if (coords.length < 2) return coords;
  try {
    const token = localStorage.getItem('auth_token') || '';
    const res = await fetch('/api/ors/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ coordinates: coords }),
    });
    if (!res.ok) return coords;
    const data = await res.json();
    // Fallback: server returned straight coords when ORS failed
    if (data.fallback) return (data.coordinates as [number, number][]);
    // Normal ORS GeoJSON response: coordinates are [lng, lat]
    return data.features[0].geometry.coordinates as [number, number][];
  } catch {
    return coords;
  }
}

async function buildRoadRoute(points: LocationPoint[]): Promise<L.LatLngExpression[]> {
  if (points.length < 2) return points.map(p => [p.latitude, p.longitude]);

  // ORS free plan allows max 50 waypoints per request → chunk
  const CHUNK = 50;
  const orsCoords: [number, number][] = points.map(p => [p.longitude, p.latitude]); // ORS: [lng, lat]

  const chunks: [number, number][][] = [];
  for (let i = 0; i < orsCoords.length; i += CHUNK - 1) {
    chunks.push(orsCoords.slice(i, Math.min(i + CHUNK, orsCoords.length)));
    if (chunks[chunks.length - 1].length < 2) chunks.pop();
  }

  const segments = await Promise.all(chunks.map(fetchRouteSegment));
  // Merge: each segment starts where the previous ended, avoid duplicates
  const merged: [number, number][] = [];
  segments.forEach((seg, si) => {
    const start = si === 0 ? 0 : 1;
    for (let i = start; i < seg.length; i++) merged.push(seg[i]);
  });

  // Convert [lng, lat] → Leaflet [lat, lng]
  return merged.map(([lng, lat]) => [lat, lng] as L.LatLngExpression);
}

export default function RepTrackingMap({ repId, repName, date, visitMarkers = [], onClose, onBack }: Props) {
  const mapRef     = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const [points,  setPoints]  = useState<LocationPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [routing, setRouting] = useState(false);
  const [error,   setError]   = useState('');

  // ── Fetch location points ──────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    setLoading(true);
    setError('');
    const query = repId > 0 ? `repId=${repId}&date=${date}` : `date=${date}`;
    fetch(`/api/tracking/locations?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) setPoints(data.points || []);
        else setError(data.error || 'فشل التحميل');
      })
      .catch(() => setError('تعذر الاتصال بالخادم'))
      .finally(() => setLoading(false));
  }, [repId, date]);

  // ── Build Leaflet map ─────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    if (!mapRef.current) return;
    if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; }

    const hasTrackPoints  = points.length > 0;
    const hasVisitMarkers = visitMarkers.length > 0;
    if (!hasTrackPoints && !hasVisitMarkers) return;

    const map = L.map(mapRef.current, { zoomControl: true });
    leafletRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    const allBounds: L.LatLngExpression[] = [];

    // ── Tracking dot markers (small, non-intrusive) ────────
    points.forEach((p, i) => {
      const ll: L.LatLngExpression = [p.latitude, p.longitude];
      allBounds.push(ll);
      const isFirst = i === 0;
      const isLast  = i === points.length - 1;

      if (isFirst || isLast) {
        const icon = makeEndpointIcon(isFirst ? '🟢' : '🔴');
        const timeStr = new Date(p.trackedAt).toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
        L.marker(ll, { icon, zIndexOffset: 500 })
          .addTo(map)
          .bindPopup(`<div dir="rtl" style="font-size:12px;font-family:sans-serif">
            <b>${isFirst ? '🟢 بداية التتبع' : '🔴 آخر نقطة'}</b><br>🕐 ${timeStr}
            ${p.accuracy ? `<br><span style="color:#94a3b8;font-size:10px">دقة: ±${Math.round(p.accuracy)}م</span>` : ''}
          </div>`);
      } else {
        L.marker(ll, { icon: makeCircleIcon('#3b82f6', 10) }).addTo(map);
      }
    });

    // ── Visit markers (on top with indigo label) ───────────
    visitMarkers.forEach(vm => {
      const ll: L.LatLngExpression = [vm.lat, vm.lng];
      allBounds.push(ll);
      L.marker(ll, { icon: makeVisitIcon(vm.label), zIndexOffset: 1000 })
        .addTo(map)
        .bindPopup(`<div dir="rtl" style="font-size:12px;font-family:sans-serif">
          <b>${vm.label}</b><br>🕐 ${vm.time}
        </div>`);
    });

    // Fit bounds immediately (straight lines as placeholder)
    if (allBounds.length > 0) {
      map.fitBounds(L.latLngBounds(allBounds), { padding: [40, 40], maxZoom: 16 });
    }

    // ── Draw straight dashed line first (instant feedback) ─
    let tempPolyline: L.Polyline | null = null;
    if (points.length >= 2) {
      const straightLLs: L.LatLngExpression[] = points.map(p => [p.latitude, p.longitude]);
      tempPolyline = L.polyline(straightLLs, {
        color: '#93c5fd', weight: 3, opacity: 0.5, dashArray: '6 5',
      }).addTo(map);
    }

    // ── Then fetch road-following route from ORS ───────────
    if (points.length >= 2) {
      setRouting(true);
      buildRoadRoute(points).then(routeLatLngs => {
        if (!leafletRef.current) return;
        // Remove placeholder
        if (tempPolyline) { tempPolyline.remove(); tempPolyline = null; }
        // Draw real road-following route
        L.polyline(routeLatLngs, {
          color: '#2563eb',
          weight: 5,
          opacity: 0.88,
        }).addTo(leafletRef.current);
        setRouting(false);
      });
    }

    return () => {
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; }
    };
  }, [loading, points]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeRange = points.length >= 2
    ? `${new Date(points[0].trackedAt).toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit' })} — ${new Date(points[points.length - 1].trackedAt).toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}`
    : null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ zIndex: 10000 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '96vw', maxWidth: 1040, height: '88vh',
          display: 'flex', flexDirection: 'column',
          borderRadius: 16, overflow: 'hidden',
          boxShadow: '0 28px 70px rgba(0,0,0,0.4)',
          background: '#fff',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)',
          padding: '12px 18px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', flexShrink: 0, gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              background: 'rgba(255,255,255,0.18)', borderRadius: 10,
              width: 44, height: 44, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 23, flexShrink: 0,
            }}>📍</div>
            <div>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: 15, lineHeight: 1.3 }}>
                مسار المندوب — {repName}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 }}>
                📅 {date}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {/* Badges — hidden on very narrow screens via overflow but button always stays */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', overflow: 'hidden', maxWidth: 'calc(100vw - 200px)' }}>
              {points.length > 0 && (
                <>
                  <span style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', borderRadius: 16, padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                    📍 {points.length}
                  </span>
                  {timeRange && (
                    <span style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', borderRadius: 16, padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                      🕐 {timeRange}
                    </span>
                  )}
                  {visitMarkers.length > 0 && (
                    <span style={{ background: 'rgba(99,102,241,0.45)', color: '#e0e7ff', borderRadius: 16, padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                      🏥 {visitMarkers.length}
                    </span>
                  )}
                </>
              )}
              {routing && (
                <span style={{ background: 'rgba(251,191,36,0.3)', color: '#fef3c7', borderRadius: 16, padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                  ⏳
                </span>
              )}
            </div>
            <button
              onClick={() => { onClose(); onBack?.(); }}
              style={{
                background: 'rgba(255,255,255,0.14)', border: '1.5px solid rgba(255,255,255,0.3)',
                color: '#fff', borderRadius: 8, padding: '7px 14px',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
                flexShrink: 0, whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.26)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
            >{onBack ? '→ رجوع' : '✕ إغلاق'}</button>
          </div>
        </div>

        {/* ── Body ── */}
        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, color: '#94a3b8' }}>
            <div style={{ fontSize: 38 }}>⏳</div>
            <div style={{ fontSize: 14 }}>جاري تحميل نقاط التتبع...</div>
          </div>
        ) : error ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, color: '#ef4444' }}>
            <div style={{ fontSize: 38 }}>⚠️</div>
            <div style={{ fontSize: 14 }}>{error}</div>
          </div>
        ) : points.length === 0 && visitMarkers.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, color: '#94a3b8' }}>
            <div style={{ fontSize: 50 }}>📭</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>لا توجد نقاط تتبع لهذا اليوم</div>
            <div style={{ fontSize: 13, color: '#cbd5e1', textAlign: 'center', maxWidth: 280 }}>
              التتبع يبدأ تلقائياً بعد أول كول يسجله المندوب
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
            {/* Legend overlay */}
            <div style={{
              position: 'absolute', bottom: 16, right: 16, zIndex: 1000,
              background: 'rgba(255,255,255,0.95)', borderRadius: 10,
              padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              fontSize: 11, direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 20, height: 4, background: '#2563eb', borderRadius: 2 }} />
                <span style={{ color: '#374151' }}>مسار المندوب</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#10b981', border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', flexShrink: 0 }} />
                <span style={{ color: '#374151' }}>بداية اليوم</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444', border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', flexShrink: 0 }} />
                <span style={{ color: '#374151' }}>آخر نقطة</span>
              </div>
              {visitMarkers.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ background: '#4f46e5', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>زيارة</div>
                  <span style={{ color: '#374151' }}>نقطة زيارة</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
