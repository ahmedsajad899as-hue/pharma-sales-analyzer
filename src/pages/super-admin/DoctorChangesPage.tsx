import { useState, useEffect, useCallback } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';

interface DoctorChange {
  id: number;
  action: 'create' | 'update' | string;
  editedAt: string;
  isUnread: boolean;
  editor: string;
  surveyName: string | null;
  oldName: string | null;
  newName: string | null;
  specialty: string | null;
  areaName: string | null;
  pharmacyName: string | null;
}

type Filter = 'all' | 'update' | 'create';

export default function DoctorChangesPage() {
  const { token } = useSuperAdmin();
  const H = { Authorization: `Bearer ${token}` };

  const [rows,    setRows]    = useState<DoctorChange[]>([]);
  const [total,   setTotal]   = useState(0);
  const [page,    setPage]    = useState(1);
  const [pages,   setPages]   = useState(1);
  const [filter,  setFilter]  = useState<Filter>('all');
  const [loading, setLoading] = useState(true);

  const limit = 50;

  const load = useCallback(async (p: number, f: Filter) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (f !== 'all') qs.set('action', f);
      const r = await fetch(`/api/super-admin/doctor-changes?${qs}`, { headers: H });
      const d = await r.json();
      if (d.success) {
        setRows(d.data);
        setTotal(d.total);
        setPage(d.page);
        setPages(Math.max(1, Math.ceil(d.total / limit)));
      }
    } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load + mark-seen (فتح الصفحة = مشاهدة الإشعارات)
  useEffect(() => {
    load(1, filter);
    fetch('/api/super-admin/doctor-changes/mark-seen', { method: 'POST', headers: H })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(1, filter); /* eslint-disable-next-line */ }, [filter]);

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('ar-IQ', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  const filterTabs: { id: Filter; label: string; icon: string }[] = [
    { id: 'all',    label: 'الكل',        icon: '📋' },
    { id: 'update', label: 'تعديلات',     icon: '✏️' },
    { id: 'create', label: 'أطباء جدد',  icon: '➕' },
  ];

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: '#1e1b4b' }}>🔔 سجل تغييرات الأطباء</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            تعديلات وإضافات المندوبين والمدراء على قوائم الأطباء المشتركة
          </p>
        </div>
        <div style={{ fontSize: 13, color: '#6366f1', fontWeight: 700, background: '#eef2ff', padding: '6px 14px', borderRadius: 10 }}>
          {total.toLocaleString('ar-IQ')} حركة
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {filterTabs.map(t => {
          const active = filter === t.id;
          return (
            <button key={t.id} onClick={() => setFilter(t.id)} style={{
              padding: '8px 16px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 13, fontWeight: 700, border: '1.5px solid',
              borderColor: active ? '#6366f1' : '#e2e8f0',
              background: active ? '#6366f1' : '#fff',
              color: active ? '#fff' : '#64748b', transition: 'all .15s',
            }}>{t.icon} {t.label}</button>
          );
        })}
      </div>

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', fontSize: 14 }}>⏳ جاري التحميل...</div>
      ) : rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', background: '#f8fafc', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
          لا توجد تغييرات بعد
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => {
            const isCreate = r.action === 'create';
            const accent = isCreate ? '#10b981' : '#6366f1';
            return (
              <div key={r.id} style={{
                background: r.isUnread ? '#fefce8' : '#fff',
                border: `1.5px solid ${r.isUnread ? '#fde68a' : '#eef2f7'}`,
                borderRadius: 14, padding: '14px 16px',
                boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                display: 'flex', alignItems: 'flex-start', gap: 12,
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 11, flexShrink: 0,
                  background: `${accent}15`, color: accent,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                }}>{isCreate ? '➕' : '✏️'}</div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {isCreate ? (
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#1e293b' }}>
                      طبيب جديد: {r.newName || '—'}
                    </div>
                  ) : (
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {r.oldName && r.newName && r.oldName !== r.newName ? (
                        <>
                          <span style={{ textDecoration: 'line-through', color: '#ef4444', fontWeight: 600 }}>{r.oldName}</span>
                          <span style={{ color: '#94a3b8' }}>←</span>
                          <span style={{ color: '#059669', fontWeight: 800 }}>{r.newName}</span>
                        </>
                      ) : (
                        <span>تعديل بيانات: {r.newName || r.oldName || '—'}</span>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                    {r.specialty    && <span style={chip}>{r.specialty}</span>}
                    {r.areaName     && <span style={chip}>📍 {r.areaName}</span>}
                    {r.pharmacyName && <span style={chip}>🏪 {r.pharmacyName}</span>}
                    {r.surveyName   && <span style={chip}>🗂️ {r.surveyName}</span>}
                  </div>

                  <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>👤 المندوب: <strong style={{ color: '#475569' }}>{r.editor}</strong></span>
                    <span>🕐 {fmtDate(r.editedAt)}</span>
                  </div>
                </div>

                {r.isUnread && (
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginTop: 6 }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 18 }}>
          <button disabled={page <= 1} onClick={() => load(page - 1, filter)} style={pgBtn(page <= 1)}>←</button>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => load(page + 1, filter)} style={pgBtn(page >= pages)}>→</button>
        </div>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #e8edf5', borderRadius: 20,
  padding: '3px 10px', fontSize: 12, color: '#475569', fontWeight: 500,
};
const pgBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 9, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', cursor: disabled ? 'default' : 'pointer',
  fontWeight: 700, opacity: disabled ? 0.4 : 1, fontFamily: 'inherit',
});
