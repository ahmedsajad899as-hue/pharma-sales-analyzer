import { useState, useEffect, useCallback, Component, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import Sidebar from './components/layout/Sidebar';
import LoginPage from './pages/LoginPage';
import './App.css';

// Lazy-load heavy pages — each becomes its own JS chunk loaded on first visit
const DashboardPage       = lazy(() => import('./pages/DashboardPage'));
const RepAnalysisPage     = lazy(() => import('./pages/RepAnalysisPage'));
const UploadPage          = lazy(() => import('./pages/UploadPage'));
const RepresentativesPage = lazy(() => import('./pages/RepresentativesPage'));
const ScientificRepsPage  = lazy(() => import('./pages/ScientificRepsPage'));
const DoctorsPage         = lazy(() => import('./pages/DoctorsPage'));
const MonthlyPlansPage    = lazy(() => import('./pages/MonthlyPlansPage'));
const ReportsPage         = lazy(() => import('./pages/ReportsPage'));
const UsersPage           = lazy(() => import('./pages/UsersPage'));
const CommercialRepPage   = lazy(() => import('./pages/CommercialRepPage'));
const AIAssistant         = lazy(() => import('./components/AIAssistant'));

// Minimal spinner shown while a page chunk is loading
function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '60vh', flexDirection: 'column', gap: 14, color: '#94a3b8',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '3px solid #e2e8f0', borderTopColor: '#6366f1',
        animation: 'spin 0.7s linear infinite',
      }} />
      <span style={{ fontSize: 13, fontWeight: 500 }}>جاري التحميل...</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export type PageId =
  | 'dashboard'
  | 'upload'
  | 'representatives'
  | 'scientific-reps'
  | 'doctors'
  | 'monthly-plans'
  | 'reports'
  | 'users'
  | 'rep-analysis'
  | 'commercial';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  componentDidCatch(error: any, info: any) {
    // يمكن إرسال الخطأ لسيرفر أو تسجيله هنا
    // eslint-disable-next-line no-console
    console.error('React ErrorBoundary:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#b91c1c', background: '#fef2f2', fontSize: 18, textAlign: 'center' }}>
          <h2>حدث خطأ في التطبيق</h2>
          <pre style={{ color: '#991b1b', background: '#fee2e2', padding: 12, borderRadius: 8, direction: 'ltr', textAlign: 'left', overflowX: 'auto' }}>{String(this.state.error)}</pre>
          <p>يرجى إعادة تحميل الصفحة أو التواصل مع الدعم.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function ImpersonationBanner() {
  const { user, logout } = useAuth();
  if (sessionStorage.getItem('_is_impersonating') !== '1') return null;
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: 'linear-gradient(90deg, #92400e, #b45309)',
      color: '#fff', padding: '8px 20px',
      display: 'flex', alignItems: 'center', gap: 12,
      fontSize: 13, fontWeight: 600, direction: 'rtl',
      boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    }}>
      <span style={{ fontSize: 16 }}>👁️</span>
      <span>وضع المراقبة — تشاهد كـ:</span>
      <span style={{ background: 'rgba(255,255,255,0.2)', borderRadius: 6, padding: '2px 10px' }}>
        {user?.username} ({user?.role})
      </span>
      <span style={{ marginRight: 'auto', fontSize: 11, opacity: 0.8 }}>القراءة فقط — إغلاق التبويب للخروج</span>
      <button onClick={logout} style={{
        background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
        borderRadius: 6, color: '#fff', cursor: 'pointer', padding: '3px 12px', fontSize: 12, fontWeight: 700,
      }}>✕ إغلاق</button>
    </div>
  );
}

function AppInner() {
  const { user, hasFeature } = useAuth();
  const isImpersonating = sessionStorage.getItem('_is_impersonating') === '1';
  // On mobile (< 768px) start with sidebar closed
  const [activePage, setActivePage]       = useState<PageId>(() => {
    try {
      const u = JSON.parse(localStorage.getItem('auth_user') || 'null');
      if (u?.role === 'commercial_rep') return 'commercial';
    } catch {}
    const saved = localStorage.getItem('lastPage') as PageId | null;
    return saved ?? 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen]     = useState(() => window.innerWidth >= 768);
  const [showAI, setShowAI]               = useState(() => localStorage.getItem('showAIAssistant') !== 'false');
  const [activeFileIds, setActiveFileIds] = useState<number[]>([]);

  // Redirect commercial_rep to the commercial page on every load
  useEffect(() => {
    if (!user) return;
    if (user.role === 'commercial_rep') {
      navigateTo('commercial');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role]);

  // Sync with browser history so mobile back button navigates within the app
  useEffect(() => {
    const saved = (localStorage.getItem('lastPage') as PageId) || 'dashboard';
    history.replaceState({ page: saved }, '');
    const handlePopState = (e: PopStateEvent) => {
      const page = (e.state?.page as PageId) || 'dashboard';
      localStorage.setItem('lastPage', page);
      setActivePage(page);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Track which pages have been visited — only those get mounted
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([activePage]));
  const prevActivePage = activePage;

  const navigateTo = useCallback((page: PageId) => {
    localStorage.setItem('lastPage', page);
    history.pushState({ page }, '');
    setActivePage(page);
    setMountedPages(prev => { const s = new Set(prev); s.add(page); return s; });
  }, []);

  // Also mount the initial page
  useEffect(() => {
    setMountedPages(prev => { const s = new Set(prev); s.add(prevActivePage); return s; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFileActive = (id: number | null) => {
    if (id === null) { setActiveFileIds([]); return; }
    setActiveFileIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // Show login page when not authenticated
  if (!user) return <LoginPage />;

  // Page definitions — each page only mounts once and stays in DOM (hidden when inactive)
  const allPages: { id: PageId; node: React.ReactNode }[] = [
    { id: 'dashboard',       node: <DashboardPage onNavigate={navigateTo} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} /> },
    { id: 'upload',          node: <UploadPage activeFileIds={activeFileIds} onFileActivated={toggleFileActive} /> },
    { id: 'representatives', node: <RepresentativesPage activeFileIds={activeFileIds} onNavigate={navigateTo} /> },
    { id: 'scientific-reps', node: <ScientificRepsPage /> },
    { id: 'doctors',         node: <DoctorsPage /> },
    { id: 'monthly-plans',   node: <MonthlyPlansPage /> },
    { id: 'reports',         node: <ReportsPage activeFileIds={activeFileIds} onNavigate={navigateTo} /> },
    { id: 'users',           node: <UsersPage /> },
    { id: 'rep-analysis',    node: <RepAnalysisPage onNavigate={navigateTo} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} /> },
    { id: 'commercial',      node: <CommercialRepPage /> },
  ];

  return (
    <div className="app-shell" dir="rtl">
      <ImpersonationBanner />
      <Sidebar
        activePage={activePage}
        onNavigate={navigateTo}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        activeFileIds={activeFileIds}
        showAI={showAI}
        onAIToggle={() => setShowAI(v => { const n = !v; localStorage.setItem('showAIAssistant', String(n)); return n; })}
      />
      <main className={`app-main ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
        style={isImpersonating ? { paddingTop: 40 } : undefined}>
        {allPages.map(({ id, node }) => {
          const isMounted = mountedPages.has(id);
          const isActive  = activePage === id;
          if (!isMounted) return null;
          return (
            <Suspense key={id} fallback={<PageLoader />}>
              <div style={isActive ? undefined : { display: 'none', visibility: 'hidden', pointerEvents: 'none' }}>
                {node}
              </div>
            </Suspense>
          );
        })}
      </main>
      {hasFeature('ai_assistant') && showAI && (
        <Suspense fallback={null}>
          <AIAssistant activePage={activePage} navigateTo={navigateTo} />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <LanguageProvider>
          <AppInner />
        </LanguageProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
