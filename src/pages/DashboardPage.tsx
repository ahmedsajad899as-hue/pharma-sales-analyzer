import { useEffect, useRef, useState } from 'react';
import type { PageId } from '../App';
import AnalysisRenderer from '../components/AnalysisRenderer';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface Stats { sciRepsCount: number; filesCount: number; areasCount: number; totalSales: number; totalReturns: number; }
interface UploadedFile { id: number; originalName: string; rowCount: number; uploadedAt: string; _count?: { sales: number }; }
interface FileMonetary { id: number; name: string; salesValue: number; returnsValue: number; }
interface ActiveStats { totalSalesValue: number; totalReturnsValue: number; files: FileMonetary[]; }

export default function DashboardPage({ onNavigate, activeFileIds, onFileActivated }: { onNavigate: (p: PageId) => void; activeFileIds: number[]; onFileActivated: (id: number) => void }) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [stats, setStats]         = useState<Stats>({ sciRepsCount: 0, filesCount: 0, areasCount: 0, totalSales: 0, totalReturns: 0 });
  const [loading, setLoading]     = useState(true);

  // Active-files monetary stats
  const [activeStats, setActiveStats]       = useState<ActiveStats>({ totalSalesValue: 0, totalReturnsValue: 0, files: [] });
  const [activeStatsLoading, setActiveStatsLoading] = useState(false);
  const [openDropdown, setOpenDropdown]     = useState<'sales' | 'returns' | 'net' | null>(null);
  const [dropdownPos, setDropdownPos]       = useState<{ top: number; left: number; width: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Files panel
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles]         = useState<UploadedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Areas panel
  const [showAreas, setShowAreas]     = useState(false);
  const [areas, setAreas]             = useState<{ id: number; name: string }[]>([]);
  const [areasLoading, setAreasLoading] = useState(false);
  const [areaSearch, setAreaSearch]   = useState('');

  // Per-file analysis
  const [analyzeFile, setAnalyzeFile]   = useState<UploadedFile | null>(null);
  const [analysisText, setAnalysisText] = useState('');
  const [analyzeLoading, setAnalyzeLoading] = useState(false);

  // Load dashboard stats
  useEffect(() => {
    fetch(`/api/dashboard/stats`, { headers: authH() })
      .then(r => r.json())
      .then(json => { if (json.success) setStats(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load active-files monetary stats whenever activeFileIds changes
  useEffect(() => {
    if (activeFileIds.length === 0) {
      setActiveStats({ totalSalesValue: 0, totalReturnsValue: 0, files: [] });
      return;
    }
    setActiveStatsLoading(true);
    fetch(`/api/dashboard/active-stats?fileIds=${activeFileIds.join(',')}`, { headers: authH() })
      .then(r => r.json())
      .then(json => { if (json.success) setActiveStats(json.data); })
      .catch(() => {})
      .finally(() => setActiveStatsLoading(false));
  }, [activeFileIds, token]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    if (openDropdown) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openDropdown]);

  const toggleDropdown = (type: 'sales' | 'returns' | 'net', e: React.MouseEvent<HTMLDivElement>) => {
    if (openDropdown === type) { setOpenDropdown(null); return; }
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + window.scrollY + 6, left: rect.left + window.scrollX, width: Math.max(rect.width, 280) });
    setOpenDropdown(type);
  };

  const fmtMoney = (v: number) => v.toLocaleString('ar-IQ-u-nu-latn', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  // Load areas list when panel opens
  const openAreasPanel = () => {
    setShowAreas(true);
    setAreaSearch('');
    setAreasLoading(true);
    fetch(`/api/areas`, { headers: authH() })
      .then(r => r.json())
      .then(json => setAreas(Array.isArray(json.data) ? json.data : []))
      .catch(() => {})
      .finally(() => setAreasLoading(false));
  };

  // Load files list when panel opens
  const openFilesPanel = () => {
    setShowFiles(true);
    setFilesLoading(true);
    fetch(`/api/files`, { headers: authH() })
      .then(r => r.json())
      .then(json => setFiles(Array.isArray(json.data) ? json.data : []))
      .catch(() => {})
      .finally(() => setFilesLoading(false));
  };

  // Trigger AI analysis for a specific file
  const runAnalysis = async (file: UploadedFile) => {
    setAnalyzeFile(file);
    setAnalysisText('');
    setAnalyzeLoading(true);
    try {
      const res  = await fetch(`/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ fileId: file.id }),
      });
      const json = await res.json();
      setAnalysisText(json.analysis || t.dashboard.noAnalysis);
    } catch {
      setAnalysisText(t.dashboard.analysisError);
    } finally {
      setAnalyzeLoading(false);
    }
  };

  const fmtDate = (d: string) => new Date(d).toLocaleDateString('ar-IQ-u-nu-latn');

  const quickActions = [
    { label: t.dashboard.uploadFile,   desc: t.dashboard.uploadFileDesc,   icon: '📤', page: 'upload'          as PageId, color: '#6366f1' },
    { label: t.dashboard.manageReps,   desc: t.dashboard.manageRepsDesc,   icon: '👥', page: 'representatives' as PageId, color: '#0ea5e9' },
    { label: t.dashboard.viewReports,  desc: t.dashboard.viewReportsDesc,  icon: '📋', page: 'reports'         as PageId, color: '#10b981' },
  ];

  const netValue = activeStats.totalSalesValue - activeStats.totalReturnsValue;

  const moneyCards: { type: 'sales' | 'returns' | 'net'; label: string; value: string; icon: string; color: string; bg: string }[] = [
    {
      type: 'sales',
      label: t.dashboard.totalSales,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(activeStats.totalSalesValue),
      icon: '📦', color: '#10b981', bg: '#d1fae5',
    },
    {
      type: 'returns',
      label: t.dashboard.returns,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(activeStats.totalReturnsValue),
      icon: '↩', color: '#ef4444', bg: '#fee2e2',
    },
    {
      type: 'net',
      label: t.dashboard.net,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(netValue),
      icon: '🏆', color: '#6366f1', bg: '#eef2ff',
    },
  ];

  const statCards = [
    ...moneyCards.map(c => ({ ...c, onClick: undefined as undefined | (() => void) })),
    {
      label: t.dashboard.sciReps, value: loading ? '...' : stats.sciRepsCount,
      icon: '🔬', color: '#8b5cf6', bg: '#ede9fe', onClick: () => onNavigate('scientific-reps'),
      type: undefined,
    },
    {
      label: t.dashboard.areas, value: loading ? '...' : stats.areasCount,
      icon: '📍', color: '#0ea5e9', bg: '#e0f2fe', onClick: openAreasPanel,
      type: undefined,
    },
    {
      label: t.dashboard.uploadedFiles, value: loading ? '...' : stats.filesCount,
      icon: '📂', color: '#10b981', bg: '#d1fae5', onClick: openFilesPanel,
      type: undefined,
    },
    {
      label: t.dashboard.aiAnalysis, value: loading ? '...' : '✓',
      icon: '🤖', color: '#f59e0b', bg: '#fef3c7', onClick: undefined as undefined | (() => void),
      type: undefined,
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{t.dashboard.title}</h1>
        <p className="page-subtitle">{t.dashboard.subtitle}</p>
      </div>

      {/* Stat Cards */}
      <div className="stats-grid">
        {statCards.map(card => {
          const isMoney = (card as any).type === 'sales' || (card as any).type === 'returns' || (card as any).type === 'net';
          const isOpen  = isMoney && openDropdown === (card as any).type;
          return (
            <div
              className="stat-card"
              key={card.label}
              style={{ borderTop: `4px solid ${card.color}`, cursor: isMoney || card.onClick ? 'pointer' : 'default', outline: isOpen ? `2px solid ${card.color}` : undefined, position: 'relative' }}
              onClick={isMoney ? (e) => toggleDropdown((card as any).type, e as React.MouseEvent<HTMLDivElement>) : card.onClick}
            >
              <div className="stat-card-icon" style={{ background: card.bg, color: card.color }}>{card.icon}</div>
              <div className="stat-card-body">
                <div className="stat-card-value" style={{ color: card.color }}>{card.value}</div>
                <div className="stat-card-label">
                  {card.label}
                  {isMoney && activeFileIds.length > 0 && (
                    <span style={{ fontSize: '10px', marginRight: '4px', opacity: 0.65 }}>({activeFileIds.length} ملف)</span>
                  )}
                </div>
              </div>
              {(isMoney || card.onClick) && <span style={{ color: card.color, fontSize: '1.1rem' }}>{isMoney ? (isOpen ? '↑' : '↓') : '←'}</span>}
            </div>
          );
        })}
      </div>

      {/* ─── Money Dropdown ─── */}
      {openDropdown && dropdownPos && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            minWidth: dropdownPos.width,
            maxWidth: 360,
            zIndex: 9999,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{ padding: '10px 14px', background: openDropdown === 'sales' ? '#d1fae5' : openDropdown === 'returns' ? '#fee2e2' : '#eef2ff', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '13px', color: openDropdown === 'sales' ? '#065f46' : openDropdown === 'returns' ? '#991b1b' : '#3730a3' }}>
              {openDropdown === 'sales' ? '📦 ' + t.dashboard.totalSales : openDropdown === 'returns' ? '↩ ' + t.dashboard.returns : '🏆 ' + t.dashboard.net}
            </span>
            <span style={{ fontWeight: 800, fontSize: '15px', color: openDropdown === 'sales' ? '#10b981' : openDropdown === 'returns' ? '#ef4444' : '#6366f1' }}>
              {fmtMoney(openDropdown === 'sales' ? activeStats.totalSalesValue : openDropdown === 'returns' ? activeStats.totalReturnsValue : netValue)}
            </span>
          </div>
          {/* Per-file list */}
          <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
            {activeStats.files.length === 0 ? (
              <div style={{ padding: '14px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>لا توجد فايلات مفعلة</div>
            ) : (
              activeStats.files.map(f => {
                const val = openDropdown === 'sales' ? f.salesValue : openDropdown === 'returns' ? f.returnsValue : f.salesValue - f.returnsValue;
                const color = openDropdown === 'sales' ? '#10b981' : openDropdown === 'returns' ? '#ef4444' : '#6366f1';
                return (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid #f1f5f9', gap: '10px' }}>
                    <span style={{ fontSize: '12px', color: '#475569', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {f.name}</span>
                    <span style={{ fontWeight: 700, fontSize: '13px', color, whiteSpace: 'nowrap' }}>{fmtMoney(val)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <h2 className="section-title">{t.dashboard.quickActions}</h2>
      <div className="quick-actions-grid">
        {quickActions.map(action => (
          <button key={action.page} className="quick-action-card" onClick={() => onNavigate(action.page)} style={{ borderColor: action.color }}>
            <div className="quick-action-icon" style={{ background: action.color }}>{action.icon}</div>
            <div className="quick-action-body">
              <div className="quick-action-label">{action.label}</div>
              <div className="quick-action-desc">{action.desc}</div>
            </div>
            <span className="quick-action-arrow" style={{ color: action.color }}>←</span>
          </button>
        ))}
      </div>

      {/* About */}
      <div className="info-banner">
        <span className="info-banner-icon">🤖</span>
        <div>
          <strong>{t.dashboard.aiPowered}</strong>
          <p>{t.dashboard.aiDesc}</p>
        </div>
      </div>

      {/* ─── Areas Panel Modal ─── */}
      {showAreas && (
        <div className="modal-overlay" onClick={() => setShowAreas(false)}>
          <div className="modal modal--wide" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">📍 {t.dashboard.areasModal} ({areas.length})</h2>
              <button className="modal-close" onClick={() => setShowAreas(false)}>✕</button>
            </div>

            <div style={{ padding: '16px 24px 8px' }}>
              <input
                className="form-input"
                placeholder={t.dashboard.areasSearch}
                value={areaSearch}
                onChange={e => setAreaSearch(e.target.value)}
              />
            </div>

            <div style={{ padding: '8px 24px 24px', maxHeight: '440px', overflowY: 'auto' }}>
              {areasLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>{t.dashboard.loading}</div>
              ) : areas.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>{t.dashboard.noAreas}</div>
              ) : (() => {
                const filtered = areas.filter(a => a.name.toLowerCase().includes(areaSearch.toLowerCase()));
                if (filtered.length === 0) return <div style={{ textAlign: 'center', padding: '1.5rem', color: '#6b7280' }}>{t.dashboard.noResults}</div>;
                // Group alphabetically
                const groups = filtered.reduce<Record<string, typeof filtered>>((acc, a) => {
                  const key = a.name.charAt(0).toUpperCase();
                  if (!acc[key]) acc[key] = [];
                  acc[key].push(a);
                  return acc;
                }, {});
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'ar')).map(([letter, group]) => (
                      <div key={letter}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#0ea5e9', background: '#e0f2fe', borderRadius: '4px', padding: '2px 10px', display: 'inline-block', marginBottom: '8px' }}>
                          {letter} · {group.length}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {group.map(a => (
                            <span key={a.id} style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '5px 12px', fontSize: '13px', color: '#0369a1', fontWeight: 500 }}>
                              📍 {a.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ─── Files Panel Modal ─── */}
      {showFiles && (
        <div className="modal-overlay" onClick={() => { setShowFiles(false); setAnalyzeFile(null); setAnalysisText(''); }}>
          <div className="modal modal--wide" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">📂 {t.dashboard.filesModal}</h2>
              <button className="modal-close" onClick={() => { setShowFiles(false); setAnalyzeFile(null); setAnalysisText(''); }}>✕</button>
            </div>

            {filesLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>{t.dashboard.loading}</div>
            ) : files.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>{t.dashboard.noFiles}</div>
            ) : (
              <div className="table-wrapper" style={{ maxHeight: analyzeFile ? '200px' : '400px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t.dashboard.colNum}</th>
                      <th>{t.dashboard.colName}</th>
                      <th>{t.dashboard.colRows}</th>
                      <th>{t.dashboard.colRecords}</th>
                      <th>{t.dashboard.colDate}</th>
                      <th>{t.dashboard.colAction}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f, i) => (
                      <tr key={f.id} style={{ background: activeFileIds.includes(f.id) ? '#f0fdf4' : analyzeFile?.id === f.id ? '#fefce8' : undefined }}>
                        <td>{i + 1}</td>
                        <td><strong>{f.originalName}</strong>{activeFileIds.includes(f.id) && <span style={{ marginRight: '6px', fontSize: '0.75rem', background: '#dcfce7', color: '#16a34a', borderRadius: '4px', padding: '2px 6px' }}>{t.dashboard.active}</span>}</td>
                        <td>{f.rowCount.toLocaleString('ar-IQ-u-nu-latn')}</td>
                        <td>{f._count?.sales?.toLocaleString('ar-IQ-u-nu-latn') ?? '—'}</td>
                        <td>{fmtDate(f.uploadedAt)}</td>
                        <td style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="btn btn--primary"
                            style={{ padding: '4px 12px', fontSize: '0.8rem', background: activeFileIds.includes(f.id) ? '#16a34a' : undefined }}
                            onClick={() => { onFileActivated(f.id); }}
                          >
                            {activeFileIds.includes(f.id) ? t.dashboard.deactivate : t.dashboard.activate}
                          </button>
                          <button
                            className="btn btn--secondary"
                            style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                            onClick={() => runAnalysis(f)}
                            disabled={analyzeLoading}
                          >
                            {analyzeLoading && analyzeFile?.id === f.id ? '⏳' : t.dashboard.analyze}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Analysis result */}
            {analyzeFile && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#374151' }}>
                  {t.dashboard.analysisLabel} <em>{analyzeFile.originalName}</em>
                </div>
                {analyzeLoading ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: '#6b7280' }}>
                    {t.dashboard.analyzing}
                  </div>
                ) : analysisText ? (
                  <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem' }}>
                    <AnalysisRenderer text={analysisText} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
