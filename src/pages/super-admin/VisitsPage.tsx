import { useState, useEffect, useCallback } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

const FEEDBACK_OPTIONS = [
  { value: 'pending',        label: 'في الانتظار' },
  { value: 'writing',        label: 'كاتب' },
  { value: 'stocked',        label: 'مخزّن' },
  { value: 'interested',     label: 'مهتم' },
  { value: 'not_interested', label: 'غير مهتم' },
  { value: 'unavailable',    label: 'غير متاح' },
];

interface Visit {
  id: number;
  visitDate: string;
  feedback: string;
  notes?: string | null;
  isDoubleVisit: boolean;
  doctor:        { id: number; name: string };
  scientificRep: { id: number; name: string };
  user?:         { id: number; username: string; displayName?: string } | null;
  item?:         { id: number; name: string } | null;
}

interface EditForm {
  id: number;
  visitDate: string;
  feedback: string;
  notes: string;
  isDoubleVisit: boolean;
  itemId: string;
}

export default function VisitsPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [visits,  setVisits]  = useState<Visit[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);

  // Filters
  const [search,   setSearch]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [page,     setPage]     = useState(1);
  const LIMIT = 30;

  // Edit modal
  const [editForm, setEditForm] = useState<EditForm | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page), limit: String(LIMIT),
      ...(search   && { search }),
      ...(dateFrom && { dateFrom }),
      ...(dateTo   && { dateTo }),
    });
    fetch(`/api/super-admin/visits?${params}`, { headers: H() })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setVisits(d.data); setTotal(d.total); }
        else setError(d.error || 'خطأ في التحميل');
      })
      .catch(() => setError('تعذر الاتصال بالسيرفر'))
      .finally(() => setLoading(false));
  }, [H, page, search, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (v: Visit) => {
    if (!confirm(`حذف زيارة "${v.doctor.name}" بتاريخ ${new Date(v.visitDate).toLocaleDateString('ar-IQ')}؟`)) return;
    const res = await fetch(`/api/super-admin/visits/${v.id}`, { method: 'DELETE', headers: H() });
    if (res.ok) { load(); } else { alert('فشل الحذف'); }
  };

  const openEdit = (v: Visit) => {
    setEditForm({
      id:           v.id,
      visitDate:    v.visitDate.split('T')[0],
      feedback:     v.feedback,
      notes:        v.notes ?? '',
      isDoubleVisit: v.isDoubleVisit,
      itemId:       v.item ? String(v.item.id) : '',
    });
    setError('');
  };

  const handleSaveEdit = async () => {
    if (!editForm) return;
    setSaving(true); setError('');
    const res = await fetch(`/api/super-admin/visits/${editForm.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({
        visitDate:    editForm.visitDate,
        feedback:     editForm.feedback,
        notes:        editForm.notes,
        isDoubleVisit: editForm.isDoubleVisit,
        ...(editForm.itemId && { itemId: parseInt(editForm.itemId) }),
      }),
    });
    const d = await res.json();
    setSaving(false);
    if (!res.ok) { setError(d.error || 'خطأ'); return; }
    setEditForm(null); load();
  };

  const feedbackColor = (f: string) => {
    const map: Record<string, string> = {
      pending: '#f59e0b', writing: '#3b82f6', stocked: '#8b5cf6',
      interested: '#10b981', not_interested: '#ef4444', unavailable: '#94a3b8',
    };
    return map[f] || '#64748b';
  };

  const feedbackLabel = (f: string) =>
    FEEDBACK_OPTIONS.find(o => o.value === f)?.label ?? f;

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>📋 إدارة الزيارات (الكولات)</h2>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>إجمالي: {total} زيارة</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="🔍 بحث باسم الطبيب أو المندوب أو الملاحظات..."
          style={{ flex: 1, minWidth: 220, padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14, outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#64748b' }}>من:</label>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#64748b' }}>إلى:</label>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
            style={{ padding: '9px 10px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14 }} />
        </div>
        {(search || dateFrom || dateTo) && (
          <button onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setPage(1); }}
            style={{ padding: '9px 16px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            ✕ مسح الفلتر
          </button>
        )}
      </div>

      {error && <ErrBox msg={error} />}

      {loading ? <Spinner /> : (
        <>
          {/* Table */}
          <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.04)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  {['#', 'التاريخ', 'الطبيب', 'المندوب', 'المستخدم', 'الحالة', 'المنتج', 'ملاحظات', 'إجراءات'].map(h => (
                    <th key={h} style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 700, color: '#374151', fontSize: 13, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visits.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>لا توجد زيارات</td></tr>
                ) : visits.map((v, i) => (
                  <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9', transition: 'background .15s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <td style={{ padding: '11px 14px', color: '#94a3b8', fontWeight: 500 }}>{(page - 1) * LIMIT + i + 1}</td>
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap', fontWeight: 600, color: '#374151' }}>
                      {new Date(v.visitDate).toLocaleDateString('ar-IQ', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                    </td>
                    <td style={{ padding: '11px 14px', fontWeight: 600, color: '#0f172a' }}>{v.doctor.name}</td>
                    <td style={{ padding: '11px 14px', color: '#374151' }}>{v.scientificRep.name}</td>
                    <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>
                      {v.user ? (v.user.displayName || v.user.username) : '—'}
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{
                        background: `${feedbackColor(v.feedback)}18`,
                        color: feedbackColor(v.feedback),
                        borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                      }}>
                        {feedbackLabel(v.feedback)}
                        {v.isDoubleVisit && ' ×2'}
                      </span>
                    </td>
                    <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13 }}>{v.item?.name ?? '—'}</td>
                    <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 13, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.notes || '—'}
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => openEdit(v)}
                          style={{ padding: '5px 12px', background: '#eff6ff', color: '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                          ✏️ تعديل
                        </button>
                        <button onClick={() => handleDelete(v)}
                          style={{ padding: '5px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                          🗑️ حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
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

      {/* Edit Modal */}
      {editForm && (
        <Modal title="✏️ تعديل الزيارة" onClose={() => { setEditForm(null); setError(''); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && <ErrBox msg={error} />}

            <Field label="📅 تاريخ الزيارة" type="date"
              value={editForm.visitDate}
              onChange={v => setEditForm(f => f ? { ...f, visitDate: v } : f)} />

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>📊 الحالة</label>
              <select
                value={editForm.feedback}
                onChange={e => setEditForm(f => f ? { ...f, feedback: e.target.value } : f)}
                style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: 10, fontSize: 14, background: '#fff', outline: 'none', cursor: 'pointer' }}>
                {FEEDBACK_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" id="doubleVisit" checked={editForm.isDoubleVisit}
                onChange={e => setEditForm(f => f ? { ...f, isDoubleVisit: e.target.checked } : f)}
                style={{ width: 18, height: 18, cursor: 'pointer' }} />
              <label htmlFor="doubleVisit" style={{ fontSize: 14, color: '#374151', cursor: 'pointer', fontWeight: 500 }}>
                زيارة مزدوجة (مع مدير/سوبرفايزر)
              </label>
            </div>

            <Field label="📝 ملاحظات" textarea
              value={editForm.notes}
              onChange={v => setEditForm(f => f ? { ...f, notes: v } : f)} />

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => { setEditForm(null); setError(''); }}
                style={{ padding: '10px 20px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                إلغاء
              </button>
              <button onClick={handleSaveEdit} disabled={saving}
                style={btnStyle('#0f172a')}>
                {saving ? '...' : '💾 حفظ التعديلات'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
