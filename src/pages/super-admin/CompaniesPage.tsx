import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

interface Office   { id: number; name: string; }
interface Company  { id: number; name: string; officeId: number; isActive: boolean; notes?: string; office?: { name: string }; _count?: { items: number; lines: number }; }
interface Item     { id: number; name: string; }
interface Line     { id: number; name?: string; isActive: boolean; lineItems: { item: Item }[]; }
interface CompanyDetail extends Company { items: Item[]; lines: Line[]; }

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
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: '#374151' }}>الايتمات ({detail.items.length})</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {detail.items.map(i => (
            <span key={i.id} style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 8, padding: '4px 12px', fontSize: 13 }}>{i.name}</span>
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
                <div style={{ fontWeight: 700, fontSize: 16 }} onClick={() => loadDetail(c.id)}>{c.name}</div>
                <span style={{ background: c.isActive ? '#dcfce7' : '#fee2e2', color: c.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
                  {c.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>🏢 {c.office?.name} · 💊 {c._count?.items ?? 0} ايتم · 📋 {c._count?.lines ?? 0} لاين</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => loadDetail(c.id)} style={btnStyle('#6366f1', true)}>التفاصيل</button>
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
