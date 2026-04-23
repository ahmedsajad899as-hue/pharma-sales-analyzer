/**
 * FileFilterPage — تنقية الملفات
 *
 * 3 تبويبات:
 *   📁 الملفات       — قائمة الملفات المحفوظة على السيرفر + رفع جديد
 *   📊 فتح الملف     — جدول Excel كامل قابل للتعديل والتصدير
 *   ⚙️ الإعدادات     — تعيين مسبق (شركات، ايتمات، مندوبين، حالة، بونص)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

const API = '';

/* ══ Types ════════════════════════════════════════════════ */
interface UploadedFile {
  id: number;
  originalName: string;
  rowCount: number;
  uploadedAt: string;
  fileType?: string;
}

interface FilterPreset {
  id: number;
  name: string;
  data: PresetData | string;
  updatedAt: string;
}

interface PresetData {
  companies:  string[];
  items:      string[];
  reps:       string[];
  statuses:   string[];
  bonuses:    Record<string, string>;
}

type Tab = 'files' | 'viewer' | 'presets';

/* ══ Column auto-detection ════════════════════════════════ */
const H_CO     = ['الصنف','صنف','اسم الصنف','الشركة','الشركه','شركة','شركه','company','اسم الشركة','اسم الشركه','الشركات'];
const H_ITEM   = ['الايتم','ايتم','item','اسم الايتم','المنتج','product','اسم المنتج','اسم الماده','اسم المادة','الماده','المادة'];
const H_REP    = ['مندوب','المندوب','rep','اسم المندوب','ممثل','مسوق'];
const H_STATUS = ['الحاله','الحالة','حاله','حالة','status','حالة الطلب','حالة الطلبية','حالة الطلبيه'];

function findCol(headers: string[], hints: string[]): number {
  for (const h of hints) {
    const i = headers.findIndex(c => c.trim().toLowerCase() === h.toLowerCase());
    if (i !== -1) return i;
  }
  for (const h of hints) {
    const i = headers.findIndex(c => c.trim().toLowerCase().includes(h.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function readXlsx(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = e => {
      try {
        const wb   = XLSX.read(e.target!.result, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!raw.length) throw new Error('الملف فارغ');
        const headers = (raw[0] as any[]).map(String);
        const rows    = raw.slice(1).map(r => headers.map((_, i) => String(r[i] ?? '')));
        resolve({ headers, rows });
      } catch (e: any) { reject(e); }
    };
    fr.onerror = () => reject(new Error('فشل قراءة الملف'));
    fr.readAsArrayBuffer(file);
  });
}

/* ══════════════════════════════════════════════════════════
   TAB: Files
══════════════════════════════════════════════════════════ */
function FilesTab({ token, onOpenFile }: { token: string; onOpenFile: (f: UploadedFile) => void }) {
  const [files, setFiles]         = useState<UploadedFile[]>([]);
  const [loading, setLoading]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch(`${API}/api/files?context=filter_page`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (json.success) setFiles(json.data || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const uploadFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setError('يرجى رفع ملف Excel أو CSV فقط'); return; }
    setError(''); setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('fileType', 'filter_page');
      const res  = await fetch(`${API}/api/upload-sales`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطأ في الرفع');
      await loadFiles();
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  };

  const deleteFile = async (id: number) => {
    if (!confirm('هل تريد حذف هذا الملف وبياناته؟')) return;
    await fetch(`${API}/api/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  return (
    <div style={{ padding: 20, direction: 'rtl' }}>
      <div
        onDragEnter={() => setDragActive(true)} onDragLeave={() => setDragActive(false)}
        onDragOver={e => { e.preventDefault(); setDragActive(true); }}
        onDrop={e => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}
        onClick={() => !uploading && fileInputRef.current?.click()}
        style={{ border: `2px dashed ${dragActive ? '#1a56db' : '#cbd5e1'}`, borderRadius: 14, padding: '28px 24px', textAlign: 'center', cursor: uploading ? 'wait' : 'pointer', background: dragActive ? '#eff6ff' : '#fff', marginBottom: 20, transition: 'all .2s' }}
      >
        <div style={{ fontSize: 32, marginBottom: 6 }}>{uploading ? '⏳' : '📤'}</div>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>{uploading ? 'جاري الرفع...' : 'ارفع ملف Excel جديد (اسحب أو اضغط)'}</div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>xlsx • xls • csv</div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.[0]) uploadFile(e.target.files[0]); e.target.value = ''; }} />
      </div>
      {error && <div style={{ marginBottom: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>{error}</div>}
      {loading ? <div style={{ textAlign: 'center', color: '#94a3b8', padding: 40 }}>جاري التحميل...</div>
       : files.length === 0 ? <div style={{ textAlign: 'center', color: '#94a3b8', padding: 40 }}>لا توجد ملفات مرفوعة بعد</div>
       : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {files.map(f => (
            <div key={f.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 24 }}>📄</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.originalName}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{f.rowCount?.toLocaleString('ar-IQ')} صف &nbsp;•&nbsp; {new Date(f.uploadedAt).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
              </div>
              <button onClick={() => onOpenFile(f)} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', color: '#1a56db', fontWeight: 600 }}>📊 فتح</button>
              <a href={`${API}/api/files/${f.id}/download`} download style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', color: '#16a34a', fontWeight: 600, textDecoration: 'none' }}>⬇️ تحميل</a>
              <button onClick={() => deleteFile(f.id)} style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: '#dc2626', fontWeight: 600 }}>🗑️</button>
            </div>
          ))}
        </div>
      }
    </div>
  );
}

/* ══ Filter group helpers ════════════════════════════════ */
function FilterGroup({ label, values, selected, onChange }: { label: string; values: string[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [search, setSearch] = useState('');
  const visible = values.filter(v => !search || v.toLowerCase().includes(search.toLowerCase()));
  const allSel  = values.length > 0 && values.every(v => selected.has(v));
  const toggle  = (v: string) => { const n = new Set(selected); n.has(v) ? n.delete(v) : n.add(v); onChange(n); };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a' }}>{label}</span>
        <button onClick={() => allSel ? onChange(new Set()) : onChange(new Set(values))} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, cursor: 'pointer', background: allSel ? '#fef2f2' : '#f0fdf4', color: allSel ? '#dc2626' : '#16a34a', border: `1px solid ${allSel ? '#fecaca' : '#bbf7d0'}` }}>{allSel ? 'إلغاء الكل' : 'الكل'}</button>
      </div>
      {values.length > 5 && <input type="text" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11, outline: 'none', marginBottom: 4, boxSizing: 'border-box' as const }} />}
      <div style={{ maxHeight: 140, overflowY: 'auto' as const }}>
        {visible.map(v => (
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} style={{ accentColor: '#1a56db', width: 13, height: 13, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: selected.has(v) ? '#1e293b' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v || '(فارغ)'}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FilterGroupWithBonus({ label, values, selected, onChange, bonusMap, onBonusChange }: { label: string; values: string[]; selected: Set<string>; onChange: (s: Set<string>) => void; bonusMap: Record<string, string>; onBonusChange: (m: Record<string, string>) => void }) {
  const [search, setSearch] = useState('');
  const visible = values.filter(v => !search || v.toLowerCase().includes(search.toLowerCase()));
  const allSel  = values.length > 0 && values.every(v => selected.has(v));
  const toggle  = (v: string) => { const n = new Set(selected); n.has(v) ? n.delete(v) : n.add(v); onChange(n); };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a' }}>{label}</span>
        <button onClick={() => allSel ? onChange(new Set()) : onChange(new Set(values))} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, cursor: 'pointer', background: allSel ? '#fef2f2' : '#f0fdf4', color: allSel ? '#dc2626' : '#16a34a', border: `1px solid ${allSel ? '#fecaca' : '#bbf7d0'}` }}>{allSel ? 'إلغاء الكل' : 'الكل'}</button>
      </div>
      {values.length > 5 && <input type="text" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11, outline: 'none', marginBottom: 4, boxSizing: 'border-box' as const }} />}
      <div style={{ maxHeight: 180, overflowY: 'auto' as const }}>
        {visible.map(v => (
          <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px' }}>
            <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} style={{ accentColor: '#1a56db', width: 13, height: 13, flexShrink: 0, cursor: 'pointer' }} />
            <span style={{ flex: 1, fontSize: 10, color: selected.has(v) ? '#1e293b' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => toggle(v)}>{v || '(فارغ)'}</span>
            {selected.has(v) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <input type="number" placeholder="0" value={bonusMap[v] ?? ''} onChange={e => onBonusChange({ ...bonusMap, [v]: e.target.value })}
                  style={{ width: 46, padding: '2px 4px', borderRadius: 5, fontSize: 10, border: bonusMap[v] ? '1px solid #86efac' : '1px solid #d1d5db', background: bonusMap[v] ? '#f0fdf4' : '#f8fafc', outline: 'none', textAlign: 'center' as const }} />
                <span style={{ fontSize: 9, color: '#64748b' }}>%</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: File Viewer / Editor
══════════════════════════════════════════════════════════ */
function ViewerTab({ token, targetFile, presets, onClearTarget }: { token: string; targetFile: UploadedFile | null; presets: FilterPreset[]; onClearTarget: () => void }) {
  const [headers,    setHeaders]    = useState<string[]>([]);
  const [allRows,    setAllRows]    = useState<string[][]>([]);
  const [editRows,   setEditRows]   = useState<string[][]>([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [fileName,   setFileName]   = useState('');
  const [coIdx,      setCoIdx]      = useState(-1);
  const [itemIdx,    setItemIdx]    = useState(-1);
  const [repIdx,     setRepIdx]     = useState(-1);
  const [statusIdx,  setStatusIdx]  = useState(-1);
  const [bonusIdx,   setBonusIdx]   = useState(-1);
  const [selCos,     setSelCos]     = useState<Set<string>>(new Set());
  const [selItems,   setSelItems]   = useState<Set<string>>(new Set());
  const [selReps,    setSelReps]    = useState<Set<string>>(new Set());
  const [selStatuses,setSelStatuses] = useState<Set<string>>(new Set());
  const [bonusMap,   setBonusMap]   = useState<Record<string, string>>({});
  const [search,     setSearch]     = useState('');
  const [activePresetId, setActivePresetId] = useState<number | null>(null);

  useEffect(() => {
    if (!targetFile) return;
    setLoading(true); setError(''); setHeaders([]); setAllRows([]); setEditRows([]);
    fetch(`${API}/api/files/${targetFile.id}/download`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        if (!res.ok) throw new Error('الملف الأصلي غير متوفر على القرص — يمكنك رفعه مجدداً');
        const blob = await res.blob();
        const file = new File([blob], targetFile.originalName);
        const { headers: h, rows } = await readXlsx(file);
        setFileName(targetFile.originalName);
        setHeaders(h); setAllRows(rows); setEditRows(rows.map(r => [...r]));
        const ci = findCol(h, H_CO);
        let   ii = findCol(h, H_ITEM);
        const ri = findCol(h, H_REP);
        const si = findCol(h, H_STATUS);
        const bi = findCol(h, ['بونص','bonus']);
        if (ci >= 0 && ii === ci) ii = -1;
        setCoIdx(ci); setItemIdx(ii); setRepIdx(ri); setStatusIdx(si); setBonusIdx(bi);
        setSelCos(new Set(ci >= 0 ? rows.map(r => r[ci]).filter(Boolean) : []));
        setSelItems(new Set(ii >= 0 ? rows.map(r => r[ii]).filter(Boolean) : []));
        setSelReps(new Set(ri >= 0 ? rows.map(r => r[ri]).filter(Boolean) : []));
        setSelStatuses(new Set(si >= 0 ? rows.map(r => r[si]).filter(Boolean) : []));
        setBonusMap({}); setActivePresetId(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [targetFile, token]);

  const applyPreset = (p: FilterPreset) => {
    const d = typeof p.data === 'string' ? JSON.parse(p.data) as PresetData : p.data as PresetData;
    if (d.companies?.length) setSelCos(new Set(d.companies));
    if (d.items?.length)     setSelItems(new Set(d.items));
    if (d.reps?.length)      setSelReps(new Set(d.reps));
    if (d.statuses?.length)  setSelStatuses(new Set(d.statuses));
    if (d.bonuses)           setBonusMap(d.bonuses);
    setActivePresetId(p.id);
  };

  const filteredRows = editRows.filter(row => {
    const co     = coIdx     >= 0 ? row[coIdx]     : null;
    const item   = itemIdx   >= 0 ? row[itemIdx]   : null;
    const rep    = repIdx    >= 0 ? row[repIdx]    : null;
    const status = statusIdx >= 0 ? row[statusIdx] : null;
    if (co     !== null && selCos.size     > 0 && !selCos.has(co))          return false;
    if (item   !== null && selItems.size   > 0 && !selItems.has(item))      return false;
    if (rep    !== null && selReps.size    > 0 && !selReps.has(rep))        return false;
    if (status !== null && selStatuses.size > 0 && !selStatuses.has(status)) return false;
    if (search) { const q = search.toLowerCase(); if (!row.some(c => c.toLowerCase().includes(q))) return false; }
    return true;
  });

  const hasAnyBonus  = Object.values(bonusMap).some(v => v !== '');
  const exportHeaders = bonusIdx < 0 && hasAnyBonus ? [...headers, 'بونص%'] : headers;
  const exportRows = filteredRows.map(row => {
    const itemVal = itemIdx >= 0 ? row[itemIdx] : '';
    const bonus   = bonusMap[itemVal] ?? '';
    if (bonusIdx >= 0 && bonus) { const r = [...row]; r[bonusIdx] = bonus; return r; }
    if (bonusIdx < 0 && hasAnyBonus) return [...row, bonus];
    return row;
  });

  const doExport = () => {
    const ws = XLSX.utils.aoa_to_sheet([exportHeaders, ...exportRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, (fileName || 'file').replace(/\.(xlsx?|csv)$/i, '') + '_filtered.xlsx');
  };

  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    setEditRows(prev => { const next = prev.map(r => [...r]); next[rowIdx][colIdx] = value; return next; });
  };

  const uniqueVals = (idx: number) => idx >= 0
    ? [...new Set(allRows.map(r => r[idx]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'))
    : [];

  if (!targetFile) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', direction: 'rtl' }}>اختر ملفاً من تبويب <strong>الملفات</strong> لعرضه هنا</div>;
  }
  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>⏳ جاري تحميل الملف...</div>;
  if (error) return (
    <div style={{ padding: 24, direction: 'rtl' }}>
      <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#dc2626', fontSize: 13 }}>{error}</div>
      <button onClick={onClearTarget} style={{ marginTop: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', cursor: 'pointer', fontSize: 13 }}>← رجوع</button>
    </div>
  );
  if (!headers.length) return null;

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Top bar */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', position: 'sticky', top: 48, zIndex: 9 }}>
        <button onClick={onClearTarget} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: '#475569', fontWeight: 600 }}>← رجوع</button>
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>📄 {fileName}</span>
          <span style={{ fontSize: 11, color: '#64748b', marginRight: 8 }}>{allRows.length.toLocaleString('ar-IQ')} صف ← <strong style={{ color: '#1a56db' }}>{filteredRows.length.toLocaleString('ar-IQ')} بعد الفلترة</strong></span>
        </div>
        <input type="text" placeholder="🔍 بحث في كل الصفوف..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', width: 200 }} />
        <button onClick={doExport} disabled={filteredRows.length === 0} style={{ background: filteredRows.length === 0 ? '#f1f5f9' : '#1a56db', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, cursor: filteredRows.length === 0 ? 'not-allowed' : 'pointer', color: filteredRows.length === 0 ? '#94a3b8' : '#fff', fontWeight: 700 }}>⬇️ تصدير ({filteredRows.length.toLocaleString('ar-IQ')})</button>
      </div>

      <div style={{ display: 'flex', gap: 0 }}>
        {/* Filter sidebar */}
        <div style={{ width: 220, flexShrink: 0, borderLeft: '1px solid #e2e8f0', background: '#f8fafc', padding: 14, overflowY: 'auto', position: 'sticky', top: 96, height: 'calc(100vh - 96px)' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a', marginBottom: 12 }}>⚙️ الفلاتر</div>
          {presets.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>إعداد مسبق</div>
              {presets.map(p => (
                <button key={p.id} onClick={() => applyPreset(p)} style={{ display: 'block', width: '100%', textAlign: 'right', marginBottom: 4, padding: '5px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: activePresetId === p.id ? '#eff6ff' : '#fff', border: `1px solid ${activePresetId === p.id ? '#bfdbfe' : '#e2e8f0'}`, color: activePresetId === p.id ? '#1a56db' : '#475569', fontWeight: 500 }}>📋 {p.name}</button>
              ))}
              <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '10px 0' }} />
            </div>
          )}
          {coIdx    >= 0 && <FilterGroup label="🏢 الشركة"   values={uniqueVals(coIdx)}    selected={selCos}      onChange={setSelCos} />}
          {itemIdx  >= 0 && <FilterGroupWithBonus label="📦 الايتم" values={uniqueVals(itemIdx)} selected={selItems} onChange={setSelItems} bonusMap={bonusMap} onBonusChange={setBonusMap} />}
          {repIdx   >= 0 && <FilterGroup label="👤 المندوب"  values={uniqueVals(repIdx)}   selected={selReps}     onChange={setSelReps} />}
          {statusIdx >= 0 && <FilterGroup label="📋 الحالة"  values={uniqueVals(statusIdx)} selected={selStatuses} onChange={setSelStatuses} />}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 96px)' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
              <tr>
                {headers.map((h, i) => (
                  <th key={i} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', padding: '8px 10px', fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', textAlign: 'center' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 500).map((row, ri) => {
                const origIdx = editRows.indexOf(row);
                return (
                  <tr key={ri} style={{ background: ri % 2 === 0 ? '#fff' : '#f8fafc' }}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ border: '1px solid #e2e8f0', padding: 0 }}>
                        <input value={cell} onChange={e => updateCell(origIdx >= 0 ? origIdx : ri, ci, e.target.value)}
                          style={{ width: '100%', padding: '5px 8px', border: 'none', background: 'transparent', fontSize: 12, outline: 'none', color: '#1e293b', textAlign: 'center' as const }} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length > 500 && <div style={{ padding: '10px 16px', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>تعرض أول 500 صف — استخدم التصدير للبيانات الكاملة</div>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TAB: Presets
══════════════════════════════════════════════════════════ */
function PresetsTab({ token, presets, onPresetsChange }: { token: string; presets: FilterPreset[]; onPresetsChange: (p: FilterPreset[]) => void }) {
  const [newName,    setNewName]    = useState('');
  const [editId,     setEditId]     = useState<number | null>(null);
  const [companies,  setCompanies]  = useState('');
  const [items,      setItems]      = useState('');
  const [reps,       setReps]       = useState('');
  const [statuses,   setStatuses]   = useState('');
  const [bonusLines, setBonusLines] = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  const openNew = () => { setEditId(null); setNewName(''); setCompanies(''); setItems(''); setReps(''); setStatuses(''); setBonusLines(''); };

  const openEdit = (p: FilterPreset) => {
    const d = typeof p.data === 'string' ? JSON.parse(p.data) as PresetData : p.data as PresetData;
    setEditId(p.id); setNewName(p.name);
    setCompanies((d.companies || []).join('\n'));
    setItems((d.items || []).join('\n'));
    setReps((d.reps || []).join('\n'));
    setStatuses((d.statuses || []).join('\n'));
    setBonusLines(Object.entries(d.bonuses || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  };

  const splitLines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);

  const save = async () => {
    if (!newName.trim()) { setError('يرجى إدخال اسم الإعداد'); return; }
    setSaving(true); setError('');
    const bonuses: Record<string, string> = {};
    splitLines(bonusLines).forEach(line => { const [k, ...rest] = line.split('='); if (k && rest.length) bonuses[k.trim()] = rest.join('=').trim(); });
    const data: PresetData = { companies: splitLines(companies), items: splitLines(items), reps: splitLines(reps), statuses: splitLines(statuses), bonuses };
    try {
      const json = await fetch(`${API}/api/filter-presets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim(), data }) }).then(r => r.json());
      if (json.success) {
        const list = await fetch(`${API}/api/filter-presets`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        if (list.success) onPresetsChange(list.data);
        openNew();
      } else { setError(json.error || 'خطأ في الحفظ'); }
    } catch { setError('خطأ في الاتصال بالسيرفر'); }
    finally { setSaving(false); }
  };

  const deletePreset = async (id: number) => {
    if (!confirm('هل تريد حذف هذا الإعداد؟')) return;
    await fetch(`${API}/api/filter-presets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    onPresetsChange(presets.filter(p => p.id !== id));
  };

  const fields = [
    { label: '🏢 الشركات المضمّنة (كل سطر = شركة)', val: companies, set: setCompanies, placeholder: 'اتركه فارغاً لتضمين الكل' },
    { label: '📦 الايتمات المضمّنة (كل سطر = ايتم)', val: items, set: setItems, placeholder: 'اتركه فارغاً لتضمين الكل' },
    { label: '👤 المندوبون المضمّنون (كل سطر = مندوب)', val: reps, set: setReps, placeholder: 'اتركه فارغاً لتضمين الكل' },
    { label: '📋 حالات الطلبية (كل سطر = حالة)', val: statuses, set: setStatuses, placeholder: 'اتركه فارغاً لتضمين الكل' },
    { label: '💰 البونص% (كل سطر: اسم_الايتم=النسبة)', val: bonusLines, set: setBonusLines, placeholder: 'مثال:\nبروفين=10\nباراسيتامول=15' },
  ];

  return (
    <div style={{ padding: 20, direction: 'rtl', display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* Saved list */}
      <div style={{ flex: '1 1 300px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', marginBottom: 12 }}>📋 الإعدادات المحفوظة</div>
        {presets.length === 0
          ? <div style={{ color: '#94a3b8', fontSize: 13, padding: '20px 0' }}>لا توجد إعدادات بعد</div>
          : presets.map(p => {
            const d = typeof p.data === 'string' ? JSON.parse(p.data) as PresetData : p.data as PresetData;
            return (
              <div key={p.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>📋 {p.name}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(p)} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#1a56db' }}>تعديل</button>
                    <button onClick={() => deletePreset(p.id)} style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#dc2626' }}>🗑️</button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {(d.companies?.length  ?? 0) > 0 && <span>🏢 {d.companies.length} شركة</span>}
                  {(d.items?.length      ?? 0) > 0 && <span>📦 {d.items.length} ايتم</span>}
                  {(d.reps?.length       ?? 0) > 0 && <span>👤 {d.reps.length} مندوب</span>}
                  {(d.statuses?.length   ?? 0) > 0 && <span>📋 {d.statuses.length} حالة</span>}
                  {Object.keys(d.bonuses || {}).length > 0 && <span>💰 بونص {Object.keys(d.bonuses).length} ايتم</span>}
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Form */}
      <div style={{ flex: '1 1 340px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', marginBottom: 14 }}>{editId ? '✏️ تعديل الإعداد' : '➕ إعداد جديد'}</div>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>اسم الإعداد</label>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="مثال: شركة ABC فقط"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, outline: 'none', marginBottom: 12, boxSizing: 'border-box' as const }} />
        {fields.map(({ label, val, set, placeholder }) => (
          <div key={label} style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
            <textarea value={val} onChange={e => set(e.target.value)} placeholder={placeholder} rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const, fontFamily: 'inherit', direction: 'rtl' }} />
          </div>
        ))}
        {error && <div style={{ marginBottom: 10, color: '#dc2626', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ flex: 1, background: saving ? '#f1f5f9' : '#1a56db', border: 'none', borderRadius: 8, padding: '9px', fontSize: 13, cursor: saving ? 'wait' : 'pointer', color: saving ? '#94a3b8' : '#fff', fontWeight: 700 }}>{saving ? 'جاري الحفظ...' : '💾 حفظ الإعداد'}</button>
          {editId && <button onClick={openNew} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 14px', fontSize: 12, cursor: 'pointer', color: '#475569' }}>إلغاء</button>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════ */
export default function FileFilterPage() {
  const { token } = useAuth();
  const [tab,        setTab]        = useState<Tab>('files');
  const [targetFile, setTargetFile] = useState<UploadedFile | null>(null);
  const [presets,    setPresets]    = useState<FilterPreset[]>([]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/filter-presets`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(json => { if (json.success) setPresets(json.data || []); })
      .catch(() => {});
  }, [token]);

  const openFile = (f: UploadedFile) => { setTargetFile(f); setTab('viewer'); };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'files',   label: '📁 الملفات' },
    { id: 'viewer',  label: '📊 فتح الملف' },
    { id: 'presets', label: '⚙️ الإعدادات المسبقة' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', direction: 'rtl' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', padding: '0 16px', position: 'sticky', top: 0, zIndex: 10, gap: 4 }}>
        <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a', padding: '14px 8px 14px 0', marginLeft: 12 }}>🗂️ تنقية الملفات</span>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '12px 18px', border: 'none', background: 'none', fontSize: 13, cursor: 'pointer', fontWeight: tab === t.id ? 700 : 500, color: tab === t.id ? '#1a56db' : '#64748b', borderBottom: tab === t.id ? '2px solid #1a56db' : '2px solid transparent' }}>{t.label}</button>
        ))}
      </div>
      {tab === 'files'   && <FilesTab   token={token!} onOpenFile={openFile} />}
      {tab === 'viewer'  && <ViewerTab  token={token!} targetFile={targetFile} presets={presets} onClearTarget={() => { setTargetFile(null); setTab('files'); }} />}
      {tab === 'presets' && <PresetsTab token={token!} presets={presets} onPresetsChange={setPresets} />}
    </div>
  );
}
