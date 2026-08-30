import { useState, useEffect, useCallback } from 'react';

/**
 * قائمة قابلة للطي بملفات "استيراد زيارات من إكسل" السابقة — تتيح تفعيل/تعطيل
 * ملف كامل (يُخفي/يُظهر زياراته في شاشة "الزيارات" دون حذفها) أو حذفه نهائياً
 * (يحذف كل زياراته معه). راجع VisitImportFile في schema.prisma.
 */
interface ImportFile {
  id: number;
  originalName: string;
  isActive: boolean;
  createdAt: string;
  doctorVisitCount: number;
  pharmacyVisitCount: number;
}

export default function VisitImportFilesPanel({ token }: { token: string }) {
  const API = import.meta.env.VITE_API_URL || '';
  const authH = { Authorization: `Bearer ${token}` };
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

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

  const toggleActive = async (f: ImportFile) => {
    setBusyId(f.id);
    try {
      const res = await fetch(`${API}/api/doctors/visits/import-files/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ isActive: !f.isActive }),
      });
      const j = await res.json();
      if (j.success) setFiles(fs => fs.map(x => x.id === f.id ? { ...x, isActive: !x.isActive } : x));
    } finally { setBusyId(null); }
  };

  const remove = async (f: ImportFile) => {
    const total = f.doctorVisitCount + f.pharmacyVisitCount;
    if (!window.confirm(`حذف ملف "${f.originalName}" سيحذف كل زياراته (${total} زيارة) نهائياً — لا يمكن التراجع. متابعة؟`)) return;
    setBusyId(f.id);
    try {
      const res = await fetch(`${API}/api/doctors/visits/import-files/${f.id}`, { method: 'DELETE', headers: authH });
      const j = await res.json();
      if (j.success) setFiles(fs => fs.filter(x => x.id !== f.id));
    } finally { setBusyId(null); }
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return iso; }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(o => !o)} style={toggleBtn}>
        📁 الملفات المرفوعة سابقاً {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={panelBox}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 12.5 }}>⏳ جاري التحميل…</div>
          ) : files.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 12.5 }}>لا توجد ملفات مرفوعة بعد</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '30vh', overflowY: 'auto' }}>
              {files.map(f => (
                <div key={f.id} style={{ ...row, opacity: f.isActive ? 1 : 0.6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.originalName}
                    </div>
                    <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                      {fmtDate(f.createdAt)} · {f.doctorVisitCount} زيارة طبيب · {f.pharmacyVisitCount} زيارة صيدلية
                      {!f.isActive && <span style={{ color: '#d97706', fontWeight: 700 }}> · معطَّل</span>}
                    </div>
                  </div>
                  <button disabled={busyId === f.id} onClick={() => toggleActive(f)}
                    style={f.isActive ? onBtn : offBtn}
                    title={f.isActive ? 'تعطيل — إخفاء زياراته من شاشة الزيارات دون حذفها' : 'تفعيل — إظهار زياراته مجدداً'}>
                    {f.isActive ? '✅ مفعَّل' : '⏸️ معطَّل'}
                  </button>
                  <button disabled={busyId === f.id} onClick={() => remove(f)} style={delFileBtn} title="حذف الملف وكل زياراته نهائياً">🗑️</button>
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
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: '#fff', border: '1px solid #eef2f7' };
const onBtn: React.CSSProperties = { border: '1px solid #86efac', background: '#f0fdf4', color: '#166534', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
const offBtn: React.CSSProperties = { border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
const delFileBtn: React.CSSProperties = { border: '1px solid #fecaca', background: '#fff', color: '#f87171', borderRadius: 7, padding: '4px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' };
