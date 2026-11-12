import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

// ════════════════════════════════════════════════════════════════════════════
// «الايتمات والأسعار» — مدير الشركة / إدارة المكتب يعدّل ايتمات شركاته.
// يكتب على نفس كتالوج السوبر أدمن (/api/items-catalog) فيُعتمد عند الجميع فوراً.
// ════════════════════════════════════════════════════════════════════════════

const API = import.meta.env.VITE_API_URL || '';

interface Company { id: number; name: string; isActive: boolean }
interface CatalogItem {
  id: number;
  name: string;
  scientificName: string | null;
  dosage: string | null;
  form: string | null;
  price: number | null;
  warehousePrice: number | null;
  scientificMessage: string | null;
  imageUrl: string | null;
  scientificCompanyId: number | null;
  lastEdit: { at: string; by: string } | null;
}
type PriceField = 'price' | 'warehousePrice';
type FormState = {
  companyId: string; name: string; scientificName: string; dosage: string; form: string;
  price: string; warehousePrice: string; scientificMessage: string;
};

const EMPTY_FORM: FormState = { companyId: '', name: '', scientificName: '', dosage: '', form: '', price: '', warehousePrice: '', scientificMessage: '' };
const fmtPrice = (n: number | null) => (n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
const cleanNum = (s: string) => s.replace(/[,،\s]/g, '');

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'الآن';
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `قبل ${d} يوم` : new Date(iso).toLocaleDateString('ar-IQ');
}

export default function ItemsCatalogManagePage() {
  const { token } = useAuth();
  const jsonH = useCallback(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token]);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [addable, setAddable] = useState<number[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [companyFilter, setCompanyFilter] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);

  // تعديل السعر داخل الصف
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cellState, setCellState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});

  // نافذة التعديل/الإضافة
  const [modal, setModal] = useState<{ mode: 'edit' | 'add'; item?: CatalogItem } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`${API}/api/items-catalog`, { headers: jsonH() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل التحميل');
      setCompanies(j.data.companies);
      setAddable(j.data.addableCompanyIds);
      setItems(j.data.items);
    } catch (e: any) { setError(e.message || 'فشل التحميل'); }
    finally { setLoading(false); }
  }, [jsonH]);

  useEffect(() => { load(); }, [load]);

  const companyName = useMemo(() => new Map(companies.map(c => [c.id, c.name])), [companies]);
  const countByCompany = useMemo(() => {
    const m = new Map<number, number>();
    for (const it of items) if (it.scientificCompanyId != null) m.set(it.scientificCompanyId, (m.get(it.scientificCompanyId) ?? 0) + 1);
    return m;
  }, [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(it =>
      (companyFilter === 'all' || it.scientificCompanyId === companyFilter) &&
      (!missingOnly || it.price == null || it.warehousePrice == null) &&
      (!q || [it.name, it.scientificName, it.dosage, it.form].some(v => v && v.toLowerCase().includes(q))),
    );
  }, [items, companyFilter, missingOnly, search]);

  const missingCount = useMemo(() => items.filter(it => it.price == null || it.warehousePrice == null).length, [items]);

  const applyUpdated = (updated: CatalogItem) =>
    setItems(prev => prev.map(it => (it.id === updated.id ? { ...it, ...updated } : it)));

  const patchItem = async (id: number, body: Record<string, unknown>) => {
    const r = await fetch(`${API}/api/items-catalog/items/${id}`, { method: 'PATCH', headers: jsonH(), body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'فشل الحفظ');
    return j as { data: CatalogItem; changed: boolean };
  };

  // ── حفظ سعر من داخل الصف (عند الخروج من الحقل أو Enter) ──
  const savePrice = async (it: CatalogItem, field: PriceField) => {
    const key = `${it.id}:${field}`;
    const raw = drafts[key];
    if (raw === undefined) return;
    const cleaned = cleanNum(raw);
    if (cleaned !== '' && (isNaN(Number(cleaned)) || Number(cleaned) < 0)) {
      setCellState(s => ({ ...s, [key]: 'error' }));
      return;
    }
    const next = cleaned === '' ? null : Number(cleaned);
    if (next === it[field]) {
      setDrafts(d => { const n = { ...d }; delete n[key]; return n; });
      return;
    }
    setCellState(s => ({ ...s, [key]: 'saving' }));
    try {
      const { data } = await patchItem(it.id, { [field]: next });
      applyUpdated({ ...data, lastEdit: { at: new Date().toISOString(), by: 'أنت' } });
      setDrafts(d => { const n = { ...d }; delete n[key]; return n; });
      setCellState(s => ({ ...s, [key]: 'saved' }));
      setTimeout(() => setCellState(s => { const n = { ...s }; if (n[key] === 'saved') delete n[key]; return n; }), 1800);
    } catch (e: any) {
      setCellState(s => ({ ...s, [key]: 'error' }));
      alert(e.message);
    }
  };

  const openEdit = (it: CatalogItem) => {
    setForm({
      companyId: String(it.scientificCompanyId ?? ''),
      name: it.name, scientificName: it.scientificName ?? '', dosage: it.dosage ?? '', form: it.form ?? '',
      price: it.price != null ? String(it.price) : '', warehousePrice: it.warehousePrice != null ? String(it.warehousePrice) : '',
      scientificMessage: it.scientificMessage ?? '',
    });
    setSaveErr(''); setModal({ mode: 'edit', item: it });
  };
  const openAdd = () => {
    const def = companyFilter !== 'all' && addable.includes(companyFilter) ? companyFilter : addable.length === 1 ? addable[0] : '';
    setForm({ ...EMPTY_FORM, companyId: String(def) });
    setSaveErr(''); setModal({ mode: 'add' });
  };

  const submitModal = async () => {
    if (!modal) return;
    if (!form.name.trim()) { setSaveErr('اسم الايتم مطلوب'); return; }
    for (const f of ['price', 'warehousePrice'] as const) {
      const c = cleanNum(form[f]);
      if (c !== '' && (isNaN(Number(c)) || Number(c) < 0)) { setSaveErr(f === 'price' ? 'سعر المكتب غير صالح' : 'سعر المذخر غير صالح'); return; }
    }
    const body = {
      name: form.name, scientificName: form.scientificName, dosage: form.dosage, form: form.form,
      scientificMessage: form.scientificMessage,
      price: cleanNum(form.price) === '' ? null : Number(cleanNum(form.price)),
      warehousePrice: cleanNum(form.warehousePrice) === '' ? null : Number(cleanNum(form.warehousePrice)),
    };
    setSaving(true); setSaveErr('');
    try {
      if (modal.mode === 'edit' && modal.item) {
        const { data, changed } = await patchItem(modal.item.id, body);
        if (changed) applyUpdated({ ...data, lastEdit: { at: new Date().toISOString(), by: 'أنت' } });
      } else {
        if (!form.companyId) { setSaveErr('اختر الشركة'); setSaving(false); return; }
        const r = await fetch(`${API}/api/items-catalog/items`, {
          method: 'POST', headers: jsonH(), body: JSON.stringify({ ...body, companyId: Number(form.companyId) }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'فشل الإضافة');
        setItems(prev => [...prev, j.data].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setModal(null);
    } catch (e: any) { setSaveErr(e.message); }
    finally { setSaving(false); }
  };

  const priceCell = (it: CatalogItem, field: PriceField) => {
    const key = `${it.id}:${field}`;
    const st = cellState[key];
    const value = drafts[key] ?? fmtPrice(it[field]);
    return (
      <div className="icm-price">
        <input
          className={`icm-price-input ${st ? `is-${st}` : ''} ${it[field] == null && drafts[key] === undefined ? 'is-empty' : ''}`}
          inputMode="decimal"
          value={value}
          placeholder="—"
          onFocus={() => setDrafts(d => (d[key] !== undefined ? d : { ...d, [key]: it[field] != null ? String(it[field]) : '' }))}
          onChange={e => { const v = e.target.value; setDrafts(d => ({ ...d, [key]: v })); setCellState(s => { const n = { ...s }; delete n[key]; return n; }); }}
          onBlur={() => savePrice(it, field)}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setDrafts(d => { const n = { ...d }; delete n[key]; return n; }); (e.target as HTMLInputElement).blur(); }
          }}
        />
        <span className="icm-price-flag">{st === 'saving' ? '⏳' : st === 'saved' ? '✓' : st === 'error' ? '⚠' : ''}</span>
      </div>
    );
  };

  return (
    <div className="icm-root" dir="rtl">
      <style>{CSS}</style>

      <div className="icm-banner">
        <span>🔒</span>
        <div>
          أي تعديل هنا <b>معتمد مباشرةً</b> — يُكتب على كتالوج الايتمات الرسمي فيظهر عند كل الحسابات وعند السوبر أدمن،
          ويُسجَّل باسمك في سجل التغييرات. الحذف والنقل بين الشركات يبقيان عند السوبر أدمن.
        </div>
      </div>

      <div className="icm-stats">
        <div className="icm-stat"><b>{companies.length}</b><span>شركة</span></div>
        <div className="icm-stat"><b>{items.length}</b><span>ايتم</span></div>
        <button className={`icm-stat icm-stat-btn ${missingOnly ? 'on' : ''}`} onClick={() => setMissingOnly(v => !v)} title="عرض الايتمات الناقصة السعر فقط">
          <b style={{ color: missingCount ? '#d97706' : '#059669' }}>{missingCount}</b><span>ناقص سعر</span>
        </button>
        <div className="icm-spacer" />
        {addable.length > 0 && <button className="icm-add" onClick={openAdd}>➕ ايتم جديد</button>}
      </div>

      <div className="icm-toolbar">
        <input className="icm-search" placeholder="🔍 بحث بالاسم أو الاسم العلمي أو الجرعة..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="icm-chips">
        <button className={`icm-chip ${companyFilter === 'all' ? 'on' : ''}`} onClick={() => setCompanyFilter('all')}>
          كل الشركات <span>{items.length}</span>
        </button>
        {companies.map(c => (
          <button key={c.id} className={`icm-chip ${companyFilter === c.id ? 'on' : ''}`} onClick={() => setCompanyFilter(c.id)}>
            {c.name} <span>{countByCompany.get(c.id) ?? 0}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="icm-empty">⏳ جاري التحميل...</div>
      ) : error ? (
        <div className="icm-empty icm-err">{error} <button onClick={load}>إعادة المحاولة</button></div>
      ) : visible.length === 0 ? (
        <div className="icm-empty">{items.length ? 'لا توجد ايتمات مطابقة' : 'لا توجد ايتمات في شركاتك بعد'}</div>
      ) : (
        <div className="icm-table-wrap">
          <table className="icm-table">
            <thead>
              <tr>
                <th>الايتم</th>
                <th>الشركة</th>
                <th>الاسم العلمي / الجرعة</th>
                <th className="num">سعر المكتب</th>
                <th className="num">سعر المذخر</th>
                <th>آخر تعديل</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(it => (
                <tr key={it.id}>
                  <td data-label="الايتم" className="icm-name">
                    {it.imageUrl && <img src={`${API}${it.imageUrl}`} alt="" />}
                    <span>{it.name}</span>
                  </td>
                  <td data-label="الشركة"><span className="icm-co">{companyName.get(it.scientificCompanyId ?? -1) ?? '—'}</span></td>
                  <td data-label="الاسم العلمي" className="icm-sci">
                    {[it.scientificName, it.dosage, it.form].filter(Boolean).join(' · ') || <span className="icm-muted">—</span>}
                  </td>
                  <td data-label="سعر المكتب" className="num">{priceCell(it, 'price')}</td>
                  <td data-label="سعر المذخر" className="num">{priceCell(it, 'warehousePrice')}</td>
                  <td data-label="آخر تعديل" className="icm-muted icm-last">
                    {it.lastEdit ? <>{it.lastEdit.by} · {timeAgo(it.lastEdit.at)}</> : '—'}
                  </td>
                  <td className="icm-actions"><button onClick={() => openEdit(it)}>✏️ تفاصيل</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div className="icm-overlay" onClick={() => !saving && setModal(null)}>
          <div className="icm-modal" onClick={e => e.stopPropagation()}>
            <div className="icm-modal-head">
              <h3>{modal.mode === 'edit' ? `✏️ ${modal.item?.name}` : '➕ ايتم جديد'}</h3>
              <button onClick={() => setModal(null)} disabled={saving}>✕</button>
            </div>
            <div className="icm-form">
              {modal.mode === 'add' ? (
                <label className="full">الشركة
                  <select value={form.companyId} onChange={e => setForm(f => ({ ...f, companyId: e.target.value }))}>
                    <option value="">— اختر —</option>
                    {addable.map(id => <option key={id} value={id}>{companyName.get(id) ?? `#${id}`}</option>)}
                  </select>
                </label>
              ) : (
                <div className="full icm-muted">الشركة: <b>{companyName.get(modal.item?.scientificCompanyId ?? -1) ?? '—'}</b></div>
              )}
              <label className="full">اسم الايتم (التجاري)
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                {modal.mode === 'edit' && form.name.trim() !== modal.item?.name && (
                  <small>الاسم القديم يبقى مربوطاً بنفس الايتم عند رفع الملفات.</small>
                )}
              </label>
              <label>الاسم العلمي<input value={form.scientificName} onChange={e => setForm(f => ({ ...f, scientificName: e.target.value }))} /></label>
              <label>الجرعة<input value={form.dosage} onChange={e => setForm(f => ({ ...f, dosage: e.target.value }))} /></label>
              <label>الشكل الدوائي<input value={form.form} placeholder="أقراص، شراب، حقن..." onChange={e => setForm(f => ({ ...f, form: e.target.value }))} /></label>
              <span />
              <label>💰 سعر المكتب<input inputMode="decimal" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} /></label>
              <label>🏬 سعر المذخر<input inputMode="decimal" value={form.warehousePrice} onChange={e => setForm(f => ({ ...f, warehousePrice: e.target.value }))} /></label>
              <label className="full">المسج العلمي
                <textarea rows={3} value={form.scientificMessage} onChange={e => setForm(f => ({ ...f, scientificMessage: e.target.value }))} />
              </label>
            </div>
            {saveErr && <div className="icm-save-err">{saveErr}</div>}
            <div className="icm-modal-foot">
              <button className="icm-cancel" onClick={() => setModal(null)} disabled={saving}>إلغاء</button>
              <button className="icm-save" onClick={submitModal} disabled={saving}>{saving ? '⏳ جاري الحفظ...' : 'حفظ واعتماد'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.icm-root { padding: 18px; max-width: 1300px; margin: 0 auto; font-family: inherit; }
.icm-banner { display: flex; gap: 10px; align-items: flex-start; background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3;
  border-radius: 12px; padding: 10px 14px; font-size: 13px; line-height: 1.7; margin-bottom: 14px; }
.icm-stats { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; margin-bottom: 12px; }
.icm-stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 8px 16px; display: flex; flex-direction: column; align-items: center; min-width: 78px; font-family: inherit; }
.icm-stat b { font-size: 20px; color: #1e293b; }
.icm-stat span { font-size: 12px; color: #64748b; }
.icm-stat-btn { cursor: pointer; }
.icm-stat-btn.on { border-color: #f59e0b; background: #fffbeb; }
.icm-spacer { flex: 1; }
.icm-add { background: #4f46e5; color: #fff; border: none; border-radius: 12px; padding: 0 18px; font-weight: 700; font-size: 14px; cursor: pointer; font-family: inherit; min-height: 44px; }
.icm-toolbar { margin-bottom: 10px; }
.icm-search { width: 100%; box-sizing: border-box; padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 11px; font-size: 14px; font-family: inherit; outline: none; background: #fff; }
.icm-search:focus { border-color: #818cf8; }
.icm-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.icm-chip { border: 1.5px solid #e2e8f0; background: #fff; color: #334155; border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.icm-chip span { background: #f1f5f9; color: #64748b; border-radius: 999px; padding: 0 7px; margin-right: 4px; font-size: 11.5px; }
.icm-chip.on { border-color: #6366f1; background: #eef2ff; color: #3730a3; }
.icm-chip.on span { background: #6366f1; color: #fff; }
.icm-empty { text-align: center; padding: 50px 10px; color: #94a3b8; background: #f8fafc; border: 1.5px dashed #e2e8f0; border-radius: 14px; }
.icm-err { color: #dc2626; }
.icm-table-wrap { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; overflow-x: auto; }
.icm-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.icm-table th { text-align: right; background: #f8fafc; color: #64748b; font-weight: 700; font-size: 12.5px; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; position: sticky; top: 0; }
.icm-table td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
.icm-table tr:hover td { background: #fafbff; }
.icm-table .num { text-align: left; }
.icm-name { font-weight: 700; color: #1e293b; }
.icm-name img { width: 28px; height: 28px; object-fit: cover; border-radius: 6px; vertical-align: middle; margin-left: 8px; }
.icm-co { background: #f5f3ff; color: #6d28d9; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; white-space: nowrap; }
.icm-sci { color: #475569; font-size: 12.5px; }
.icm-muted { color: #94a3b8; font-size: 12px; }
.icm-last { white-space: nowrap; }
.icm-price { display: inline-flex; align-items: center; gap: 4px; }
.icm-price-input { width: 110px; text-align: left; direction: ltr; padding: 6px 8px; border: 1.5px solid transparent; border-radius: 8px; background: #f8fafc;
  font-size: 13.5px; font-weight: 700; color: #0f172a; font-family: inherit; outline: none; }
.icm-price-input:hover { border-color: #e2e8f0; }
.icm-price-input:focus { border-color: #6366f1; background: #fff; }
.icm-price-input.is-empty { background: #fffbeb; }
.icm-price-input.is-saved { border-color: #10b981; }
.icm-price-input.is-error { border-color: #ef4444; }
.icm-price-flag { width: 14px; font-size: 12px; color: #10b981; }
.icm-actions { text-align: left; white-space: nowrap; }
.icm-actions button { border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit; color: #334155; }
.icm-actions button:hover { border-color: #6366f1; color: #4f46e5; }
.icm-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.icm-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
.icm-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #f1f5f9; }
.icm-modal-head h3 { margin: 0; font-size: 16px; color: #1e1b4b; }
.icm-modal-head button { border: none; background: #f1f5f9; border-radius: 8px; width: 32px; height: 32px; cursor: pointer; }
.icm-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px 18px; }
.icm-form .full { grid-column: 1 / -1; }
.icm-form label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 700; color: #475569; }
.icm-form input, .icm-form select, .icm-form textarea { padding: 9px 11px; border: 1.5px solid #e2e8f0; border-radius: 9px; font-size: 14px; font-family: inherit; outline: none; font-weight: 500; color: #0f172a; background: #fff; }
.icm-form input:focus, .icm-form select:focus, .icm-form textarea:focus { border-color: #6366f1; }
.icm-form small { color: #b45309; font-weight: 500; }
.icm-save-err { margin: 0 18px 10px; color: #dc2626; font-size: 13px; font-weight: 600; }
.icm-modal-foot { display: flex; gap: 8px; justify-content: flex-start; padding: 12px 18px 16px; border-top: 1px solid #f1f5f9; }
.icm-save { background: #4f46e5; color: #fff; border: none; border-radius: 10px; padding: 10px 20px; font-weight: 700; cursor: pointer; font-family: inherit; }
.icm-cancel { background: #f1f5f9; color: #334155; border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; font-family: inherit; }
.icm-save:disabled, .icm-cancel:disabled { opacity: .6; cursor: default; }

@media (max-width: 720px) {
  .icm-root { padding: 12px 16px; }
  .icm-table thead { display: none; }
  .icm-table, .icm-table tbody, .icm-table tr, .icm-table td { display: block; width: 100%; box-sizing: border-box; }
  .icm-table tr { border-bottom: 8px solid #f8fafc; padding: 6px 0; }
  .icm-table td { border: none; padding: 5px 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .icm-table td::before { content: attr(data-label); color: #94a3b8; font-size: 12px; font-weight: 600; }
  .icm-table td.icm-name { font-size: 15px; }
  .icm-table td.icm-name::before, .icm-table td.icm-actions::before { content: none; }
  .icm-table .num { text-align: right; }
  .icm-form { grid-template-columns: 1fr; }
  .icm-form > span:empty { display: none; }
  .icm-add { width: 100%; }
}
`;
