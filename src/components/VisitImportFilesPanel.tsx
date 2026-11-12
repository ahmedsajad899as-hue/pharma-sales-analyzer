import { useState, useEffect, useCallback } from 'react';

/**
 * قائمة قابلة للطي بملفات استيراد الزيارات. منذ 2026-11-13 كل رفعة جديدة تنصهر في
 * «ملف الزيارات التراكمي» كدفعة (مثل ملف المبيعات التراكمي)؛ كل دفعة تُفعَّل/تُعطَّل/
 * تُحذف وحدها. الملفات القديمة المستقلة تبقى كما هي حتى يضغط المستخدم «دمج».
 * «مكرّر مخفي» = زيارات موجودة أصلاً في رفعة أقدم (لأي حساب، لنفس المندوب) فلا تُحسب مرتين.
 */
interface ImportBatch {
  id: number;
  originalName: string;
  source: string;
  isActive: boolean;
  createdAt: string;
  uploadedBy: string | null;
  doctorVisitCount: number;
  pharmacyVisitCount: number;
  activeVisitCount: number;
}
interface ImportFile {
  id: number;
  originalName: string;
  isActive: boolean;
  isCumulative: boolean;
  createdAt: string;
  doctorVisitCount: number;
  pharmacyVisitCount: number;
  activeVisitCount: number;
  batches: ImportBatch[];
}

const SOURCE_LABEL: Record<string, string> = { excel: '📥 إكسل', dofied: '☁️ دوفايد', telegram: '✈️ تلكرام', merged: '📁 ملف سابق' };

export default function VisitImportFilesPanel({ token }: { token: string }) {
  const API = import.meta.env.VITE_API_URL || '';
  const authH = { Authorization: `Bearer ${token}` };
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/doctors/visits/import-files`, { headers: authH });
      const j = await res.json();
      if (j.success) setFiles(j.data);
      setLoaded(true);
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { if (open && !loaded) load(); /* eslint-disable-next-line */ }, [open]);

  const call = async (key: string, url: string, init: RequestInit) => {
    setBusy(key); setMsg('');
    try {
      const res = await fetch(`${API}${url}`, { ...init, headers: { 'Content-Type': 'application/json', ...authH } });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { setMsg(j.error || 'تعذّرت العملية'); return null; }
      await load(); // العدّادات (والمكرّر المخفي) تتغيّر في رفعات أخرى أيضاً
      return j;
    } finally { setBusy(null); }
  };

  const toggleFile = (f: ImportFile) => call(`f${f.id}`, `/api/doctors/visits/import-files/${f.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !f.isActive }) });
  const removeFile = (f: ImportFile) => {
    const total = f.doctorVisitCount + f.pharmacyVisitCount;
    const what = f.isCumulative ? `الملف التراكمي بكل رفعاته (${f.batches.length})` : `ملف "${f.originalName}"`;
    if (!window.confirm(`حذف ${what} سيحذف كل زياراته (${total} زيارة) نهائياً — لا يمكن التراجع. متابعة؟`)) return;
    call(`f${f.id}`, `/api/doctors/visits/import-files/${f.id}`, { method: 'DELETE' });
  };
  const toggleBatch = (b: ImportBatch) => call(`b${b.id}`, `/api/doctors/visits/import-batches/${b.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !b.isActive }) });
  const removeBatch = (b: ImportBatch) => {
    const total = b.doctorVisitCount + b.pharmacyVisitCount;
    if (!window.confirm(`حذف رفعة "${b.originalName}" سيحذف زياراتها (${total} زيارة) نهائياً — لا يمكن التراجع. متابعة؟`)) return;
    call(`b${b.id}`, `/api/doctors/visits/import-batches/${b.id}`, { method: 'DELETE' });
  };

  const standalone = files.filter(f => !f.isCumulative);
  const canMerge = standalone.length > 0 && (files.length > 1);
  const merge = async () => {
    if (!window.confirm(`دمج ${standalone.length} ملف سابق في ملف الزيارات التراكمي؟\nكل ملف يصير رفعة داخله باسمه وتاريخه وحالة تفعيله — لا تُحذف أي زيارة.`)) return;
    const j = await call('merge', '/api/doctors/visits/import-files/merge', { method: 'POST' });
    if (j?.data) setMsg(`✅ دُمج ${j.data.merged} ملف (${j.data.movedVisits ?? 0} زيارة) في ملف واحد`);
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return iso; }
  };
  const hiddenNote = (total: number, active: number, isActive: boolean) =>
    isActive && total > active ? <span style={{ color: '#64748b' }}> · {total - active} مكرّر مخفي</span> : null;

  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(o => !o)} style={toggleBtn}>
        📁 الملفات المرفوعة سابقاً {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={panelBox}>
          {msg && <div style={{ fontSize: 12, fontWeight: 700, color: msg.startsWith('✅') ? '#166534' : '#b91c1c', marginBottom: 8 }}>{msg}</div>}
          {canMerge && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, padding: '6px 8px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
              <span style={{ fontSize: 11.5, color: '#1e3a8a', fontWeight: 600 }}>{standalone.length} ملف سابق مستقل — يمكن دمجها في ملف واحد</span>
              <button disabled={busy === 'merge'} onClick={merge} style={mergeBtn}>{busy === 'merge' ? '⏳ جارِ الدمج…' : '🔗 دمج في ملف واحد'}</button>
            </div>
          )}
          {loading && !loaded ? (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 12.5 }}>⏳ جاري التحميل…</div>
          ) : files.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 12.5 }}>لا توجد ملفات مرفوعة بعد</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '36vh', overflowY: 'auto' }}>
              {files.map(f => (
                <div key={f.id} style={{ ...fileBox, opacity: f.isActive ? 1 : 0.6, borderColor: f.isCumulative ? '#c7d2fe' : '#eef2f7' }}>
                  <div style={row}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.isCumulative ? '🗂️ ' : ''}{f.originalName}
                      </div>
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                        {f.isCumulative ? `${f.batches.length} رفعة` : fmtDate(f.createdAt)} · {f.doctorVisitCount} زيارة طبيب · {f.pharmacyVisitCount} زيارة صيدلية
                        {hiddenNote(f.doctorVisitCount + f.pharmacyVisitCount, f.activeVisitCount, f.isActive)}
                        {!f.isActive && <span style={{ color: '#d97706', fontWeight: 700 }}> · معطَّل</span>}
                      </div>
                    </div>
                    <button disabled={busy === `f${f.id}`} onClick={() => toggleFile(f)}
                      style={f.isActive ? onBtn : offBtn}
                      title={f.isActive ? 'تعطيل — إخفاء زياراته من كل الشاشات دون حذفها' : 'تفعيل — إظهار زياراته مجدداً'}>
                      {f.isActive ? '✅ مفعَّل' : '⏸️ معطَّل'}
                    </button>
                    <button disabled={busy === `f${f.id}`} onClick={() => removeFile(f)} style={delFileBtn} title="حذف الملف وكل زياراته نهائياً">🗑️</button>
                  </div>
                  {f.isCumulative && f.batches.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, paddingInlineStart: 12, borderInlineStart: '2px solid #e0e7ff' }}>
                      {f.batches.map(b => (
                        <div key={b.id} style={{ ...row, padding: '4px 6px', background: '#f8fafc', opacity: b.isActive ? 1 : 0.6 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {b.originalName}
                            </div>
                            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
                              {SOURCE_LABEL[b.source] ?? b.source} · {fmtDate(b.createdAt)}{b.uploadedBy ? ` · ${b.uploadedBy}` : ''} · {b.doctorVisitCount + b.pharmacyVisitCount} زيارة
                              {hiddenNote(b.doctorVisitCount + b.pharmacyVisitCount, b.activeVisitCount, b.isActive && f.isActive)}
                            </div>
                          </div>
                          <button disabled={busy === `b${b.id}`} onClick={() => toggleBatch(b)}
                            style={{ ...(b.isActive ? onBtn : offBtn), padding: '3px 8px', fontSize: 10.5 }}
                            title={b.isActive ? 'تعطيل هذه الرفعة وحدها' : 'تفعيل هذه الرفعة'}>
                            {b.isActive ? '✅' : '⏸️'}
                          </button>
                          <button disabled={busy === `b${b.id}`} onClick={() => removeBatch(b)} style={{ ...delFileBtn, padding: '3px 6px', fontSize: 11 }} title="حذف هذه الرفعة وزياراتها (تراجع)">🗑️</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const toggleBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const panelBox: React.CSSProperties = { marginTop: 8, border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#f8fafc' };
const fileBox: React.CSSProperties = { padding: '6px 8px', borderRadius: 8, background: '#fff', border: '1px solid #eef2f7' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, borderRadius: 6 };
const onBtn: React.CSSProperties = { border: '1px solid #86efac', background: '#f0fdf4', color: '#166534', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
const offBtn: React.CSSProperties = { border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
const delFileBtn: React.CSSProperties = { border: '1px solid #fecaca', background: '#fff', color: '#f87171', borderRadius: 7, padding: '4px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' };
const mergeBtn: React.CSSProperties = { border: '1px solid #93c5fd', background: '#fff', color: '#1d4ed8', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
