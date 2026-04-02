import { useState } from 'react';
import type { PageId } from '../App';
import UploadPage from './UploadPage';
import RepresentativesPage from './RepresentativesPage';
import ScientificRepsPage from './ScientificRepsPage';
import ReportsPage from './ReportsPage';
import ItemsPage from './ItemsPage';

type TabId = 'upload' | 'representatives' | 'scientific-reps' | 'reports' | 'items';

interface Props {
  activeFileIds: number[];
  onFileActivated: (id: number | null) => void;
  onNavigate: (p: PageId) => void;
}

const TABS: { id: TabId; label: string; icon: string; desc: string }[] = [
  { id: 'upload',          label: 'رفع الملفات',         icon: '📤', desc: 'رفع وإدارة ملفات المبيعات' },
  { id: 'representatives', label: 'المندوبون التجاريون', icon: '💰', desc: 'متابعة وإدارة المندوبين التجاريين' },
  { id: 'scientific-reps', label: 'المندوبون العلميون',  icon: '🔬', desc: 'إدارة المندوبين العلميين وتعيين المناطق' },
  { id: 'reports',         label: 'التقارير والتحليل',   icon: '📊', desc: 'تقارير المبيعات والتحليل المفصّل' },
  { id: 'items',           label: 'الايتمات',            icon: '💊', desc: 'إدارة ايتمات الشركة بكافة تفاصيلها' },
];

const ACCENT = '#4f46e5';  // single unified accent color

export default function RepAnalysisPage({ activeFileIds, onFileActivated, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const saved = localStorage.getItem('rep_analysis_tab');
    return (saved && TABS.some(t => t.id === saved)) ? saved as TabId : 'upload';
  });
  const [animKey, setAnimKey] = useState(0);

  const handleTabChange = (id: TabId) => {
    if (id === activeTab) return;
    localStorage.setItem('rep_analysis_tab', id);
    setAnimKey(k => k + 1);
    setActiveTab(id);
  };

  const activeInfo = TABS.find(t => t.id === activeTab)!;

  const renderContent = () => {
    switch (activeTab) {
      case 'upload':          return <UploadPage activeFileIds={activeFileIds} onFileActivated={onFileActivated} />;
      case 'representatives': return <RepresentativesPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'scientific-reps': return <ScientificRepsPage />;
      case 'reports':         return <ReportsPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'items':           return <ItemsPage />;
    }
  };

  return (
    <div style={{ minHeight: '100%', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ra-tab {
          transition: background 0.18s, color 0.18s, box-shadow 0.18s;
        }
        .ra-tab:hover:not(.ra-tab--active) {
          background: rgba(79,70,229,0.07) !important;
          color: #4f46e5 !important;
        }
        @media (max-width: 640px) {
          .ra-tabs { overflow-x: auto !important; flex-wrap: nowrap !important; }
          .ra-tab  { padding: 9px 14px !important; font-size: 12px !important; white-space: nowrap; }
          .ra-tab-desc { display: none !important; }
        }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        background: 'linear-gradient(135deg, #312e81 0%, #4f46e5 100%)',
        padding: '20px 24px 0',
      }}>
        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 12, flexShrink: 0,
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>📂</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>
              تحليل ملفات المندوبين
            </h1>
            <p style={{ margin: 0, marginTop: 2, fontSize: 12, color: 'rgba(199,210,254,0.85)' }}>
              {activeInfo.icon} {activeInfo.desc}
            </p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="ra-tabs" style={{ display: 'flex', gap: 2 }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className={`ra-tab${isActive ? ' ra-tab--active' : ''}`}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: '10px 18px',
                  border: 'none',
                  borderRadius: '8px 8px 0 0',
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 500,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 7,
                  whiteSpace: 'nowrap',
                  background: isActive ? '#f8fafc' : 'transparent',
                  color: isActive ? ACCENT : 'rgba(255,255,255,0.7)',
                  borderBottom: isActive ? `3px solid ${ACCENT}` : '3px solid transparent',
                  boxShadow: 'none',
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Accent line + content ── */}
      <div key={animKey} style={{
        flex: 1,
        background: '#f8fafc',
        animation: 'fadeSlideIn 0.22s ease',
      }}>
        <div style={{ height: 3, background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT}30)` }} />
        {renderContent()}
      </div>
    </div>
  );
}

