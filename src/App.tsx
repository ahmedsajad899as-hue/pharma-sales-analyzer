import { useState, useEffect, useCallback, useRef, Component, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import Sidebar from './components/layout/Sidebar';
import LoginPage from './pages/LoginPage';
import './App.css';

// Lazy-load heavy pages — each becomes its own JS chunk loaded on first visit
// lazyWithRetry: on chunk load failure, hard-reload once to bust stale cache
function lazyWithRetry<T extends React.ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory().catch(() => {
      const key = 'chunkErrReload';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
      }
      return factory(); // retry once after reload
    })
  );
}

const _importDashboard       = () => import('./pages/DashboardPage');
const _importRepAnalysis     = () => import('./pages/RepAnalysisPage');
const _importUpload          = () => import('./pages/UploadPage');
const _importRepresentatives = () => import('./pages/RepresentativesPage');
const _importScientificReps  = () => import('./pages/ScientificRepsPage');
const _importDoctors         = () => import('./pages/DoctorsPage');
const _importMonthlyPlans    = () => import('./pages/MonthlyPlansPage');
const _importReports         = () => import('./pages/ReportsPage');
const _importUsers           = () => import('./pages/UsersPage');
const _importCommercial      = () => import('./pages/CommercialRepPage');
const _importAI              = () => import('./components/AIAssistant');
const _importSurvey          = () => import('./pages/SurveyPage');
const _importFMS             = () => import('./pages/FMSPage');
const _importSalesData       = () => import('./pages/SalesDataPage');
const _importDistributorSales = () => import('./pages/DistributorSalesPage');

const DashboardPage       = lazyWithRetry(_importDashboard);
const RepAnalysisPage     = lazyWithRetry(_importRepAnalysis);
const UploadPage          = lazyWithRetry(_importUpload);
const RepresentativesPage = lazyWithRetry(_importRepresentatives);
const ScientificRepsPage  = lazyWithRetry(_importScientificReps);
const DoctorsPage         = lazyWithRetry(_importDoctors);
const MonthlyPlansPage    = lazyWithRetry(_importMonthlyPlans);
const ReportsPage         = lazyWithRetry(_importReports);
const UsersPage           = lazyWithRetry(_importUsers);
const CommercialRepPage   = lazyWithRetry(_importCommercial);
const AIAssistant         = lazyWithRetry(_importAI);
const SurveyPage          = lazyWithRetry(_importSurvey);
const FMSPage             = lazyWithRetry(_importFMS);
const SalesDataPage           = lazyWithRetry(_importSalesData);
const DistributorSalesPage    = lazyWithRetry(_importDistributorSales);

// Preload all page chunks immediately in background after app mounts
function preloadAllChunks() {
  const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 100));
  idle(() => {
    _importDashboard(); _importRepAnalysis(); _importUpload();
    _importRepresentatives(); _importScientificReps(); _importDoctors();
    _importMonthlyPlans(); _importReports(); _importUsers();
    _importCommercial(); _importAI(); _importSurvey(); _importFMS(); _importSalesData();
    _importDistributorSales();
  });
}

// Minimal spinner shown while a page chunk is loading
function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '60vh', flexDirection: 'column', gap: 14, color: '#94a3b8',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '3px solid #dde3ef', borderTopColor: '#1a56db',
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
  | 'commercial'
  | 'master-survey'
  | 'fms'
  | 'sales-data'
  | 'distributor-sales';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  componentDidCatch(error: any, info: any) {
    // Auto-reload on chunk load failures (stale cache after new deployment)
    const msg: string = String(error?.message ?? error);
    const isChunkError =
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Importing a module script failed') ||
      msg.includes('error loading dynamically imported module') ||
      msg.includes('ChunkLoadError') ||
      /Loading chunk .* failed/.test(msg) ||
      /Loading CSS chunk .* failed/.test(msg);
    if (isChunkError) {
      // Reload once — guard against infinite reload loop
      const reloadKey = 'chunkErrReload';
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
        return;
      }
    }
    // eslint-disable-next-line no-console
    console.error('React ErrorBoundary:', error, info);
  }
  render() {
    if (this.state.hasError) {
      const msg: string = String(this.state.error?.message ?? this.state.error);
      const isChunkError =
        msg.includes('Failed to fetch dynamically imported module') ||
        msg.includes('ChunkLoadError') ||
        /Loading chunk .* failed/.test(msg);
      if (isChunkError) {
        return (
          <div style={{ padding: 32, textAlign: 'center', color: '#6366f1' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔄</div>
            <p style={{ fontSize: 15, fontWeight: 600 }}>جاري إعادة تحميل التطبيق...</p>
          </div>
        );
      }
      return (
        <div style={{ padding: 32, color: '#b91c1c', background: '#fef2f2', fontSize: 18, textAlign: 'center' }}>
          <h2>حدث خطأ في التطبيق</h2>
          <pre style={{ color: '#991b1b', background: '#fee2e2', padding: 12, borderRadius: 8, direction: 'ltr', textAlign: 'left', overflowX: 'auto' }}>{String(this.state.error)}</pre>
          <button onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '10px 24px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            🔄 إعادة التحميل
          </button>
        </div>
      );
    }
    // Clear the reload guard once the app loads successfully
    sessionStorage.removeItem('chunkErrReload');
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

  // Preload all page chunks in background so navigation is instant
  useEffect(() => { preloadAllChunks(); }, []);

  // On mobile (< 768px) start with sidebar closed
  const [activePage, setActivePage]       = useState<PageId>(() => {
    try {
      const u = JSON.parse(localStorage.getItem('auth_user') || 'null');
      if (u?.role === 'commercial_rep') return 'commercial';
      // company_manager now uses the merged rep-analysis page
      const companyMgrIndividualPages: string[] = ['upload', 'representatives', 'scientific-reps', 'reports'];
      if (u?.role === 'company_manager') {
        const saved = localStorage.getItem('lastPage');
        if (saved && companyMgrIndividualPages.includes(saved)) return 'rep-analysis';
      }
    } catch {}
    const saved = localStorage.getItem('lastPage') as PageId | null;
    return saved ?? 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen]     = useState(() => window.innerWidth >= 768);
  const [showAI, setShowAI]               = useState(() => localStorage.getItem('showAIAssistant') !== 'false');
  const [activeFileIds, setActiveFileIds] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('activeFileIds');
      if (saved) return JSON.parse(saved) as number[];
    } catch {}
    return [];
  });

  // Keep a ref so the popstate closure always sees the latest activePage
  const activePageRef = useRef(activePage);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);

  // Keep a ref so the popstate closure always sees the latest sidebarOpen
  const sidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);

  // Sync with browser history so mobile back button navigates within the app
  useEffect(() => {
    const saved = (localStorage.getItem('lastPage') as PageId) || 'dashboard';
    // Single base entry – when popped we know user wants to exit
    history.replaceState({ page: saved }, '');
    // Working entry – user always sits here when no layers open
    history.pushState({ page: saved, appShell: true }, '');

    let exitPending = false;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let toastEl: HTMLDivElement | null = null;

    const clearExitState = () => {
      exitPending = false;
      if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
      if (toastEl) { toastEl.style.opacity = '0'; setTimeout(() => { toastEl?.remove(); toastEl = null; }, 150); }
    };

    const showExitToast = () => {
      toastEl = document.createElement('div');
      toastEl.textContent = 'اضغط مرة أخرى للخروج';
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '80px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(15,23,42,0.88)', color: '#fff',
        padding: '10px 22px', borderRadius: '24px', fontSize: '14px',
        fontWeight: '600', zIndex: '99999', pointerEvents: 'none',
        backdropFilter: 'blur(6px)', direction: 'rtl',
        boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
        opacity: '0', transition: 'opacity .15s',
      });
      document.body.appendChild(toastEl);
      requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = '1'; });
    };

    const handlePopState = (e: PopStateEvent) => {
      // 0. Close mobile sidebar first if it's open
      if (sidebarOpenRef.current && window.innerWidth < 768) {
        setSidebarOpen(false);
        history.pushState({ page: activePageRef.current, appShell: true }, '');
        clearExitState();
        return;
      }

      // 1. Let open layers intercept (CommercialRepPage listens to this)
      const layerEv = new CustomEvent('before-navigate-back', {
        cancelable: true,
        detail: { activePage: activePageRef.current },
      });
      window.dispatchEvent(layerEv);
      if (layerEv.defaultPrevented) {
        // A layer was closed – re-push working entry immediately so
        // the stack depth is restored with no visible navigation
        history.pushState({ page: activePageRef.current, appShell: true }, '');
        clearExitState();
        return;
      }

      // 1b. If we landed on a navEntry (pushed by navigateTo), skip it silently.
      //     This happens when the user closes a drawer then presses back a second
      //     time — the navigateTo entry for the current page sits below the
      //     appShell entry and must be jumped over to reach the real previous page.
      if (e.state?.navEntry) {
        history.back();
        return;
      }

      // 2. Normal page back-navigation (entries pushed by navigateTo)
      const targetPage = e.state?.page as PageId | undefined;
      if (targetPage && targetPage !== activePageRef.current) {
        localStorage.setItem('lastPage', targetPage);
        setActivePage(targetPage);
        clearExitState();
        return;
      }

      // 3. Same page or no page state → exit candidate
      // Re-push working entry immediately so browser shows NO navigation animation
      history.pushState({ page: activePageRef.current, appShell: true }, '');

      if (exitPending) {
        // Second press within 1s → exit for real (go back twice to leave the app)
        clearExitState();
        history.go(-2);
        return;
      }

      exitPending = true;
      navigator.vibrate?.(40);
      showExitToast();
      exitTimer = setTimeout(clearExitState, 1000);
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      clearExitState();
    };
  }, [])

  // Track which pages have been visited — only those get mounted
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([activePage]));
  const prevActivePage = activePage;

  // Pre-mount ALL pages in background after initial render so navigation is instant.
  // Pages render hidden (display:none) and fetch their data silently.
  // By the time the user taps a page icon, data is already loaded.
  const allPageIds: PageId[] = [
    'dashboard', 'upload', 'representatives', 'scientific-reps', 'doctors',
    'monthly-plans', 'reports', 'users', 'rep-analysis', 'commercial', 'master-survey', 'fms', 'sales-data',
    'distributor-sales',
  ];
  useEffect(() => {
    const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
    idle(() => setMountedPages(new Set(allPageIds)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = useCallback((page: PageId) => {
    localStorage.setItem('lastPage', page);
    // Only push a new history entry when moving to a different page.
    // Pushing same-page entries creates orphan entries that cause false exit triggers.
    if (page !== activePageRef.current) {
      history.pushState({ page, navEntry: true }, '');
    }
    setActivePage(page);
    setMountedPages(prev => { const s = new Set(prev); s.add(page); return s; });
  }, []);

  // Also mount the initial page
  useEffect(() => {
    setMountedPages(prev => { const s = new Set(prev); s.add(prevActivePage); return s; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFileActive = useCallback((id: number | null) => {
    if (id === null) {
      setActiveFileIds([]);
      localStorage.removeItem('activeFileIds');
      return;
    }
    setActiveFileIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      localStorage.setItem('activeFileIds', JSON.stringify(next));
      return next;
    });
  }, []);

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
    { id: 'master-survey',   node: <SurveyPage /> },
    { id: 'fms',             node: <FMSPage /> },
    { id: 'sales-data',      node: <SalesDataPage /> },
    { id: 'distributor-sales', node: <DistributorSalesPage /> },
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
