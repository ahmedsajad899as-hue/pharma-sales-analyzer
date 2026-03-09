import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

interface Office   { id: number; name: string; }
interface Company  { id: number; name: string; officeId: number; isActive: boolean; notes?: string; office?: { name: string }; _count?: { items: number; lines: number }; }
interface Item     { id: number; name: string; scientificName?: string; dosage?: string; form?: string; price?: number | null; scientificMessage?: string; }
interface Line     { id: number; name?: string; isActive: boolean; lineItems: { item: Item }[]; }
interface CompanyDetail extends Company { items: Item[]; lines: Line[]; }
interface ItemForm { name: string; scientificName: string; dosage: string; form: string; price: string; scientificMessage: string; }

// ─── Org-chart types ──────────────────────────────────────────────────────
interface OrgUser {
  id: number; username: string; displayName?: string | null;
  role: string; isActive: boolean; phone?: string | null;
  managerIds: number[]; subordinateIds: number[];
}
interface OrgData {
  company: CompanyDetail;
  users: OrgUser[];
}

// ─── Role colours / labels / icons ───────────────────────────────────────
const ROLE_META: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  company_manager:        { label: 'مدير شركة',          color: '#7c3aed', bg: '#f5f3ff', icon: '👔' },
  supervisor:             { label: 'مشرف',                color: '#1d4ed8', bg: '#eff6ff', icon: '🗂️' },
  product_manager:        { label: 'مدير منتج',           color: '#0369a1', bg: '#e0f2fe', icon: '📦' },
  team_leader:            { label: 'قائد فريق',           color: '#0891b2', bg: '#ecfeff', icon: '👥' },
  scientific_rep:         { label: 'مندوب علمي',          color: '#059669', bg: '#f0fdf4', icon: '🔬' },
  commercial_supervisor:  { label: 'مشرف تجاري',          color: '#b45309', bg: '#fffbeb', icon: '💼' },
  commercial_team_leader: { label: 'قائد فريق تجاري',     color: '#c2410c', bg: '#fff7ed', icon: '🏢' },
  commercial_rep:         { label: 'مندوب تجاري',         color: '#dc2626', bg: '#fff1f2', icon: '🏷️' },
  office_manager:         { label: 'مدير مكتب',           color: '#4f46e5', bg: '#eef2ff', icon: '🏛️' },
  office_hr:              { label: 'HR مكتب',             color: '#0d9488', bg: '#f0fdfa', icon: '👤' },
  office_employee:        { label: 'موظف مكتب',           color: '#6b7280', bg: '#f9fafb', icon: '🖥️' },
  admin:                  { label: 'مدير',                 color: '#374151', bg: '#f9fafb', icon: '⚙️' },
  manager:                { label: 'مدير',                 color: '#374151', bg: '#f9fafb', icon: '⚙️' },
};
const DEF_META = { label: 'مستخدم', color: '#64748b', bg: '#f8fafc', icon: '👤' };

// ─── CSS injected once for the tree connectors ────────────────────────────
const ORG_CSS = `
  .otree-root { list-style:none; margin:0; padding:0; display:flex; flex-wrap:nowrap; justify-content:center; }
  .otree-ul   { list-style:none; margin:0; padding:0; display:flex; flex-wrap:nowrap; justify-content:center;
                padding-top:20px; position:relative; }
  .otree-ul::before { content:''; position:absolute; top:0; left:50%; border-left:2px solid #cbd5e1; width:0; height:20px; }
  .otree-li { display:inline-flex; flex-direction:column; align-items:center; position:relative; padding:20px 8px 0; text-align:center; }
  .otree-li::before,.otree-li::after { content:''; position:absolute; top:0; right:50%; border-top:2px solid #cbd5e1; width:50%; height:20px; }
  .otree-li::after  { right:auto; left:50%; border-left:2px solid #cbd5e1; }
  .otree-li:only-child::before,.otree-li:only-child::after { display:none; }
  .otree-li:only-child { padding-top:0; }
  .otree-li:first-child::before,.otree-li:last-child::after { border:0 none; }
  .otree-li:last-child::before  { border-right:2px solid #cbd5e1; border-radius:0 5px 0 0; }
  .otree-li:first-child::after  { border-radius:5px 0 0 0; }
`;

// ─── Single node card ─────────────────────────────────────────────────────
function OrgCard({ u }: { u: OrgUser }) {
  const m = ROLE_META[u.role] ?? DEF_META;
  return (
    <div style={{
      background: m.bg, border: `1px solid ${m.color}33`, borderTop: `3px solid ${m.color}`,
      borderRadius: 10, padding: '10px 12px', minWidth: 140, maxWidth: 180,
      display: 'inline-block', verticalAlign: 'top',
      opacity: u.isActive ? 1 : 0.6, boxShadow: '0 1px 4px #0001',
    }}>
      <div style={{ fontSize: 20, marginBottom: 3 }}>{m.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 12, color: '#1e293b', marginBottom: 2, lineHeight: 1.4 }}>
        {u.displayName || u.username}
      </div>
      <span style={{ fontSize: 10, color: m.color, fontWeight: 600, background: `${m.color}18`, borderRadius: 20, padding: '1px 7px' }}>
        {m.label}
      </span>
      {u.phone && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>{u.phone}</div>}
      {!u.isActive && <div style={{ fontSize: 9, color: '#dc2626', fontWeight: 700, marginTop: 2 }}>⚠️ معطل</div>}
    </div>
  );
}

// ─── Recursive branch ─────────────────────────────────────────────────────
function OrgBranch({ u, all, visited }: { u: OrgUser; all: OrgUser[]; visited: Set<number> }) {
  if (visited.has(u.id)) return null;
  const next = new Set(visited); next.add(u.id);
  const children = all.filter(c => c.managerIds.includes(u.id) && !next.has(c.id));
  return (
    <li className="otree-li">
      <OrgCard u={u} />
      {children.length > 0 && (
        <ul className="otree-ul">
          {children.map(c => <OrgBranch key={c.id} u={c} all={all} visited={next} />)}
        </ul>
      )}
    </li>
  );
}

// ─── Full tree ────────────────────────────────────────────────────────────
function OrgTree({ users }: { users: OrgUser[] }) {
  if (users.length === 0) return (
    <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0', fontSize: 14 }}>
      لا يوجد مستخدمون مضافون لهذه الشركة بعد
    </div>
  );
  const roots = users.filter(u => u.managerIds.length === 0);
  const startNodes = roots.length > 0 ? roots : users;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ORG_CSS }} />
      <div style={{ overflowX: 'auto', paddingBottom: 16, minWidth: 0 }}>
        <ul className="otree-root">
          {startNodes.map(u => <OrgBranch key={u.id} u={u} all={users} visited={new Set()} />)}
        </ul>
      </div>
    </>
  );
}

export default function CompaniesPage() {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [companies, setCompanies] = useState<Company[]>([]);
  const [offices,   setOffices]   = useState<Office[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [detail,    setDetail]    = useState<CompanyDetail | null>(null);
  const [form,      setForm]      = useState<Partial<Company> | null>(null);
  const [lineForm,  setLineForm]  = useState<{ lineId?: number; name: string; itemIds: number[] } | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [itemForm,  setItemForm]  = useState<ItemForm | null>(null);

  // ─── Org view ──────────────────────────────────────────────────────────
  const [orgData,    setOrgData]    = useState<OrgData | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError,   setOrgError]   = useState('');
  // keep the company id so we can still render the header on error
  const [orgCompanyId, setOrgCompanyId] = useState<number | null>(null);

  const loadOrg = (id: number) => {
    setDetail(null);
    setOrgData(null);
    setOrgError('');
    setOrgCompanyId(id);
    setOrgLoading(true);
    fetch(`/api/sa/companies/${id}/org`, { headers: H() })
      .then(async r => {
        const d = await r.json();
        if (d.success) { setOrgData(d.data); }
        else { setOrgError(d.error || 'فشل تحميل البيانات'); }
      })
      .catch(e => setOrgError(e.message || 'خطأ في الاتصال'))
      .finally(() => setOrgLoading(false));
  };

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/sa/companies', { headers: H() }).then(r => r.json()),
      fetch('/api/sa/offices',   { headers: H() }).then(r => r.json()),
    ]).then(([c, o]) => {
      if (c.success) setCompanies(c.data);
      if (o.success) setOffices(o.data);
    }).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const loadDetail = (id: number) => {
    fetch(`/api/sa/companies/${id}`, { headers: H() }).then(r => r.json()).then(d => { if (d.success) setDetail(d.data); });
  };

  const saveCompany = async () => {
    if (!form?.name?.trim() || !form.officeId) { setError('الاسم والمكتب مطلوبان'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const res = await fetch(isEdit ? `/api/sa/companies/${form.id}` : '/api/sa/companies', {
      method: isEdit ? 'PUT' : 'POST', headers: H(), body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
  };

  const saveLine = async () => {
    if (!detail || lineForm === null) return;
    setSaving(true);
    const isEdit = Boolean(lineForm.lineId);
    const url = isEdit
      ? `/api/sa/companies/${detail.id}/lines/${lineForm.lineId}`
      : `/api/sa/companies/${detail.id}/lines`;
    const method = isEdit ? 'PUT' : 'POST';
    const body: any = { name: lineForm.name, itemIds: lineForm.itemIds };
    await fetch(url, { method, headers: H(), body: JSON.stringify(body) });
    if (isEdit) {
      await fetch(`/api/sa/companies/${detail.id}/lines/${lineForm.lineId}/items`, {
        method: 'PUT', headers: H(), body: JSON.stringify({ itemIds: lineForm.itemIds }),
      });
    }
    setSaving(false); setLineForm(null); loadDetail(detail.id);
  };

  const delLine = async (lineId: number) => {
    if (!detail || !confirm('حذف اللاين؟')) return;
    await fetch(`/api/sa/companies/${detail.id}/lines/${lineId}`, { method: 'DELETE', headers: H() });
    loadDetail(detail.id);
  };

  const blankItemForm = (): ItemForm => ({ name: '', scientificName: '', dosage: '', form: '', price: '', scientificMessage: '' });

  const addItem = async () => {
    if (!detail || !itemForm?.name?.trim()) return;
    setSaving(true); setError('');
    const payload = {
      name:              itemForm.name.trim(),
      scientificName:    itemForm.scientificName.trim() || null,
      dosage:            itemForm.dosage.trim()         || null,
      form:              itemForm.form.trim()           || null,
      price:             itemForm.price !== '' ? parseFloat(itemForm.price) : null,
      scientificMessage: itemForm.scientificMessage.trim() || null,
    };
    const res = await fetch(`/api/sa/companies/${detail.id}/items`, {
      method: 'POST', headers: H(), body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setItemForm(null); loadDetail(detail.id);
  };

  const delItem = async (itemId: number, itemName: string) => {
    if (!detail || !confirm(`حذف ايتم "${itemName}" من هذه الشركة؟`)) return;
    await fetch(`/api/sa/companies/${detail.id}/items/${itemId}`, { method: 'DELETE', headers: H() });
    loadDetail(detail.id);
  };

  const toggleCompany = async (c: Company) => {
    await fetch(`/api/sa/companies/${c.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !c.isActive }) });
    load();
  };

  const delCompany = async (c: Company) => {
    if (!confirm(`حذف شركة "${c.name}"؟`)) return;
    await fetch(`/api/sa/companies/${c.id}`, { method: 'DELETE', headers: H() });
    load();
    if (detail?.id === c.id) setDetail(null);
  };

  if (orgData || orgLoading || orgError) return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 500 }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '2px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => { setOrgData(null); setOrgLoading(false); setOrgError(''); setOrgCompanyId(null); }} style={{ ...btnStyle('#64748b', true), marginBottom: 0 }}>← رجوع</button>
          {orgData && (
            <div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>🏭 {orgData.company.name}</h2>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                🏢 {orgData.company.office?.name}
                <span style={{ margin: '0 8px', color: '#e2e8f0' }}>·</span>
                <span style={{ background: orgData.company.isActive ? '#dcfce7' : '#fee2e2', color: orgData.company.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                  {orgData.company.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
            </div>
          )}
          {orgLoading && <span style={{ color: '#64748b', fontSize: 14 }}>جاري التحميل...</span>}
          {orgError && <span style={{ color: '#dc2626', fontSize: 14 }}>⚠️ {orgError}</span>}
        </div>
        {orgData && (
          <button onClick={() => { const id = orgData.company.id; setOrgData(null); setOrgError(''); setOrgCompanyId(null); loadDetail(id); }} style={btnStyle('#0f172a')}>
            ⚙️ إدارة الشركة
          </button>
        )}
        {orgError && orgCompanyId && (
          <button onClick={() => loadOrg(orgCompanyId)} style={btnStyle('#3b82f6')}>🔄 إعادة المحاولة</button>
        )}
      </div>

      {orgLoading && !orgData ? <Spinner /> : orgError && !orgData ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#dc2626', fontSize: 14 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <strong>حدث خطأ</strong>
          <div style={{ marginTop: 6, color: '#64748b', fontSize: 13 }}>{orgError}</div>
        </div>
      ) : orgData && (
        <div style={{ display: 'flex', gap: 20, flex: 1, overflow: 'hidden', alignItems: 'flex-start' }}>

          {/* ── Org chart (main area) ────────────────────────────────────── */}
          <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', minWidth: 0 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>
              🏗️ الهيكل التنظيمي
              <span style={{ fontSize: 13, fontWeight: 400, color: '#64748b', marginRight: 8 }}>
                ({orgData.users.length} مستخدم)
              </span>
            </h3>
            <OrgTree users={orgData.users} />
          </div>

          {/* ── Items & Lines sidebar ────────────────────────────────────── */}
          <div style={{ width: 270, flexShrink: 0, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, overflowY: 'auto', maxHeight: '80vh' }}>

            {/* Items */}
            <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: '#374151' }}>
              💊 الايتمات
              <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b', marginRight: 6 }}>({orgData.company.items.length})</span>
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
              {orgData.company.items.map(i => (
                <div key={i.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: '#1e293b' }}>{i.name}</div>
                  {i.scientificName && <div style={{ fontSize: 11, color: '#6366f1', marginTop: 1 }}>{i.scientificName}</div>}
                  <div style={{ display: 'flex', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                    {i.dosage && <span style={{ fontSize: 10, color: '#64748b', background: '#f1f5f9', borderRadius: 4, padding: '1px 5px' }}>{i.dosage}</span>}
                    {i.form   && <span style={{ fontSize: 10, color: '#64748b', background: '#f1f5f9', borderRadius: 4, padding: '1px 5px' }}>{i.form}</span>}
                    {i.price != null && <span style={{ fontSize: 10, color: '#059669', fontWeight: 600, background: '#f0fdf4', borderRadius: 4, padding: '1px 5px' }}>{i.price.toLocaleString()} د.ع</span>}
                  </div>
                </div>
              ))}
              {orgData.company.items.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>لا توجد ايتمات</div>
              )}
            </div>

            {/* Lines */}
            {orgData.company.lines.length > 0 && (
              <>
                <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: '#374151' }}>
                  📋 اللاينات
                  <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b', marginRight: 6 }}>({orgData.company.lines.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {orgData.company.lines.map(l => (
                    <div key={l.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ fontWeight: 600, fontSize: 12, color: '#1e293b', marginBottom: 4 }}>
                        {l.name || `لاين #${l.id}`}
                        <span style={{ fontSize: 10, color: l.isActive ? '#059669' : '#dc2626', fontWeight: 600, background: l.isActive ? '#f0fdf4' : '#fef2f2', borderRadius: 20, padding: '1px 6px', marginRight: 6 }}>
                          {l.isActive ? 'نشط' : 'معطل'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {l.lineItems.map(li => (
                          <span key={li.item.id} style={{ fontSize: 10, color: '#16a34a', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 4, padding: '1px 6px' }}>
                            {li.item.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (detail) return (
    <div>
      <button onClick={() => setDetail(null)} style={{ ...btnStyle('#64748b', true), marginBottom: 20 }}>← رجوع</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>🏭 {detail.name}</h2>
          <span style={{ fontSize: 13, color: '#64748b' }}>مكتب: {detail.office?.name}</span>
        </div>
        <button onClick={() => setLineForm({ name: '', itemIds: [] })} style={btnStyle('#0f172a')}>+ إضافة لاين</button>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#374151' }}>الايتمات ({detail.items.length})</h3>
          <button onClick={() => { setItemForm(blankItemForm()); setError(''); }} style={btnStyle('#059669', true)}>+ إضافة ايتم</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {detail.items.map(i => (
            <span key={i.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 8, padding: '4px 10px', fontSize: 13 }}>
              <span>
                <strong>{i.name}</strong>
                {i.scientificName && <span style={{ color: '#6366f1', marginRight: 4 }}>({i.scientificName})</span>}
                {i.dosage && <span style={{ color: '#64748b', fontSize: 11, marginRight: 4 }}>{i.dosage}</span>}
                {i.form && <span style={{ color: '#64748b', fontSize: 11, marginRight: 4 }}>· {i.form}</span>}
                {i.price != null && <span style={{ color: '#059669', fontSize: 11, marginRight: 4 }}>· {i.price.toLocaleString()} د.ع</span>}
              </span>
              <button onClick={() => delItem(i.id, i.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14, padding: '0 2px', lineHeight: 1 }}>×</button>
            </span>
          ))}
          {detail.items.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد ايتمات مضافة للشركة</span>}
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: '#374151' }}>اللاينات ({detail.lines.length})</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14 }}>
        {detail.lines.map(l => (
          <div key={l.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{l.name || `لاين #${l.id}`}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setLineForm({ lineId: l.id, name: l.name || '', itemIds: l.lineItems.map(li => li.item.id) })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => delLine(l.id)} style={btnStyle('#ef4444', true)}>حذف</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {l.lineItems.map(li => (
                <span key={li.item.id} style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6, padding: '2px 10px', fontSize: 12 }}>{li.item.name}</span>
              ))}
            </div>
          </div>
        ))}
        {detail.lines.length === 0 && <div style={{ color: '#94a3b8', fontSize: 13, padding: 16 }}>لا توجد لاينات</div>}
      </div>

      {/* Item add modal */}
      {itemForm !== null && (
        <Modal onClose={() => { setItemForm(null); setError(''); }} title="إضافة ايتم للشركة">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Field label="الاسم التجاري *" value={itemForm.name} onChange={v => setItemForm(f => ({ ...f!, name: v }))} />
            <Field label="الاسم العلمي" value={itemForm.scientificName} onChange={v => setItemForm(f => ({ ...f!, scientificName: v }))} />
            <Field label="الجرعة الدوائية" value={itemForm.dosage} onChange={v => setItemForm(f => ({ ...f!, dosage: v }))} placeholder="مثال: 500mg" />
            <Field label="الشكل الدوائي" value={itemForm.form} onChange={v => setItemForm(f => ({ ...f!, form: v }))} placeholder="أقراص / كبسول / شراب..." />
            <Field label="السعر (د.ع)" value={itemForm.price} onChange={v => setItemForm(f => ({ ...f!, price: v }))} type="number" />
          </div>
          <Field label="المسج العلمي" value={itemForm.scientificMessage} onChange={v => setItemForm(f => ({ ...f!, scientificMessage: v }))} textarea />
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setItemForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={addItem} disabled={saving || !itemForm?.name?.trim()} style={btnStyle('#059669', true)}>{saving ? '...' : 'إضافة'}</button>
          </div>
        </Modal>
      )}

      {/* Line form modal */}
      {lineForm !== null && (
        <Modal onClose={() => setLineForm(null)} title={lineForm.lineId ? 'تعديل اللاين' : 'إضافة لاين'}>
          <Field label="اسم اللاين (اختياري)" value={lineForm.name} onChange={v => setLineForm(f => ({ ...f!, name: v }))} />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>الايتمات</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
              {detail.items.map(i => (
                <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={lineForm.itemIds.includes(i.id)}
                    onChange={e => setLineForm(f => ({ ...f!, itemIds: e.target.checked ? [...f!.itemIds, i.id] : f!.itemIds.filter(x => x !== i.id) }))} />
                  {i.name}
                </label>
              ))}
              {detail.items.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>أضف ايتمات للشركة أولاً</span>}
            </div>
          </div>
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setLineForm(null)} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveLine} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>🏭 الشركات العلمية</h2>
        <button onClick={() => setForm({ name: '', isActive: true })} style={btnStyle('#0f172a')}>+ إضافة شركة</button>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>
          {companies.map(c => (
            <div key={c.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }} onClick={() => loadOrg(c.id)}>{c.name}</div>
                <span style={{ background: c.isActive ? '#dcfce7' : '#fee2e2', color: c.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
                  {c.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>🏢 {c.office?.name} · 💊 {c._count?.items ?? 0} ايتم · 📋 {c._count?.lines ?? 0} لاين</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => loadOrg(c.id)} style={btnStyle('#6366f1', true)}>التفاصيل</button>
                <button onClick={() => setForm({ ...c })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => toggleCompany(c)} style={btnStyle(c.isActive ? '#f59e0b' : '#10b981', true)}>{c.isActive ? 'تعطيل' : 'تفعيل'}</button>
                <button onClick={() => delCompany(c)} style={btnStyle('#ef4444', true)}>حذف</button>
              </div>
            </div>
          ))}
          {companies.length === 0 && <div style={{ color: '#94a3b8', padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد شركات</div>}
        </div>
      )}

      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل الشركة' : 'إضافة شركة'}>
          <Field label="اسم الشركة *" value={form.name || ''} onChange={v => setForm(f => ({ ...f!, name: v }))} />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>المكتب العلمي *</label>
            <select value={form.officeId || ''} onChange={e => setForm(f => ({ ...f!, officeId: Number(e.target.value) }))}
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
              <option value="">-- اختر مكتب --</option>
              {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <Field label="ملاحظات" value={form.notes || ''} onChange={v => setForm(f => ({ ...f!, notes: v }))} textarea />
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveCompany} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
