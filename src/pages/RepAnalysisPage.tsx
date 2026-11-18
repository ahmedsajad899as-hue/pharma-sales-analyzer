import { useState, useEffect, useRef } from 'react';
import { usePageBackHandler } from '../hooks/useBackHandler';
import type { PageId } from '../App';
import UploadPage from './UploadPage';
import RepresentativesPage from './RepresentativesPage';
import ScientificRepsPage from './ScientificRepsPage';
import ReportsPage from './ReportsPage';
import ItemsPage from './ItemsPage';
import TargetsPage from './TargetsPage';

type TabId = 'upload' | 'representatives' | 'scientific-reps' | 'reports' | 'items' | 'targets';

interface Props {
  activeFileIds: number[];
  onFileActivated: (id: number | null) => void;
  onNavigate: (p: PageId) => void;
}

const TABS: { id: TabId; label: string; desc: string }[] = [
  { id: 'upload',          label: 'رفع الملفات',         desc: 'رفع وإدارة ملفات المبيعات' },
  { id: 'representatives', label: 'المندوبون التجاريون', desc: 'متابعة وإدارة المندوبين التجاريين' },
  { id: 'scientific-reps', label: 'المندوبون العلميون',  desc: 'إدارة المندوبين العلميين وتعيين المناطق' },
  { id: 'reports',         label: 'التقارير',   desc: 'تقارير المبيعات والتحليل المفصّل' },
  { id: 'items',           label: 'الايتمات',            desc: 'إدارة ايتمات الشركة بكافة تفاصيلها' },
  { id: 'targets',         label: 'التارگت',          desc: 'إدارة التارگت الشهري للمندوبين ومقارنته بالمبيعات' },
];

// صفحات تُفتح بأزرار مطويّة تحت سهم صغير في تبويب التقارير (ليست تبويبات في الشريط)
const REPORT_SUBPAGES: TabId[] = ['representatives', 'scientific-reps', 'items'];

// تبويبات تحصل على تظليل خلفية خفيف لتمييزها بصرياً عن البقية
const HIGHLIGHTED_TABS = new Set<TabId>(['upload', 'reports', 'targets']);

export default function RepAnalysisPage({ activeFileIds, onFileActivated, onNavigate }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const saved = localStorage.getItem('rep_analysis_tab');
    return (saved && TABS.some(t => t.id === saved)) ? saved as TabId : 'upload';
  });
  const [animKey, setAnimKey] = useState(0);
  // أزرار المندوبين/الايتمات مطويّة افتراضياً؛ تبقى مفتوحة ما دامت إحدى صفحاتها معروضة
  const [subOpen, setSubOpen] = useState(false);
  const subVisible = subOpen || REPORT_SUBPAGES.includes(activeTab);

  // Back button: go to default tab when on a secondary tab (only if this page is active)
  usePageBackHandler('rep-analysis', [
    [REPORT_SUBPAGES.includes(activeTab), () => handleTabChange('reports')],
    [activeTab !== 'upload' && !REPORT_SUBPAGES.includes(activeTab), () => handleTabChange('upload')],
  ]);

  const handleTabChange = (id: TabId) => {
    if (id === activeTab) return;
    localStorage.setItem('rep_analysis_tab', id);
    setAnimKey(k => k + 1);
    setActiveTab(id);
  };

  const handleTabChangeRef = useRef(handleTabChange);
  handleTabChangeRef.current = handleTabChange;

  // أمر المساعد «open-sales» (مثلاً «افتح مبيعات شركة ديفا»): ننتقل لتبويب
  // التقارير ونسلّم الطلب لـReportsPage عبر __aiSalesRequest — يلتقطه عند
  // التركيب إن لم يكن معروضاً بعد، أو عبر حدث ai-open-sales إن كان معروضاً.
  useEffect(() => {
    const handler = (e: Event) => {
      const { action, param } = (e as CustomEvent).detail || {};
      if (action !== 'open-sales') return;
      (window as any).__aiSalesRequest = { ...(param && typeof param === 'object' ? param : {}), at: Date.now() };
      handleTabChangeRef.current('reports');
      window.dispatchEvent(new CustomEvent('ai-open-sales'));
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending?.action === 'open-sales') { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  // Expose digest for AI assistant — list of active sales-data files on this page
  useEffect(() => {
    (window as any).__repAnalysisDigest = {
      activeFileIds: Array.isArray(activeFileIds) ? activeFileIds : [],
    };
    return () => { delete (window as any).__repAnalysisDigest; };
  }, [activeFileIds]);

  const renderContent = () => {
    switch (activeTab) {
      case 'upload':          return <UploadPage activeFileIds={activeFileIds} onFileActivated={onFileActivated} onSwitchToItems={() => handleTabChange('items')} />;
      case 'representatives': return <RepresentativesPage activeFileIds={activeFileIds} onNavigate={onNavigate} />;
      case 'scientific-reps': return <ScientificRepsPage activeFileIds={activeFileIds} />;
      case 'reports':         return <ReportsPage activeFileIds={activeFileIds} onNavigate={onNavigate} aiSalesTarget />;
      case 'items':           return <ItemsPage />;
      case 'targets':         return <TargetsPage activeFileIds={activeFileIds} />;
    }
  };

  return (
    <div className="ra-root" style={{ minHeight: '100%', background: 'var(--page-bg, #f8fafc)', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .ra-tab { transition: color 0.15s, border-color 0.15s; }
        .ra-tab:hover { color: #1e293b !important; }
        @media (max-width: 640px) {
          .ra-tabs { overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
          .ra-tabs::-webkit-scrollbar { display: none; }
          .ra-tab  { font-size: 13px !important; padding: 10px 14px !important; flex: 1 0 auto; }
          .ra-header { padding: 10px 10px 0 !important; }
          .ra-subrow { padding: 10px 12px 0 !important; }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="ra-header" style={{
        background: '#fff',
        borderBottom: '1px solid #e2e8f0',
        padding: '18px 28px 0',
        direction: 'rtl',
      }}>
        {/* Tab bar */}
        <div className="ra-tabs" style={{ display: 'flex', gap: 0 }}>
          {TABS.filter(tab => !REPORT_SUBPAGES.includes(tab.id)).map(tab => {
            const isActive = activeTab === tab.id || (tab.id === 'reports' && REPORT_SUBPAGES.includes(activeTab));
            const isHighlighted = HIGHLIGHTED_TABS.has(tab.id);
            return (
              <button
                key={tab.id}
                className="ra-tab"
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: '10px 20px',
                  paddingInlineEnd: 70, // توسيع الخانة نحو اليسار (RTL: نهاية السطر)
                  border: 'none',
                  borderBottom: isActive ? '2px solid #4f46e5' : '2px solid transparent',
                  background: isHighlighted ? (isActive ? 'rgba(79,70,229,0.16)' : 'rgba(79,70,229,0.09)') : 'transparent',
                  borderRadius: isHighlighted ? '8px 8px 0 0' : 0,
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
        {(activeTab === 'reports' || REPORT_SUBPAGES.includes(activeTab)) && (
          // يسار الصفحة (نهاية السطر في RTL): السهم، والأزرار تنفتح بجانبه
          <div className="ra-subrow" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', direction: 'rtl', padding: '6px 28px 0' }}>
            {subVisible && TABS.filter(tab => REPORT_SUBPAGES.includes(tab.id)).map(tab => {
              const on = activeTab === tab.id;
              return (
                <button key={tab.id} title={tab.desc} onClick={() => handleTabChange(on ? 'reports' : tab.id)}
                  style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer',
                    border: '1px solid ' + (on ? '#4f46e5' : '#e2e8f0'),
                    background: on ? '#4f46e5' : '#fff', color: on ? '#fff' : '#475569',
                    fontWeight: on ? 600 : 400,
                  }}>{tab.label}</button>
              );
            })}
            <button type="button" aria-expanded={subVisible}
              title={subVisible ? 'إخفاء' : 'المندوبون التجاريون · المندوبون العلميون · الايتمات'}
              onClick={() => {
                if (subVisible && REPORT_SUBPAGES.includes(activeTab)) handleTabChange('reports');
                setSubOpen(!subVisible);
              }}
              style={{
                width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 7, border: '1px solid #e2e8f0', background: subVisible ? '#eef2ff' : '#fff',
                color: '#475569', cursor: 'pointer', padding: 0,
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: subVisible ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s' }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
        {renderContent()}
      </div>
    </div>
  );
}

