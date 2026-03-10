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

const TABS: { id: TabId; label: string; icon: string; color: string; bg: string; desc: string }[] = [
  { id: 'upload',          label: 'رفع الملفات',           icon: '📤', color: '#8b5cf6', bg: '#f5f3ff', desc: 'رفع وإدارة ملفات المبيعات' },
  { id: 'representatives', label: 'المندوبون التجاريون',   icon: '💰', color: '#d97706', bg: '#fffbeb', desc: 'متابعة وإدارة المندوبين التجاريين' },
  { id: 'scientific-reps', label: 'المندوبون العلميون',    icon: '🔬', color: '#059669', bg: '#f0fdf4', desc: 'إدارة المندوبين العلميين وتعيين المناطق' },
  { id: 'reports',         label: 'التقارير والتحليل',     icon: '📊', color: '#2563eb', bg: '#eff6ff', desc: 'تقارير المبيعات والتحليل المفصّل' },
  { id: 'items',           label: 'الايتمات',              icon: '💊', color: '#e11d48', bg: '#fff1f2', desc: 'إدارة ايتمات الشركة بكافة تفاصيلها' },
];

export default function RepAnalysisPage({ activeFileIds, onFileActivated, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('upload');
  const [animKey, setAnimKey]     = useState(0);

  const handleTabChange = (id: TabId) => {
    if (id === activeTab) return;
    setAnimKey(k => k + 1);
    setActiveTab(id);
  };

  const activeInfo = TABS.find(t => t.id === activeTab)!;

  const renderContent = () => {
    switch (activeTab) {
      case 'upload':
        return <UploadPage activeFileIds={activeFileIds} onFileActivated={onFileActivated} />;
      case 'representatives':
        return <RepresentativesPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'scientific-reps':
        return <ScientificRepsPage />;
      case 'reports':
        return <ReportsPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'items':
        return <ItemsPage />;
    }
  };

  return (
    <div style={{ minHeight: '100%', background: '#f1f5f9', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes repTabSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes repTabPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
          50%      { box-shadow: 0 0 0 6px rgba(99,102,241,0.15); }
        }
        .rep-tab-btn {
          transition: all 0.22s cubic-bezier(0.4,0,0.2,1) !important;
        }
        .rep-tab-btn:hover:not(.rep-tab-active) {
          background: rgba(255,255,255,0.18) !important;
          color: #fff !important;
          transform: translateY(-2px) !important;
        }
        .rep-tab-active {
          animation: repTabPulse 2s ease-in-out infinite;
        }
        @media (max-width: 640px) {
          .rep-tabs-row { overflow-x: auto !important; flex-wrap: nowrap !important; padding-bottom: 2px; }
          .rep-tab-btn  { padding: 8px 12px !important; font-size: 12px !important; min-width: 120px !important; }
          .rep-tab-label-desc { display: none !important; }
        }
      `}</style>

      {/* ── Hero Header ─────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)',
        position: 'relative', overflow: 'hidden',
        paddingTop: 28, paddingLeft: 24, paddingRight: 24, paddingBottom: 0,
      }}>
        {/* Decorative blobs */}
        <div style={{ position:'absolute', top:-60, right:-50, width:220, height:220, borderRadius:'50%', background:'rgba(255,255,255,0.04)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', bottom:-40, left:80,  width:150, height:150, borderRadius:'50%', background:'rgba(99,102,241,0.18)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', top:10,   left:-30,  width:100, height:100, borderRadius:'50%', background:'rgba(6,182,212,0.1)', pointerEvents:'none' }} />

        {/* Title row */}
        <div style={{ position:'relative', zIndex:1, display:'flex', alignItems:'center', gap:16, marginBottom:22 }}>
          <div style={{
            width:52, height:52, borderRadius:16, flexShrink:0,
            background: 'linear-gradient(135deg,rgba(255,255,255,0.22),rgba(255,255,255,0.06))',
            border: '1px solid rgba(255,255,255,0.18)',
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:26,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          }}>📂</div>
          <div>
            <h1 style={{ margin:0, fontSize:20, fontWeight:800, color:'#fff', letterSpacing:'-0.02em', lineHeight:1.2 }}>
              تحليل ملفات المندوبين
            </h1>
            <p style={{ margin:0, marginTop:4, fontSize:12, color:'rgba(199,210,254,0.8)' }}>
              {activeInfo.desc}
            </p>
          </div>

          {/* Active tab indicator pill */}
          <div style={{
            marginRight: 'auto',
            display:'flex', alignItems:'center', gap:8,
            background:'rgba(255,255,255,0.1)', borderRadius:999,
            padding:'5px 14px 5px 8px', border:'1px solid rgba(255,255,255,0.2)',
          }}>
            <span style={{
              width:8, height:8, borderRadius:'50%',
              background: activeInfo.color, display:'inline-block',
              boxShadow:`0 0 8px ${activeInfo.color}`,
            }} />
            <span style={{ fontSize:12, color:'rgba(255,255,255,0.85)', fontWeight:600 }}>
              {activeInfo.icon} {activeInfo.label}
            </span>
          </div>
        </div>

        {/* Tab bar */}
        <div className="rep-tabs-row" style={{ position:'relative', zIndex:1, display:'flex', gap:4 }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className={`rep-tab-btn${isActive ? ' rep-tab-active' : ''}`}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: '10px 20px',
                  border: 'none',
                  borderRadius: '10px 10px 0 0',
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 500,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  whiteSpace: 'nowrap',
                  background: isActive ? '#f1f5f9' : 'rgba(255,255,255,0.09)',
                  color: isActive ? tab.color : 'rgba(255,255,255,0.65)',
                  borderBottom: isActive ? `3px solid ${tab.color}` : '3px solid transparent',
                  boxShadow: isActive ? '0 -2px 16px rgba(0,0,0,0.2)' : 'none',
                }}
              >
                <span style={{ fontSize:17, lineHeight:1 }}>{tab.icon}</span>
                <span>{tab.label}</span>
                {isActive && (
                  <span style={{
                    width:7, height:7, borderRadius:'50%',
                    background: tab.color, display:'inline-block',
                    animation:'repTabPulse 2s ease-in-out infinite',
                    marginLeft:2,
                  }} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content area ───────────────────────────────────── */}
      <div
        key={animKey}
        style={{
          flex:1,
          background: '#f1f5f9',
          animation: 'repTabSlideIn 0.28s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Thin accent line matching active tab */}
        <div style={{ height:3, background:`linear-gradient(90deg,${activeInfo.color}90,${activeInfo.color}20)` }} />
        {renderContent()}
      </div>
    </div>
  );
}
