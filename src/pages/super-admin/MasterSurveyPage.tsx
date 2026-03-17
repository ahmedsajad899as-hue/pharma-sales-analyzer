import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { parseExcelFile } from '../../services/excelParser';

// ── Types ────────────────────────────────────────────────────
interface DocImportRow { name: string; specialty: string; areaName: string; pharmacyName: string; className: string; zoneName: string; phone: string; notes: string; }
interface PharmaImportRow { name: string; ownerName: string; pharmacyName: string; phone: string; address: string; areaName: string; notes: string; }
interface Survey {
  id: number; name: string; description?: string; isActive: boolean;
  createdAt: string;
  _count?: { doctors: number; pharmacies: number };
}
interface SurveyDoctor {
  id: number; surveyId: number; name: string; specialty?: string; areaName?: string;
  pharmacyName?: string; className?: string; zoneName?: string; phone?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface SurveyPharmacy {
  id: number; surveyId: number; name: string; ownerName?: string; pharmacyName?: string; phone?: string;
  address?: string; areaName?: string; notes?: string;
  lastEditedAt?: string; lastEditedBy?: { username: string; displayName?: string };
}
interface VisibilityUser {
  id: number; username: string; displayName?: string; role: string; officeId?: number; hidden: boolean;
}
interface VisibilityOffice { id: number; name: string; hidden: boolean; }
interface EditLog {
  id: number; entryType: string; entryId: number; action: string;
  oldData?: string; newData?: string; editedAt: string;
  editedBy?: { username: string; displayName?: string };
}

// ── Smart Excel column detection ──────────────────────────────
type DocField   = keyof DocImportRow;
type PharmaField = keyof PharmaImportRow;

const DOC_FIELD_KEYWORDS: Array<[DocField, string[]]> = [
  ['name',         ['اسم الطبيب','الطبيب','الدكتور','الاسم الكامل','الاسم','اسم الدكتور','doctor','name','physician']],
  ['specialty',    ['الاختصاص','التخصص','تخصص','اختصاص','specialty','speciality','speciality_1','spec']],
  ['areaName',     ['المنطقه','منطقه','اسم المنطقه','الحي','حي','zone','sector','zone name','zone_name']],
  ['pharmacyName', ['اسم الصيدليه','اسم الصيدلية','الصيدليه','الصيدلية','صيدليه','صيدلية','اسم الدكان','الدكان','دكان','pharmacy name','pharmacy_name','pharmacyname','pharmacy','pharmcy','pharmc','clinic']],
  ['className',    ['الكلاس','كلاس','التصنيف','تصنيف','الفئه','فئه','class','classification','cat','category']],
  ['zoneName',     ['الزون','زون','القطاع','قطاع','منطقه فرعيه','area','region','area name']],
  ['phone',        ['الهاتف','رقم الهاتف','الجوال','رقم الجوال','موبايل','جوال','هاتف','تلفون','phone','mobile','tel','phone number','mobile number']],
  ['notes',        ['ملاحظات','ملاحظه','تعليق','تعليقات','notes','note','remarks']],
];
const PHARMA_FIELD_KEYWORDS: Array<[PharmaField, string[]]> = [
  ['name',         ['اسم الصيدلية','اسم الدكان','الصيدلية','صيدلية','الدكان','دكان','الاسم الكامل','الاسم','اسم','pharmacy name','pharmacy_name','pharmacyname','pharmacy','name']],
  ['ownerName',    ['صاحب الصيدلية','صاحب الدكان','المالك','صاحب','المدير','مدير','owner','ownername','owner name']],
  ['pharmacyName', ['الفرع','فرع','الماركة','ماركة','السلسلة','chain','brand','branch']],
  ['phone',        ['الهاتف','رقم الهاتف','الجوال','رقم الجوال','موبايل','جوال','هاتف','تلفون','phone','mobile','tel','phone number','mobile number']],
  ['address',      ['العنوان','عنوان','الموقع','address','location','street']],
  ['areaName',     ['المنطقة','المنطقه','منطقة','اسم المنطقة','area','region','area name']],
  ['notes',        ['ملاحظات','ملاحظه','تعليق','تعليقات','notes','note','remarks']],
];

function normalizeHdr(h: string): string {
  return h.trim().toLowerCase()
    .replace(/[_\-]/g, ' ')        // underscore/dash → space
    .replace(/\s+/g, ' ')          // collapse spaces
    .replace(/ة/g, 'ه')            // normalize ة → ه (Arabic taa marbuta)
    .replace(/[\u064B-\u065F]/g,''); // strip Arabic diacritics
}
function detectDocField(header: string): DocField | null {
  const h = normalizeHdr(header);
  for (const [field, kws] of DOC_FIELD_KEYWORDS) {
    for (const kw of kws) {
      const nkw = normalizeHdr(kw);
      if (h === nkw || h.includes(nkw) || nkw.includes(h)) return field;
    }
  }
  return null;
}
function detectPharmaField(header: string): PharmaField | null {
  const h = normalizeHdr(header);
  for (const [field, kws] of PHARMA_FIELD_KEYWORDS) {
    for (const kw of kws) {
      const nkw = normalizeHdr(kw);
      if (h === nkw || h.includes(nkw) || nkw.includes(h)) return field;
    }
  }
  return null;
}
function buildDocHeaderMap(row: Record<string,unknown>): Record<string, DocField> {
  const map: Record<string, DocField> = {};
  const used = new Set<DocField>();
  for (const header of Object.keys(row)) {
    const field = detectDocField(header);
    if (field && !used.has(field)) { map[header] = field; used.add(field); }
  }
  return map;
}
function buildPharmaHeaderMap(row: Record<string,unknown>): Record<string, PharmaField> {
  const map: Record<string, PharmaField> = {};
  const used = new Set<PharmaField>();
  for (const header of Object.keys(row)) {
    const field = detectPharmaField(header);
    if (field && !used.has(field)) { map[header] = field; used.add(field); }
  }
  return map;
}
function smartMapDocRow(row: Record<string,unknown>, headerMap: Record<string, DocField>): DocImportRow {
  const r: DocImportRow = { name:'', specialty:'', areaName:'', pharmacyName:'', className:'', zoneName:'', phone:'', notes:'' };
  for (const [header, field] of Object.entries(headerMap)) {
    const v = row[header];
    if (v != null && v !== '') r[field] = String(v).trim();
  }
  return r;
}
function smartMapPharmaRow(row: Record<string,unknown>, headerMap: Record<string, PharmaField>): PharmaImportRow {
  const r: PharmaImportRow = { name:'', ownerName:'', pharmacyName:'', phone:'', address:'', areaName:'', notes:'' };
  for (const [header, field] of Object.entries(headerMap)) {
    const v = row[header];
    if (v != null && v !== '') r[field] = String(v).trim();
  }
  return r;
}
function downloadTemplate(type: 'doctors' | 'pharmacies') {
  const [headers, example] = type === 'doctors'
    ? [['اسم الطبيب','الاختصاص','المنطقة','اسم الصيدلية','الكلاس','الزون','الهاتف','ملاحظات'], ['د. أحمد محمد','قلبية','الكرخ','صيدلية النور','A','Z1','07701234567','']]
    : [['اسم الصيدلية','صاحب الصيدلية','الصيدلية','الهاتف','العنوان','المنطقة','ملاحظات'], ['صيدلية النور','أحمد علي','مجموعة الرافدين','07701234567','شارع السعدون','الرصافة','']];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, example]), type === 'doctors' ? 'أطباء' : 'صيدليات');
  XLSX.writeFile(wb, type === 'doctors' ? 'نموذج_أطباء.xlsx' : 'نموذج_صيدليات.xlsx');
}

// ── Small helpers ─────────────────────────────────────────────
const actionColor: Record<string,string> = { create: '#10b981', update: '#f59e0b', delete: '#ef4444' };
const actionLabel: Record<string,string> = { create: 'أضاف', update: 'عدّل', delete: 'حذف' };

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      background: `${color}18`, color, border: `1px solid ${color}40`,
      borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700,
    }}>{text}</span>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid #e2e8f0', borderTopColor: '#6366f1', animation: 'spin .6s linear infinite' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 500,
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────
export default function MasterSurveyPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [surveys,        setSurveys]        = useState<Survey[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [apiError,       setApiError]       = useState<string | null>(null);
  const [selectedSurvey, setSelectedSurvey] = useState<(Survey & { doctors: SurveyDoctor[]; pharmacies: SurveyPharmacy[] }) | null>(null);
  const [tab,            setTab]            = useState<'doctors' | 'pharmacies' | 'visibility' | 'logs'>('doctors');

  // modals
  const [showSurveyForm,   setShowSurveyForm]   = useState(false);
  const [editingSurvey,    setEditingSurvey]     = useState<Survey | null>(null);
  const [showDocForm,      setShowDocForm]       = useState(false);
  const [editingDoc,       setEditingDoc]        = useState<SurveyDoctor | null>(null);
  const [showPharmaForm,   setShowPharmaForm]    = useState(false);
  const [editingPharma,    setEditingPharma]     = useState<SurveyPharmacy | null>(null);

  // visibility
  const [visUsers,   setVisUsers]   = useState<VisibilityUser[]>([]);
  const [visOffices, setVisOffices] = useState<VisibilityOffice[]>([]);
  const [visLoading, setVisLoading] = useState(false);

  // logs
  const [logs,       setLogs]       = useState<EditLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // excel import
  const [importDoctorsPreview, setImportDoctorsPreview] = useState<DocImportRow[]>([]);
  const [showDoctorsImport,    setShowDoctorsImport]    = useState(false);
  const [importPharmasPreview, setImportPharmasPreview] = useState<PharmaImportRow[]>([]);
  const [showPharmasImport,    setShowPharmasImport]    = useState(false);
  const [importing,            setImporting]            = useState(false);
  const [detectedDocMapping,   setDetectedDocMapping]   = useState<Record<string,string>>({});
  const [detectedPharmaMapping,setDetectedPharmaMapping] = useState<Record<string,string>>({});
  const [unknownDocCols,       setUnknownDocCols]        = useState<string[]>([]);
  const [unknownPharmaCols,    setUnknownPharmaCols]     = useState<string[]>([]);
  const docFileRef    = useRef<HTMLInputElement>(null);
  const pharmaFileRef = useRef<HTMLInputElement>(null);

  // ── Fetch surveys list ──
  const fetchSurveys = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const r = await fetch('/api/super-admin/surveys', { headers: H() });
      const d = await r.json();
      if (d.success) setSurveys(d.data);
      else setApiError(d.error || d.message || `خطأ ${r.status}`);
    } catch (e) {
      setApiError('تعذّر الاتصال بالخادم');
    } finally { setLoading(false); }
  }, [H]);

  useEffect(() => { fetchSurveys(); }, [fetchSurveys]);

  // ── Fetch selected survey detail ──
  const fetchSurvey = useCallback(async (id: number) => {
    const r = await fetch(`/api/super-admin/surveys/${id}`, { headers: H() });
    const d = await r.json();
    if (d.success) setSelectedSurvey(d.data);
  }, [H]);

  // ── Fetch visibility ──
  const fetchVisibility = useCallback(async (id: number) => {
    setVisLoading(true);
    try {
      const r = await fetch(`/api/super-admin/surveys/${id}/visibility`, { headers: H() });
      const d = await r.json();
      if (d.success) { setVisUsers(d.data.users); setVisOffices(d.data.offices); }
    } finally { setVisLoading(false); }
  }, [H]);

  // ── Fetch logs ──
  const fetchLogs = useCallback(async (id: number) => {
    setLogsLoading(true);
    try {
      const r = await fetch(`/api/super-admin/surveys/${id}/logs`, { headers: H() });
      const d = await r.json();
      if (d.success) setLogs(d.data);
    } finally { setLogsLoading(false); }
  }, [H]);

  const openSurvey = (s: Survey) => {
    setTab('doctors');
    fetchSurvey(s.id);
  };

  useEffect(() => {
    if (!selectedSurvey) return;
    if (tab === 'visibility') fetchVisibility(selectedSurvey.id);
    if (tab === 'logs')       fetchLogs(selectedSurvey.id);
  }, [tab, selectedSurvey?.id]);

  // ── Excel import handlers ───────────────────────────────────
  const handleDocExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const rows = await parseExcelFile(file);
    if (!rows.length) return;
    const headerMap = buildDocHeaderMap(rows[0] as Record<string,unknown>);
    const DOC_LABELS: Record<DocField, string> = { name:'الاسم', specialty:'الاختصاص', areaName:'المنطقة', pharmacyName:'الصيدلية', className:'الكلاس', zoneName:'الزون', phone:'الهاتف', notes:'ملاحظات' };
    const humanMap: Record<string,string> = {};
    for (const [h, f] of Object.entries(headerMap)) humanMap[h] = DOC_LABELS[f];
    setDetectedDocMapping(humanMap);
    const allHeaders = Object.keys(rows[0] as Record<string,unknown>);
    setUnknownDocCols(allHeaders.filter(h => !(h in headerMap)));
    setImportDoctorsPreview(rows.map(r => smartMapDocRow(r as Record<string,unknown>, headerMap)).filter(r => r.name));
    setShowDoctorsImport(true); e.target.value = '';
  };
  const handlePharmaExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const rows = await parseExcelFile(file);
    if (!rows.length) return;
    const headerMap = buildPharmaHeaderMap(rows[0] as Record<string,unknown>);
    const PHARMA_LABELS: Record<PharmaField, string> = { name:'الاسم', ownerName:'صاحب الصيدلية', pharmacyName:'الصيدلية', phone:'الهاتف', address:'العنوان', areaName:'المنطقة', notes:'ملاحظات' };
    const humanMap: Record<string,string> = {};
    for (const [h, f] of Object.entries(headerMap)) humanMap[h] = PHARMA_LABELS[f];
    setDetectedPharmaMapping(humanMap);
    const allHeaders = Object.keys(rows[0] as Record<string,unknown>);
    setUnknownPharmaCols(allHeaders.filter(h => !(h in headerMap)));
    setImportPharmasPreview(rows.map(r => smartMapPharmaRow(r as Record<string,unknown>, headerMap)).filter(r => r.name));
    setShowPharmasImport(true); e.target.value = '';
  };
  const confirmImportDoctors = async () => {
    if (!selectedSurvey || !importDoctorsPreview.length) return;
    setImporting(true);
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/doctors/bulk`, {
      method: 'POST', headers: H(), body: JSON.stringify({ doctors: importDoctorsPreview }),
    });
    setShowDoctorsImport(false); setImportDoctorsPreview([]); fetchSurvey(selectedSurvey.id); setImporting(false);
  };
  const confirmImportPharmas = async () => {
    if (!selectedSurvey || !importPharmasPreview.length) return;
    setImporting(true);
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/pharmacies/bulk`, {
      method: 'POST', headers: H(), body: JSON.stringify({ pharmacies: importPharmasPreview }),
    });
    setShowPharmasImport(false); setImportPharmasPreview([]); fetchSurvey(selectedSurvey.id); setImporting(false);
  };

  // ── DocImportModal ───────────────────────────────────────────
  function DocImportModal() {
    return (
      <ModalOverlay onClose={() => setShowDoctorsImport(false)}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>📥 استيراد أطباء من Excel</h3>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>تم العثور على <strong>{importDoctorsPreview.length}</strong> طبيب — تأكد من البيانات ثم اضغط استيراد</p>
        {Object.keys(detectedDocMapping).length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, fontSize: 11 }}>
            <div style={{ fontWeight: 700, color: '#166534', marginBottom: 5 }}>🔍 الأعمدة المكتشفة تلقائياً:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {Object.entries(detectedDocMapping).map(([excel, field]) => (
                <span key={excel} style={{ background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '2px 8px', border: '1px solid #86efac' }}>
                  {excel} → {field}
                </span>
              ))}
            </div>
          </div>
        )}
        {unknownDocCols.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 11 }}>
            <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 5 }}>⚠️ أعمدة لم تُعرف (تحقق من اسمائها):</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {unknownDocCols.map(col => (
                <span key={col} style={{ background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '2px 8px', border: '1px solid #fcd34d' }}>
                  {col}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #e8edf5', borderRadius: 10, marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: '#f8fafc' }}>
              {['الاسم','الاختصاص','المنطقة','الصيدلية','الكلاس','الزون','الهاتف'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e8edf5' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {importDoctorsPreview.map((d, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600, color: '#1e293b' }}>{d.name}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.specialty || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.areaName || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.pharmacyName || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.className || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.zoneName || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{d.phone || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setShowDoctorsImport(false)} style={btnSecondary}>إلغاء</button>
          <button onClick={confirmImportDoctors} disabled={importing} style={btnPrimary}>
            {importing ? 'جاري الاستيراد...' : `✅ استيراد ${importDoctorsPreview.length} طبيب`}
          </button>
        </div>
      </ModalOverlay>
    );
  }

  // ── PharmaImportModal ────────────────────────────────────────
  function PharmaImportModal() {
    return (
      <ModalOverlay onClose={() => setShowPharmasImport(false)}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>📥 استيراد صيدليات من Excel</h3>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>تم العثور على <strong>{importPharmasPreview.length}</strong> صيدلية — تأكد من البيانات ثم اضغط استيراد</p>
        {Object.keys(detectedPharmaMapping).length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, fontSize: 11 }}>
            <div style={{ fontWeight: 700, color: '#166534', marginBottom: 5 }}>🔍 الأعمدة المكتشفة تلقائياً:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {Object.entries(detectedPharmaMapping).map(([excel, field]) => (
                <span key={excel} style={{ background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '2px 8px', border: '1px solid #86efac' }}>
                  {excel} → {field}
                </span>
              ))}
            </div>
          </div>
        )}
        {unknownPharmaCols.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 11 }}>
            <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 5 }}>⚠️ أعمدة لم تُعرف (تحقق من أسمائها):</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {unknownPharmaCols.map(col => (
                <span key={col} style={{ background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '2px 8px', border: '1px solid #fcd34d' }}>
                  {col}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #e8edf5', borderRadius: 10, marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: '#f8fafc' }}>
              {['الاسم','صاحب الصيدلية','الصيدلية','الهاتف','العنوان','المنطقة'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e8edf5' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {importPharmasPreview.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600, color: '#1e293b' }}>{p.name}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{p.ownerName || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{p.pharmacyName || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{p.phone || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{p.address || '—'}</td>
                  <td style={{ padding: '7px 10px', color: '#64748b' }}>{p.areaName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setShowPharmasImport(false)} style={btnSecondary}>إلغاء</button>
          <button onClick={confirmImportPharmas} disabled={importing} style={btnPrimary}>
            {importing ? 'جاري الاستيراد...' : `✅ استيراد ${importPharmasPreview.length} صيدلية`}
          </button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Survey Form ──────────────────────────────────────────────
  function SurveyForm() {
    const [name,        setName]        = useState(editingSurvey?.name ?? '');
    const [description, setDescription] = useState(editingSurvey?.description ?? '');
    const [isActive,    setIsActive]    = useState(editingSurvey?.isActive !== false);
    const [saving, setSaving] = useState(false);

    const save = async () => {
      if (!name.trim()) return;
      setSaving(true);
      const url    = editingSurvey ? `/api/super-admin/surveys/${editingSurvey.id}` : '/api/super-admin/surveys';
      const method = editingSurvey ? 'PUT' : 'POST';
      try {
        const r = await fetch(url, { method, headers: H(), body: JSON.stringify({ name, description, isActive }) });
        const d = await r.json();
        if (!r.ok || !d.success) {
          alert(`❌ فشل الحفظ: ${d?.error || r.status}`);
          setSaving(false);
          return;
        }
        setShowSurveyForm(false);
        setEditingSurvey(null);
        fetchSurveys();
        if (selectedSurvey && editingSurvey?.id === selectedSurvey.id) fetchSurvey(selectedSurvey.id);
      } catch (e) {
        alert('❌ تعذّر الاتصال بالخادم');
      }
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={() => { setShowSurveyForm(false); setEditingSurvey(null); }}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>
          {editingSurvey ? '✏️ تعديل السيرفي' : '➕ سيرفي جديد'}
        </h3>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>الاسم *</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="اسم السيرفي" style={inputStyle} />
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', margin: '12px 0 6px' }}>الوصف</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="وصف اختياري" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
          <input type="checkbox" id="isActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ width: 16, height: 16 }} />
          <label htmlFor="isActive" style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>نشط (يظهر للمستخدمين)</label>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={() => { setShowSurveyForm(false); setEditingSurvey(null); }} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !name.trim()} style={btnPrimary}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Doctor Form ──────────────────────────────────────────────
  function DoctorForm() {
    const [form, setForm] = useState({
      name: editingDoc?.name ?? '', specialty: editingDoc?.specialty ?? '',
      areaName: editingDoc?.areaName ?? '', pharmacyName: editingDoc?.pharmacyName ?? '',
      className: editingDoc?.className ?? '', zoneName: editingDoc?.zoneName ?? '',
      phone: editingDoc?.phone ?? '', notes: editingDoc?.notes ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

    const save = async () => {
      if (!form.name.trim() || !selectedSurvey) return;
      setSaving(true);
      const url    = editingDoc ? `/api/super-admin/surveys/${selectedSurvey.id}/doctors/${editingDoc.id}` : `/api/super-admin/surveys/${selectedSurvey.id}/doctors`;
      const method = editingDoc ? 'PUT' : 'POST';
      await fetch(url, { method, headers: H(), body: JSON.stringify(form) });
      setShowDocForm(false); setEditingDoc(null);
      fetchSurvey(selectedSurvey.id);
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={() => { setShowDocForm(false); setEditingDoc(null); }}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>{editingDoc ? '✏️ تعديل طبيب' : '➕ إضافة طبيب'}</h3>
        {[
          ['الاسم *', 'name'], ['الاختصاص', 'specialty'], ['المنطقة', 'areaName'],
          ['اسم الصيدلية', 'pharmacyName'], ['الكلاس', 'className'], ['الزون', 'zoneName'], ['الهاتف', 'phone'],
        ].map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => { setShowDocForm(false); setEditingDoc(null); }} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={btnPrimary}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Pharmacy Form ────────────────────────────────────────────
  function PharmacyForm() {
    const [form, setForm] = useState({
      name: editingPharma?.name ?? '', ownerName: editingPharma?.ownerName ?? '',
      pharmacyName: editingPharma?.pharmacyName ?? '',
      phone: editingPharma?.phone ?? '', address: editingPharma?.address ?? '',
      areaName: editingPharma?.areaName ?? '', notes: editingPharma?.notes ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

    const save = async () => {
      if (!form.name.trim() || !selectedSurvey) return;
      setSaving(true);
      const url    = editingPharma ? `/api/super-admin/surveys/${selectedSurvey.id}/pharmacies/${editingPharma.id}` : `/api/super-admin/surveys/${selectedSurvey.id}/pharmacies`;
      const method = editingPharma ? 'PUT' : 'POST';
      await fetch(url, { method, headers: H(), body: JSON.stringify(form) });
      setShowPharmaForm(false); setEditingPharma(null);
      fetchSurvey(selectedSurvey.id);
      setSaving(false);
    };

    return (
      <ModalOverlay onClose={() => { setShowPharmaForm(false); setEditingPharma(null); }}>
        <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>{editingPharma ? '✏️ تعديل صيدلية' : '➕ إضافة صيدلية'}</h3>
        {[
          ['الاسم *', 'name'], ['صاحب الصيدلية', 'ownerName'], ['الصيدلية', 'pharmacyName'], ['الهاتف', 'phone'],
          ['العنوان', 'address'], ['المنطقة', 'areaName'],
        ].map(([label, key]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>{label}</label>
            <input value={(form as any)[key]} onChange={set(key)} style={inputStyle} />
          </div>
        ))}
        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>ملاحظات</label>
        <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => { setShowPharmaForm(false); setEditingPharma(null); }} style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={saving || !form.name.trim()} style={btnPrimary}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
        </div>
      </ModalOverlay>
    );
  }

  // ── Delete helpers ────────────────────────────────────────────
  const deleteSurvey = async (id: number) => {
    if (!confirm('حذف هذا السيرفي نهائياً؟ سيُحذف مع كل بياناته.')) return;
    await fetch(`/api/super-admin/surveys/${id}`, { method: 'DELETE', headers: H() });
    if (selectedSurvey?.id === id) setSelectedSurvey(null);
    fetchSurveys();
  };

  const deleteDoc = async (docId: number) => {
    if (!selectedSurvey || !confirm('حذف هذا الطبيب من السيرفي؟')) return;
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/doctors/${docId}`, { method: 'DELETE', headers: H() });
    fetchSurvey(selectedSurvey.id);
  };

  const deletePharma = async (pharmaId: number) => {
    if (!selectedSurvey || !confirm('حذف هذه الصيدلية من السيرفي؟')) return;
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/pharmacies/${pharmaId}`, { method: 'DELETE', headers: H() });
    fetchSurvey(selectedSurvey.id);
  };

  const toggleUserVisibility = async (userId: number, currentlyHidden: boolean) => {
    if (!selectedSurvey) return;
    const method = currentlyHidden ? 'DELETE' : 'POST';
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/visibility/hide-user/${userId}`, { method, headers: H() });
    setVisUsers(v => v.map(u => u.id === userId ? { ...u, hidden: !currentlyHidden } : u));
  };

  const toggleOfficeVisibility = async (officeId: number, currentlyHidden: boolean) => {
    if (!selectedSurvey) return;
    const method = currentlyHidden ? 'DELETE' : 'POST';
    await fetch(`/api/super-admin/surveys/${selectedSurvey.id}/visibility/hide-office/${officeId}`, { method, headers: H() });
    setVisOffices(v => v.map(o => o.id === officeId ? { ...o, hidden: !currentlyHidden } : o));
  };

  // ── Render ────────────────────────────────────────────────────
  if (!selectedSurvey) {
    // Surveys List View
    return (
      <div style={{ direction: 'rtl' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1e1b4b' }}>🗂️ السيرفيات</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>إدارة سيرفيات الأطباء والصيدليات المشتركة</p>
          </div>
          <button onClick={() => { setEditingSurvey(null); setShowSurveyForm(true); }} style={{ ...btnPrimary, padding: '10px 20px' }}>
            ➕ سيرفي جديد
          </button>
        </div>

        {loading ? <Spinner /> : surveys.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, color: apiError ? '#ef4444' : '#94a3b8', fontSize: 15 }}>
            {apiError
              ? <><div style={{ fontSize: 18, marginBottom: 8 }}>⚠️</div><div>خطأ في الاتصال بالخادم:</div><div style={{ fontSize: 12, marginTop: 4, fontFamily: 'monospace', background: '#fef2f2', padding: '6px 12px', borderRadius: 8, display: 'inline-block', marginTop: 8 }}>{apiError}</div></>
              : 'لا توجد سيرفيات بعد — أنشئ أول سيرفي الآن'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px,1fr))', gap: 16 }}>
            {surveys.map(s => (
              <div key={s.id} style={{
                background: '#fff', border: '1.5px solid #e8edf5', borderRadius: 14,
                padding: 18, boxShadow: '0 2px 10px rgba(99,102,241,0.06)',
                transition: 'box-shadow .2s', cursor: 'pointer',
              }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 6px 24px rgba(99,102,241,0.14)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 2px 10px rgba(99,102,241,0.06)')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 16, fontWeight: 800, color: '#1e1b4b' }}>{s.name}</span>
                      <Badge text={s.isActive ? 'نشط' : 'موقف'} color={s.isActive ? '#10b981' : '#94a3b8'} />
                    </div>
                    {s.description && <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{s.description}</p>}
                    <div style={{ display: 'flex', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#6366f1', fontWeight: 600 }}>🩺 {s._count?.doctors ?? 0} طبيب</span>
                      <span style={{ fontSize: 12, color: '#f97316', fontWeight: 600 }}>🏪 {s._count?.pharmacies ?? 0} صيدلية</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button onClick={e => { e.stopPropagation(); openSurvey(s); }} style={{ ...btnPrimary, padding: '6px 12px', fontSize: 12 }}>إدارة</button>
                    <button onClick={e => { e.stopPropagation(); setEditingSurvey(s); setShowSurveyForm(true); }} style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12 }}>تعديل</button>
                    <button onClick={e => { e.stopPropagation(); deleteSurvey(s.id); }} style={{ ...btnDanger, padding: '6px 12px', fontSize: 12 }}>حذف</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {showSurveyForm && <SurveyForm />}
      </div>
    );
  }

  // ── Survey Detail View ────────────────────────────────────────
  const tabs: { id: typeof tab; label: string; icon: string }[] = [
    { id: 'doctors',    label: `الأطباء (${selectedSurvey.doctors.length})`,       icon: '🩺' },
    { id: 'pharmacies', label: `الصيدليات (${selectedSurvey.pharmacies.length})`,  icon: '🏪' },
    { id: 'visibility', label: 'الصلاحيات',                                         icon: '👁️' },
    { id: 'logs',       label: 'سجل التعديلات',                                     icon: '📋' },
  ];

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={() => setSelectedSurvey(null)} style={{ ...btnSecondary, padding: '8px 14px' }}>← رجوع</button>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1e1b4b' }}>{selectedSurvey.name}</h2>
            <Badge text={selectedSurvey.isActive ? 'نشط' : 'موقف'} color={selectedSurvey.isActive ? '#10b981' : '#94a3b8'} />
          </div>
          {selectedSurvey.description && <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>{selectedSurvey.description}</p>}
        </div>
        <button onClick={() => { setEditingSurvey(selectedSurvey); setShowSurveyForm(true); }} style={{ ...btnSecondary, padding: '8px 14px', marginRight: 'auto' }}>✏️ تعديل</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e8edf5', marginBottom: 20 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 16px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: 'transparent', borderBottom: tab === t.id ? '2px solid #6366f1' : '2px solid transparent',
            color: tab === t.id ? '#6366f1' : '#64748b', marginBottom: -2, transition: 'all .15s',
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Doctors Tab */}
      {tab === 'doctors' && (
        <div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 14 }}>
            <button onClick={() => downloadTemplate('doctors')} style={{ ...btnSecondary, padding: '9px 18px' }}>📄 نموذج Excel</button>
            <button onClick={() => docFileRef.current?.click()} style={{ ...btnSecondary, padding: '9px 18px' }}>📥 استيراد Excel</button>
            <input ref={docFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleDocExcel} />
            <button onClick={() => { setEditingDoc(null); setShowDocForm(true); }} style={{ ...btnPrimary, padding: '9px 18px' }}>➕ إضافة طبيب</button>
          </div>
          {selectedSurvey.doctors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا يوجد أطباء في هذا السيرفي بعد</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['الاسم','الاختصاص','المنطقة','الصيدلية','الكلاس','الزون','الهاتف','آخر تعديل',''].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e8edf5', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedSurvey.doctors.map(d => (
                    <tr key={d.id} style={{ borderBottom: '1px solid #f1f5f9' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ padding: '10px 12px', fontWeight: 700, color: '#1e293b' }}>{d.name}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.specialty || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.areaName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.pharmacyName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.className || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.zoneName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{d.phone || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 11 }}>
                        {d.lastEditedBy ? (
                          <span>{d.lastEditedBy.displayName || d.lastEditedBy.username}<br />{d.lastEditedAt ? new Date(d.lastEditedAt).toLocaleDateString('ar-IQ') : ''}</span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => { setEditingDoc(d); setShowDocForm(true); }} style={{ ...btnSecondary, padding: '4px 10px', fontSize: 11 }}>تعديل</button>
                          <button onClick={() => deleteDoc(d.id)} style={{ ...btnDanger, padding: '4px 10px', fontSize: 11 }}>حذف</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pharmacies Tab */}
      {tab === 'pharmacies' && (
        <div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 14 }}>
            <button onClick={() => downloadTemplate('pharmacies')} style={{ ...btnSecondary, padding: '9px 18px' }}>📄 نموذج Excel</button>
            <button onClick={() => pharmaFileRef.current?.click()} style={{ ...btnSecondary, padding: '9px 18px' }}>📥 استيراد Excel</button>
            <input ref={pharmaFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handlePharmaExcel} />
            <button onClick={() => { setEditingPharma(null); setShowPharmaForm(true); }} style={{ ...btnPrimary, padding: '9px 18px' }}>➕ إضافة صيدلية</button>
          </div>
          {selectedSurvey.pharmacies.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد صيدليات في هذا السيرفي بعد</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['الاسم','صاحب الصيدلية','الصيدلية','الهاتف','العنوان','المنطقة','آخر تعديل',''].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e8edf5', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedSurvey.pharmacies.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f1f5f9' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ padding: '10px 12px', fontWeight: 700, color: '#1e293b' }}>{p.name}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{p.ownerName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{p.pharmacyName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{p.phone || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{p.address || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#64748b' }}>{p.areaName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 11 }}>
                        {p.lastEditedBy ? (
                          <span>{p.lastEditedBy.displayName || p.lastEditedBy.username}<br />{p.lastEditedAt ? new Date(p.lastEditedAt).toLocaleDateString('ar-IQ') : ''}</span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => { setEditingPharma(p); setShowPharmaForm(true); }} style={{ ...btnSecondary, padding: '4px 10px', fontSize: 11 }}>تعديل</button>
                          <button onClick={() => deletePharma(p.id)} style={{ ...btnDanger, padding: '4px 10px', fontSize: 11 }}>حذف</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Visibility Tab */}
      {tab === 'visibility' && (
        <div>
          {visLoading ? <Spinner /> : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Users */}
              <div>
                <h4 style={{ margin: '0 0 14px', fontWeight: 800, color: '#1e1b4b', fontSize: 14 }}>👥 المستخدمون</h4>
                <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #e8edf5', borderRadius: 10 }}>
                  {visUsers.map(u => (
                    <div key={u.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', borderBottom: '1px solid #f1f5f9',
                    }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{u.displayName || u.username}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{u.role} {u.officeId ? `· مكتب #${u.officeId}` : ''}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {u.hidden && <Badge text="مخفي" color="#ef4444" />}
                        <button
                          onClick={() => toggleUserVisibility(u.id, u.hidden)}
                          style={u.hidden ? { ...btnPrimary, padding: '5px 12px', fontSize: 11 } : { ...btnDanger, padding: '5px 12px', fontSize: 11 }}>
                          {u.hidden ? '✅ إظهار' : '🚫 إخفاء'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Offices */}
              <div>
                <h4 style={{ margin: '0 0 14px', fontWeight: 800, color: '#1e1b4b', fontSize: 14 }}>🏢 المكاتب</h4>
                <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>إخفاء المكتب يخفي السيرفي عن جميع مستخدمي ذلك المكتب</p>
                <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #e8edf5', borderRadius: 10 }}>
                  {visOffices.map(o => (
                    <div key={o.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', borderBottom: '1px solid #f1f5f9',
                    }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{o.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {o.hidden && <Badge text="مخفي" color="#ef4444" />}
                        <button
                          onClick={() => toggleOfficeVisibility(o.id, o.hidden)}
                          style={o.hidden ? { ...btnPrimary, padding: '5px 12px', fontSize: 11 } : { ...btnDanger, padding: '5px 12px', fontSize: 11 }}>
                          {o.hidden ? '✅ إظهار' : '🚫 إخفاء'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Logs Tab */}
      {tab === 'logs' && (
        <div>
          {logsLoading ? <Spinner /> : logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد تعديلات بعد</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {logs.map(log => {
                let oldObj: Record<string,unknown> | null = null;
                let newObj: Record<string,unknown> | null = null;
                try { if (log.oldData) oldObj = JSON.parse(log.oldData); } catch {}
                try { if (log.newData) newObj = JSON.parse(log.newData); } catch {}
                const fields = ['name','specialty','areaName','pharmacyName','ownerName','phone','address','notes'];
                const changed = fields.filter(f => oldObj && newObj && oldObj[f] !== newObj[f]);

                return (
                  <div key={log.id} style={{
                    background: '#f8fafc', border: '1px solid #e8edf5', borderRadius: 12, padding: '14px 16px',
                    borderRight: `4px solid ${actionColor[log.action] ?? '#94a3b8'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: changed.length ? 10 : 0 }}>
                      <Badge text={actionLabel[log.action] ?? log.action} color={actionColor[log.action] ?? '#94a3b8'} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
                        {log.entryType === 'doctor' ? '🩺 طبيب' : '🏪 صيدلية'}
                        {' — '}
                        {(newObj ?? oldObj)?.name as string ?? `#${log.entryId}`}
                      </span>
                      <span style={{ marginRight: 'auto', fontSize: 11, color: '#94a3b8' }}>
                        {log.editedBy?.displayName || log.editedBy?.username || 'الماستر'}
                        {' · '}
                        {new Date(log.editedAt).toLocaleString('ar-IQ')}
                      </span>
                    </div>
                    {changed.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {changed.map(f => (
                          <div key={f} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#64748b', minWidth: 80 }}>{f}:</span>
                            <span style={{ color: '#ef4444', textDecoration: 'line-through' }}>{String(oldObj![f] ?? '—')}</span>
                            <span style={{ color: '#94a3b8' }}>→</span>
                            <span style={{ color: '#10b981' }}>{String(newObj![f] ?? '—')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showSurveyForm     && <SurveyForm />}
      {showDocForm        && <DoctorForm />}
      {showPharmaForm     && <PharmacyForm />}
      {showDoctorsImport  && <DocImportModal />}
      {showPharmasImport  && <PharmaImportModal />}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f0',
  borderRadius: 9, fontSize: 13, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', direction: 'rtl',
};
const btnPrimary: React.CSSProperties = {
  background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff',
  border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700,
  fontSize: 13, padding: '9px 20px', fontFamily: 'inherit',
};
const btnSecondary: React.CSSProperties = {
  background: '#f1f5f9', color: '#374151', border: '1.5px solid #e2e8f0',
  borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '9px 20px', fontFamily: 'inherit',
};
const btnDanger: React.CSSProperties = {
  background: '#fef2f2', color: '#ef4444', border: '1.5px solid #fecaca',
  borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 13,
  padding: '9px 20px', fontFamily: 'inherit',
};
