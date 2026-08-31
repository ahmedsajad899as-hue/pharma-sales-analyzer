import { useState, useEffect, useCallback, useRef } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';
import { Icon } from '../config/icons';

// ── Types ────────────────────────────────────────────────────
interface Survey {
  id: number; name: string; description?: string; surveyType: string;
  _count: { doctors: number; pharmacies: number; drugEntries?: number };
}
interface SurveyDoctor {
  id: number; name: string; specialty?: string; areaName?: string;
  pharmacyName?: string; className?: string; phone?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface SurveyPharmacy {
  id: number; name: string; ownerName?: string; phone?: string;
  address?: string; areaName?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface DrugEntry {
  id: number; surveyId: number;
  brandName: string; scientificName?: string; company?: string; dosageForm?: string; packaging?: string | null;
  priceOfficeToWholesaler?: number | null;
  priceWholesalerToPharmacy?: number | null;
  pricePharmacyToPatient?: number | null;
  notes?: string;
}
interface SurveyDetail extends Survey {
  doctors: SurveyDoctor[];
  pharmacies: SurveyPharmacy[];
  userAreaNames?: string[];
}

// ── Helpers ──────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--c-border)', borderTopColor: 'var(--c-accent)', animation: 'surveySpins .6s linear infinite' }} />
      <style>{`@keyframes surveySpins{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Toast({ msg, onClose }: { msg: React.ReactNode; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 2500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--c-text-primary)', color: '#fff', padding: '12px 24px', borderRadius: 24,
      fontSize: 14, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
      direction: 'rtl', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
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
        background: 'var(--c-surface)', borderRadius: 18, padding: 24, width: '100%', maxWidth: 500,
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
  const isCompanyManager = user?.role === 'company_manager';

  const [surveys,        setSurveys]        = useState<Survey[]>([]);
  const [selectedSurvey, setSelectedSurvey] = useState<SurveyDetail | null>(null);
  const [tab,            setTab]            = useState<'doctors' | 'pharmacies' | 'drug_prices'>('doctors');
  const [loading,        setLoading]        = useState(true);
  const [toast,          setToast]          = useState<React.ReactNode | null>(null);

  // Rep selector (for company_manager)
  const [reps,          setReps]          = useState<{ userId: number; name: string; linkedRepId: number }[]>([]);
  const [selectedRepId, setSelectedRepId] = useState<number | null>(null); // linkedRepId (ScientificRepresentative.id)

  // Edit modal state
  const [editingDoc,     setEditingDoc]     = useState<SurveyDoctor | null>(null);
  const [editingPharma,  setEditingPharma]  = useState<SurveyPharmacy | null>(null);
  const [addingDoc,      setAddingDoc]      = useState(false);
  const [addingPharma,   setAddingPharma]   = useState(false);

  // Drug entries state
  const [drugEntries,        setDrugEntries]        = useState<DrugEntry[]>([]);
  const [drugEntriesTotal,   setDrugEntriesTotal]   = useState(0);
  const [drugEntriesPage,    setDrugEntriesPage]    = useState(1);
  const [drugEntriesPages,   setDrugEntriesPages]   = useState(1);
  const [drugEntriesLoading, setDrugEntriesLoading] = useState(false);
  const [drugSearch,         setDrugSearch]         = useState('');
  const drugSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Back button: close open modals in priority order
  useBackHandler([
    [editingDoc !== null,    () => setEditingDoc(null)],
    [editingPharma !== null, () => setEditingPharma(null)],
    [addingDoc,              () => setAddingDoc(false)],
    [addingPharma,           () => setAddingPharma(false)],
    [selectedSurvey !== null, () => setSelectedSurvey(null)],
  ]);

  const showToast = (msg: React.ReactNode) => setToast(msg);

  // ── Fetch drug entries ──
  const loadDrugEntries = useCallback(async (id: number, search = '', page = 1) => {
    setDrugEntriesLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '100' });
      if (search.trim()) qs.set('search', search.trim());
      const r = await fetch(`/api/master-surveys/${id}/drug-entries?${qs}`, { headers: H() });
      const d = await r.json();
      if (d.success) {
        setDrugEntries(d.data);
        setDrugEntriesTotal(d.total ?? 0);
        setDrugEntriesPage(d.page ?? 1);
        setDrugEntriesPages(d.pages ?? 1);
      }
    } finally { setDrugEntriesLoading(false); }
  }, [H]);

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

  // ── Fetch reps for company_manager ──
  useEffect(() => {
    if (!isCompanyManager) return;
    fetch('/api/company-members', { headers: H() })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const scientificReps = d.data
            .filter((m: any) => m.role === 'scientific_rep' && m.linkedRepId)
            .map((m: any) => ({ userId: m.id, name: m.linkedRep?.name || m.username, linkedRepId: m.linkedRepId }));
          setReps(scientificReps);
        }
      });
  }, [isCompanyManager, H]);

  const repParam = selectedRepId ? `?repId=${selectedRepId}` : '';

  const openSurvey = async (id: number) => {
    const r = await fetch(`/api/master-surveys/${id}${repParam}`, { headers: H() });
    const d = await r.json();
    if (d.success) {
      setSelectedSurvey(d.data);
      const isDrug = d.data.surveyType === 'drug_prices';
      setTab(isDrug ? 'drug_prices' : 'doctors');
      if (isDrug) { setDrugSearch(''); setDrugEntriesPage(1); loadDrugEntries(id, '', 1); }
    }
  };

  const reloadSurvey = async () => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}${repParam}`, { headers: H() });
    const d = await r.json();
    if (d.success) setSelectedSurvey(d.data);
  };

  // When rep selection changes, reload the current survey
  const handleRepChange = async (repId: number | null) => {
    setSelectedRepId(repId);
    if (!selectedSurvey) return;
    const param = repId ? `?repId=${repId}` : '';
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}${param}`, { headers: H() });
    const d = await r.json();
    if (d.success) setSelectedSurvey(d.data);
  };

  // ── Import helpers ──
  const [importingAll, setImportingAll] = useState(false);

  const importAllDoctors = async () => {
    if (!selectedSurvey) return;
    setImportingAll(true);
    try {
      const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/doctors/import-all${repParam}`, { method: 'POST', headers: H() });
      const d = await r.json();
      showToast(d.success ? <><Icon name="checkCircle" size={14} /> {d.message}</> : <><Icon name="close" size={14} /> {d.error ?? 'خطأ'}</>);
    } catch {
      showToast(<><Icon name="close" size={14} /> حدث خطأ أثناء الاستيراد</>);
    } finally { setImportingAll(false); }
  };

  const [importingAllPharm, setImportingAllPharm] = useState(false);

  const importAllPharmacies = async () => {
    if (!selectedSurvey) return;
    setImportingAllPharm(true);
    try {
      const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/pharmacies/import-all${repParam}`, { method: 'POST', headers: H() });
      const d = await r.json();
      showToast(d.success ? <><Icon name="checkCircle" size={14} /> {d.message}</> : <><Icon name="close" size={14} /> {d.error ?? 'خطأ'}</>);
    } catch {
      showToast(<><Icon name="close" size={14} /> حدث خطأ أثناء الاستيراد</>);
    } finally { setImportingAllPharm(false); }
  };

  const importDoctor = async (docId: number) => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/doctors/${docId}/import${repParam}`, { method: 'POST', headers: H() });
    const d = await r.json();
    showToast(d.success ? <><Icon name="checkCircle" size={14} /> {d.message || 'أُضيف الطبيب لقائمة أطبائك'}</> : <><Icon name="close" size={14} /> {d.error ?? 'خطأ'}</>);
  };

  const importPharmacy = async (pharmaId: number) => {
    if (!selectedSurvey) return;
    const r = await fetch(`/api/master-surveys/${selectedSurvey.id}/pharmacies/${pharmaId}/import${repParam}`, { method: 'POST', headers: H() });
    const d = await r.json();
    showToast(d.success ? <><Icon name="checkCircle" size={14} /> {d.message || 'أُضيفت الصيدلية لقائمتك'}</> : <><Icon name="close" size={14} /> {d.error ?? 'خطأ'}</>);
  };

  // ── Edit Doctor Form ──
  function EditDoctorModal({ doc, onClose }: { doc: SurveyDoctor | null; onClose: () => void }) {
    const isNew = !doc;
    const [form, setForm] = useState({
      name: doc?.name ?? '', specialty: doc?.specialty ?? '',
      areaName: doc?.areaName ?? '', pharmacyName: doc?.pharmacyName ?? '',
      className: doc?.className ?? '', phone: doc?.phone ?? '', notes: doc?.notes ?? '',
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
      if (d.success) { showToast(<><Icon name="checkCircle" size={14} /> {isNew ? 'تم إضافة الطبيب' : 'تم التعديل'}</>); reloadSurvey(); onClose(); }
      else showToast(d.error ?? 'خطأ');
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={onClose}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: 'var(--c-text-primary)', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 8 }}>
          {isNew ? <><Icon name="add" size={18} /> إضافة طبيب</> : <><Icon name="edit" size={16} /> تعديل بيانات الطبيب</>}
        </h3>
        {([['الاسم *','name'],['الاختصاص','specialty'],['المنطقة','areaName'],['الصيدلية المرتبطة','pharmacyName'],['الكلاس','className'],['الهاتف','phone']] as [string,string][]).map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-secondary)', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-secondary)', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <p style={{ fontSize: 11, color: 'var(--c-text-muted)', margin: '10px 0 0', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="warning" size={12} /> التعديل مشترك — سيظهر للجميع فور الحفظ
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving ? 'جاري الحفظ...' : <><Icon name="check" size={14} /> حفظ</>}
          </button>
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
      if (d.success) { showToast(<><Icon name="checkCircle" size={14} /> {isNew ? 'تم إضافة الصيدلية' : 'تم التعديل'}</>); reloadSurvey(); onClose(); }
      else showToast(d.error ?? 'خطأ');
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={onClose}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: 'var(--c-text-primary)', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 8 }}>
          {isNew ? <><Icon name="add" size={18} /> إضافة صيدلية</> : <><Icon name="edit" size={16} /> تعديل بيانات الصيدلية</>}
        </h3>
        {([['الاسم *','name'],['صاحب الصيدلية','ownerName'],['الهاتف','phone'],['العنوان','address'],['المنطقة','areaName']] as [string,string][]).map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-secondary)', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-secondary)', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <p style={{ fontSize: 11, color: 'var(--c-text-muted)', margin: '10px 0 0', direction: 'rtl', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="warning" size={12} /> التعديل مشترك — سيظهر للجميع فور الحفظ
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving ? 'جاري الحفظ...' : <><Icon name="check" size={14} /> حفظ</>}
          </button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Survey List ──────────────────────────────────────────────
  if (!selectedSurvey) {
    return (
      <div style={{ padding: '0 0 80px', direction: 'rtl' }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--c-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="navMasterSurvey" size={20} /> السيرفيات</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--c-text-secondary)' }}>قوائم الأطباء والصيدليات المشتركة من الإدارة</p>
        </div>

        {loading ? <Spinner /> : surveys.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: 60, color: 'var(--c-text-muted)',
            background: 'var(--c-bg)', borderRadius: 16, border: '1.5px dashed var(--c-border)',
          }}>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}><Icon name="navMasterSurvey" size={40} /></div>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>لا توجد سيرفيات متاحة</p>
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>ستظهر هنا السيرفيات التي يُضيفها الماستر أدمن</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px,1fr))', gap: 14 }}>
            {surveys.map(s => (
              <button key={s.id} onClick={() => openSurvey(s.id)} style={{
                background: 'var(--c-surface)', border: '1.5px solid var(--c-border-light)', borderRadius: 16,
                padding: '20px 18px', textAlign: 'right', cursor: 'pointer',
                boxShadow: '0 2px 12px rgba(0,0,0,0.05)', transition: 'all .2s',
                fontFamily: 'inherit',
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 28px rgba(26,86,219,0.15)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(26,86,219,0.35)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.05)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--c-border-light)'; }}
              >
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--c-text-primary)', marginBottom: 6 }}>{s.name}</div>
                {s.description && <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--c-text-secondary)', lineHeight: 1.5 }}>{s.description}</p>}
                <div style={{ display: 'flex', gap: 14 }}>
                  {s.surveyType === 'drug_prices'
                    ? <span style={{ fontSize: 13, color: 'var(--c-success)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="drug" size={15} /> {(s._count.drugEntries ?? 0).toLocaleString('ar-IQ')} دواء</span>
                    : <>
                        <span style={{ fontSize: 13, color: 'var(--c-accent)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="doctor" size={15} /> {s._count.doctors} طبيب</span>
                        <span style={{ fontSize: 13, color: '#f97316', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="pharmacy" size={15} /> {s._count.pharmacies} صيدلية</span>
                      </>
                  }
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: selectedSurvey.userAreaNames?.length ? 12 : 20 }}>
        <button onClick={() => setSelectedSurvey(null)} style={{ ...btnBack, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="chevronLeft" size={14} /> رجوع</button>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--c-text-primary)' }}>{selectedSurvey.name}</h2>
          {selectedSurvey.description && <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-secondary)' }}>{selectedSurvey.description}</p>}
        </div>
      </div>

      {/* Assigned Areas Banner */}
      {selectedSurvey.userAreaNames && selectedSurvey.userAreaNames.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
          background: 'var(--c-accent-light)', border: '1.5px solid rgba(26,86,219,0.25)', borderRadius: 12,
          padding: '10px 14px', marginBottom: 20, direction: 'rtl',
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-accent)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="location" size={13} /> مناطقك المحددة:</span>
          {selectedSurvey.userAreaNames.map(area => (
            <span key={area} className="tag tag--blue">{area}</span>
          ))}
        </div>
      )}

      {/* Rep Selector (company_manager only, only for non-drug-prices surveys) */}
      {isCompanyManager && reps.length > 0 && selectedSurvey.surveyType !== 'drug_prices' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--c-warning-bg)', border: '1.5px solid var(--c-warning-border)', borderRadius: 12,
          padding: '10px 14px', marginBottom: 20, direction: 'rtl',
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-warning)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="person" size={13} /> استيراد لحساب:</span>
          <select
            value={selectedRepId ?? ''}
            onChange={e => handleRepChange(e.target.value ? Number(e.target.value) : null)}
            style={{
              flex: 1, border: '1.5px solid var(--c-warning-border)', borderRadius: 8, padding: '6px 10px',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: 'var(--c-surface)',
              color: 'var(--c-text-primary)', cursor: 'pointer', direction: 'rtl',
            }}
          >
            <option value="">— لحسابي (مدير الشركة) —</option>
            {reps.map(r => (
              <option key={r.linkedRepId} value={r.linkedRepId}>{r.name}</option>
            ))}
          </select>
          {selectedRepId && (
            <span style={{ fontSize: 11, color: 'var(--c-warning)', whiteSpace: 'nowrap' }}>
              الأطباء المعروضون مفلتَرون بمناطق المندوب
            </span>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--c-border-light)', marginBottom: 20 }}>
        {selectedSurvey.surveyType === 'drug_prices' ? (
          <button style={{
            padding: '10px 18px', border: 'none', cursor: 'default', fontWeight: 700, fontSize: 13,
            background: 'transparent', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
            borderBottom: '2px solid var(--c-success)', color: 'var(--c-success)', marginBottom: -2,
          }}><Icon name="drug" size={15} /> أسعار الأدوية ({drugEntriesTotal.toLocaleString('ar-IQ')})</button>
        ) : ([
          { id: 'doctors' as const,    icon: 'doctor' as const,   label: `الأطباء (${selectedSurvey.doctors.length})` },
          { id: 'pharmacies' as const, icon: 'pharmacy' as const, label: `الصيدليات (${selectedSurvey.pharmacies.length})` },
        ]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)} style={{
            padding: '10px 18px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'transparent', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
            borderBottom: tab === t.id ? '2px solid var(--c-accent)' : '2px solid transparent',
            color: tab === t.id ? 'var(--c-accent)' : 'var(--c-text-secondary)', marginBottom: -2, transition: 'all .15s',
          }}><Icon name={t.icon} size={15} /> {t.label}</button>
        ))}
        <div style={{ marginRight: 'auto', display: 'flex', gap: 8, paddingBottom: 4 }}>
          {tab === 'doctors' && (
            <>
              <button
                onClick={importAllDoctors}
                disabled={importingAll || selectedSurvey.doctors.length === 0}
                style={{ ...btnImport, padding: '7px 14px', fontSize: 12, opacity: importingAll ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 5 }}
              >
                {importingAll ? 'جاري...' : <><Icon name="import" size={14} /> استيرد الكل</>}
              </button>
              <button onClick={() => setAddingDoc(true)} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Icon name="add" size={14} /> إضافة طبيب
              </button>
            </>
          )}
          {tab === 'pharmacies' && (
            <>
              <button
                onClick={importAllPharmacies}
                disabled={importingAllPharm || selectedSurvey.pharmacies.length === 0}
                style={{ ...btnImport, padding: '7px 14px', fontSize: 12, opacity: importingAllPharm ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 5 }}
              >
                {importingAllPharm ? 'جاري...' : <><Icon name="import" size={14} /> استيرد الكل</>}
              </button>
              <button onClick={() => setAddingPharma(true)} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Icon name="add" size={14} /> إضافة صيدلية
              </button>
            </>
          )}
          {tab === 'drug_prices' && (
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', top: '50%', right: 10, transform: 'translateY(-50%)', display: 'flex', color: 'var(--c-text-muted)', pointerEvents: 'none' }}>
                <Icon name="search" size={13} />
              </span>
              <input
                placeholder="ابحث عن دواء..."
                value={drugSearch}
                onChange={e => {
                  const v = e.target.value;
                  setDrugSearch(v);
                  if (drugSearchTimer.current) clearTimeout(drugSearchTimer.current);
                  drugSearchTimer.current = setTimeout(() => {
                    setDrugEntriesPage(1);
                    loadDrugEntries(selectedSurvey.id, v, 1);
                  }, 350);
                }}
                style={{ ...inputStyleInline, paddingRight: 30 }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Doctors Table */}
      {tab === 'doctors' && (
        selectedSurvey.doctors.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--c-text-muted)', background: 'var(--c-bg)', borderRadius: 14, border: '1.5px dashed var(--c-border)' }}>
            لا يوجد أطباء في هذا السيرفي بعد
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedSurvey.doctors.map(d => (
              <div key={d.id} style={{
                background: 'var(--c-surface)', border: '1.5px solid var(--c-border-light)', borderRadius: 14,
                padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--c-text-primary)', marginBottom: 4 }}>{d.name}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {d.specialty    && <span style={infoChip}>{d.specialty}</span>}
                      {d.areaName     && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="location" size={12} /> {d.areaName}</span>}
                      {d.pharmacyName && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="pharmacy" size={12} /> {d.pharmacyName}</span>}
                      {d.className    && <span style={{ ...infoChip, background: 'var(--c-warning-bg)', color: 'var(--c-warning)', fontWeight: 700, border: '1px solid var(--c-warning-border)' }}>{d.className}</span>}
                      {d.phone        && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="call" size={12} /> {d.phone}</span>}
                    </div>
                    {d.notes && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--c-text-secondary)', lineHeight: 1.5 }}>{d.notes}</p>}
                    {d.lastEditedBy && (
                      <div style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="edit" size={11} /> عُدِّل بواسطة: <strong>{d.lastEditedBy.displayName || d.lastEditedBy.username}</strong>
                        {d.lastEditedAt ? ` · ${new Date(d.lastEditedAt).toLocaleDateString('ar-IQ')}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setEditingDoc(d)} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="edit" size={13} /> تعديل</button>
                    <button onClick={() => importDoctor(d.id)} style={{ ...btnImport, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="import" size={13} /> استيراد لسجلاتي</button>
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
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--c-text-muted)', background: 'var(--c-bg)', borderRadius: 14, border: '1.5px dashed var(--c-border)' }}>
            لا توجد صيدليات في هذا السيرفي بعد
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedSurvey.pharmacies.map(p => (
              <div key={p.id} style={{
                background: 'var(--c-surface)', border: '1.5px solid var(--c-border-light)', borderRadius: 14,
                padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--c-text-primary)', marginBottom: 4 }}>{p.name}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {p.ownerName && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="person" size={12} /> {p.ownerName}</span>}
                      {p.areaName  && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="location" size={12} /> {p.areaName}</span>}
                      {p.phone     && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="call" size={12} /> {p.phone}</span>}
                      {p.address   && <span style={{ ...infoChip, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="home" size={12} /> {p.address}</span>}
                    </div>
                    {p.notes && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--c-text-secondary)', lineHeight: 1.5 }}>{p.notes}</p>}
                    {p.lastEditedBy && (
                      <div style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="edit" size={11} /> عُدِّل بواسطة: <strong>{p.lastEditedBy.displayName || p.lastEditedBy.username}</strong>
                        {p.lastEditedAt ? ` · ${new Date(p.lastEditedAt).toLocaleDateString('ar-IQ')}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setEditingPharma(p)} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="edit" size={13} /> تعديل</button>
                    <button onClick={() => importPharmacy(p.id)} style={{ ...btnImport, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="import" size={13} /> استيراد لسجلاتي</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Drug Prices Table */}
      {tab === 'drug_prices' && (
        drugEntriesLoading ? <Spinner /> : drugEntries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--c-text-muted)', background: 'var(--c-bg)', borderRadius: 14, border: '1.5px dashed var(--c-border)' }}>
            {drugSearch ? `لا توجد نتائج لـ “${drugSearch}”` : 'لا توجد بيانات أسعار بعد'}
          </div>
        ) : (
          <>
            {/* pagination */}
            {drugEntriesPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, fontSize: 12, color: 'var(--c-text-secondary)' }}>
                <span>{drugEntriesTotal.toLocaleString('ar-IQ')} دواء إجمالاً</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button disabled={drugEntriesPage <= 1} onClick={() => { const p = drugEntriesPage - 1; loadDrugEntries(selectedSurvey.id, drugSearch, p); }}
                    style={{ ...btnSecondary, padding: '4px 10px', fontSize: 12, opacity: drugEntriesPage <= 1 ? 0.4 : 1, display: 'flex', alignItems: 'center' }}><Icon name="chevronLeft" size={13} /></button>
                  <span style={{ fontWeight: 600, color: 'var(--c-text-primary)' }}>{drugEntriesPage} / {drugEntriesPages}</span>
                  <button disabled={drugEntriesPage >= drugEntriesPages} onClick={() => { const p = drugEntriesPage + 1; loadDrugEntries(selectedSurvey.id, drugSearch, p); }}
                    style={{ ...btnSecondary, padding: '4px 10px', fontSize: 12, opacity: drugEntriesPage >= drugEntriesPages ? 0.4 : 1, display: 'flex', alignItems: 'center' }}><Icon name="chevronRight" size={13} /></button>
                </div>
              </div>
            )}
            <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid var(--c-border-light)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--c-bg)' }}>
                    {['الاسم التجاري','الاسم العلمي','الشكل','التعبئة','الشركة','سعر المكتب→مذخر','سعر مذخر→صيدلية','سعر صيدلية→مريض','ملاحظات'].map(h => {
                      const parts = h.split('→');
                      return (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--c-text-primary)', borderBottom: '2px solid var(--c-border-light)', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {parts.length === 2
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>{parts[0]}<Icon name="chevronRight" size={11} />{parts[1]}</span>
                            : h}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {drugEntries.map((e, i) => (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--c-border-light)', background: i % 2 === 0 ? 'var(--c-surface)' : 'var(--c-bg)' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: 'var(--c-text-primary)' }}>{e.brandName}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-accent)', fontSize: 12 }}>{e.scientificName || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-text-secondary)' }}>{e.dosageForm || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-text-secondary)' }}>{e.packaging || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-text-secondary)' }}>{e.company || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-success)', fontWeight: 600 }}>
                        {e.priceOfficeToWholesaler != null ? Number(e.priceOfficeToWholesaler).toFixed(3) : <span style={{ color: 'var(--c-text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-warning)', fontWeight: 600 }}>
                        {e.priceWholesalerToPharmacy != null ? Number(e.priceWholesalerToPharmacy).toFixed(3) : <span style={{ color: 'var(--c-text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-danger)', fontWeight: 600 }}>
                        {e.pricePharmacyToPatient != null ? Number(e.pricePharmacyToPatient).toFixed(3) : <span style={{ color: 'var(--c-text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--c-text-muted)', fontSize: 12, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
  width: '100%', padding: '9px 12px', border: '1.5px solid var(--c-border)',
  borderRadius: 9, fontSize: 13, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', direction: 'rtl',
};
const inputStyleInline: React.CSSProperties = {
  padding: '7px 12px', border: '1.5px solid var(--c-border)',
  borderRadius: 9, fontSize: 13, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', direction: 'rtl', width: 200,
};
const btnPrimary: React.CSSProperties = {
  background: 'linear-gradient(135deg,var(--c-accent),var(--c-accent-hover))', color: '#fff',
  border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 700,
  fontSize: 13, padding: '10px 20px', fontFamily: 'inherit',
};
const btnSecondary: React.CSSProperties = {
  background: 'var(--c-bg)', color: 'var(--c-text-primary)', border: '1.5px solid var(--c-border)',
  borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '10px 20px', fontFamily: 'inherit',
};
const btnImport: React.CSSProperties = {
  background: 'var(--c-success-bg)', color: 'var(--c-success)', border: '1.5px solid var(--c-success-border)',
  borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
  padding: '10px 20px', fontFamily: 'inherit',
};
const btnBack: React.CSSProperties = {
  background: 'var(--c-bg)', color: 'var(--c-text-primary)', border: '1.5px solid var(--c-border)',
  borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '8px 14px', fontFamily: 'inherit', flexShrink: 0,
};
const infoChip: React.CSSProperties = {
  background: 'var(--c-bg)', border: '1px solid var(--c-border)',
  borderRadius: 20, padding: '3px 10px', fontSize: 12, color: 'var(--c-text-secondary)', fontWeight: 500,
};
