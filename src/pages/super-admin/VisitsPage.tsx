import { useState, useEffect, useCallback } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

const FEEDBACK_OPTIONS = [
  { value: 'pending',        label: 'بانتظار الفيدباك' },
  { value: 'writing',        label: 'يكتب' },
  { value: 'stocked',        label: 'يوجد كومبتتر' },
  { value: 'interested',     label: 'مهتم' },
  { value: 'not_interested', label: 'غير مهتم' },
  { value: 'unavailable',    label: 'متابعة وتذكير' },
];

interface Visit {
  id: number;
  visitDate: string;
  feedback: string;
  notes?: string | null;
  isDoubleVisit: boolean;
  doctor:        { id: number; name: string };
  scientificRep: { id: number; name: string } | null;
  user?:         { id: number; username: string; displayName?: string; office?: { id: number; name: string } | null; companyAssignments?: { company: { id: number; name: string } }[] } | null;
  item?:         { id: number; name: string } | null;
}

interface PharmVisitItem { id: number; itemName?: string | null; item?: { id: number; name: string } | null; }
interface PharmVisit {
  id: number;
  pharmacyName: string;
  areaName?: string | null;
  area?: { id: number; name: string } | null;
  visitDate: string;
  notes?: string | null;
  isDoubleVisit: boolean;
  latitude?: number | null;
  longitude?: number | null;
  scientificRep: { id: number; name: string } | null;
  user?:         { id: number; username: string; displayName?: string; office?: { id: number; name: string } | null; companyAssignments?: { company: { id: number; name: string } }[] } | null;
  items: PharmVisitItem[];
}

interface EditForm {
  id: number;
  visitDate: string;
  feedback: string;
  notes: string;
  isDoubleVisit: boolean;
  itemId: string;
}

interface PharmEditForm {
  id: number;
  visitDate: string;
  pharmacyName: string;
  notes: string;
  isDoubleVisit: boolean;
}

interface FilterOption { id: number; name: string; }

export default function VisitsPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [tab, setTab] = useState<'doctor' | 'pharmacy' | 'activity'>('doctor');

  // ── Activity Log state ──────────────────────────────────────
  const [actLogs,    setActLogs]    = useState<any[]>([]);
  const [actTotal,   setActTotal]   = useState(0);
  const [actLoading, setActLoading] = useState(false);
  const [actPage,    setActPage]    = useState(1);
  const [actSearch,  setActSearch]  = useState('');
  const [actDateFrom, setActDateFrom] = useState('');
  const [actDateTo,   setActDateTo]   = useState('');
  const ACT_LIMIT = 50;

  const [visits,  setVisits]  = useState<Visit[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);

  const [pharmVisits,  setPharmVisits]  = useState<PharmVisit[]>([]);
  const [pharmTotal,   setPharmTotal]   = useState(0);
  const [pharmLoading, setPharmLoading] = useState(true);
  const [pharmError,   setPharmError]   = useState('');
  const [pharmSaving,  setPharmSaving]  = useState(false);

  const [search,        setSearch]        = useState('');
  const [dateFrom,      setDateFrom]      = useState('');
  const [dateTo,        setDateTo]        = useState('');
  const [filterOffice,  setFilterOffice]  = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [page,          setPage]          = useState(1);
  const [pharmPage,     setPharmPage]     = useState(1);
  const LIMIT = 30;

  const [selectedIds,      setSelectedIds]      = useState<Set<number>>(new Set());
  const [pharmSelectedIds, setPharmSelectedIds] = useState<Set<number>>(new Set());

  const [offices,   setOffices]   = useState<FilterOption[]>([]);
  const [companies, setCompanies] = useState<FilterOption[]>([]);

  const [editForm,      setEditForm]      = useState<EditForm | null>(null);
  const [pharmEditForm, setPharmEditForm] = useState<PharmEditForm | null>(null);

  useEffect(() => {
    fetch('/api/super-admin/offices-for-filter',   { headers: H() })
      .then(r => r.json()).then(d => { if (d.success) setOffices(d.data); });
    fetch('/api/super-admin/companies-for-filter', { headers: H() })
      .then(r => r.json()).then(d => { if (d.success) setCompanies(d.data); });
  }, [H]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page), limit: String(LIMIT),
      ...(search        && { search }),
      ...(dateFrom      && { dateFrom }),
      ...(dateTo        && { dateTo }),
      ...(filterOffice  && { officeId: filterOffice }),
      ...(filterCompany && { companyId: filterCompany }),
    });
    fetch(`/api/super-admin/visits?${params}`, { headers: H() })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setVisits(d.data); setTotal(d.total); setSelectedIds(new Set()); }
        else setError(d.error || 'خطأ في التحميل');
      })
      .catch(() => setError('تعذر الاتصال بالسيرفر'))
      .finally(() => setLoading(false));
  }, [H, page, search, dateFrom, dateTo, filterOffice, filterCompany]);

  const loadPharm = useCallback(() => {
    setPharmLoading(true);
    const params = new URLSearchParams({
      page: String(pharmPage), limit: String(LIMIT),
      ...(search        && { search }),
      ...(dateFrom      && { dateFrom }),
      ...(dateTo        && { dateTo }),
      ...(filterOffice  && { officeId: filterOffice }),
      ...(filterCompany && { companyId: filterCompany }),
    });
    fetch(`/api/super-admin/pharmacy-visits?${params}`, { headers: H() })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setPharmVisits(d.data); setPharmTotal(d.total); setPharmSelectedIds(new Set()); }
        else setPharmError(d.error || 'خطأ في التحميل');
      })
      .catch(() => setPharmError('تعذر الاتصال بالسيرفر'))
      .finally(() => setPharmLoading(false));
  }, [H, pharmPage, search, dateFrom, dateTo, filterOffice, filterCompany]);

  useEffect(() => { if (tab === 'doctor')   load(); },      [load, tab]);
  useEffect(() => { if (tab === 'pharmacy') loadPharm(); }, [loadPharm, tab]);

  const loadActivity = useCallback(() => {
    setActLoading(true);
    const params = new URLSearchParams({
      page: String(actPage), limit: String(ACT_LIMIT),
      ...(actSearch   && { search:   actSearch }),
      ...(actDateFrom && { dateFrom: actDateFrom }),
      ...(actDateTo   && { dateTo:   actDateTo }),
    });
    fetch(`/api/super-admin/activity-logs?${params}`, { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) { setActLogs(d.data); setActTotal(d.total); } })
      .catch(() => {})
      .finally(() => setActLoading(false));
  }, [H, actPage, actSearch, actDateFrom, actDateTo]);

  useEffect(() => { if (tab === 'activity') loadActivity(); }, [loadActivity, tab]);

  const handleDelete = async (v: Visit) => {
    if (!confirm(`حذف زيارة "${v.doctor.name}" بتاريخ ${new Date(v.visitDate).toLocaleDateString('ar-IQ')}؟`)) return;
    const res = await fetch(`/api/super-admin/visits/${v.id}`, { method: 'DELETE', headers: H() });
    if (res.ok) { load(); } else { alert('فشل الحذف'); }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`حذف ${selectedIds.size} زيارة محددة؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    const res = await fetch('/api/super-admin/visits', {
      method: 'DELETE', headers: H(),
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    if (res.ok) { load(); } else { alert('فشل الحذف الجماعي'); }
  };

  const toggleSelect = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const toggleSelectAll = () => {
    if (selectedIds.size === visits.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(visits.map(v => v.id)));
  };

  const openEdit = (v: Visit) => {
    setEditForm({ id: v.id, visitDate: v.visitDate.split('T')[0], feedback: v.feedback, notes: v.notes ?? '', isDoubleVisit: v.isDoubleVisit, itemId: v.item ? String(v.item.id) : '' });
    setError('');
  };

  const handleSaveEdit = async () => {
    if (!editForm) return;
    setSaving(true); setError('');
    const res = await fetch(`/api/super-admin/visits/${editForm.id}`, {
      method: 'PATCH', headers: H(),
      body: JSON.stringify({ visitDate: editForm.visitDate, feedback: editForm.feedback, notes: editForm.notes, isDoubleVisit: editForm.isDoubleVisit, ...(editForm.itemId && { itemId: parseInt(editForm.itemId) }) }),
    });
    const d = await res.json();
    setSaving(false);
    if (!res.ok) { setError(d.error || 'خطأ'); return; }
    setEditForm(null); load();
  };

  const handlePharmDelete = async (v: PharmVisit) => {
    if (!confirm(`حذف زيارة صيدلية "${v.pharmacyName}" بتاريخ ${new Date(v.visitDate).toLocaleDateString('ar-IQ')}؟`)) return;
    const res = await fetch(`/api/super-admin/pharmacy-visits/${v.id}`, { method: 'DELETE', headers: H() });
    if (res.ok) { loadPharm(); } else { alert('فشل الحذف'); }
  };

  const handlePharmBulkDelete = async () => {
    if (pharmSelectedIds.size === 0) return;
    if (!confirm(`حذف ${pharmSelectedIds.size} زيارة صيدلية محددة؟ لا يمكن التراجع.`)) return;
    const res = await fetch('/api/super-admin/pharmacy-visits', {
      method: 'DELETE', headers: H(),
      body: JSON.stringify({ ids: [...pharmSelectedIds] }),
    });
    if (res.ok) { loadPharm(); } else { alert('فشل الحذف الجماعي'); }
  };

  const togglePharmSelect = (id: number) => setPharmSelectedIds(prev => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const togglePharmSelectAll = () => {
    if (pharmSelectedIds.size === pharmVisits.length) setPharmSelectedIds(new Set());
    else setPharmSelectedIds(new Set(pharmVisits.map(v => v.id)));
  };

  const openPharmEdit = (v: PharmVisit) => {
    setPharmEditForm({ id: v.id, visitDate: v.visitDate.split('T')[0], pharmacyName: v.pharmacyName, notes: v.notes ?? '', isDoubleVisit: v.isDoubleVisit });
    setPharmError('');
  };

  const handlePharmSaveEdit = async () => {
    if (!pharmEditForm) return;
    setPharmSaving(true); setPharmError('');
    const res = await fetch(`/api/super-admin/pharmacy-visits/${pharmEditForm.id}`, {
      method: 'PATCH', headers: H(),
      body: JSON.stringify({ visitDate: pharmEditForm.visitDate, pharmacyName: pharmEditForm.pharmacyName, notes: pharmEditForm.notes, isDoubleVisit: pharmEditForm.isDoubleVisit }),
    });
    const d = await res.json();
    setPharmSaving(false);
    if (!res.ok) { setPharmError(d.error || 'خطأ'); return; }
    setPharmEditForm(null); loadPharm();
  };

  const feedbackColor = (f: string) => {
    const map: Record<string, string> = {
      pending: '#0ea5e9', writing: '#10b981', stocked: '#8b5cf6',
      interested: '#6366f1', not_interested: '#ef4444', unavailable: '#f59e0b',
    };
    return map[f] || '#64748b';
  };
  const feedbackLabel = (f: string) => FEEDBACK_OPTIONS.find(o => o.value === f)?.label ?? f;

  const totalPages      = Math.ceil(total / LIMIT);
  const pharmTotalPages = Math.ceil(pharmTotal / LIMIT);
  const hasFilters      = !!(search || dateFrom || dateTo || filterOffice || filterCompany);
  const allSelected     = visits.length > 0 && selectedIds.size === visits.length;
  const pharmAllSelected = pharmVisits.length > 0 && pharmSelectedIds.size === pharmVisits.length;

  const selectStyle: React.CSSProperties = {
    padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10,
    fontSize: 14, background: '#fff', outline: 'none', cursor: 'pointer', minWidth: 160,
  };

  const clearFilters = () => { setSearch(''); setDateFrom(''); setDateTo(''); setFilterOffice(''); setFilterCompany(''); setPage(1); setPharmPage(1); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}> إدارة الزيارات (الكولات)</h2>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
            {tab === 'doctor' ? `إجمالي زيارات الأطباء: ${total}` : `إجمالي زيارات الصيدليات: ${pharmTotal}`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        <button onClick={() => setTab('doctor')}
          style={{ padding: '9px 22px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14,
            background: tab === 'doctor' ? '#0f172a' : '#f1f5f9', color: tab === 'doctor' ? '#fff' : '#64748b' }}>
          ‍ زيارات الأطباء
        </button>
        <button onClick={() => setTab('pharmacy')}
          style={{ padding: '9px 22px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14,
            background: tab === 'pharmacy' ? '#0f766e' : '#f1f5f9', color: tab === 'pharmacy' ? '#fff' : '#64748b' }}>
           زيارات الصيدليات
        </button>
        <button onClick={() => setTab('activity')}
          style={{ padding: '9px 22px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14,
            background: tab === 'activity' ? '#7c3aed' : '#f1f5f9', color: tab === 'activity' ? '#fff' : '#64748b' }}>
          🕵️ سجل الحركات
        </button>
      </div>

      {/* ── Activity Log Tab ──────────────────────────────────── */}
      {tab === 'activity' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              value={actSearch} onChange={e => { setActSearch(e.target.value); setActPage(1); }}
              placeholder="🔍 بحث باسم المستخدم أو الإجراء أو التفاصيل..."
              style={{ flex: 1, minWidth: 240, padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14, outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: '#64748b' }}>من:</label>
              <input type="date" value={actDateFrom} onChange={e => { setActDateFrom(e.target.value); setActPage(1); }}
                style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: '#64748b' }}>إلى:</label>
              <input type="date" value={actDateTo} onChange={e => { setActDateTo(e.target.value); setActPage(1); }}
                style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
            </div>
            <button onClick={loadActivity} style={{ padding: '9px 18px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              🔄 تحديث
            </button>
          </div>

          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
            إجمالي الحركات المسجلة: {actTotal.toLocaleString('en')}
          </div>

          {actLoading
            ? <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>جاري التحميل...</div>
            : actLogs.length === 0
              ? <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>لا توجد حركات</div>
              : (
                <div style={{ overflowX: 'auto', borderRadius: 12, border: '1.5px solid #e2e8f0', background: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, direction: 'rtl' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                        {['#', 'التاريخ والوقت', 'الحساب', 'الدور', 'الإجراء', 'الوحدة', 'التفاصيل', 'IP'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 12, color: '#475569', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {actLogs.map((log, idx) => {
                        const dt = new Date(log.createdAt);
                        const dateStr = `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
                        const timeStr = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}:${String(dt.getSeconds()).padStart(2,'0')}`;
                        const actionColor = log.action === 'login' ? '#10b981' : log.action === 'logout' ? '#ef4444' : log.action?.startsWith('DELETE') ? '#f97316' : '#6366f1';
                        return (
                          <tr key={log.id} style={{ borderBottom: '1px solid #f1f5f9' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#faf5ff')}
                            onMouseLeave={e => (e.currentTarget.style.background = '')}>
                            <td style={{ padding: '8px 12px', color: '#94a3b8', fontSize: 11 }}>{(actPage-1)*ACT_LIMIT + idx + 1}</td>
                            <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#374151' }}>
                              <div style={{ fontWeight: 600 }}>{dateStr}</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>{timeStr}</div>
                            </td>
                            <td style={{ padding: '8px 12px', fontWeight: 600, color: '#0f172a' }}>
                              {log.user?.displayName || log.user?.username || <span style={{ color: '#cbd5e1' }}>—</span>}
                              {log.user?.username && log.user?.displayName && (
                                <div style={{ fontSize: 10, color: '#94a3b8' }}>@{log.user.username}</div>
                              )}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              {log.user?.role
                                ? <span style={{ background: '#f1f5f9', borderRadius: 6, padding: '2px 8px', fontSize: 11, color: '#475569' }}>{log.user.role}</span>
                                : <span style={{ color: '#cbd5e1' }}>—</span>}
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <span style={{ background: actionColor + '18', color: actionColor, borderRadius: 6, padding: '3px 10px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
                                {log.action}
                              </span>
                            </td>
                            <td style={{ padding: '8px 10px', color: '#64748b', fontSize: 12 }}>{log.module || '—'}</td>
                            <td style={{ padding: '8px 12px', color: '#374151', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.details ?? ''}>
                              {log.details || '—'}
                            </td>
                            <td style={{ padding: '8px 10px', color: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}>{log.ipAddress || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          }

          {/* Pagination */}
          {actTotal > ACT_LIMIT && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
              <button onClick={() => setActPage(p => Math.max(1, p-1))} disabled={actPage === 1}
                style={{ padding: '7px 16px', background: actPage===1?'#f1f5f9':'#7c3aed', color: actPage===1?'#94a3b8':'#fff', border: 'none', borderRadius: 8, cursor: actPage===1?'default':'pointer', fontWeight: 600 }}>
                ‹ السابق
              </button>
              <span style={{ padding: '7px 14px', fontSize: 13, color: '#64748b' }}>
                صفحة {actPage} من {Math.ceil(actTotal/ACT_LIMIT)}
              </span>
              <button onClick={() => setActPage(p => p+1)} disabled={actPage >= Math.ceil(actTotal/ACT_LIMIT)}
                style={{ padding: '7px 16px', background: actPage>=Math.ceil(actTotal/ACT_LIMIT)?'#f1f5f9':'#7c3aed', color: actPage>=Math.ceil(actTotal/ACT_LIMIT)?'#94a3b8':'#fff', border: 'none', borderRadius: 8, cursor: actPage>=Math.ceil(actTotal/ACT_LIMIT)?'default':'pointer', fontWeight: 600 }}>
                التالي ›
              </button>
            </div>
          )}
        </div>
      )}

      {tab !== 'activity' && <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => { setSearch(e.target.value); setPage(1); setPharmPage(1); }}
          placeholder={tab === 'doctor' ? ' بحث باسم الطبيب أو المندوب أو الملاحظات...' : ' بحث باسم الصيدلية أو المنطقة أو المندوب...'}
          style={{ flex: 1, minWidth: 220, padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14, outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#64748b' }}>من:</label>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); setPharmPage(1); }}
            style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#64748b' }}>إلى:</label>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); setPharmPage(1); }}
            style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={filterOffice}  onChange={e => { setFilterOffice(e.target.value);  setPage(1); setPharmPage(1); }} style={selectStyle}>
          <option value=""> كل المكاتب</option>
          {offices.map(o => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
        </select>
        <select value={filterCompany} onChange={e => { setFilterCompany(e.target.value); setPage(1); setPharmPage(1); }} style={selectStyle}>
          <option value=""> كل الشركات</option>
          {companies.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
        </select>
        {hasFilters && (
          <button onClick={clearFilters}
            style={{ padding: '9px 16px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
             مسح الفلتر
          </button>
        )}
      </div>}

      {tab === 'doctor' && (
        <>
          {selectedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '10px 16px', background: '#fef3c7', borderRadius: 10, border: '1.5px solid #f59e0b' }}>
              <span style={{ fontWeight: 700, color: '#92400e', fontSize: 14 }}> تم تحديد {selectedIds.size} زيارة</span>
              <button onClick={handleBulkDelete}
                style={{ padding: '7px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                 حذف المحدد
              </button>
              <button onClick={() => setSelectedIds(new Set())}
                style={{ padding: '7px 14px', background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                إلغاء التحديد
              </button>
            </div>
          )}
          {error && <ErrBox msg={error} />}
          {loading ? <Spinner /> : (
            <>
              <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.04)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                      <th style={{ padding: '12px 14px' }}>
                        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      </th>
                      {['#', 'التاريخ', 'الطبيب', 'المندوب', 'المستخدم', 'المكتب', 'الشركة', 'الحالة', 'المنتج', 'ملاحظات', 'إجراءات'].map(h => (
                        <th key={h} style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 700, color: '#374151', fontSize: 13, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visits.length === 0 ? (
                      <tr><td colSpan={12} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد زيارات</td></tr>
                    ) : visits.map((v, i) => {
                      const isSelected = selectedIds.has(v.id);
                      return (
                        <tr key={v.id}
                          style={{ borderBottom: '1px solid #f1f5f9', transition: 'background .15s', background: isSelected ? '#fffbeb' : '' }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#f8fafc'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = isSelected ? '#fffbeb' : ''; }}>
                          <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(v.id)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                          </td>
                          <td style={{ padding: '11px 14px', color: '#94a3b8', fontWeight: 500 }}>{(page - 1) * LIMIT + i + 1}</td>
                          <td style={{ padding: '11px 14px', whiteSpace: 'nowrap', fontWeight: 600, color: '#374151' }}>
                            {new Date(v.visitDate).toLocaleDateString('ar-IQ', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </td>
                          <td style={{ padding: '11px 14px', fontWeight: 600, color: '#0f172a' }}>{v.doctor.name}</td>
                          <td style={{ padding: '11px 14px', color: '#374151' }}>{v.scientificRep?.name ?? (v.user?.displayName || v.user?.username || '')}</td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>{v.user ? (v.user.displayName || v.user.username) : ''}</td>
                          <td style={{ padding: '11px 14px', color: '#374151', fontSize: 13 }}>{v.user?.office?.name ?? ''}</td>
                          <td style={{ padding: '11px 14px', color: '#374151', fontSize: 13 }}>{v.user?.companyAssignments?.map(a => a.company.name).join('، ') || ''}</td>
                          <td style={{ padding: '11px 14px' }}>
                            <span style={{ background: `${feedbackColor(v.feedback)}18`, color: feedbackColor(v.feedback), borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                              {feedbackLabel(v.feedback)}{v.isDoubleVisit && ' ×2'}
                            </span>
                          </td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>{v.item?.name ?? ''}</td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.notes || ''}</td>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => openEdit(v)} style={{ padding: '5px 12px', background: '#eff6ff', color: '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}> تعديل</button>
                              <button onClick={() => handleDelete(v)} style={{ padding: '5px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}> حذف</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20 }}>
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    style={{ padding: '8px 16px', background: page === 1 ? '#f1f5f9' : '#0f172a', color: page === 1 ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, cursor: page === 1 ? 'default' : 'pointer', fontWeight: 600 }}>
                    &#8594; السابق
                  </button>
                  <span style={{ fontSize: 14, color: '#374151', fontWeight: 600 }}>{page} / {totalPages}</span>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    style={{ padding: '8px 16px', background: page === totalPages ? '#f1f5f9' : '#0f172a', color: page === totalPages ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, cursor: page === totalPages ? 'default' : 'pointer', fontWeight: 600 }}>
                    التالي &#8592;
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === 'pharmacy' && (
        <>
          {pharmSelectedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '10px 16px', background: '#ccfbf1', borderRadius: 10, border: '1.5px solid #5eead4' }}>
              <span style={{ fontWeight: 700, color: '#0f766e', fontSize: 14 }}> تم تحديد {pharmSelectedIds.size} زيارة صيدلية</span>
              <button onClick={handlePharmBulkDelete}
                style={{ padding: '7px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                 حذف المحدد
              </button>
              <button onClick={() => setPharmSelectedIds(new Set())}
                style={{ padding: '7px 14px', background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                إلغاء التحديد
              </button>
            </div>
          )}
          {pharmError && <ErrBox msg={pharmError} />}
          {pharmLoading ? <Spinner /> : (
            <>
              <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.04)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: '#f0fdfa', borderBottom: '2px solid #99f6e4' }}>
                      <th style={{ padding: '12px 14px' }}>
                        <input type="checkbox" checked={pharmAllSelected} onChange={togglePharmSelectAll} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      </th>
                      {['#', 'التاريخ', 'الصيدلية', 'المنطقة', 'المندوب', 'المستخدم', 'المكتب', 'الشركة', 'المنتجات', 'مزدوجة', 'ملاحظات', 'إجراءات'].map(h => (
                        <th key={h} style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 700, color: '#0f766e', fontSize: 13, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pharmVisits.length === 0 ? (
                      <tr><td colSpan={13} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد زيارات صيدليات</td></tr>
                    ) : pharmVisits.map((v, i) => {
                      const isSelected = pharmSelectedIds.has(v.id);
                      const itemNames  = v.items.map(it => it.item?.name ?? it.itemName ?? '').filter(Boolean).join('، ');
                      const areaLabel  = v.area?.name ?? v.areaName ?? '';
                      return (
                        <tr key={v.id}
                          style={{ borderBottom: '1px solid #f1f5f9', transition: 'background .15s', background: isSelected ? '#f0fdfa' : '' }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#f8fafc'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = isSelected ? '#f0fdfa' : ''; }}>
                          <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                            <input type="checkbox" checked={isSelected} onChange={() => togglePharmSelect(v.id)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                          </td>
                          <td style={{ padding: '11px 14px', color: '#94a3b8', fontWeight: 500 }}>{(pharmPage - 1) * LIMIT + i + 1}</td>
                          <td style={{ padding: '11px 14px', whiteSpace: 'nowrap', fontWeight: 600, color: '#374151' }}>
                            {new Date(v.visitDate).toLocaleDateString('ar-IQ', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </td>
                          <td style={{ padding: '11px 14px', fontWeight: 600, color: '#0f766e' }}>{v.pharmacyName}</td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>{areaLabel}</td>
                          <td style={{ padding: '11px 14px', color: '#374151' }}>{v.scientificRep?.name ?? (v.user?.displayName || v.user?.username || '')}</td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>{v.user ? (v.user.displayName || v.user.username) : ''}</td>
                          <td style={{ padding: '11px 14px', color: '#374151', fontSize: 13 }}>{v.user?.office?.name ?? ''}</td>
                          <td style={{ padding: '11px 14px', color: '#374151', fontSize: 13 }}>{v.user?.companyAssignments?.map(a => a.company.name).join('، ') || ''}</td>
                          <td style={{ padding: '11px 14px', color: '#2563eb', fontSize: 13 }}>{itemNames || ''}</td>
                          <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                            {v.isDoubleVisit
                              ? <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>مزدوجة</span>
                              : <span style={{ color: '#cbd5e1', fontSize: 12 }}></span>}
                          </td>
                          <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.notes || ''}</td>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => openPharmEdit(v)} style={{ padding: '5px 12px', background: '#eff6ff', color: '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}> تعديل</button>
                              <button onClick={() => handlePharmDelete(v)} style={{ padding: '5px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}> حذف</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pharmTotalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20 }}>
                  <button onClick={() => setPharmPage(p => Math.max(1, p - 1))} disabled={pharmPage === 1}
                    style={{ padding: '8px 16px', background: pharmPage === 1 ? '#f1f5f9' : '#0f766e', color: pharmPage === 1 ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, cursor: pharmPage === 1 ? 'default' : 'pointer', fontWeight: 600 }}>
                    &#8594; السابق
                  </button>
                  <span style={{ fontSize: 14, color: '#374151', fontWeight: 600 }}>{pharmPage} / {pharmTotalPages}</span>
                  <button onClick={() => setPharmPage(p => Math.min(pharmTotalPages, p + 1))} disabled={pharmPage === pharmTotalPages}
                    style={{ padding: '8px 16px', background: pharmPage === pharmTotalPages ? '#f1f5f9' : '#0f766e', color: pharmPage === pharmTotalPages ? '#94a3b8' : '#fff', border: 'none', borderRadius: 8, cursor: pharmPage === pharmTotalPages ? 'default' : 'pointer', fontWeight: 600 }}>
                    التالي &#8592;
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {editForm && (
        <Modal title=" تعديل زيارة طبيب" onClose={() => { setEditForm(null); setError(''); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && <ErrBox msg={error} />}
            <Field label=" تاريخ الزيارة" type="date" value={editForm.visitDate} onChange={v => setEditForm(f => f ? { ...f, visitDate: v } : f)} />
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}> الحالة</label>
              <select value={editForm.feedback} onChange={e => setEditForm(f => f ? { ...f, feedback: e.target.value } : f)}
                style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14, background: '#fff', outline: 'none', cursor: 'pointer' }}>
                {FEEDBACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" id="doubleVisit" checked={editForm.isDoubleVisit}
                onChange={e => setEditForm(f => f ? { ...f, isDoubleVisit: e.target.checked } : f)}
                style={{ width: 18, height: 18, cursor: 'pointer' }} />
              <label htmlFor="doubleVisit" style={{ fontSize: 14, color: '#374151', cursor: 'pointer', fontWeight: 500 }}>زيارة مزدوجة (مع مدير/سوبرفايزر)</label>
            </div>
            <Field label=" ملاحظات" textarea value={editForm.notes} onChange={v => setEditForm(f => f ? { ...f, notes: v } : f)} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => { setEditForm(null); setError(''); }}
                style={{ padding: '10px 20px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                إلغاء
              </button>
              <button onClick={handleSaveEdit} disabled={saving} style={btnStyle('#0f172a')}>
                {saving ? '...' : ' حفظ التعديلات'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {pharmEditForm && (
        <Modal title=" تعديل زيارة صيدلية" onClose={() => { setPharmEditForm(null); setPharmError(''); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {pharmError && <ErrBox msg={pharmError} />}
            <Field label=" تاريخ الزيارة" type="date" value={pharmEditForm.visitDate} onChange={v => setPharmEditForm(f => f ? { ...f, visitDate: v } : f)} />
            <Field label=" اسم الصيدلية" value={pharmEditForm.pharmacyName} onChange={v => setPharmEditForm(f => f ? { ...f, pharmacyName: v } : f)} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" id="pharmDoubleVisit" checked={pharmEditForm.isDoubleVisit}
                onChange={e => setPharmEditForm(f => f ? { ...f, isDoubleVisit: e.target.checked } : f)}
                style={{ width: 18, height: 18, cursor: 'pointer' }} />
              <label htmlFor="pharmDoubleVisit" style={{ fontSize: 14, color: '#374151', cursor: 'pointer', fontWeight: 500 }}>زيارة مزدوجة (مع مدير/سوبرفايزر)</label>
            </div>
            <Field label=" ملاحظات" textarea value={pharmEditForm.notes} onChange={v => setPharmEditForm(f => f ? { ...f, notes: v } : f)} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => { setPharmEditForm(null); setPharmError(''); }}
                style={{ padding: '10px 20px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                إلغاء
              </button>
              <button onClick={handlePharmSaveEdit} disabled={pharmSaving} style={btnStyle('#0f766e')}>
                {pharmSaving ? '...' : ' حفظ التعديلات'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}