import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { PageId } from '../App';

const API = import.meta.env.VITE_API_URL || '';

interface Rep {
  id: number;
  name: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  areas: { area: { id: number; name: string } }[];
  items: { item: { id: number; name: string } }[];
}

interface AreaItem { id: number; name: string; }

interface Props { activeFileIds: number[]; onNavigate?: (page: PageId) => void; }

export default function RepresentativesPage({ activeFileIds, onNavigate }: Props) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [reps, setReps]       = useState<Rep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState<'add' | 'edit' | 'assign' | null>(null);
  const [selected, setSelected] = useState<Rep | null>(null);

  // Form state
  const [formName, setFormName]   = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');

  // Assign state
  const [areaInput, setAreaInput]     = useState('');
  const [assignedAreas, setAssignedAreas] = useState<AreaItem[]>([]);

  const loadReps = async () => {
    if (activeFileIds.length === 0) {
      setReps([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const url = `${API}/api/representatives?fileIds=${activeFileIds.join(',')}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      let json: any;
      try { json = await res.json(); } catch { throw new Error(`${t.common.serverError} (HTTP ${res.status})`); }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
      setReps(list);
    } catch (err: any) {
      setError(`${t.reps.errorLoad}: ${err.message || t.common.error}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadReps(); }, [activeFileIds.join(','), token]);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-add-rep') {
        setFormName(''); setFormPhone(''); setFormEmail('');
        setModal('add');
      }
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  const openAdd = () => {
    setFormName(''); setFormPhone(''); setFormEmail('');
    setModal('add');
  };

  const openEdit = (rep: Rep) => {
    setSelected(rep);
    setFormName(rep.name); setFormPhone(rep.phone || ''); setFormEmail(rep.email || '');
    setModal('edit');
  };

  const openAssign = (rep: Rep) => {
    setSelected(rep);
    // rep.areas is [{ area: { id, name } }] — flatten to AreaItem[]
    const flat = (rep.areas || []).map(a => ({ id: a.area.id, name: a.area.name }));
    setAssignedAreas(flat);
    setAreaInput('');
    setModal('assign');
  };

  const saveRep = async () => {
    if (!formName.trim()) return;
    const body = { name: formName.trim(), phone: formPhone, email: formEmail };
    try {
      if (modal === 'add') {
        const r = await fetch(`${API}/api/representatives`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.message || e.error || t.reps.errorAdd); }
      } else if (modal === 'edit' && selected) {
        const r = await fetch(`${API}/api/representatives/${selected.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.message || e.error || t.reps.errorEdit); }
      }
      setModal(null);
      loadReps();
    } catch {
      setError(t.reps.errorSave);
    }
  };

  const deleteRep = async (id: number) => {
    if (!confirm(t.reps.deleteConfirm)) return;
    await fetch(`${API}/api/representatives/${id}`, { method: 'DELETE', headers: authH() });
    loadReps();
  };

  const saveAssign = async () => {
    if (!selected) return;
    const areaNames = assignedAreas.map(a => a.name).filter(Boolean);
    const r = await fetch(`${API}/api/representatives/${selected.id}/areas/by-name`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH() },
      body: JSON.stringify({ areaNames }),
    });
    if (!r.ok) { const e = await r.json(); setError(e.message || t.reps.errorSave); return; }
    setModal(null);
    loadReps();
  };

  const addArea = () => {
    const name = areaInput.trim();
    if (!name) return;
    if (assignedAreas.some(a => a.name === name)) return; // avoid duplicates
    setAssignedAreas(prev => [...prev, { id: Date.now(), name }]);
    setAreaInput('');
  };

  const removeArea = (id: number) => setAssignedAreas(prev => prev.filter(a => a.id !== id));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t.reps.title}</h1>
          <p className="page-subtitle">{t.reps.subtitle}</p>
        </div>
        <button className="btn btn--primary" onClick={openAdd}>{t.reps.addBtn}</button>
      </div>

      {error && (
        <div style={{
          background: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
          borderLeft: '4px solid #f43f5e',
          borderRadius: '0 14px 14px 0',
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 4px 20px rgba(244,63,94,0.12)',
          marginBottom: 4,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: '#fecdd3',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
          }}>⚠️</div>
          <span style={{ flex: 1, color: '#881337', fontSize: 13, fontWeight: 500 }}>{error}</span>
          <button
            onClick={loadReps}
            style={{
              background: 'linear-gradient(135deg,#f43f5e,#e11d48)',
              border: 'none', borderRadius: 20,
              padding: '6px 16px', fontSize: 12, cursor: 'pointer',
              fontWeight: 700, color: '#fff', whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(244,63,94,0.35)',
            }}
          >
            🔄 {t.reps.retry}
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-spinner">{t.common.loading}</div>
      ) : (
        <>
          {/* ── Desktop table ── */}
          <div className="rep-desktop-table table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.reps.colNum}</th>
                  <th>{t.reps.colName}</th>
                  <th>{t.reps.colPhone}</th>
                  <th>{t.reps.colAreas}</th>
                  <th>{t.reps.colStatus}</th>
                  <th>{t.reps.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {reps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row">
                    {activeFileIds.length === 0
                      ? t.reps.noFileWarning
                      : t.reps.noReps}
                  </td>
                </tr>
                ) : reps.map(rep => (
                  <tr key={rep.id}>
                    <td>{rep.id}</td>
                    <td><strong>{rep.name}</strong></td>
                    <td>{rep.phone || '—'}</td>
                    <td>
                      <div className="tag-list">
                        {rep.areas.length === 0
                          ? <span className="tag tag--blue">{t.reps.allAreas}</span>
                          : rep.areas.map(a => <span key={a.area.id} className="tag tag--gray">{a.area.name}</span>)
                        }
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${rep.isActive ? 'badge--green' : 'badge--red'}`}>
                        {rep.isActive ? t.reps.active : t.reps.inactive}
                      </span>
                    </td>
                    <td>
                      <div className="action-btns">
                        <button className="btn-icon btn-icon--blue" onClick={() => openEdit(rep)} title={t.reps.editBtn}>✏️</button>
                        <button className="btn-icon btn-icon--green" onClick={() => openAssign(rep)} title={t.reps.assignBtn}>📍</button>
                        <button className="btn-icon btn-icon--red" onClick={() => deleteRep(rep.id)} title={t.reps.deleteBtn}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Mobile card list ── */}
          <div className="rep-mobile-cards">
            {reps.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: '32px 0', fontSize: 14 }}>
                {activeFileIds.length === 0 ? t.reps.noFileWarning : t.reps.noReps}
              </div>
            ) : reps.map(rep => (
              <div key={rep.id} className="rep-mobile-card">
                <div className="rep-mobile-card-header">
                  <div>
                    <div className="rep-mobile-card-name">{rep.name}</div>
                    {rep.phone && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{rep.phone}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className={`badge ${rep.isActive ? 'badge--green' : 'badge--red'}`} style={{ fontSize: 11 }}>
                      {rep.isActive ? t.reps.active : t.reps.inactive}
                    </span>
                    <div className="rep-mobile-card-actions">
                      <button className="btn-icon btn-icon--blue" onClick={() => openEdit(rep)} title={t.reps.editBtn}>✏️</button>
                      <button className="btn-icon btn-icon--green" onClick={() => openAssign(rep)} title={t.reps.assignBtn}>📍</button>
                      <button className="btn-icon btn-icon--red" onClick={() => deleteRep(rep.id)} title={t.reps.deleteBtn}>🗑️</button>
                    </div>
                  </div>
                </div>
                <div className="rep-mobile-card-row">
                  <span className="rep-mobile-card-label">📍 {t.reps.colAreas}:</span>
                  <div className="tag-list" style={{ flex: 1 }}>
                    {rep.areas.length === 0
                      ? <span className="tag tag--blue">{t.reps.allAreas}</span>
                      : rep.areas.map(a => <span key={a.area.id} className="tag tag--gray">{a.area.name}</span>)
                    }
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add / Edit Modal */}
      {(modal === 'add' || modal === 'edit') && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{modal === 'add' ? t.reps.addTitle : t.reps.editTitle}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t.reps.colName} *</label>
                <input className="form-input" value={formName} onChange={e => setFormName(e.target.value)} placeholder={t.reps.namePlaceholder} />
              </div>
              <div className="form-group">
                <label className="form-label">{t.reps.colPhone}</label>
                <input className="form-input" value={formPhone} onChange={e => setFormPhone(e.target.value)} placeholder={t.reps.phonePlaceholder} />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input className="form-input" value={formEmail} onChange={e => setFormEmail(e.target.value)} placeholder={t.reps.emailPlaceholder} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.reps.cancel}</button>
              <button className="btn btn--primary" onClick={saveRep}>{t.reps.save}</button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Areas Modal */}
      {modal === 'assign' && selected && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t.reps.assignTitle} — {selected.name}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t.reps.addArea}</label>
                <div className="input-row">
                  <input
                    className="form-input"
                    value={areaInput}
                    onChange={e => setAreaInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addArea()}
                    placeholder={t.reps.areaPlaceholder}
                  />
                  <button className="btn btn--primary" onClick={addArea}>{t.reps.addArea}</button>
                </div>
              </div>
              <div className="tag-list tag-list--wrap">
                {assignedAreas.map(a => (
                  <span key={a.id} className="tag tag--removable">
                    {a.name}
                    <button onClick={() => removeArea(a.id)}>✕</button>
                  </span>
                ))}
                {assignedAreas.length === 0 && <span className="form-hint">{t.reps.allAreas}</span>}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.reps.cancel}</button>
              <button className="btn btn--primary" onClick={saveAssign}>{t.reps.save}</button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom warning when no file active */}
      {activeFileIds.length === 0 && (
        <div style={{
          position: 'sticky', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #6d28d9 100%)',
          padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 13, color: '#e0e7ff', fontWeight: 500,
          zIndex: 100,
          boxShadow: '0 -6px 32px rgba(99,102,241,0.45)',
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, flexShrink: 0,
          }}>📂</div>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
              {t.reps.noActiveFileTitle}
            </div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              {t.reps.noFileWarning}
            </div>
          </div>
          <div
            onClick={() => onNavigate?.('upload')}
            className="upload-badge-pulse"
            style={{
              padding: '7px 18px',
              backdropFilter: 'blur(8px)',
              borderRadius: 24,
              fontSize: 12, fontWeight: 700, color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)',
              whiteSpace: 'nowrap', letterSpacing: '0.3px',
              cursor: 'pointer',
            }}
          >{t.common.uploadPageBtn}</div>
        </div>
      )}
    </div>
  );
}
