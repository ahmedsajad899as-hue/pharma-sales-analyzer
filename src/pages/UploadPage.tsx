import { useState, useRef, useCallback, useEffect } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
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
  userId?: number | null;
  sharedWithRepId?: number | null;
  sharedWithRep?: { id: number; name: string } | null;
  sharedWithUserId?: number | null;
  sharedWithUser?: { id: number; displayName?: string; username: string } | null;
  _count?: { sales: number };
}

interface Props {
  activeFileIds: number[];
  onFileActivated: (id: number | null) => void;
}

const API = '';

export default function UploadPage({ activeFileIds, onFileActivated }: Props) {
  const { token, hasFeature, user } = useAuth();
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

  // Use a ref so loadFiles doesn't re-run when activeFileIds changes (avoids re-fetch on toggle)
  const activeFileIdsRef = useRef<number[]>(activeFileIds);
  activeFileIdsRef.current = activeFileIds;
  const onFileActivatedRef = useRef(onFileActivated);
  onFileActivatedRef.current = onFileActivated;

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res  = await fetch(`${API}/api/files`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      const fetched: UploadedFile[] = Array.isArray(json.data) ? json.data : [];
      setFiles(fetched);
      // No auto-activation — the user must activate a file manually
    } catch { /* ignore */ }
    finally { setFilesLoading(false); }
  }, [token]); // removed activeFileIds & onFileActivated — refs keep them up-to-date without re-triggering

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
  const [currModalRate, setCurrModalRate] = useState<string>('1470');
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [currSaveMsg, setCurrSaveMsg] = useState('');

  // File-rep sharing state (old: ScientificRep)
  const [shareModalFile, setShareModalFile] = useState<UploadedFile | null>(null);
  const [sciReps, setSciReps] = useState<{ id: number; name: string }[]>([]);
  const [sciRepsLoading, setSciRepsLoading] = useState(false);
  const [selectedRepId, setSelectedRepId] = useState<number | null>(null);
  // File-user sharing state (new: User account with area assignments)
  const [linkedUsers, setLinkedUsers] = useState<{ id: number; name: string; role: string; areaCount: number; areas: string[] }[]>([]);
  const [linkedUsersLoading, setLinkedUsersLoading] = useState(false);
  const [selectedLinkedUserId, setSelectedLinkedUserId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [shareMsg, setShareMsg] = useState('');

  const openShareModal = async (f: UploadedFile) => {
    setShareModalFile(f);
    setSelectedLinkedUserId(f.sharedWithUserId ?? null);
    setShareMsg('');
    // Load linked users (subordinates of this manager)
    setLinkedUsersLoading(true);
    try {
      const res  = await fetch(`${API}/api/files/linked-users`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      setLinkedUsers(Array.isArray(json.data) ? json.data : []);
    } catch { /* ignore */ }
    finally { setLinkedUsersLoading(false); }
  };

  const confirmShare = async () => {
    if (!shareModalFile) return;
    // Guard: if file already has a linked user and user is trying to unlink, require explicit confirmation
    if (selectedLinkedUserId === null && shareModalFile.sharedWithUserId !== null) {
      const currentName = shareModalFile.sharedWithUser?.displayName || shareModalFile.sharedWithUser?.username || 'المندوب';
      if (!window.confirm(`هل تريد فعلاً إلغاء ربط الملف بـ "${currentName}"؟`)) return;
    }
    setSaving(true);
    setShareMsg('');
    try {
      const res  = await fetch(`${API}/api/files/${shareModalFile.id}/share-with-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ userId: selectedLinkedUserId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل التعيين');
      setShareMsg(selectedLinkedUserId ? '✓ تمت المزامنة بنجاح' : '✓ تم إلغاء المزامنة');
      await loadFiles();
      setTimeout(() => { setShareModalFile(null); setShareMsg(''); }, 1200);
    } catch (err: any) {
      setShareMsg(`⚠ ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Download filtered Excel for a user (by area assignments)
  const [exporting, setExporting] = useState<string | null>(null); // key = `${fileId}-${userId}`

  const downloadUserSalesExcel = async (fileId: number, userId?: number) => {
    const key = `${fileId}-${userId ?? 'me'}`;
    setExporting(key);
    try {
      const url = `${API}/api/files/${fileId}/export-user-sales${userId ? `?userId=${userId}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'فشل التحميل');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      let filename = 'مبيعاتي.xlsx';
      const match = disposition.match(/filename\*?=UTF-8''([^;]+)/i) ?? disposition.match(/filename="?([^";]+)"?/i);
      if (match) filename = decodeURIComponent(match[1]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setExporting(null);
    }
  };

  // Back button: close open overlays in priority order
  useBackHandler([
    [shareModalFile !== null, () => setShareModalFile(null)],
    [currencyModal !== null, () => setCurrencyModal(null)],
    [analyzeFile !== null,   () => setAnalyzeFile(null)],
    [confirmId !== null,     () => setConfirmId(null)],
    [showNorm,               () => setShowNorm(false)],
  ]);

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
    setCurrModalRate(String(f.exchangeRate ?? 1470));
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

  // ── Style tokens (PharmacyNet-style) ─────────────────────────
  const CARD: React.CSSProperties = {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
    padding: '12px 16px', marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,.04)',
  };
  const BTN_PRI: React.CSSProperties = {
    padding: '5px 14px', border: 'none', borderRadius: 6, background: '#1e40af',
    color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
  };
  const BTN_SEC: React.CSSProperties = {
    padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#f8fafc',
    color: '#374151', fontSize: 12, cursor: 'pointer',
  };
  const BTN_GHOST: React.CSSProperties = {
    padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff',
    color: '#64748b', fontSize: 12, cursor: 'pointer',
  };
  const BADGE = (bg: string, color: string, border = bg): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
    background: bg, color, border: `1px solid ${border}`, whiteSpace: 'nowrap',
  });

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px', direction: 'rtl', fontFamily: 'inherit' }}>

      {/* ── Page header ─────────────────────────────────────── */}
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', margin: 0 }}>{t.upload.title}</h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: '2px 0 0' }}>{t.upload.subtitle}</p>
      </div>

      {/* ── Active files bar ────────────────────────────────── */}
      {activeFiles.length > 0 ? (
        <div style={{ ...CARD, background: '#f0fdf4', borderColor: '#bbf7d0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 14px' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#15803d', whiteSpace: 'nowrap' }}>✅ نشط:</span>
          {activeFiles.map(f => (
            <span key={f.id} style={BADGE('#dcfce7', '#15803d', '#86efac')}>
              {f.fileType === 'returns' ? '↩' : f.fileType === 'auto' ? '🔀' : '📦'} {f.originalName}
            </span>
          ))}
          <span style={{ fontSize: 11, color: '#166534', marginRight: 'auto' }}>{t.upload.allReportsNote}</span>
        </div>
      ) : (
        <div style={{ ...CARD, background: '#fff7ed', borderColor: '#fed7aa', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
          <span>⚠️</span>
          <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>{t.upload.noActiveFile}</span>
          <span style={{ fontSize: 11, color: '#b45309' }}>— {t.upload.noActiveFileDesc}</span>
        </div>
      )}

      {/* ── Upload drop zone ────────────────────────────────── */}
      <div
        style={{
          ...CARD,
          borderStyle: dragging ? 'dashed' : 'dashed',
          borderColor: dragging ? '#93c5fd' : '#cbd5e1',
          background: dragging ? '#eff6ff' : uploading ? '#f8fafc' : '#fafbfc',
          padding: '20px 16px',
          textAlign: 'center',
          cursor: 'default',
          transition: 'all 0.15s',
        }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) requestUpload(f); e.target.value = ''; }}
        />
        {uploading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>⏳ {t.upload.uploading}</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, fontWeight: 600 }}>{t.upload.chooseFileType}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              {([
                { type: 'auto',    label: t.upload.typeAuto,    icon: '🔀', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
                { type: 'returns', label: t.upload.typeReturns, icon: '↩',  color: '#dc2626', bg: '#fff1f2', border: '#fecaca' },
                { type: 'sales',   label: t.upload.typeSales,   icon: '📦', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
              ] as const).map(opt => (
                <button key={opt.type} onClick={() => { setFileType(opt.type); setTimeout(() => fileRef.current?.click(), 0); }}
                  style={{
                    padding: '12px 22px', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                    fontSize: 13, border: `1.5px solid ${opt.border}`,
                    background: opt.bg, color: opt.color,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    minWidth: 110, transition: 'opacity 0.1s',
                  }}
                >
                  <span style={{ fontSize: 24 }}>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 10, color: '#94a3b8', fontSize: 11 }}>{t.upload.dragHint}</div>
          </>
        )}
      </div>

      {progress > 0 && (
        <div style={{ height: 3, background: '#e2e8f0', borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: '#1e40af', width: `${progress}%`, transition: 'width 0.2s', borderRadius: 2 }} />
        </div>
      )}

      {error && (
        <div style={{ ...CARD, background: '#fef2f2', borderColor: '#fca5a5', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>⚠️ {error}</div>
          {errorDetail && <div style={{ fontSize: 11, color: '#b91c1c', fontFamily: 'monospace', background: '#fff', borderRadius: 4, padding: '4px 8px' }}>{errorDetail}</div>}
        </div>
      )}

      {/* Upload success */}
      {uploadResult && (uploadResult.salesCount !== undefined || uploadResult.returnsCount !== undefined) && (
        <div style={{ ...CARD, background: '#f0fdf4', borderColor: '#86efac', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <span>✅</span>
          <strong style={{ color: '#15803d' }}>{t.upload.uploadSuccessTitle}</strong>
          {uploadResult.salesCount !== undefined && uploadResult.salesCount > 0 && <span style={{ color: '#2563eb' }}>📦 {uploadResult.salesCount.toLocaleString('ar-IQ')} {t.upload.rowUnit}</span>}
          {uploadResult.returnsCount !== undefined && uploadResult.returnsCount > 0 && <span style={{ color: '#dc2626' }}>↩ {uploadResult.returnsCount.toLocaleString('ar-IQ')} {t.upload.rowUnit}</span>}
        </div>
      )}

      {/* Normalization panel */}
      {uploadResult?.normalizations && uploadResult.normalizations.length > 0 && (
        <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fcd34d', padding: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer' }} onClick={() => setShowNorm(v => !v)}>
            <span style={{ fontSize: 14 }}>⚠️</span>
            <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>{t.upload.normCount} {uploadResult.normalizations.length} {t.upload.normSuffix}</span>
            <span style={{ fontSize: 11, color: '#b45309', marginRight: 'auto' }}>{showNorm ? '▲' : '▼'}</span>
          </div>
          {showNorm && (
            <div style={{ borderTop: '1px solid #fcd34d', padding: '8px 14px', overflowY: 'auto', maxHeight: 200 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#fef3c7' }}>
                    {[t.upload.normColType, t.upload.normColFrom, t.upload.normColTo, t.upload.normColSource].map(h => (
                      <th key={h} style={{ padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #fcd34d', color: '#78350f' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {uploadResult.normalizations.map((n, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #fef3c7' }}>
                      <td style={{ padding: '3px 8px', color: '#92400e' }}>{n.entityType === 'item' ? t.upload.entityItem : n.entityType === 'rep' ? t.upload.entityRep : t.upload.entityCompany}</td>
                      <td style={{ padding: '3px 8px', color: '#dc2626', textDecoration: 'line-through' }}>{n.from}</td>
                      <td style={{ padding: '3px 8px', color: '#15803d', fontWeight: 700 }}>{n.to}</td>
                      <td style={{ padding: '3px 8px', color: '#6b7280' }}>{n.source === 'db' ? t.upload.sourceDb : t.upload.sourceFile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Unknown items */}
      {uploadResult?.unknownItems && uploadResult.unknownItems.length > 0 && (
        <div style={{ ...CARD, background: '#fff7ed', borderColor: '#fb923c', padding: '8px 14px' }}>
          <div style={{ fontSize: 12, color: '#9a3412', fontWeight: 700, marginBottom: 6 }}>🆕 {uploadResult.unknownItems.length} ايتم غير موجود في الكتالوج</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {uploadResult.unknownItems.map((name, i) => (
              <span key={i} style={BADGE('#fed7aa', '#9a3412', '#fdba74')}>{name}</span>
            ))}
          </div>
        </div>
      )}

      {/* Dedup result */}
      {dedupResult && showDedupDetail && dedupResult.count > 0 && (
        <div style={{ ...CARD, background: '#eff6ff', borderColor: '#93c5fd', padding: '8px 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1e3a5f', marginBottom: 6 }}>{t.upload.dedupScanHeader} ({dedupResult.count})</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#dbeafe' }}>
                {[t.upload.normColType, t.upload.dedupColDuplicate, t.upload.dedupColMerge].map(h => (
                  <th key={h} style={{ padding: '3px 8px', textAlign: 'right', borderBottom: '1px solid #93c5fd', color: '#1e40af' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dedupResult.normalizations.map((n: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #dbeafe' }}>
                  <td style={{ padding: '3px 8px', color: '#1e40af' }}>{n.entityType === 'item' ? t.upload.entityItem : n.entityType === 'rep' ? t.upload.entityRep : t.upload.entityCompany}</td>
                  <td style={{ padding: '3px 8px', color: '#dc2626' }}>{n.from}</td>
                  <td style={{ padding: '3px 8px', color: '#15803d', fontWeight: 700 }}>{n.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => dedupNames(true)} disabled={deduping} style={{ ...BTN_PRI, marginTop: 8 }}>
            {t.upload.dedupApplyBtn}
          </button>
        </div>
      )}

      {cleanResult && (
        <div style={{ ...CARD, background: '#f0fdf4', borderColor: '#86efac', padding: '7px 14px', fontSize: 12, color: '#065f46', fontWeight: 600 }}>
          ✓ {t.upload.cleanSuccessPrefix} {cleanResult.areas} {t.upload.cleanSuccessArea} {t.upload.cleanSuccessAnd} {cleanResult.items} {t.upload.cleanSuccessItem}
        </div>
      )}

      {dedupResult && !showDedupDetail && (
        <div style={{ ...CARD, background: '#eff6ff', borderColor: '#93c5fd', padding: '7px 14px', fontSize: 12, color: '#1e3a5f', fontWeight: 600, cursor: dedupResult.count > 0 ? 'pointer' : 'default' }}
          onClick={() => dedupResult.count > 0 && setShowDedupDetail(v => !v)}>
          {dedupResult.count === 0 ? t.upload.dedupNoSimilar : `🔀 ${t.upload.dedupUnified} ${dedupResult.count} ${t.upload.dedupNamesUnit} — اضغط للتفاصيل ▼`}
        </div>
      )}

      {/* ── Files List ──────────────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
          📁 {t.upload.filesTitle}
        </div>

        {filesLoading ? (
          <div style={{ textAlign: 'center', padding: '28px', color: '#94a3b8', fontSize: 13 }}>⏳ {t.upload.filesLoading}</div>
        ) : files.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px', color: '#94a3b8', background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>{t.upload.noFiles}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map(f => {
              const isActive = activeFileIds.includes(f.id);
              const isSharedToMe = f.sharedWithUserId === user?.id && f.userId !== user?.id;
              const isSharedByMe = f.userId === user?.id && !!f.sharedWithUserId;

              const typeMeta =
                f.fileType === 'returns' ? { label: t.upload.typeReturnsLabel, color: '#dc2626', bg: '#fee2e2', border: '#fca5a5' } :
                f.fileType === 'auto'    ? { label: t.upload.typeAutoLabel,    color: '#6d28d9', bg: '#ede9fe', border: '#c4b5fd' } :
                f.fileType === 'matrix' ? { label: t.upload.typeMatrixLabel,   color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc' } :
                                          { label: t.upload.typeSalesLabel,    color: '#1d4ed8', bg: '#dbeafe', border: '#93c5fd' };

              const currIsDollar = (f.currencyMode ?? f.detectedCurrency) === 'USD';

              return (
                <div key={f.id} style={{
                  ...CARD,
                  marginBottom: 0,
                  borderColor: isActive ? '#86efac' : isSharedToMe ? '#fde68a' : '#e2e8f0',
                  background: isActive ? '#f0fdf4' : isSharedToMe ? '#fffbeb' : '#fff',
                }}>
                  {/* ── Row 1: name + badges ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.originalName}
                    </span>
                    <span style={BADGE(typeMeta.bg, typeMeta.color, typeMeta.border)}>{typeMeta.label}</span>
                    {isActive && <span style={BADGE('#dcfce7', '#15803d', '#86efac')}>✓ {t.upload.statusActive}</span>}
                    {isSharedByMe && <span style={BADGE('#ede9fe', '#6d28d9', '#c4b5fd')}>🔗 {f.sharedWithUser?.displayName || f.sharedWithUser?.username}</span>}
                    {isSharedToMe && <span style={BADGE('#fef3c7', '#92400e', '#fcd34d')}>📥 مشارك معك</span>}
                  </div>

                  {/* ── Row 2: meta ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 11, color: '#64748b' }}>
                    <span>📊 {f.rowCount.toLocaleString('ar-IQ')} {t.upload.rowUnit}</span>
                    <span>📅 {fmtDate(f.uploadedAt)}</span>
                    <span style={BADGE(currIsDollar ? '#fef9c3' : '#dcfce7', currIsDollar ? '#92400e' : '#15803d', currIsDollar ? '#fcd34d' : '#86efac')}>
                      {currIsDollar ? 'USD $' : 'IQD ﷼'}
                    </span>
                  </div>

                  {/* ── Row 3: actions ── */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button style={{ ...BTN_PRI }} onClick={() => handleAnalyze(f)} disabled={analyzing && analyzeFile?.id === f.id}>
                      {analyzing && analyzeFile?.id === f.id ? '⏳' : t.upload.btnAnalyze}
                    </button>

                    {hasFeature('currency_convert') && (
                      <button style={{ ...BTN_SEC, background: f.currencyMode === 'USD' ? '#fef9c3' : undefined, color: f.currencyMode === 'USD' ? '#92400e' : undefined, borderColor: f.currencyMode === 'USD' ? '#fcd34d' : undefined }} onClick={() => openCurrencyModal(f)}>
                        {t.upload.btnCurrency}
                      </button>
                    )}

                    {/* Sync button — manager only */}
                    {f.userId === user?.id && ['admin','manager','company_manager','team_leader','supervisor','product_manager','office_manager'].includes(user?.role ?? '') && (
                      <button style={{ ...BTN_SEC, background: isSharedByMe ? '#f5f3ff' : undefined, color: isSharedByMe ? '#6d28d9' : undefined, borderColor: isSharedByMe ? '#c4b5fd' : undefined }}
                        onClick={() => openShareModal(f)}>
                        {isSharedByMe ? `🔗 ${f.sharedWithUser?.displayName || f.sharedWithUser?.username}` : '🔗 مزامنة مع مندوب'}
                      </button>
                    )}

                    {/* Download — recipient */}
                    {isSharedToMe && (
                      <button style={{ ...BTN_SEC, background: '#ecfdf5', color: '#059669', borderColor: '#6ee7b7' }}
                        onClick={() => downloadUserSalesExcel(f.id)} disabled={exporting === `${f.id}-me`}>
                        {exporting === `${f.id}-me` ? '⏳' : '📥 تحميل مبيعاتي'}
                      </button>
                    )}

                    {/* Download — manager preview */}
                    {f.userId === user?.id && f.sharedWithUserId && (
                      <button style={{ ...BTN_SEC, background: '#f0fdf4', color: '#15803d', borderColor: '#86efac' }}
                        onClick={() => downloadUserSalesExcel(f.id, f.sharedWithUserId!)} disabled={exporting === `${f.id}-${f.sharedWithUserId}`}>
                        {exporting === `${f.id}-${f.sharedWithUserId}` ? '⏳' : `📥 بيانات ${f.sharedWithUser?.displayName || f.sharedWithUser?.username || 'المندوب'}`}
                      </button>
                    )}

                    {/* Activate toggle */}
                    <button style={{ ...BTN_GHOST, background: isActive ? '#dcfce7' : undefined, color: isActive ? '#15803d' : undefined, borderColor: isActive ? '#86efac' : undefined }}
                      onClick={() => onFileActivated(f.id)}>
                      {isActive ? t.upload.btnDeactivate : t.upload.btnActivate}
                    </button>

                    {/* Delete */}
                    {confirmId === f.id ? (
                      <>
                        <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>{t.upload.confirmDelete}</span>
                        <button style={{ ...BTN_PRI, background: '#dc2626' }} onClick={() => deleteFile(f.id)} disabled={deleting === f.id}>
                          {deleting === f.id ? '⏳' : t.upload.confirmDeleteBtn}
                        </button>
                        <button style={{ ...BTN_GHOST }} onClick={() => setConfirmId(null)}>{t.upload.cancel}</button>
                      </>
                    ) : (
                      <button style={{ ...BTN_GHOST, color: '#dc2626', borderColor: '#fca5a5', background: '#fff5f5' }}
                        onClick={() => setConfirmId(f.id)} disabled={deleting === f.id}>
                        {t.upload.deleteBtn}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
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

      {/* ── Share with User (area-based) Modal ── */}
      {shareModalFile && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShareModalFile(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 18, padding: '2rem', minWidth: 340, maxWidth: 480, boxShadow: '0 10px 40px rgba(0,0,0,0.22)', direction: 'rtl', width: '92%' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: 800, color: '#1e1b4b' }}>🔗 مزامنة مع مندوب / قائد فريق</h3>
            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#6b7280' }}>{shareModalFile.originalName}</p>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
              سيتمكن المستخدم المختار من رؤية بياناته المفلترة حسب مناطقه المعيّنة فقط
            </p>

            {linkedUsersLoading ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>⏳ جاري تحميل المستخدمين...</div>
            ) : linkedUsers.length === 0 ? (
              <div style={{ padding: '12px', background: '#fef2f2', borderRadius: 10, color: '#b91c1c', fontSize: 13 }}>
                لا يوجد مندوبون أو قادة فريق مرتبطون بك — يجب تعيينهم من لوحة الماستر أولاً
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto', marginBottom: 16 }}>
                {/* None option */}
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
                  border: `1.5px solid ${selectedLinkedUserId === null ? '#e11d48' : '#e2e8f0'}`,
                  background: selectedLinkedUserId === null ? '#fff1f2' : '#f9fafb',
                }}>
                  <input type="radio" name="shareUser" checked={selectedLinkedUserId === null} onChange={() => setSelectedLinkedUserId(null)} style={{ accentColor: '#e11d48' }} />
                  <span style={{ fontSize: 13, fontWeight: selectedLinkedUserId === null ? 700 : 400, color: selectedLinkedUserId === null ? '#be123c' : '#374151' }}>
                    🚫 بدون مزامنة (إلغاء التعيين)
                  </span>
                </label>
                {linkedUsers.map(u => {
                  const ROLE_AR: Record<string, string> = { scientific_rep: 'مندوب علمي', team_leader: 'قائد فريق', supervisor: 'مشرف', manager: 'مدير فريق' };
                  const isSelected = selectedLinkedUserId === u.id;
                  return (
                    <label key={u.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                      border: `1.5px solid ${isSelected ? '#7c3aed' : '#e2e8f0'}`,
                      background: isSelected ? '#f5f3ff' : '#f9fafb',
                    }}>
                      <input type="radio" name="shareUser" checked={isSelected} onChange={() => setSelectedLinkedUserId(u.id)} style={{ accentColor: '#7c3aed' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: isSelected ? 700 : 400, color: isSelected ? '#6d28d9' : '#374151' }}>
                          👤 {u.name}
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                          {ROLE_AR[u.role] ?? u.role} · {u.areaCount > 0 ? `${u.areaCount} منطقة` : '⚠ لا توجد مناطق مُعيَّنة'}
                          {u.areaCount > 0 && u.areas.length > 0 && ` · ${u.areas.slice(0, 3).join('، ')}${u.areas.length > 3 ? '...' : ''}`}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {shareMsg && (
              <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 700, color: shareMsg.startsWith('✓') ? '#059669' : '#dc2626' }}>
                {shareMsg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                style={{ padding: '8px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
                onClick={() => setShareModalFile(null)}
              >
                إلغاء
              </button>
              {/* Preview download for selected user */}
              {selectedLinkedUserId && (
                <button
                  onClick={() => downloadUserSalesExcel(shareModalFile.id, selectedLinkedUserId)}
                  disabled={exporting === `${shareModalFile.id}-${selectedLinkedUserId}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: '#ecfdf5', color: '#059669', border: '1px solid #6ee7b7', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
                  title="تحميل البيانات المفلترة للمستخدم المختار (حسب مناطقه) كـ Excel"
                >
                  {exporting === `${shareModalFile.id}-${selectedLinkedUserId}` ? '⏳ جاري...' : '📥 معاينة Excel'}
                </button>
              )}
              <button
                style={{ padding: '8px 22px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14, opacity: saving ? 0.7 : 1 }}
                onClick={confirmShare}
                disabled={saving || linkedUsers.length === 0}
              >
                {saving ? '⏳ جاري...' : '✓ تأكيد المزامنة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}