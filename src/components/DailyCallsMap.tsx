import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLanguage } from '../context/LanguageContext';

export interface VisitLikeUser { id: number; username: string; }
export interface VisitLikePt { id: number; userId: number; user: VisitLikeUser; }
export interface VisitCommentPt { id: number; userId: number; content: string; createdAt: string; user: VisitLikeUser; }
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
  likes?: VisitLikePt[];
  comments?: VisitCommentPt[];
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

  const getFeedbackLabel = (feedback: string) =>
    feedback === 'writing'        ? (t.dashboard as any).feedbackWriting :
    feedback === 'stocked'        ? (t.dashboard as any).feedbackStocked :
    feedback === 'interested'     ? (t.dashboard as any).feedbackInterested :
    feedback === 'not_interested' ? (t.dashboard as any).feedbackNotInterested :
    feedback === 'unavailable'    ? (t.dashboard as any).feedbackUnavailable :
                                    (t.dashboard as any).feedbackPending;

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

      const feedbackLabel = getFeedbackLabel(v.feedback);

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
        onClick={e => e.stopPropagation()}
        style={{
          width: '96vw',
          maxWidth: 1040,
          height: '88vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 28px 70px rgba(0,0,0,0.38)',
          background: '#fff',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          background: 'linear-gradient(135deg, #0f2544 0%, #1d4ed8 100%)',
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          gap: 10,
        }}>
          {/* Left: icon + title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{
              background: 'rgba(255,255,255,0.18)',
              borderRadius: 10,
              width: 42, height: 42,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, flexShrink: 0,
            }}>🗺️</div>
            <div>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>
                خريطة مسار الزيارات
              </div>
              {repName && (
                <div style={{ color: 'rgba(255,255,255,0.68)', fontSize: 12, marginTop: 3 }}>
                  👤 {repName}
                </div>
              )}
            </div>
          </div>

          {/* Right: GPS badge + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7,
              background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 20,
              padding: '5px 13px',
            }}>
              <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>نقاط GPS</span>
              <span style={{
                background: gpsVisits.length === visits.length ? '#10b981' : '#f59e0b',
                color: '#fff', borderRadius: 12, padding: '1px 9px',
                fontSize: 12, fontWeight: 700,
              }}>
                {gpsVisits.length} / {visits.length}
              </span>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'rgba(255,255,255,0.14)',
                border: '1.5px solid rgba(255,255,255,0.32)',
                color: '#fff', borderRadius: 8,
                padding: '7px 15px', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.26)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
            >
              ✕ إغلاق
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        {gpsVisits.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, color: '#94a3b8' }}>
            <div style={{ fontSize: 50 }}>📭</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>لا توجد زيارات مسجّلة بموقع GPS</div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

            {/* ── Map ── */}
            <div ref={mapRef} style={{ flex: 1, minHeight: 0 }} />

            {/* ── Sidebar ── */}
            <div style={{
              width: 282,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid #e2e8f0',
              background: '#f8fafc',
              direction: 'rtl',
            }}>
              {/* Sidebar header */}
              <div style={{
                padding: '11px 14px 10px',
                borderBottom: '1px solid #e2e8f0',
                background: '#fff',
                flexShrink: 0,
              }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a', marginBottom: 8 }}>
                  📋 قائمة الزيارات ({gpsVisits.length})
                </div>
                {/* Legend pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 7px' }}>
                  {Object.entries(feedbackColor).map(([key, color]) => {
                    const count = gpsVisits.filter(v => v.feedback === key).length;
                    if (count === 0) return null;
                    return (
                      <span key={key} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: `${color}18`,
                        border: `1px solid ${color}45`,
                        borderRadius: 12,
                        padding: '2px 8px',
                        fontSize: 11, color, fontWeight: 600,
                      }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
                        {getFeedbackLabel(key)} {count}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Visit cards */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                {gpsVisits.map((v, idx) => {
                  const color = feedbackColor[v.feedback] ?? defaultColor;
                  const timeStr = new Date(v.visitDate).toLocaleTimeString('ar-IQ-u-nu-latn', {
                    hour: '2-digit', minute: '2-digit',
                  });
                  return (
                    <div key={v.id} style={{
                      background: '#fff',
                      border: '1px solid #e2e8f0',
                      borderRadius: 10,
                      padding: '9px 11px',
                      display: 'flex',
                      gap: 9,
                      alignItems: 'flex-start',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                      transition: 'box-shadow 0.15s',
                    }}>
                      {/* Number bubble */}
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        background: color, color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 700, fontSize: 13, flexShrink: 0,
                        boxShadow: `0 2px 6px ${color}55`,
                      }}>{idx + 1}</div>

                      {/* Info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontWeight: 700, fontSize: 13, color: '#1e293b',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {v.doctor.name}
                        </div>
                        {v.doctor.specialty && (
                          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>{v.doctor.specialty}</div>
                        )}
                        {v.doctor.area && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>📍 {v.doctor.area.name}</div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 4 }}>
                          <span style={{
                            background: color, color: '#fff',
                            borderRadius: 6, padding: '2px 8px',
                            fontSize: 11, fontWeight: 600,
                          }}>
                            {getFeedbackLabel(v.feedback)}
                          </span>
                          <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>🕐 {timeStr}</span>
                        </div>
                        {v.item && (
                          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>💊 {v.item.name}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
