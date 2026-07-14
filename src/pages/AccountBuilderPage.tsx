import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

// ── Types ─────────────────────────────────────────────────────
type BonusMethod = 'proportional' | 'independent' | 'netDiff';

interface AccountItemRow {
  id: string;
  itemName: string;
  companyName: string;
  price: number;
  quantity: number;
  /** إجمالي نسبة البونص للايتم (%) — تُستخدم لحساب النت برايس */
  totalBonusPercent: number;
  /** الجزء من البونص الكلي الذي يبقى بونص فعلي (%) — الباقي يتحول إلى دعم مالي */
  keptBonusPercent: number;
}

interface Account {
  id: number;
  name: string;
  items: AccountItemRow[];
  /** طريقة احتساب قيمة الدعم المالي المطبّقة على كل صفوف هذا الحساب */
  bonusMethod: BonusMethod;
}

interface CatalogItem {
  id: number;
  name: string;
  price?: number | null; // سعر مكتب — يُعبَّأ تلقائياً في خانة السعر عند اختيار الايتم
  company?: { id: number; name: string } | null;
  scientificCompany?: { id: number; name: string } | null;
}

// ── Bonus / net-price math ──────────────────────────────────────
// نت برايس = السعر مقسوماً على (1 + نسبة البونص) — بونص 40% على سعر 8000 يعطي نت برايس 5714
function netPriceFor(price: number, bonusPercent: number): number {
  return bonusPercent > 0 ? price / (1 + bonusPercent / 100) : price;
}

// قيمة الدعم المالي لكل وحدة، حسب الطريقة المختارة، عند تقسيم البونص الكلي إلى (محتفظ به + محوّل لدعم مالي)
function financialSupportPerUnit(price: number, totalBonusPercent: number, keptBonusPercent: number, method: BonusMethod): number {
  const total = Math.max(totalBonusPercent, 0);
  const kept = Math.min(Math.max(keptBonusPercent, 0), total);
  const converted = total - kept;
  if (total <= 0 || converted <= 0) return 0;
  switch (method) {
    case 'proportional': {
      // القيمة الكلية للبونص × (النسبة المحوّلة / النسبة الكلية)
      const totalBonusValue = price - netPriceFor(price, total);
      return totalBonusValue * (converted / total);
    }
    case 'independent': {
      // الجزء المحوّل يُعامل كبونص مستقل بنفس معادلة النت برايس
      return price - netPriceFor(price, converted);
    }
    case 'netDiff': {
      // الفرق بين نت برايس (عند الاحتفاظ بالجزء الفعلي فقط) ونت برايس (عند كامل البونص الأصلي)
      return netPriceFor(price, kept) - netPriceFor(price, total);
    }
  }
}

const BONUS_METHODS: { id: BonusMethod; label: string; desc: string }[] = [
  { id: 'proportional', label: 'طريقة 1: نسبي',        desc: 'قيمة البونص الكلي × (النسبة المحوّلة ÷ النسبة الكلية)' },
  { id: 'independent',  label: 'طريقة 2: بونص مستقل',  desc: 'الجزء المحوّل يُحسب كبونص مستقل بنفس معادلة النت برايس' },
  { id: 'netDiff',      label: 'طريقة 3: فرق النت برايس', desc: 'الفرق بين نت برايس الجزء المحتفَظ به ونت برايس الكلي' },
];

// ── Helpers ───────────────────────────────────────────────────
function fmt(n: number) {
  return (Number.isFinite(n) ? n : 0).toLocaleString('ar-IQ', { maximumFractionDigits: 0 });
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function emptyRow(): AccountItemRow {
  return { id: uid(), itemName: '', companyName: '', price: 0, quantity: 0, totalBonusPercent: 0, keptBonusPercent: 0 };
}

export default function AccountBuilderPage() {
  const { user, token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const legacyStorageKey = `accountBuilder_${user?.id ?? 'guest'}`;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // قادة الفرق (تيم ليدر) يُثبَّت لهم طريقة "فرق النت برايس" فقط
  const isTeamLeader = user?.role === 'team_leader' || user?.role === 'commercial_team_leader';

  // كتالوج الايتمات (مرتبط بالشركات المعيّنة للمستخدم) — لاختيار اسم الايتم وتعبئة الشركة تلقائياً
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [itemSuggestRowId, setItemSuggestRowId] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/items`, { headers })
      .then(r => r.json())
      .then(j => setCatalogItems(Array.isArray(j.data) ? j.data : []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // مؤقتات حفظ مستقلة لكل حساب — بهذا لا يُلغى الحفظ المعلَّق عند التبديل بين الحسابات
  const saveTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const scheduleSave = (accountId: number, items: AccountItemRow[], bonusMethod: BonusMethod) => {
    const timers = saveTimers.current;
    clearTimeout(timers.get(accountId));
    timers.set(accountId, setTimeout(() => {
      fetch(`${API}/api/account-builder/${accountId}`, {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({ items, bonusMethod }),
      }).catch(() => {});
      timers.delete(accountId);
    }, 600));
  };

  // ── تحميل الحسابات من السيرفر (متزامنة عبر الأجهزة) + ترحيل لمرة واحدة لأي بيانات محفوظة محلياً فقط على هذا الجهاز ──
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API}/api/account-builder`, { headers });
        const json = await res.json();
        const serverAccounts: Account[] = (json.data || []).map((a: any) => ({
          id: a.id, name: a.name, bonusMethod: a.bonusMethod, items: a.items || [],
        }));

        const migKey = `${legacyStorageKey}_migrated_v1`;
        if (!localStorage.getItem(migKey)) {
          try {
            const raw = localStorage.getItem(legacyStorageKey);
            if (raw) {
              const localAccounts = JSON.parse(raw);
              for (const la of localAccounts) {
                if (!la?.items?.length) continue;
                const createRes = await fetch(`${API}/api/account-builder`, {
                  method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: la.name || 'حساب مستورد' }),
                });
                const createJson = await createRes.json();
                const newId = createJson.data.id;
                const items = la.items.map((r: any) => ({ totalBonusPercent: 0, keptBonusPercent: 0, ...r }));
                const bonusMethod = la.bonusMethod || 'proportional';
                await fetch(`${API}/api/account-builder/${newId}`, {
                  method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ items, bonusMethod }),
                });
                serverAccounts.push({ id: newId, name: la.name || 'حساب مستورد', bonusMethod, items });
              }
            }
          } catch {}
          localStorage.setItem(migKey, '1');
          localStorage.removeItem(legacyStorageKey);
        }

        if (!cancelled) {
          setAccounts(serverAccounts);
          setActiveId(prev => prev ?? serverAccounts[0]?.id ?? null);
        }
      } catch {} finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const activeAccount = accounts.find(a => a.id === activeId) || null;

  const addAccount = async () => {
    const name = `حساب ${accounts.length + 1}`;
    try {
      const res = await fetch(`${API}/api/account-builder`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) });
      const json = await res.json();
      const acc: Account = { id: json.data.id, name: json.data.name, bonusMethod: json.data.bonusMethod, items: [] };
      setAccounts(prev => [...prev, acc]);
      setActiveId(acc.id);
    } catch {}
  };

  const deleteAccount = (id: number) => {
    setAccounts(prev => prev.filter(a => a.id !== id));
    if (activeId === id) setActiveId(null);
    setConfirmDeleteId(null);
    fetch(`${API}/api/account-builder/${id}`, { method: 'DELETE', headers }).catch(() => {});
  };

  const renameAccount = (id: number, name: string) => {
    const trimmed = name.trim();
    setAccounts(prev => prev.map(a => a.id === id ? { ...a, name: trimmed || a.name } : a));
    setRenamingId(null);
    if (!trimmed) return;
    fetch(`${API}/api/account-builder/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ name: trimmed }) }).catch(() => {});
  };

  const setBonusMethod = (method: BonusMethod) => {
    if (!activeAccount) return;
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, bonusMethod: method } : a));
    scheduleSave(activeAccount.id, activeAccount.items, method);
  };

  // تثبيت طريقة "فرق النت برايس" (طريقة 3) لقادة الفرق على أي حساب نشط بطريقة مختلفة
  useEffect(() => {
    if (isTeamLeader && activeAccount && activeAccount.bonusMethod !== 'netDiff') {
      setBonusMethod('netDiff');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeamLeader, activeAccount?.id, activeAccount?.bonusMethod]);

  const addRow = () => {
    if (!activeAccount) return;
    const newItems = [...activeAccount.items, emptyRow()];
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, items: newItems } : a));
    scheduleSave(activeAccount.id, newItems, activeAccount.bonusMethod);
  };

  const deleteRow = (rowId: string) => {
    if (!activeAccount) return;
    const newItems = activeAccount.items.filter(r => r.id !== rowId);
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, items: newItems } : a));
    scheduleSave(activeAccount.id, newItems, activeAccount.bonusMethod);
  };

  const updateRow = (rowId: string, patch: Partial<AccountItemRow>) => {
    if (!activeAccount) return;
    const newItems = activeAccount.items.map(r => r.id === rowId ? { ...r, ...patch } : r);
    setAccounts(prev => prev.map(a => a.id === activeAccount.id ? { ...a, items: newItems } : a));
    scheduleSave(activeAccount.id, newItems, activeAccount.bonusMethod);
  };

  // إجمالي السعر — رياضيات مباشرة (سعر × كمية)
  const totalPrice    = activeAccount ? activeAccount.items.reduce((s, r) => s + r.price * r.quantity, 0) : 0;
  const totalSupport   = activeAccount
    ? activeAccount.items.reduce((s, r) => s + financialSupportPerUnit(r.price, r.totalBonusPercent, r.keptBonusPercent, activeAccount.bonusMethod) * r.quantity, 0)
    : 0;

  return (
    <div dir="rtl" style={{ fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif', background: '#f0f4f8', minHeight: '100vh', padding: '16px 18px' }}>

      {/* ── Page Header ────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#1e40af', borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: 20 }}>🧮</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: '#1e293b' }}>الحساب</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>إنشاء حسابات ومعادلات خاصة بالإيتمات — محفوظة على حسابك وتظهر على كل أجهزتك</p>
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
          <span style={{ marginRight: 'auto', fontSize: 11, color: '#94a3b8' }}>{loading ? 'جاري التحميل...' : `${accounts.length} حساب`}</span>
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
          {!loading && accounts.length === 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>لا توجد حسابات بعد</span>}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{activeAccount.name}</span>
            <button onClick={addRow} style={PILL_BTN('#eff6ff', '#1d4ed8')}>+ إضافة إيتم</button>

            {/* طريقة احتساب الدعم المالي — مثبّتة على طريقة 3 لقادة الفرق */}
            <div style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 4, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '3px 4px' }}>
              <span style={{ fontSize: 11, color: '#6b7280', padding: '0 6px' }}>طريقة الدعم المالي:</span>
              {isTeamLeader ? (
                <span style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: '#1e40af', color: '#fff' }}>
                  {BONUS_METHODS.find(m => m.id === 'netDiff')?.label}
                </span>
              ) : (
                BONUS_METHODS.map(m => (
                  <button
                    key={m.id}
                    onClick={() => setBonusMethod(m.id)}
                    title={m.desc}
                    style={{
                      padding: '4px 10px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                      background: activeAccount.bonusMethod === m.id ? '#1e40af' : 'transparent',
                      color: activeAccount.bonusMethod === m.id ? '#fff' : '#374151',
                    }}
                  >{m.label}</button>
                ))
              )}
            </div>
          </div>
          <div style={{ padding: '6px 14px', fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f1f5f9', background: '#fafbff' }}>
            ℹ️ {BONUS_METHODS.find(m => m.id === activeAccount.bonusMethod)?.desc}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: '#1e40af', color: '#fff' }}>
                  <th style={{ ...TH, width: 26 }}>#</th>
                  <th style={{ ...TH, width: 130 }}>اسم الايتم</th>
                  <th style={{ ...TH, width: 105 }}>اسم الشركة</th>
                  <th style={{ ...TH, width: 62 }}>السعر</th>
                  <th style={{ ...TH, width: 55 }}>الكمية</th>
                  <th style={{ ...TH, width: 85 }}>المجموع الكلي</th>
                  <th style={{ ...TH, width: 65 }}>البونص الكلي %</th>
                  <th style={{ ...TH, width: 70 }}>محتفظ به %</th>
                  <th style={{ ...TH, width: 72 }}>النت برايس</th>
                  <th style={{ ...TH, width: 78 }}>دعم / وحدة</th>
                  <th style={{ ...TH, width: 85 }}>إجمالي الدعم</th>
                  <th style={{ ...TH, width: 24 }}></th>
                </tr>
              </thead>
              <tbody>
                {activeAccount.items.map((r, i) => {
                  const netPrice = netPriceFor(r.price, r.totalBonusPercent);
                  const supportPerUnit = financialSupportPerUnit(r.price, r.totalBonusPercent, r.keptBonusPercent, activeAccount.bonusMethod);
                  const suggMatches = itemSuggestRowId === r.id
                    ? (r.itemName.trim()
                        ? catalogItems.filter(ci => ci.name.toLowerCase().includes(r.itemName.trim().toLowerCase()))
                        : catalogItems
                      ).slice(0, 30)
                    : [];
                  return (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                    <td style={TD}>{i + 1}</td>
                    <td style={{ ...TD, position: 'relative' }}>
                      <input
                        value={r.itemName}
                        autoComplete="off"
                        onChange={e => { updateRow(r.id, { itemName: e.target.value }); setItemSuggestRowId(r.id); }}
                        onFocus={() => setItemSuggestRowId(r.id)}
                        onBlur={() => setTimeout(() => setItemSuggestRowId(prev => prev === r.id ? null : prev), 150)}
                        style={CELL_INPUT}
                        placeholder="اختر أو اكتب اسم الايتم"
                      />
                      {suggMatches.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 50, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, maxHeight: 190, overflowY: 'auto', minWidth: 220 }}>
                          {suggMatches.map(ci => (
                            <div
                              key={ci.id}
                              onMouseDown={() => {
                                const companyName = ci.scientificCompany?.name || ci.company?.name || '';
                                const patch: Partial<AccountItemRow> = { itemName: ci.name, companyName };
                                if (ci.price != null) patch.price = ci.price;
                                updateRow(r.id, patch);
                                setItemSuggestRowId(null);
                              }}
                              style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', textAlign: 'right' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                              onMouseLeave={e => (e.currentTarget.style.background = '')}
                            >
                              <div style={{ fontWeight: 600, fontSize: 12, color: '#111827' }}>{ci.name}</div>
                              {(ci.scientificCompany?.name || ci.company?.name) && (
                                <div style={{ fontSize: 10, color: '#94a3b8' }}>{ci.scientificCompany?.name || ci.company?.name}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={TD}><input value={r.companyName} onChange={e => updateRow(r.id, { companyName: e.target.value })} style={CELL_INPUT} placeholder="اسم الشركة" /></td>
                    <td style={TD}><input type="number" value={r.price || ''} onChange={e => updateRow(r.id, { price: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={TD}><input type="number" value={r.quantity || ''} onChange={e => updateRow(r.id, { quantity: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 700, color: '#047857' }}>{fmt(r.price * r.quantity)}</td>
                    <td style={TD}><input type="number" value={r.totalBonusPercent || ''} onChange={e => updateRow(r.id, { totalBonusPercent: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" /></td>
                    <td style={TD}><input type="number" value={r.keptBonusPercent || ''} onChange={e => updateRow(r.id, { keptBonusPercent: parseFloat(e.target.value) || 0 })} style={{ ...CELL_INPUT, textAlign: 'center' }} placeholder="0" title="اتركه 0 لتحويل كامل البونص إلى دعم مالي" /></td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 700, color: '#1e40af' }}>{fmt(netPrice)}</td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 700, color: '#7c3aed' }}>{fmt(supportPerUnit)}</td>
                    <td style={{ ...TD, textAlign: 'center', fontWeight: 800, color: '#7c3aed' }}>{fmt(supportPerUnit * r.quantity)}</td>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <button onClick={() => deleteRow(r.id)} title="حذف الصف" style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>×</button>
                    </td>
                  </tr>
                  );
                })}
                {activeAccount.items.length === 0 && (
                  <tr><td colSpan={12} style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>لا توجد إيتمات. اضغط «+ إضافة إيتم» للبدء.</td></tr>
                )}
              </tbody>
              {activeAccount.items.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#fef9c3', borderTop: '2px solid #eab308' }}>
                    <td colSpan={5} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontSize: 12, color: '#854d0e' }}>الإجمالي</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 800, color: '#047857' }}>{fmt(totalPrice)}</td>
                    <td colSpan={4} />
                    <td style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 800, color: '#7c3aed' }}>{fmt(totalSupport)}</td>
                    <td />
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
  padding: '6px 6px', textAlign: 'right', fontWeight: 600, fontSize: 10.5,
  whiteSpace: 'nowrap', borderLeft: '1px solid rgba(255,255,255,.15)',
};
const TD: React.CSSProperties = {
  padding: '3px 4px', borderBottom: '1px solid #f1f5f9', fontSize: 11, color: '#374151',
};
const CELL_INPUT: React.CSSProperties = {
  width: '100%', border: '1px solid #e5e7eb', borderRadius: 5, padding: '4px 5px',
  fontSize: 11, background: '#fff', outline: 'none', color: '#1e293b', boxSizing: 'border-box',
};
function PILL_BTN(bg: string, color: string): React.CSSProperties {
  return { padding: '3px 10px', borderRadius: 6, border: 'none', background: bg, color, fontWeight: 600, fontSize: 11, cursor: 'pointer' };
}
