import { useState, useEffect, useCallback, Component } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import Sidebar from './components/layout/Sidebar';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UploadPage from './pages/UploadPage';
import RepresentativesPage from './pages/RepresentativesPage';
import ScientificRepsPage from './pages/ScientificRepsPage';
import DoctorsPage from './pages/DoctorsPage';
import MonthlyPlansPage from './pages/MonthlyPlansPage';
import ReportsPage from './pages/ReportsPage';
import UsersPage from './pages/UsersPage';
import './App.css';

export type PageId =
  | 'dashboard'
  | 'upload'
  | 'representatives'
  | 'scientific-reps'
  | 'doctors'
  | 'monthly-plans'
  | 'reports'
  | 'users';

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

function AppInner() {
  const { user } = useAuth();
  // On mobile (< 768px) start with sidebar closed
  const [activePage, setActivePage]       = useState<PageId>(() => (localStorage.getItem('lastPage') as PageId) || 'dashboard');
  const [sidebarOpen, setSidebarOpen]     = useState(() => window.innerWidth >= 768);
  const [activeFileIds, setActiveFileIds] = useState<number[]>([]);

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

  const navigateTo = useCallback((page: PageId) => {
    localStorage.setItem('lastPage', page);
    history.pushState({ page }, '');
    setActivePage(page);
  }, []);

  const toggleFileActive = (id: number | null) => {
    if (id === null) { setActiveFileIds([]); return; }
    setActiveFileIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // Show login page when not authenticated
  if (!user) return <LoginPage />;

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigateTo} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
      case 'upload':
        return <UploadPage activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
      case 'representatives':
        return <RepresentativesPage activeFileIds={activeFileIds} onNavigate={navigateTo} />;
      case 'scientific-reps':
        return <ScientificRepsPage />;
      case 'doctors':
        return <DoctorsPage />;
      case 'monthly-plans':
        return <MonthlyPlansPage />;
      case 'reports':
        return <ReportsPage activeFileIds={activeFileIds} onNavigate={navigateTo} />;
      case 'users':
        return <UsersPage />;
      default:
        return <DashboardPage onNavigate={navigateTo} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
    }
  };

  return (
    <div className="app-shell" dir="rtl">
      <Sidebar
        activePage={activePage}
        onNavigate={navigateTo}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        activeFileIds={activeFileIds}
      />
      <main className={`app-main ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        {renderPage()}
      </main>
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
