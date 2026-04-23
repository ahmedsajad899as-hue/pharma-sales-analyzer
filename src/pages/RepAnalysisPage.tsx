import { useState, useEffect } from 'react';
import { usePageBackHandler } from '../hooks/useBackHandler';
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

const TABS: { id: TabId; label: string; desc: string }[] = [
  { id: 'upload',          label: 'رفع الملفات',         desc: 'رفع وإدارة ملفات المبيعات' },
  { id: 'representatives', label: 'المندوبون التجاريون', desc: 'متابعة وإدارة المندوبين التجاريين' },
  { id: 'scientific-reps', label: 'المندوبون العلميون',  desc: 'إدارة المندوبين العلميين وتعيين المناطق' },
  { id: 'reports',         label: 'التقارير والتحليل',   desc: 'تقارير المبيعات والتحليل المفصّل' },
  { id: 'items',           label: 'الايتمات',            desc: 'إدارة ايتمات الشركة بكافة تفاصيلها' },
];

export default function RepAnalysisPage({ activeFileIds, onFileActivated, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const saved = localStorage.getItem('rep_analysis_tab');
    return (saved && TABS.some(t => t.id === saved)) ? saved as TabId : 'upload';
  });
  const [animKey, setAnimKey] = useState(0);

  // Back button: go to default tab when on a secondary tab (only if this page is active)
  usePageBackHandler('rep-analysis', [
    [activeTab !== 'upload', () => handleTabChange('upload')],
  ]);

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
      case 'scientific-reps': return <ScientificRepsPage activeFileIds={activeFileIds} />;
      case 'reports':         return <ReportsPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'items':           return <ItemsPage />;
    }
  };

  return (
    <div style={{ minHeight: '100%', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .ra-tab { transition: color 0.15s, border-color 0.15s; }
        .ra-tab:hover { color: #1e293b !important; }
        @media (max-width: 640px) {
          .ra-tabs { overflow-x: auto; flex-wrap: nowrap; }
          .ra-tab  { font-size: 13px !important; padding: 10px 14px !important; }
        }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        background: '#fff',
        borderBottom: '1px solid #e2e8f0',
        padding: '18px 28px 0',
        direction: 'rtl',
      }}>
        {/* Title row */}
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.01em' }}>
            تحليل ملفات المندوبين
          </h1>
          <p style={{ margin: '3px 0 0', fontSize: 13, color: '#94a3b8' }}>
            {activeInfo.desc}
          </p>
        </div>

        {/* Tab bar */}
        <div className="ra-tabs" style={{ display: 'flex', gap: 0 }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className="ra-tab"
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: '10px 20px',
                  border: 'none',
                  borderBottom: isActive ? '2px solid #4f46e5' : '2px solid transparent',
                  background: 'transparent',
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#4f46e5' : '#64748b',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ── */}
      <div key={animKey} style={{ flex: 1, background: '#f8fafc' }}>
        {renderContent()}
      </div>
    </div>
  );
}

