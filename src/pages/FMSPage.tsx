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

const MONTHS = ['ÙŠÙ†Ø§ÙŠØ±','ÙØ¨Ø±Ø§ÙŠØ±','Ù…Ø§Ø±Ø³','Ø£Ø¨Ø±ÙŠÙ„','Ù…Ø§ÙŠÙˆ','ÙŠÙˆÙ†ÙŠÙˆ','ÙŠÙˆÙ„ÙŠÙˆ','Ø£ØºØ³Ø·Ø³','Ø³Ø¨ØªÙ…Ø¨Ø±','Ø£ÙƒØªÙˆØ¨Ø±','Ù†ÙˆÙÙ…Ø¨Ø±','Ø¯ÙŠØ³Ù…Ø¨Ø±'];

/* â”€â”€â”€ Bulk-picker sub-component â”€â”€â”€ */
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
          <span style={{ fontWeight: 700, fontSize: 14 }}>ðŸ“‹ Ø§Ø®ØªÙŠØ§Ø± Ø£ØµÙ†Ø§Ù Ù…ØªØ¹Ø¯Ø¯Ø©</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>âœ•</button>
        </div>
        {/* Search + default qty */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ðŸ” Ø¨Ø­Ø«..."
            style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            ÙƒÙ…ÙŠØ© Ø§ÙØªØ±Ø§Ø¶ÙŠØ©:
            <input type="number" min="1" value={defQty} onChange={e => setDefQty(parseInt(e.target.value) || 1)}
              style={{ width: 60, padding: '6px 8px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
          </label>
        </div>
        {/* Select all row */}
        <div style={{ padding: '6px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={checked.size === filtered.length && filtered.length > 0}
            onChange={toggleAll} style={{ width: 15, height: 15, cursor: 'pointer' }} />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            ØªØ­Ø¯ÙŠØ¯ Ø§Ù„ÙƒÙ„ ({filtered.length} ØµÙ†Ù) {checked.size > 0 && `â€” Ù…Ø­Ø¯Ø¯: ${checked.size}`}
          </span>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0
            ? <div style={{ padding: '30px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Ù„Ø§ ØªÙˆØ¬Ø¯ Ø£ØµÙ†Ø§Ù</div>
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
          <span style={{ fontSize: 12, color: '#6b7280' }}>{checked.size} ØµÙ†Ù Ù…Ø­Ø¯Ø¯</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Ø¥Ù„ØºØ§Ø¡</button>
            <button onClick={confirm} disabled={checked.size === 0}
              style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: checked.size === 0 ? 'not-allowed' : 'pointer', background: checked.size === 0 ? '#c7d2fe' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>
              âœ… Ø¥Ø¶Ø§ÙØ© {checked.size > 0 ? `(${checked.size})` : ''}
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

  // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [sciReps, setSciReps]   = useState<SciRep[]>([]);
  const [items,   setItems]     = useState<Item[]>([]);
  const [plans,   setPlans]     = useState<FmsPlan[]>([]);
  const [loading, setLoading]   = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState('');
  const [success, setSuccess]   = useState('');

  // Filter
  const [filterMonth, setFilterMonth] = useState<string>(String(new Date().getMonth() + 1));
  const [filterYear,  setFilterYear]  = useState<string>(String(new Date().getFullYear()));

  // Form state
  const [showForm,    setShowForm]    = useState(false);
  const [showPicker,  setShowPicker]  = useState(false);
  const [editPlan,    setEditPlan]    = useState<FmsPlan | null>(null);
  const [formRepId,   setFormRepId]   = useState('');
  const [formMonth,   setFormMonth]   = useState(String(new Date().getMonth() + 1));
  const [formYear,    setFormYear]    = useState(String(new Date().getFullYear()));
  const [formNotes,   setFormNotes]   = useState('');
  const [formItems,   setFormItems]   = useState<FmsPlanItem[]>([{ itemId: null, itemName: '', quantity: 0 }]);

  // â”€â”€ Load â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      setError('ÙØ´Ù„ ÙÙŠ ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª');
    } finally { setLoading(false); }
  }, [authH, filterMonth, filterYear]);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // â”€â”€ Form helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Bulk-add from picker
  const handleBulkAdd = (rows: FmsPlanItem[]) => {
    setFormItems(prev => {
      // Remove empty placeholder rows, then append new ones
      const cleaned = prev.filter(r => r.itemName.trim() !== '' || r.quantity > 0);
      return [...cleaned, ...rows];
    });
  };

  const savePlan = async () => {
    if (!formRepId) { setError('Ø§Ø®ØªØ± Ù…Ù†Ø¯ÙˆØ¨Ø§Ù‹'); return; }
    const validItems = formItems.filter(it => it.itemName.trim() && it.quantity > 0);
    if (validItems.length === 0) { setError('Ø£Ø¶Ù ØµÙ†ÙØ§Ù‹ ÙˆØ§Ø­Ø¯Ø§Ù‹ Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„ Ø¨ÙƒÙ…ÙŠØ© Ø£ÙƒØ¨Ø± Ù…Ù† ØµÙØ±'); return; }
    setSaving(true); setError('');
    try {
      const body = { scientificRepId: formRepId, month: formMonth, year: formYear, notes: formNotes, items: validItems };
      const r = await fetch('/api/fms', { method: 'POST', headers: authH(), body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø­ÙØ¸');
      setSuccess('ØªÙ… Ø§Ù„Ø­ÙØ¸ Ø¨Ù†Ø¬Ø§Ø­ âœ“');
      setShowForm(false);
      loadPlans();
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const deletePlan = async (id: number) => {
    if (!confirm('Ù‡Ù„ ØªØ±ÙŠØ¯ Ø­Ø°Ù Ù‡Ø°Ù‡ Ø§Ù„Ø®Ø·Ø©ØŸ')) return;
    try {
      await fetch(`/api/fms/${id}`, { method: 'DELETE', headers: authH() });
      setPlans(p => p.filter(x => x.id !== id));
    } catch { setError('ÙØ´Ù„ ÙÙŠ Ø§Ù„Ø­Ø°Ù'); }
  };

  // â”€â”€ Export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const exportExcel = () => {
    const wb = XLSX.utils.book_new();
    const summaryRows: any[][] = [['Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ Ø§Ù„Ø¹Ù„Ù…ÙŠ', 'Ø§Ù„Ø´Ù‡Ø±', 'Ø§Ù„Ø³Ù†Ø©', 'Ø§Ù„Ù…Ù„Ø§Ø­Ø¸Ø§Øª', 'Ø¹Ø¯Ø¯ Ø§Ù„Ø£ØµÙ†Ø§Ù', 'Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„ÙƒÙ…ÙŠØ§Øª']];
    plans.forEach(p => {
      summaryRows.push([p.scientificRep.name, MONTHS[p.month - 1], p.year, p.notes ?? '', p.items.length, p.items.reduce((s, it) => s + it.quantity, 0)]);
    });
    const summWs = XLSX.utils.aoa_to_sheet(summaryRows);
    summWs['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 30 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, summWs, 'Ù…Ù„Ø®Øµ');
    plans.forEach(p => {
      const rows: any[][] = [
        [`Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨: ${p.scientificRep.name} â€” ${MONTHS[p.month - 1]} ${p.year}`], [],
        ['#', 'Ø§Ù„ØµÙ†Ù', 'Ø§Ù„ÙƒÙ…ÙŠØ©'],
        ...p.items.map((it, i) => [i + 1, it.itemName, it.quantity]),
        [], ['', 'Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ', p.items.reduce((s, it) => s + it.quantity, 0)],
      ];
      if (p.notes) rows.push(['', 'Ù…Ù„Ø§Ø­Ø¸Ø§Øª:', p.notes]);
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
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1e293b' }}>ðŸ§ª FMS â€” Ø¹ÙŠÙ†Ø§Øª Ù…Ø¬Ø§Ù†ÙŠØ© Ø´Ù‡Ø±ÙŠØ©</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>ØªØ¹ÙŠÙŠÙ† Ø§Ù„Ø¹ÙŠÙ†Ø§Øª Ø§Ù„Ø´Ù‡Ø±ÙŠØ© Ø§Ù„Ù…Ø¬Ø§Ù†ÙŠØ© Ù„ÙƒÙ„ Ù…Ù†Ø¯ÙˆØ¨ Ø¹Ù„Ù…ÙŠ</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {plans.length > 0 && (
            <button onClick={exportExcel} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: 13 }}>ðŸ“¥ ØªØµØ¯ÙŠØ± Excel</button>
          )}
          <button onClick={openNew} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13 }}>+ Ø®Ø·Ø© Ø¬Ø¯ÙŠØ¯Ø©</button>
        </div>
      </div>

      {error   && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #fecaca' }}>{error}</div>}
      {success && <div style={{ background: '#f0fdf4', color: '#15803d', padding: '10px 16px', borderRadius: 8, marginBottom: 12, border: '1px solid #bbf7d0' }}>{success}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          Ø§Ù„Ø´Ù‡Ø±:
          <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          Ø§Ù„Ø³Ù†Ø©:
          <select value={filterYear} onChange={e => setFilterYear(e.target.value)} style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }}>
            {years.map(y => <option key={y}>{y}</option>)}
          </select>
        </label>
      </div>

      {/* Plans */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>Ø¬Ø§Ø±ÙŠ Ø§Ù„ØªØ­Ù…ÙŠÙ„...</div>
      ) : plans.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>ðŸ§ª</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Ù„Ø§ ØªÙˆØ¬Ø¯ Ø®Ø·Ø· Ù„Ù‡Ø°Ø§ Ø§Ù„Ø´Ù‡Ø±</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Ø§Ø¶ØºØ· "+ Ø®Ø·Ø© Ø¬Ø¯ÙŠØ¯Ø©" Ù„Ø¥Ø¶Ø§ÙØ© Ø®Ø·Ø©</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plans.map(plan => (
            <div key={plan.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16 }}>ðŸ”¬</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{plan.scientificRep.name}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{MONTHS[plan.month - 1]} {plan.year} â€” {plan.items.length} ØµÙ†Ù / {plan.items.reduce((s, it) => s + it.quantity, 0)} ÙˆØ­Ø¯Ø©</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => openEdit(plan)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4f46e5', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>âœï¸ ØªØ¹Ø¯ÙŠÙ„</button>
                  <button onClick={() => deletePlan(plan.id)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>ðŸ—‘ï¸ Ø­Ø°Ù</button>
                </div>
              </div>
              <div style={{ padding: '10px 16px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>#</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>Ø§Ù„ØµÙ†Ù</th>
                      <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, color: '#374151' }}>Ø§Ù„ÙƒÙ…ÙŠØ©</th>
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
                      <td colSpan={2} style={{ padding: '6px 10px', color: '#15803d' }}>Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>{plan.items.reduce((s, it) => s + it.quantity, 0)}</td>
                    </tr>
                  </tfoot>
                </table>
                {plan.notes && <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>ðŸ“ {plan.notes}</div>}
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
            {/* Modal header */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{editPlan ? 'âœï¸ ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ø®Ø·Ø©' : 'âž• Ø®Ø·Ø© Ø¬Ø¯ÙŠØ¯Ø©'}</div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>âœ•</button>
            </div>

            {/* Modal body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {error && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

              {/* Rep / Month / Year */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ Ø§Ù„Ø¹Ù„Ù…ÙŠ *
                  <select value={formRepId} onChange={e => setFormRepId(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {sciReps.map(r => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  Ø§Ù„Ø´Ù‡Ø± *
                  <select value={formMonth} onChange={e => setFormMonth(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {MONTHS.map((m, i) => <option key={i} value={String(i + 1)}>{m}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                  Ø§Ù„Ø³Ù†Ø© *
                  <select value={formYear} onChange={e => setFormYear(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                    {years.map(y => <option key={y}>{y}</option>)}
                  </select>
                </label>
              </div>

              {/* Items header + action buttons */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>Ø§Ù„Ø£ØµÙ†Ø§Ù ÙˆØ§Ù„ÙƒÙ…ÙŠØ§Øª ({formItems.filter(r => r.itemName.trim()).length})</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setShowPicker(true)}
                    style={{ fontSize: 12, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 600 }}>
                    ðŸ“‹ Ø§Ø®ØªÙŠØ§Ø± Ù…ØªØ¹Ø¯Ø¯
                  </button>
                  <button onClick={addRow}
                    style={{ fontSize: 12, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}>
                    + Ø¥Ø¶Ø§ÙØ© ØµÙ
                  </button>
                </div>
              </div>

              {/* Items rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {formItems.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 18, textAlign: 'center' }}>{i + 1}</span>
                    <div style={{ flex: 2 }}>
                      <input
                        list={`items-list-${i}`}
                        value={row.itemName}
                        onChange={e => handleItemSelect(i, e.target.value)}
                        placeholder="Ø§Ø³Ù… Ø§Ù„ØµÙ†Ù..."
                        style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                      />
                      <datalist id={`items-list-${i}`}>
                        {items.map(it => <option key={it.id} value={it.name} />)}
                      </datalist>
                    </div>
                    <input type="number" min="1" value={row.quantity || ''} onChange={e => setRowQty(i, parseInt(e.target.value) || 0)}
                      placeholder="Ø§Ù„ÙƒÙ…ÙŠØ©"
                      style={{ width: 90, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
                    {formItems.length > 1 && (
                      <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>âœ•</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Notes */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151' }}>
                Ù…Ù„Ø§Ø­Ø¸Ø§Øª (Ø§Ø®ØªÙŠØ§Ø±ÙŠ)
                <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={2}
                  placeholder="Ù…Ù„Ø§Ø­Ø¸Ø§Øª Ø¹Ø§Ù…Ø©..."
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical' }} />
              </label>
            </div>

            {/* Modal footer */}
            <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Ø¥Ù„ØºØ§Ø¡</button>
              <button onClick={savePlan} disabled={saving}
                style={{ padding: '8px 22px', borderRadius: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontWeight: 700, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'â³ Ø¬Ø§Ø±ÙŠ Ø§Ù„Ø­ÙØ¸...' : 'âœ… Ø­ÙØ¸'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

