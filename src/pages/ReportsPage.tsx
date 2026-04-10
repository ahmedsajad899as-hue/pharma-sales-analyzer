import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { PageId } from '../App';

/** Quantity cell — hidden by default, click to reveal, click again to hide.
 *  forceReveal overrides local state when provided (used by global toggle). */
function HiddenQty({ value, fmt, style, signed, forceReveal }: { value: number; fmt: (n: number) => string; style?: React.CSSProperties; signed?: boolean; forceReveal?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  // global forceReveal OR individual click — either one shows the value
  const show = !!forceReveal || revealed;
  const formatted = signed
    ? (value >= 0 ? `+${fmt(Math.abs(value))}` : `-${fmt(Math.abs(value))}`)
    : fmt(value);
  return (
    <span
      onClick={() => setRevealed(r => !r)}
      title={show ? 'انقر للإخفاء' : 'انقر لعرض الكمية'}
      style={{ cursor: 'pointer', userSelect: 'none', ...style }}
    >
      {show ? formatted : (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          background: '#f1f5f9', borderRadius: 6,
          padding: '1px 8px', fontSize: 12,
          color: '#94a3b8', letterSpacing: 2,
        }}>
          •••
        </span>
      )}
    </span>
  );
}

interface Rep { id: number; name: string; }
interface BreakdownRow { name: string; repName?: string; totalQty: number; totalValue: number; isZero?: boolean; }
interface CommReport {
  repName: string;
  totalQty: number;
  totalValue: number;
  byArea: BreakdownRow[];
  byItem: BreakdownRow[];
}
interface SciReport {
  repName: string;
  totalQty: number;
  totalValue: number;
  assignedAreas: Rep[];
  assignedItems: Rep[];
  assignedCommercialReps: Rep[];
  byArea: BreakdownRow[];
  byItem: BreakdownRow[];
  byRep: BreakdownRow[];
}

type Mode = 'commercial' | 'scientific';
type ReportView = 'sales' | 'returns' | 'net';

interface Props { activeFileIds: number[]; onNavigate?: (page: PageId) => void; }

export default function ReportsPage({ activeFileIds, onNavigate }: Props) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [mode, setMode]           = useState<Mode>(() => (sessionStorage.getItem('rpt_mode') as Mode) || 'commercial');

  // Commercial
  const [commReps, setCommReps]   = useState<Rep[]>([]);
  const [commRepId, setCommRepId] = useState(() => sessionStorage.getItem('rpt_commRepId') || '');
  const [commReport, setCommReport]                   = useState<CommReport | null>(null);
  const [commReturnsReport, setCommReturnsReport]     = useState<CommReport | null>(null);

  // Scientific
  const [sciReps, setSciReps]     = useState<Rep[]>([]);
  const [sciRepId, setSciRepId]   = useState(() => sessionStorage.getItem('rpt_sciRepId') || '');
  const [sciReport, setSciReport]                     = useState<SciReport | null>(null);
  const [sciReturnsReport, setSciReturnsReport]       = useState<SciReport | null>(null);

  // Shared
  const [fromDate, setFromDate]   = useState(() => sessionStorage.getItem('rpt_fromDate') || '');
  const [toDate, setToDate]       = useState(() => sessionStorage.getItem('rpt_toDate') || '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'area' | 'item' | 'rep'>('area');
  const [showInfoTags, setShowInfoTags] = useState(false);
  const [reportView, setReportView] = useState<ReportView>(() => (sessionStorage.getItem('rpt_view') as ReportView) || 'sales');
  const [exporting, setExporting]           = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selCommIds, setSelCommIds]           = useState<Set<number>>(new Set());
  const [selSciIds, setSelSciIds]             = useState<Set<number>>(new Set());
  const [exportProgress, setExportProgress]   = useState('');
  const [tabQtyRevealed, setTabQtyRevealed]   = useState<Record<string, boolean>>({});
  const qtyRevealed = tabQtyRevealed[activeTab] ?? false;
  const toggleQtyRevealed = () => setTabQtyRevealed(p => ({ ...p, [activeTab]: !p[activeTab] }));

  // Currency conversion — loaded from active file settings
  const [fileCurrencyMode, setFileCurrencyMode] = useState<'IQD' | 'USD'>('IQD');
  const [fileSourceCurrency, setFileSourceCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [fileExchangeRate, setFileExchangeRate] = useState<number>(1500);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-export-report') setShowExportModal(true);
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

// Always load scientific reps — doctor-visit reports don't require uploaded Excel files
  useEffect(() => {
    fetch(`/api/scientific-reps`, { headers: authH() })
      .then(r => r.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
        setSciReps(list);
      }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (activeFileIds.length === 0) {
      setCommReps([]);
      setCommRepId('');
      setCommReport(null);
      setSciReport(null);
      setFileCurrencyMode('IQD');
      setFileSourceCurrency('IQD');
      setFileExchangeRate(1500);
      return;
    }
    // Load currency settings from the first active file
    fetch(`/api/files`, { headers: authH() })
      .then(r => r.json())
      .then((json: any) => {
        const allFiles: any[] = Array.isArray(json.data) ? json.data : [];
        const activeFile = allFiles.find((f: any) => activeFileIds.includes(f.id));
        if (activeFile) {
          setFileCurrencyMode(activeFile.currencyMode === 'USD' ? 'USD' : 'IQD');
          setFileSourceCurrency(activeFile.detectedCurrency === 'USD' ? 'USD' : 'IQD');
          setFileExchangeRate(activeFile.exchangeRate || 1500);
        } else {
          setFileCurrencyMode('IQD');
          setFileSourceCurrency('IQD');
          setFileExchangeRate(1500);
        }
      }).catch(() => {});

    const repsUrl = `/api/representatives?fileIds=${activeFileIds.join(',')}`;
    fetch(repsUrl, { headers: authH() })
      .then(r => r.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
        setCommReps(list);
      }).catch(() => {});
  }, [activeFileIds.join(',')]);

  // Persist key state to sessionStorage whenever it changes
  useEffect(() => { sessionStorage.setItem('rpt_mode', mode); }, [mode]);
  useEffect(() => { sessionStorage.setItem('rpt_commRepId', commRepId); }, [commRepId]);
  useEffect(() => { sessionStorage.setItem('rpt_sciRepId', sciRepId); }, [sciRepId]);
  useEffect(() => { sessionStorage.setItem('rpt_fromDate', fromDate); }, [fromDate]);
  useEffect(() => { sessionStorage.setItem('rpt_toDate', toDate); }, [toDate]);
  useEffect(() => { sessionStorage.setItem('rpt_view', reportView); }, [reportView]);

  // Auto-reload last report after page refresh (once reps list is loaded)
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current) return;
    if (mode === 'commercial' && commRepId && commReps.length > 0) {
      autoLoaded.current = true;
      loadCommReport(commRepId);
    } else if (mode === 'scientific' && sciRepId && sciReps.length > 0) {
      autoLoaded.current = true;
      loadSciReport(sciRepId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commReps, sciReps]);

  const loadCommReport = async (repIdOverride?: string) => {
    const id = repIdOverride ?? commRepId;
    if (!id) { setError(t.reports.errSelectComm); return; }
    setError(''); setLoading(true); setCommReport(null); setCommReturnsReport(null);
    try {
      const params = new URLSearchParams();
      if (fromDate)    params.set('startDate', fromDate);
      if (toDate)      params.set('endDate', toDate);
      if (activeFileIds.length > 0) params.set('fileIds', activeFileIds.join(','));

      const parseReport = (d: any): CommReport => ({
        repName:    d.representative?.name ?? '—',
        totalQty:   d.summary?.totalQuantity ?? 0,
        totalValue: d.summary?.totalValue    ?? 0,
        byArea: (d.byArea ?? []).map((r: any) => ({ name: r.areaName ?? r.name, repName: r.repName ?? undefined, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        byItem: (d.byItem ?? []).map((r: any) => ({ name: r.itemName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
      });

      const [salesRes, returnsRes] = await Promise.all([
        fetch(`/api/reports/representative/${id}?${params}&recordType=sale`, { headers: authH() }),
        fetch(`/api/reports/representative/${id}?${params}&recordType=return`, { headers: authH() }),
      ]);
      const [salesJson, returnsJson] = await Promise.all([salesRes.json(), returnsRes.json()]);
      if (!salesRes.ok) throw new Error(salesJson.message || t.reports.errLoad);
      setCommReport(parseReport(salesJson.data ?? salesJson));
      setCommReturnsReport(returnsRes.ok ? parseReport(returnsJson.data ?? returnsJson) : null);
      setReportView('sales');
      setActiveTab('area');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const loadSciReport = async (repIdOverride?: string) => {
    const id = repIdOverride ?? sciRepId;
    if (!id) { setError(t.reports.errSelectSci); return; }
    setError(''); setLoading(true); setSciReport(null); setSciReturnsReport(null);
    try {
      const params = new URLSearchParams();
      if (fromDate)    params.set('startDate', fromDate);
      if (toDate)      params.set('endDate', toDate);
      if (activeFileIds.length > 0) params.set('fileIds', activeFileIds.join(','));

      const parseSciReport = (d: any): SciReport => {
        const salesItems = (d.byItem ?? []).map((r: any) => ({ name: r.itemName ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 }));
        const assignedItemsList: Rep[] = d.assignedItems ?? [];
        const salesItemNames = new Set(salesItems.map((r: BreakdownRow) => r.name));
        const zeroItems: BreakdownRow[] = assignedItemsList
          .filter(i => !salesItemNames.has(i.name))
          .map(i => ({ name: i.name, totalQty: 0, totalValue: 0, isZero: true }));

        const salesAreas = (d.byArea ?? []).map((r: any) => ({ name: r.areaName ?? r.name, repName: r.repName ?? undefined, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 }));
        const assignedAreasList: Rep[] = d.assignedAreas ?? [];
        const salesAreaNames = new Set(salesAreas.map((r: BreakdownRow) => r.name));
        const zeroAreas: BreakdownRow[] = assignedAreasList
          .filter(a => !salesAreaNames.has(a.name))
          .map(a => ({ name: a.name, totalQty: 0, totalValue: 0, isZero: true }));

        return {
          repName:    d.scientificRep?.name ?? '—',
          totalQty:   d.summary?.totalQuantity ?? 0,
          totalValue: d.summary?.totalValue    ?? 0,
          assignedAreas:          assignedAreasList,
          assignedItems:          assignedItemsList,
          assignedCommercialReps: d.assignedCommercialReps ?? [],
          byArea: [...salesAreas, ...zeroAreas],
          byItem: [...salesItems, ...zeroItems],
          byRep:  (d.byRep  ?? []).map((r: any) => ({ name: r.repName  ?? r.name, totalQty: r.totalQuantity ?? 0, totalValue: r.totalValue ?? 0 })),
        };
      };

      const [salesRes, returnsRes] = await Promise.all([
        fetch(`/api/scientific-reps/${id}/report?${params}&recordType=sale`, { headers: authH() }),
        fetch(`/api/scientific-reps/${id}/report?${params}&recordType=return`, { headers: authH() }),
      ]);
      const [salesJson, returnsJson] = await Promise.all([salesRes.json(), returnsRes.json()]);
      if (!salesRes.ok) throw new Error(salesJson.message || t.reports.errLoad);
      setSciReport(parseSciReport(salesJson.data ?? salesJson));
      setSciReturnsReport(returnsRes.ok ? parseSciReport(returnsJson.data ?? returnsJson) : null);
      setReportView('sales');
      setActiveTab('area');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const fmt = (n: number) => Math.round(n || 0).toLocaleString('ar-IQ-u-nu-latn');
  const fmtSigned = (n: number) => (n >= 0 ? '+' : '') + fmt(n);

  // Currency-aware value formatting
  // IQD file → USD display: divide by rate
  // USD file → IQD display: multiply by rate
  // same currency: no change
  const convertVal = (n: number) => {
    const v = n || 0;
    if (fileSourceCurrency === 'IQD' && fileCurrencyMode === 'USD') return v / fileExchangeRate;
    if (fileSourceCurrency === 'USD' && fileCurrencyMode === 'IQD') return v * fileExchangeRate;
    return v;
  };
  const fmtVal = (n: number) => {
    const v = convertVal(n || 0);
    return fileCurrencyMode === 'USD'
      ? Math.round(v).toLocaleString('en-US')
      : Math.round(v).toLocaleString('ar-IQ-u-nu-latn');
  };
  const fmtValSigned = (n: number) => n >= 0 ? `+${fmtVal(Math.abs(n))}` : `-${fmtVal(Math.abs(n))}`;
  const currColHeader  = fileCurrencyMode === 'USD' ? `القيمة ($)` : t.reports.colValDinar;
  const currStatTotal  = fileCurrencyMode === 'USD' ? `إجمالي القيمة ($)` : t.reports.statTotalVal;
  const currStatNet    = fileCurrencyMode === 'USD' ? `صافي القيمة ($)` : t.reports.statNetVal;

  /* ─── Net breakdown table ─── */
  const renderNetTable = (sales: BreakdownRow[], returns: BreakdownRow[], nameLabel: string, hideQtyCols = false) => {
    const hasRep = sales.some(r => r.repName) || returns.some(r => r.repName);
    const rowKey = (r: BreakdownRow) => hasRep ? `${r.name}||${r.repName ?? ''}` : r.name;
    const salesMap  = Object.fromEntries(sales.map(r => [rowKey(r), r]));
    const retMap    = Object.fromEntries(returns.map(r => [rowKey(r), r]));
    // Remove rows where all four values are zero (avoids ghost duplicates when repName is null in one dataset)
    const allKeys = [...new Set([...sales.map(rowKey), ...returns.map(rowKey)])].filter(key => {
      const s = salesMap[key]  ?? { totalQty: 0, totalValue: 0 };
      const r = retMap[key]    ?? { totalQty: 0, totalValue: 0 };
      return s.totalQty !== 0 || s.totalValue !== 0 || r.totalQty !== 0 || r.totalValue !== 0;
    });
    const colCount = (hasRep ? 3 : 2) + (hideQtyCols ? 2 : 6); // name+# + optional rep + value cols
    const colSpanEmpty = colCount;
    return (
      <>
        {!hideQtyCols && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
          <button
            onClick={() => toggleQtyRevealed()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '3px 10px', borderRadius: '6px', border: '1px solid',
              fontSize: '11px', fontWeight: 600, cursor: 'pointer',
              background: qtyRevealed ? '#1e40af' : '#f8fafc',
              color: qtyRevealed ? '#fff' : '#64748b',
              borderColor: qtyRevealed ? '#1e40af' : '#e2e8f0',
              transition: 'all 0.15s', letterSpacing: '0.3px',
            }}
          >
            {qtyRevealed ? 'إخفاء الكميات' : 'إظهار الكميات'}
          </button>
        </div>
        )}
      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th><th>{nameLabel}</th>
              {hasRep && <th>👤 {t.reports.colCommRep}</th>}
              {!hideQtyCols && <th style={{ background: '#dbeafe', color: '#1e40af', whiteSpace: 'nowrap' }} title={t.reports.colSalesQty}>📦 {qtyRevealed ? '▼' : '▶'}</th>}
              <th style={{ background: '#dbeafe', color: '#1e40af', whiteSpace: 'nowrap' }} title={t.reports.colSalesVal}>💰 {!hideQtyCols && (qtyRevealed ? '▼' : '▶')}</th>
              {!hideQtyCols && <th style={{ background: '#fee2e2', color: '#991b1b', whiteSpace: 'nowrap' }} title={t.reports.colRetQty}>↩️ {qtyRevealed ? '▼' : '▶'}</th>}
              <th style={{ background: '#fee2e2', color: '#991b1b', whiteSpace: 'nowrap' }} title={t.reports.colRetVal}>💸 {!hideQtyCols && (qtyRevealed ? '▼' : '▶')}</th>
              {!hideQtyCols && <th style={{ background: '#d1fae5', color: '#065f46', whiteSpace: 'nowrap' }} title={t.reports.colNetQty}>✅</th>}
              <th style={{ background: '#d1fae5', color: '#065f46', whiteSpace: 'nowrap' }} title={t.reports.colNetVal}>🏆</th>
            </tr>
          </thead>
          <tbody>
            {allKeys.map((key, i) => {
              const s = salesMap[key]  ?? { totalQty: 0, totalValue: 0 };
              const r = retMap[key]    ?? { totalQty: 0, totalValue: 0 };
              const row = salesMap[key] ?? retMap[key];
              const netQty = s.totalQty - r.totalQty;
              const netVal = s.totalValue - r.totalValue;
              return (
                <tr key={key}>
                  <td>{i + 1}</td>
                  <td><strong>{row.name}</strong></td>
                  {hasRep && <td style={{ color: '#1e293b', fontWeight: 600, fontSize: 13 }}>{row.repName ?? '—'}</td>}
                  {!hideQtyCols && <td style={{ color: '#1d4ed8' }}>{qtyRevealed ? <HiddenQty value={s.totalQty} fmt={fmt} style={{ color: '#1d4ed8' }} forceReveal={true} /> : null}</td>}
                  <td style={{ color: '#1d4ed8' }}>{hideQtyCols ? fmtVal(s.totalValue) : (qtyRevealed ? fmtVal(s.totalValue) : null)}</td>
                  {!hideQtyCols && <td style={{ color: '#dc2626' }}>{qtyRevealed ? <HiddenQty value={r.totalQty} fmt={fmt} style={{ color: '#dc2626' }} forceReveal={true} /> : null}</td>}
                  <td style={{ color: '#dc2626' }}>{hideQtyCols ? fmtVal(r.totalValue) : (qtyRevealed ? fmtVal(r.totalValue) : null)}</td>
                  {!hideQtyCols && <td style={{ fontWeight: 700, color: netQty >= 0 ? '#065f46' : '#991b1b' }}><HiddenQty value={netQty} fmt={fmt} signed style={{ fontWeight: 700, color: netQty >= 0 ? '#065f46' : '#991b1b' }} forceReveal={true} /></td>}
                  <td style={{ fontWeight: 700, color: netVal >= 0 ? '#065f46' : '#991b1b' }}>{fmtValSigned(netVal)}</td>
                </tr>
              );
            })}
            {allKeys.length === 0 && <tr><td colSpan={colSpanEmpty} className="empty-row">{t.reports.noDataTable}</td></tr>}
            {allKeys.length > 0 && (() => {
              const totSalesQty = sales.reduce((s, r) => s + r.totalQty, 0);
              const totSalesVal = sales.reduce((s, r) => s + r.totalValue, 0);
              const totRetQty   = returns.reduce((s, r) => s + r.totalQty, 0);
              const totRetVal   = returns.reduce((s, r) => s + r.totalValue, 0);
              return (
                <tr style={{ background: '#f0fdf4', fontWeight: 800, borderTop: '2px solid #86efac' }}>
                  <td></td><td>{t.reports.totalLabel}</td>
                  {hasRep && <td></td>}
                  {!hideQtyCols && <td style={{ color: '#1d4ed8' }}>{qtyRevealed ? <HiddenQty value={totSalesQty} fmt={fmt} style={{ color: '#1d4ed8' }} forceReveal={true} /> : null}</td>}
                  <td style={{ color: '#1d4ed8' }}>{hideQtyCols ? fmtVal(totSalesVal) : (qtyRevealed ? fmtVal(totSalesVal) : null)}</td>
                  {!hideQtyCols && <td style={{ color: '#dc2626' }}>{qtyRevealed ? <HiddenQty value={totRetQty} fmt={fmt} style={{ color: '#dc2626' }} forceReveal={true} /> : null}</td>}
                  <td style={{ color: '#dc2626' }}>{hideQtyCols ? fmtVal(totRetVal) : (qtyRevealed ? fmtVal(totRetVal) : null)}</td>
                  {!hideQtyCols && <td style={{ color: totSalesQty - totRetQty >= 0 ? '#065f46' : '#991b1b' }}><HiddenQty value={totSalesQty - totRetQty} fmt={fmt} signed style={{ color: totSalesQty - totRetQty >= 0 ? '#065f46' : '#991b1b' }} forceReveal={true} /></td>}
                  <td style={{ color: totSalesVal - totRetVal >= 0 ? '#065f46' : '#991b1b' }}>{fmtValSigned(totSalesVal - totRetVal)}</td>
                </tr>
              );
            })()}
          </tbody>
        </table>
      </div>
      </>
    );
  };

  /* ─── Report view toggle ─── */
  const renderViewToggle = (hasSales: boolean, hasReturns: boolean) => (
    <div style={{ display: 'flex', gap: 10, margin: '16px 0 0', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {[
        { key: 'sales'   as ReportView, icon: '📦', label: t.reports.colSalesQty, bg: '#3b82f6', glow: '#3b82f644', border: '#1d4ed8' },
        { key: 'returns' as ReportView, icon: '↩️',  label: t.reports.colRetQty,  bg: '#ef4444', glow: '#ef444444', border: '#b91c1c' },
        { key: 'net'     as ReportView, icon: '🏆', label: t.reports.viewNet,     bg: '#10b981', glow: '#10b98144', border: '#065f46' },
      ].map(({ key, icon, label, bg, glow, border }) => {
        const isActive = reportView === key;
        const isDisabled = key === 'returns' && !hasReturns;
        return (
          <button
            key={key}
            onClick={() => setReportView(key)}
            disabled={isDisabled}
            title={label + (isDisabled ? ' — لا يوجد بيانات ارجاعات' : '')}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              padding: isActive ? '10px 16px 8px' : '7px 12px 6px',
              borderRadius: 12,
              border: isActive ? `2.5px solid ${border}` : '2.5px solid transparent',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              background: isActive ? bg : '#f1f5f9',
              color: isActive ? '#fff' : '#64748b',
              opacity: isDisabled ? 0.4 : 1,
              boxShadow: isActive ? `0 4px 18px ${glow}, 0 2px 6px ${glow}` : '0 1px 3px #0001',
              transform: isActive ? 'scale(1.12) translateY(-3px)' : 'scale(1)',
              transition: 'all 0.2s cubic-bezier(.34,1.56,.64,1)',
              minWidth: 48,
              position: 'relative',
            }}>
            <span style={{ fontSize: isActive ? 24 : 17, lineHeight: 1, transition: 'font-size 0.2s' }}>{icon}</span>
            <span style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.2, marginTop: 2, opacity: isActive ? 1 : 0.7 }}>{label}</span>
            {isActive && (
              <span style={{
                position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)',
                width: 8, height: 8, borderRadius: '50%', background: border,
                boxShadow: `0 0 6px ${border}`,
              }} />
            )}
          </button>
        );
      })}
      {!hasReturns && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff7ed', border: '1px solid #fed7aa',
          borderRadius: 8, padding: '5px 10px', fontSize: 12, color: '#9a3412',
        }}>
          <span>↩️</span>
          <span>لا يوجد بيانات ارجاعات — ارفع ملف ارجاعات من <strong>رفع الملفات</strong></span>
        </div>
      )}
    </div>
  );

  /* ─── Export with rep selection ─── */
  const doExport = async () => {
    if (selCommIds.size === 0 && selSciIds.size === 0) {
      setError(t.reports.exportSelectError); return;
    }
    setShowExportModal(false);
    setExporting(true);
    setExportProgress(t.reports.exportPreparing);
    try {
      const wb = XLSX.utils.book_new();

      const qp = new URLSearchParams();
      if (fromDate)    qp.set('startDate', fromDate);
      if (toDate)      qp.set('endDate',   toDate);
      if (activeFileIds.length > 0) qp.set('fileIds', activeFileIds.join(','));
      const qStr = qp.toString();

      // Build a sheet from raw sale rows
      // sciRepName: if provided, prepend an "اسم المندوب العلمي" column
      const buildSheet = (sales: any[], sciRepName?: string): any[][] => {
        if (sales.length === 0) return [[t.reports.noDataTable]];

        // Helper: detect & format date values to DD/MM/YYYY
        const fmtDate = (v: any): any => {
          if (v instanceof Date) return v.toLocaleDateString('en-GB');
          if (typeof v === 'string') {
            // ISO date string: "2026-03-02T..." or "2026-03-02"
            if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
              const d = new Date(v);
              return isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB');
            }
          }
          if (typeof v === 'number' && v > 25000 && v < 60000) {
            // Excel serial date (approx 1970–2060)
            const d = new Date(Math.round((v - 25569) * 86400 * 1000));
            return isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB');
          }
          return v;
        };

        // Detect if a column key is a date column
        const isDateKey = (k: string) =>
          /تاريخ|date/i.test(k);

        // Collect original Excel column names from rawData
        const allKeys = new Set<string>();
        let hasRaw = false;
        sales.forEach(s => {
          if (s.rawData) {
            hasRaw = true;
            try { Object.keys(JSON.parse(s.rawData)).forEach((k: string) => allKeys.add(k)); } catch {}
          }
        });
        if (hasRaw && allKeys.size > 0) {
          const headers = [...allKeys];
          const sciCol = sciRepName ? [t.reports.exportColSciRep] : [];
          return [
            [...sciCol, t.reports.exportColRecordType, ...headers],
            ...sales.map(s => {
              let raw: any = {};
              try { if (s.rawData) raw = JSON.parse(s.rawData); } catch {}
              const typeLabel = s.recordType === 'return' ? t.reports.exportTypeReturn : t.reports.exportTypeSales;
              const dataRow = headers.map(h => {
                const v = raw[h];
                if (isDateKey(h)) return fmtDate(v);
                return typeof v === 'number' ? Math.round(v * 100) / 100 : (v ?? '');
              });
              return sciRepName ? [sciRepName, typeLabel, ...dataRow] : [typeLabel, ...dataRow];
            }),
          ];
        }
        // Fallback — no rawData stored (old uploads)
        const sciCol = sciRepName ? [t.reports.exportColSciRep] : [];
        return [
          [...sciCol, t.reports.exportColRecordType, t.reports.exportColRepName, t.reports.colArea, t.reports.colItem, t.reports.colQty, t.reports.exportColValTotal, t.reports.exportColDate],
          ...sales.map(s => {
            const typeLabel = s.recordType === 'return' ? t.reports.exportTypeReturn : t.reports.exportTypeSales;
            const dataRow = [
              s.representative?.name ?? '',
              s.area?.name ?? '',
              s.item?.name ?? '',
              Math.round(s.quantity || 0),
              Math.round(s.totalValue || 0),
              fmtDate(s.saleDate),
            ];
            return sciRepName ? [sciRepName, typeLabel, ...dataRow] : [typeLabel, ...dataRow];
          }),
        ];
      };

      const addSheet = (name: string, rows: any[][]) => {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if (rows[0]) ws['!cols'] = rows[0].map(() => ({ wch: 22 }));
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      };

      const summaryData: any[][] = [
        ['#', t.reports.exportSumType, t.reports.exportColRepName, t.reports.exportSumTotalQty, t.reports.exportSumTotalVal]
      ];
      let idx = 1;

      // ── Commercial reps ───────────────────────────────
      for (const repId of Array.from(selCommIds)) {
        const rep = commReps.find(r => r.id === repId);
        const repName = rep?.name ?? `${t.reports.exportCommType} ${repId}`;
        setExportProgress(`${t.reports.exportProgressMsg}: ${repName}...`);
        const res  = await fetch(`/api/export/raw-sales?commRepIds=${repId}&${qStr}`, { headers: authH() });
        const json = await res.json();
        const sales: any[] = json.data ?? [];
        const totalQty = sales.reduce((s, r) => s + (r.quantity  || 0), 0);
        const totalVal = sales.reduce((s, r) => s + (r.totalValue|| 0), 0);
        summaryData.push([idx++, t.reports.exportCommType, repName, Math.round(totalQty), Math.round(totalVal)]);
        addSheet(`${t.reports.exportCommPrefix}-${repName}`, buildSheet(sales));  // no sciRepName for commercial
      }

      // ── Scientific reps (show sales of their assigned commercial reps) ─
      for (const repId of Array.from(selSciIds)) {
        const rep = sciReps.find(r => r.id === repId);
        setExportProgress(`${t.reports.exportProgressMsg}: ${rep?.name ?? repId}...`);
        const rRes  = await fetch(`/api/scientific-reps/${repId}/report?${qStr}`, { headers: authH() });
        const rJson = await rRes.json();
        const d = rJson.data ?? rJson;
        const sciName       = d.scientificRep?.name ?? rep?.name ?? `${t.reports.exportSciType} ${repId}`;
        const assignedIds: number[] = (d.assignedCommercialReps ?? []).map((r: any) => r.id).filter(Boolean);
        let sales: any[] = [];
        if (assignedIds.length > 0) {
          const sRes  = await fetch(`/api/export/raw-sales?commRepIds=${assignedIds.join(',')}&${qStr}`, { headers: authH() });
          const sJson = await sRes.json();
          sales = sJson.data ?? [];
        }
        const totalQty = sales.reduce((s, r) => s + (r.quantity  || 0), 0);
        const totalVal = sales.reduce((s, r) => s + (r.totalValue|| 0), 0);
        summaryData.push([idx++, t.reports.exportSciType, sciName, Math.round(totalQty), Math.round(totalVal)]);
        addSheet(`${t.reports.exportSciPrefix}-${sciName}`, buildSheet(sales, sciName));  // pass sciRepName
      }

      // ── Grand total row ──────────────────────────────
      if (summaryData.length > 1) {
        const gQty = summaryData.slice(1).reduce((s, r) => s + (r[3] || 0), 0);
        const gVal = summaryData.slice(1).reduce((s, r) => s + (r[4] || 0), 0);
        summaryData.push(['', t.reports.exportGrandTotal, '', gQty, gVal]);
      }

      // ── Add summary sheet FIRST ─────────────────────────
      const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
      summaryWs['!cols'] = [{ wch: 4 }, { wch: 10 }, { wch: 30 }, { wch: 18 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, summaryWs, t.reports.exportSummarySheet);
      // Move summary to front
      const si = wb.SheetNames.indexOf(t.reports.exportSummarySheet);
      if (si > 0) { wb.SheetNames.splice(si, 1); wb.SheetNames.unshift(t.reports.exportSummarySheet); }

      setExportProgress(t.reports.exportSavingFile);
      XLSX.writeFile(wb, `${t.reports.exportFileName}_${new Date().toISOString().slice(0,10)}.xlsx`);
    } catch (e: any) {
      setError(t.reports.exportFailed + e.message);
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  };

  const renderBreakdownTable = (rows: BreakdownRow[], totalValue: number, nameLabel: string, hideQtyCols = false) => {
    const hasRep   = rows.some(r => r.repName);
    const salesRows = rows.filter(r => !r.isZero);
    const zeroRows  = rows.filter(r => r.isZero);
    const colCount  = hasRep ? (hideQtyCols ? 3 : 4) : (hideQtyCols ? 2 : 3);
    return (
    <>
      {!hideQtyCols && (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <button
          onClick={() => toggleQtyRevealed()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '3px 10px', borderRadius: '6px', border: '1px solid',
            fontSize: '11px', fontWeight: 600, cursor: 'pointer',
            background: qtyRevealed ? '#1e40af' : '#f8fafc',
            color: qtyRevealed ? '#fff' : '#64748b',
            borderColor: qtyRevealed ? '#1e40af' : '#e2e8f0',
            transition: 'all 0.15s', letterSpacing: '0.3px',
          }}
        >
          {qtyRevealed ? 'إخفاء الكميات' : 'إظهار الكميات'}
        </button>
      </div>
      )}
    <div className="table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{nameLabel}</th>
            {hasRep && <th>👤 {t.reports.colCommRep}</th>}
            {!hideQtyCols && <th>{t.reports.colQty}</th>}
            <th>{currColHeader}</th>
          </tr>
        </thead>
        <tbody>
          {salesRows.map((row, i) => {
            const pct = totalValue > 0 ? ((row.totalValue / totalValue) * 100).toFixed(1) : '0';
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><strong>{row.name}</strong></td>
                {hasRep && <td style={{ color: '#4f46e5', fontWeight: 600, fontSize: 13 }}>{row.repName ?? '—'}</td>}
                {!hideQtyCols && <td><HiddenQty value={row.totalQty} fmt={fmt} forceReveal={qtyRevealed} /></td>}
                <td>{fmtVal(row.totalValue)}</td>
              </tr>
            );
          })}
          {salesRows.length === 0 && zeroRows.length === 0 && (
            <tr><td colSpan={colCount} className="empty-row">{t.reports.noDataTable}</td></tr>
          )}

          {/* ─── Zero-sales divider row ─── */}
          {zeroRows.length > 0 && (
            <tr>
              <td colSpan={colCount} style={{
                padding: '10px 16px',
                background: 'linear-gradient(90deg, #f8fafc 0%, #f1f5f9 100%)',
                borderTop: '2px dashed #cbd5e1',
                borderBottom: '2px dashed #cbd5e1',
                color: '#64748b',
                fontSize: '12px',
                fontWeight: 700,
                textAlign: 'center',
                letterSpacing: '0.05em',
              }}>
                ⚠️ {t.reports.zeroItemsMsg} — {zeroRows.length} {t.reports.zeroItemsUnit}
              </td>
            </tr>
          )}
          {zeroRows.map((row, i) => (
            <tr key={`zero-${i}`} style={{ background: '#fafafa', opacity: 0.75 }}>
              <td style={{ color: '#94a3b8' }}>{salesRows.length + i + 1}</td>
              <td>
                <span style={{ color: '#475569', fontWeight: 500 }}>{row.name}</span>
                <span style={{ marginRight: '8px', fontSize: '11px', background: '#fee2e2', color: '#dc2626', borderRadius: '4px', padding: '1px 6px', fontWeight: 600 }}>
                  {t.reports.noSalesLabel}
                </span>
              </td>
              {hasRep && <td style={{ color: '#94a3b8' }}>—</td>}
              {!hideQtyCols && <td style={{ color: '#94a3b8' }}>0</td>}
              <td style={{ color: '#94a3b8' }}>0</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t.reports.title}</h1>
          <p className="page-subtitle">{t.reports.subtitle}</p>
        </div>
        <button
          onClick={() => setShowExportModal(true)}
          disabled={exporting}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 20px', borderRadius: '10px', border: 'none', cursor: exporting ? 'not-allowed' : 'pointer',
            background: exporting ? '#d1fae5' : 'linear-gradient(135deg,#10b981,#059669)',
            color: '#fff', fontWeight: 700, fontSize: '14px',
            boxShadow: exporting ? 'none' : '0 2px 8px rgba(16,185,129,.35)',
            transition: 'all .2s',
            opacity: exporting ? 0.75 : 1,
          }}
        >
          {exporting ? `⏳ ${exportProgress}` : `📥 ${t.reports.export}`}
        </button>
      </div>

      {/* Mode toggle */}
      <div className="tabs" style={{ marginBottom: 0 }}>
        <button className={`tab ${mode === 'commercial' ? 'tab--active' : ''}`} onClick={() => { setMode('commercial'); setError(''); setCommReport(null); }}>
          💰 {t.reports.modeCommercial}
        </button>
        <button className={`tab ${mode === 'scientific' ? 'tab--active' : ''}`} onClick={() => { setMode('scientific'); setError(''); setSciReport(null); }}>
          🔬 {t.reports.modeScientific}
        </button>
      </div>

      {/* Filters Card */}
      <div className="filter-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>

          {/* Rep selector */}
          {mode === 'commercial' ? (
            <select className="form-input" style={{ flex: '1 1 160px', maxWidth: 280 }} value={commRepId}
              onChange={e => { setCommRepId(e.target.value); if (e.target.value) loadCommReport(e.target.value); }}>
              <option value="">-- {t.reports.selectCommRep} --</option>
              {commReps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ) : (
            <select className="form-input" style={{ flex: '1 1 160px', maxWidth: 280 }} value={sciRepId}
              onChange={e => { setSciRepId(e.target.value); if (e.target.value) loadSciReport(e.target.value); }}>
              <option value="">-- {t.reports.selectSciRep} --</option>
              {sciReps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}

          {/* Combined date range block — icon only, hidden inputs */}
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            <label
              title={fromDate && toDate ? `${fromDate} → ${toDate}` : fromDate ? `من ${fromDate}` : toDate ? `إلى ${toDate}` : `${t.reports.fromDate} / ${t.reports.toDate}`}
              style={{
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: (fromDate || toDate) ? '#6366f1' : '#f1f5f9',
                border: `1.5px solid ${(fromDate || toDate) ? '#6366f1' : '#e2e8f0'}`,
                boxShadow: (fromDate || toDate) ? '0 2px 8px #6366f144' : 'none',
                fontSize: 20, transition: 'all 0.2s',
              }}
            >
              📅
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
            </label>
            {(fromDate || toDate) && (
              <span onClick={() => { setFromDate(''); setToDate(''); }}
                style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#ef4444', color: '#fff', fontSize: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', fontWeight: 700, lineHeight: 1,
                }}>✕</span>
            )}
          </div>
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            <label
              title={toDate || t.reports.toDate}
              style={{
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: toDate ? '#6366f1' : '#f1f5f9',
                border: `1.5px solid ${toDate ? '#6366f1' : '#e2e8f0'}`,
                boxShadow: toDate ? '0 2px 8px #6366f144' : 'none',
                fontSize: 20, transition: 'all 0.2s',
              }}
            >
              📅
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
            </label>
          </div>

          {/* Generate icon button */}
          <button
            title={t.reports.generate}
            onClick={() => mode === 'commercial' ? loadCommReport() : loadSciReport()}
            disabled={loading}
            style={{
              width: 40, height: 40, borderRadius: 10, border: 'none', flexShrink: 0,
              background: loading ? '#a5b4fc' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
              color: '#fff', fontSize: 20, cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px #6366f144', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? '⏳' : '🔍'}
          </button>

        </div>
      </div>

      {error && (
        <div style={{
          background: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
          borderLeft: '4px solid #f43f5e',
          borderRadius: '0 14px 14px 0',
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 4px 20px rgba(244,63,94,0.12)',
          marginBottom: 4,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: '#fecdd3',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
          }}>⚠️</div>
          <span style={{ flex: 1, color: '#881337', fontSize: 13, fontWeight: 500 }}>{error}</span>
        </div>
      )}

      {/* ─── Commercial Rep Report ─── */}
      {mode === 'commercial' && commReport && (() => {
        const viewData    = reportView === 'returns' ? commReturnsReport! : commReport;
        const netQtyTotal = (commReport?.totalQty ?? 0) - (commReturnsReport?.totalQty ?? 0);
        const netValTotal = (commReport?.totalValue ?? 0) - (commReturnsReport?.totalValue ?? 0);
        const isNet = reportView === 'net';
        return (
        <>
          <div className="report-summary">

            {renderViewToggle(true, (commReturnsReport?.totalQty ?? 0) > 0)}
            <div style={{ marginTop: 16, maxWidth: 360 }}>
              <div className="stat-card" style={{ borderTop: `4px solid ${isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981'}` }}>
                <div className="stat-card-icon" style={{ background: isNet ? '#d1fae5' : reportView === 'returns' ? '#fee2e2' : '#d1fae5', color: isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981' }}>💰</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: isNet ? (netValTotal >= 0 ? '#065f46' : '#991b1b') : reportView === 'returns' ? '#ef4444' : '#10b981' }}>
                    {isNet ? fmtValSigned(netValTotal) : fmtVal(viewData?.totalValue ?? 0)}
                  </div>
                  <div className="stat-card-label">{isNet ? currStatNet : currStatTotal}</div>
                </div>
              </div>
            </div>
          </div>
          <div className="tabs">
            <button title={t.reports.tabByArea}   className={`tab ${activeTab === 'area' ? 'tab--active' : ''}`} onClick={() => setActiveTab('area')}>📍</button>
            <button title={t.reports.tabByItem}   className={`tab ${activeTab === 'item' ? 'tab--active' : ''}`} onClick={() => setActiveTab('item')}>💊</button>
          </div>
          {isNet ? (
            <>
              {activeTab === 'area' && renderNetTable(commReport.byArea, commReturnsReport?.byArea ?? [], t.reports.colArea, true)}
              {activeTab === 'item' && renderNetTable(commReport.byItem, commReturnsReport?.byItem ?? [], t.reports.colItem)}
            </>
          ) : (
            <>
              {activeTab === 'area' && renderBreakdownTable(viewData?.byArea ?? [], viewData?.totalValue ?? 0, t.reports.colArea, true)}
              {activeTab === 'item' && renderBreakdownTable(viewData?.byItem ?? [], viewData?.totalValue ?? 0, t.reports.colItem)}
            </>
          )}
        </>
        );
      })()}

      {/* ─── Scientific Rep Report ─── */}
      {mode === 'scientific' && sciReport && (() => {
        const viewData    = reportView === 'returns' ? sciReturnsReport! : sciReport;
        const netQtyTotal = (sciReport?.totalQty ?? 0) - (sciReturnsReport?.totalQty ?? 0);
        const netValTotal = (sciReport?.totalValue ?? 0) - (sciReturnsReport?.totalValue ?? 0);
        const isNet = reportView === 'net';
        return (
        <>
          <div className="report-summary">


            {/* Info tags — hidden by default, toggle on click */}
            <div style={{ margin: '0.6rem 0' }}>
              <button
                onClick={() => setShowInfoTags(v => !v)}
                style={{
                  background: showInfoTags ? '#ede9fe' : '#f3f4f6',
                  border: `1px solid ${showInfoTags ? '#c4b5fd' : '#e5e7eb'}`,
                  borderRadius: 20, padding: '4px 14px', cursor: 'pointer',
                  fontSize: '1rem', color: showInfoTags ? '#6d28d9' : '#6b7280',
                }}
                title={showInfoTags ? 'إخفاء التفاصيل' : 'عرض المناطق والمندوبين والأيتمات'}
              >
                {showInfoTags ? '🔼' : '🔽'}
              </button>
              {showInfoTags && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.6rem' }}>
                  {sciReport.assignedCommercialReps.map(r => (
                    <span key={r.id} className="tag tag--green">💰 {r.name}</span>
                  ))}
                  {sciReport.assignedAreas.map(a => (
                    <span key={a.id} className="tag tag--purple">📍 {a.name}</span>
                  ))}
                  {sciReport.assignedItems.map(i => (
                    <span key={i.id} className="tag tag--orange">💊 {i.name}</span>
                  ))}
                  {sciReport.assignedCommercialReps.length === 0 && (
                    <span className="tag" style={{ background: '#fee2e2', color: '#dc2626' }}>⚠️ {t.reports.noCommRepsAssigned}</span>
                  )}
                </div>
              )}
            </div>

            {renderViewToggle(true, (sciReturnsReport?.totalQty ?? 0) > 0)}

            <div style={{ marginTop: 16, maxWidth: 360 }}>
              <div className="stat-card" style={{ borderTop: `4px solid ${isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981'}` }}>
                <div className="stat-card-icon" style={{ background: isNet ? '#d1fae5' : reportView === 'returns' ? '#fee2e2' : '#d1fae5', color: isNet ? '#10b981' : reportView === 'returns' ? '#ef4444' : '#10b981' }}>💰</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: isNet ? (netValTotal >= 0 ? '#065f46' : '#991b1b') : reportView === 'returns' ? '#ef4444' : '#10b981' }}>
                    {isNet ? fmtValSigned(netValTotal) : fmtVal(viewData?.totalValue ?? 0)}
                  </div>
                  <div className="stat-card-label">{isNet ? currStatNet : currStatTotal}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="tabs">
            <button title={t.reports.tabByArea}    className={`tab ${activeTab === 'area' ? 'tab--active' : ''}`} onClick={() => setActiveTab('area')}>📍</button>
            <button title={t.reports.tabByItem}    className={`tab ${activeTab === 'item' ? 'tab--active' : ''}`} onClick={() => setActiveTab('item')}>💊</button>
            <button title={t.reports.tabByCommRep} className={`tab ${activeTab === 'rep'  ? 'tab--active' : ''}`} onClick={() => setActiveTab('rep')}>👤</button>
          </div>
          {isNet ? (
            <>
              {activeTab === 'area' && renderNetTable(sciReport.byArea, sciReturnsReport?.byArea ?? [], t.reports.colArea, true)}
              {activeTab === 'item' && renderNetTable(sciReport.byItem, sciReturnsReport?.byItem ?? [], t.reports.colItem)}
              {activeTab === 'rep'  && renderNetTable(sciReport.byRep,  sciReturnsReport?.byRep  ?? [], t.reports.colCommRep, true)}
            </>
          ) : (
            <>
              {activeTab === 'area' && renderBreakdownTable(viewData?.byArea ?? [], viewData?.totalValue ?? 0, t.reports.colArea, true)}
              {activeTab === 'item' && renderBreakdownTable(viewData?.byItem ?? [], viewData?.totalValue ?? 0, t.reports.colItem)}
              {activeTab === 'rep'  && renderBreakdownTable(viewData?.byRep  ?? [], viewData?.totalValue ?? 0, t.reports.colCommRep, true)}
            </>
          )}
        </>
        );
      })()}

      {/* ─── Export Selection Modal ─── */}
      {showExportModal && (
        <div className="modal-overlay" onClick={() => !exporting && setShowExportModal(false)}>
          <div className="modal modal--wide" style={{ maxWidth: 700 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">{t.reports.exportTitle}</h2>
              <button className="modal-close" onClick={() => setShowExportModal(false)}>✕</button>
            </div>

            <div style={{ padding: '12px 24px 4px', fontSize: 12, color: '#6b7280', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
              {t.reports.exportOldFileNote}
            </div>

            <div className="export-modal-grid" style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Commercial Reps */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ color: '#374151', fontSize: 14 }}>💼 {t.reports.exportCommLabel} ({commReps.length})</strong>
                  <button style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                    onClick={() => {
                      const s = new Set(selCommIds);
                      commReps.every(r => s.has(r.id)) ? commReps.forEach(r => s.delete(r.id)) : commReps.forEach(r => s.add(r.id));
                      setSelCommIds(s);
                    }}>
                    {commReps.every(r => selCommIds.has(r.id)) && commReps.length > 0 ? t.reports.exportDeselectAll : t.reports.exportSelectAll}
                  </button>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {commReps.length === 0
                    ? <span style={{ color: '#9ca3af', fontSize: 13 }}>{t.reports.exportNoReps}</span>
                    : commReps.map(r => (
                      <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', borderRadius: 8, background: selCommIds.has(r.id) ? '#eef2ff' : '#f9fafb', border: `1px solid ${selCommIds.has(r.id) ? '#a5b4fc' : '#e5e7eb'}` }}>
                        <input type="checkbox" checked={selCommIds.has(r.id)} onChange={e => {
                          const s = new Set(selCommIds);
                          e.target.checked ? s.add(r.id) : s.delete(r.id);
                          setSelCommIds(s);
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                      </label>
                    ))}
                </div>
              </div>

              {/* Scientific Reps */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ color: '#374151', fontSize: 14 }}>🔬 {t.reports.exportSciLabel} ({sciReps.length})</strong>
                  <button style={{ fontSize: 12, color: '#10b981', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                    onClick={() => {
                      const s = new Set(selSciIds);
                      sciReps.every(r => s.has(r.id)) ? sciReps.forEach(r => s.delete(r.id)) : sciReps.forEach(r => s.add(r.id));
                      setSelSciIds(s);
                    }}>
                    {sciReps.every(r => selSciIds.has(r.id)) && sciReps.length > 0 ? t.reports.exportDeselectAll : t.reports.exportSelectAll}
                  </button>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {sciReps.length === 0
                    ? <span style={{ color: '#9ca3af', fontSize: 13 }}>{t.reports.exportNoReps}</span>
                    : sciReps.map(r => (
                      <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', borderRadius: 8, background: selSciIds.has(r.id) ? '#f0fdf4' : '#f9fafb', border: `1px solid ${selSciIds.has(r.id) ? '#86efac' : '#e5e7eb'}` }}>
                        <input type="checkbox" checked={selSciIds.has(r.id)} onChange={e => {
                          const s = new Set(selSciIds);
                          e.target.checked ? s.add(r.id) : s.delete(r.id);
                          setSelSciIds(s);
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                      </label>
                    ))}
                </div>
              </div>
            </div>

            <div style={{ padding: '14px 24px', background: '#f9fafb', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                {(selCommIds.size + selSciIds.size) > 0
                  ? `✅ ${selCommIds.size + selSciIds.size} ${t.reports.exportSelectedCount}`
                  : t.reports.exportSelectHint}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--secondary" style={{ padding: '8px 16px' }} onClick={() => setShowExportModal(false)}>{t.reports.exportCancel}</button>
                <button
                  onClick={doExport}
                  disabled={selCommIds.size + selSciIds.size === 0}
                  style={{
                    padding: '8px 22px', borderRadius: 8, border: 'none',
                    cursor: (selCommIds.size + selSciIds.size) === 0 ? 'not-allowed' : 'pointer',
                    background: (selCommIds.size + selSciIds.size) === 0 ? '#d1d5db' : 'linear-gradient(135deg,#10b981,#059669)',
                    color: '#fff', fontWeight: 700, fontSize: 14,
                  }}
                >
                  {t.reports.exportStart}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom warning bar when no file is active ── */}
      {activeFileIds.length === 0 && (
        <div style={{
          position: 'sticky', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #6d28d9 100%)',
          padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 13, color: '#e0e7ff', fontWeight: 500,
          zIndex: 100,
          boxShadow: '0 -6px 32px rgba(99,102,241,0.45)',
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, flexShrink: 0,
          }}>📊</div>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
              {t.reports.noActiveFileTitle}
            </div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              {t.reports.noActiveFileDesc}
            </div>
          </div>
          <div
            onClick={() => onNavigate?.('upload')}
            className="upload-badge-pulse"
            style={{
              padding: '7px 18px',
              backdropFilter: 'blur(8px)',
              borderRadius: 24,
              fontSize: 12, fontWeight: 700, color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)',
              whiteSpace: 'nowrap', letterSpacing: '0.3px',
              cursor: 'pointer',
            }}
          >{t.common.uploadPageBtn}</div>
        </div>
      )}
    </div>
  );
}
