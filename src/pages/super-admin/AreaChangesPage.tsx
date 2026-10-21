import { useState, useEffect, useCallback } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';

interface AreaChange {
  id: number;
  changedAt: string;
  isUnread: boolean;
  manager: string;
  managerRole: string | null;
  target: string;
  targetRole: string | null;
  added: string[];
  removed: string[];
  provinceMaterialized: boolean;
  kind?: 'areas' | 'profile';
  oldName?: string | null;
  newName?: string | null;
  isActive?: boolean | null;
}

const ROLE_LABEL: Record<string, string> = {
  company_manager:    'مدير شركة',
  office_hr:          'HR مكتب',
  office_manager:     'مدير مكتب',
  team_leader:        'قائد فريق',
  scientific_rep:     'مندوب علمي',
  commercial_rep:     'مندوب تجاري',
  supervisor:         'مشرف',
  product_manager:    'مدير منتج',
  office_employee:    'موظف مكتب',
  commercial_team_leader: 'قائد فريق تجاري',
  commercial_supervisor:  'مشرف تجاري',
};
const roleLabel = (r: string | null) => (r ? ROLE_LABEL[r] ?? r : '');

// تغييرات المدراء على مناطق المندوبين/التيم ليدرية — من ActivityLog (rep_areas_update)
export default function AreaChangesPage() {
  const { token } = useSuperAdmin();
  const H = { Authorization: `Bearer ${token}` };

  const [rows,    setRows]    = useState<AreaChange[]>([]);
  const [total,   setTotal]   = useState(0);
  const [page,    setPage]    = useState(1);
  const [pages,   setPages]   = useState(1);
  const [search,  setSearch]  = useState('');
  const [loading, setLoading] = useState(true);

  const limit = 50;

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) });
      const r = await fetch(`/api/super-admin/area-changes?${qs}`, { headers: H });
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
    load(1);
    fetch('/api/super-admin/area-changes/mark-seen', { method: 'POST', headers: H })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('ar-IQ', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  const q = search.trim().toLowerCase();
  const visible = q
    ? rows.filter(r => [r.manager, r.target, r.oldName ?? '', r.newName ?? '', ...r.added, ...r.removed].some(s => s.toLowerCase().includes(q)))
    : rows;

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: '#1e1b4b' }}>📍 تغييرات المناطق</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            تعديلات المدراء على مناطق المندوبين والتيم ليدرية — من غيّر، لمن، وأي منطقة أُضيفت أو حُذفت
          </p>
        </div>
        <div style={{ fontSize: 13, color: '#6366f1', fontWeight: 700, background: '#eef2ff', padding: '6px 14px', borderRadius: 10 }}>
          {total.toLocaleString('ar-IQ')} تغيير
        </div>
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="🔍 بحث باسم المدير أو المندوب أو المنطقة (في هذه الصفحة)..."
        style={{
          width: '100%', boxSizing: 'border-box', padding: '10px 14px', marginBottom: 16,
          borderRadius: 11, border: '1.5px solid #e2e8f0', fontSize: 13.5, fontFamily: 'inherit',
          outline: 'none', background: '#fff',
        }}
      />

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', fontSize: 14 }}>⏳ جاري التحميل...</div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', background: '#f8fafc', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
          لا توجد تغييرات {q ? 'مطابقة للبحث' : 'بعد'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map(r => (
            <div key={r.id} style={{
              background: r.isUnread ? '#fefce8' : '#fff',
              border: `1.5px solid ${r.isUnread ? '#fde68a' : '#eef2f7'}`,
              borderRadius: 14, padding: '14px 16px',
              boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
              display: 'flex', alignItems: 'flex-start', gap: 12,
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: 11, flexShrink: 0,
                background: '#6366f115', color: '#6366f1',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
              }}>{r.kind === 'profile' ? '👤' : '📍'}</div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>👔 {r.manager}</span>
                  {r.managerRole && <span style={roleChip}>{roleLabel(r.managerRole)}</span>}
                  <span style={{ color: '#94a3b8', fontWeight: 500 }}>{r.kind === 'profile' ? 'عدّل حساب' : 'عدّل مناطق'}</span>
                  <span>👤 {r.target}</span>
                  {r.targetRole && <span style={roleChip}>{roleLabel(r.targetRole)}</span>}
                </div>

                {r.newName && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center', fontSize: 12.5 }}>
                    <span style={{ fontWeight: 800, color: '#4f46e5' }}>✏️ تغيير الاسم:</span>
                    <span style={removeChip}>{r.oldName}</span>
                    <span style={{ color: '#94a3b8' }}>←</span>
                    <span style={addChip}>{r.newName}</span>
                  </div>
                )}
                {r.isActive != null && (
                  <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 800, color: r.isActive ? '#059669' : '#dc2626' }}>
                    {r.isActive ? '✅ تفعيل الحساب' : '🚫 تعطيل الحساب'}
                  </div>
                )}

                {r.added.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#059669' }}>➕ أُضيفت ({r.added.length}):</span>
                    {r.added.map(a => <span key={a} style={addChip}>{a}</span>)}
                  </div>
                )}
                {r.removed.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#dc2626' }}>➖ حُذفت ({r.removed.length}):</span>
                    {r.removed.map(a => <span key={a} style={removeChip}>{a}</span>)}
                  </div>
                )}

                <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span>🕐 {fmtDate(r.changedAt)}</span>
                  {r.provinceMaterialized && (
                    <span style={{ color: '#b45309' }}>🗺️ تحوّل تعيين المحافظة/القسم إلى مناطق صريحة</span>
                  )}
                </div>
              </div>

              {r.isUnread && (
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginTop: 6 }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 18 }}>
          <button disabled={page <= 1} onClick={() => load(page - 1)} style={pgBtn(page <= 1)}>←</button>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => load(page + 1)} style={pgBtn(page >= pages)}>→</button>
        </div>
      )}
    </div>
  );
}

const roleChip: React.CSSProperties = {
  background: '#f1f5f9', borderRadius: 20, padding: '2px 8px',
  fontSize: 11, color: '#64748b', fontWeight: 600,
};
const addChip: React.CSSProperties = {
  background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 20,
  padding: '3px 10px', fontSize: 12, color: '#047857', fontWeight: 600,
};
const removeChip: React.CSSProperties = {
  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 20,
  padding: '3px 10px', fontSize: 12, color: '#b91c1c', fontWeight: 600,
  textDecoration: 'line-through',
};
const pgBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 9, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', cursor: disabled ? 'default' : 'pointer',
  fontWeight: 700, opacity: disabled ? 0.4 : 1, fontFamily: 'inherit',
});
