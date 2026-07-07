import { useState, useEffect, useCallback } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

// ─── أنواع ──────────────────────────────────────────────────────────────────
interface Company { id: number; name: string; office?: { name: string }; _count?: { items: number } }
interface Item    { id: number; name: string; scientificName?: string; dosage?: string; form?: string }
interface Alias   { id: number; fromName: string; toName: string; toItemId: number | null; toItem?: { id: number; name: string } | null; updatedAt: string }
interface ReviewItem { id: number; name: string; userName: string | null; salesCount: number; confidence: string; suggestions: { id: number; name: string; sim: number }[] }

type Tab = 'catalog' | 'aliases' | 'review';

const CONF_META: Record<string, { label: string; color: string; bg: string }> = {
  alias:  { label: 'قاعدة محفوظة', color: '#059669', bg: '#ecfdf5' },
  exact:  { label: 'تطابق تام',    color: '#059669', bg: '#ecfdf5' },
  high:   { label: 'تطابق قوي',    color: '#2563eb', bg: '#eff6ff' },
  medium: { label: 'محتمل',        color: '#d97706', bg: '#fffbeb' },
  none:   { label: 'جديد',         color: '#64748b', bg: '#f1f5f9' },
};

export default function ItemsCatalogPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');

  const [items, setItems]     = useState<Item[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [review, setReview]   = useState<ReviewItem[]>([]);

  // ── تحميل الشركات مرة واحدة ──
  useEffect(() => {
    fetch('/api/sa/companies', { headers: H() })
      .then(r => r.json())
      .then(d => {
        const list: Company[] = Array.isArray(d.data) ? d.data : [];
        setCompanies(list);
        setCompanyId(prev => prev ?? (list[0]?.id ?? null));
      })
      .catch(() => setErr('تعذّر تحميل الشركات'));
  }, [H]);

  // ── تحميل بيانات التبويب للشركة المختارة ──
  const reload = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setErr('');
    try {
      // الكتالوج مطلوب في كل التبويبات (للاختيار/العرض)
      const detail = await fetch(`/api/sa/companies/${companyId}`, { headers: H() }).then(r => r.json());
      setItems(detail.data?.items || []);
      if (tab === 'aliases') {
        const d = await fetch(`/api/sa/companies/${companyId}/aliases`, { headers: H() }).then(r => r.json());
        setAliases(Array.isArray(d.data) ? d.data : []);
      } else if (tab === 'review') {
        const d = await fetch(`/api/sa/companies/${companyId}/review-queue`, { headers: H() }).then(r => r.json());
        setReview(Array.isArray(d.data) ? d.data : []);
      }
    } catch { setErr('تعذّر تحميل البيانات'); }
    setLoading(false);
  }, [companyId, tab, H]);

  useEffect(() => { reload(); }, [reload]);

  // ── أفعال الكتالوج ──
  const [itemModal, setItemModal] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', scientificName: '', dosage: '', form: '' });
  const addItem = async () => {
    if (!newItem.name.trim() || !companyId) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/items`, { method: 'POST', headers: H(), body: JSON.stringify(newItem) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setItemModal(false); setNewItem({ name: '', scientificName: '', dosage: '', form: '' });
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل إضافة الايتم'); }
    setBusy(false);
  };
  const delItem = async (id: number) => {
    if (!companyId || !confirm('إزالة هذا الايتم من كتالوج الشركة؟')) return;
    setBusy(true);
    await fetch(`/api/sa/companies/${companyId}/items/${id}`, { method: 'DELETE', headers: H() });
    setBusy(false); await reload();
  };

  // ── نقل ايتم لشركة أخرى (أُدخل بالخطأ) ──
  const [transferFor, setTransferFor] = useState<Item | null>(null);
  const [transferTarget, setTransferTarget] = useState<string>('');
  const doTransfer = async () => {
    if (!companyId || !transferFor || !transferTarget) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/items/${transferFor.id}/transfer`, {
        method: 'POST', headers: H(), body: JSON.stringify({ targetCompanyId: parseInt(transferTarget) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setTransferFor(null); setTransferTarget('');
      await reload();
      const dest = companies.find(c => c.id === parseInt(transferTarget))?.name || 'الشركة الهدف';
      alert(d.action === 'merged' ? `تم دمج الايتم مع ايتم مطابق موجود في ${dest}` : `تم نقل الايتم إلى ${dest}`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل نقل الايتم'); }
    setBusy(false);
  };

  // ── أفعال قواعد التوحيد (aliases) ──
  const [aliasModal, setAliasModal] = useState(false);
  const [newAlias, setNewAlias] = useState({ fromName: '', toItemId: '' });
  const addAlias = async () => {
    if (!newAlias.fromName.trim() || !newAlias.toItemId || !companyId) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/aliases`, { method: 'POST', headers: H(), body: JSON.stringify(newAlias) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      setAliasModal(false); setNewAlias({ fromName: '', toItemId: '' });
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل إضافة القاعدة'); }
    setBusy(false);
  };
  const delAlias = async (id: number) => {
    if (!companyId || !confirm('حذف قاعدة التوحيد هذه؟')) return;
    setBusy(true);
    await fetch(`/api/sa/companies/${companyId}/aliases/${id}`, { method: 'DELETE', headers: H() });
    setBusy(false); await reload();
  };

  // ── أفعال طابور المراجعة ──
  const resolveReview = async (tempItemId: number, action: 'link' | 'add' | 'delete', targetItemId?: number) => {
    if (!companyId) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/sa/companies/${companyId}/review-queue/resolve`, {
        method: 'POST', headers: H(), body: JSON.stringify({ tempItemId, action, targetItemId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'فشل');
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : 'فشل المعالجة'); }
    setBusy(false);
  };

  const filteredItems = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));
  const filteredAliases = aliases.filter(a => !search || a.fromName.toLowerCase().includes(search.toLowerCase()) || a.toName.toLowerCase().includes(search.toLowerCase()));
  const filteredReview = review.filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()));

  const tabs: { id: Tab; label: string; count: number; icon: string }[] = [
    { id: 'catalog', label: 'الكتالوج',       count: items.length,   icon: '💊' },
    { id: 'aliases', label: 'قواعد التوحيد',  count: aliases.length, icon: '🔗' },
    { id: 'review',  label: 'طابور المراجعة', count: review.length,  icon: '🆕' },
  ];

  return (
    <div style={{ direction: 'rtl' }}>
      {/* رأس: اختيار الشركة */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: '#1e1b4b' }}>💊 إدارة الايتمات</span>
        <select
          value={companyId ?? ''}
          onChange={e => setCompanyId(e.target.value ? parseInt(e.target.value) : null)}
          style={{ padding: '9px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0', fontSize: 14, fontWeight: 600, minWidth: 220, background: '#fff', cursor: 'pointer' }}
        >
          {companies.map(c => (
            <option key={c.id} value={c.id}>{c.name}{c.office?.name ? ` — ${c.office.name}` : ''}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>الكتالوج والقواعد مشتركة بين كل مستخدمي الشركة</span>
      </div>

      {err && <ErrBox msg={err} />}

      {/* تبويبات */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setSearch(''); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 12,
              border: active ? '1.5px solid #6366f1' : '1.5px solid #e2e8f0',
              background: active ? '#eef2ff' : '#fff', cursor: 'pointer',
              fontSize: 14, fontWeight: active ? 800 : 600, color: active ? '#4338ca' : '#64748b',
            }}>
              <span>{t.icon}</span>{t.label}
              <span style={{ background: active ? '#6366f1' : '#e2e8f0', color: active ? '#fff' : '#64748b', borderRadius: 20, padding: '1px 9px', fontSize: 12, fontWeight: 800 }}>{t.count}</span>
            </button>
          );
        })}
        <div style={{ marginRight: 'auto', display: 'flex', gap: 8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث..."
            style={{ padding: '8px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0', fontSize: 13, minWidth: 200 }} />
          {tab === 'catalog' && <button onClick={() => setItemModal(true)} style={btnStyle('#6366f1')}>+ إضافة ايتم</button>}
          {tab === 'aliases' && <button onClick={() => setAliasModal(true)} style={btnStyle('#0891b2')} disabled={items.length === 0}>+ قاعدة توحيد</button>}
        </div>
      </div>

      {loading ? <Spinner /> : (
        <>
          {/* ── الكتالوج ── */}
          {tab === 'catalog' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {filteredItems.map(i => (
                <div key={i.id} style={{ border: '1px solid #e8edf5', borderRadius: 12, padding: 14, background: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{i.name}</div>
                    {(i.scientificName || i.dosage || i.form) && (
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                        {[i.scientificName, i.dosage, i.form].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => { setTransferFor(i); setTransferTarget(''); }} title="نقل لشركة أخرى" style={btnStyle('#0891b2', true)}>↔</button>
                    <button onClick={() => delItem(i.id)} title="إزالة" style={btnStyle('#ef4444', true)}>🗑</button>
                  </div>
                </div>
              ))}
              {filteredItems.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد ايتمات في الكتالوج</div>}
            </div>
          )}

          {/* ── قواعد التوحيد ── */}
          {tab === 'aliases' && (
            <div style={{ border: '1px solid #e8edf5', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', padding: '10px 14px', background: '#f8fafc', fontWeight: 700, fontSize: 12, color: '#64748b' }}>
                <div style={{ flex: 1 }}>الاسم البديل (كما يظهر بالملفات)</div>
                <div style={{ flex: 1 }}>← الايتم القانوني</div>
                <div style={{ width: 80, textAlign: 'center' }}>حذف</div>
              </div>
              {filteredAliases.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid #f1f5f9', fontSize: 13 }}>
                  <div style={{ flex: 1, color: '#b45309' }}>{a.fromName}</div>
                  <div style={{ flex: 1, color: '#059669', fontWeight: 600 }}>{a.toItem?.name || a.toName}</div>
                  <div style={{ width: 80, textAlign: 'center' }}>
                    <button onClick={() => delAlias(a.id)} style={btnStyle('#ef4444', true)}>🗑</button>
                  </div>
                </div>
              ))}
              {filteredAliases.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>لا توجد قواعد توحيد محفوظة بعد</div>}
            </div>
          )}

          {/* ── طابور المراجعة ── */}
          {tab === 'review' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredReview.map(r => {
                const cm = CONF_META[r.confidence] || CONF_META.none;
                return (
                  <div key={r.id} style={{ border: '1px solid #e8edf5', borderRadius: 12, padding: 14, background: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, color: '#1e293b' }}>{r.name}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: cm.color, background: cm.bg, padding: '2px 10px', borderRadius: 20 }}>{cm.label}</span>
                      {r.salesCount > 0 && <span style={{ fontSize: 11, color: '#64748b' }}>📊 {r.salesCount} مبيعة</span>}
                      {r.userName && <span style={{ fontSize: 11, color: '#94a3b8' }}>👤 {r.userName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {/* اقتراحات الربط */}
                      {r.suggestions.map(s => (
                        <button key={s.id} onClick={() => resolveReview(r.id, 'link', s.id)} disabled={busy}
                          style={{ ...btnStyle('#2563eb', true), background: '#eff6ff', color: '#1d4ed8', border: '1.5px solid #bfdbfe' }}>
                          🔗 ربط بـ {s.name}
                        </button>
                      ))}
                      {/* ربط يدوي بأي ايتم من الكتالوج */}
                      <select defaultValue="" onChange={e => { if (e.target.value) resolveReview(r.id, 'link', parseInt(e.target.value)); }}
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 12 }} disabled={busy || items.length === 0}>
                        <option value="">🔗 ربط بايتم آخر…</option>
                        {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                      <button onClick={() => resolveReview(r.id, 'add')} disabled={busy} style={btnStyle('#059669', true)}>➕ إضافة للكتالوج</button>
                      <button onClick={() => resolveReview(r.id, 'delete')} disabled={busy} style={btnStyle('#ef4444', true)}>🗑 حذف</button>
                    </div>
                  </div>
                );
              })}
              {filteredReview.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>لا توجد ايتمات بحاجة مراجعة 🎉</div>}
            </div>
          )}
        </>
      )}

      {/* مودال إضافة ايتم للكتالوج */}
      {itemModal && (
        <Modal title="إضافة ايتم للكتالوج" onClose={() => setItemModal(false)}>
          <Field label="اسم الايتم *" value={newItem.name} onChange={v => setNewItem({ ...newItem, name: v })} placeholder="مثال: AIRTIDE 100 50MCG 60CAP INHALER" />
          <Field label="الاسم العلمي" value={newItem.scientificName} onChange={v => setNewItem({ ...newItem, scientificName: v })} />
          <Field label="الجرعة" value={newItem.dosage} onChange={v => setNewItem({ ...newItem, dosage: v })} />
          <Field label="الشكل الدوائي" value={newItem.form} onChange={v => setNewItem({ ...newItem, form: v })} />
          <button onClick={addItem} disabled={busy || !newItem.name.trim()} style={{ ...btnStyle('#6366f1'), width: '100%', marginTop: 8 }}>حفظ</button>
        </Modal>
      )}

      {/* مودال نقل ايتم لشركة أخرى */}
      {transferFor && (
        <Modal title={`نقل «${transferFor.name}» لشركة أخرى`} onClose={() => setTransferFor(null)}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 1.7 }}>
            المبيعات والزيارات والتارگت المرتبطة بالايتم ستنتقل معه تلقائياً. لو وُجد ايتم مطابق بالاسم في الشركة الهدف سيتم الدمج بدل التكرار.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 5 }}>الشركة الهدف *</label>
            <select value={transferTarget} onChange={e => setTransferTarget(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14 }}>
              <option value="">— اختر الشركة الهدف —</option>
              {companies.filter(c => c.id !== companyId).map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.office?.name ? ` — ${c.office.name}` : ''}</option>
              ))}
            </select>
          </div>
          <button onClick={doTransfer} disabled={busy || !transferTarget} style={{ ...btnStyle('#0891b2'), width: '100%', marginTop: 4 }}>نقل الايتم</button>
        </Modal>
      )}

      {/* مودال إضافة قاعدة توحيد */}
      {aliasModal && (
        <Modal title="قاعدة توحيد جديدة" onClose={() => setAliasModal(false)}>
          <Field label="الاسم البديل (كما يظهر في الملفات) *" value={newAlias.fromName} onChange={v => setNewAlias({ ...newAlias, fromName: v })} placeholder="مثال: air tide" />
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 5 }}>← يُوحَّد إلى الايتم القانوني *</label>
            <select value={newAlias.toItemId} onChange={e => setNewAlias({ ...newAlias, toItemId: e.target.value })}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 14 }}>
              <option value="">— اختر ايتماً من الكتالوج —</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <button onClick={addAlias} disabled={busy || !newAlias.fromName.trim() || !newAlias.toItemId} style={{ ...btnStyle('#0891b2'), width: '100%', marginTop: 4 }}>حفظ القاعدة</button>
        </Modal>
      )}
    </div>
  );
}
