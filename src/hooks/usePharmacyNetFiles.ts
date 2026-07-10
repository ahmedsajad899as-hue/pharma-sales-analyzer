import { useState, useEffect, useCallback, useRef, DragEvent } from 'react';

const API = import.meta.env.VITE_API_URL || '';

export interface UpFile { id: number; originalName: string; uploadedAt: string; rowCount: number; }

/**
 * إدارة ملفات سياق `pharmacy_net` (رفع/اختيار/حذف) — مشتركة بين صفحة Pharmacy Net
 * وصفحة تحليل الإيتم المستقلة، فكلتاهما تحلّل نفس مجموعة الملفات المرفوعة.
 */
export function usePharmacyNetFiles(token: string | null) {
  const headers = { Authorization: `Bearer ${token}` };

  const [files, setFiles]               = useState<UpFile[]>([]);
  const [selFiles, setSelFiles]         = useState<Set<number>>(new Set());
  const [filesLoading, setFilesLoading] = useState(false);

  const [uploading, setUploading]       = useState(false);
  const [uploadMsg, setUploadMsg]       = useState<{ ok: boolean; text: string } | null>(null);
  const [dragOver, setDragOver]         = useState(false);
  const [showUpload, setShowUpload]     = useState(false);
  const [clearing, setClearing]         = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<number | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Pre-upload currency selection
  const [pendingFile, setPendingFile]   = useState<File | null>(null);
  const [preCurrency, setPreCurrency]   = useState<'IQD' | 'USD'>('USD');
  const [preRate, setPreRate]           = useState<string>('1470');

  const requestUpload = (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setUploadMsg({ ok: false, text: 'يُسمح فقط بـ Excel أو CSV' }); return; }
    setPreCurrency('USD');
    setPreRate('1470');
    setPendingFile(file);
  };

  const uploadFile = useCallback(async (file: File, sourceCurrency: 'IQD' | 'USD', exchangeRate: number) => {
    setUploading(true); setUploadMsg(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('fileType', 'pharmacy_net');
    fd.append('sourceCurrency', sourceCurrency);
    try {
      const res  = await fetch(`${API}/api/upload-sales`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل الرفع');
      const newId = data.data?.uploadedFile?.id ?? data.uploadedFile?.id;
      if (newId) {
        await fetch(`${API}/api/files/${newId}/currency`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ currencyMode: sourceCurrency, exchangeRate, sourceCurrency }),
        });
      }
      setUploadMsg({ ok: true, text: `تم رفع ${file.name} — ${data.data?.rowCount ?? ''} سجل` });
      const r2 = await fetch(`${API}/api/files?context=pharmacy_net`, { headers: { Authorization: `Bearer ${token}` } });
      const d2 = await r2.json();
      const all: UpFile[] = Array.isArray(d2.data) ? d2.data : [];
      setFiles(all);
      setSelFiles(prev => { const s = new Set(prev); if (newId) s.add(newId); return s; });
      setTimeout(() => setUploadMsg(null), 7000);
    } catch (e: any) { setUploadMsg({ ok: false, text: e.message || 'حدث خطأ' }); }
    finally { setUploading(false); }
  }, [token]);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) requestUpload(file); };

  const clearAllData = useCallback(async () => {
    setClearing(true);
    try {
      for (const f of files) {
        await fetch(`${API}/api/files/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      }
      setFiles([]);
      setSelFiles(new Set());
    } finally { setClearing(false); setShowClearConfirm(false); }
  }, [files, token]);

  const deleteOneFile = useCallback(async (id: number) => {
    setDeletingFileId(id);
    try {
      await fetch(`${API}/api/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setFiles(prev => prev.filter(f => f.id !== id));
      setSelFiles(prev => { const s = new Set(prev); s.delete(id); return s; });
    } finally { setDeletingFileId(null); setConfirmDeleteFileId(null); }
  }, [token]);

  const toggleFile = (id: number) => setSelFiles(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const selectAll  = () => setSelFiles(new Set(files.map(f => f.id)));
  const selectNone = () => setSelFiles(new Set());

  const fileIdsParam = [...selFiles].join(',');
  const fileQuery    = fileIdsParam ? `?fileIds=${fileIdsParam}` : '?';

  useEffect(() => {
    setFilesLoading(true);
    fetch(`${API}/api/files?context=pharmacy_net`, { headers }).then(r => r.json()).then(d => {
      const all: UpFile[] = Array.isArray(d.data) ? d.data : [];
      setFiles(all);
      if (all.length > 0) setSelFiles(new Set(all.map(f => f.id)));
    }).catch(() => {}).finally(() => setFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return {
    files, selFiles, filesLoading, fileIdsParam, fileQuery,
    toggleFile, selectAll, selectNone,
    uploading, uploadMsg, dragOver, setDragOver, showUpload, setShowUpload,
    requestUpload, uploadFile, handleDrop, uploadInputRef,
    pendingFile, setPendingFile, preCurrency, setPreCurrency, preRate, setPreRate,
    clearing, showClearConfirm, setShowClearConfirm, clearAllData,
    confirmDeleteFileId, setConfirmDeleteFileId, deletingFileId, deleteOneFile,
  };
}
