import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Notif {
  id: number; type: string; title: string; body: string;
  isRead: boolean; data?: string | null; createdAt: string;
}

/**
 * جرس الإشعارات داخل التطبيق.
 *
 * كانت الإشعارات (AppNotification) تُقرأ من /api/commercial/notifications فقط،
 * فلا يراها إلا المندوب التجاري. هذا المكوّن يقرأ النقطة العامة
 * /api/notifications ليصل تنبيه الصيدليات المتأخرة لأي مستخدم.
 */
export default function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { token } = useAuth();
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
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
          position: 'absolute', insetInlineEnd: 0, top: '110%', width: 'min(360px, 88vw)',
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
          boxShadow: '0 18px 40px rgba(15,23,42,0.18)', zIndex: 3000, direction: 'rtl',
          maxHeight: 420, overflowY: 'auto',
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
          ) : items.map(n => (
            <div key={n.id}
              onClick={() => !n.isRead && markRead(n.id)}
              style={{
                padding: '10px 12px', borderBottom: '1px solid #f1f5f9',
                background: n.isRead ? '#fff' : '#eff6ff', cursor: n.isRead ? 'default' : 'pointer',
              }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{n.title}</div>
              <div style={{ fontSize: 11, color: '#475569', whiteSpace: 'pre-line', lineHeight: 1.6 }}>{n.body}</div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                {new Date(n.createdAt).toLocaleString('ar-IQ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
