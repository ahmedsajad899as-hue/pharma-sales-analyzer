import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// ── Types ────────────────────────────────────────────────────
interface Survey {
  id: number; name: string; description?: string;
  _count: { doctors: number; pharmacies: number };
}
interface SurveyDoctor {
  id: number; name: string; specialty?: string; areaName?: string;
  pharmacyName?: string; phone?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface SurveyPharmacy {
  id: number; name: string; ownerName?: string; phone?: string;
  address?: string; areaName?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface SurveyDetail extends Survey {
  doctors: SurveyDoctor[];
  pharmacies: SurveyPharmacy[];
}

// ── Helpers ──────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid #e2e8f0', borderTopColor: '#8B1A1A', animation: 'surveySpins .6s linear infinite' }} />
      <style>{`@keyframes surveySpins{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 2500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
      background: '#1e293b', color: '#fff', padding: '12px 24px', borderRadius: 24,
      fontSize: 14, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
      direction: 'rtl', whiteSpace: 'nowrap',
    }}>{msg}</div>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 18, padding: 24, width: '100%', maxWidth: 500,
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────
export default function SurveyPage() {
  const { user } = useAuth();
  const token = localStorage.getItem('auth_token');
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [surveys,        setSurveys]        = useState<Survey[]>([]);
  const [selectedSurvey, setSelectedSurvey] = useState<SurveyDetail | null>(null);
  const [tab,            setTab]            = useState<'doctors' | 'pharmacies'>('doctors');
  const [loading,        setLoading]        = useState(true);
  const [toast,          setToast]          = useState<string | null>(null);

  // Edit modal state
  const [editingDoc,     setEditingDoc]     = useState<SurveyDoctor | null>(null);
  const [editingPharma,  setEditingPharma]  = useState<SurveyPharmacy | null>(null);
  const [addingDoc,      setAddingDoc]      = useState(false);
  const [addingPharma,   setAddingPharma]   = useState(false);

  const showToast = (msg: string) => setToast(msg);

  // ── Fetch surveys ──
  const fetchSurveys = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/master-surveys', { headers: H() });
      const d = await r.json();
      if (d.success) setSurveys(d.data);
    } finally { setLoading(false); }
  }, [H]);

  useEffect(() => { fetchSurveys(); }, [fetchSurveys]);

  const openSurvey = async (id: number) => {
    const r = await fetch(`/api/master-surveys/${id}`, { headers: H() });
    const d = await r.json();
    if (d.success) { setSelectedSurvey(d.data); setTab('doctors'); }
  };

  const reloadSurvey = async () => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}`, { headers: H() });
    const d = await r.json();
    if (d.success) setSelectedSurvey(d.data);
  };

  // ── Import helpers ──
  const importDoctor = async (docId: number) => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/doctors/${docId}/import`, { method: 'POST', headers: H() });
    const d = await r.json();
    showToast(d.success ? '✅ أُضيف الطبيب لقائمة أطبائك' : d.error ?? 'خطأ');
  };

  const importPharmacy = async (pharmaId: number) => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/pharmacies/${pharmaId}/import`, { method: 'POST', headers: H() });
    const d = await r.json();
    showToast(d.success ? '✅ أُضيفت الصيدلية لقائمتك' : d.error ?? 'خطأ');
  };

  // ── Edit Doctor Form ──
  function EditDoctorModal({ doc, onClose }: { doc: SurveyDoctor | null; onClose: () => void }) {
    const isNew = !doc;
    const [form, setForm] = useState({
      name: doc?.name ?? '', specialty: doc?.specialty ?? '',
      areaName: doc?.areaName ?? '', pharmacyName: doc?.pharmacyName ?? '',
      phone: doc?.phone ?? '', notes: doc?.notes ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

    const save = async () => {
      if (!form.name.trim() || !selectedSurvey) return;
      setSaving(true);
      const url    = isNew ? `/api/master-surveys/${selectedSurvey.id}/doctors` : `/api/master-surveys/${selectedSurvey.id}/doctors/${doc!.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await fetch(url, { method, headers: H(), body: JSON.stringify(form) });
      const d = await r.json();
      if (d.success) { showToast(isNew ? '✅ تم إضافة الطبيب' : '✅ تم التعديل'); reloadSurvey(); onClose(); }
      else showToast(d.error ?? 'خطأ');
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={onClose}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: '#1e293b', direction: 'rtl' }}>
          {isNew ? '➕ إضافة طبيب' : '✏️ تعديل بيانات الطبيب'}
        </h3>
        {([['الاسم *','name'],['الاختصاص','specialty'],['المنطقة','areaName'],['الصيدلية المرتبطة','pharmacyName'],['الهاتف','phone']] as [string,string][]).map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <p style={{ fontSize: 11, color: '#94a3b8', margin: '10px 0 0', direction: 'rtl' }}>
          ⚠️ التعديل مشترك — سيظهر للجميع فور الحفظ
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={btnPrimary}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Edit Pharmacy Form ──
  function EditPharmacyModal({ pharma, onClose }: { pharma: SurveyPharmacy | null; onClose: () => void }) {
    const isNew = !pharma;
    const [form, setForm] = useState({
      name: pharma?.name ?? '', ownerName: pharma?.ownerName ?? '',
      phone: pharma?.phone ?? '', address: pharma?.address ?? '',
      areaName: pharma?.areaName ?? '', notes: pharma?.notes ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

    const save = async () => {
      if (!form.name.trim() || !selectedSurvey) return;
      setSaving(true);
      const url    = isNew ? `/api/master-surveys/${selectedSurvey.id}/pharmacies` : `/api/master-surveys/${selectedSurvey.id}/pharmacies/${pharma!.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await fetch(url, { method, headers: H(), body: JSON.stringify(form) });
      const d = await r.json();
      if (d.success) { showToast(isNew ? '✅ تم إضافة الصيدلية' : '✅ تم التعديل'); reloadSurvey(); onClose(); }
      else showToast(d.error ?? 'خطأ');
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={onClose}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: '#1e293b', direction: 'rtl' }}>
          {isNew ? '➕ إضافة صيدلية' : '✏️ تعديل بيانات الصيدلية'}
        </h3>
        {([['الاسم *','name'],['صاحب الصيدلية','ownerName'],['الهاتف','phone'],['العنوان','address'],['المنطقة','areaName']] as [string,string][]).map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <p style={{ fontSize: 11, color: '#94a3b8', margin: '10px 0 0', direction: 'rtl' }}>
          ⚠️ التعديل مشترك — سيظهر للجميع فور الحفظ
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={btnPrimary}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Survey List ──────────────────────────────────────────────
  if (!selectedSurvey) {
    return (
      <div style={{ padding: '0 0 80px', direction: 'rtl' }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1e293b' }}>🗂️ السيرفيات</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>قوائم الأطباء والصيدليات المشتركة من الإدارة</p>
        </div>

        {loading ? <Spinner /> : surveys.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: 60, color: '#94a3b8',
            background: '#f8fafc', borderRadius: 16, border: '1.5px dashed #e2e8f0',
          }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🗂️</div>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>لا توجد سيرفيات متاحة</p>
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>ستظهر هنا السيرفيات التي يُضيفها الماستر أدمن</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px,1fr))', gap: 14 }}>
            {surveys.map(s => (
              <button key={s.id} onClick={() => openSurvey(s.id)} style={{
                background: '#fff', border: '1.5px solid #e8edf5', borderRadius: 16,
                padding: '20px 18px', textAlign: 'right', cursor: 'pointer',
                boxShadow: '0 2px 12px rgba(0,0,0,0.05)', transition: 'all .2s',
                fontFamily: 'inherit',
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 28px rgba(139,26,26,0.15)'; (e.currentTarget as HTMLElement).style.borderColor = '#8B1A1A40'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.05)'; (e.currentTarget as HTMLElement).style.borderColor = '#e8edf5'; }}
              >
                <div style={{ fontSize: 16, fontWeight: 800, color: '#1e293b', marginBottom: 6 }}>{s.name}</div>
                {s.description && <p style={{ margin: '0 0 12px', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{s.description}</p>}
                <div style={{ display: 'flex', gap: 14 }}>
                  <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 700 }}>🩺 {s._count.doctors} طبيب</span>
                  <span style={{ fontSize: 13, color: '#f97316', fontWeight: 700 }}>🏪 {s._count.pharmacies} صيدلية</span>
                </div>
              </button>
            ))}
          </div>
        )}
        {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
      </div>
    );
  }

  // ── Survey Detail ────────────────────────────────────────────
  return (
    <div style={{ padding: '0 0 80px', direction: 'rtl' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={() => setSelectedSurvey(null)} style={btnBack}>← رجوع</button>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' }}>{selectedSurvey.name}</h2>
          {selectedSurvey.description && <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>{selectedSurvey.description}</p>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #f1f5f9', marginBottom: 20 }}>
        {[
          { id: 'doctors' as const,    label: `🩺 الأطباء (${selectedSurvey.doctors.length})` },
          { id: 'pharmacies' as const, label: `🏪 الصيدليات (${selectedSurvey.pharmacies.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 18px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'transparent', fontFamily: 'inherit',
            borderBottom: tab === t.id ? '2px solid #8B1A1A' : '2px solid transparent',
            color: tab === t.id ? '#8B1A1A' : '#64748b', marginBottom: -2, transition: 'all .15s',
          }}>{t.label}</button>
        ))}
        <div style={{ marginRight: 'auto', display: 'flex', gap: 8, paddingBottom: 4 }}>
          {tab === 'doctors' && (
            <button onClick={() => setAddingDoc(true)} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12 }}>
              ➕ إضافة طبيب
            </button>
          )}
          {tab === 'pharmacies' && (
            <button onClick={() => setAddingPharma(true)} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12 }}>
              ➕ إضافة صيدلية
            </button>
          )}
        </div>
      </div>

      {/* Doctors Table */}
      {tab === 'doctors' && (
        selectedSurvey.doctors.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8', background: '#f8fafc', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
            لا يوجد أطباء في هذا السيرفي بعد
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedSurvey.doctors.map(d => (
              <div key={d.id} style={{
                background: '#fff', border: '1.5px solid #f1f5f9', borderRadius: 14,
                padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: '#1e293b', marginBottom: 4 }}>{d.name}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {d.specialty    && <span style={infoChip}>{d.specialty}</span>}
                      {d.areaName     && <span style={infoChip}>📍 {d.areaName}</span>}
                      {d.pharmacyName && <span style={infoChip}>🏪 {d.pharmacyName}</span>}
                      {d.phone        && <span style={infoChip}>📞 {d.phone}</span>}
                    </div>
                    {d.notes && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{d.notes}</p>}
                    {d.lastEditedBy && (
                      <div style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>
                        ✏️ عُدِّل بواسطة: <strong>{d.lastEditedBy.displayName || d.lastEditedBy.username}</strong>
                        {d.lastEditedAt ? ` · ${new Date(d.lastEditedAt).toLocaleDateString('ar-IQ')}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setEditingDoc(d)} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 12 }}>✏️ تعديل</button>
                    <button onClick={() => importDoctor(d.id)} style={{ ...btnImport, padding: '6px 14px', fontSize: 12 }}>📥 استيراد لسجلاتي</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Pharmacies Table */}
      {tab === 'pharmacies' && (
        selectedSurvey.pharmacies.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8', background: '#f8fafc', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
            لا توجد صيدليات في هذا السيرفي بعد
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedSurvey.pharmacies.map(p => (
              <div key={p.id} style={{
                background: '#fff', border: '1.5px solid #f1f5f9', borderRadius: 14,
                padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: '#1e293b', marginBottom: 4 }}>{p.name}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {p.ownerName && <span style={infoChip}>👤 {p.ownerName}</span>}
                      {p.areaName  && <span style={infoChip}>📍 {p.areaName}</span>}
                      {p.phone     && <span style={infoChip}>📞 {p.phone}</span>}
                      {p.address   && <span style={infoChip}>🏠 {p.address}</span>}
                    </div>
                    {p.notes && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{p.notes}</p>}
                    {p.lastEditedBy && (
                      <div style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>
                        ✏️ عُدِّل بواسطة: <strong>{p.lastEditedBy.displayName || p.lastEditedBy.username}</strong>
                        {p.lastEditedAt ? ` · ${new Date(p.lastEditedAt).toLocaleDateString('ar-IQ')}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setEditingPharma(p)} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 12 }}>✏️ تعديل</button>
                    <button onClick={() => importPharmacy(p.id)} style={{ ...btnImport, padding: '6px 14px', fontSize: 12 }}>📥 استيراد لسجلاتي</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Modals */}
      {(editingDoc || addingDoc)    && <EditDoctorModal   doc={editingDoc}    onClose={() => { setEditingDoc(null);    setAddingDoc(false); }} />}
      {(editingPharma || addingPharma) && <EditPharmacyModal pharma={editingPharma} onClose={() => { setEditingPharma(null); setAddingPharma(false); }} />}
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f0',
  borderRadius: 9, fontSize: 13, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', direction: 'rtl',
};
const btnPrimary: React.CSSProperties = {
  background: 'linear-gradient(135deg,#8B1A1A,#6B1414)', color: '#fff',
  border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 700,
  fontSize: 13, padding: '10px 20px', fontFamily: 'inherit',
};
const btnSecondary: React.CSSProperties = {
  background: '#f1f5f9', color: '#374151', border: '1.5px solid #e2e8f0',
  borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '10px 20px', fontFamily: 'inherit',
};
const btnImport: React.CSSProperties = {
  background: '#f0fdf4', color: '#15803d', border: '1.5px solid #bbf7d0',
  borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
  padding: '10px 20px', fontFamily: 'inherit',
};
const btnBack: React.CSSProperties = {
  background: '#f1f5f9', color: '#374151', border: '1.5px solid #e2e8f0',
  borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '8px 14px', fontFamily: 'inherit', flexShrink: 0,
};
const infoChip: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #e2e8f0',
  borderRadius: 20, padding: '3px 10px', fontSize: 12, color: '#475569', fontWeight: 500,
};
