import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLanguage } from '../context/LanguageContext';

export interface VisitPoint {
  id: number;
  visitDate: string;
  latitude: number | null;
  longitude: number | null;
  feedback: string;
  notes?: string | null;
  doctor: { id: number; name: string; specialty?: string | null; pharmacyName?: string | null; area?: { name: string } | null };
  scientificRep: { id: number; name: string };
  item?: { id: number; name: string } | null;
}

interface Props {
  visits: VisitPoint[];
  repName?: string;
  onClose: () => void;
}

// Feedback colour mapping
const feedbackColor: Record<string, string> = {
  writing:       '#10b981',
  stocked:       '#0ea5e9',
  interested:    '#6366f1',
  not_interested:'#ef4444',
  unavailable:   '#9ca3af',
  pending:       '#f59e0b',
};

const defaultColor = '#6366f1';

// Fix the default broken-image icon that Leaflet uses with bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function makeNumberedIcon(num: number, color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      background:${color};
      color:#fff;
      border-radius:50%;
      width:30px;
      height:30px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight:700;
      font-size:13px;
      border:2.5px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,0.35);
      font-family:sans-serif;
    ">${num}</div>`,
    iconSize:   [30, 30],
    iconAnchor: [15, 15],
    popupAnchor:[0, -18],
  });
}

export default function DailyCallsMap({ visits, repName, onClose }: Props) {
  const { t } = useLanguage();
  const mapRef    = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<L.Map | null>(null);

  const gpsVisits = visits
    .filter(v => v.latitude != null && v.longitude != null)
    .sort((a, b) => new Date(a.visitDate).getTime() - new Date(b.visitDate).getTime());

  useEffect(() => {
    if (!mapRef.current) return;
    if (leafletRef.current) {
      leafletRef.current.remove();
      leafletRef.current = null;
    }

    if (gpsVisits.length === 0) return;

    const map = L.map(mapRef.current, { zoomControl: true });
    leafletRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    const latlngs: L.LatLngExpression[] = [];

    gpsVisits.forEach((v, idx) => {
      const lat = v.latitude as number;
      const lng = v.longitude as number;
      latlngs.push([lat, lng]);

      const color = feedbackColor[v.feedback] ?? defaultColor;
      const icon  = makeNumberedIcon(idx + 1, color);

      const timeStr = new Date(v.visitDate).toLocaleTimeString('ar-IQ-u-nu-latn', {
        hour: '2-digit', minute: '2-digit',
      });

      const feedbackLabel =
        v.feedback === 'writing'        ? (t.dashboard as any).feedbackWriting :
        v.feedback === 'stocked'        ? (t.dashboard as any).feedbackStocked :
        v.feedback === 'interested'     ? (t.dashboard as any).feedbackInterested :
        v.feedback === 'not_interested' ? (t.dashboard as any).feedbackNotInterested :
        v.feedback === 'unavailable'    ? (t.dashboard as any).feedbackUnavailable :
                                          (t.dashboard as any).feedbackPending;

      const popup = `
        <div dir="rtl" style="font-family:sans-serif;min-width:180px;line-height:1.6">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px">
            ${idx + 1}. ${v.doctor.name}
          </div>
          ${v.doctor.specialty ? `<div style="font-size:12px;color:#6b7280">${v.doctor.specialty}</div>` : ''}
          <div style="font-size:12px;margin-top:4px">🕐 ${timeStr}</div>
          ${v.item ? `<div style="font-size:12px">💊 ${v.item.name}</div>` : ''}
          <div style="font-size:12px;margin-top:4px">
            <span style="background:${color};color:#fff;padding:2px 8px;border-radius:8px;font-size:11px">${feedbackLabel}</span>
          </div>
          ${v.notes ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${v.notes}</div>` : ''}
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">👤 ${v.scientificRep.name}</div>
        </div>
      `;

      L.marker([lat, lng], { icon }).addTo(map).bindPopup(popup);
    });

    // Draw route polyline
    if (latlngs.length > 1) {
      L.polyline(latlngs, {
        color: '#6366f1',
        weight: 3,
        opacity: 0.75,
        dashArray: '6 6',
      }).addTo(map);
    }

    // Fit map to all markers
    const bounds = L.latLngBounds(latlngs as L.LatLngExpression[]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });

    return () => {
      if (leafletRef.current) {
        leafletRef.current.remove();
        leafletRef.current = null;
      }
    };
  }, [gpsVisits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ zIndex: 10000 }}
    >
      <div
        className="modal modal--wide"
        style={{ maxWidth: 860, height: '82vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <h2 className="modal-title">
            🗺️ {(t.dashboard as any).mapTitle}
            {repName && (
              <span style={{ fontSize: '0.85rem', fontWeight: 400, marginRight: '8px', color: '#6b7280' }}>
                — {repName}
              </span>
            )}
          </h2>
          <button className="modal-close" onClick={onClose}>{(t.dashboard as any).mapClose} ✕</button>
        </div>

        {/* Legend */}
        {gpsVisits.length > 0 && (
          <div style={{ padding: '8px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: '12px', flexWrap: 'wrap', flexShrink: 0 }}>
            {Object.entries(feedbackColor).map(([key, color]) => {
              const label =
                key === 'writing'        ? (t.dashboard as any).feedbackWriting :
                key === 'stocked'        ? (t.dashboard as any).feedbackStocked :
                key === 'interested'     ? (t.dashboard as any).feedbackInterested :
                key === 'not_interested' ? (t.dashboard as any).feedbackNotInterested :
                key === 'unavailable'    ? (t.dashboard as any).feedbackUnavailable :
                                           (t.dashboard as any).feedbackPending;
              const count = gpsVisits.filter(v => v.feedback === key).length;
              if (count === 0) return null;
              return (
                <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}>
                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block' }} />
                  {label} ({count})
                </span>
              );
            })}
            <span style={{ fontSize: '12px', color: '#9ca3af', marginRight: 'auto' }}>
              {gpsVisits.length} / {visits.length} نقطة بـ GPS
            </span>
          </div>
        )}

        {/* Map or no-GPS message */}
        {gpsVisits.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '14px' }}>
            📍 {(t.dashboard as any).mapNoGps}
          </div>
        ) : (
          <div ref={mapRef} style={{ flex: 1, minHeight: 0 }} />
        )}
      </div>
    </div>
  );
}
