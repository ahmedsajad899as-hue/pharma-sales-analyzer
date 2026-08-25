import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Notif {
  id: number; type: string; title: string; body: string;
  isRead: boolean; data?: string | null; createdAt: string;
}

interface AlertItem {
  pharmacy: string; item: string; area: string | null; days: number; lastOrder?: string | null;
}
interface AlertData {
  thresholdDays: number; count: number; items: AlertItem[];
}

/** يحاول قراءة تفاصيل تنبيه «صيدليات متأخرة» المُهيكلة من n.data — غير ذلك يُعرض كنص عادي. */
function parseAlertData(n: Notif): AlertData | null {
  if (n.type !== 'pharmacy_overdue' || !n.data) return null;
  try {
    const d = JSON.parse(n.data);
    if (!Array.isArray(d.items)) return null;
    return { thresholdDays: d.thresholdDays ?? 30, count: d.count ?? d.items.length, items: d.items };
  } catch { return null; }
}

/** يجمع الصيدليات حسب المنطقة، ويرتّب المناطق والصيدليات من الأكثر تأخراً للأقل. */
function groupByArea(items: AlertItem[]) {
  const map = new Map<string, AlertItem[]>();
  for (const it of items) {
    const key = it.area || 'بدون منطقة';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return [...map.entries()]
    .map(([area, list]) => ({ area, list: [...list].sort((a, b) => b.days - a.days) }))
    .sort((a, b) => b.list[0].days - a.list[0].days);
}

function severityColor(days: number, threshold: number) {
  if (days >= threshold * 2)   return '#dc2626';
  if (days >= threshold * 1.3) return '#f97316';
  return '#ca8a04';
}

/**
 * جرس الإشعارات داخل التطبيق.
 *
 * كانت الإشعارات (AppNotification) تُقرأ من /api/commercial/notifications فقط،
 * فلا يراها إلا المندوب التجاري. هذا المكوّن يقرأ النقطة العامة
 * /api/notifications ليصل تنبيه الصيدليات المتأخرة لأي مستخدم.
 *
 * تنبيهات الصيدليات المتأخرة (pharmacy_overdue) كانت تُعرض كنص خام واحد (بوليتات
 * مدمجة بلا فواصل واضحة، وأسماء إيتمات إنجليزية تختلط مع أسماء صيدليات عربية
 * فتنعكس اتجاهات النص) — الآن تُقرأ من data.items المُهيكلة وتُعرض مجمّعة حسب
 * المنطقة ومرتّبة من الأكثر تأخراً، مع طي/فتح لكل إشعار حتى لا تُغرق الإشعارات
 * ذات مئات الصيدليات القائمة بجدار نص واحد.
 */
export default function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { token } = useAuth();
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    fetch(`${API}/api/notifications?limit=30`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success) { setItems(d.data || []); setUnread(d.unread || 0); } })
      .catch(() => { /* الشبكة متقطّعة — الجرس ليس حرجاً */ });
  }, [token]);

  // فحص دوري خفيف: الإشعارات تُولَّد من مُجدوِل في السيرفر لا من فعل المستخدم،
  // فبدون استعلام دوري لن تظهر إلا بعد إعادة تحميل الصفحة.
  useEffect(() => {
    load();
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [load]);

  // إغلاق عند النقر خارج القائمة
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const markRead = async (id: number | 'all') => {
    try {
      const r = await fetch(`${API}/api/notifications/${id}/read`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (d.success) {
        setUnread(d.unread ?? 0);
        setItems(prev => prev.map(n => (id === 'all' || n.id === id ? { ...n, isRead: true } : n)));
      }
    } catch { /* تجاهل */ }
  };

  const toggleExpand = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!token) return null;

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        title="الإشعارات"
        style={{
          position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: compact ? 18 : 20, lineHeight: 1, padding: 4,
        }}
      >
        🔔
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 0, insetInlineEnd: 0, background: '#dc2626', color: '#fff',
            borderRadius: 10, fontSize: 10, fontWeight: 800, padding: '0 5px', minWidth: 16,
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', insetInlineEnd: 0, top: '110%', width: 'min(400px, 92vw)',
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
          boxShadow: '0 18px 40px rgba(15,23,42,0.18)', zIndex: 3000, direction: 'rtl',
          maxHeight: 460, overflowY: 'auto',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid #eef2f7', position: 'sticky', top: 0, background: '#fff',
          }}>
            <strong style={{ fontSize: 13, color: '#0f172a' }}>الإشعارات</strong>
            {unread > 0 && (
              <button onClick={() => markRead('all')}
                style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 11 }}>
                تعليم الكل كمقروء
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>لا توجد إشعارات</div>
          ) : items.map(n => {
            const alert = parseAlertData(n);
            const isOpen = expanded.has(n.id);
            const groups = alert ? groupByArea(alert.items) : [];
            return (
              <div key={n.id} style={{ borderBottom: '1px solid #f1f5f9', background: n.isRead ? '#fff' : '#eff6ff' }}>
                <div
                  onClick={() => { if (!n.isRead) markRead(n.id); if (alert) toggleExpand(n.id); }}
                  style={{ padding: '10px 12px', cursor: (alert || !n.isRead) ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{n.title}</div>
                    {alert && <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0, marginTop: 1 }}>{isOpen ? '▲ إخفاء' : '▼ تفاصيل'}</span>}
                  </div>

                  {!alert && (
                    <div style={{ fontSize: 11, color: '#475569', whiteSpace: 'pre-line', lineHeight: 1.6 }}>{n.body}</div>
                  )}
                  {alert && !isOpen && (
                    <div style={{ fontSize: 11, color: '#64748b' }}>
                      أعلى المناطق تأخراً: {groups.slice(0, 3).map(g => `${g.area} (${g.list.length})`).join('، ')}
                      {groups.length > 3 && ' …'}
                    </div>
                  )}

                  <div style={{ fontSize: 10, color: '#94a3b8' }}>
                    {new Date(n.createdAt).toLocaleString('ar-IQ')}
                  </div>
                </div>

                {alert && isOpen && (
                  <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {groups.map(g => (
                      <div key={g.area} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 8px' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', marginBottom: 5 }}>
                          📍 {g.area} <span style={{ color: '#94a3b8', fontWeight: 500 }}>({g.list.length})</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {g.list.map((it, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
                              <span style={{
                                background: severityColor(it.days, alert.thresholdDays), color: '#fff', borderRadius: 6,
                                padding: '1px 6px', fontSize: 10, fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap',
                              }}>{it.days} يوم</span>
                              <span style={{ color: '#0f172a', fontWeight: 600 }}>{it.pharmacy}</span>
                              <span style={{ color: '#cbd5e1' }}>—</span>
                              {/* dir="ltr" يعزل اسم الإيتم الإنجليزي حتى لا ينعكس مع النص العربي المجاور */}
                              <span dir="ltr" style={{ color: '#64748b', unicodeBidi: 'isolate' }}>{it.item}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {alert.count > alert.items.length && (
                      <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', padding: '2px 0' }}>
                        و{alert.count - alert.items.length} صيدلية أخرى غير معروضة هنا (تُعرض أول 50 فقط)
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
