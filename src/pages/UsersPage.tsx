import { useState, useEffect, useCallback } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface ScientificRep { id: number; name: string; }

interface User {
  id: number;
  username: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  linkedRepId: number | null;
  linkedRep: ScientificRep | null;
}

interface CompanyMember {
  id: number;
  username: string;
  role: string;
  isActive: boolean;
  linkedRepId: number | null;
  linkedRep: ScientificRep | null;
  areas: { id: number; name: string }[];
  companies: { id: number; name: string }[];
}

interface AreaItem { id: number; name: string; }

const ALL_ROLES: { value: string; label: string }[] = [
  { value: 'user',                   label: '👤 مستخدم' },
  { value: 'scientific_rep',         label: '🔬 مندوب علمي' },
  { value: 'team_leader',            label: '🎯 قائد فريق' },
  { value: 'supervisor',             label: '🔷 مشرف' },
  { value: 'product_manager',        label: '📦 مدير منتج' },
  { value: 'company_manager',        label: '🏭 مدير شركة' },
  { value: 'office_manager',         label: '🏢 مدير مكتب' },
  { value: 'commercial_rep',         label: '💼 مندوب تجاري' },
  { value: 'commercial_team_leader', label: '💼 قائد فريق تجاري' },
  { value: 'commercial_supervisor',  label: '💼 مشرف تجاري' },
  { value: 'manager',                label: '🛡️ مدير الفريق' },
  { value: 'admin',                  label: '👑 مدير النظام' },
];

type ModalType = 'add' | 'edit' | 'password' | null;

export default function UsersPage() {
  const { user: currentUser, token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const isCompanyManager = currentUser?.role === 'company_manager';

  const [users, setUsers]     = useState<User[]>([]);
  const [sciReps, setSciReps] = useState<ScientificRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState<ModalType>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [saving, setSaving]   = useState(false);

  // Company manager: company members view
  const [companyMembers, setCompanyMembers]       = useState<CompanyMember[]>([]);
  const [membersLoading, setMembersLoading]       = useState(true);
  const [membersError, setMembersError]           = useState('');
  const [areasModalMember, setAreasModalMember]   = useState<CompanyMember | null>(null);

  // Back button: close open modals in priority order
  useBackHandler([
    [areasModalMember !== null, () => setAreasModalMember(null)],
    [modal !== null,            () => setModal(null)],
  ]);
  const [allAreas, setAllAreas]                   = useState<AreaItem[]>([]);
  const [selectedAreaIds, setSelectedAreaIds]     = useState<Set<number>>(new Set());
  const [areasLoading, setAreasLoading]           = useState(false);
  const [areasSaving, setAreasSaving]             = useState(false);

  // Form fields
  const [fUsername,     setFUsername]     = useState('');
  const [fPassword,     setFPassword]     = useState('');
  const [fRole,         setFRole]         = useState<string>('user');
  const [fIsActive,     setFIsActive]     = useState(true);
  const [fLinkedRepId,  setFLinkedRepId]  = useState<number | ''>('');
  const [fNewPass,      setFNewPass]      = useState('');
  const [fConfirm,      setFConfirm]      = useState('');

  const load = useCallback(async () => {
    if (isCompanyManager) {
      setMembersLoading(true);
      setMembersError('');
      try {
        const r = await fetch('/api/company-members', { headers: authH() });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'فشل تحميل أعضاء الشركة');
        setCompanyMembers(j.data ?? []);
      } catch (err: any) { setMembersError(err.message || 'فشل تحميل أعضاء الشركة'); }
      finally { setMembersLoading(false); }
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [ur, rr] = await Promise.all([
        fetch('/api/admin/users', { headers: authH() }),
        fetch('/api/scientific-reps', { headers: authH() }),
      ]);
      const uj = await ur.json();
      const rj = await rr.json();
      if (!ur.ok) throw new Error(uj.error || 'فشل تحميل المستخدمين');
      setUsers(Array.isArray(uj.data) ? uj.data : []);
      const repsArr = Array.isArray(rj) ? rj : Array.isArray(rj?.data) ? rj.data : [];
      setSciReps(repsArr.map((r: any) => ({ id: r.id, name: r.name })));
    } catch (err: any) { setError(err.message || 'فشل تحميل المستخدمين'); }
    finally   { setLoading(false); }
  }, [isCompanyManager]);

  useEffect(() => { load(); }, [load]);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-add-user') {
        setFUsername(''); setFPassword(''); setFRole('scientific_rep'); setFIsActive(true); setFLinkedRepId('');
        setSelected(null);
        setModal('add');
      }
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  const openAdd = () => {
    setFUsername(''); setFPassword(''); setFRole('scientific_rep'); setFIsActive(true); setFLinkedRepId('');
    setSelected(null);
    setModal('add');
  };

  const openEdit = (u: User) => {
    setSelected(u);
    setFUsername(u.username);
    setFRole(u.role);
    setFIsActive(u.isActive);
    setFLinkedRepId(u.linkedRepId ?? '');
    setFPassword('');
    setModal('edit');
  };

  const openChangePassword = (u: User) => {
    setSelected(u);
    setFNewPass(''); setFConfirm('');
    setModal('password');
  };

  const saveUser = async () => {
    if (!fUsername.trim()) return setError('اسم المستخدم مطلوب.');
    if (modal === 'add' && (!fPassword || fPassword.length < 6)) return setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    setSaving(true);
    try {
      const body: any = {
        username: fUsername.trim(),
        role: fRole,
        isActive: fIsActive,
        linkedRepId: (fRole === 'user' || fRole === 'scientific_rep') && fLinkedRepId !== '' ? fLinkedRepId : null,
      };
      if (modal === 'add') body.password = fPassword;

      const url    = modal === 'add' ? '/api/admin/users' : `/api/admin/users/${selected!.id}`;
      const method = modal === 'add' ? 'POST' : 'PATCH';
      const r      = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body) });
      const j      = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الحفظ');
      setModal(null);
      load();
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const savePassword = async () => {
    if (!fNewPass || fNewPass.length < 6) return setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    if (fNewPass !== fConfirm) return setError('كلمات المرور غير متطابقة.');
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/users/${selected!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ password: fNewPass }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل تغيير كلمة المرور');
      setModal(null);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const deleteUser = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم وجميع بياناته؟')) return;
    const r = await fetch(`/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: authH(),
    });
    if (!r.ok) {
      const j = await r.json();
      setError(j.error || 'فشل الحذف');
      return;
    }
    load();
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString('ar-SA');

  const ROLE_LABELS: Record<string, string> = {
    scientific_rep: '🔬 مندوب علمي', team_leader: '🎯 قائد فريق', supervisor: '🔷 مشرف',
    product_manager: '📦 مدير منتج', company_manager: '🏭 مدير شركة',
    office_manager: '🏢 مدير مكتب', commercial_rep: '💼 مندوب تجاري',
    commercial_team_leader: '💼 قائد تجاري', commercial_supervisor: '💼 مشرف تجاري',
    manager: '🛡️ مدير', admin: '👑 أدمن', user: '👤 مستخدم',
  };

  const openAreasModal = async (member: CompanyMember) => {
    setAreasModalMember(member);
    setSelectedAreaIds(new Set(member.areas.map(a => a.id)));
    setAreasLoading(true);
    try {
      const r = await fetch(`/api/company-members/${member.id}/areas`, { headers: authH() });
      const j = await r.json();
      if (r.ok) {
        setAllAreas(j.allAreas ?? []);
        setSelectedAreaIds(new Set(j.assignedAreaIds ?? []));
      }
    } catch { /* keep existing */ }
    finally { setAreasLoading(false); }
  };

  const saveAreas = async () => {
    if (!areasModalMember) return;
    setAreasSaving(true);
    try {
      const r = await fetch(`/api/company-members/${areasModalMember.id}/areas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ areaIds: [...selectedAreaIds] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل حفظ المناطق');
      // Update member's areas locally
      setCompanyMembers(prev => prev.map(m =>
        m.id === areasModalMember.id ? { ...m, areas: j.areas ?? [] } : m
      ));
      setAreasModalMember(null);
      window.dispatchEvent(new Event('areas-changed'));
    } catch (err: any) { alert(err.message || 'فشل حفظ المناطق'); }
    finally { setAreasSaving(false); }
  };

  // ── Company Manager View ─────────────────────────────────────
  if (isCompanyManager) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">👥 أعضاء الشركة</h1>
            <p className="page-subtitle">المندوبون والمديرون في شركتك</p>
          </div>
          <button onClick={load} style={{ fontSize: 13, padding: '6px 14px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>🔄 تحديث</button>
        </div>

        {membersError && <div className="alert alert--error">{membersError}</div>}

        {membersLoading ? (
          <div className="loading-spinner">جاري التحميل...</div>
        ) : companyMembers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
            <p>لا يوجد أعضاء في شركتك حتى الآن</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>يمكن للأدمن إضافة مندوبين وربطهم بشركتك</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {companyMembers.map(member => (
              <div key={member.id} style={{
                background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
                padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14,
                boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
              }}>
                {/* Avatar */}
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                  background: '#eef2ff', color: '#4f46e5',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 900, fontSize: 20,
                }}>
                  {member.username[0]?.toUpperCase()}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{member.username}</div>
                  <div style={{ fontSize: 12, color: '#6366f1', marginTop: 2 }}>
                    {ROLE_LABELS[member.role] ?? member.role}
                    {!member.isActive && <span style={{ color: '#ef4444', marginRight: 8 }}>● غير نشط</span>}
                  </div>
                  {member.linkedRep && (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                      🔬 {member.linkedRep.name}
                    </div>
                  )}
                  {/* Areas chips */}
                  {member.areas.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                      {member.areas.map(a => (
                        <span key={a.id} style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 12,
                          background: '#e0f2fe', color: '#0369a1', fontWeight: 600,
                        }}>📍 {a.name}</span>
                      ))}
                    </div>
                  )}
                  {member.areas.length === 0 && (
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>📍 لم تُحدد مناطق — سيُشمل جميع المناطق في اقتراح البلان</div>
                  )}
                </div>

                {/* Actions */}
                <button
                  onClick={() => openAreasModal(member)}
                  style={{
                    padding: '6px 12px', fontSize: 12, fontWeight: 700,
                    background: '#eef2ff', color: '#4f46e5',
                    border: '1px solid #c7d2fe', borderRadius: 8, cursor: 'pointer',
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  📍 تحديد المناطق
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Areas Modal ── */}
        {areasModalMember && (
          <div className="modal-overlay" onClick={() => setAreasModalMember(null)}>
            <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>📍 مناطق عمل {areasModalMember.username}</h2>
                <button className="modal-close" onClick={() => setAreasModalMember(null)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>
                  حدد المناطق المسموح بها لاقتراح بلان هذا المندوب. إذا لم تختر أي منطقة سيُشمل جميع المناطق.
                </p>
                {areasLoading ? (
                  <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8' }}>⏳ جاري التحميل...</div>
                ) : (
                  <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {allAreas.map(area => (
                      <label key={area.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        borderRadius: 8, cursor: 'pointer',
                        background: selectedAreaIds.has(area.id) ? '#eef2ff' : '#f8fafc',
                        border: `1px solid ${selectedAreaIds.has(area.id) ? '#c7d2fe' : '#e2e8f0'}`,
                      }}>
                        <input
                          type="checkbox"
                          checked={selectedAreaIds.has(area.id)}
                          onChange={e => {
                            setSelectedAreaIds(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(area.id);
                              else next.delete(area.id);
                              return next;
                            });
                          }}
                          style={{ width: 16, height: 16, accentColor: '#6366f1' }}
                        />
                        <span style={{ fontSize: 14, color: '#1e293b' }}>📍 {area.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn--secondary" onClick={() => setAreasModalMember(null)}>إلغاء</button>
                <button className="btn btn--primary" onClick={saveAreas} disabled={areasSaving}>
                  {areasSaving ? '⏳ جاري الحفظ...' : '💾 حفظ المناطق'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t.users.title}</h1>
          <p className="page-subtitle">{t.users.subtitle}</p>
        </div>
        <button className="btn btn--primary" onClick={openAdd}>{t.users.addBtn}</button>
      </div>

      {error && <div className="alert alert--error" onClick={() => setError('')}>{error} ✕</div>}

      {loading ? (
        <div className="loading-spinner">{t.common.loading}</div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t.users.colUsername}</th>
                <th>{t.users.colRole}</th>
                <th>المندوب المرتبط</th>
                <th>{t.reps.colStatus}</th>
                <th>{t.dashboard.colDate}</th>
                <th>{t.users.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td colSpan={7} className="empty-row">{t.users.noUsers}</td></tr>
              ) : users.map(u => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    <strong>{u.username}</strong>
                    {u.id === currentUser?.id && <span className="tag tag--blue" style={{ marginRight: 8 }}>أنت</span>}
                  </td>
                  <td>
                    <span className={`badge ${
                      u.role === 'admin' ? 'badge--purple'
                      : u.role === 'manager' ? 'badge--orange'
                      : u.role === 'company_manager' || u.role === 'office_manager' ? 'badge--orange'
                      : u.role === 'scientific_rep' || u.role === 'team_leader' || u.role === 'supervisor' ? 'badge--green'
                      : 'badge--blue'
                    }`}>
                      {ALL_ROLES.find(r => r.value === u.role)?.label ?? `👤 ${u.role}`}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, color: '#475569' }}>
                    {u.linkedRep ? (
                      <span className="tag tag--blue">🔬 {u.linkedRep.name}</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${u.isActive ? 'badge--green' : 'badge--red'}`}>
                      {u.isActive ? t.reps.active : t.reps.inactive}
                    </span>
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="action-btns">
                      <button className="btn-icon btn-icon--blue"   onClick={() => openEdit(u)}           title="تعديل">✏️</button>
                      <button className="btn-icon btn-icon--orange" onClick={() => openChangePassword(u)} title="تغيير كلمة المرور">🔑</button>
                      {u.id !== currentUser?.id && (
                        <button className="btn-icon btn-icon--red" onClick={() => deleteUser(u.id)} title="حذف">🗑️</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add / Edit Modal ── */}
      {(modal === 'add' || modal === 'edit') && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{modal === 'add' ? `➕ ${t.users.addTitle}` : `✏️ ${t.users.editTitle}`}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t.users.colUsername} *</label>
                <input className="form-input" value={fUsername} onChange={e => setFUsername(e.target.value)} placeholder={t.users.usernamePlaceholder} />
              </div>
              {modal === 'add' && (
                <div className="form-group">
                  <label className="form-label">{t.users.passwordPlaceholder} * (6+)</label>
                  <input className="form-input" type="password" value={fPassword} onChange={e => setFPassword(e.target.value)} placeholder="••••••••" />
                </div>
              )}
              <div className="form-group">
                <label className="form-label">{t.users.colRole}</label>
                <select className="form-input" value={fRole} onChange={e => setFRole(e.target.value)}>
                  {ALL_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              {(fRole === 'user' || fRole === 'scientific_rep') && (
                <div className="form-group">
                  <label className="form-label">🔬 ربط بمندوب علمي (اختياري)</label>
                  <select
                    className="form-input"
                    value={fLinkedRepId}
                    onChange={e => setFLinkedRepId(e.target.value === '' ? '' : parseInt(e.target.value))}
                  >
                    <option value="">— بدون ربط</option>
                    {sciReps.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <small style={{ color: '#64748b', fontSize: 12 }}>ربط هذا الحساب بمندوب علمي محدد حتى يستلم بلاناته.</small>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">{t.reps.colStatus}</label>
                <select className="form-input" value={fIsActive ? 'true' : 'false'} onChange={e => setFIsActive(e.target.value === 'true')}>
                  <option value="true">✅ {t.reps.active}</option>
                  <option value="false">🚫 {t.reps.inactive}</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.users.cancel}</button>
              <button className="btn btn--primary" onClick={saveUser} disabled={saving}>
                {saving ? t.common.loading : `💾 ${t.users.save}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Password Modal ── */}
      {modal === 'password' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🔑 تغيير كلمة مرور: {selected?.username}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">كلمة المرور الجديدة *</label>
                <input className="form-input" type="password" value={fNewPass} onChange={e => setFNewPass(e.target.value)} placeholder="••••••••" />
              </div>
              <div className="form-group">
                <label className="form-label">تأكيد كلمة المرور *</label>
                <input className="form-input" type="password" value={fConfirm} onChange={e => setFConfirm(e.target.value)} placeholder="••••••••" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>إلغاء</button>
              <button className="btn btn--primary" onClick={savePassword} disabled={saving}>
                {saving ? '⏳...' : '🔑 تغيير'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
