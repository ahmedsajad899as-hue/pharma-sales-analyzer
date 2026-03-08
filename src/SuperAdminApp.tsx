import { useState } from 'react';
import { SuperAdminProvider, useSuperAdmin } from './context/SuperAdminContext';
import SuperAdminLogin from './pages/super-admin/SuperAdminLogin';
import OfficesPage from './pages/super-admin/OfficesPage';
import CompaniesPage from './pages/super-admin/CompaniesPage';
import UsersPage from './pages/super-admin/UsersPage';
import SuperAdminsPage from './pages/super-admin/SuperAdminsPage';

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
