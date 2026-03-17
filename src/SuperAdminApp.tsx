import { useState, useEffect } from 'react';
import { SuperAdminProvider, useSuperAdmin } from './context/SuperAdminContext';
import SuperAdminLogin from './pages/super-admin/SuperAdminLogin';
import OfficesPage from './pages/super-admin/OfficesPage';
import CompaniesPage from './pages/super-admin/CompaniesPage';
import UsersPage from './pages/super-admin/UsersPage';
import SuperAdminsPage from './pages/super-admin/SuperAdminsPage';
import VisitsPage from './pages/super-admin/VisitsPage';
import MasterSurveyPage from './pages/super-admin/MasterSurveyPage';

type Page = 'offices' | 'companies' | 'users' | 'super-admins' | 'visits' | 'surveys';

const NAV: { id: Page; label: string; icon: string; color: string; glow: string; masterOnly?: boolean }[] = [
  { id: 'offices',      label: 'المكاتب',    icon: '🏢', color: '#06b6d4', glow: 'rgba(6,182,212,0.35)' },
  { id: 'companies',    label: 'الشركات',    icon: '🏭', color: '#8b5cf6', glow: 'rgba(139,92,246,0.35)' },
  { id: 'users',        label: 'المستخدمون', icon: '👥', color: '#10b981', glow: 'rgba(16,185,129,0.35)' },
  { id: 'super-admins', label: 'المشرفون',   icon: '🛡️', color: '#f59e0b', glow: 'rgba(245,158,11,0.35)', masterOnly: true },
  { id: 'visits',       label: 'الزيارات',    icon: '📋', color: '#e11d48', glow: 'rgba(225,29,72,0.35)',  masterOnly: true },
  { id: 'surveys',      label: 'السيرفيات',   icon: '🗂️', color: '#f97316', glow: 'rgba(249,115,22,0.35)', masterOnly: true },
];

interface SAStats { offices: number; companies: number; users: number; }

function StatsBar({ token }: { token: string }) {
  const [stats, setStats] = useState<SAStats>({ offices: 0, companies: 0, users: 0 });
  const H = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    Promise.all([
      fetch('/api/sa/offices',   { headers: H }).then(r => r.json()),
      fetch('/api/sa/companies', { headers: H }).then(r => r.json()),
      fetch('/api/sa/users',     { headers: H }).then(r => r.json()),
    ]).then(([o, c, u]) => setStats({
      offices:   Array.isArray(o.data) ? o.data.length : 0,
      companies: Array.isArray(c.data) ? c.data.length : 0,
      users:     Array.isArray(u.data) ? u.data.length : 0,
    })).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const cards = [
    { label: 'مكتب',      value: stats.offices,   icon: '🏢', color: '#06b6d4', bg: 'rgba(6,182,212,0.1)',   border: 'rgba(6,182,212,0.25)'   },
    { label: 'شركة',      value: stats.companies, icon: '🏭', color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)',  border: 'rgba(139,92,246,0.25)'  },
    { label: 'مستخدم',   value: stats.users,     icon: '👥', color: '#10b981', bg: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.25)'  },
  ];

  return (
    <div style={{ display: 'flex', gap: 10, padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
      {cards.map(s => (
        <div key={s.label} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: s.bg, border: `1.5px solid ${s.border}`,
          borderRadius: 14, padding: '8px 18px', flexShrink: 0,
          boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          cursor: 'default',
        }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: `${s.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{s.icon}</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 500 }}>{s.label}</div>
          </div>
        </div>
      ))}
      <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1.5px solid #bbf7d0', borderRadius: 20, padding: '5px 14px' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', animation: 'saPulse 2s infinite' }} />
          <span style={{ fontSize: 11, color: '#15803d', fontWeight: 700 }}>نشط</span>
        </div>
      </div>
    </div>
  );
}

function SuperAdminShell() {
  const { admin, logout, token } = useSuperAdmin();
  const [page,          setPage]          = useState<Page>(() => (localStorage.getItem('sa_last_page') as Page) || 'offices');
  const [collapsed,      setCollapsed]      = useState(false);
  const [jumpUserId,     setJumpUserId]     = useState<number | null>(null);

  useEffect(() => { localStorage.setItem('sa_last_page', page); }, [page]);

  if (!admin || !token) return <SuperAdminLogin />;

  const visibleNav = NAV.filter(n => !n.masterOnly || admin.isMaster);
  const activeMeta = NAV.find(n => n.id === page) ?? NAV[0];

  return (
    <div style={{
      display: 'flex', height: '100vh',
      fontFamily: '"Segoe UI", Tahoma, "Arial", sans-serif',
      direction: 'rtl', overflow: 'hidden',
      background: '#f1f5fb',
    }}>

      {/* ── Sidebar ───────────────────────────────────────── */}
      <aside style={{
        width: collapsed ? 68 : 256,
        background: 'linear-gradient(175deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)',
        borderLeft: '1px solid rgba(165,180,252,0.15)',
        display: 'flex', flexDirection: 'column',
        transition: 'width .25s cubic-bezier(.4,0,.2,1)',
        overflow: 'hidden', flexShrink: 0,
        boxShadow: '4px 0 32px rgba(30,27,75,0.35)',
        position: 'relative', zIndex: 10,
      }}>

        {/* Logo */}
        <div style={{
          padding: collapsed ? '20px 14px' : '20px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.10)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: 'linear-gradient(135deg, #818cf8 0%, #6366f1 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, boxShadow: '0 4px 16px rgba(99,102,241,0.5)',
          }}>🛡️</div>
          {!collapsed && (
            <div>
              <div style={{
                fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap',
                color: '#e0e7ff',
              }}>لوحة التحكم</div>
              <div style={{ fontSize: 10, color: '#a5b4fc', whiteSpace: 'nowrap', marginTop: 2, letterSpacing: 1.5, fontWeight: 600 }}>SUPER ADMIN</div>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '14px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {visibleNav.map(n => {
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => setPage(n.id)} title={collapsed ? n.label : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', padding: collapsed ? '12px 0' : '11px 14px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                borderRadius: 12, border: 'none', cursor: 'pointer', marginBottom: 4,
                background: active
                  ? 'rgba(255,255,255,0.15)'
                  : 'transparent',
                boxShadow: active ? '0 2px 12px rgba(0,0,0,0.15)' : 'none',
                transition: 'all .18s', overflow: 'hidden',
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                  background: active ? `linear-gradient(135deg, ${n.color}, ${n.color}cc)` : 'rgba(255,255,255,0.08)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 17,
                  boxShadow: active ? `0 4px 12px ${n.glow}` : 'none',
                  transition: 'all .18s',
                }}>{n.icon}</div>
                {!collapsed && (
                  <span style={{
                    fontSize: 13, fontWeight: active ? 700 : 500,
                    color: active ? '#fff' : '#a5b4fc',
                    whiteSpace: 'nowrap', transition: 'color .18s',
                  }}>{n.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User card + logout */}
        <div style={{ padding: '10px 8px', borderTop: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
          {!collapsed && (
            <div style={{
              padding: '11px 13px', marginBottom: 8, borderRadius: 12,
              background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  background: admin.isMaster
                    ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                    : 'linear-gradient(135deg, #818cf8, #6366f1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17,
                  boxShadow: '0 3px 10px rgba(0,0,0,0.25)',
                }}>{admin.isMaster ? '👑' : '🛡️'}</div>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e0e7ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{admin.username}</div>
                  <div style={{ fontSize: 10, color: admin.isMaster ? '#fcd34d' : '#a5b4fc', marginTop: 2, fontWeight: 600 }}>
                    {admin.isMaster ? '👑 Master Admin' : '🛡️ Super Admin'}
                  </div>
                </div>
              </div>
            </div>
          )}
          <button onClick={logout} title="تسجيل خروج" style={{
            display: 'flex', alignItems: 'center', gap: 9,
            justifyContent: collapsed ? 'center' : 'flex-start',
            width: '100%', padding: '9px 12px', borderRadius: 11,
            border: '1px solid rgba(252,165,165,0.25)',
            cursor: 'pointer', background: 'rgba(239,68,68,0.12)',
            color: '#fca5a5', fontSize: 13, fontWeight: 600, transition: 'all .2s',
          }}>
            <span>🚪</span>
            {!collapsed && <span>تسجيل خروج</span>}
          </button>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Header */}
        <header style={{
          height: 62, flexShrink: 0,
          background: '#ffffff',
          borderBottom: '1px solid #e8edf5',
          padding: '0 24px',
          display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 1px 6px rgba(99,102,241,0.07)',
        }}>
          <button onClick={() => setCollapsed(c => !c)} style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: '#f1f5f9', border: '1.5px solid #e2e8f0',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 15, transition: 'all .2s',
          }}>☰</button>

          {/* Page indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10, flexShrink: 0,
              background: `linear-gradient(135deg, ${activeMeta.color}20, ${activeMeta.color}10)`,
              border: `1.5px solid ${activeMeta.color}30`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17,
            }}>{activeMeta.icon}</div>
            <span style={{ fontWeight: 800, fontSize: 16, color: '#1e1b4b' }}>{activeMeta.label}</span>
          </div>

          {/* Right side: date */}
          <div style={{ marginRight: 'auto', fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>
            {new Date().toLocaleDateString('ar-IQ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </header>

        {/* Stats bar */}
        <StatsBar token={token} />

        {/* Page content */}
        <main style={{
          flex: 1, overflowY: 'auto', padding: 24,
          background: '#f1f5fb',
        }}>
          <div style={{
            background: '#ffffff',
            border: '1px solid #e8edf5',
            borderRadius: 18, padding: 24, minHeight: '100%',
            boxShadow: '0 2px 16px rgba(99,102,241,0.06)',
          }}>
            {page === 'offices'      && <OfficesPage />}
            {page === 'companies'    && <CompaniesPage onOpenUser={id => { setJumpUserId(id); setPage('users'); }} />}
            {page === 'users'        && <UsersPage jumpUserId={jumpUserId} onJumpClear={() => setJumpUserId(null)} />}
            {page === 'super-admins' && <SuperAdminsPage />}
            {page === 'visits'       && <VisitsPage />}
            {page === 'surveys'      && <MasterSurveyPage />}
          </div>
        </main>
      </div>

      <style>{`
        @keyframes saPulse { 0%,100%{opacity:1;} 50%{opacity:.3;} }
        aside nav button:hover { background: rgba(255,255,255,0.12) !important; }
      `}</style>
    </div>
  );
}

export default function SuperAdminApp() {
  return (
    <SuperAdminProvider>
      <SuperAdminShell />
    </SuperAdminProvider>
  );
}
