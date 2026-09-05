import { useState, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { SuperAdminProvider, useSuperAdmin } from './context/SuperAdminContext';

class SAErrorBoundary extends Component<{ children: ReactNode }, { err: string | null; stack: string | null }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { err: null, stack: null }; }
  static getDerivedStateFromError(e: Error) { return { err: e.message, stack: e.stack || null }; }
  // Recover WITHOUT losing the session: just drop the navigation state that may be
  // poisoning the render (a restored user-detail / tab that crashes), then reload.
  clearNavAndReload = () => {
    localStorage.removeItem('sa_user_detail_id');
    localStorage.removeItem('sa_user_tab');
    localStorage.setItem('sa_last_page', 'offices');
    window.location.reload();
  };
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'system-ui, sans-serif', direction: 'rtl', padding: 20 }}>
          <div style={{ background: '#1e293b', border: '1px solid #dc2626', borderRadius: 16, padding: '32px 40px', maxWidth: 560, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ color: '#f87171', margin: '0 0 8px' }}>حدث خطأ غير متوقع</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>{this.state.err}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={this.clearNavAndReload}
                style={{ padding: '10px 24px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                العودة للوحة (دون فقد الجلسة)
              </button>
              <button onClick={() => { localStorage.removeItem('sa_token'); localStorage.removeItem('sa_user'); this.clearNavAndReload(); }}
                style={{ padding: '10px 24px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                مسح الجلسة وإعادة المحاولة
              </button>
            </div>
            {this.state.stack && (
              <details style={{ textAlign: 'left', direction: 'ltr' }}>
                <summary style={{ color: '#64748b', fontSize: 12, cursor: 'pointer', marginBottom: 6 }}>تفاصيل تقنية (للمطوّر)</summary>
                <pre style={{ maxHeight: 200, overflow: 'auto', background: '#0f172a', color: '#94a3b8', fontSize: 11, padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{this.state.stack}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
import SuperAdminLogin from './pages/super-admin/SuperAdminLogin';
import OfficesPage from './pages/super-admin/OfficesPage';
import CompaniesPage from './pages/super-admin/CompaniesPage';
import ItemsCatalogPage from './pages/super-admin/ItemsCatalogPage';
import AreasPage from './pages/super-admin/AreasPage';
import UsersPage from './pages/super-admin/UsersPage';
import SuperAdminsPage from './pages/super-admin/SuperAdminsPage';
import VisitsPage from './pages/super-admin/VisitsPage';
import MasterSurveyPage from './pages/super-admin/MasterSurveyPage';
import DoctorChangesPage from './pages/super-admin/DoctorChangesPage';

type Page = 'offices' | 'companies' | 'items' | 'areas' | 'users' | 'super-admins' | 'visits' | 'surveys' | 'doctor-changes';

// لون تمييز واحد فقط للحالة النشطة (بدل لون مختلف لكل عنصر) — يهدّئ الشريط الجانبي
// ويجعل العين تتبع "أين أنا" بدل التوهان بين تدرّجات ملوّنة متعددة.
const NAV: { id: Page; label: string; icon: string; masterOnly?: boolean }[] = [
  { id: 'offices',      label: 'المكاتب',      icon: '🏢' },
  { id: 'companies',    label: 'الشركات',      icon: '🏭' },
  { id: 'items',        label: 'الايتمات',     icon: '💊' },
  { id: 'areas',        label: 'المناطق',      icon: '🗺️' },
  { id: 'users',        label: 'المستخدمون',   icon: '👥' },
  { id: 'super-admins', label: 'المشرفون',     icon: '🛡️', masterOnly: true },
  { id: 'visits',       label: 'الزيارات',      icon: '📋', masterOnly: true },
  { id: 'surveys',      label: 'السيرفيات',     icon: '🗂️', masterOnly: true },
  { id: 'doctor-changes', label: 'سجل الأطباء', icon: '🔔', masterOnly: true },
];
const ACCENT = '#4f46e5';

// جرس إشعارات تغييرات الأطباء + تطابقات الأسماء بحاجة مراجعة — يظهر للماستر أدمن فقط
function NotificationBell({ token, refreshKey, onOpen }: { token: string; refreshKey: string; onOpen: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const fetchCount = () => {
      const H = { Authorization: `Bearer ${token}` };
      Promise.all([
        fetch('/api/super-admin/doctor-changes/unread-count', { headers: H }).then(r => r.json()).catch(() => null),
        fetch('/api/super-admin/doctor-name-matches/count',   { headers: H }).then(r => r.json()).catch(() => null),
      ]).then(([a, b]) => {
        if (!alive) return;
        setCount((a?.success ? a.count : 0) + (b?.success ? b.count : 0));
      });
    };
    fetchCount();
    const iv = setInterval(fetchCount, 60000); // كل دقيقة
    return () => { alive = false; clearInterval(iv); };
  }, [token, refreshKey]);

  return (
    <button onClick={onOpen} title="سجل تغييرات الأطباء ومطابقة الأسماء" style={{
      position: 'relative', width: 34, height: 34, borderRadius: 9,
      background: '#f8fafc', border: '1px solid #e2e8f0', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0,
    }}>
      🔔
      {count > 0 && (
        <span style={{
          position: 'absolute', top: -5, insetInlineEnd: -5, minWidth: 16, height: 16, padding: '0 3px',
          borderRadius: 8, background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{count > 99 ? '99+' : count}</span>
      )}
    </button>
  );
}

interface SAStats { offices: number; companies: number; users: number; items: number; }

function StatsBar({ token, onOpenItems }: { token: string; onOpenItems: () => void }) {
  const [stats, setStats] = useState<SAStats>({ offices: 0, companies: 0, users: 0, items: 0 });
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
      // إجمالي ايتمات الكتالوج عبر كل الشركات — /api/sa/companies يرجع
      // _count.items لكل شركة أصلاً، فلا حاجة لنقطة جديدة.
      items: Array.isArray(c.data)
        ? c.data.reduce((s: number, x: any) => s + (x?._count?.items ?? 0), 0)
        : 0,
    })).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const cards = [
    { label: 'مكتب',    value: stats.offices,   icon: '🏢' },
    { label: 'شركة',    value: stats.companies, icon: '🏭' },
    { label: 'مستخدم', value: stats.users,     icon: '👥' },
    { label: 'ايتم',    value: stats.items,     icon: '💊', onClick: onOpenItems, title: 'عرض كل الايتمات وطابور المراجعة عبر كل الشركات' },
  ];

  return (
    <div style={{ display: 'flex', gap: 8, padding: '10px 24px', borderBottom: '1px solid #eef1f6', flexShrink: 0, background: '#fff' }}>
      {cards.map(s => (
        <div key={s.label} onClick={s.onClick} title={s.title} style={{
          display: 'flex', alignItems: 'center', gap: 9,
          background: '#f8fafc', border: '1px solid #eef1f6',
          borderRadius: 10, padding: '7px 16px', flexShrink: 0,
          cursor: s.onClick ? 'pointer' : 'default',
        }}>
          <span style={{ fontSize: 14, flexShrink: 0, opacity: .75 }}>{s.icon}</span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#1e293b', lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2, fontWeight: 500 }}>{s.label}</div>
          </div>
        </div>
      ))}
      <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f8fafc', border: '1px solid #eef1f6', borderRadius: 20, padding: '5px 14px' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'saPulse 2s infinite' }} />
          <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>نشط</span>
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
  // يُفتَح فقط عبر بطاقة «ايتم» بشريط الإحصائيات — نظرة عامة على كل الشركات دفعة واحدة
  const [itemsDefaultAll, setItemsDefaultAll] = useState(false);
  useEffect(() => { if (page !== 'items') setItemsDefaultAll(false); }, [page]);

  useEffect(() => { localStorage.setItem('sa_last_page', page); }, [page]);

  if (!admin || !token) return <SuperAdminLogin />;

  const visibleNav = NAV.filter(n => !n.masterOnly || admin.isMaster);
  const activeMeta = NAV.find(n => n.id === page) ?? NAV[0];

  return (
    <div style={{
      display: 'flex', height: '100vh',
      fontFamily: '"Segoe UI", Tahoma, "Arial", sans-serif',
      direction: 'rtl', overflow: 'hidden',
      background: '#f4f6fa',
    }}>

      {/* ── Sidebar ───────────────────────────────────────── */}
      <aside style={{
        width: collapsed ? 64 : 232,
        background: '#1e2333',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column',
        transition: 'width .2s ease',
        overflow: 'hidden', flexShrink: 0,
        position: 'relative', zIndex: 10,
      }}>

        {/* Logo */}
        <div style={{
          padding: collapsed ? '18px 14px' : '18px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: ACCENT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15,
          }}>🛡️</div>
          {!collapsed && (
            <div>
              <div style={{
                fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap',
                color: '#f1f5f9',
              }}>لوحة التحكم</div>
              <div style={{ fontSize: 9.5, color: '#7c869c', whiteSpace: 'nowrap', marginTop: 1, letterSpacing: 1, fontWeight: 600 }}>SUPER ADMIN</div>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '10px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {visibleNav.map(n => {
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => setPage(n.id)} title={collapsed ? n.label : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: collapsed ? '10px 0' : '9px 12px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                borderRadius: 8, border: 'none', cursor: 'pointer', marginBottom: 2,
                background: active ? 'rgba(255,255,255,0.09)' : 'transparent',
                borderRight: active ? `2px solid ${ACCENT}` : '2px solid transparent',
                transition: 'background .15s', overflow: 'hidden',
              }}>
                <span style={{ fontSize: 15, flexShrink: 0, opacity: active ? 1 : .8 }}>{n.icon}</span>
                {!collapsed && (
                  <span style={{
                    fontSize: 12.5, fontWeight: active ? 700 : 500,
                    color: active ? '#f1f5f9' : '#94a1b8',
                    whiteSpace: 'nowrap', transition: 'color .15s',
                  }}>{n.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User card + logout */}
        <div style={{ padding: '8px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          {!collapsed && (
            <div style={{
              padding: '9px 11px', marginBottom: 6, borderRadius: 8,
              background: 'rgba(255,255,255,0.05)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                  background: admin.isMaster ? '#92400e' : '#334155',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                }}>{admin.isMaster ? '👑' : '🛡️'}</div>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{admin.username}</div>
                  <div style={{ fontSize: 9.5, color: '#8b95a8', marginTop: 1, fontWeight: 500 }}>
                    {admin.isMaster ? 'Master Admin' : 'Super Admin'}
                  </div>
                </div>
              </div>
            </div>
          )}
          <button onClick={logout} title="تسجيل خروج" style={{
            display: 'flex', alignItems: 'center', gap: 8,
            justifyContent: collapsed ? 'center' : 'flex-start',
            width: '100%', padding: '8px 11px', borderRadius: 8,
            border: 'none',
            cursor: 'pointer', background: 'transparent',
            color: '#94a1b8', fontSize: 12.5, fontWeight: 500, transition: 'background .15s, color .15s',
          }}>
            <span style={{ fontSize: 14 }}>🚪</span>
            {!collapsed && <span>تسجيل خروج</span>}
          </button>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Header */}
        <header style={{
          height: 56, flexShrink: 0,
          background: '#ffffff',
          borderBottom: '1px solid #eef1f6',
          padding: '0 22px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <button onClick={() => setCollapsed(c => !c)} style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: '#f8fafc', border: '1px solid #eef1f6',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 14, transition: 'background .15s',
          }}>☰</button>

          {/* Page indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, opacity: .8 }}>{activeMeta.icon}</span>
            <span style={{ fontWeight: 700, fontSize: 14.5, color: '#1e293b' }}>{activeMeta.label}</span>
          </div>

          {/* Right side: bell + date */}
          <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {admin.isMaster && (
              <NotificationBell token={token} refreshKey={page} onOpen={() => setPage('doctor-changes')} />
            )}
            <div style={{ fontSize: 11.5, color: '#94a3b8', fontWeight: 500 }}>
              {new Date().toLocaleDateString('ar-IQ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
          </div>
        </header>

        {/* Stats bar */}
        <StatsBar token={token} onOpenItems={() => { setItemsDefaultAll(true); setPage('items'); }} />

        {/* Page content */}
        <main style={{
          flex: 1, overflowY: 'auto', padding: 22,
          background: '#f4f6fa',
        }}>
          <div style={{
            background: '#ffffff',
            border: '1px solid #eef1f6',
            borderRadius: 14, padding: 22, minHeight: '100%',
          }}>
            {page === 'offices'      && <OfficesPage />}
            {page === 'companies'    && <CompaniesPage onOpenUser={id => { setJumpUserId(id); setPage('users'); }} />}
            {page === 'items'        && <ItemsCatalogPage defaultAll={itemsDefaultAll} />}
            {page === 'areas'        && <AreasPage />}
            {page === 'users'        && <UsersPage jumpUserId={jumpUserId} onJumpClear={() => setJumpUserId(null)} />}
            {page === 'super-admins' && <SuperAdminsPage />}
            {page === 'visits'       && <VisitsPage />}
            {page === 'surveys'      && <MasterSurveyPage />}
            {page === 'doctor-changes' && <DoctorChangesPage />}
          </div>
        </main>
      </div>

      <style>{`
        @keyframes saPulse { 0%,100%{opacity:1;} 50%{opacity:.3;} }
        aside nav button:hover { background: rgba(255,255,255,0.06) !important; }
        aside button[title="تسجيل خروج"]:hover { background: rgba(239,68,68,0.12) !important; color: #fca5a5 !important; }
        header button:hover { background: #eef1f6 !important; }
      `}</style>
    </div>
  );
}

export default function SuperAdminApp() {
  return (
    <SAErrorBoundary>
      <SuperAdminProvider>
        <SuperAdminShell />
      </SuperAdminProvider>
    </SAErrorBoundary>
  );
}
