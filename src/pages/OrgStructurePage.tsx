import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { OrgTree, ROLE_META, DEF_META } from '../components/OrgTree';
import type { OrgUser } from '../components/OrgTree';

export default function OrgStructurePage() {
  const { token } = useAuth();
  const [users, setUsers]     = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [sel, setSel]         = useState<OrgUser | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/my-company-org', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => {
        if (j.success) setUsers(j.data?.users ?? []);
        else setError(j.error || 'فشل تحميل الهيكلية');
      })
      .catch(() => setError('تعذّر الاتصال بالخادم'))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🏗️</span>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1e293b' }}>الهيكلية</h2>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            الهيكل التنظيمي للشركة {users.length > 0 && `· ${users.length} مستخدم`}
          </div>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16, overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0' }}>⏳ جاري التحميل...</div>
        ) : error ? (
          <div style={{ textAlign: 'center', color: '#dc2626', padding: '40px 0' }}>{error}</div>
        ) : (
          <OrgTree users={users} onSelect={setSel} />
        )}
      </div>

      {/* User detail popup */}
      {sel && (() => {
        const m = ROLE_META[sel.role] ?? DEF_META;
        const managers = users.filter(u => sel.managerIds.includes(u.id));
        const subs     = users.filter(u => sel.subordinateIds.includes(u.id));
        return (
          <div onClick={() => setSel(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 28, minWidth: 320, maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', position: 'relative', direction: 'rtl' }}>
              <button onClick={() => setSel(null)} style={{ position: 'absolute', top: 12, left: 16, background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>✕</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: m.bg, border: `2px solid ${m.color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>{m.icon}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 18, color: '#1e293b' }}>{sel.displayName || sel.username}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>@{sel.username}</div>
                </div>
                <span style={{ marginRight: 'auto', background: m.bg, color: m.color, border: `1px solid ${m.color}33`, borderRadius: 20, padding: '3px 12px', fontSize: 12, fontWeight: 600 }}>{m.label}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {([
                  ['الحالة', sel.isActive ? '✅ نشط' : '❌ معطل'],
                  sel.phone ? ['الهاتف', sel.phone] : null,
                  managers.length > 0 ? ['المدير', managers.map(u => u.displayName || u.username).join('، ')] : null,
                  subs.length     > 0 ? ['المرؤوسون', subs.map(u => u.displayName || u.username).join('، ')] : null,
                ].filter((x): x is string[] => x !== null)).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>
                    <span style={{ color: '#64748b', fontWeight: 600, minWidth: 80 }}>{label}</span>
                    <span style={{ color: '#1e293b' }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
