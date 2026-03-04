import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem  { id: number; name: string; }
interface Company    { id: number; name: string; items: NamedItem[]; }
interface ScientificRep {
  id: number; name: string; phone?: string; email?: string; company?: string; notes?: string; isActive: boolean;
  areas: NamedItem[]; items: NamedItem[]; companies: NamedItem[]; commercialReps: NamedItem[];
}

type ModalType = 'add' | 'edit' | 'assign' | null;
type AssignTab = 'areas' | 'companies' | 'items' | 'commercialReps';
type AreaViewMode = 'flat' | 'byRep';
interface CommercialWithAreas { id: number; name: string; areas: NamedItem[]; }

export default function ScientificRepsPage() {
  const { token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [reps, setReps]         = useState<ScientificRep[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [modal, setModal]       = useState<ModalType>(null);
  const [selected, setSelected] = useState<ScientificRep | null>(null);

  // Form fields
  const [fName, setFName]       = useState('');
  const [fPhone, setFPhone]     = useState('');
  const [fEmail, setFEmail]     = useState('');
  const [fCompany, setFCompany] = useState('');
  const [fNotes, setFNotes]     = useState('');

  // Assignment modal
  const [assignTab, setAssignTab]           = useState<AssignTab>('areas');
  const [selAreas, setSelAreas]             = useState<NamedItem[]>([]);
  const [selItems, setSelItems]             = useState<NamedItem[]>([]);
  const [selCommercial, setSelCommercial]   = useState<NamedItem[]>([]);
  const [allAreas, setAllAreas]             = useState<NamedItem[]>([]);
  const [allItems, setAllItems]             = useState<NamedItem[]>([]);
  const [allCommercial, setAllCommercial]   = useState<NamedItem[]>([]);
  const [newAreaName, setNewAreaName]       = useState('');
  const [newItemName, setNewItemName]       = useState('');
  const [search, setSearch]                 = useState('');
  const [saving, setSaving]                 = useState(false);
  const [areaViewMode, setAreaViewMode]       = useState<AreaViewMode>('flat');
  const [allCommercialWithAreas, setAllCommercialWithAreas] = useState<CommercialWithAreas[]>([]);
  const [selectedCommRepId, setSelectedCommRepId] = useState<number | null>(null);
  const [allCompanies, setAllCompanies]           = useState<Company[]>([]);
  const [selCompanies, setSelCompanies]           = useState<NamedItem[]>([]);
  const [filterCompanyId, setFilterCompanyId]     = useState<number | 'all'>('all');
  // ─── Load ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/scientific-reps`, { headers: authH() });
      let j: any;
      try { j = await r.json(); } catch { throw new Error(`${t.common.serverError} (HTTP ${r.status})`); }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setReps(Array.isArray(j.data) ? j.data : []);
    } catch (err: any) { setError(`${t.sciReps.errorLoad}: ${err.message || t.sciReps.errorUnknown}`); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const loadAllOptions = useCallback(async () => {
    const safe = (p: Promise<any>) => p.catch(() => ({ data: [] }));
    const [ar, it, cr, crAreas, co] = await Promise.all([
      safe(fetch(`${API}/api/areas`,                              { headers: authH() }).then(r => r.json())),
      safe(fetch(`${API}/api/items`,                              { headers: authH() }).then(r => r.json())),
      safe(fetch(`${API}/api/representatives`,                    { headers: authH() }).then(r => r.json())),
      safe(fetch(`${API}/api/representatives/with-sales-areas`,   { headers: authH() }).then(r => r.json())),
      safe(fetch(`${API}/api/companies`,                          { headers: authH() }).then(r => r.json())),
    ]);
    setAllAreas(Array.isArray(ar.data) ? ar.data : []);
    setAllItems(Array.isArray(it.data) ? it.data : []);
    setAllCompanies(Array.isArray(co.data) ? co.data : []);
    const crList = Array.isArray(cr.data) ? cr.data : (Array.isArray(cr) ? cr : []);
    setAllCommercial(crList);
    const crAreasList = Array.isArray(crAreas.data) ? crAreas.data : [];
    setAllCommercialWithAreas(crAreasList.filter((r: any) => r.areas?.length > 0));
  }, [token]);

  // ─── Open modals ───────────────────────────────────────────
  const openAdd = () => {
    setFName(''); setFPhone(''); setFEmail(''); setFCompany(''); setFNotes('');
    setModal('add');
  };

  const openEdit = (rep: ScientificRep) => {
    setSelected(rep);
    setFName(rep.name); setFPhone(rep.phone || ''); setFEmail(rep.email || ''); setFCompany(rep.company || ''); setFNotes(rep.notes || '');
    setModal('edit');
  };

  const openAssign = async (rep: ScientificRep) => {
    setSelected(rep);
    setSelAreas(rep.areas ?? []);
    setSelItems(rep.items ?? []);
    setSelCompanies(rep.companies ?? []);
    setSelCommercial(rep.commercialReps ?? []);
    setAssignTab('areas');
    setSearch('');
    setNewAreaName('');
    setNewItemName('');
    setAreaViewMode('flat');
    setSelectedCommRepId(null);
    setFilterCompanyId('all');
    setModal('assign');           // افتح المودال أولاً حتى لو فشل التحميل
    try {
      await loadAllOptions();
    } catch (err: any) {
      setError(`${t.sciReps.errorAssignLoad}: ${err.message}`);
    }
  };

  // ─── Save ──────────────────────────────────────────────────
  const saveRep = async () => {
    if (!fName.trim()) return;
    setSaving(true);
    try {
      const body = { name: fName.trim(), phone: fPhone || null, email: fEmail || null, company: fCompany || null, notes: fNotes || null };
      if (modal === 'add') {
        const r = await fetch(`${API}/api/scientific-reps`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body) });
        if (!r.ok) { const e = await r.json(); throw new Error(e.message || t.sciReps.errorAdd); }
      } else if (modal === 'edit' && selected) {
        const r = await fetch(`${API}/api/scientific-reps/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body) });
        if (!r.ok) { const e = await r.json(); throw new Error(e.message || t.sciReps.errorEdit); }
      }
      setModal(null); load();
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const saveAssign = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const id = selected.id;
      await Promise.all([
        fetch(`${API}/api/scientific-reps/${id}/areas`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({ areaNames: selAreas.map(a => a.name) }),
        }),
        fetch(`${API}/api/scientific-reps/${id}/items`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({ itemNames: selItems.map(i => i.name) }),
        }),
        fetch(`${API}/api/scientific-reps/${id}/companies`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({ companyIds: selCompanies.map(c => c.id) }),
        }),
        fetch(`${API}/api/scientific-reps/${id}/commercial-reps`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({ commercialRepIds: selCommercial.map(c => c.id) }),
        }),
      ]);
      setModal(null); load();
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const deleteRep = async (id: number) => {
    if (!confirm(t.sciReps.deleteConfirm)) return;
    await fetch(`${API}/api/scientific-reps/${id}`, { method: 'DELETE', headers: authH() });
    load();
  };

  // ─── Toggle helpers ────────────────────────────────────────
  const toggleArea = (a: NamedItem) =>
    setSelAreas(prev => prev.some(x => x.id === a.id) ? prev.filter(x => x.id !== a.id) : [...prev, a]);

  const toggleItem = (i: NamedItem) =>
    setSelItems(prev => prev.some(x => x.id === i.id) ? prev.filter(x => x.id !== i.id) : [...prev, i]);

  // When checking a company → add its items; when unchecking → remove its items
  // (only removes items not shared by another still-selected company)
  const toggleCompany = (co: Company) => {
    const isSelected = selCompanies.some(x => x.id === co.id);
    if (isSelected) {
      // Remove company from selection
      const remainingCompanies = selCompanies.filter(x => x.id !== co.id);
      setSelCompanies(remainingCompanies);
      // Collect item IDs still covered by the remaining selected companies
      const stillCoveredIds = new Set(
        remainingCompanies.flatMap(rc => {
          const full = allCompanies.find(c => c.id === rc.id);
          return full ? full.items.map(i => i.id) : [];
        })
      );
      // Remove this company's items that are no longer covered by any selected company
      const removeIds = new Set(co.items.map(i => i.id));
      setSelItems(prev => prev.filter(i => !removeIds.has(i.id) || stillCoveredIds.has(i.id)));
    } else {
      // Add company and its items
      setSelCompanies(prev => [...prev, { id: co.id, name: co.name }]);
      setSelItems(prev => {
        const existing = new Set(prev.map(x => x.id));
        const newOnes = co.items.filter(i => !existing.has(i.id));
        return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
      });
    }
  };

  const [deletingCompany, setDeletingCompany] = useState<number | null>(null);
  const deleteCompany = async (id: number) => {
    setDeletingCompany(id);
    try {
      const res = await fetch(`${API}/api/companies/${id}`, { method: 'DELETE', headers: authH() });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      setAllCompanies(prev => prev.filter(c => c.id !== id));
      setSelCompanies(prev => prev.filter(c => c.id !== id));
    } catch (err: any) { setError(err.message || t.sciReps.errorDelete); }
    finally { setDeletingCompany(null); }
  };

  const toggleCommercial = (c: NamedItem) =>
    setSelCommercial(prev => prev.some(x => x.id === c.id) ? prev.filter(x => x.id !== c.id) : [...prev, c]);

  const addCustomArea = () => {
    const name = newAreaName.trim();
    if (!name || selAreas.some(a => a.name === name)) return;
    setSelAreas(prev => [...prev, { id: Date.now(), name }]);
    setNewAreaName('');
  };

  const addCustomItem = () => {
    const name = newItemName.trim();
    if (!name || selItems.some(i => i.name === name)) return;
    setSelItems(prev => [...prev, { id: Date.now(), name }]);
    setNewItemName('');
  };

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t.sciReps.title}</h1>
          <p className="page-subtitle">{t.sciReps.subtitle}</p>
        </div>
        <button className="btn btn--primary" onClick={openAdd}>{t.sciReps.addBtn}</button>
      </div>

      {error && (
        <div className="alert alert--error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }} onClick={() => setError('')}>
          <span>{error}</span>
          <button
            onClick={e => { e.stopPropagation(); setError(''); load(); }}
            style={{ background: '#fca5a5', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 700, color: '#7f1d1d', whiteSpace: 'nowrap' }}
          >
            {t.sciReps.retry}
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-spinner">{t.sciReps.loading}</div>
      ) : (
        <>
          {/* ── Desktop table ── */}
          <div className="rep-desktop-table table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.sciReps.colNum}</th>
                  <th>{t.sciReps.colName}</th>
                  <th>{t.sciReps.colPhone}</th>
                  <th>{t.sciReps.colCompany}</th>
                  <th>{t.sciReps.colAreas}</th>
                  <th>{t.sciReps.colItems}</th>
                  <th>{t.reps.colAreas} / {t.reps.colName}</th>
                  <th>{t.reps.colStatus}</th>
                  <th>{t.sciReps.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {reps.length === 0 ? (
                  <tr><td colSpan={9} className="empty-row">{t.sciReps.noReps}</td></tr>
                ) : reps.map(rep => (
                  <tr key={rep.id}>
                    <td>{rep.id}</td>
                    <td><strong>{rep.name}</strong>{rep.notes && <div className="row-note">{rep.notes}</div>}</td>
                    <td>{rep.phone || '—'}</td>
                    <td>
                      <div className="tag-list">
                        {(rep.companies ?? []).length === 0
                          ? <span style={{ color: '#94a3b8' }}>—</span>
                          : (rep.companies ?? []).map(c => <span key={c.id} className="tag" style={{ background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa' }}>{c.name}</span>)
                        }
                      </div>
                    </td>
                    <td>
                      <div className="tag-list">
                        {rep.areas.length === 0
                          ? <span className="tag tag--blue">{t.sciReps.allAreas}</span>
                          : rep.areas.map(a => <span key={a.id} className="tag tag--gray">{a.name}</span>)
                        }
                      </div>
                    </td>
                    <td>
                      <div className="tag-list">
                        {rep.items.length === 0
                          ? <span className="tag tag--green">{t.sciReps.allItems}</span>
                          : rep.items.slice(0, 3).map(i => <span key={i.id} className="tag tag--purple">{i.name}</span>)
                        }
                        {rep.items.length > 3 && (
                          <span className="tag tag--gray" title={rep.items.slice(3).map(i => i.name).join('\n')} style={{ cursor: 'help', borderBottom: '1px dashed #94a3b8' }}>
                            +{rep.items.length - 3} {t.sciReps.moreItemsSuffix}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="tag-list">
                        {rep.commercialReps.length === 0
                          ? <span className="tag tag--orange">{t.sciReps.allCommReps}</span>
                          : rep.commercialReps.slice(0, 2).map(c => <span key={c.id} className="tag tag--orange">{c.name}</span>)
                        }
                        {rep.commercialReps.length > 2 && <span className="tag tag--gray">+{rep.commercialReps.length - 2}</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${rep.isActive ? 'badge--green' : 'badge--red'}`}>
                        {rep.isActive ? t.sciReps.active : t.sciReps.inactive}
                      </span>
                    </td>
                    <td>
                      <div className="action-btns">
                        <button className="btn-icon btn-icon--blue"   onClick={() => openEdit(rep)}   title={t.sciReps.editTooltip}>✏️</button>
                        <button className="btn-icon btn-icon--green"  onClick={() => openAssign(rep)} title={t.sciReps.assignTooltip}>🔗</button>
                        <button className="btn-icon btn-icon--red"    onClick={() => deleteRep(rep.id)} title={t.sciReps.deleteTooltip}>🗑️</button>
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
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: '32px 0', fontSize: 14 }}>{t.sciReps.noRepsHint}</div>
            ) : reps.map(rep => (
              <div key={rep.id} className="rep-mobile-card">
                <div className="rep-mobile-card-header">
                  <div>
                    <div className="rep-mobile-card-name">{rep.name}</div>
                    {rep.phone && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{rep.phone}</div>}
                    {rep.notes && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{rep.notes}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className={`badge ${rep.isActive ? 'badge--green' : 'badge--red'}`} style={{ fontSize: 11 }}>
                      {rep.isActive ? t.sciReps.active : t.sciReps.inactive}
                    </span>
                    <div className="rep-mobile-card-actions">
                      <button className="btn-icon btn-icon--blue"  onClick={() => openEdit(rep)}    title={t.sciReps.editTooltip}>✏️</button>
                      <button className="btn-icon btn-icon--green" onClick={() => openAssign(rep)}  title={t.sciReps.assignTooltip}>🔗</button>
                      <button className="btn-icon btn-icon--red"   onClick={() => deleteRep(rep.id)} title={t.sciReps.deleteTooltip}>🗑️</button>
                    </div>
                  </div>
                </div>

                {(rep.companies ?? []).length > 0 && (
                  <div className="rep-mobile-card-row">
                    <span className="rep-mobile-card-label">{t.sciReps.labelCompany}</span>
                    <div className="tag-list" style={{ flex: 1 }}>
                      {(rep.companies ?? []).map(c => <span key={c.id} className="tag" style={{ background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', fontSize: 11 }}>{c.name}</span>)}
                    </div>
                  </div>
                )}

                <div className="rep-mobile-card-row">
                  <span className="rep-mobile-card-label">{t.sciReps.labelAreas}</span>
                  <div className="tag-list" style={{ flex: 1 }}>
                    {rep.areas.length === 0
                      ? <span className="tag tag--blue" style={{ fontSize: 11 }}>{t.sciReps.allAreas}</span>
                      : rep.areas.map(a => <span key={a.id} className="tag tag--gray" style={{ fontSize: 11 }}>{a.name}</span>)
                    }
                  </div>
                </div>

                <div className="rep-mobile-card-row">
                  <span className="rep-mobile-card-label">{t.sciReps.labelItems}</span>
                  <div className="tag-list" style={{ flex: 1 }}>
                    {rep.items.length === 0
                      ? <span className="tag tag--green" style={{ fontSize: 11 }}>{t.sciReps.allItems}</span>
                      : <>
                          {rep.items.slice(0, 4).map(i => <span key={i.id} className="tag tag--purple" style={{ fontSize: 11 }}>{i.name}</span>)}
                          {rep.items.length > 4 && <span className="tag tag--gray" style={{ fontSize: 11 }}>+{rep.items.length - 4}</span>}
                        </>
                    }
                  </div>
                </div>

                {rep.commercialReps.length > 0 && (
                  <div className="rep-mobile-card-row">
                    <span className="rep-mobile-card-label">{t.sciReps.labelCommercial}</span>
                    <div className="tag-list" style={{ flex: 1 }}>
                      {rep.commercialReps.slice(0, 3).map(c => <span key={c.id} className="tag tag--orange" style={{ fontSize: 11 }}>{c.name}</span>)}
                      {rep.commercialReps.length > 3 && <span className="tag tag--gray" style={{ fontSize: 11 }}>+{rep.commercialReps.length - 3}</span>}
                    </div>
                  </div>
                )}
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
              <h2>{modal === 'add' ? `➕ ${t.sciReps.addTitle}` : `✏️ ${t.sciReps.editTitle}`}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t.sciReps.formLabelName}</label>
                <input className="form-input" value={fName} onChange={e => setFName(e.target.value)} placeholder={t.sciReps.namePlaceholderFull} />
              </div>
              <div className="form-group">
                <label className="form-label">{t.sciReps.formLabelPhone}</label>
                <input className="form-input" value={fPhone} onChange={e => setFPhone(e.target.value)} placeholder="05xxxxxxxx" />
              </div>
              <div className="form-group">
                <label className="form-label">{t.sciReps.formLabelCompany}</label>
                <input className="form-input" value={fCompany} onChange={e => setFCompany(e.target.value)} placeholder={t.sciReps.companyNamePlaceholder} />
              </div>
              <div className="form-group">
                <label className="form-label">{t.sciReps.formLabelEmail}</label>
                <input className="form-input" value={fEmail} onChange={e => setFEmail(e.target.value)} placeholder="email@example.com" />
              </div>
              <div className="form-group">
                <label className="form-label">{t.sciReps.formLabelNotes}</label>
                <input className="form-input" value={fNotes} onChange={e => setFNotes(e.target.value)} placeholder={t.sciReps.notesOptionalPlaceholder} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.sciReps.cancel}</button>
              <button className="btn btn--primary" onClick={saveRep} disabled={saving || !fName.trim()}>
                {saving ? t.sciReps.savingIcon : t.sciReps.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Modal */}
      {modal === 'assign' && selected && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🔗 {t.sciReps.assignTitle} — <span style={{ color: '#6366f1' }}>{selected.name}</span></h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>

            {/* Tabs */}
            <div style={{ padding: '0 24px' }}>
              <div className="tabs">
                <button className={`tab ${assignTab === 'areas' ? 'tab--active' : ''}`} onClick={() => setAssignTab('areas')}>
                  📍 {t.sciReps.tabAreas} ({selAreas.length || t.sciReps.allLabel})
                </button>
                <button className={`tab ${assignTab === 'companies' ? 'tab--active' : ''}`} onClick={() => setAssignTab('companies')}>
                  🏢 {t.sciReps.tabCompanies} ({selCompanies.length || '—'})
                </button>
                <button className={`tab ${assignTab === 'items' ? 'tab--active' : ''}`} onClick={() => setAssignTab('items')}>
                  💊 {t.sciReps.tabItems} ({selItems.length || t.sciReps.allLabel})
                </button>
                <button className={`tab ${assignTab === 'commercialReps' ? 'tab--active' : ''}`} onClick={() => setAssignTab('commercialReps')}>
                  👤 {t.sciReps.tabCommReps} ({selCommercial.length || t.sciReps.allLabel})
                </button>
              </div>
            </div>

            <div className={`modal-body assign-body${assignTab !== 'commercialReps' ? ' assign-body--dual' : ''}`}>

              {/* ── Companies tab ────────────────────────────────────────── */}
              {assignTab === 'companies' ? (
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>

                  {/* LEFT — available companies checklist */}
                  <div style={{ flex: '0 0 52%', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', padding: '16px 14px' }}>
                    {(() => {
                      const realCos   = allCompanies.filter(c => c.items.length > 0);
                      const orphanCos = allCompanies.filter(c => c.items.length === 0);
                      return (
                        <>
                          <div style={{ fontWeight: 700, fontSize: '13px', color: '#475569', marginBottom: '8px' }}>
                            {t.sciReps.availableCompanies}
                            <span style={{ marginRight: '6px', background: '#e2e8f0', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: '#64748b' }}>
                              {realCos.length}
                            </span>
                          </div>
                          {realCos.length === 0 ? (
                            <p className="form-hint" style={{ color: '#f59e0b' }}>{t.sciReps.noCompaniesWarning}</p>
                          ) : (
                            <div className="options-list" style={{ flex: 1 }}>
                              {realCos.map(co => (
                                <label key={co.id} className="option-row" style={{ alignItems: 'flex-start', gap: '8px', padding: '8px 4px' }}>
                                  <input
                                    type="checkbox"
                                    checked={selCompanies.some(x => x.id === co.id)}
                                    onChange={() => toggleCompany(co)}
                                    style={{ marginTop: '2px', accentColor: '#c2410c' }}
                                  />
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '13px' }}>{co.name}</div>
                                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                                      {co.items.length} {t.sciReps.itemSingular}: {co.items.slice(0, 4).map(i => i.name).join(t.sciReps.listSep)}
                                      {co.items.length > 4 && ` … +${co.items.length - 4}`}
                                    </div>
                                    {selCompanies.some(x => x.id === co.id) ? (
                                      <div
                                        style={{ fontSize: '11px', color: '#2563eb', marginTop: '3px', cursor: 'pointer', textDecoration: 'underline' }}
                                        onClick={e => { e.preventDefault(); setFilterCompanyId(co.id); setSearch(''); setAssignTab('items'); }}
                                      >
                                        {t.sciReps.viewInItemsTabPre} {co.items.length} {t.sciReps.viewInItemsTabPost}
                                      </div>
                                    ) : null}
                                  </div>
                                </label>
                              ))}
                            </div>
                          )}

                          {/* Orphan companies — 0 items: likely customer/pharmacy names */}
                          {orphanCos.length > 0 && (
                            <div style={{ marginTop: '10px', borderTop: '1px dashed #fca5a5', paddingTop: '8px' }}>
                              <div style={{ fontSize: '12px', color: '#ef4444', fontWeight: 700, marginBottom: '6px' }}>
                                {t.sciReps.orphanCompaniesPrefix} ({orphanCos.length}) {t.sciReps.orphanCompaniesSuffix}
                              </div>
                              {orphanCos.map(co => (
                                <div key={co.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 4px', borderRadius: '6px', background: '#fff1f2', marginBottom: '4px' }}>
                                  <span style={{ fontSize: '13px', color: '#6b7280' }}>🚫 {co.name}</span>
                                  <button
                                    onClick={() => deleteCompany(co.id)}
                                    disabled={deletingCompany === co.id}
                                    style={{ background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: '5px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 700 }}
                                  >
                                    {deletingCompany === co.id ? '...' : t.sciReps.deleteCompanyBtn}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* RIGHT — selected companies tags */}
                  <div style={{ flex: '0 0 48%', display: 'flex', flexDirection: 'column', padding: '16px 14px', background: '#fafafa', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <span style={{ fontWeight: 700, fontSize: '13px', color: '#475569' }}>{t.sciReps.selectedCompanies}</span>
                      {selCompanies.length > 0 && (
                        <button onClick={() => setSelCompanies([])}
                          style={{ background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: '6px', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
                          {t.sciReps.clearAll}
                        </button>
                      )}
                    </div>
                    {selCompanies.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#94a3b8', gap: '8px' }}>
                        <span style={{ fontSize: '32px' }}>🏢</span>
                        <p style={{ fontSize: '13px', textAlign: 'center' }}>{t.sciReps.noCompanySelected}</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                        {selCompanies.map(co => (
                          <span key={co.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', borderRadius: '8px', padding: '5px 10px', fontSize: '13px', fontWeight: 600 }}>
                            🏢 {co.name}
                            <button onClick={() => setSelCompanies(prev => prev.filter(x => x.id !== co.id))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9a3412', padding: 0, lineHeight: 1, fontSize: '12px', fontWeight: 700 }}>✕</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {selCompanies.length > 0 && (
                      <>
                        <div style={{ marginTop: '16px', padding: '10px', background: '#eff6ff', borderRadius: '8px', fontSize: '12px', color: '#1e40af', border: '1px solid #93c5fd' }}>
                          {t.sciReps.autoAddHint}
                        </div>

                        {/* Items preview grouped by company */}
                        <div style={{ marginTop: '14px', flex: 1, overflowY: 'auto' }}>
                          <div style={{ fontWeight: 700, fontSize: '12px', color: '#475569', marginBottom: '8px' }}>
                            {t.sciReps.companyItemsTitle}
                            <span style={{ marginRight: '6px', background: '#e2e8f0', borderRadius: '999px', padding: '1px 7px', fontSize: '11px', color: '#64748b' }}>
                              {selCompanies.reduce((acc, sc) => {
                                const full = allCompanies.find(c => c.id === sc.id);
                                return acc + (full?.items.length ?? 0);
                              }, 0)}
                            </span>
                          </div>
                          {selCompanies.map(sc => {
                            const full = allCompanies.find(c => c.id === sc.id);
                            if (!full || full.items.length === 0) return null;
                            return (
                              <div key={sc.id} style={{ marginBottom: '10px' }}>
                                <div style={{ fontSize: '11px', fontWeight: 700, color: '#c2410c', marginBottom: '5px', paddingBottom: '3px', borderBottom: '1px dashed #fed7aa' }}>
                                  🏢 {sc.name}
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                  {full.items.map(item => (
                                    <span
                                      key={item.id}
                                      style={{
                                        fontSize: '10px',
                                        padding: '2px 7px',
                                        borderRadius: '999px',
                                        background: selItems.some(i => i.id === item.id) ? '#dcfce7' : '#f1f5f9',
                                        color: selItems.some(i => i.id === item.id) ? '#15803d' : '#64748b',
                                        border: `1px solid ${selItems.some(i => i.id === item.id) ? '#86efac' : '#e2e8f0'}`,
                                        fontWeight: selItems.some(i => i.id === item.id) ? 700 : 400,
                                        whiteSpace: 'nowrap',
                                        lineHeight: '1.6',
                                      }}
                                    >
                                      {selItems.some(i => i.id === item.id) ? '✓ ' : ''}{item.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>

              ) : assignTab === 'items' ? (
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>

                  {/* LEFT PANE — available checklist */}
                  <div style={{ flex: '0 0 52%', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', padding: '16px 14px' }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#475569', marginBottom: '8px' }}>
                      {t.sciReps.availableItems}
                    </div>

                    {/* Company filter */}
                    {allCompanies.length > 0 && (
                      <div style={{ marginBottom: '8px' }}>
                        <select
                          className="form-input"
                          style={{ fontSize: '13px', background: filterCompanyId === 'all' ? '#fff' : '#fff7ed', color: filterCompanyId === 'all' ? '#374151' : '#c2410c', fontWeight: filterCompanyId === 'all' ? 400 : 700, borderColor: filterCompanyId === 'all' ? '#e2e8f0' : '#fcd34d' }}
                          value={filterCompanyId}
                          onChange={e => { setFilterCompanyId(e.target.value === 'all' ? 'all' : Number(e.target.value)); setSearch(''); }}
                        >
                          <option value="all">{t.sciReps.allCompaniesOption}</option>
                          {allCompanies.map(co => (
                            <option key={co.id} value={co.id}>{co.name} ({co.items.length} {t.sciReps.itemSingular})</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Search */}
                    <input
                      className="form-input"
                      style={{ marginBottom: '8px', fontSize: '13px' }}
                      placeholder={t.sciReps.searchItems}
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />

                    {/* Add custom item */}
                    <div className="input-row" style={{ marginBottom: '8px' }}>
                      <input className="form-input" style={{ fontSize: '13px' }} value={newItemName}
                        onChange={e => setNewItemName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addCustomItem()}
                        placeholder={t.sciReps.addNewItem} />
                      <button className="btn btn--primary" onClick={addCustomItem} style={{ whiteSpace: 'nowrap', fontSize: '12px', padding: '6px 10px' }}>{t.sciReps.addBtnShort}</button>
                    </div>

                    {/* Select All row */}
                    {(() => {
                      const companyItems = filterCompanyId === 'all' ? allItems : (allCompanies.find(co => co.id === filterCompanyId)?.items ?? []);
                      const filtered = companyItems.filter(i => i.name.toLowerCase().includes(search.toLowerCase()));
                      if (filtered.length === 0) return null;
                      const allChecked = filtered.every(i => selItems.some(x => x.name === i.name));
                      const someChecked = !allChecked && filtered.some(i => selItems.some(x => x.name === i.name));
                      return (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 4px', borderBottom: '1.5px solid #e2e8f0', marginBottom: '4px', fontWeight: 700, color: '#6366f1', fontSize: '13px', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={allChecked}
                            ref={el => { if (el) el.indeterminate = someChecked; }}
                            onChange={() => {
                              if (allChecked) {
                                const names = new Set(filtered.map(x => x.name));
                                setSelItems(prev => prev.filter(x => !names.has(x.name)));
                              } else {
                                setSelItems(prev => { const names = new Set(prev.map(x => x.name)); return [...prev, ...filtered.filter(i => !names.has(i.name))]; });
                              }
                            }}
                            style={{ accentColor: '#6366f1' }}
                          />
                          <span>{allChecked ? t.sciReps.deselectAll : t.sciReps.selectAll} ({filtered.length})</span>
                        </label>
                      );
                    })()}

                    {/* Checklist */}
                    <div className="options-list" style={{ flex: 1 }}>
                      {(filterCompanyId === 'all' ? allItems : (allCompanies.find(co => co.id === filterCompanyId)?.items ?? []))
                        .filter(i => i.name.toLowerCase().includes(search.toLowerCase()))
                        .map(i => (
                          <label key={i.id} className="option-row">
                            <input type="checkbox" checked={selItems.some(x => x.name === i.name)} onChange={() => toggleItem(i)} />
                            <span>{i.name}</span>
                          </label>
                        ))
                      }
                      {allItems.length === 0 && <p className="form-hint">{t.sciReps.noItemsHint}</p>}
                      {allItems.length > 0 && filterCompanyId !== 'all' && (allCompanies.find(co => co.id === filterCompanyId)?.items ?? []).length === 0 && (
                        <p className="form-hint">{t.sciReps.noItemsForCompany}</p>
                      )}
                    </div>
                  </div>

                  {/* RIGHT PANE — selected items grouped alphabetically */}
                  <div style={{ flex: '0 0 48%', display: 'flex', flexDirection: 'column', padding: '16px 14px', background: '#fafafa' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <span style={{ fontWeight: 700, fontSize: '13px', color: '#475569' }}>{t.sciReps.selectedItems}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ background: '#6366f1', color: '#fff', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 700 }}>
                          {selItems.length}
                        </span>
                        {selItems.length > 0 && (
                          <button
                            onClick={() => setSelItems([])}
                            style={{ background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: '6px', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                          >
                            {t.sciReps.clearAll}
                          </button>
                        )}
                      </div>
                    </div>

                    {selItems.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#94a3b8', gap: '8px' }}>
                        <span style={{ fontSize: '32px' }}>💊</span>
                        <p style={{ fontSize: '13px', textAlign: 'center' }}>{t.sciReps.noItemsSelected}<br/><span style={{ fontSize: '11px' }}>{t.sciReps.allItemsIncluded}</span></p>
                      </div>
                    ) : (
                      <div style={{ flex: 1, overflowY: 'auto' }}>
                        {/* Group by first character */}
                        {Object.entries(
                          selItems.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar')).reduce<Record<string, NamedItem[]>>((acc, item) => {
                            const key = item.name.charAt(0).toUpperCase();
                            if (!acc[key]) acc[key] = [];
                            acc[key].push(item);
                            return acc;
                          }, {})
                        ).map(([letter, group]) => (
                          <div key={letter} style={{ marginBottom: '10px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: '#6366f1', background: '#ede9fe', borderRadius: '4px', padding: '2px 8px', marginBottom: '4px', display: 'inline-block' }}>
                              {letter} · {group.length}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {group.map(i => (
                                <span
                                  key={i.id}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: '#f0fdf4', color: '#065f46', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', fontWeight: 500 }}
                                >
                                  {i.name}
                                  <button
                                    onClick={() => setSelItems(prev => prev.filter(x => x.id !== i.id))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#064e3b', padding: 0, lineHeight: 1, fontSize: '11px', fontWeight: 700 }}
                                  >✕</button>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

              ) : assignTab === 'areas' ? (
                /* ── Areas: dual-pane layout ── */
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>

                  {/* LEFT — checklist */}
                  <div style={{ flex: '0 0 52%', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', padding: '16px 14px' }}>

                    {/* View mode toggle */}
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                      <button
                        onClick={() => { setAreaViewMode('flat'); setSearch(''); }}
                        style={{ flex: 1, padding: '5px 0', fontSize: '12px', fontWeight: 700, borderRadius: '6px', border: '1.5px solid', cursor: 'pointer',
                          background: areaViewMode === 'flat' ? '#6366f1' : '#f1f5f9',
                          color:      areaViewMode === 'flat' ? '#fff'    : '#475569',
                          borderColor: areaViewMode === 'flat' ? '#6366f1' : '#e2e8f0' }}
                      >{t.sciReps.flatMode}</button>
                      <button
                        onClick={() => { setAreaViewMode('byRep'); setSearch(''); }}
                        style={{ flex: 1, padding: '5px 0', fontSize: '12px', fontWeight: 700, borderRadius: '6px', border: '1.5px solid', cursor: 'pointer',
                          background: areaViewMode === 'byRep' ? '#0ea5e9' : '#f1f5f9',
                          color:      areaViewMode === 'byRep' ? '#fff'    : '#475569',
                          borderColor: areaViewMode === 'byRep' ? '#0ea5e9' : '#e2e8f0' }}
                      >{t.sciReps.byRepMode}</button>
                    </div>

                    {areaViewMode === 'flat' ? (
                      /* ─ Flat list mode ─ */
                      <>
                        <div style={{ fontWeight: 700, fontSize: '13px', color: '#475569', marginBottom: '8px' }}>
                          {t.sciReps.availableAreas}
                          <span style={{ marginRight: '6px', background: '#e2e8f0', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: '#64748b' }}>
                            {allAreas.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).length}
                          </span>
                        </div>
                        <input className="form-input" style={{ marginBottom: '8px', fontSize: '13px' }}
                          placeholder={t.sciReps.searchAreas}
                          value={search} onChange={e => setSearch(e.target.value)} />
                        <div className="input-row" style={{ marginBottom: '8px' }}>
                          <input className="form-input" style={{ fontSize: '13px' }} value={newAreaName}
                            onChange={e => setNewAreaName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && addCustomArea()}
                            placeholder={t.sciReps.addNewArea} />
                          <button className="btn btn--primary" onClick={addCustomArea} style={{ whiteSpace: 'nowrap', fontSize: '12px', padding: '6px 10px' }}>{t.sciReps.addBtnShort}</button>
                        </div>
                        {(() => {
                          const filtered = allAreas.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
                          if (filtered.length === 0) return null;
                          const allChecked = filtered.every(a => selAreas.some(x => x.name === a.name));
                          const someChecked = !allChecked && filtered.some(a => selAreas.some(x => x.name === a.name));
                          return (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 4px', borderBottom: '1.5px solid #e2e8f0', marginBottom: '4px', fontWeight: 700, color: '#6366f1', fontSize: '13px', cursor: 'pointer' }}>
                              <input type="checkbox" checked={allChecked}
                                ref={el => { if (el) el.indeterminate = someChecked; }}
                                onChange={() => {
                                  if (allChecked) { const names = new Set(filtered.map(x => x.name)); setSelAreas(prev => prev.filter(x => !names.has(x.name))); }
                                  else { setSelAreas(prev => { const names = new Set(prev.map(x => x.name)); return [...prev, ...filtered.filter(a => !names.has(a.name))]; }); }
                                }}
                                style={{ accentColor: '#6366f1' }} />
                              <span>{allChecked ? t.sciReps.deselectAll : t.sciReps.selectAll} ({filtered.length})</span>
                            </label>
                          );
                        })()}
                        <div className="options-list" style={{ flex: 1 }}>
                          {allAreas.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).map(a => (
                            <label key={a.id} className="option-row">
                              <input type="checkbox" checked={selAreas.some(x => x.name === a.name)} onChange={() => toggleArea(a)} />
                              <span>{a.name}</span>
                            </label>
                          ))}
                          {allAreas.length === 0 && <p className="form-hint">{t.sciReps.noAreasHint}</p>}
                        </div>
                      </>
                    ) : (
                      /* ─ By-commercial-rep mode ─ */
                      <>
                        <style>{`
                          .rep-card { border:1.5px solid #e2e8f0; border-radius:8px; margin-bottom:4px; background:#fff; overflow:hidden; }
                          .rep-card-header { display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:default; background:#fff; min-height:38px; }
                          .rep-card:hover { border-color:#0ea5e9; background:#f0f9ff; }
                          .rep-card:hover .rep-card-header { background:#f0f9ff; }
                          .rep-card-areas { display:flex; flex-direction:column; gap:2px; border-top:0px solid #bae6fd; padding:0 12px; background:#f8fbff; max-height:0; opacity:0; overflow:hidden; transition: max-height 0.25s ease 0.8s, opacity 0.2s ease 0.8s, padding 0.1s ease 0.8s, border-top-width 0s ease 0.8s; }
                          .rep-card:hover .rep-card-areas { max-height:400px; opacity:1; padding:6px 12px 10px; border-top-width:1px; }
                          .rep-area-row { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; cursor:pointer; }
                          .rep-area-row:hover { background:#e0f2fe; }
                          .rep-area-row.checked { background:#e0f2fe; }
                        `}</style>
                        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                          {allCommercialWithAreas.length === 0 && (
                            <p style={{ fontSize: '12px', color: '#f59e0b', margin: '8px 0' }}>{t.sciReps.noCommercialWithAreas}</p>
                          )}
                          {allCommercialWithAreas.map(rep => {
                            const repAreas      = rep.areas;
                            const selCount      = repAreas.filter(a => selAreas.some(x => x.name === a.name)).length;
                            const allChecked    = selCount === repAreas.length && repAreas.length > 0;
                            const someChecked   = selCount > 0 && !allChecked;
                            const commRep       = allCommercial.find(c => c.id === rep.id) ?? { id: rep.id, name: rep.name };

                            // add/remove commercial rep based on whether any area of his is still selected
                            const syncCommRep = (newAreas: NamedItem[]) => {
                              const hasAnyArea = repAreas.some(a => newAreas.some(x => x.name === a.name));
                              setSelCommercial(prev => {
                                const already = prev.some(c => c.id === rep.id);
                                if (hasAnyArea && !already) return [...prev, commRep];
                                if (!hasAnyArea && already) return prev.filter(c => c.id !== rep.id);
                                return prev;
                              });
                            };

                            return (
                              <div key={rep.id} className="rep-card">
                                <div className="rep-card-header">
                                  <input type="checkbox" checked={allChecked}
                                    ref={el => { if (el) el.indeterminate = someChecked; }}
                                    onChange={() => {
                                      if (allChecked) {
                                        const names = new Set(repAreas.map(a => a.name));
                                        setSelAreas(prev => { const next = prev.filter(x => !names.has(x.name)); syncCommRep(next); return next; });
                                      } else {
                                        setSelAreas(prev => { const names = new Set(prev.map(x => x.name)); const next = [...prev, ...repAreas.filter(a => !names.has(a.name))]; syncCommRep(next); return next; });
                                      }
                                    }}
                                    style={{ accentColor: '#0ea5e9', width: '15px', height: '15px', flexShrink: 0 }}
                                  />
                                  <span style={{ flex: 1, fontWeight: 700, fontSize: '13px', color: '#1e40af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rep.name}</span>
                                  <span style={{ fontSize: '11px', background: selCount > 0 ? '#0ea5e9' : '#e2e8f0', color: selCount > 0 ? '#fff' : '#64748b', borderRadius: '999px', padding: '1px 8px', fontWeight: 700, flexShrink: 0 }}>
                                    {selCount > 0 ? `${selCount}/${repAreas.length}` : `${repAreas.length} ${t.sciReps.areaCountLabel}`}
                                  </span>
                                </div>
                                <div className="rep-card-areas">
                                  {repAreas.map(a => (
                                    <label key={a.id} className={`rep-area-row${selAreas.some(x => x.name === a.name) ? ' checked' : ''}`}>
                                      <input type="checkbox" checked={selAreas.some(x => x.name === a.name)}
                                        onChange={() => {
                                          setSelAreas(prev => {
                                            const next = prev.some(x => x.id === a.id)
                                              ? prev.filter(x => x.id !== a.id)
                                              : [...prev, a];
                                            syncCommRep(next);
                                            return next;
                                          });
                                        }}
                                        style={{ accentColor: '#0ea5e9', width: '14px', height: '14px', flexShrink: 0 }} />
                                      <span style={{ fontSize: '13px', color: '#0f172a' }}>{a.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                  {/* RIGHT — selected areas */}
                  <div style={{ flex: '0 0 48%', display: 'flex', flexDirection: 'column', padding: '16px 14px', background: '#fafafa' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <span style={{ fontWeight: 700, fontSize: '13px', color: '#475569' }}>{t.sciReps.selectedAreas}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ background: '#0ea5e9', color: '#fff', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 700 }}>
                          {selAreas.length || t.sciReps.allLabel}
                        </span>
                        {selAreas.length > 0 && (
                          <button onClick={() => setSelAreas([])}
                            style={{ background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: '6px', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
                            {t.sciReps.clearAll}
                          </button>
                        )}
                      </div>
                    </div>

                    {selAreas.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#94a3b8', gap: '8px' }}>
                        <span style={{ fontSize: '32px' }}>📍</span>
                        <p style={{ fontSize: '13px', textAlign: 'center' }}>{t.sciReps.noAreasSelected}<br/><span style={{ fontSize: '11px' }}>{t.sciReps.allAreasIncluded}</span></p>
                      </div>
                    ) : (
                      <div style={{ flex: 1, overflowY: 'auto' }}>
                        {Object.entries(
                          selAreas.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar')).reduce<Record<string, NamedItem[]>>((acc, area) => {
                            const key = area.name.charAt(0).toUpperCase();
                            if (!acc[key]) acc[key] = [];
                            acc[key].push(area);
                            return acc;
                          }, {})
                        ).map(([letter, group]) => (
                          <div key={letter} style={{ marginBottom: '10px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: '#0ea5e9', background: '#e0f2fe', borderRadius: '4px', padding: '2px 8px', marginBottom: '4px', display: 'inline-block' }}>
                              {letter} · {group.length}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {group.map(a => (
                                <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', fontWeight: 500 }}>
                                  {a.name}
                                  <button onClick={() => setSelAreas(prev => prev.filter(x => x.id !== a.id))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#0c4a6e', padding: 0, lineHeight: 1, fontSize: '11px', fontWeight: 700 }}>✕</button>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

              ) : (
                /* ── Commercial Reps: standard single-pane layout ── */
                <>
                  <p className="form-hint">{t.sciReps.commercialRepsHint}</p>

                  <input
                    className="form-input"
                    style={{ marginBottom: '10px' }}
                    placeholder={t.common.search}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />

                  {/* Selected tags */}
                  <div className="tag-list tag-list--wrap" style={{ minHeight: '36px', marginBottom: '10px' }}>
                    {selCommercial.length === 0
                      ? <span className="tag tag--blue">{t.sciReps.allCommercialTag}</span>
                      : selCommercial.map(c => (
                        <span key={c.id} className="tag tag--removable" style={{ background: '#fff7ed', color: '#9a3412' }}>
                          {c.name}<button onClick={() => setSelCommercial(prev => prev.filter(x => x.id !== c.id))}>✕</button>
                        </span>
                      ))
                    }
                  </div>

                  {/* Select All / Deselect All */}
                  {(() => {
                    const filtered = allCommercial.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
                    const allChecked = filtered.length > 0 && filtered.every(c => selCommercial.some(x => x.id === (c as any).id));
                    const someChecked = !allChecked && filtered.some(c => selCommercial.some(x => x.id === (c as any).id));
                    const selectAll   = () => setSelCommercial(prev => { const ids = new Set(prev.map(x => x.id)); return [...prev, ...(filtered as any[]).filter(c => !ids.has(c.id))]; });
                    const deselectAll = () => { const ids = new Set((filtered as any[]).map(x => x.id)); setSelCommercial(prev => prev.filter(x => !ids.has(x.id))); };
                    if (filtered.length === 0) return null;
                    return (
                      <label className="option-row" style={{ borderBottom: '1.5px solid #e2e8f0', marginBottom: '4px', paddingBottom: '10px', fontWeight: 700, color: '#6366f1' }}>
                        <input type="checkbox" checked={allChecked}
                          ref={el => { if (el) el.indeterminate = someChecked; }}
                          onChange={() => allChecked ? deselectAll() : selectAll()}
                          style={{ accentColor: '#6366f1' }} />
                        <span>{allChecked ? t.sciReps.deselectAll : t.sciReps.selectAll} ({filtered.length})</span>
                      </label>
                    );
                  })()}

                  <div className="options-list">
                    {allCommercial
                      .filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
                      .map(c => (
                        <label key={c.id} className="option-row">
                          <input type="checkbox" checked={selCommercial.some(x => x.id === c.id)} onChange={() => toggleCommercial(c)} />
                          <span>{c.name}</span>
                        </label>
                      ))
                    }
                    {allCommercial.length === 0 && <p className="form-hint">{t.sciReps.noCommercialReps}</p>}
                  </div>
                </>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.sciReps.cancel}</button>
              <button className="btn btn--primary" onClick={saveAssign} disabled={saving}>
                {saving ? t.sciReps.savingAssign : t.sciReps.saveAssignBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
