import { useState } from 'react';
import type { PageId } from '../../App';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

interface SidebarProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  isOpen: boolean;
  onToggle: () => void;
  activeFileIds?: number[];
}

export default function Sidebar({ activePage, onNavigate, isOpen, onToggle, activeFileIds = [] }: SidebarProps) {
  const { user, logout, isAdmin, isManager, isManagerOrAdmin } = useAuth();
  const { t, toggleLang, lang } = useLanguage();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const role = user?.role ?? 'user';

  const navItems: { id: PageId; label: string; icon: string; roles: string[] }[] = [
    { id: 'dashboard',       label: t.nav.dashboard,       icon: '📊', roles: ['admin'] },
    { id: 'upload',          label: t.nav.upload,          icon: '📤', roles: ['admin'] },
    { id: 'representatives', label: t.nav.representatives, icon: '💰', roles: ['admin'] },
    { id: 'scientific-reps', label: t.nav.scientificReps,  icon: '🔬', roles: ['admin', 'manager'] },
    { id: 'doctors',         label: t.nav.doctors,         icon: '🏥', roles: ['admin', 'manager'] },
    { id: 'monthly-plans',   label: t.nav.monthlyPlans,    icon: '📅', roles: ['admin', 'manager', 'user'] },
    { id: 'reports',         label: t.nav.reports,         icon: '📋', roles: ['admin'] },
    { id: 'users',           label: t.nav.users,           icon: '👥', roles: ['admin'] },
  ];

  const visibleItems = navItems.filter(item => item.roles.includes(role));

  const roleLabel = role === 'admin' ? t.sidebar.admin
    : role === 'manager' ? 'مدير الفريق'
    : t.sidebar.user;
  const roleIcon = role === 'admin' ? '👑' : role === 'manager' ? '🛡️' : '👤';

  const LangToggleBtn = ({ full }: { full?: boolean }) => (
    <button
      onClick={toggleLang}
      title={t.toggleLang}
      style={{
        background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: 8,
        padding: full ? '6px 14px' : '6px',
        fontSize: full ? 13 : 12,
        color: '#e2e8f0',
        cursor: 'pointer',
        fontWeight: 700,
        letterSpacing: '0.03em',
        width: full ? '100%' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}
    >
      🌐 {full ? t.toggleLang : lang === 'ar' ? 'EN' : 'ع'}
    </button>
  );


  const handleMobileNavigate = (id: PageId) => {
    onNavigate(id);
    setMobileMenuOpen(false);
  };

  return (
    <>
      {/* ── DESKTOP SIDEBAR ── */}
      <aside className={`sidebar sidebar--desktop ${isOpen ? 'sidebar--open' : 'sidebar--closed'}`}>
        <div className="sidebar-brand">
          <span className="sidebar-brand-icon">💊</span>
          {isOpen && <span className="sidebar-brand-text">{t.appName}</span>}
          <button className="sidebar-toggle" onClick={onToggle} title={t.sidebar.collapse}>
            {isOpen ? (lang === 'ar' ? '◀' : '▶') : (lang === 'ar' ? '▶' : '◀')}
          </button>
        </div>

        <nav className="sidebar-nav">
          {visibleItems.map(item => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`sidebar-nav-item ${activePage === item.id ? 'sidebar-nav-item--active' : ''}`}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              {isOpen && <span className="sidebar-nav-label">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer" style={{ marginTop: 'auto' }}>
          {isOpen ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>{roleIcon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0' }}>{user?.username}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {roleLabel}
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <LangToggleBtn full />
              </div>
              <button className="btn btn--secondary" style={{ width: '100%', fontSize: 13 }} onClick={logout}>
                🚪 {t.sidebar.logout}
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
              <LangToggleBtn />
              <button className="sidebar-nav-item" onClick={logout} title={t.sidebar.logout} style={{ width: '100%' }}>
                <span className="sidebar-nav-icon">🚪</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── MOBILE TOP HEADER ── */}
      <header className="mobile-header">
        <div className="mobile-header-brand">
          <span style={{ fontSize: 22 }}>💊</span>
          <span className="mobile-header-title">{t.appName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={toggleLang}
            style={{
              background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 6,
              padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#334155', cursor: 'pointer',
            }}
          >
            🌐 {lang === 'ar' ? 'EN' : 'ع'}
          </button>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>
            {roleIcon} {user?.username}
          </span>
          <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(true)} title="menu">
            ☰
          </button>
        </div>
      </header>

      {/* ── MOBILE BOTTOM NAV ── */}
      <nav className="mobile-bottom-nav">
        {visibleItems.slice(0, 5).map(item => (
          <button
            key={item.id}
            onClick={() => handleMobileNavigate(item.id)}
            className={`mobile-nav-item ${activePage === item.id ? 'mobile-nav-item--active' : ''}`}
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span className="mobile-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* ── MOBILE SLIDE-IN MENU (drawer) ── */}
      {mobileMenuOpen && (
        <div className="mobile-drawer-overlay" onClick={() => setMobileMenuOpen(false)}>
          <div className="mobile-drawer" onClick={e => e.stopPropagation()}>
            <div className="mobile-drawer-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 26 }}>💊</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{t.appName}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {user?.username} · {roleLabel}
                  </div>
                </div>
              </div>
              <button className="mobile-drawer-close" onClick={() => setMobileMenuOpen(false)}>✕</button>
            </div>
            <nav className="mobile-drawer-nav">
              {visibleItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => handleMobileNavigate(item.id)}
                  className={`mobile-drawer-item ${activePage === item.id ? 'mobile-drawer-item--active' : ''}`}
                >
                  <span style={{ fontSize: 20 }}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => { toggleLang(); setMobileMenuOpen(false); }}
                style={{
                  background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 8,
                  padding: '8px 14px', fontSize: 13, fontWeight: 700, color: '#334155',
                  cursor: 'pointer', width: '100%', textAlign: 'center',
                }}
              >
                🌐 {t.toggleLang}
              </button>
              <button
                className="btn btn--secondary"
                style={{ width: '100%', fontSize: 14 }}
                onClick={() => { logout(); setMobileMenuOpen(false); }}
              >
                🚪 {t.sidebar.logout}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
