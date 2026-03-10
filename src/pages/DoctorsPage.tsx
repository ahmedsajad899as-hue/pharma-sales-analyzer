import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface Area   { id: number; name: string; }
interface Item   { id: number; name: string; }
interface Doctor {
  id: number;
  name: string;
  specialty?: string;
  pharmacyName?: string;
  notes?: string;
  isActive: boolean;
  area?: Area;
  targetItem?: Item;
}

export default function DoctorsPage() {
  const { token } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [doctors, setDoctors]   = useState<Doctor[]>([]);
  const [areas, setAreas]       = useState<Area[]>([]);
  const [items, setItems]       = useState<Item[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [filterArea, setFilterArea] = useState<string>('all');

  // modal
  const [modal, setModal]     = useState<'add' | 'edit' | null>(null);
  const [selected, setSelected] = useState<Doctor | null>(null);
  const [saving, setSaving]   = useState(false);

  // form
  const [fName, setFName]               = useState('');
  const [fSpecialty, setFSpecialty]     = useState('');
  const [fPharmacy, setFPharmacy]       = useState('');
  const [fNotes, setFNotes]             = useState('');
  const [fAreaId, setFAreaId]           = useState('');
  const [fAreaName, setFAreaName]       = useState('');
  const [fAreaSugg, setFAreaSugg]       = useState<Area[]>([]);
  const [fAreaShowSugg, setFAreaShowSugg] = useState(false);
  const [fItemId, setFItemId]           = useState('');
  const [fItemName, setFItemName]       = useState('');
  const [fItemSugg, setFItemSugg]       = useState<Item[]>([]);
  const [fItemShowSugg, setFItemShowSugg] = useState(false);
  const [fActive, setFActive]           = useState(true);

  // excel import
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting]     = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number; skipped: number; errors: any[];
    colMap?: Record<string, string | null>;
    detectedCols?: string[];
    error?: string; hint?: string;
  } | null>(null);
  const [showImportPanel, setShowImportPanel] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const [dr, ar, it] = await Promise.all([
        fetch(`${API}/api/doctors`, { headers: h }),
        fetch(`${API}/api/areas`,   { headers: h }),
        fetch(`${API}/api/items`,   { headers: h }),
      ]);
      const [drJson, arJson, itJson] = await Promise.all([dr.json(), ar.json(), it.json()]);
      if (!dr.ok) throw new Error(drJson.error ?? `خطأ ${dr.status}`);
      if (!ar.ok) throw new Error(arJson.error ?? `خطأ ${ar.status}`);
      if (!it.ok) throw new Error(itJson.error ?? `خطأ ${it.status}`);
      setDoctors(Array.isArray(drJson) ? drJson : []);
      const arArr = Array.isArray(arJson) ? arJson : (Array.isArray(arJson?.data) ? arJson.data : []);
      const itArr = Array.isArray(itJson) ? itJson : (Array.isArray(itJson?.data) ? itJson.data : []);
      setAreas(arArr);
      setItems(itArr);
    } catch (e: any) { setError(e.message ?? 'خطأ في التحميل'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setSelected(null);
    setFName(''); setFSpecialty(''); setFPharmacy(''); setFNotes('');
    setFAreaId(''); setFAreaName(''); setFAreaSugg([]); setFAreaShowSugg(false);
    setFItemId(''); setFItemName(''); setFItemSugg([]); setFItemShowSugg(false);
    setFActive(true);
    setModal('add');
  };

  const openEdit = (d: Doctor) => {
    setSelected(d);
    setFName(d.name); setFSpecialty(d.specialty ?? ''); setFPharmacy(d.pharmacyName ?? '');
    setFNotes(d.notes ?? '');
    setFAreaId(d.area?.id?.toString() ?? ''); setFAreaName(d.area?.name ?? ''); setFAreaSugg([]); setFAreaShowSugg(false);
    setFItemId(d.targetItem?.id?.toString() ?? ''); setFItemName(d.targetItem?.name ?? ''); setFItemSugg([]); setFItemShowSugg(false);
    setFActive(d.isActive);
    setModal('edit');
  };

  const save = async () => {
    if (!fName.trim()) { alert('اسم الطبيب مطلوب'); return; }
    setSaving(true);
    try {
      // Resolve or create area
      let resolvedAreaId = fAreaId;
      if (fAreaName.trim() && !resolvedAreaId) {
        const r = await fetch(`${API}/api/areas`, { method: 'POST', headers: H(), body: JSON.stringify({ name: fAreaName.trim() }) });
        if (r.ok) { const j = await r.json(); resolvedAreaId = String(j.id); setAreas(prev => prev.some(a => a.id === j.id) ? prev : [...prev, j].sort((a, b) => a.name.localeCompare(b.name))); }
      } else if (!fAreaName.trim()) { resolvedAreaId = ''; }
      // Resolve or create item
      let resolvedItemId = fItemId;
      if (fItemName.trim() && !resolvedItemId) {
        const r = await fetch(`${API}/api/items`, { method: 'POST', headers: H(), body: JSON.stringify({ name: fItemName.trim() }) });
        if (r.ok) { const j = await r.json(); const item = j.data ?? j; resolvedItemId = String(item.id); setItems(prev => prev.some(i => i.id === item.id) ? prev : [...prev, item].sort((a, b) => a.name.localeCompare(b.name))); }
      } else if (!fItemName.trim()) { resolvedItemId = ''; }

      const body = { name: fName.trim(), specialty: fSpecialty.trim() || null, pharmacyName: fPharmacy.trim() || null,
        notes: fNotes.trim() || null, areaId: resolvedAreaId || null, targetItemId: resolvedItemId || null, isActive: fActive };
      const url  = modal === 'edit' ? `${API}/api/doctors/${selected!.id}` : `${API}/api/doctors`;
      const resp = await fetch(url, { method: modal === 'edit' ? 'PUT' : 'POST', headers: H(), body: JSON.stringify(body) });
      if (!resp.ok) { const j = await resp.json(); throw new Error(j.error ?? 'فشل الحفظ'); }
      await load(); setModal(null);
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('هل تريد حذف هذا الطبيب؟')) return;
    await fetch(`${API}/api/doctors/${id}`, { method: 'DELETE', headers: H() });
    await load();
  };

  const deleteAll = async () => {
    if (!confirm(`⚠️ هل تريد مسح جميع الأطباء (${doctors.length} طبيب)؟\nهذه العملية لا يمكن التراجع عنها.`)) return;
    try {
      const r = await fetch(`${API}/api/doctors/all`, { method: 'DELETE', headers: H() });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? 'فشل الحذف'); }
      setImportResult(null);
      await load();
    } catch (e: any) { alert(e.message); }
  };

  const importExcel = async (file: File) => {
    setImporting(true); setImportResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`${API}/api/doctors/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const j = await r.json();
      // Always store the result (even errors contain detectedCols)
      setImportResult(j);
      if (r.ok && j.imported > 0) await load();
    } catch (e: any) { alert(e.message); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const filtered = doctors.filter(d => {
    const matchSearch = !search || d.name.includes(search) || (d.specialty ?? '').includes(search) || (d.pharmacyName ?? '').includes(search);
    const matchArea   = filterArea === 'all' || d.area?.id?.toString() === filterArea;
    return matchSearch && matchArea;
  });

  const fieldLabels: Record<string, string> = {
    name: 'الاسم', specialty: 'التخصص', area: 'المنطقة',
    pharmacy: 'الصيدلية', item: 'الايتم', notes: 'ملاحظات',
  };

  return (
    <div className="page-container" dir="rtl">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1e293b' }}>🏥 قائمة السيرفي</h1>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 14 }}>إدارة قاعدة بيانات الأطباء</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => { setShowImportPanel(v => !v); setImportResult(null); }}
            style={btnStyle('#10b981')}>
            📊 استيراد Excel
          </button>
          <button onClick={openAdd} style={btnStyle('#3b82f6')}>+ إضافة طبيب</button>
          {doctors.length > 0 && (
            <button onClick={deleteAll} style={btnStyle('#ef4444')}
              title="مسح جميع الأطباء">
              🗑 مسح الكل
            </button>
          )}
        </div>
      </div>

      {/* Excel import panel */}
      {showImportPanel && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15, color: '#166534' }}>📊 استيراد قائمة السيرفي من Excel</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#15803d', lineHeight: 1.7 }}>
            النظام يكتشف الأعمدة تلقائياً من ملفك. ارفع الملف وسيظهر لك أي أعمدة تم التعرف عليها.
            <br />
            <span style={{ fontSize: 12, color: '#166534' }}>
              الأعمدة المدعومة (بأي تسمية): اسم الطبيب · التخصص · المنطقة · الصيدلية · الايتم · ملاحظات
            </span>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && importExcel(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={importing}
              style={{ ...btnStyle('#3b82f6'), opacity: importing ? 0.7 : 1 }}>
              {importing ? '⏳ جاري الاستيراد...' : '📂 اختر ملف Excel'}
            </button>
            {importResult && !importResult.error && (
              <div style={{ fontSize: 13, color: importResult.imported > 0 ? '#166534' : '#92400e', fontWeight: 600 }}>
                {importResult.imported > 0
                  ? `✅ تم استيراد ${importResult.imported} طبيب`
                  : '⚠️ لم يتم استيراد أي طبيب'}
                {(importResult.skipped ?? 0) > 0 && <span style={{ color: '#92400e', marginRight: 8 }}> | تخطي صفوف: {importResult.skipped}</span>}
                {(importResult.errors?.length ?? 0) > 0 && <span style={{ color: '#991b1b', marginRight: 8 }}> | أخطاء: {importResult.errors.length}</span>}
              </div>
            )}
          </div>

          {/* Column mapping result */}
          {importResult?.colMap && (
            <div style={{ marginTop: 12, background: '#fff', borderRadius: 8, padding: 12, border: '1px solid #d1fae5' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#374151' }}>🔍 الأعمدة المكتشفة في ملفك:</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(importResult.colMap).map(([field, col]) => (
                  <span key={field} style={{
                    padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: col ? '#dcfce7' : '#fee2e2',
                    color: col ? '#166534' : '#991b1b'
                  }}>
                    {fieldLabels[field] ?? field}: {col ? `"${col}"` : '❌ غير موجود'}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Error: column not found */}
          {importResult?.error && (
            <div style={{ marginTop: 10, background: '#fee2e2', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700, color: '#991b1b' }}>❌ {importResult.error}</p>
              {importResult.hint && <p style={{ margin: '0 0 8px', color: '#7f1d1d' }}>{importResult.hint}</p>}
              {importResult.detectedCols && (
                <div>
                  <p style={{ margin: '0 0 4px', color: '#374151', fontWeight: 600 }}>الأعمدة الموجودة في ملفك:</p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {importResult.detectedCols.map((c, i) => (
                      <span key={i} style={{ padding: '2px 8px', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}>{c}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {(importResult?.errors?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10, background: '#fee2e2', borderRadius: 8, padding: 10, fontSize: 12, color: '#991b1b', maxHeight: 120, overflowY: 'auto' }}>
              {importResult!.errors.map((e, i) => (
                <div key={i}>صف {e.row}: {e.name} — {e.error}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div style={alertStyle}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="بحث بالاسم أو التخصص..."
          style={inputStyle}
        />
        <select value={filterArea} onChange={e => setFilterArea(e.target.value)} style={inputStyle}>
          <option value="all">كل المناطق</option>
          {areas.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
        </select>
      </div>

      {/* Table */}
      {loading ? <p style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>جاري التحميل...</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['الاسم', 'التخصص', 'المنطقة', 'الصيدلية', 'الايتم المستهدف', 'الحالة', 'إجراءات'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>لا توجد بيانات</td></tr>
              ) : filtered.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={tdStyle}>{d.name}</td>
                  <td style={tdStyle}>{d.specialty ?? '-'}</td>
                  <td style={tdStyle}>{d.area?.name ?? '-'}</td>
                  <td style={tdStyle}>{d.pharmacyName ?? '-'}</td>
                  <td style={tdStyle}>{d.targetItem?.name ?? '-'}</td>
                  <td style={tdStyle}>
                    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                      background: d.isActive ? '#dcfce7' : '#fee2e2', color: d.isActive ? '#166534' : '#991b1b' }}>
                      {d.isActive ? 'نشط' : 'غير نشط'}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <button onClick={() => openEdit(d)} style={{ ...btnSmall('#6366f1'), marginLeft: 6 }}>تعديل</button>
                    <button onClick={() => remove(d.id)} style={btnSmall('#ef4444')}>حذف</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>
            إجمالي: {filtered.length} طبيب
          </p>
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>{modal === 'add' ? '+ إضافة طبيب' : 'تعديل بيانات الطبيب'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={labelStyle}>
                اسم الطبيب *
                <input value={fName} onChange={e => setFName(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                التخصص
                <input value={fSpecialty} onChange={e => setFSpecialty(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                المنطقة
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={fAreaName}
                    autoComplete="off"
                    placeholder="اكتب اسم المنطقة..."
                    style={{ ...inputStyle, paddingLeft: fAreaId ? '28px' : undefined }}
                    onChange={e => {
                      const v = e.target.value;
                      setFAreaName(v); setFAreaId('');
                      if (!v.trim()) { setFAreaSugg([]); setFAreaShowSugg(false); return; }
                      const lv = v.toLowerCase();
                      const m = areas.filter(a => a.name.toLowerCase().includes(lv)).slice(0, 7);
                      setFAreaSugg(m); setFAreaShowSugg(true);
                    }}
                    onBlur={() => setTimeout(() => setFAreaShowSugg(false), 180)}
                    onFocus={() => { if (fAreaSugg.length > 0) setFAreaShowSugg(true); }}
                  />
                  {fAreaId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#059669', fontWeight: 700 }}>✓</span>}
                  {!fAreaId && fAreaName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>جديد</span>}
                  {fAreaShowSugg && fAreaSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fAreaSugg.map(a => (
                        <div key={a.id}
                          onMouseDown={() => { setFAreaId(String(a.id)); setFAreaName(a.name); setFAreaSugg([]); setFAreaShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                          {a.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label style={labelStyle}>
                اسم الصيدلية
                <input value={fPharmacy} onChange={e => setFPharmacy(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                الايتم المستهدف
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={fItemName}
                    autoComplete="off"
                    placeholder="اكتب اسم الصنف..."
                    style={{ ...inputStyle, paddingLeft: fItemId ? '28px' : undefined }}
                    onChange={e => {
                      const v = e.target.value;
                      setFItemName(v); setFItemId('');
                      if (!v.trim()) { setFItemSugg([]); setFItemShowSugg(false); return; }
                      const lv = v.toLowerCase();
                      const m = items.filter(i => i.name.toLowerCase().includes(lv)).slice(0, 7);
                      setFItemSugg(m); setFItemShowSugg(true);
                    }}
                    onBlur={() => setTimeout(() => setFItemShowSugg(false), 180)}
                    onFocus={() => { if (fItemSugg.length > 0) setFItemShowSugg(true); }}
                  />
                  {fItemId && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#059669', fontWeight: 700 }}>✓</span>}
                  {!fItemId && fItemName.trim() && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>جديد</span>}
                  {fItemShowSugg && fItemSugg.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', marginTop: 2, overflow: 'hidden' }}>
                      {fItemSugg.map(i => (
                        <div key={i.id}
                          onMouseDown={() => { setFItemId(String(i.id)); setFItemName(i.name); setFItemSugg([]); setFItemShowSugg(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>
                          {i.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label style={labelStyle}>
                الحالة
                <select value={fActive ? 'true' : 'false'} onChange={e => setFActive(e.target.value === 'true')} style={inputStyle}>
                  <option value="true">نشط</option>
                  <option value="false">غير نشط</option>
                </select>
              </label>
            </div>
            <label style={{ ...labelStyle, gridColumn: 'span 2', marginTop: 8 }}>
              ملاحظات
              <textarea value={fNotes} onChange={e => setFNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setModal(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
              <button onClick={save} disabled={saving} style={btnStyle('#3b82f6')}>{saving ? 'جاري الحفظ...' : 'حفظ'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const btnStyle = (bg: string) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 8,
  padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 14,
});
const btnSmall = (bg: string) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12,
});
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box', direction: 'rtl',
};
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#374151' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const thStyle: React.CSSProperties    = { textAlign: 'right', padding: '10px 12px', fontWeight: 700, fontSize: 13, color: '#475569', borderBottom: '2px solid #e2e8f0' };
const tdStyle: React.CSSProperties    = { padding: '10px 12px', color: '#1e293b', verticalAlign: 'middle' };
const alertStyle: React.CSSProperties = { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16 };
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalStyle: React.CSSProperties   = { background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl' };
