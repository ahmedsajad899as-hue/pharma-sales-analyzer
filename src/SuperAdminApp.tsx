import { useState, useEffect } from 'react';
import { SuperAdminProvider, useSuperAdmin } from './context/SuperAdminContext';
import SuperAdminLogin from './pages/super-admin/SuperAdminLogin';
import OfficesPage from './pages/super-admin/OfficesPage';
import CompaniesPage from './pages/super-admin/CompaniesPage';
import UsersPage from './pages/super-admin/UsersPage';
import SuperAdminsPage from './pages/super-admin/SuperAdminsPage';

type Page = 'offices' | 'companies' | 'users' | 'super-admins';

const NAV: { id: Page; label: string; icon: string; color: string; glow: string; masterOnly?: boolean }[] = [
  { id: 'offices',      label: 'المكاتب',    icon: '🏢', color: '#06b6d4', glow: 'rgba(6,182,212,0.35)' },
  { id: 'companies',    label: 'الشركات',    icon: '🏭', color: '#8b5cf6', glow: 'rgba(139,92,246,0.35)' },
  { id: 'users',        label: 'المستخدمون', icon: '👥', color: '#10b981', glow: 'rgba(16,185,129,0.35)' },
  { id: 'super-admins', label: 'المشرفون',   icon: '🛡️', color: '#f59e0b', glow: 'rgba(245,158,11,0.35)', masterOnly: true },
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
          background: s.bg, border: `1px solid ${s.border}`,
          borderRadius: 10, padding: '7px 14px', flexShrink: 0,
          transition: 'transform .2s',
        }}>
          <span style={{ fontSize: 16 }}>{s.icon}</span>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{s.label}</div>
          </div>
        </div>
      ))}
      <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981', animation: 'saPulse 2s infinite' }} />
          <span style={{ fontSize: 11, color: '#475569' }}>نشط</span>
        </div>
      </div>
    </div>
  );
}

function SuperAdminShell() {
  const { admin, logout, token } = useSuperAdmin();
  const [page, setPage] = useState<Page>('offices');
  const [collapsed, setCollapsed] = useState(false);

  if (!admin || !token) return <SuperAdminLogin />;

  const visibleNav = NAV.filter(n => !n.masterOnly || admin.isMaster);
  const activeMeta = NAV.find(n => n.id === page) ?? NAV[0];

  return (
    <div style={{
      display: 'flex', height: '100vh',
      fontFamily: '"Segoe UI", Tahoma, "Arial", sans-serif',
      direction: 'rtl', overflow: 'hidden',
      background: '#080c18',
    }}>

      {/* ── Sidebar ───────────────────────────────────────── */}
      <aside style={{
        width: collapsed ? 64 : 252,
        background: 'linear-gradient(180deg, #0c1220 0%, #090d1b 100%)',
        borderLeft: '1px solid rgba(99,102,241,0.18)',
        display: 'flex', flexDirection: 'column',
        transition: 'width .25s cubic-bezier(.4,0,.2,1)',
        overflow: 'hidden', flexShrink: 0,
        boxShadow: '-4px 0 40px rgba(0,0,0,0.6)',
        position: 'relative', zIndex: 10,
      }}>

        {/* Logo */}
        <div style={{
          padding: collapsed ? '22px 14px' : '22px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 11, flexShrink: 0,
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 19, boxShadow: '0 4px 18px rgba(99,102,241,0.55)',
          }}>🛡️</div>
          {!collapsed && (
            <div>
              <div style={{
                fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap',
                background: 'linear-gradient(90deg, #a5b4fc, #818cf8)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>لوحة التحكم</div>
              <div style={{ fontSize: 10, color: '#334155', whiteSpace: 'nowrap', marginTop: 1, letterSpacing: 1 }}>SUPER ADMIN</div>
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
                width: '100%', padding: collapsed ? '11px 0' : '10px 13px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                borderRadius: 11, border: 'none', cursor: 'pointer', marginBottom: 3,
                background: active
                  ? `linear-gradient(135deg, ${n.color}1a, ${n.color}0d)`
                  : 'transparent',
                borderRight: active ? `3px solid ${n.color}` : '3px solid transparent',
                boxShadow: active ? `inset 0 0 18px ${n.glow}, 0 0 12px ${n.glow}` : 'none',
                transition: 'all .18s', overflow: 'hidden',
              }}>
                <span style={{
                  fontSize: 19, flexShrink: 0,
                  filter: active ? `drop-shadow(0 0 6px ${n.color})` : 'grayscale(1) brightness(0.45)',
                  transition: 'filter .18s',
                }}>{n.icon}</span>
                {!collapsed && (
                  <span style={{
                    fontSize: 13, fontWeight: active ? 700 : 500,
                    color: active ? n.color : '#475569',
                    whiteSpace: 'nowrap', transition: 'color .18s',
                  }}>{n.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User card + logout */}
        <div style={{ padding: '10px 8px', borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          {!collapsed && (
            <div style={{
              padding: '10px 12px', marginBottom: 8, borderRadius: 10,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                  background: admin.isMaster
                    ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                    : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
                }}>{admin.isMaster ? '👑' : '🛡️'}</div>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{admin.username}</div>
                  <div style={{ fontSize: 10, color: admin.isMaster ? '#fbbf24' : '#818cf8', marginTop: 1 }}>
                    {admin.isMaster ? '👑 Master Admin' : '🛡️ Super Admin'}
                  </div>
                </div>
              </div>
            </div>
          )}
          <button onClick={logout} title="تسجيل خروج" style={{
            display: 'flex', alignItems: 'center', gap: 9,
            justifyContent: collapsed ? 'center' : 'flex-start',
            width: '100%', padding: '9px 12px', borderRadius: 10,
            border: '1px solid rgba(239,68,68,0.18)',
            cursor: 'pointer', background: 'rgba(239,68,68,0.07)',
            color: '#f87171', fontSize: 13, fontWeight: 600, transition: 'all .2s',
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
          height: 58, flexShrink: 0,
          background: 'rgba(8,12,24,0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          backdropFilter: 'blur(12px)',
          padding: '0 24px',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <button onClick={() => setCollapsed(c => !c)} style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 15, transition: 'all .2s',
          }}>☰</button>

          {/* Page indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: `linear-gradient(135deg, ${activeMeta.color}22, ${activeMeta.color}11)`,
              border: `1px solid ${activeMeta.color}33`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
              boxShadow: `0 0 12px ${activeMeta.glow}`,
            }}>{activeMeta.icon}</div>
            <span style={{ fontWeight: 700, fontSize: 15, color: activeMeta.color }}>{activeMeta.label}</span>
          </div>

          {/* Right side: date */}
          <div style={{ marginRight: 'auto', fontSize: 12, color: '#334155' }}>
            {new Date().toLocaleDateString('ar-IQ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </header>

        {/* Stats bar */}
        <StatsBar token={token} />

        {/* Page content */}
        <main style={{
          flex: 1, overflowY: 'auto', padding: 24,
          background: 'radial-gradient(ellipse 80% 40% at 80% 0%, rgba(99,102,241,0.06) 0%, transparent 60%), #080c18',
        }}>
          <div style={{
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 16, padding: 22, minHeight: '100%',
          }}>
            {page === 'offices'      && <OfficesPage />}
            {page === 'companies'    && <CompaniesPage />}
            {page === 'users'        && <UsersPage />}
            {page === 'super-admins' && <SuperAdminsPage />}
          </div>
        </main>
      </div>

      <style>{`
        @keyframes saPulse { 0%,100%{opacity:1;box-shadow:0 0 8px #10b981;} 50%{opacity:.4;box-shadow:0 0 3px #10b981;} }
        aside button:hover { background: rgba(255,255,255,0.06) !important; }
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

type Page = 'offices' | 'companies' | 'users' | 'super-admins';

const NAV: { id: Page; label: string; icon: string; masterOnly?: boolean }[] = [
  { id: 'offices',      label: 'المكاتب',    icon: '🏢' },
  { id: 'companies',    label: 'الشركات',    icon: '🏭' },
  { id: 'users',        label: 'المستخدمون', icon: '👥' },
  { id: 'super-admins', label: 'المشرفون',   icon: '🛡️', masterOnly: true },
];

function SuperAdminShell() {
  const { admin, logout } = useSuperAdmin();
  const [page, setPage] = useState<Page>('offices');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  if (!admin) return <SuperAdminLogin />;

  const visibleNav = NAV.filter(n => !n.masterOnly || admin.isMaster);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Segoe UI, Tahoma, sans-serif', direction: 'rtl', background: '#f8fafc' }}>
      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? 240 : 60,
        background: '#0f172a',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .2s',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: '20px 16px', borderBottom: '1px solid rgba(255,255,255,.08)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>🛡️</span>
          {sidebarOpen && <span style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap' }}>لوحة التحكم</span>}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '12px 8px' }}>
          {visibleNav.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
                cursor: 'pointer', marginBottom: 4, textAlign: 'right',
                background: page === n.id ? 'rgba(255,255,255,.12)' : 'transparent',
                color: page === n.id ? '#fff' : '#94a3b8',
                fontSize: 14, fontWeight: page === n.id ? 600 : 400,
                transition: 'all .15s',
              }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{n.icon}</span>
              {sidebarOpen && <span style={{ whiteSpace: 'nowrap' }}>{n.label}</span>}
            </button>
          ))}
        </nav>

        {/* User + logout */}
        <div style={{ padding: '12px 8px', borderTop: '1px solid rgba(255,255,255,.08)' }}>
          {sidebarOpen && (
            <div style={{ padding: '8px 12px', marginBottom: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>{admin.username}</div>
              {admin.isMaster && <div style={{ fontSize: 11, color: '#fbbf24' }}>👑 ماستر</div>}
            </div>
          )}
          <button onClick={logout} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
            cursor: 'pointer', background: 'rgba(239,68,68,.15)', color: '#fca5a5',
            fontSize: 14, fontWeight: 600,
          }}>
            <span style={{ flexShrink: 0 }}>🚪</span>
            {sidebarOpen && <span>تسجيل خروج</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <header style={{
          background: '#fff', borderBottom: '1px solid #e2e8f0',
          padding: '0 24px', height: 60, display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <button onClick={() => setSidebarOpen(o => !o)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#64748b' }}>
            ☰
          </button>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>
            {visibleNav.find(n => n.id === page)?.icon} {visibleNav.find(n => n.id === page)?.label}
          </span>
        </header>

        {/* Content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
          {page === 'offices'      && <OfficesPage />}
          {page === 'companies'    && <CompaniesPage />}
          {page === 'users'        && <UsersPage />}
          {page === 'super-admins' && <SuperAdminsPage />}
        </main>
      </div>
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
