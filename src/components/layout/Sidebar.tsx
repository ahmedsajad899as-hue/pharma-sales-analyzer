import { useState } from 'react';
import type { PageId } from '../../App';
import { useAuth } from '../../context/AuthContext';
import type { SavedAccount } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

function OrdineLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="28" rx="6" fill="#8B1A1A"/>
      {/* Large arc r=12 */}
      <path d="M 26 14 A 12 12 0 1 1 14 2" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      {/* Medium arc r=8.5 */}
      <path d="M 22.5 14 A 8.5 8.5 0 1 1 14 5.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      {/* Small arc r=5 */}
      <path d="M 19 14 A 5 5 0 1 1 14 9" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      {/* Free + in top-right gap */}
      <line x1="16.5" y1="7.5" x2="25.5" y2="7.5" stroke="white" strokeWidth="2.4" strokeLinecap="round"/>
      <line x1="21" y1="3" x2="21" y2="12" stroke="white" strokeWidth="2.4" strokeLinecap="round"/>
    </svg>
  );
}

interface SidebarProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  isOpen: boolean;
  onToggle: () => void;
  activeFileIds?: number[];
  showAI?: boolean;
  onAIToggle?: () => void;
}

export default function Sidebar({ activePage, onNavigate, isOpen, onToggle, activeFileIds = [], showAI, onAIToggle }: SidebarProps) {
  const { user, logout, isAdmin, isManager, isManagerOrAdmin, hasFeature, savedAccounts, switchAccount, removeSavedAccount } = useAuth();
  const { t, toggleLang, lang } = useLanguage();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showSwitchPanel, setShowSwitchPanel] = useState(false);

  // Dev env switcher — only visible on localhost
  const isLocal = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  const prodHost = 'ordine-sales.up.railway.app';
  const switchEnv = () => {
    const path = window.location.pathname + window.location.search + window.location.hash;
    if (isLocal) window.open(`https://${prodHost}${path}`, '_blank');
    else window.open(`http://localhost:5173${path}`, '_blank');
  };

  const role = user?.role ?? 'user';

  // Roles that see the merged "rep analysis" page instead of 4 separate pages
  const REP_ANALYSIS_ROLES = new Set(['scientific_rep', 'team_leader', 'supervisor']);

  // roles: [] means "all roles"; roles with entries means restricted to those roles only
  const navItems: { id: PageId; label: string; icon: string; roles: string[] }[] = [
    { id: 'dashboard', label: role === 'commercial_rep' ? '💹 المبيع والارجاع' : t.nav.dashboard, icon: '📊', roles: [] },
    // Merged page — shown only to rep roles
    { id: 'rep-analysis',    label: 'تحليل ملفات المندوبين', icon: '📂', roles: ['scientific_rep','team_leader','supervisor'] },
    // Individual pages — hidden for rep roles
    { id: 'upload',          label: t.nav.upload,          icon: '📤', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
    { id: 'representatives', label: t.nav.representatives, icon: '💰', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
    { id: 'scientific-reps', label: t.nav.scientificReps,  icon: '🔬', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
    { id: 'doctors',         label: t.nav.doctors,         icon: '🏥', roles: [] },
    { id: 'monthly-plans',   label: t.nav.monthlyPlans,    icon: '📅', roles: [] },
    { id: 'reports',         label: t.nav.reports,         icon: '📋', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user'] },
    { id: 'users',           label: t.nav.users,           icon: '👥', roles: ['admin','manager','company_manager','product_manager','office_manager','commercial_supervisor','commercial_team_leader','user','scientific_rep','team_leader','supervisor'] },
    { id: 'commercial',      label: 'التجاري',             icon: '💰', roles: ['commercial_rep','commercial_team_leader','commercial_supervisor','office_manager','admin','manager','company_manager'] },
  ];

  // Feature-to-page mapping — pages hidden when feature is disabled
  // Multiple keys can map to the same page; any disabled key will hide that page
  const featurePageMap: Record<string, PageId> = {
    monthly_plans: 'monthly-plans',
    reports:       'reports',
    rep_analysis:  'rep-analysis',
    rep_files:     'rep-analysis',
    users_list:    'users',
  };

  // empty roles array = visible to all; otherwise check role inclusion
  const filteredItems = navItems.filter(item => {
    if (item.roles.length > 0 && !item.roles.includes(role)) return false;
    const featureKeys = Object.entries(featurePageMap)
      .filter(([, pageId]) => pageId === item.id)
      .map(([key]) => key);
    if (featureKeys.some(k => !hasFeature(k))) return false;
    return true;
  });

  // For commercial_rep: show التجاري first, then الرئيسية, then السيرفي
  const COMM_REP_ORDER: PageId[] = ['commercial', 'dashboard', 'doctors'];
  const visibleItems = role === 'commercial_rep'
    ? [...filteredItems].sort((a, b) => {
        const ai = COMM_REP_ORDER.indexOf(a.id as PageId);
        const bi = COMM_REP_ORDER.indexOf(b.id as PageId);
        const av = ai === -1 ? 999 : ai;
        const bv = bi === -1 ? 999 : bi;
        return av - bv;
      })
    : filteredItems;

  const ROLE_LABELS: Record<string, string> = {
    admin:                    t.sidebar.admin,
    manager:                  'مدير الفريق',
    company_manager:          'مدير شركة',
    supervisor:               'مشرف',
    product_manager:          'مدير منتج',
    team_leader:              'قائد فريق',
    office_manager:           'مدير مكتب',
    office_hr:                'HR مكتب',
    office_employee:          'موظف مكتب',
    commercial_supervisor:    'مشرف تجاري',
    commercial_team_leader:   'قائد فريق تجاري',
    commercial_rep:           'مندوب تجاري',
    scientific_rep:           'مندوب علمي',
    user:                     'مستخدم',
  };
  const ROLE_ICONS: Record<string, string> = {
    admin: '👑', manager: '🛡️', company_manager: '🏢', supervisor: '🔍',
    product_manager: '📦', team_leader: '🎯', office_manager: '🏠',
    commercial_supervisor: '💼', commercial_team_leader: '📋',
    commercial_rep: '💰', scientific_rep: '🔬',
  };
  const roleLabel = ROLE_LABELS[role] ?? role;
  const roleIcon  = ROLE_ICONS[role]  ?? '👤';

  // Other saved accounts (excluding the currently active one)
  const otherAccounts = savedAccounts.filter(a => a.user.id !== user?.id);
  // Show switch button whenever the feature is enabled and at least one account is saved
  // (even a single saved account is useful — user can open panel, see info, add more)
  const showSwitchBtn = hasFeature('switch_account') && savedAccounts.length >= 1;

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
          <span className="sidebar-brand-icon"><OrdineLogo size={28} /></span>
          {isOpen && <span className="sidebar-brand-text">{t.appName}</span>}
          <button className="sidebar-toggle" onClick={onToggle} title={t.sidebar.collapse}>
            {isOpen ? (lang === 'ar' ? '◀' : '▶') : (lang === 'ar' ? '▶' : '◀')}
          </button>
        </div>

        <nav className="sidebar-nav">
          {visibleItems.map(item => {
            const isActive = activePage === item.id;
            const isRepAnalysis = item.id === 'rep-analysis';
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`sidebar-nav-item ${isActive ? 'sidebar-nav-item--active' : ''}`}
                style={isRepAnalysis && !isActive ? {
                  background: 'linear-gradient(90deg,rgba(99,102,241,0.18),rgba(99,102,241,0.08))',
                  borderLeft: '3px solid rgba(99,102,241,0.6)',
                } : undefined}
              >
                <span className="sidebar-nav-icon">{item.icon}</span>
                {isOpen && <span className="sidebar-nav-label">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer" style={{ marginTop: 'auto' }}>
          {isOpen ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>{roleIcon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.username}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{roleLabel}</div>
                </div>
                {showSwitchBtn && (
                  <button
                    onClick={() => setShowSwitchPanel(true)}
                    title="تبديل الحساب"
                    style={{
                      background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)',
                      borderRadius: 7, padding: '4px 7px', fontSize: 14, cursor: 'pointer',
                      color: '#a5b4fc', flexShrink: 0,
                    }}
                  >⇄</button>
                )}
              </div>
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={onAIToggle}
                  title={showAI ? 'إخفاء المساعد الذكي' : 'إظهار المساعد الذكي'}
                  style={{
                    background: showAI ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.09)',
                    border: `1px solid ${showAI ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.2)'}`,
                    borderRadius: 8, padding: '6px 14px', fontSize: 13,
                    color: showAI ? '#c7d2fe' : '#94a3b8',
                    cursor: 'pointer', fontWeight: 600, width: '100%',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  🤖 {showAI ? 'إخفاء المساعد' : 'إظهار المساعد'}
                </button>
              </div>
              <div style={{ marginBottom: 6 }}>
                <LangToggleBtn full />
              </div>
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={switchEnv}
                  title={isLocal ? 'فتح نفس الصفحة على Production' : 'فتح نفس الصفحة على Local'}
                  style={{
                    background: isLocal ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)',
                    border: `1px solid ${isLocal ? 'rgba(234,179,8,0.4)' : 'rgba(34,197,94,0.4)'}`,
                    borderRadius: 8, padding: '6px 14px', fontSize: 12,
                    color: isLocal ? '#fbbf24' : '#4ade80',
                    cursor: 'pointer', fontWeight: 700, width: '100%',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >{isLocal ? '🚀 فتح على Production' : '🖥️ فتح على Local'}</button>
              </div>
              <button className="btn btn--secondary" style={{ width: '100%', fontSize: 13 }} onClick={logout}>
                🚪 {t.sidebar.logout}
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
              {showSwitchBtn && (
                <button
                  onClick={() => setShowSwitchPanel(true)}
                  title="تبديل الحساب"
                  style={{
                    background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)',
                    borderRadius: 8, padding: '6px', fontSize: 16, cursor: 'pointer', width: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a5b4fc',
                  }}
                >⇄</button>
              )}
              <button
                onClick={onAIToggle}
                title={showAI ? 'إخفاء المساعد' : 'إظهار المساعد'}
                style={{
                  background: showAI ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.09)',
                  border: `1px solid ${showAI ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.2)'}`,
                  borderRadius: 8, padding: '6px', fontSize: 16,
                  cursor: 'pointer', width: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >🤖</button>
              <LangToggleBtn />
              <button
                onClick={switchEnv}
                title={isLocal ? 'فتح على Production' : 'فتح على Local'}
                style={{
                  background: isLocal ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)',
                  border: `1px solid ${isLocal ? 'rgba(234,179,8,0.4)' : 'rgba(34,197,94,0.4)'}`,
                  borderRadius: 8, padding: '6px', fontSize: 14, cursor: 'pointer', width: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: isLocal ? '#fbbf24' : '#4ade80',
                }}
              >{isLocal ? '🚀' : '🖥️'}</button>
              <button className="sidebar-nav-item" onClick={logout} title={t.sidebar.logout} style={{ width: '100%' }}>
                <span className="sidebar-nav-icon">🚪</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── MOBILE TOP HEADER ── */}
      <header className="mobile-header">
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mobile-header-title" style={{ fontSize: 22 }}>{t.appName}</span>
          <span style={{ display:'flex', alignItems:'center' }}><OrdineLogo size={36} /></span>
        </div>
        <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(true)} title="menu" style={{ marginRight: 0, fontSize: 16 }}>
          ☰
        </button>
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
                <span style={{ fontSize: 26, display:'flex', alignItems:'center' }}><OrdineLogo size={28} /></span>
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
              {visibleItems.map(item => {
                const isRepAnalysis = item.id === 'rep-analysis';
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleMobileNavigate(item.id)}
                    className={`mobile-drawer-item ${isActive ? 'mobile-drawer-item--active' : ''}`}
                    style={isRepAnalysis && !isActive ? {
                      background: 'linear-gradient(90deg,rgba(99,102,241,0.1),transparent)',
                      borderRight: '3px solid rgba(99,102,241,0.5)',
                    } : undefined}
                  >
                    <span style={{ fontSize: 20 }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {showSwitchBtn && (
                <button
                  onClick={() => { setShowSwitchPanel(true); setMobileMenuOpen(false); }}
                  style={{
                    background: '#eef2ff', border: '1px solid #a5b4fc', borderRadius: 8,
                    padding: '8px 14px', fontSize: 13, fontWeight: 700, color: '#4338ca',
                    cursor: 'pointer', width: '100%', textAlign: 'center',
                  }}
                >⇄ تبديل الحساب</button>
              )}
              <button
                onClick={() => { onAIToggle?.(); setMobileMenuOpen(false); }}
                style={{
                  background: showAI ? '#eef2ff' : '#f1f5f9',
                  border: `1px solid ${showAI ? '#a5b4fc' : '#cbd5e1'}`,
                  borderRadius: 8, padding: '8px 14px', fontSize: 13,
                  fontWeight: 700, color: showAI ? '#4338ca' : '#334155',
                  cursor: 'pointer', width: '100%', textAlign: 'center',
                }}
              >
                🤖 {showAI ? 'إخفاء المساعد الذكي' : 'إظهار المساعد الذكي'}
              </button>
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
                onClick={() => { switchEnv(); setMobileMenuOpen(false); }}
                style={{
                  background: isLocal ? 'rgba(234,179,8,0.12)' : 'rgba(34,197,94,0.12)',
                  border: `1px solid ${isLocal ? 'rgba(234,179,8,0.5)' : 'rgba(34,197,94,0.5)'}`,
                  borderRadius: 8, padding: '8px 14px', fontSize: 13,
                  fontWeight: 700, color: isLocal ? '#d97706' : '#16a34a',
                  cursor: 'pointer', width: '100%', textAlign: 'center',
                }}
              >
                {isLocal ? '🚀 فتح على Production' : '🖥️ فتح على Local'}
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

      {/* ── SWITCH ACCOUNT PANEL ── */}
      {showSwitchPanel && (
        <div
          onClick={() => setShowSwitchPanel(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 18, padding: 24,
              minWidth: 300, maxWidth: 400, width: '90%',
              maxHeight: '80vh', overflowY: 'auto',
              direction: 'rtl', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#1e293b' }}>⇄ تبديل الحساب</h2>
              <button
                onClick={() => setShowSwitchPanel(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}
              >✕</button>
            </div>

            {/* Current account */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>الحساب الحالي</div>
              <div style={{
                background: '#eef2ff', border: '2px solid #a5b4fc', borderRadius: 12,
                padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%', background: '#6366f1',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 900, fontSize: 17, flexShrink: 0,
                }}>
                  {(user?.displayName || user?.username || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#3730a3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {user?.displayName || user?.username}
                  </div>
                  <div style={{ fontSize: 12, color: '#6366f1' }}>{ROLE_LABELS[user?.role ?? ''] ?? user?.role}</div>
                </div>
                <span style={{ fontSize: 18, color: '#6366f1' }}>✓</span>
              </div>
            </div>

            {/* Other accounts */}
            {otherAccounts.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>حسابات أخرى</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {otherAccounts.map((acc: SavedAccount) => (
                    <div
                      key={acc.user.id}
                      style={{
                        background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12,
                        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
                        cursor: 'pointer', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f0f9ff')}
                      onMouseLeave={e => (e.currentTarget.style.background = '#f8fafc')}
                    >
                      {/* Avatar */}
                      <div
                        onClick={() => { switchAccount(acc); setShowSwitchPanel(false); }}
                        style={{
                          width: 38, height: 38, borderRadius: '50%', background: '#0ea5e9',
                          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 900, fontSize: 17, flexShrink: 0, cursor: 'pointer',
                        }}
                      >
                        {(acc.user.displayName || acc.user.username || '?')[0].toUpperCase()}
                      </div>
                      {/* Info */}
                      <div
                        style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                        onClick={() => { switchAccount(acc); setShowSwitchPanel(false); }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {acc.user.displayName || acc.user.username}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>{ROLE_LABELS[acc.user.role] ?? acc.user.role}</div>
                      </div>
                      {/* Switch btn */}
                      <button
                        onClick={() => { switchAccount(acc); setShowSwitchPanel(false); }}
                        style={{
                          background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8,
                          padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                        }}
                      >تبديل</button>
                      {/* Remove btn */}
                      <button
                        onClick={e => { e.stopPropagation(); removeSavedAccount(acc.user.id); }}
                        title="إزالة من القائمة"
                        style={{
                          background: 'none', border: 'none', fontSize: 16,
                          cursor: 'pointer', color: '#cbd5e1', padding: '2px 4px', flexShrink: 0,
                        }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {savedAccounts.length <= 1 && (
              <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', marginTop: 8 }}>
                لا توجد حسابات محفوظة أخرى — سجّل دخول بحساب آخر أولاً ليظهر هنا
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
