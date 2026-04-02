import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Company { id: number; name: string; isSci?: boolean; }
interface Item {
  id: number;
  name: string;
  scientificName: string | null;
  dosage: string | null;
  form: string | null;
  price: number | null;
  scientificMessage: string | null;
  imageUrl: string | null;
  companyId: number | null;
  company: Company | null;
  scientificCompanyId: number | null;
  scientificCompany: Company | null;
}

const EMPTY_FORM = { name: '', scientificName: '', dosage: '', form: '', price: '', scientificMessage: '', companyId: '' };

export default function ItemsPage() {
  const { token }   = useAuth();
  const authH       = () => ({ Authorization: `Bearer ${token}` });
  const jsonH       = () => ({ 'Content-Type': 'application/json', ...authH() });

  const [items, setItems]       = useState<Item[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [filterCompany, setFilterCompany] = useState('all');

  // Modal state
  const [modal, setModal]       = useState<'add' | 'edit' | 'view' | 'import' | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [form, setForm]         = useState({ ...EMPTY_FORM });
  const [saving, setSaving]     = useState(false);
  const [saveErr, setSaveErr]   = useState('');

  // Image upload state
  const imageInputRef              = useRef<HTMLInputElement>(null);
  const [imageUploading, setImageUploading] = useState(false);

  const handleImageUpload = async (itemId: number, file: File) => {
    setImageUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const r = await fetch(`${API}/api/items/${itemId}/image`, { method: 'POST', headers: authH(), body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل رفع الصورة');
      setSelected(prev => prev?.id === itemId ? { ...prev, imageUrl: j.imageUrl } : prev);
      setItems(prev => prev.map(it => it.id === itemId ? { ...it, imageUrl: j.imageUrl } : it));
    } catch (e: any) { alert(e.message); }
    finally { setImageUploading(false); }
  };

  const handleRemoveImage = async (itemId: number) => {
    if (!confirm('حذف صورة الايتم؟')) return;
    try {
      const r = await fetch(`${API}/api/items/${itemId}/image`, { method: 'DELETE', headers: authH() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الحذف');
      setSelected(prev => prev?.id === itemId ? { ...prev, imageUrl: null } : prev);
      setItems(prev => prev.map(it => it.id === itemId ? { ...it, imageUrl: null } : it));
    } catch (e: any) { alert(e.message); }
  };

  // Excel import state
  const importInputRef            = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [ir, cr] = await Promise.all([
        fetch(`${API}/api/items`, { headers: authH() }).then(r => r.json()),
        fetch(`${API}/api/companies`, { headers: authH() }).then(r => r.json()),
      ]);
      if (ir.success) setItems(ir.data ?? []);
      if (cr.success) setCompanies(cr.data ?? []);
    } catch {
      setError('فشل تحميل البيانات');
    } finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setForm({ ...EMPTY_FORM });
    setSaveErr('');
    setModal('add');
  };
  const openEdit = (item: Item) => {
    setSelected(item);
    setForm({
      name: item.name,
      scientificName: item.scientificName ?? '',
      dosage: item.dosage ?? '',
      form: item.form ?? '',
      price: item.price != null ? String(item.price) : '',
      scientificMessage: item.scientificMessage ?? '',
      companyId: item.companyId != null ? String(item.companyId) : '',
    });
    setSaveErr('');
    setModal('edit');
  };
  const openView = (item: Item) => { setSelected(item); setModal('view'); };

  const handleSave = async () => {
    if (!form.name.trim()) { setSaveErr('اسم الايتم مطلوب'); return; }
    setSaving(true); setSaveErr('');
    try {
      const body = {
        name: form.name.trim(),
        scientificName:    form.scientificName.trim()    || null,
        dosage:            form.dosage.trim()            || null,
        form:              form.form.trim()              || null,
        price:             form.price !== '' ? parseFloat(form.price) : null,
        scientificMessage: form.scientificMessage.trim() || null,
      };

      if (modal === 'add') {
        const r = await fetch(`${API}/api/items`, { method: 'POST', headers: jsonH(), body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'فشل الإضافة');
      } else if (modal === 'edit' && selected) {
        const r = await fetch(`${API}/api/items/${selected.id}`, { method: 'PATCH', headers: jsonH(), body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'فشل التعديل');
      }
      await load();
      setModal(null);
    } catch (e: any) {
      setSaveErr(e.message);
    } finally { setSaving(false); }
  };

  const handleDelete = async (item: Item) => {
    if (!confirm(`حذف الايتم "${item.name}"؟`)) return;
    try {
      const r = await fetch(`${API}/api/items/${item.id}`, { method: 'DELETE', headers: authH() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الحذف');
      await load();
    } catch (e: any) { alert(e.message); }
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true); setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      const r = await fetch(`${API}/api/items/import-excel`, { method: 'POST', headers: authH(), body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الاستيراد');
      setImportResult({ inserted: j.inserted, skipped: j.skipped, errors: j.errors });
      await load();
    } catch (e: any) {
      setImportResult({ inserted: 0, skipped: 0, errors: [e.message] });
    } finally { setImporting(false); }
  };

  // Filtered items
  const filtered = items.filter(it => {
    if (filterCompany !== 'all') {
      if (filterCompany === 'null') {
        if (it.companyId != null || it.scientificCompanyId != null) return false;
      } else if (filterCompany.startsWith('sci-')) {
        const sciId = Number(filterCompany.slice(4));
        if (it.scientificCompanyId !== sciId) return false;
      } else if (filterCompany.startsWith('usr-')) {
        const usrId = Number(filterCompany.slice(4));
        if (it.companyId !== usrId) return false;
      }
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        it.name.toLowerCase().includes(q) ||
        (it.scientificName ?? '').toLowerCase().includes(q) ||
        (it.dosage ?? '').toLowerCase().includes(q) ||
        (it.scientificMessage ?? '').toLowerCase().includes(q) ||
        (it.company?.name ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Group by company (scientific company takes priority over user-scoped company)
  const grouped = filtered.reduce<Record<string, Item[]>>((acc, it) => {
    const key = it.scientificCompany?.name ?? it.company?.name ?? 'بدون شركة';
    if (!acc[key]) acc[key] = [];
    acc[key].push(it);
    return acc;
  }, {});

  const FIELD_ICONS: Record<string, string> = {
    name: '💊', scientificName: '🔬', dosage: '⚖️', form: '💿', price: '💰', scientificMessage: '📋',
  };

  return (
    <div dir="rtl" style={{ padding: '20px', minHeight: '100%' }}>
      <style>{`
        @keyframes itemCardIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        .item-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 16px;
          animation: itemCardIn 0.22s ease both;
          transition: box-shadow 0.18s, transform 0.18s;
          cursor: default;
        }
        .item-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.09); transform: translateY(-2px); }
        .item-detail-row { display:flex; gap:6px; align-items:flex-start; margin-bottom:5px; font-size:12.5px; }
        .item-detail-label { color:#94a3b8; font-size:11px; min-width:80px; flex-shrink:0; font-weight:500; }
        .item-detail-val { color:#1e293b; font-weight:600; word-break:break-word; }
        .item-sci-msg { background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:8px 12px; font-size:12px; color:#0369a1; line-height:1.6; margin-top:8px; }
        .company-group-header { display:flex; align-items:center; gap:8px; padding:8px 0 12px; }
        .items-modal-overlay {
          position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:1000;
          display:flex; align-items:center; justify-content:center; padding:20px;
          animation: itemCardIn 0.15s ease;
        }
        .items-modal-box {
          background:#fff; border-radius:18px; padding:28px; width:100%; max-width:560px;
          max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.25);
          animation: itemCardIn 0.2s ease;
        }
        .items-form-row { margin-bottom:14px; }
        .items-form-label { font-size:12px; font-weight:600; color:#475569; margin-bottom:5px; display:block; }
        .items-form-input {
          width:100%; border:1.5px solid #e2e8f0; border-radius:10px; padding:9px 12px; font-size:13px;
          direction:rtl; box-sizing:border-box; outline:none; transition:border-color .15s;
          background:#f8fafc;
        }
        .items-form-input:focus { border-color:#6366f1; background:#fff; }
        .items-form-textarea { resize:vertical; min-height:80px; }
        @media (max-width:640px) {
          .items-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12, marginBottom:20 }}>
        <div>
          <h2 style={{ margin:0, fontSize:18, fontWeight:800, color:'#1e293b', display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:22 }}>💊</span> الايتمات
          </h2>
          <p style={{ margin:0, fontSize:12, color:'#94a3b8', marginTop:3 }}>
            إجمالي: <strong style={{ color:'#6366f1' }}>{items.length}</strong> ايتم · معروض: <strong>{filtered.length}</strong>
          </p>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button
            onClick={() => { setImportFile(null); setImportResult(null); setModal('import'); }}
            style={{
              background:'#fff', color:'#059669',
              border:'1.5px solid #059669', borderRadius:10, padding:'9px 16px', fontSize:13, fontWeight:700,
              cursor:'pointer', display:'flex', alignItems:'center', gap:6,
              transition:'all .18s',
            }}
          >
            📥 استيراد Excel
          </button>
          <button
            onClick={openAdd}
            style={{
              background:'linear-gradient(135deg,#6366f1,#8b5cf6)', color:'#fff',
              border:'none', borderRadius:10, padding:'9px 18px', fontSize:13, fontWeight:700,
              cursor:'pointer', display:'flex', alignItems:'center', gap:6,
              boxShadow:'0 4px 14px rgba(99,102,241,0.35)',
              transition:'all .18s',
            }}
          >
            ＋ إضافة ايتم جديد
          </button>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:20 }}>
        <input
          type="text"
          placeholder="🔍 بحث باسم الايتم، الاسم العلمي، الشركة..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex:1, minWidth:200, padding:'9px 14px', borderRadius:10, border:'1.5px solid #e2e8f0',
            fontSize:13, direction:'rtl', outline:'none', background:'#fff',
            boxShadow:'0 1px 4px rgba(0,0,0,0.05)',
          }}
        />
        <select
          value={filterCompany}
          onChange={e => setFilterCompany(e.target.value)}
          style={{
            padding:'9px 12px', borderRadius:10, border:'1.5px solid #e2e8f0', fontSize:13,
            background:'#fff', outline:'none', cursor:'pointer', minWidth:160,
          }}
        >
          <option value="all">🏢 كل الشركات</option>
          <option value="null">بدون شركة</option>
          {companies.map(c => (
            <option key={`${c.isSci ? 'sci' : 'usr'}-${c.id}`} value={`${c.isSci ? 'sci' : 'usr'}-${c.id}`}>
              {c.name}
            </option>
          ))}
        </select>
        {(search || filterCompany !== 'all') && (
          <button
            onClick={() => { setSearch(''); setFilterCompany('all'); }}
            style={{ padding:'9px 14px', border:'1.5px solid #ef4444', borderRadius:10, color:'#ef4444', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:700 }}
          >
            ✕ مسح
          </button>
        )}
      </div>

      {loading && (
        <div style={{ textAlign:'center', padding:'40px', color:'#94a3b8', fontSize:14 }}>جاري التحميل...</div>
      )}
      {error && (
        <div style={{ textAlign:'center', padding:'20px', color:'#ef4444', fontSize:13 }}>{error}</div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'60px 20px', color:'#94a3b8' }}>
          <div style={{ fontSize:48, marginBottom:12 }}>💊</div>
          <p style={{ fontSize:14, fontWeight:600 }}>لا توجد ايتمات</p>
          <p style={{ fontSize:12, marginTop:4 }}>اضغط "إضافة ايتم جديد" لبدء الإضافة</p>
        </div>
      )}

      {/* ── Grouped cards ───────────────────────────────────── */}
      {!loading && Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b,'ar')).map(([companyName, compItems]) => (
        <div key={companyName} style={{ marginBottom:28 }}>
          {/* Company header */}
          <div className="company-group-header">
            <div style={{
              background:'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius:10,
              padding:'6px 14px', color:'#fff', fontSize:13, fontWeight:700,
              display:'flex', alignItems:'center', gap:6,
              boxShadow:'0 2px 10px rgba(99,102,241,0.3)',
            }}>
              🏢 {companyName}
            </div>
            <span style={{ background:'#f1f5f9', borderRadius:999, padding:'3px 12px', fontSize:12, fontWeight:600, color:'#6366f1' }}>
              {compItems.length} ايتم
            </span>
            <div style={{ flex:1, height:1, background:'linear-gradient(90deg,#e2e8f0,transparent)' }} />
          </div>

          {/* Cards grid */}
          <div
            className="items-grid"
            style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:14 }}
          >
            {compItems.map((item, idx) => (
              <div
                key={item.id}
                className="item-card"
                style={{ animationDelay: `${idx * 30}ms`, padding: item.imageUrl ? 0 : 16, overflow: 'hidden' }}
              >
                {/* Card image */}
                {item.imageUrl && (
                  <div style={{ height: 130, overflow: 'hidden', borderRadius: '14px 14px 0 0', background: '#f1f5f9', cursor: 'pointer' }} onClick={() => openView(item)}>
                    <img src={`${API}${item.imageUrl}`} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                )}
                {/* Card header */}
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10, padding: item.imageUrl ? '12px 16px 0' : 0 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:15, fontWeight:800, color:'#1e293b', lineHeight:1.3 }}>{item.name}</div>
                    {item.scientificName && (
                      <div style={{ fontSize:11, color:'#6366f1', marginTop:2, fontStyle:'italic' }}>🔬 {item.scientificName}</div>
                    )}
                  </div>
                  <div style={{ display:'flex', gap:5, flexShrink:0, marginRight:8 }}>
                    <button
                      onClick={() => openView(item)}
                      title="تفاصيل"
                      style={{ background:'#f0f9ff', border:'none', borderRadius:8, padding:'5px 8px', cursor:'pointer', fontSize:13, color:'#0284c7' }}
                    >👁</button>
                    <button
                      onClick={() => openEdit(item)}
                      title="تعديل"
                      style={{ background:'#f0fdf4', border:'none', borderRadius:8, padding:'5px 8px', cursor:'pointer', fontSize:13, color:'#059669' }}
                    >✏️</button>
                    <button
                      onClick={() => handleDelete(item)}
                      title="حذف"
                      style={{ background:'#fff1f2', border:'none', borderRadius:8, padding:'5px 8px', cursor:'pointer', fontSize:13, color:'#e11d48' }}
                    >🗑</button>
                  </div>
                </div>

                {/* Details */}
                <div style={{ borderTop:'1px solid #f1f5f9', paddingTop:10, ...(item.imageUrl ? { padding: '10px 16px 16px' } : {}) }}>
                  {item.dosage && (
                    <div className="item-detail-row">
                      <span className="item-detail-label">⚖️ الجرعة</span>
                      <span className="item-detail-val">{item.dosage}</span>
                    </div>
                  )}
                  {item.form && (
                    <div className="item-detail-row">
                      <span className="item-detail-label">💿 الشكل</span>
                      <span className="item-detail-val">{item.form}</span>
                    </div>
                  )}
                  {item.price != null && (
                    <div className="item-detail-row">
                      <span className="item-detail-label">💰 السعر</span>
                      <span className="item-detail-val" style={{ color:'#d97706' }}>{item.price.toLocaleString()} د.ع</span>
                    </div>
                  )}
                  {item.scientificMessage && (
                    <div className="item-sci-msg">
                      📋 {item.scientificMessage}
                    </div>
                  )}
                  {!item.dosage && !item.form && item.price == null && !item.scientificMessage && (
                    <div style={{ color:'#cbd5e1', fontSize:12, textAlign:'center', padding:'4px 0' }}>لا توجد تفاصيل مضافة</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ── Add / Edit Modal ─────────────────────────────────── */}
      {(modal === 'add' || modal === 'edit') && (
        <div className="items-modal-overlay" onClick={() => setModal(null)}>
          <div className="items-modal-box" onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:800, color:'#1e293b' }}>
                {modal === 'add' ? '➕ إضافة ايتم جديد' : `✏️ تعديل: ${selected?.name}`}
              </h3>
              <button onClick={() => setModal(null)} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#94a3b8' }}>✕</button>
            </div>

            <div className="items-form-row">
              <label className="items-form-label">💊 اسم الايتم <span style={{ color:'#ef4444' }}>*</span></label>
              <input className="items-form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="مثال: اموكسيسيلين 500mg" />
            </div>
            <div className="items-form-row">
              <label className="items-form-label">🔬 الاسم العلمي</label>
              <input className="items-form-input" value={form.scientificName} onChange={e => setForm(f => ({ ...f, scientificName: e.target.value }))} placeholder="Scientific name" />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div className="items-form-row">
                <label className="items-form-label">⚖️ الجرعة</label>
                <input className="items-form-input" value={form.dosage} onChange={e => setForm(f => ({ ...f, dosage: e.target.value }))} placeholder="500mg" />
              </div>
              <div className="items-form-row">
                <label className="items-form-label">💿 الشكل الدوائي</label>
                <input className="items-form-input" value={form.form} onChange={e => setForm(f => ({ ...f, form: e.target.value }))} placeholder="أقراص / شراب..." />
              </div>
            </div>
            <div className="items-form-row">
              <label className="items-form-label">💰 السعر (د.ع)</label>
              <input className="items-form-input" type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="0" />
            </div>
            <div className="items-form-row">
              <label className="items-form-label">📋 المسج العلمي / ملاحظات</label>
              <textarea className="items-form-input items-form-textarea" value={form.scientificMessage} onChange={e => setForm(f => ({ ...f, scientificMessage: e.target.value }))} placeholder="وصف الايتم والمعلومات العلمية..." />
            </div>

            {saveErr && <div style={{ color:'#ef4444', fontSize:12, marginBottom:10, textAlign:'center' }}>{saveErr}</div>}

            <div style={{ display:'flex', gap:10 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  flex:1, background:'linear-gradient(135deg,#6366f1,#8b5cf6)', color:'#fff',
                  border:'none', borderRadius:10, padding:'11px', fontSize:14, fontWeight:700, cursor:'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'جاري الحفظ...' : modal === 'add' ? 'إضافة' : 'حفظ التعديلات'}
              </button>
              <button
                onClick={() => setModal(null)}
                style={{ flex:1, background:'#f1f5f9', border:'none', borderRadius:10, padding:'11px', fontSize:14, fontWeight:700, cursor:'pointer', color:'#475569' }}
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Details Modal ───────────────────────────────── */}
      {modal === 'view' && selected && (
        <div className="items-modal-overlay" onClick={() => setModal(null)}>
          <div className="items-modal-box" onClick={e => e.stopPropagation()} style={{ padding: 0, overflow: 'hidden' }}>
            {/* Image area */}
            <div style={{ position: 'relative' }}>
              {selected.imageUrl ? (
                <div style={{ height: 200, background: '#f1f5f9', overflow: 'hidden', borderRadius: '18px 18px 0 0' }}>
                  <img src={`${API}${selected.imageUrl}`} alt={selected.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6 }}>
                    <button onClick={() => imageInputRef.current?.click()} style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', color: '#fff', border: 'none', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                      {imageUploading ? '⏳' : '📷 تغيير'}
                    </button>
                    <button onClick={() => handleRemoveImage(selected.id)} style={{ background: 'rgba(220,38,38,0.7)', backdropFilter: 'blur(4px)', color: '#fff', border: 'none', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>🗑 حذف</button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => imageInputRef.current?.click()}
                  style={{ height: 100, background: '#f8fafc', borderRadius: '18px 18px 0 0', border: '2px dashed #e2e8f0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', gap: 4 }}
                >
                  <span style={{ fontSize: 28 }}>🖼️</span>
                  <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>{imageUploading ? '⏳ جاري الرفع...' : '📷 إضافة صورة'}</span>
                </div>
              )}
              <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f && selected) handleImageUpload(selected.id, f); e.target.value = ''; }}
              />
              <button onClick={() => setModal(null)} style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', border: 'none', borderRadius: '50%', width: 30, height: 30, color: '#fff', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
              <h3 style={{ margin:0, fontSize:17, fontWeight:800, color:'#1e293b' }}>💊 {selected.name}</h3>
            </div>

            {/* Detail rows */}
            {[
              { icon:'🔬', label:'الاسم العلمي',     value: selected.scientificName },
              { icon:'⚖️', label:'الجرعة',           value: selected.dosage },
              { icon:'💿', label:'الشكل الدوائي',    value: selected.form },
              { icon:'💰', label:'السعر',             value: selected.price != null ? `${selected.price.toLocaleString()} د.ع` : null },
              { icon:'🏢', label:'الشركة',           value: selected.company?.name },
            ].map(row => row.value && (
              <div key={row.label} style={{ display:'flex', gap:12, alignItems:'center', borderBottom:'1px solid #f8fafc', paddingBottom:10, marginBottom:10 }}>
                <span style={{ fontSize:20, width:28, textAlign:'center' }}>{row.icon}</span>
                <div>
                  <div style={{ fontSize:11, color:'#94a3b8', fontWeight:500 }}>{row.label}</div>
                  <div style={{ fontSize:14, fontWeight:700, color:'#1e293b' }}>{row.value}</div>
                </div>
              </div>
            ))}

            {selected.scientificMessage && (
              <div style={{ background:'linear-gradient(135deg,#f0f9ff,#e0f2fe)', border:'1px solid #bae6fd', borderRadius:12, padding:'14px 16px', marginTop:8 }}>
                <div style={{ fontSize:11, color:'#0284c7', fontWeight:600, marginBottom:6 }}>📋 المسج العلمي</div>
                <p style={{ margin:0, fontSize:13, color:'#0369a1', lineHeight:1.7 }}>{selected.scientificMessage}</p>
              </div>
            )}

            <div style={{ display:'flex', gap:10, marginTop:18 }}>
              <button
                onClick={() => { openEdit(selected); }}
                style={{ flex:1, background:'#f0fdf4', border:'1.5px solid #86efac', borderRadius:10, padding:'10px', fontSize:13, fontWeight:700, cursor:'pointer', color:'#059669' }}
              >✏️ تعديل</button>
              <button
                onClick={() => setModal(null)}
                style={{ flex:1, background:'#f1f5f9', border:'none', borderRadius:10, padding:'10px', fontSize:13, fontWeight:700, cursor:'pointer', color:'#475569' }}
              >إغلاق</button>
            </div>
            </div>{/* end padding wrapper */}
          </div>
        </div>
      )}
      {/* ── Excel Import Modal ───────────────────────────────── */}
      {modal === 'import' && (
        <div className="items-modal-overlay" onClick={() => setModal(null)}>
          <div className="items-modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth:520 }}>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
              <h3 style={{ margin:0, fontSize:17, fontWeight:800, color:'#1e293b', display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:22 }}>📥</span> استيراد الايتمات من Excel
              </h3>
              <button onClick={() => setModal(null)} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#94a3b8' }}>✕</button>
            </div>

            {/* Column guide */}
            <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:12, padding:'12px 14px', marginBottom:18 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#64748b', marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
                <span>📋</span> أعمدة الملف المطلوبة (يمكن بالعربي أو الإنجليزي)
              </div>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr style={{ background:'#e2e8f0' }}>
                      {['الاسم *', 'الاسم العلمي', 'الجرعة', 'الشكل', 'السعر', 'المسج العلمي', 'الشركة'].map(h => (
                        <th key={h} style={{ padding:'5px 8px', textAlign:'center', color:'#475569', fontWeight:700, whiteSpace:'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background:'#fff' }}>
                      {['name', 'scientificName', 'dosage', 'form', 'price', 'scientificMessage', 'companyName'].map(e => (
                        <td key={e} style={{ padding:'4px 8px', textAlign:'center', color:'#94a3b8', fontSize:10 }}>{e}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p style={{ margin:'8px 0 0', fontSize:10.5, color:'#94a3b8' }}>
                * الاسم إلزامي · اسم الشركة يجب أن يتطابق مع الشركات الموجودة
              </p>
            </div>

            {/* File picker */}
            <div
              onClick={() => importInputRef.current?.click()}
              style={{
                border: `2px dashed ${importFile ? '#059669' : '#cbd5e1'}`,
                borderRadius: 12,
                padding: '20px',
                textAlign: 'center',
                cursor: 'pointer',
                background: importFile ? '#f0fdf4' : '#f8fafc',
                transition: 'all .18s',
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 6 }}>{importFile ? '✅' : '📂'}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: importFile ? '#059669' : '#475569' }}>
                {importFile ? importFile.name : 'اضغط لاختيار ملف Excel أو CSV'}
              </div>
              {importFile && (
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  {(importFile.size / 1024).toFixed(1)} KB
                </div>
              )}
              <input
                ref={importInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  setImportFile(f);
                  setImportResult(null);
                }}
              />
            </div>

            {/* Import result */}
            {importResult && (
              <div style={{ marginBottom: 16, borderRadius: 12, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', gap: 0 }}>
                  <div style={{ flex: 1, background: '#f0fdf4', padding: '10px 0', textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#059669' }}>{importResult.inserted}</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>✅ تم الإضافة</div>
                  </div>
                  <div style={{ flex: 1, background: '#fffbeb', padding: '10px 0', textAlign: 'center', borderRight: '1px solid #e2e8f0', borderLeft: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#d97706' }}>{importResult.skipped}</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>⚠️ تم التحديث</div>
                  </div>
                  <div style={{ flex: 1, background: importResult.errors.length > 0 ? '#fef2f2' : '#f8fafc', padding: '10px 0', textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: importResult.errors.length > 0 ? '#ef4444' : '#94a3b8' }}>{importResult.errors.length}</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>❌ أخطاء</div>
                  </div>
                </div>
                {importResult.errors.length > 0 && (
                  <div style={{ background: '#fef2f2', padding: '10px 14px', borderTop: '1px solid #fee2e2', maxHeight: 100, overflowY: 'auto' }}>
                    {importResult.errors.map((err, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#ef4444', marginBottom: 3 }}>• {err}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleImport}
                disabled={!importFile || importing}
                style={{
                  flex: 1, background: importFile && !importing ? 'linear-gradient(135deg,#059669,#10b981)' : '#e2e8f0',
                  color: importFile && !importing ? '#fff' : '#94a3b8',
                  border: 'none', borderRadius: 10, padding: '11px', fontSize: 14, fontWeight: 700,
                  cursor: importFile && !importing ? 'pointer' : 'not-allowed',
                  transition: 'all .18s',
                  boxShadow: importFile && !importing ? '0 4px 14px rgba(5,150,105,0.3)' : 'none',
                }}
              >
                {importing ? '⏳ جاري الاستيراد...' : '📥 استيراد'}
              </button>
              <button
                onClick={() => setModal(null)}
                style={{ flex: 1, background: '#f1f5f9', border: 'none', borderRadius: 10, padding: '11px', fontSize: 14, fontWeight: 700, cursor: 'pointer', color: '#475569' }}
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
