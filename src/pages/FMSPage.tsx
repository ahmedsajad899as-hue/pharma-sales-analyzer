import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';

interface SciRep  { id: number; name: string; }
interface Item    { id: number; name: string; }
interface FmsPlanItem { id?: number; itemId: number | null; itemName: string; quantity: number; }
interface FmsPlan {
  id: number;
  month: number;
  year: number;
  notes: string | null;
  scientificRepId: number;
  scientificRep: SciRep;
  items: FmsPlanItem[];
}

const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

/* ─── Bulk-picker sub-component ─── */
function BulkItemPicker({ items, existing, onAdd, onClose }: {
  items: Item[];
  existing: FmsPlanItem[];
  onAdd: (rows: FmsPlanItem[]) => void;
  onClose: () => void;
}) {
  const [search,   setSearch]   = useState('');
  const [checked,  setChecked]  = useState<Set<number>>(new Set());
  const [defQty,   setDefQty]   = useState(1);

  const existingIds = new Set(existing.map(r => r.itemId).filter(Boolean));
  const filtered = items.filter(it =>
    !existingIds.has(it.id) &&
    it.name.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id: number) => setChecked(p => {
    const s = new Set(p);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const toggleAll = () => {
    if (checked.size === filtered.length) setChecked(new Set());
    else setChecked(new Set(filtered.map(it => it.id)));
  };

  const confirm = () => {
    const rows: FmsPlanItem[] = [...checked].map(id => {
      const it = items.find(x => x.id === id)!;
      return { itemId: it.id, itemName: it.name, quantity: defQty };
    });
    onAdd(rows);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 500, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>📋 اختيار أصناف متعددة</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>✕</button>
        </div>
        {/* Search + default qty */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث..."
            style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            كمية افتراضية:
            <input type="number" min="1" value={defQty} onChange={e => setDefQty(parseInt(e.target.value) || 1)}
              style={{ width: 60, padding: '6px 8px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          </label>
        </div>
        {/* Select all row */}
        <div style={{ padding: '6px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={checked.size === filtered.length && filtered.length > 0}
            onChange={toggleAll} style={{ width: 15, height: 15, cursor: 'pointer' }} />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            تحديد الكل ({filtered.length} صنف) {checked.size > 0 && `— محدد: ${checked.size}`}
          </span>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0
            ? <div style={{ padding: '30px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>لا توجد أصناف</div>
            : filtered.map(it => (
              <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', cursor: 'pointer', borderBottom: '1px solid #f9fafb', background: checked.has(it.id) ? '#eef2ff' : undefined }}>
                <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)}
                  style={{ width: 15, height: 15, cursor: 'pointer' }} />
                <span style={{ fontSize: 13, fontWeight: checked.has(it.id) ? 600 : 400, color: checked.has(it.id) ? '#4f46e5' : '#1e293b' }}>{it.name}</span>
              </label>
            ))
          }
        </div>
        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{checked.size} صنف محدد</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>إلغاء</button>
            <button onClick={confirm} disabled={checked.size === 0}
              style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: checked.size === 0 ? 'not-allowed' : 'pointer', background: checked.size === 0 ? '#c7d2fe' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
              ✅ إضافة {checked.size > 0 ? `(${checked.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FMSPage() {
  const { token } = useAuth();
  const authH = useCallback(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token]);

  const [sciReps, setSciReps]   = useState<SciRep[]>([]);
  const [items,   setItems]     = useState<Item[]>([]);
  const [plans,   setPlans]     = useState<FmsPlan[]>([]);
  const [loading, setLoading]   = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState('');
  const [success, setSuccess]   = useState('');

  const [filterMonth, setFilterMonth] = useState<string>(String(new Date().getMonth() + 1));
  const [filterYear,  setFilterYear]  = useState<string>(String(new Date().getFullYear()));

  const [showForm,    setShowForm]    = useState(false);
  const [showPicker,  setShowPicker]  = useState(false);
  const [editPlan,    setEditPlan]    = useState<FmsPlan | null>(null);
  const [formRepId,   setFormRepId]   = useState('');
  const [formMonth,   setFormMonth]   = useState(String(new Date().getMonth() + 1));
  const [formYear,    setFormYear]    = useState(String(new Date().getFullYear()));
  const [formNotes,   setFormNotes]   = useState('');
  const [formItems,   setFormItems]   = useState<FmsPlanItem[]>([{ itemId: null, itemName: '', quantity: 0 }]);

  useEffect(() => {
    fetch('/api/scientific-reps', { headers: authH() })
      .then(r => r.json())
      .then(j => setSciReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
    fetch('/api/items', { headers: authH() })
      .then(r => r.json())
      .then(j => setItems(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  }, [authH]);

  const loadPlans = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams({ month: filterMonth, year: filterYear });
      const r = await fetch(`/api/fms?${q}`, { headers: authH() });
      const j = await r.json();
      setPlans(j.data ?? []);
    } catch {
      setError('فشل في تحميل البيانات');
    } finally { setLoading(false); }
  }, [authH, filterMonth, filterYear]);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const openNew = () => {
    setEditPlan(null);
    setFormRepId(sciReps[0] ? String(sciReps[0].id) : '');
    setFormMonth(filterMonth);
    setFormYear(filterYear);
    setFormNotes('');
    setFormItems([{ itemId: null, itemName: '', quantity: 0 }]);
    setShowForm(true);
  };

  const openEdit = (plan: FmsPlan) => {
    setEditPlan(plan);
    setFormRepId(String(plan.scientificRepId));
    setFormMonth(String(plan.month));
    setFormYear(String(plan.year));
    setFormNotes(plan.notes ?? '');
    setFormItems(plan.items.length > 0 ? plan.items.map(it => ({ ...it })) : [{ itemId: null, itemName: '', quantity: 0 }]);
    setShowForm(true);
  };

  const addRow = () => setFormItems(p => [...p, { itemId: null, itemName: '', quantity: 0 }]);
  const removeRow = (i: number) => setFormItems(p => p.filter((_, idx) => idx !== i));
  const setRowItem = (i: number, itemId: number | null, itemName: string) =>
    setFormItems(p => p.map((r, idx) => idx === i ? { ...r, itemId, itemName } : r));
  const setRowQty = (i: number, qty: number) =>
    setFormItems(p => p.map((r, idx) => idx === i ? { ...r, quantity: qty } : r));

  const handleItemSelect = (i: number, val: string) => {
    const found = items.find(it => it.name === val);
    if (found) setRowItem(i, found.id, found.name);
    else       setRowItem(i, null, val);
  };

  const handleBulkAdd = (rows: FmsPlanItem[]) => {
    setFormItems(prev => {
      const cleaned = prev.filter(r => r.itemName.trim() !== '' || r.quantity > 0);
      return [...cleaned, ...rows];
    });
  };

  const savePlan = async () => {
    if (!formRepId) { setError('اختر مندوباً'); return; }
    const validItems = formItems.filter(it => it.itemName.trim() && it.quantity > 0);
    if (validItems.length === 0) { setError('أضف صنفاً واحداً على الأقل بكمية أكبر من صفر'); return; }
    setSaving(true); setError('');
    try {
      const body = { scientificRepId: formRepId, month: formMonth, year: formYear, notes: formNotes, items: validItems };
      const r = await fetch('/api/fms', { method: 'POST', headers: authH(), body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'خطأ في الحفظ');
      setSuccess('تم الحفظ بنجاح ✓');
      setShowForm(false);
      loadPlans();
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const deletePlan = async (id: number) => {
    if (!confirm('هل تريد حذف هذه الخطة؟')) return;
    try {
      await fetch(`/api/fms/${id}`, { method: 'DELETE', headers: authH() });
      setPlans(p => p.filter(x => x.id !== id));
    } catch { setError('فشل في الحذف'); }
  };

  const exportExcel = () => {
    const wb = XLSX.utils.book_new();
    const summaryRows: any[][] = [['المندوب العلمي', 'الشهر', 'السنة', 'الملاحظات', 'عدد الأصناف', 'إجمالي الكميات']];
    plans.forEach(p => {
      summaryRows.push([p.scientificRep.name, MONTHS[p.month - 1], p.year, p.notes ?? '', p.items.length, p.items.reduce((s, it) => s + it.quantity, 0)]);
    });
    const summWs = XLSX.utils.aoa_to_sheet(summaryRows);
    summWs['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 30 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, summWs, 'ملخص');
    plans.forEach(p => {
      const rows: any[][] = [
        [`المندوب: ${p.scientificRep.name} — ${MONTHS[p.month - 1]} ${p.year}`], [],
        ['#', 'الصنف', 'الكمية'],
        ...p.items.map((it, i) => [i + 1, it.itemName, it.quantity]),
        [], ['', 'الإجمالي', p.items.reduce((s, it) => s + it.quantity, 0)],
      ];
      if (p.notes) rows.push(['', 'ملاحظات:', p.notes]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 5 }, { wch: 35 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, p.scientificRep.name.slice(0, 31));
    });
    XLSX.writeFile(wb, `FMS_${MONTHS[parseInt(filterMonth) - 1]}_${filterYear}.xlsx`);
  };

  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - 2 + i));

  return (
    <div style={{ padding: '20px 16px', maxWidth: 1100, margin: '0 auto', direction: 'rtl', fontFamily: 'inherit' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1e293b' }}>🧪 FMS — عينات مجانية شهرية</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>تعيين العينات الشهرية المجانية لكل مندوب علمي</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {plans.length > 0 && (
            <button onClick={exportExcel} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: 13 }}>📥 تصدير Excel</button>
          )}
          <button onClick={openNew} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>+ خطة جديدة</button>
        </div>
      </div>

      {error   && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #fecaca' }}>{error}</div>}
      {success && <div style={{ background: '#f0fdf4', color: '#15803d', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #bbf7d0' }}>{success}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          الشهر:
          <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          السنة:
          <select value={filterYear} onChange={e => setFilterYear(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {years.map(y => <option key={y}>{y}</option>)}
          </select>
        </label>
      </div>

      {/* Plans list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>جاري التحميل...</div>
      ) : plans.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧪</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>لا توجد خطط لهذا الشهر</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>اضغط "+ خطة جديدة" لإضافة خطة</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plans.map(plan => (
            <div key={plan.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16 }}>🔬</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{plan.scientificRep.name}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{MONTHS[plan.month - 1]} {plan.year} — {plan.items.length} صنف / {plan.items.reduce((s, it) => s + it.quantity, 0)} وحدة</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => openEdit(plan)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4f46e5', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>✏️ تعديل</button>
                  <button onClick={() => deletePlan(plan.id)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>🗑️ حذف</button>
                </div>
              </div>
              <div style={{ padding: '10px 16px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>#</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>الصنف</th>
                      <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, color: '#374151' }}>الكمية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.items.map((it, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', color: '#9ca3af', fontSize: 11 }}>{i + 1}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 500 }}>{it.itemName}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                          <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 6, padding: '2px 10px', fontWeight: 700, fontSize: 12 }}>{it.quantity}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                      <td colSpan={2} style={{ padding: '6px 10px', color: '#15803d' }}>الإجمالي</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>{plan.items.reduce((s, it) => s + it.quantity, 0)}</td>
                    </tr>
                  </tfoot>
                </table>
                {plan.notes && <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>📝 {plan.notes}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bulk picker */}
      {showPicker && (
        <BulkItemPicker
          items={items}
          existing={formItems}
          onAdd={handleBulkAdd}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* Form Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setShowForm(false)}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 700, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{editPlan ? '✏️ تعديل الخطة' : '➕ خطة جديدة'}</div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>✕</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {error && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  المندوب العلمي *
                  <select value={formRepId} onChange={e => setFormRepId(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {sciReps.map(r => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  الشهر *
                  <select value={formMonth} onChange={e => setFormMonth(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  السنة *
                  <select value={formYear} onChange={e => setFormYear(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {years.map(y => <option key={y}>{y}</option>)}
                  </select>
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>الأصناف والكميات ({formItems.filter(r => r.itemName.trim()).length})</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setShowPicker(true)}
                    style={{ fontSize: 12, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 600 }}>
                    📋 اختيار متعدد
                  </button>
                  <button onClick={addRow}
                    style={{ fontSize: 12, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}>
                    + إضافة صف
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {formItems.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 18, textAlign: 'center' }}>{i + 1}</span>
                    <div style={{ flex: 2 }}>
                      <input
                        list={`items-list-${i}`}
                        value={row.itemName}
                        onChange={e => handleItemSelect(i, e.target.value)}
                        placeholder="اسم الصنف..."
                        style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                      />
                      <datalist id={`items-list-${i}`}>
                        {items.map(it => <option key={it.id} value={it.name} />)}
                      </datalist>
                    </div>
                    <input type="number" min="1" value={row.quantity || ''} onChange={e => setRowQty(i, parseInt(e.target.value) || 0)}
                      placeholder="الكمية"
                      style={{ width: 90, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
                    {formItems.length > 1 && (
                      <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>✕</button>
                    )}
                  </div>
                ))}
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                ملاحظات (اختياري)
                <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={2}
                  placeholder="ملاحظات عامة..."
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical' }} />
              </label>
            </div>

            <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>إلغاء</button>
              <button onClick={savePlan} disabled={saving}
                style={{ padding: '8px 22px', borderRadius: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
                {saving ? '⏳ جاري الحفظ...' : '✅ حفظ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
