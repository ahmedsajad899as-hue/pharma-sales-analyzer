import { useMemo, useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, btnStyle } from './OfficesPage';

interface Area { id: number; name: string; provinceId: number | null; provinceConflict?: string | null; subProvinceId: number | null; userId: number | null; user?: { username: string } | null; }
interface Province { id: number; name: string; sortOrder?: number; areaCount?: number; }
interface SubProvince { id: number; name: string; provinceId: number; sortOrder?: number; areaCount?: number; }
interface MergeSuggestion { a: { id: number; name: string; sales: number }; b: { id: number; name: string; sales: number } }
interface DeleteInfo { id: number; name: string; usage: Record<string, number>; total: number; blocking: boolean }

// توست خفيف — نفس النمط المستخدم في UsersPage.tsx، معزول هنا لأن هذه صفحة مستقلة.
function showToast(msg: string, color: string = '#16a34a') {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
    background: color, color: '#fff', padding: '10px 22px', borderRadius: '10px',
    fontSize: '14px', fontWeight: '700', zIndex: '99999', direction: 'rtl',
    boxShadow: '0 4px 20px rgba(0,0,0,0.25)', opacity: '0', transition: 'opacity .15s',
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, 1800);
}

const USAGE_LABELS: Record<string, string> = {
  sales: 'مبيعات', plans: 'خطط شهرية', doctors: 'أطباء', pharmacies: 'صيدليات',
  pharmacyVisits: 'زيارات صيدليات', sciReps: 'مناديب علميون', reps: 'مناديب',
  assignments: 'مستخدمون معيّنون', surveyDoctors: 'سجلات سيرفي',
};

export default function AreasPage() {
  const { token, logout } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [areas, setAreas]             = useState<Area[]>([]);
  const [provinces, setProvinces]     = useState<Province[]>([]);
  const [subProvinces, setSubProvinces] = useState<SubProvince[]>([]);
  const [loading, setLoading]         = useState(true);
  const [busy, setBusy]               = useState(false);
  const [search, setSearch]           = useState('');
  const [collapsed, setCollapsed]     = useState<Set<string>>(new Set());

  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaProvince, setNewAreaProvince] = useState<number | ''>('');

  const [editingId, setEditingId]     = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [openProvincePicker, setOpenProvincePicker] = useState<number | null>(null);
  const [openSubPicker, setOpenSubPicker]           = useState<number | null>(null);
  const [openMergePicker, setOpenMergePicker]       = useState<number | null>(null);

  const [mergeSugs, setMergeSugs]     = useState<MergeSuggestion[] | null>(null);
  const [mergeBusy, setMergeBusy]     = useState(false);

  const [deleteInfo, setDeleteInfo]   = useState<DeleteInfo | null>(null);
  const [deleteTransferTo, setDeleteTransferTo] = useState<number | ''>('');

  const handleAuthError = (r: Response): boolean => {
    if (r.status === 401) { showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626'); logout(); return true; }
    return false;
  };

  const load = async () => {
    setLoading(true);
    try {
      const [ar, pr, sp] = await Promise.all([
        fetch('/api/sa/areas?all=true', { headers: H() }).then(r => r.json()),
        fetch('/api/sa/provinces',       { headers: H() }).then(r => r.json()),
        fetch('/api/sa/sub-provinces',   { headers: H() }).then(r => r.json()),
      ]);
      if (ar.success) setAreas(ar.data);
      if (pr.success) setProvinces(pr.data);
      if (sp.success) setSubProvinces(sp.data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const refreshProvinceCounts = async () => {
    const [r, rs] = await Promise.all([
      fetch('/api/sa/provinces', { headers: H() }),
      fetch('/api/sa/sub-provinces', { headers: H() }),
    ]);
    const j = await r.json();  if (j.success) setProvinces(j.data);
    const js = await rs.json(); if (js.success) setSubProvinces(js.data);
  };

  // ── Area CRUD ────────────────────────────────────────────────────────────
  const createArea = async () => {
    const name = newAreaName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas', { method: 'POST', headers: H(), body: JSON.stringify({ name }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + j.error, '#dc2626'); return; }
      setAreas(j.data);
      // إن اختار المدير محافظة عند الإنشاء، أسندها فوراً بدل ترك المنطقة «غير محدد»
      if (newAreaProvince !== '') {
        const created = j.data.find((a: Area) => a.name === name);
        if (created) await assignProvince([created.id], Number(newAreaProvince));
      }
      setNewAreaName(''); setNewAreaProvince('');
      showToast('✅ تمت إضافة المنطقة');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const renameArea = async (id: number) => {
    const name = editingName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ name }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); setEditingId(null); setEditingName(''); showToast('✅ تم تعديل الاسم'); }
      else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const assignProvince = async (areaIds: number[], provinceId: number | null) => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds, provinceId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); await refreshProvinceCounts(); showToast(`✅ تم نقل ${j.updated} منطقة`); }
      else showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const assignSubProvince = async (areaIds: number[], subProvinceId: number | null) => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/sub-province-bulk', { method: 'PUT', headers: H(), body: JSON.stringify({ areaIds, subProvinceId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); await refreshProvinceCounts(); showToast(`✅ تم نقل ${j.updated} منطقة`); }
      else showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const mergeInto = async (fromId: number, toId: number, fromName: string, toName: string) => {
    if (!confirm(`دمج "${fromName}" داخل "${toName}"؟ ستُنقل كل بياناتها (مبيعات، أطباء، ...) ثم تُحذف "${fromName}". لا يمكن التراجع.`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge', { method: 'POST', headers: H(), body: JSON.stringify({ fromId, toId }) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); await refreshProvinceCounts(); setOpenMergePicker(null); showToast(`✅ تم الدمج في "${toName}"`); }
      else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const openDelete = async (id: number, name: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}/usage`, { headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + j.error, '#dc2626'); return; }
      setDeleteTransferTo('');
      setDeleteInfo({ id, name, usage: j.usage, total: j.total, blocking: j.blocking });
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  const confirmDelete = async (mode: 'detach' | 'transfer') => {
    if (!deleteInfo) return;
    if (mode === 'transfer' && !deleteTransferTo) { showToast('اختر منطقة لنقل البيانات إليها', '#dc2626'); return; }
    setBusy(true);
    try {
      const body = mode === 'transfer' ? { transferTo: deleteTransferTo } : {};
      const r = await fetch(`/api/sa/areas/${deleteInfo.id}`, { method: 'DELETE', headers: H(), body: JSON.stringify(body) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        setAreas(j.data); await refreshProvinceCounts(); setDeleteInfo(null);
        showToast(mode === 'transfer' ? '✅ تم نقل البيانات وحذف المنطقة' : '✅ تم حذف المنطقة');
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setBusy(false); }
  };

  // ── أدوات الدمج والمطابقة التلقائية على مستوى القائمة كاملة ───────────────
  const mergeDuplicates = async () => {
    if (!confirm('سيتم دمج المناطق المكررة المتطابقة بالاسم (مثل الحارثية/الحارثيه) في منطقة واحدة، مع نقل كل بياناتها. لا تُحذف أي بيانات. متابعة؟')) return;
    setMergeBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge-duplicates', { method: 'POST', headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { setAreas(j.data); showToast(j.mergedCount > 0 ? `✅ تم دمج ${j.mergedCount} منطقة مكررة` : '✅ لا توجد مناطق مكررة متطابقة'); }
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setMergeBusy(false); }
  };

  const loadMergeSuggestions = async () => {
    setMergeBusy(true);
    try {
      const r = await fetch('/api/sa/areas/merge-suggestions', { headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) setMergeSugs(j.data);
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setMergeBusy(false); }
  };

  const resetFromSurvey = async () => {
    if (!confirm('سيتم مسح المناطق غير المستخدمة (بلا بيانات) وإعادة تحميل القائمة من السيرفي الرئيسي. المناطق المرتبطة ببيانات تبقى. متابعة؟')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sa/areas/reset-from-survey', { method: 'POST', headers: H() });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) { await load(); showToast(`✅ تم التحديث — ${j.count} منطقة`); }
      else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  const autoMatchProvinces = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/provinces/auto-match', { method: 'POST', headers: H(), body: JSON.stringify({}) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        await load();
        const s = j.stats || {};
        showToast(`✅ مطابقة المحافظات: ${s.matchedFromSales ?? 0} من المبيعات، ${s.matchedFromName ?? 0} من الاسم، ${s.unresolved ?? 0} بقيت بلا محافظة`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  const autoMatchSubProvinces = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/sa/sub-provinces/auto-match', { method: 'POST', headers: H(), body: JSON.stringify({}) });
      if (handleAuthError(r)) return;
      const j = await r.json();
      if (j.success) {
        await load();
        const s = j.stats || {};
        showToast(`✅ توزيع كرخ/رصافة: ${s.matched ?? 0} تم توزيعها، ${s.unresolved ?? 0} بقيت بلا قسم`);
      } else showToast('❌ ' + j.error, '#dc2626');
    } finally { setBusy(false); }
  };

  // ── بناء الشجرة: محافظة ← قسم (إن وُجد) ← مناطق ───────────────────────────
  // كل المحافظات الـ18 تظهر دائماً حتى الفارغة منها — هذا المطلوب: رؤية كل
  // المحافظات والمناطق المنطوية تحتها في مكان واحد.
  type SubGroup = { subKey: string; sub: SubProvince | null; areas: Area[] };
  type Group = { key: string; province: Province | null; areas: Area[]; subs: SubGroup[] };

  const { groups, conflictCount } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? areas.filter(a => a.name.toLowerCase().includes(q)) : areas;
    const provinceById = new Map(provinces.map(p => [p.id, p]));
    const subById = new Map(subProvinces.map(s => [s.id, s]));

    const groupsMap = new Map<string, Group>();
    const ensureGroup = (key: string, province: Province | null): Group => {
      if (!groupsMap.has(key)) groupsMap.set(key, { key, province, areas: [], subs: [] });
      return groupsMap.get(key)!;
    };
    const ensureSub = (g: Group, sub: SubProvince | null): SubGroup => {
      const subKey = sub ? String(sub.id) : 'direct';
      let sg = g.subs.find(s => s.subKey === subKey);
      if (!sg) { sg = { subKey, sub, areas: [] }; g.subs.push(sg); }
      return sg;
    };

    // كل محافظة تظهر دوماً، حتى بلا مناطق مطابقة للبحث الحالي
    if (!q) for (const p of provinces) ensureGroup(String(p.id), p);
    ensureGroup('none', null);
    if (!q) for (const s of subProvinces) ensureSub(ensureGroup(String(s.provinceId), provinceById.get(s.provinceId) ?? null), s);

    for (const a of filtered) {
      const p = a.provinceId != null ? provinceById.get(a.provinceId) ?? null : null;
      const g = ensureGroup(p ? String(p.id) : 'none', p);
      g.areas.push(a);
      const s = a.subProvinceId != null ? subById.get(a.subProvinceId) ?? null : null;
      ensureSub(g, s && p && s.provinceId === p.id ? s : null).areas.push(a);
    }

    const list = [...groupsMap.values()]
      .filter(g => !q || g.areas.length > 0)
      .sort((x, y) => {
        if (!x.province) return 1;
        if (!y.province) return -1;
        return (x.province.sortOrder ?? 0) - (y.province.sortOrder ?? 0) || x.province.name.localeCompare(y.province.name, 'ar');
      });
    for (const g of list) {
      g.subs.sort((x, y) => {
        if (!x.sub) return 1;
        if (!y.sub) return -1;
        return (x.sub.sortOrder ?? 0) - (y.sub.sortOrder ?? 0) || x.sub.name.localeCompare(y.sub.name, 'ar');
      });
    }
    return { groups: list, conflictCount: areas.filter(a => a.provinceConflict).length };
  }, [areas, provinces, subProvinces, search]);

  const toggleCollapse = (key: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const AreaRow = ({ a }: { a: Area }) => {
    const isEditing = editingId === a.id;
    const provincePickerOpen = openProvincePicker === a.id;
    const subPickerOpen = openSubPicker === a.id;
    const mergePickerOpen = openMergePicker === a.id;
    const areaSubs = a.provinceId != null ? subProvinces.filter(s => s.provinceId === a.provinceId) : [];

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', padding: '6px 10px', background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 8, fontSize: 13.5 }}>
        {isEditing ? (
          <>
            <input type="text" value={editingName} onChange={e => setEditingName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') renameArea(a.id); if (e.key === 'Escape') setEditingId(null); }}
              autoFocus disabled={busy}
              style={{ flex: 1, minWidth: 120, padding: '5px 10px', borderRadius: 6, border: '1px solid #93c5fd', fontSize: 13.5, direction: 'rtl' }} />
            <button onClick={() => renameArea(a.id)} disabled={busy || !editingName.trim()} title="حفظ الاسم" style={{ ...btnStyle('#16a34a', true), fontSize: 11, padding: '3px 9px' }}>💾</button>
            <button onClick={() => setEditingId(null)} disabled={busy} title="إلغاء" style={{ ...btnStyle('#94a3b8', true), fontSize: 11, padding: '3px 9px' }}>✕</button>
          </>
        ) : (
          <>
            <span style={{ flex: 1, minWidth: 140, color: '#1e293b', fontWeight: 500 }}>
              {a.name}
              {a.userId != null && (
                <span title="هذه منطقة خاصة بحساب مستخدم معيّن — منطقة بنفس الاسم عند حساب آخر صفّ مستقلّ بالتصميم، ولا يمكن دمجهما" style={{ marginInlineStart: 6, fontSize: 10, fontWeight: 600, color: '#3730a3', background: '#e0e7ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '1px 6px' }}>👤 {a.user?.username ?? `#${a.userId}`}</span>
              )}
              {a.provinceConflict && (
                <span title={`ورد اسم هذه المنطقة في ملف بمحافظة «${a.provinceConflict}» تختلف عن المحفوظة`} style={{ marginInlineStart: 6, fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '1px 6px' }}>⚠️ {a.provinceConflict}</span>
              )}
            </span>

            {/* نقل بين المحافظات */}
            {provincePickerOpen ? (
              <select autoFocus defaultValue={a.provinceId ?? ''} disabled={busy}
                onChange={e => { assignProvince([a.id], e.target.value === '' ? null : Number(e.target.value)); setOpenProvincePicker(null); }}
                onBlur={() => setOpenProvincePicker(null)}
                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #93c5fd', direction: 'rtl', maxWidth: 140 }}>
                <option value="">— بلا محافظة</option>
                {provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <button onClick={() => setOpenProvincePicker(a.id)} disabled={busy} title="نقل إلى محافظة أخرى"
                style={{ ...btnStyle('#64748b', true), fontSize: 11, padding: '3px 8px' }}>
                🗺️ {a.provinceId != null ? (provinces.find(p => p.id === a.provinceId)?.name ?? '؟') : '—'}
              </button>
            )}

            {/* نقل بين الأقسام (الكرخ/الرصافة) — يظهر فقط إن كان لمحافظة المنطقة أقسام */}
            {areaSubs.length > 0 && (
              subPickerOpen ? (
                <select autoFocus defaultValue={a.subProvinceId ?? ''} disabled={busy}
                  onChange={e => { assignSubProvince([a.id], e.target.value === '' ? null : Number(e.target.value)); setOpenSubPicker(null); }}
                  onBlur={() => setOpenSubPicker(null)}
                  style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #93c5fd', direction: 'rtl', maxWidth: 130 }}>
                  <option value="">— بلا قسم</option>
                  {areaSubs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <button onClick={() => setOpenSubPicker(a.id)} disabled={busy} title="نقل إلى قسم آخر داخل المحافظة"
                  style={{ ...btnStyle('#94a3b8', true), fontSize: 11, padding: '3px 8px' }}>
                  🏙️ {a.subProvinceId != null ? (subProvinces.find(s => s.id === a.subProvinceId)?.name ?? '؟') : '—'}
                </button>
              )
            )}

            {/* دمج مع منطقة أخرى */}
            {mergePickerOpen ? (
              <select autoFocus defaultValue="" disabled={busy}
                onChange={e => {
                  const toId = Number(e.target.value);
                  const target = areas.find(x => x.id === toId);
                  if (target) mergeInto(a.id, toId, a.name, target.name);
                  else setOpenMergePicker(null);
                }}
                onBlur={() => setOpenMergePicker(null)}
                style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #fca5a5', direction: 'rtl', maxWidth: 150 }}>
                <option value="" disabled>— دمج داخل —</option>
                {/* الدمج بين حسابين مختلفين ممنوع من الخادم (يُخفي بيانات أحدهما) —
                    نستبعده هنا مسبقاً بدل ترك المدير يجرّب ويصطدم بخطأ */}
                {areas.filter(x => x.id !== a.id && (x.userId ?? null) === (a.userId ?? null)).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            ) : (
              <button onClick={() => setOpenMergePicker(a.id)} disabled={busy} title="دمج هذه المنطقة داخل منطقة أخرى لنفس الحساب (تُحذف بعد نقل بياناتها)"
                style={{ ...btnStyle('#d97706', true), fontSize: 11, padding: '3px 8px' }}>🔀 دمج</button>
            )}

            <button onClick={() => { setEditingId(a.id); setEditingName(a.name); }} disabled={busy} title="تعديل الاسم" style={{ ...btnStyle('#2563eb', true), fontSize: 11, padding: '3px 9px' }}>✏️</button>
            <button onClick={() => openDelete(a.id, a.name)} disabled={busy} title="حذف المنطقة" style={{ ...btnStyle('#dc2626', true), fontSize: 11, padding: '3px 9px' }}>🗑️</button>
          </>
        )}
      </div>
    );
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>🗺️ المحافظات والمناطق</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy || mergeBusy} onClick={mergeDuplicates} title="دمج المناطق المتطابقة بعد التطبيع (الحارثية = الحارثيه) دون فقدان أي بيانات"
            style={{ ...btnStyle('#0d9488', true), fontSize: 12 }}>{mergeBusy ? '...' : '🧹 دمج المكررات'}</button>
          <button disabled={busy || mergeBusy} onClick={loadMergeSuggestions} title="عرض مناطق متشابهة (وليست متطابقة) لمراجعتها ودمجها يدوياً"
            style={{ ...btnStyle('#d97706', true), fontSize: 12 }}>{mergeBusy ? '...' : '🔍 اقتراحات الدمج'}</button>
          <button disabled={busy} onClick={autoMatchProvinces} title="يُسند محافظة لكل منطقة بلا محافظة تلقائياً"
            style={{ ...btnStyle('#0d9488', true), fontSize: 12 }}>🗺️ مطابقة المحافظات</button>
          <button disabled={busy} onClick={autoMatchSubProvinces} title="يوزّع مناطق بغداد على الكرخ/الرصافة تلقائياً"
            style={{ ...btnStyle('#4f46e5', true), fontSize: 12 }}>🏙️ توزيع كرخ/رصافة</button>
          <button disabled={busy} onClick={resetFromSurvey} title="إعادة تحميل قائمة المناطق من السيرفي الرئيسي (لا تحذف مناطق مرتبطة ببيانات)"
            style={{ ...btnStyle('#7c3aed', true), fontSize: 12 }}>🔄 تحديث من السيرفي</button>
        </div>
      </div>

      {conflictCount > 0 && (
        <div style={{ marginBottom: 12, border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10, padding: '8px 12px', fontSize: 12, color: '#991b1b' }}>
          ⚠️ <strong>{conflictCount}</strong> منطقة ورد اسمها في ملف بمحافظة تختلف عن المحفوظة. اضغط زر المحافظة بجانب المنطقة لحسم التعارض.
        </div>
      )}

      {mergeSugs !== null && (
        <div style={{ marginBottom: 16, border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13, color: '#92400e' }}>🔍 اقتراحات دمج المناطق المتشابهة ({mergeSugs.length})</strong>
            <button onClick={() => setMergeSugs(null)} style={{ ...btnStyle('#64748b', true), fontSize: 11, padding: '3px 10px' }}>✕ إغلاق</button>
          </div>
          {mergeSugs.length === 0 ? (
            <div style={{ fontSize: 13, color: '#78716c', padding: '6px 2px' }}>لا توجد مناطق متشابهة تحتاج مراجعة.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
              {mergeSugs.map((s, i) => {
                const keep = s.b.sales > s.a.sales ? s.b : s.a;
                const drop = keep === s.a ? s.b : s.a;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 10px', fontSize: 13, flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 140 }}>
                      <b>{s.a.name}</b> <span style={{ color: '#94a3b8', fontSize: 11 }}>({s.a.sales} مبيعة)</span>
                      <span style={{ color: '#d97706', margin: '0 6px' }}>↔</span>
                      <b>{s.b.name}</b> <span style={{ color: '#94a3b8', fontSize: 11 }}>({s.b.sales} مبيعة)</span>
                    </span>
                    <button disabled={mergeBusy} onClick={async () => { await mergeInto(drop.id, keep.id, drop.name, keep.name); setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}
                      style={{ ...btnStyle('#0d9488', true), fontSize: 11, padding: '3px 10px' }}>دمج في «{keep.name}»</button>
                    <button disabled={mergeBusy} onClick={() => setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev)}
                      style={{ ...btnStyle('#94a3b8', true), fontSize: 11, padding: '3px 10px' }}>تجاهل</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <input type="text" placeholder="🔍 بحث عن منطقة..." value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: '9px 12px', marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl', boxSizing: 'border-box' }} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input type="text" placeholder="➕ اسم منطقة جديدة..." value={newAreaName} onChange={e => setNewAreaName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createArea(); }} disabled={busy}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }} />
        <select value={newAreaProvince} onChange={e => setNewAreaProvince(e.target.value === '' ? '' : Number(e.target.value))} disabled={busy}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13, direction: 'rtl', maxWidth: 180 }}>
          <option value="">بلا محافظة</option>
          {provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={createArea} disabled={busy || !newAreaName.trim()} style={{ ...btnStyle('#16a34a', true), fontSize: 13, opacity: (busy || !newAreaName.trim()) ? 0.5 : 1 }}>
          ➕ إضافة
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, fontSize: 12, color: '#64748b' }}>
        <span>{groups.length} محافظة/مجموعة — {areas.length} منطقة إجمالاً</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setCollapsed(new Set())} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}>▼ فتح الكل</button>
          <button onClick={() => setCollapsed(new Set(groups.map(g => g.key)))} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}>◀ طيّ الكل</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {groups.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8', fontSize: 13 }}>لا توجد مناطق مطابقة</div>}
        {groups.map(group => {
          const isCollapsed = search.trim() ? false : collapsed.has(group.key);
          return (
            <div key={group.key} style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
              <div onClick={() => toggleCollapse(group.key)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#f8fafc', borderBottom: isCollapsed ? 'none' : '1px solid #e2e8f0', borderRadius: isCollapsed ? 9 : '9px 9px 0 0' }}>
                <span style={{ fontSize: 12, color: '#475569', width: 14 }}>{isCollapsed ? '◀' : '▼'}</span>
                {group.province ? (
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>🗺️ {group.province.name} <span style={{ fontWeight: 500, fontSize: 12, color: '#64748b' }}>({group.areas.length})</span></span>
                ) : (
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#92400e' }}>⚠️ غير محدد <span style={{ fontWeight: 500, fontSize: 12, color: '#a16207' }}>({group.areas.length})</span></span>
                )}
              </div>
              {!isCollapsed && (
                <div style={{ padding: 8 }}>
                  {group.areas.length === 0 && group.subs.every(s => s.areas.length === 0) && (
                    <div style={{ fontSize: 12, color: '#94a3b8', padding: '4px 8px' }}>لا توجد مناطق في هذه المحافظة بعد.</div>
                  )}
                  {group.subs.length > 1 ? (
                    // فيها أقسام فعلية (بغداد: الكرخ/الرصافة) — اعرض كل قسم كمجموعة فرعية
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {group.subs.map(sg => {
                        const subKeyFull = group.key + ':' + sg.subKey;
                        const subCollapsed = search.trim() ? false : collapsed.has(subKeyFull);
                        return (
                          <div key={sg.subKey} style={{ border: '1px solid #eef2f7', borderRadius: 8, background: '#fcfdfe' }}>
                            <div onClick={() => toggleCollapse(subKeyFull)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#f1f5f9', borderBottom: subCollapsed ? 'none' : '1px solid #e8edf3', borderRadius: subCollapsed ? 7 : '7px 7px 0 0' }}>
                              <span style={{ fontSize: 11, color: '#64748b', width: 12 }}>{subCollapsed ? '◀' : '▼'}</span>
                              <span style={{ fontWeight: 600, fontSize: 12.5, color: sg.sub ? '#334155' : '#64748b' }}>
                                {sg.sub ? `🏙️ ${sg.sub.name}` : '▪️ بلا قسم'} <span style={{ fontWeight: 500, fontSize: 11 }}>({sg.areas.length})</span>
                              </span>
                            </div>
                            {!subCollapsed && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 6 }}>
                                {sg.areas.length === 0 && <div style={{ fontSize: 11, color: '#94a3b8', padding: '3px 6px' }}>لا توجد مناطق هنا بعد.</div>}
                                {sg.areas.map(a => <AreaRow key={a.id} a={a} />)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {group.areas.map(a => <AreaRow key={a.id} a={a} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 🗑️ نافذة حذف منطقة */}
      {deleteInfo && (() => {
        const rows = Object.entries(deleteInfo.usage).filter(([, v]) => v > 0);
        const isEmpty = deleteInfo.total === 0;
        return (
          <div onClick={() => !busy && setDeleteInfo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 'min(460px, 92vw)', maxHeight: '85vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 17, color: '#0f172a' }}>🗑️ حذف منطقة «{deleteInfo.name}»</h3>
              {isEmpty ? (
                <p style={{ fontSize: 14, color: '#475569', margin: '0 0 16px' }}>لا توجد أي بيانات مرتبطة بهذه المنطقة. يمكن حذفها مباشرة.</p>
              ) : (
                <>
                  <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: 12, marginBottom: 14 }}>
                    <strong style={{ fontSize: 13, color: '#92400e' }}>⚠️ هذه المنطقة مرتبطة ببيانات:</strong>
                    <ul style={{ margin: '8px 0 0', paddingInlineStart: 20, fontSize: 13, color: '#78350f' }}>
                      {rows.map(([k, v]) => <li key={k}>{USAGE_LABELS[k] || k}: <b>{v}</b></li>)}
                    </ul>
                  </div>
                  {deleteInfo.blocking && (
                    <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '0 0 12px' }}>
                      ⛔ لوجود مبيعات مرتبطة لا يمكن «تصفير» المنطقة — يجب <b>نقل</b> بياناتها إلى منطقة أخرى قبل الحذف.
                    </p>
                  )}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>① نقل البيانات إلى منطقة أخرى ثم الحذف:</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select value={deleteTransferTo} onChange={e => setDeleteTransferTo(e.target.value ? Number(e.target.value) : '')} disabled={busy}
                        style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}>
                        <option value="">— اختر منطقة الوجهة —</option>
                        {/* النقل بين حسابين مختلفين ممنوع من الخادم لنفس سبب منع الدمج */}
                        {areas.filter(a => a.id !== deleteInfo.id && (a.userId ?? null) === (areas.find(x => x.id === deleteInfo.id)?.userId ?? null)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <button onClick={() => confirmDelete('transfer')} disabled={busy || !deleteTransferTo} style={{ ...btnStyle('#0d9488', true), fontSize: 13, opacity: (busy || !deleteTransferTo) ? 0.5 : 1 }}>نقل وحذف</button>
                    </div>
                  </div>
                </>
              )}
              {!deleteInfo.blocking && (
                <div style={{ marginBottom: 14 }}>
                  {!isEmpty && <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>② تصفير (فصل) البيانات ثم الحذف:</div>}
                  <button onClick={() => confirmDelete('detach')} disabled={busy} style={{ ...btnStyle('#dc2626', true), fontSize: 13, padding: '6px 16px', width: '100%' }}>
                    {busy ? '...' : (isEmpty ? '🗑️ حذف المنطقة' : '🗑️ تصفير البيانات وحذف المنطقة')}
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <button onClick={() => setDeleteInfo(null)} disabled={busy} style={{ ...btnStyle('#64748b', true), fontSize: 13 }}>إلغاء</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
