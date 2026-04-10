import { useState, useRef, useCallback, useEffect } from 'react';
import AnalysisRenderer from '../components/AnalysisRenderer';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface UploadedFile {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
  fileType?: string;
  currencyMode?: string;
  exchangeRate?: number;
  detectedCurrency?: string;
  _count?: { sales: number };
}

interface Props {
  activeFileIds: number[];
  onFileActivated: (id: number | null) => void;
}

const API = '';

export default function UploadPage({ activeFileIds, onFileActivated }: Props) {
  const { token, hasFeature } = useAuth();
  const { t } = useLanguage();
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress]   = useState(0);
  const [error, setError]         = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const [fileType, setFileType]   = useState<'sales' | 'returns' | 'auto'>('sales');

  // Pre-upload currency picker
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preCurrency, setPreCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [uploadResult, setUploadResult] = useState<{
    salesCount?: number;
    returnsCount?: number;
    normalizations?: Array<{ from: string; to: string; source: string; entityType: string }>;
    unknownItems?: string[];
  } | null>(null);
  const [showNorm, setShowNorm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Files list
  const [files, setFiles]             = useState<UploadedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Analysis
  const [analyzeFile, setAnalyzeFile] = useState<UploadedFile | null>(null);
  const [analysisText, setAnalysisText] = useState('');
  const [analyzing, setAnalyzing]     = useState(false);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res  = await fetch(`${API}/api/files`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      setFiles(Array.isArray(json.data) ? json.data : []);
    } catch { /* ignore */ }
    finally { setFilesLoading(false); }
  }, [token]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const uploadFile = useCallback(async (file: File, sourceCurrency: 'IQD' | 'USD') => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      setError(t.upload.invalidFile);
      return;
    }
    setError('');
    setErrorDetail('');
    setUploading(true);
    setProgress(20);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileType', fileType);
    formData.append('sourceCurrency', sourceCurrency);
    try {
      setProgress(50);
      const res  = await fetch(`${API}/api/upload-sales`, { method: 'POST', body: formData, headers: { Authorization: `Bearer ${token}` } });
      setProgress(80);
      const data = await res.json();
      setProgress(100);
      if (!res.ok) {
        const msg = data.message || data.error || t.upload.uploadFailed;
        const detailMatch = msg.match(/Detected columns: \[(.+?)\]/);
        if (detailMatch) setErrorDetail(`${t.upload.columnsFound}: ${detailMatch[1]}`);
        throw new Error(msg.split('\n')[0]);
      }
      // Auto-activate new file
      const newFileId = data.data?.uploadedFile?.id ?? data.uploadedFile?.id;
      const norms = data.data?.normalizations ?? data.normalizations ?? [];
      const unknownItems = data.data?.unknownItems ?? data.unknownItems ?? [];
      setUploadResult({
        salesCount:  data.data?.salesCount,
        returnsCount: data.data?.returnsCount,
        normalizations: norms,
        unknownItems,
      });
      setShowNorm(norms.length > 0);
      setTimeout(() => { setUploadResult(null); setShowNorm(false); }, 18000);
      // toggle-activate the new file (if not already active)
      if (newFileId && !activeFileIds.includes(newFileId)) onFileActivated(newFileId);
      await loadFiles();
    } catch (err: any) {
      setError(err.message || t.upload.error);
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 1000);
    }
  }, [loadFiles, onFileActivated, fileType, activeFileIds, token]);

  const requestUpload = (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      setError(t.upload.invalidFile);
      return;
    }
    setPreCurrency('IQD');
    setPendingFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) requestUpload(file);
  };

  const [deleting, setDeleting] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [syncDone, setSyncDone] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{areas: number; items: number} | null>(null);
  const [deduping, setDeduping] = useState(false);
  const [dedupResult, setDedupResult] = useState<{ count: number; normalizations: any[] } | null>(null);
  const [showDedupDetail, setShowDedupDetail] = useState(false);

  // Currency conversion state
  const [redetecting, setRedetecting] = useState<number | null>(null);
  const [currencyModal, setCurrencyModal] = useState<UploadedFile | null>(null);
  const [currModalSource, setCurrModalSource] = useState<'IQD' | 'USD'>('IQD');
  const [currModalMode, setCurrModalMode] = useState<'IQD' | 'USD'>('IQD');
  const [currModalRate, setCurrModalRate] = useState<string>('1500');
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [currSaveMsg, setCurrSaveMsg] = useState('');

  const dedupNames = async (apply: boolean) => {
    setDeduping(true);
    setDedupResult(null);
    try {
      const res  = await fetch(`${API}/api/dedup-names`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ apply }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t.upload.dedupFailed);
      setDedupResult({ count: json.count, normalizations: json.normalizations ?? [] });
      setShowDedupDetail(false);
      setTimeout(() => setDedupResult(null), 15000);
    } catch (err: any) {
      setError(err.message || t.upload.dedupError);
    } finally {
      setDeduping(false);
    }
  };

  const cleanupOrphans = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const res  = await fetch(`${API}/api/cleanup-orphans`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t.upload.cleanFailed);
      setCleanResult({ areas: json.deletedAreas, items: json.deletedItems });
      setTimeout(() => setCleanResult(null), 5000);
    } catch (err: any) {
      setError(err.message || t.upload.cleanError);
    } finally {
      setCleaning(false);
    }
  };

  const syncAssignments = async (id: number) => {
    setSyncing(id);
    setSyncDone(null);
    try {
      const res  = await fetch(`${API}/api/files/${id}/sync-assignments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t.upload.syncFailed);
      setSyncDone(id);
      setTimeout(() => setSyncDone(null), 3000);
    } catch (err: any) {
      setError(err.message || t.upload.syncError);
    } finally {
      setSyncing(null);
    }
  };

  const deleteFile = async (id: number) => {
    setDeleting(id);
    setConfirmId(null);
    try {
      const res = await fetch(`${API}/api/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t.upload.deleteFailed);
      // Remove from active list if it was active
      if (activeFileIds.includes(id)) onFileActivated(id);
      await loadFiles();
    } catch (err: any) {
      setError(err.message || t.upload.deleteError);
    } finally {
      setDeleting(null);
    }
  };

  const handleAnalyze = async (file: UploadedFile) => {
    setAnalyzeFile(file);
    setAnalysisText('');
    setAnalyzing(true);
    try {
      const res  = await fetch(`${API}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fileId: file.id }),
      });
      const data = await res.json();
      setAnalysisText(data.analysis || t.upload.analysisEmpty);
    } catch {
      setAnalysisText(t.upload.analysisFailed);
    } finally {
      setAnalyzing(false);
    }
  };

  const redetectCurrency = async (f: UploadedFile) => {
    setRedetecting(f.id);
    try {
      const res = await fetch(`${API}/api/files/${f.id}/redetect-currency`, { method: 'POST', credentials: 'include' });
      if (res.ok) loadFiles();
    } finally {
      setRedetecting(null);
    }
  };

  const openCurrencyModal = (f: UploadedFile) => {
    setCurrencyModal(f);
    setCurrModalSource(f.detectedCurrency === 'USD' ? 'USD' : 'IQD');
    setCurrModalMode(f.currencyMode === 'USD' ? 'USD' : 'IQD');
    setCurrModalRate(String(f.exchangeRate ?? 1500));
    setCurrSaveMsg('');
  };

  const saveCurrencySettings = async () => {
    if (!currencyModal) return;
    const rate = parseFloat(currModalRate);
    if (!isFinite(rate) || rate <= 0) return;
    setSavingCurrency(true);
    setCurrSaveMsg('');
    try {
      const res = await fetch(`${API}/api/files/${currencyModal.id}/currency`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currencyMode: currModalMode, exchangeRate: rate, sourceCurrency: currModalSource }),
      });
      if (!res.ok) throw new Error();
      setCurrSaveMsg(t.upload.currencySaved);
      await loadFiles();
      setTimeout(() => setCurrencyModal(null), 900);
    } catch {
      setCurrSaveMsg(t.upload.currencySaveFailed);
    } finally {
      setSavingCurrency(false);
    }
  };

  const fmtDate = (d: string) => new Date(d).toLocaleDateString('ar-IQ-u-nu-latn');
  const activeFiles = files.filter(f => activeFileIds.includes(f.id));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t.upload.title}</h1>
          <p className="page-subtitle">{t.upload.subtitle}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {cleanResult && (
            <span style={{ fontSize: '13px', color: '#065f46', background: '#d1fae5', borderRadius: '8px', padding: '5px 12px', fontWeight: 600 }}>
              {t.upload.cleanSuccessPrefix} {cleanResult.areas} {t.upload.cleanSuccessArea} {t.upload.cleanSuccessAnd} {cleanResult.items} {t.upload.cleanSuccessItem}
            </span>
          )}
          {dedupResult && (
            <span style={{ fontSize: '13px', color: '#1e3a5f', background: '#dbeafe', borderRadius: '8px', padding: '5px 12px', fontWeight: 600, cursor: dedupResult.count > 0 ? 'pointer' : 'default' }}
              onClick={() => dedupResult.count > 0 && setShowDedupDetail(v => !v)}>
              {dedupResult.count === 0
                ? t.upload.dedupNoSimilar
                : `🔀 ${t.upload.dedupUnified} ${dedupResult.count} ${t.upload.dedupNamesUnit} ${showDedupDetail ? '▲' : '▼'}`}
            </span>
          )}
        </div>
      </div>

      {/* Active files banner */}
      {activeFiles.length > 0 ? (
        <div className="info-banner" style={{ background: '#f0fdf4', borderColor: '#86efac', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="info-banner-icon">✅</span>
            <strong>{activeFiles.length === 1 ? t.upload.activeFileSingle : `${activeFiles.length} ${t.upload.activeFilesMulti}`}:</strong>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingRight: 8 }}>
            {activeFiles.map(f => (
              <span key={f.id} style={{ background: '#dcfce7', color: '#15803d', borderRadius: 20, padding: '3px 12px', fontSize: 13, fontWeight: 600 }}>
                {f.fileType === 'returns' ? '↩' : f.fileType === 'auto' ? '🔀' : '📦'} {f.originalName}
              </span>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#166534', paddingRight: 8 }}>{t.upload.allReportsNote}</p>
        </div>
      ) : (
        <div className="info-banner" style={{ background: '#fff7ed', borderColor: '#fdba74' }}>
          <span className="info-banner-icon">⚠️</span>
          <div>
            <strong>{t.upload.noActiveFile}</strong>
            <p>{t.upload.noActiveFileDesc}</p>
          </div>
        </div>
      )}

      {/* Drop Zone */}
      <div
        className={`drop-zone ${dragging ? 'drop-zone--active' : ''} ${uploading ? 'drop-zone--uploading' : ''}`}
        style={{ cursor: 'default', paddingBottom: uploading ? undefined : '1.6rem' }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) requestUpload(f); e.target.value = ''; }}
        />

        {uploading ? (
          <>
            <div className="drop-zone-icon">⏳</div>
            <div className="drop-zone-text">{t.upload.uploading}</div>
          </>
        ) : dragging ? (
          <>
            <div className="drop-zone-icon">📂</div>
            <div className="drop-zone-text">{t.upload.dropHere}</div>
          </>
        ) : (
          <>
            <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16, fontWeight: 600 }}>
              {t.upload.chooseFileType}
            </div>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
              {([
                { type: 'sales',   label: t.upload.typeSales,   icon: '📦', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe', shadow: 'rgba(59,130,246,0.25)' },
                { type: 'returns', label: t.upload.typeReturns, icon: '↩',  color: '#ef4444', bg: '#fff1f2', border: '#fecaca', shadow: 'rgba(239,68,68,0.25)' },
                { type: 'auto',    label: t.upload.typeAuto,    icon: '🔀', color: '#8b5cf6', bg: '#f5f3ff', border: '#ddd6fe', shadow: 'rgba(139,92,246,0.25)' },
              ] as const).map(opt => (
                <button
                  key={opt.type}
                  onClick={() => { setFileType(opt.type); setTimeout(() => fileRef.current?.click(), 0); }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                    padding: '18px 28px', borderRadius: 14, cursor: 'pointer', fontWeight: 700,
                    fontSize: 15, transition: 'all 0.18s',
                    background: opt.bg,
                    color: opt.color,
                    border: `2px solid ${opt.border}`,
                    boxShadow: `0 4px 14px ${opt.shadow}`,
                    minWidth: 130,
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px)';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 8px 20px ${opt.shadow}`;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.transform = '';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 14px ${opt.shadow}`;
                  }}
                >
                  <span style={{ fontSize: 32 }}>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 18, color: '#9ca3af', fontSize: 12 }}>
              {t.upload.dragHint}
            </div>
          </>
        )}
      </div>

      {progress > 0 && (
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && (
        <div className="alert alert--error" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
          <div><span>⚠️</span> {error}</div>
          {errorDetail && (
            <div style={{ fontSize: '12px', background: '#fff0f0', borderRadius: '6px', padding: '8px', width: '100%', direction: 'ltr', fontFamily: 'monospace' }}>
              {errorDetail}
              <div style={{ marginTop: '6px', direction: 'rtl', fontFamily: 'inherit', color: '#7f1d1d' }}>
                {t.upload.columnHint}
              </div>
            </div>
          )}
        </div>
      )}

      {uploadResult && (uploadResult.salesCount !== undefined || uploadResult.returnsCount !== undefined) && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
          <span style={{ fontSize: 20 }}>✅</span>
          <div>
            <strong>{t.upload.uploadSuccessTitle}</strong>
            {uploadResult.salesCount !== undefined && uploadResult.returnsCount !== undefined && (
              <div style={{ marginTop: 4, color: '#374151' }}>
                {uploadResult.salesCount > 0 && <span style={{ marginLeft: 12 }}>📦 {t.upload.salesRows}: <strong style={{ color: '#2563eb' }}>{uploadResult.salesCount.toLocaleString('ar-IQ')}</strong> {t.upload.rowUnit}</span>}
                {uploadResult.returnsCount > 0 && <span>↩ {t.upload.returnsRows}: <strong style={{ color: '#dc2626' }}>{uploadResult.returnsCount.toLocaleString('ar-IQ')}</strong> {t.upload.rowUnit}</span>}
                {uploadResult.returnsCount === 0 && uploadResult.salesCount === 0 && <span style={{ color: '#9ca3af' }}>{t.upload.noDataInFile}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Normalization warning panel */}
      {uploadResult && uploadResult.normalizations && uploadResult.normalizations.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: 0, fontSize: 14 }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setShowNorm(v => !v)}
          >
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <strong style={{ color: '#92400e' }}>
                {t.upload.normCount} {uploadResult.normalizations.length} {t.upload.normSuffix}
              </strong>
              <span style={{ color: '#b45309', fontSize: 12, marginRight: 8 }}>
                {t.upload.normClickDetails} {showNorm ? '▲' : '▼'})
              </span>
            </div>
          </div>
          {showNorm && (
            <div style={{ borderTop: '1px solid #fcd34d', padding: '10px 18px', overflowY: 'auto', maxHeight: 240 }}>
              <p style={{ margin: '0 0 8px', color: '#78350f', fontSize: 13 }}>
                {t.upload.normDesc}
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fef3c7' }}>
                    <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #fcd34d' }}>{t.upload.normColType}</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #fcd34d' }}>{t.upload.normColFrom}</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #fcd34d' }}>{t.upload.normColTo}</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #fcd34d' }}>{t.upload.normColSource}</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadResult.normalizations.map((n, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #fef3c7' }}>
                      <td style={{ padding: '4px 8px', color: '#92400e' }}>
                        {n.entityType === 'item' ? t.upload.entityItem : n.entityType === 'rep' ? t.upload.entityRep : t.upload.entityCompany}
                      </td>
                      <td style={{ padding: '4px 8px', color: '#dc2626', textDecoration: 'line-through' }}>{n.from}</td>
                      <td style={{ padding: '4px 8px', color: '#15803d', fontWeight: 700 }}>{n.to}</td>
                      <td style={{ padding: '4px 8px', color: '#6b7280', fontSize: 12 }}>
                        {n.source === 'db' ? t.upload.sourceDb : t.upload.sourceFile}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Unknown items warning — items from file not in company catalog */}
      {uploadResult && uploadResult.unknownItems && uploadResult.unknownItems.length > 0 && (
        <div style={{ background: '#fff7ed', border: '1px solid #fb923c', borderRadius: 10, padding: '12px 18px', fontSize: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 22 }}>🆕</span>
            <div>
              <strong style={{ color: '#9a3412', fontSize: 15 }}>
                {uploadResult.unknownItems.length} ايتم غير موجود في كتالوج الشركة
              </strong>
              <div style={{ color: '#c2410c', fontSize: 12, marginTop: 2 }}>
                تم حفظ البيانات مؤقتاً — أضف هذه الأيتمات من صفحة إدارة الشركة إذا أردت اعتمادها رسمياً
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {uploadResult.unknownItems.map((name, i) => (
              <span key={i} style={{ background: '#fed7aa', color: '#9a3412', borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 600 }}>
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Dedup scan result */}
      {dedupResult && showDedupDetail && dedupResult.count > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 10, padding: '10px 18px', fontSize: 14 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#1e3a5f' }}>
            {t.upload.dedupScanHeader} ({dedupResult.count})
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#dbeafe' }}>
                <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #93c5fd' }}>{t.upload.normColType}</th>
                <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #93c5fd' }}>{t.upload.dedupColDuplicate}</th>
                <th style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #93c5fd' }}>{t.upload.dedupColMerge}</th>
              </tr>
            </thead>
            <tbody>
              {dedupResult.normalizations.map((n: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #dbeafe' }}>
                  <td style={{ padding: '4px 8px', color: '#1e40af' }}>
                    {n.entityType === 'item' ? t.upload.entityItem : n.entityType === 'rep' ? t.upload.entityRep : t.upload.entityCompany}
                  </td>
                  <td style={{ padding: '4px 8px', color: '#dc2626' }}>{n.from}</td>
                  <td style={{ padding: '4px 8px', color: '#15803d', fontWeight: 700 }}>{n.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => dedupNames(true)}
            disabled={deduping}
            style={{ marginTop: 10, padding: '6px 18px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
          >
            {t.upload.dedupApplyBtn}
          </button>
        </div>
      )}

      {/* Files List */}
      <div style={{ marginTop: '1.5rem' }}>
        <h2 className="section-title" style={{ marginBottom: '0.75rem' }}>{t.upload.filesTitle}</h2>
        {filesLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>{t.upload.filesLoading}</div>
        ) : files.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', background: '#f9fafb', borderRadius: 12 }}>
            {t.upload.noFiles}
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.upload.colStatus}</th>
                  <th>{t.upload.colType}</th>
                  <th>{t.upload.colCurrency}</th>
                  <th>{t.upload.colName}</th>
                  <th>{t.upload.colRows}</th>
                  <th>{t.upload.colDate}</th>
                  <th>{t.upload.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => {
                  const isActive = activeFileIds.includes(f.id);
                  return (
                    <tr key={f.id} style={{ background: isActive ? '#f0fdf4' : undefined }}>
                      <td>
                        {isActive
                          ? <span style={{ color: '#16a34a', fontWeight: 700 }}>{t.upload.statusActive}</span>
                          : <span style={{ color: '#9ca3af' }}>—</span>}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                          background: f.fileType === 'returns' ? '#fee2e2' : f.fileType === 'auto' ? '#ede9fe' : '#dbeafe',
                          color:      f.fileType === 'returns' ? '#dc2626'  : f.fileType === 'auto' ? '#6d28d9'  : '#1d4ed8',
                        }}>
                          {f.fileType === 'returns' ? t.upload.typeReturnsLabel : f.fileType === 'auto' ? t.upload.typeAutoLabel : t.upload.typeSalesLabel}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                          background: f.detectedCurrency === 'USD' ? '#fef3c7' : '#dbeafe',
                          color: f.detectedCurrency === 'USD' ? '#92400e' : '#1d4ed8',
                          border: `1px solid ${f.detectedCurrency === 'USD' ? '#fcd34d' : '#93c5fd'}`,
                        }}>
                          {f.detectedCurrency === 'USD' ? '🇺🇸 USD' : '🇮🇶 IQD'}
                        </span>
                      </td>
                      <td><strong>{f.originalName}</strong></td>
                      <td>{f.rowCount.toLocaleString('ar-IQ')}</td>
                      <td>{fmtDate(f.uploadedAt)}</td>
                      <td style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          className="btn btn--primary"
                          style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                          onClick={() => handleAnalyze(f)}
                          disabled={analyzing && analyzeFile?.id === f.id}
                        >
                          {analyzing && analyzeFile?.id === f.id ? '⏳' : t.upload.btnAnalyze}
                        </button>
                        {hasFeature('currency_convert') && (
                          <button
                            title={t.upload.currencyModalTitle}
                            style={{
                              padding: '4px 10px', fontSize: '0.8rem',
                              background: f.currencyMode === 'USD' ? '#fef9c3' : '#f3f4f6',
                              color: f.currencyMode === 'USD' ? '#92400e' : '#374151',
                              border: `1px solid ${f.currencyMode === 'USD' ? '#fcd34d' : '#d1d5db'}`,
                              borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: f.currencyMode === 'USD' ? 700 : undefined,
                            }}
                            onClick={() => openCurrencyModal(f)}
                          >
                            {t.upload.btnCurrency}{f.currencyMode === 'USD' && <span style={{ marginRight: 4 }}>$</span>}
                          </button>
                        )}
                        <button
                          className="btn btn--secondary"
                          style={{
                            padding: '4px 14px', fontSize: '0.8rem',
                            background: isActive ? '#dcfce7' : undefined,
                            color: isActive ? '#15803d' : undefined,
                            border: isActive ? '1px solid #86efac' : undefined,
                            fontWeight: isActive ? 700 : undefined,
                          }}
                          onClick={() => onFileActivated(f.id)}
                        >
                          {isActive ? t.upload.btnDeactivate : t.upload.btnActivate}
                        </button>
                        {confirmId === f.id ? (
                          <>
                            <span style={{ fontSize: '0.78rem', color: '#dc2626', fontWeight: 600 }}>{t.upload.confirmDelete}</span>
                            <button
                              className="btn btn--danger"
                              style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                              onClick={() => deleteFile(f.id)}
                              disabled={deleting === f.id}
                            >
                              {deleting === f.id ? '⏳' : t.upload.confirmDeleteBtn}
                            </button>
                            <button
                              style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
                              onClick={() => setConfirmId(null)}
                            >
                              {t.upload.cancel}
                            </button>
                          </>
                        ) : (
                          <button
                            style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer' }}
                            onClick={() => setConfirmId(f.id)}
                            disabled={deleting === f.id}
                          >
                            {t.upload.deleteBtn}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Analysis Output */}
      {analyzeFile && (
        <div className="analysis-output" style={{ marginTop: '1.5rem' }}>
          <h3 className="analysis-output-title">
            {t.upload.analysisTitle}: <em style={{ fontWeight: 400 }}>{analyzeFile.originalName}</em>
          </h3>
          {analyzing ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
              {t.upload.analyzingText}
            </div>
          ) : (
            <AnalysisRenderer text={analysisText} />
          )}
        </div>
      )}

      {/* Currency Modal */}
      {currencyModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCurrencyModal(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 16, padding: '2rem', minWidth: 340, maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', direction: 'rtl' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }}>{t.upload.currencyModalTitle}</h3>
            <p style={{ margin: '0 0 1.25rem', fontSize: '0.85rem', color: '#6b7280' }}>{currencyModal.originalName}</p>

            {/* Source currency — what the file data is in */}
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem', color: '#374151' }}>
              {t.upload.currencySourceLabel}
            </label>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {(['IQD', 'USD'] as const).map(mode => (
                <label
                  key={mode}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem',
                    border: `2px solid ${currModalSource === mode ? (mode === 'USD' ? '#f59e0b' : '#3b82f6') : '#e5e7eb'}`,
                    borderRadius: 10, padding: '0.6rem 0.9rem', cursor: 'pointer',
                    background: currModalSource === mode ? (mode === 'USD' ? '#fef9c3' : '#eff6ff') : '#f9fafb',
                    fontWeight: currModalSource === mode ? 700 : 400, fontSize: '0.9rem',
                  }}
                >
                  <input
                    type="radio"
                    name="currSource"
                    value={mode}
                    checked={currModalSource === mode}
                    onChange={() => setCurrModalSource(mode)}
                    style={{ accentColor: mode === 'USD' ? '#f59e0b' : '#3b82f6' }}
                  />
                  {mode === 'IQD' ? t.upload.currencyIQD : t.upload.currencyUSD}
                </label>
              ))}
            </div>

            {/* Target display currency — what to convert to */}
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem', color: '#374151' }}>
              {t.upload.currencyTargetLabel}
            </label>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {(['IQD', 'USD'] as const).map(mode => (
                <label
                  key={mode}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem',
                    border: `2px solid ${currModalMode === mode ? (mode === 'USD' ? '#f59e0b' : '#3b82f6') : '#e5e7eb'}`,
                    borderRadius: 10, padding: '0.6rem 0.9rem', cursor: 'pointer',
                    background: currModalMode === mode ? (mode === 'USD' ? '#fef9c3' : '#eff6ff') : '#f9fafb',
                    fontWeight: currModalMode === mode ? 700 : 400, fontSize: '0.9rem',
                  }}
                >
                  <input
                    type="radio"
                    name="currMode"
                    value={mode}
                    checked={currModalMode === mode}
                    onChange={() => setCurrModalMode(mode)}
                    style={{ accentColor: mode === 'USD' ? '#f59e0b' : '#3b82f6' }}
                  />
                  {mode === 'IQD' ? t.upload.currencyIQD : t.upload.currencyUSD}
                </label>
              ))}
            </div>

            {/* Exchange rate — shown only when source ≠ target */}
            {currModalSource !== currModalMode && (
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', color: '#374151' }}>
                  {t.upload.currencyRate}
                </label>
                <input
                  type="number"
                  min={1}
                  value={currModalRate}
                  onChange={e => setCurrModalRate(e.target.value)}
                  placeholder={t.upload.currencyRatePlaceholder}
                  style={{
                    width: '100%', padding: '0.55rem 0.75rem', border: '1px solid #d1d5db',
                    borderRadius: 8, fontSize: '1rem', outline: 'none', boxSizing: 'border-box',
                    direction: 'ltr', textAlign: 'left',
                  }}
                />
                <p style={{ fontSize: '0.78rem', color: '#6b7280', margin: '0.3rem 0 0' }}>
                  1 USD = {currModalRate || '?'} IQD
                </p>
              </div>
            )}

            {/* Save message */}
            {currSaveMsg && (
              <p style={{ color: currSaveMsg === t.upload.currencySaved ? '#16a34a' : '#dc2626', fontSize: '0.85rem', marginBottom: '0.75rem', fontWeight: 600 }}>
                {currSaveMsg}
              </p>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                style={{ padding: '7px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: '0.9rem' }}
                onClick={() => setCurrencyModal(null)}
              >
                {t.upload.cancel}
              </button>
              <button
                style={{ padding: '7px 20px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem', opacity: savingCurrency ? 0.7 : 1 }}
                onClick={saveCurrencySettings}
                disabled={savingCurrency}
              >
                {savingCurrency ? t.upload.currencySaving : t.upload.currencySave}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-upload currency picker modal */}
      {pendingFile && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPendingFile(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 18, padding: '2rem', minWidth: 340, maxWidth: 420, boxShadow: '0 10px 40px rgba(0,0,0,0.22)', direction: 'rtl' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 0.3rem', fontSize: '1.15rem', fontWeight: 700 }}>
              {t.upload.preCurrencyTitle}
            </h3>
            <p style={{ margin: '0 0 1.4rem', fontSize: '0.84rem', color: '#6b7280' }}>
              {pendingFile.name}
            </p>

            <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.75rem', color: '#374151' }}>
              {t.upload.preCurrencyLabel}
            </label>

            <div style={{ display: 'flex', gap: '0.85rem', marginBottom: '1.75rem' }}>
              {(['IQD', 'USD'] as const).map(c => (
                <label
                  key={c}
                  style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem',
                    border: `2px solid ${preCurrency === c ? (c === 'USD' ? '#f59e0b' : '#3b82f6') : '#e5e7eb'}`,
                    borderRadius: 12, padding: '0.9rem 0.5rem', cursor: 'pointer',
                    background: preCurrency === c ? (c === 'USD' ? '#fef9c3' : '#eff6ff') : '#f9fafb',
                    fontWeight: preCurrency === c ? 700 : 400,
                  }}
                >
                  <input
                    type="radio"
                    name="preCurr"
                    value={c}
                    checked={preCurrency === c}
                    onChange={() => setPreCurrency(c)}
                    style={{ accentColor: c === 'USD' ? '#f59e0b' : '#3b82f6' }}
                  />
                  <span style={{ fontSize: '1.6rem' }}>{c === 'IQD' ? '🇮🇶' : '🇺🇸'}</span>
                  <span style={{ fontSize: '0.9rem' }}>{c === 'IQD' ? t.upload.currencyIQD : t.upload.currencyUSD}</span>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                style={{ padding: '8px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: '0.9rem' }}
                onClick={() => setPendingFile(null)}
              >
                {t.upload.cancel}
              </button>
              <button
                style={{ padding: '8px 22px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}
                onClick={() => { const f = pendingFile; setPendingFile(null); uploadFile(f, preCurrency); }}
              >
                {t.upload.preCurrencyConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
