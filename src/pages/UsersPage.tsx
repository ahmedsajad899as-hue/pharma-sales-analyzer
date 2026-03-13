import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface ScientificRep { id: number; name: string; }

interface User {
  id: number;
  username: string;
  role: 'admin' | 'manager' | 'user';
  isActive: boolean;
  createdAt: string;
  linkedRepId: number | null;
  linkedRep: ScientificRep | null;
}

type ModalType = 'add' | 'edit' | 'password' | null;

export default function UsersPage() {
  const { user: currentUser, token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [users, setUsers]     = useState<User[]>([]);
  const [sciReps, setSciReps] = useState<ScientificRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState<ModalType>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [saving, setSaving]   = useState(false);

  // Form fields
  const [fUsername,     setFUsername]     = useState('');
  const [fPassword,     setFPassword]     = useState('');
  const [fRole,         setFRole]         = useState<'admin' | 'manager' | 'user'>('user');
  const [fIsActive,     setFIsActive]     = useState(true);
  const [fLinkedRepId,  setFLinkedRepId]  = useState<number | ''>('');
  const [fNewPass,      setFNewPass]      = useState('');
  const [fConfirm,      setFConfirm]      = useState('');

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => { load(); }, [load]);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-add-user') {
        setFUsername(''); setFPassword(''); setFRole('user'); setFIsActive(true); setFLinkedRepId('');
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
    setFUsername(''); setFPassword(''); setFRole('user'); setFIsActive(true); setFLinkedRepId('');
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
        linkedRepId: fRole === 'user' && fLinkedRepId !== '' ? fLinkedRepId : null,
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
                      : 'badge--blue'
                    }`}>
                      {u.role === 'admin' ? `👑 ${t.users.admin}`
                        : u.role === 'manager' ? '🛡️ مدير الفريق'
                        : `👤 ${t.users.user}`}
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
                <select className="form-input" value={fRole} onChange={e => setFRole(e.target.value as any)}>
                  <option value="user">👤 {t.users.user}</option>
                  <option value="manager">🛡️ مدير الفريق</option>
                  <option value="admin">👑 {t.users.admin}</option>
                </select>
              </div>
              {fRole === 'user' && (
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
