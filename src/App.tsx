import { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import Sidebar from './components/layout/Sidebar';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UploadPage from './pages/UploadPage';
import RepresentativesPage from './pages/RepresentativesPage';
import ScientificRepsPage from './pages/ScientificRepsPage';
import ReportsPage from './pages/ReportsPage';
import UsersPage from './pages/UsersPage';
import './App.css';

export type PageId = 'dashboard' | 'upload' | 'representatives' | 'scientific-reps' | 'reports' | 'users';

function AppInner() {
  const { user } = useAuth();
  // On mobile (< 768px) start with sidebar closed
  const [activePage, setActivePage]       = useState<PageId>('dashboard');
  const [sidebarOpen, setSidebarOpen]     = useState(() => window.innerWidth >= 768);
  const [activeFileIds, setActiveFileIds] = useState<number[]>([]);

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
        return <DashboardPage onNavigate={setActivePage} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
      case 'upload':
        return <UploadPage activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
      case 'representatives':
        return <RepresentativesPage activeFileIds={activeFileIds} onNavigate={setActivePage} />;
      case 'scientific-reps':
        return <ScientificRepsPage />;
      case 'reports':
        return <ReportsPage activeFileIds={activeFileIds} onNavigate={setActivePage} />;
      case 'users':
        return <UsersPage />;
      default:
        return <DashboardPage onNavigate={setActivePage} activeFileIds={activeFileIds} onFileActivated={toggleFileActive} />;
    }
  };

  return (
    <div className="app-shell" dir="rtl">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
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
    <LanguageProvider>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </LanguageProvider>
  );
}
