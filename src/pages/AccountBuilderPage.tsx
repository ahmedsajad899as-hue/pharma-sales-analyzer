import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// ── Types ─────────────────────────────────────────────────────
interface AccountItemRow {
  id: string;
  itemName: string;
  companyName: string;
  price: number;
  quantity: number;
  discount: number;
  bonus: string;
}

interface Account {
  id: string;
  name: string;
  items: AccountItemRow[];
}

// ── Helpers ───────────────────────────────────────────────────
function fmt(n: number) {
  return (Number.isFinite(n) ? n : 0).toLocaleString('ar-IQ');
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function emptyRow(): AccountItemRow {
  return { id: uid(), itemName: '', companyName: '', price: 0, quantity: 0, discount: 0, bonus: '' };
}

export default function AccountBuilderPage() {
  const { user } = useAuth();
  const storageKey = `accountBuilder_${user?.id ?? 'guest'}`;

  const [accounts, setAccounts] = useState<Account[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [activeId, setActiveId] = useState<string | null>(accounts[0]?.id ?? null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(accounts)); } catch {}
  }, [accounts, storageKey]);

  const activeAccount = accounts.find(a => a.id === activeId) || null;

  const addAccount = () => {
    const acc: Account = { id: uid(), name: `حساب ${accounts.length + 1}`, items: [emptyRow()] };
    setAccounts(prev => [...prev, acc]);
    setActiveId(acc.id);
  };

  const deleteAccount = (id: string) => {
    setAccounts(prev => prev.filter(a => a.id !== id));
    if (activeId === id) setActiveId(null);
    setConfirmDeleteId(null);
  };

  const renameAccount = (id: string, name: string) => {
    setAccounts(prev => prev.map(a => a.id === id ? { ...a, name: name.trim() || a.name } : a));
    setRenamingId(null);
  };

  const addRow = () => {
    if (!activeAccount) return;
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, items: [...a.items, emptyRow()] } : a));
  };

  const deleteRow = (rowId: string) => {
    if (!activeAccount) return;
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, items: a.items.filter(r => r.id !== rowId) } : a));
  };

  const updateRow = (rowId: string, patch: Partial<AccountItemRow>) => {
    if (!activeAccount) return;
    setAccounts(prev => prev.map(a => a.id === activeAccount.id
      ? { ...a, items: a.items.map(r => r.id === rowId ? { ...r, ...patch } : r) }
      : a));
  };

  // Totals derived directly from price/quantity/discount — the bonus formula itself is not applied yet
  const totalPrice    = activeAccount ? activeAccount.items.reduce((s, r) => s + r.price * r.quantity, 0) : 0;
  const totalDiscount = activeAccount ? activeAccount.items.reduce((s, r) => s + r.discount * r.quantity, 0) : 0;
  const netTotal       = totalPrice - totalDiscount;

  return (
    <div dir="rtl" style={{ fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif', background: '#f0f4f8', minHeight: '100vh', padding: '16px 18px' }}>

      {/* ── Page Header ────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#1e40af', borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: 20 }}>🧮</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: '#1e293b' }}>الحساب</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>إنشاء حسابات ومعادلات خاصة بالإيتمات</p>
        </div>
      </div>

      {/* ── Delete confirm dialog ─────────────────────────── */}
      {confirmDeleteId && (() => {
        const acc = accounts.find(a => a.id === confirmDeleteId);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setConfirmDeleteId(null)}>
            <div style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', minWidth: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', textAlign: 'center' }} dir="rtl" onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>🗑️</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', marginBottom: 6 }}>حذف الحساب</div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18 }}>سيتم حذف «{acc?.name}» وكل بياناته نهائياً. هل أنت متأكد؟</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button onClick={() => deleteAccount(confirmDeleteId)} style={{ padding: '8px 22px', borderRadius: 8, background: '#dc2626', color: '#fff', border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>✔ نعم، احذف</button>
                <button onClick={() => setConfirmDeleteId(null)} style={{ padding: '8px 18px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', border: 'none', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>إلغاء</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Accounts selector card ──────────────────────────── */}
      <div style={CARD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>الحسابات:</span>
          <button onClick={addAccount} style={{ ...PILL_BTN('#f5f3ff', '#6d28d9'), border: '1.5px dashed #a5b4fc' }}>+ حساب جديد</button>
          <span style={{ marginRight: 'auto', fontSize: 11, color: '#94a3b8' }}>{accounts.length} حساب</span>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {accounts.map(a => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 0,
              borderRadius: 6, fontSize: 12,
              border: activeId === a.id ? '1.5px solid #1e40af' : '1.5px solid #e2e8f0',
              background: activeId === a.id ? '#eff6ff' : '#fff',
              color: activeId === a.id ? '#1e40af' : '#6b7280',
              fontWeight: activeId === a.id ? 600 : 400,
              overflow: 'hidden',
            }}>
              {renamingId === a.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => renameAccount(a.id, renameValue)}
                  onKeyDown={e => { if (e.key === 'Enter') renameAccount(a.id, renameValue); if (e.key === 'Escape') setRenamingId(null); }}
                  style={{ padding: '5px 10px', border: 'none', outline: 'none', fontSize: 12, width: 110 }}
                />
              ) : (
                <span
                  onClick={() => setActiveId(a.id)}
                  onDoubleClick={() => { setRenamingId(a.id); setRenameValue(a.name); }}
                  title="اضغط مرتين لإعادة التسمية"
                  style={{ padding: '5px 10px', cursor: 'pointer' }}
                >
                  {activeId === a.id ? '✓ ' : ''}{a.name}
                  <span style={{ opacity: .55, marginRight: 4 }}>({a.items.length})</span>
                </span>
              )}
              <button
                onClick={e => { e.stopPropagation(); setConfirmDeleteId(a.id); }}
                title="حذف الحساب"
                style={{
                  padding: '5px 7px', border: 'none', background: 'transparent',
                  cursor: 'pointer', color: '#94a3b8', fontSize: 13, lineHeight: 1,
                  borderRight: activeId === a.id ? '1px solid #bfdbfe' : '1px solid #e2e8f0',
                  order: -1,
                }}
              >×</button>
            </div>
          ))}
          {accounts.length === 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>لا توجد حسابات بعد</span>}
        </div>
      </div>

      {/* ── Active account fields table ──────────────────────── */}
      {!activeAccount ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧮</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#64748b', marginBottom: 6 }}>لا يوجد حساب محدد</div>
          <div style={{ fontSize: 12 }}>أنشئ حساباً جديداً أو اختر أحد الحسابات أعلاه للبدء بإدخال بيانات الإيتمات</div>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #e2e8f0' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{activeAccount.name}</span>
            <button onClick={addRow} style={{ marginRight: 'auto', ...PILL_BTN('#eff6ff', '#1d4ed8') }}>+ إضافة إيتم</button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900 }}>
              <thead>
                <tr style={{ background: '#1e40af', color: '#fff' }}>
                  <th style={TH}>#</th>
                  <th style={{ ...TH, minWidth: 160 }}>اسم الايتم</th>
                  <th style={{ ...TH, minWidth: 130 }}>اسم الشركة</th>
                  <th style={TH}>السعر</th>
                  <th style={TH}>الكمية</th>
                  <th style={TH}>الخصم</th>
                  <th style={TH}>المجموع الكلي للسعر</th>
                  <th style={TH}>المجموع الكلي للخصم</th>
                  <th style={{ ...TH, minWidth: 110 }}>البونص للايتم</th>
                  <th style={{ ...TH, width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {activeAccount.items.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                    <td style={TD}>{i + 1}</td>
                    <td style={TD}><input value={r.itemName} onChange={e => updateRow(r.id, { itemName: e.target.value })} style={CELL_INPUT} placeholder="اسم الايتم" /></td>
                    <td style={TD}><input value={r.companyName} onChange={e => updateRow(r.id, { companyName: e.target.value })} style={CELL_INPUT} placeholder="اسم الشركة" /></td>
                    <td style={TD}><input type="number" value={r.price || ''} onChange={e => updateRow(r.id, { price: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={TD}><input type="number" value={r.quantity || ''} onChange={e => updateRow(r.id, { quantity: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={TD}><input type="number" value={r.discount || ''} onChange={e => updateRow(r.id, { discount: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 700, color: '#047857' }}>{fmt(r.price * r.quantity)}</td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 700, color: '#dc2626' }}>{fmt(r.discount * r.quantity)}</td>
                    <td style={TD}><input value={r.bonus} onChange={e => updateRow(r.id, { bonus: e.target.value })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="مثال: 1+10" /></td>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => deleteRow(r.id)} title="حذف الصف" style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>×</button>
                    </td>
                  </tr>
                ))}
                {activeAccount.items.length === 0 && (
                  <tr><td colSpan={10} style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>لا توجد إيتمات. اضغط «+ إضافة إيتم» للبدء.</td></tr>
                )}
              </tbody>
              {activeAccount.items.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#fef9c3', borderTop: '2px solid #eab308' }}>
                    <td colSpan={6} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontSize: 12, color: '#854d0e' }}>الإجمالي</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 800, color: '#047857' }}>{fmt(totalPrice)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 800, color: '#dc2626' }}>{fmt(totalDiscount)}</td>
                    <td colSpan={2} style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 800, color: '#1e293b' }}>الصافي: {fmt(netTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Style constants (matches Pharmacy Net design) ──────────────
const CARD: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
  padding: '12px 16px', marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,.04)',
};
const TH: React.CSSProperties = {
  padding: '9px 12px', textAlign: 'right', fontWeight: 600, fontSize: 12,
  whiteSpace: 'nowrap', borderLeft: '1px solid rgba(255,255,255,.15)',
};
const TD: React.CSSProperties = {
  padding: '5px 8px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#374151',
};
const CELL_INPUT: React.CSSProperties = {
  width: '100%', border: '1px solid #e5e7eb', borderRadius: 5, padding: '5px 7px',
  fontSize: 12, background: '#fff', outline: 'none', color: '#1e293b',
};
function PILL_BTN(bg: string, color: string): React.CSSProperties {
  return { padding: '3px 10px', borderRadius: 6, border: 'none', background: bg, color, fontWeight: 600, fontSize: 11, cursor: 'pointer' };
}
