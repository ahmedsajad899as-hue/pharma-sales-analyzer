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
  // Multi-user sharing via junction table
  fileShares?: Array<{ userId: number; user: { id: number; displayName?: string; username: string } }>;
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
  const [preCurrency, setPreCurrency] = useState<'IQD' | 'USD'>('USD');
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
      // Suggest merging any newly-created near-duplicate items (confirmation modal)
      checkSimilarItemsRef.current();
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
    setPreCurrency('USD');
    setPendingFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) requestUpload(file);
  };

  // Clipboard paste — lets user Ctrl+V a file copied from WhatsApp Desktop
  const requestUploadRef = useRef<(f: File) => void>(requestUpload);
  useEffect(() => { requestUploadRef.current = requestUpload; });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) { requestUploadRef.current(file); break; }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const [deleting, setDeleting] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [menuOpenUp, setMenuOpenUp] = useState(false);
  const [expandedSharesId, setExpandedSharesId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [syncDone, setSyncDone] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{areas: number; items: number} | null>(null);
  const [deduping, setDeduping] = useState(false);
  const [dedupResult, setDedupResult] = useState<{ count: number; normalizations: any[] } | null>(null);
  const [showDedupDetail, setShowDedupDetail] = useState(false);
  // Post-upload "merge similar items" confirmation modal
  type DedupEntry = { from: string; to: string; source: string; entityType: string };
  const [autoDedup, setAutoDedup] = useState<DedupEntry[] | null>(null);
  const [autoDedupApplying, setAutoDedupApplying] = useState(false);

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
  // File-user sharing state (new: multi-user via junction table)
  const [linkedUsers, setLinkedUsers] = useState<{ id: number; name: string; role: string; areaCount: number; areas: string[] }[]>([]);
  const [linkedUsersLoading, setLinkedUsersLoading] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  // Custom area overrides per user in share modal
  const [fileAreas, setFileAreas] = useState<{ id: number; name: string }[]>([]);
  const [customAreaOverrides, setCustomAreaOverrides] = useState<Map<number, Set<number>>>(new Map());
  const [expandedAreaUserId, setExpandedAreaUserId] = useState<number | null>(null);

  const openShareModal = async (f: UploadedFile) => {
    setShareModalFile(f);
    // Pre-select users that are already shared
    const already = new Set((f.fileShares ?? []).map(s => s.userId));
    setSelectedUserIds(already);
    setShareMsg('');
    setLinkedUsersLoading(true);
    try {
      const res  = await fetch(`${API}/api/files/linked-users`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      setLinkedUsers(Array.isArray(json.data) ? json.data : []);
    } catch { /* ignore */ }
    finally { setLinkedUsersLoading(false); }
  };

  const toggleSelectUser = (uid: number) => {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };

  const selectAllUsers = () => {
    setSelectedUserIds(new Set(linkedUsers.map(u => u.id)));
  };

  const confirmShare = async () => {
    if (!shareModalFile) return;
    setSaving(true);
    setShareMsg('');
    try {
      // Build areaOverrides object: { [userId]: areaId[] }
      const areaOverrides: Record<number, number[]> = {};
      customAreaOverrides.forEach((areaIds, userId) => {
        if (areaIds.size > 0) areaOverrides[userId] = [...areaIds];
      });
      const res  = await fetch(`${API}/api/files/${shareModalFile.id}/share-with-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ userIds: [...selectedUserIds], areaOverrides }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل التعيين');
      setShareMsg(selectedUserIds.size > 0 ? `✓ تمت المزامنة مع ${selectedUserIds.size} مستخدم` : '✓ تم إلغاء جميع المزامنات');
      await loadFiles();
      setTimeout(() => { setShareModalFile(null); setShareMsg(''); }, 1400);
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

  // After an upload, look for newly-created items that are near-duplicates of
  // existing ones and pop a confirmation modal so the user can merge them.
  const checkSimilarItems = async () => {
    try {
      const res  = await fetch(`${API}/api/dedup-names`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ apply: false }),
      });
      const json = await res.json();
      if (!res.ok) return;
      const items: DedupEntry[] = (json.normalizations ?? []).filter((e: DedupEntry) => e.entityType === 'item');
      if (items.length > 0) setAutoDedup(items);
    } catch { /* non-fatal — skip the suggestion */ }
  };

  // Apply ONLY the item merges shown in the confirmation modal.
  const applyAutoDedup = async () => {
    setAutoDedupApplying(true);
    try {
      const res = await fetch(`${API}/api/dedup-names`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ apply: true, entityTypes: ['item'] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t.upload.dedupFailed);
      setAutoDedup(null);
      await loadFiles();
    } catch (err: any) {
      setError(err.message || t.upload.dedupError);
    } finally {
      setAutoDedupApplying(false);
    }
  };

  // Stable ref so the memoised uploadFile callback always calls the latest checker.
  const checkSimilarItemsRef = useRef(checkSimilarItems);
  useEffect(() => { checkSimilarItemsRef.current = checkSimilarItems; });

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
  const MENU_ITEM_STYLE: React.CSSProperties = {
    display: 'block', width: '100%', padding: '7px 14px', background: 'none',
    border: 'none', textAlign: 'right', cursor: 'pointer', fontSize: 12,
    color: '#374151', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px', direction: 'rtl', fontFamily: 'inherit' }}>

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
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={handleDrop}
      >
        <input
          ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) requestUpload(f); e.target.value = ''; }}
        />
        {uploading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>⏳ {t.upload.uploading}</div>
        ) : dragging ? (
          <div style={{ padding: '28px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, pointerEvents: 'none' }}>
            <span style={{ fontSize: 48 }}>📂</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#2563eb' }}>أفلت الملف هنا</span>
            <span style={{ fontSize: 12, color: '#60a5fa' }}>.xlsx · .xls · .csv</span>
          </div>
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
            <div style={{ marginTop: 14, fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>📎</span>
              <span>أو اسحب الملف مباشرة هنا</span>
              <span style={{ color: '#e2e8f0' }}>·</span>
              <kbd style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontFamily: 'monospace', color: '#475569' }}>Ctrl+V</kbd>
              <span>للصق من الحافظة (واتساب / مستكشف الملفات)</span>
            </div>
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

      {/* Close 3-dots menu on outside click */}
      {openMenuId !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setOpenMenuId(null)} />
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
              const shares = f.fileShares ?? [];
              const isSharedToMe = shares.some(s => s.userId === user?.id) && f.userId !== user?.id;
              const isSharedByMe = f.userId === user?.id && shares.length > 0;
              const shareCount   = shares.length;

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
                  {/* ── Row 1: name + badges + 3-dots menu ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
                    {/* 3-dots menu on visual left */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onClick={(e) => {
                          if (openMenuId === f.id) { setOpenMenuId(null); return; }
                          // Flip the menu upward when there isn't enough room below the
                          // button (e.g. the last file card in a long list) so its lower
                          // options aren't clipped by the viewport edge.
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMenuOpenUp(window.innerHeight - rect.bottom < 280);
                          setOpenMenuId(f.id);
                        }}
                        style={{
                          width: 28, height: 28, border: '1px solid #e2e8f0', borderRadius: 6,
                          background: openMenuId === f.id ? '#f1f5f9' : '#fff',
                          cursor: 'pointer', fontSize: 16, color: '#64748b',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                        }}
                        title="الخيارات"
                      >⋮</button>

                      {openMenuId === f.id && (
                        <div style={{
                          position: 'absolute', right: 0, zIndex: 1000,
                          ...(menuOpenUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
                          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 190,
                          maxHeight: '70vh', overflowY: 'auto',
                          padding: '4px 0', direction: 'rtl',
                        }}>
                          {/* Activate/Deactivate */}
                          <button onClick={() => { onFileActivated(f.id); setOpenMenuId(null); }} style={MENU_ITEM_STYLE}>
                            {isActive ? '✅ إلغاء التفعيل' : '⚡ تفعيل الملف'}
                          </button>

                          {/* Analyze */}
                          <button onClick={() => { handleAnalyze(f); setOpenMenuId(null); }} disabled={analyzing && analyzeFile?.id === f.id} style={MENU_ITEM_STYLE}>
                            🤖 تحليل الملف
                          </button>

                          {/* Currency convert */}
                          {hasFeature('currency_convert') && (
                            <button onClick={() => { openCurrencyModal(f); setOpenMenuId(null); }} style={MENU_ITEM_STYLE}>
                              💱 تحويل العملة
                            </button>
                          )}

                          {/* Sync with reps — manager only */}
                          {f.userId === user?.id && ['admin','manager','company_manager','team_leader','supervisor','product_manager','office_manager'].includes(user?.role ?? '') && (
                            <button onClick={() => { openShareModal(f); setOpenMenuId(null); }} style={MENU_ITEM_STYLE}>
                              🔗 {isSharedByMe ? `مزامنة (${shareCount})` : 'مزامنة مع مندوبين'}
                            </button>
                          )}

                          {/* Download my sales — shared recipient */}
                          {isSharedToMe && (
                            <button onClick={() => { downloadUserSalesExcel(f.id); setOpenMenuId(null); }} disabled={exporting === `${f.id}-me`} style={MENU_ITEM_STYLE}>
                              📥 تحميل مبيعاتي
                            </button>
                          )}

                          <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />

                          {/* Delete */}
                          {confirmId === f.id ? (
                            <div style={{ padding: '6px 12px', display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, flex: 1 }}>{t.upload.confirmDelete}</span>
                              <button style={{ ...BTN_PRI, background: '#dc2626', padding: '3px 10px' }} onClick={() => deleteFile(f.id)} disabled={deleting === f.id}>
                                {deleting === f.id ? '⏳' : '✓'}
                              </button>
                              <button style={{ ...BTN_GHOST, padding: '3px 8px' }} onClick={() => setConfirmId(null)}>✕</button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmId(f.id)} disabled={deleting === f.id}
                              style={{ ...MENU_ITEM_STYLE, color: '#dc2626' }}>
                              🗑️ حذف الملف
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* File name */}
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.originalName}
                    </span>
                    <span style={BADGE(typeMeta.bg, typeMeta.color, typeMeta.border)}>{typeMeta.label}</span>
                    {isActive && <span style={BADGE('#dcfce7', '#15803d', '#86efac')}>✓ {t.upload.statusActive}</span>}
                    {isSharedByMe && (
                      <button
                        onClick={() => setExpandedSharesId(expandedSharesId === f.id ? null : f.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid #c4b5fd', borderRadius: 20, padding: '2px 10px', background: expandedSharesId === f.id ? '#ede9fe' : '#faf5ff', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#6d28d9', flexShrink: 0 }}
                        title="عرض المندوبين"
                      >
                        🔗 {shareCount} مندوب
                        <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: expandedSharesId === f.id ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                      </button>
                    )}
                    {isSharedToMe && <span style={BADGE('#fef3c7', '#92400e', '#fcd34d')}>📥 مشارك معك</span>}
                  </div>

                  {/* ── Expanded reps row ── */}
                  {isSharedByMe && expandedSharesId === f.id && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e2e8f0' }}>
                      {shares.map(s => (
                        <span key={s.userId} style={BADGE('#ede9fe', '#6d28d9', '#c4b5fd')}>
                          🔗 {s.user.displayName || s.user.username}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* ── Row 2: meta (no row count) ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 11, color: '#64748b' }}>
                    <span>📅 {fmtDate(f.uploadedAt)}</span>
                    <span style={BADGE(currIsDollar ? '#fef9c3' : '#dcfce7', currIsDollar ? '#92400e' : '#15803d', currIsDollar ? '#fcd34d' : '#86efac')}>
                      {currIsDollar ? 'USD $' : 'IQD د.ع'}
                    </span>
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

      {/* Post-upload: confirm merging newly-detected similar items */}
      {autoDedup && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => !autoDedupApplying && setAutoDedup(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 16, padding: '20px 22px', width: 'min(620px, 96vw)', maxHeight: '86vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', direction: 'rtl' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
              <strong style={{ color: '#92400e', fontSize: 15 }}>
                ⚠️ تم اكتشاف {autoDedup.length} ايتم متشابه — أكّد الدمج (يُحتفظ بالاسم الأطول)
              </strong>
              <button onClick={() => setAutoDedup(null)} disabled={autoDedupApplying} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#92400e' }}>✕</button>
            </div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 14 }}>
              <thead>
                <tr style={{ background: '#fef3c7' }}>
                  <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>سيُحذف</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', color: '#92400e' }}>→</th>
                  <th style={{ padding: '6px 10px', textAlign: 'right', color: '#065f46', fontWeight: 700 }}>سيُبقى (الأطول)</th>
                </tr>
              </thead>
              <tbody>
                {autoDedup.map((e, i) => {
                  const keepLonger = e.from.length >= e.to.length;
                  const keep   = keepLonger ? e.from : e.to;
                  const remove = keepLonger ? e.to   : e.from;
                  return (
                    <tr key={i} style={{ borderTop: '1px solid #fde68a' }}>
                      <td style={{ padding: '6px 10px', color: '#dc2626', textDecoration: 'line-through' }}>{remove}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', color: '#92400e' }}>→</td>
                      <td style={{ padding: '6px 10px', color: '#065f46', fontWeight: 600 }}>{keep}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={applyAutoDedup} disabled={autoDedupApplying}
                style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: autoDedupApplying ? 0.7 : 1 }}>
                {autoDedupApplying ? '⏳ جاري الدمج...' : `🔀 تطبيق الدمج (${autoDedup.length} ايتم)`}
              </button>
              <button onClick={() => setAutoDedup(null)} disabled={autoDedupApplying}
                style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                تخطّي
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
            <p style={{ margin: '0 0 1rem', fontSize: '0.84rem', color: '#6b7280', wordBreak: 'break-all' }}>
              {pendingFile.name}
            </p>

            {/* File type selector */}
            <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 700, marginBottom: '0.55rem', color: '#374151' }}>
              نوع الملف
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.3rem' }}>
              {([
                { type: 'auto',    label: 'مختلط (تلقائي)', icon: '🔀', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
                { type: 'returns', label: 'ارجاعات فقط',    icon: '↩',  color: '#dc2626', bg: '#fff1f2', border: '#fecaca' },
                { type: 'sales',   label: 'مبيعات فقط',     icon: '📦', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
              ] as const).map(opt => (
                <button key={opt.type} type="button"
                  onClick={() => setFileType(opt.type)}
                  style={{
                    flex: 1, padding: '8px 4px', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
                    fontSize: 11, border: `2px solid ${fileType === opt.type ? opt.border : '#e5e7eb'}`,
                    background: fileType === opt.type ? opt.bg : '#f9fafb',
                    color: fileType === opt.type ? opt.color : '#9ca3af',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                    transition: 'all 0.1s',
                  }}
                >
                  <span style={{ fontSize: 18 }}>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>

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
            style={{ background: '#fff', borderRadius: 12, padding: '20px 20px 16px', minWidth: 340, maxWidth: 500, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', direction: 'rtl', width: '94%' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>🔗 مزامنة الملف مع مندوبين</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{shareModalFile.originalName}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 1.5 }}>
                اختر مندوبين أو أكثر — كل منهم سيرى بياناته المفلترة حسب مناطقه فقط
              </div>
            </div>

            {linkedUsersLoading ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ جاري التحميل...</div>
            ) : linkedUsers.length === 0 ? (
              <div style={{ padding: '12px', background: '#fef2f2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
                لا يوجد مندوبون مرتبطون بك — عيّنهم من لوحة الماستر أولاً
              </div>
            ) : (
              <>
                {/* Select all / clear */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <button onClick={selectAllUsers} style={{ ...BTN_SEC, fontSize: 11 }}>تحديد الكل</button>
                  <button onClick={() => setSelectedUserIds(new Set())} style={{ ...BTN_GHOST, fontSize: 11 }}>إلغاء الكل</button>
                  {selectedUserIds.size > 0 && (
                    <span style={{ fontSize: 11, color: '#6d28d9', fontWeight: 700, marginRight: 4 }}>
                      {selectedUserIds.size} محدد
                    </span>
                  )}
                </div>

                {/* User list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 300, overflowY: 'auto', marginBottom: 12 }}>
                  {linkedUsers.map(u => {
                    const ROLE_AR: Record<string, string> = { scientific_rep: 'مندوب علمي', team_leader: 'قائد فريق', supervisor: 'مشرف', manager: 'مدير' };
                    const checked = selectedUserIds.has(u.id);
                    const isExpanded = expandedAreaUserId === u.id;
                    const overrides = customAreaOverrides.get(u.id);
                    const hasOverride = overrides && overrides.size > 0;
                    return (
                      <div key={u.id} style={{
                        borderRadius: 8,
                        border: `1.5px solid ${checked ? (hasOverride ? '#0891b2' : '#7c3aed') : '#e2e8f0'}`,
                        background: checked ? (hasOverride ? '#ecfeff' : '#f5f3ff') : '#fafafa',
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}>
                        {/* Main row — checkbox + name only, no buttons here */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleSelectUser(u.id)}
                            style={{ accentColor: '#7c3aed', width: 16, height: 16, margin: 0, flexShrink: 0, cursor: 'pointer' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              title={u.name}
                              style={{
                                fontSize: 13, fontWeight: checked ? 700 : 500, color: checked ? (hasOverride ? '#0e7490' : '#6d28d9') : '#1e293b',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              }}
                            >
                              👤 {u.name}
                            </div>
                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {ROLE_AR[u.role] ?? u.role}
                              {hasOverride
                                ? <span style={{ color: '#0891b2', fontWeight: 700, marginRight: 4 }}>· 📍 {overrides!.size} منطقة مخصصة</span>
                                : u.areaCount > 0
                                  ? ` · ${u.areaCount} منطقة`
                                  : <span style={{ color: '#f59e0b', marginRight: 4 }}> · ⚠ لا مناطق</span>
                              }
                            </div>
                          </div>
                        </label>

                        {/* Action buttons row — shown only when checked */}
                        {checked && (
                          <div style={{ display: 'flex', gap: 6, padding: '0 14px 10px', flexWrap: 'wrap' }}>
                            {fileAreas.length > 0 && (
                              <button
                                onClick={() => setExpandedAreaUserId(isExpanded ? null : u.id)}
                                style={{
                                  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                                  border: `1px solid ${hasOverride ? '#0891b2' : '#a78bfa'}`,
                                  background: hasOverride ? '#cffafe' : '#ede9fe',
                                  color: hasOverride ? '#0e7490' : '#6d28d9', cursor: 'pointer',
                                }}
                              >
                                {isExpanded ? '▲ إخفاء' : (hasOverride ? `📍 ${overrides!.size} منطقة` : '📍 تخصيص المناطق')}
                              </button>
                            )}
                            <button
                              onClick={() => downloadUserSalesExcel(shareModalFile!.id, u.id)}
                              disabled={exporting === `${shareModalFile!.id}-${u.id}`}
                              style={{ ...BTN_SEC, fontSize: 11, padding: '4px 10px' }}
                              title={`تحميل بيانات ${u.name}`}
                            >
                              {exporting === `${shareModalFile!.id}-${u.id}` ? '⏳ جاري...' : '📥 تحميل'}
                            </button>
                          </div>
                        )}

                        {/* Area picker panel */}
                        {checked && isExpanded && fileAreas.length > 0 && (
                          <div style={{ borderTop: '1px solid #e0f2fe', background: '#f0f9ff', padding: '8px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: '#0369a1' }}>📍 اختر المناطق لـ {u.name}</span>
                              <button onClick={() => {
                                setCustomAreaOverrides(prev => {
                                  const next = new Map(prev);
                                  next.set(u.id, new Set(fileAreas.map(a => a.id)));
                                  return next;
                                });
                              }} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, border: '1px solid #7dd3fc', background: '#e0f2fe', color: '#0369a1', cursor: 'pointer', fontWeight: 700 }}>الكل</button>
                              <button onClick={() => {
                                setCustomAreaOverrides(prev => {
                                  const next = new Map(prev);
                                  next.delete(u.id);
                                  return next;
                                });
                              }} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>إلغاء التخصيص</button>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {fileAreas.map(area => {
                                const sel = overrides?.has(area.id) ?? false;
                                return (
                                  <button key={area.id} onClick={() => {
                                    setCustomAreaOverrides(prev => {
                                      const next = new Map(prev);
                                      const cur = new Set(next.get(u.id) ?? []);
                                      if (cur.has(area.id)) cur.delete(area.id); else cur.add(area.id);
                                      if (cur.size === 0) next.delete(u.id); else next.set(u.id, cur);
                                      return next;
                                    });
                                  }} style={{
                                    fontSize: 11, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', fontWeight: sel ? 700 : 400,
                                    border: `1px solid ${sel ? '#0891b2' : '#cbd5e1'}`,
                                    background: sel ? '#0891b2' : '#fff',
                                    color: sel ? '#fff' : '#475569',
                                  }}>
                                    {area.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {shareMsg && (
              <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 700, color: shareMsg.startsWith('✓') ? '#059669' : '#dc2626' }}>
                {shareMsg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button style={{ ...BTN_GHOST }} onClick={() => setShareModalFile(null)}>إلغاء</button>
              <button
                style={{ ...BTN_PRI, opacity: saving ? 0.7 : 1 }}
                onClick={confirmShare}
                disabled={saving || linkedUsers.length === 0}
              >
                {saving ? '⏳ جاري...' : `✓ حفظ المزامنة${selectedUserIds.size > 0 ? ` (${selectedUserIds.size})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}