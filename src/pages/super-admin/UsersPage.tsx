import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

const ROLES = [
  { value: 'office_manager',          label: 'مدير مكتب' },
  { value: 'office_hr',               label: 'HR مكتب' },
  { value: 'office_employee',         label: 'موظف مكتب' },
  { value: 'company_manager',         label: 'مدير شركة' },
  { value: 'supervisor',              label: 'مشرف' },
  { value: 'product_manager',         label: 'مدير منتج' },
  { value: 'team_leader',             label: 'قائد فريق' },
  { value: 'scientific_rep',          label: 'مندوب علمي' },
  { value: 'commercial_supervisor',   label: 'مشرف تجاري' },
  { value: 'commercial_team_leader',  label: 'قائد فريق تجاري' },
  { value: 'commercial_rep',          label: 'مندوب تجاري' },
  { value: 'admin',                   label: 'مدير (admin)' },
  { value: 'manager',                 label: 'مدير (manager)' },
];

const FEATURES = [
  // ── الصفحات ──
  { key: 'ai_assistant',  label: 'مساعد الذكاء الاصطناعي', icon: '🤖', desc: 'زر مساعد AI والأوامر الصوتية والنصية الذكية', group: 'pages' },
  { key: 'monthly_plans', label: 'البلانات الشهرية',        icon: '📅', desc: 'صفحة إنشاء وإدارة البلانات الشهرية',          group: 'pages' },
  { key: 'reports',       label: 'التقارير',                icon: '📊', desc: 'صفحة عرض التقارير والإحصائيات',               group: 'pages' },
  { key: 'rep_analysis',  label: 'تحليل زيارات المندوب',    icon: '📈', desc: 'تحليل أداء المندوب التفصيلي',                 group: 'pages' },
  { key: 'wish_list',     label: 'قائمة الطلبات (السيرفي)', icon: '📋', desc: 'صفحة قائمة الأطباء المستهدفين',               group: 'pages' },
  { key: 'export_report', label: 'تصدير التقارير',          icon: '⬇️', desc: 'إمكانية تصدير وطباعة التقارير',               group: 'pages' },
  // ── ميزات داخل التطبيق ──
  { key: 'call_log',      label: 'سجل إضافة الزيارات',      icon: '📝', desc: 'نموذج تسجيل الزيارة اليومية وإدخال البيانات', group: 'features' },
  { key: 'voice_visit',   label: 'الزيارة الصوتية',          icon: '🎤', desc: 'زر تسجيل الزيارة عبر الصوت (الميكروفون)',     group: 'features' },
  { key: 'daily_map',     label: 'خريطة الزيارات اليومية',   icon: '🗺️', desc: 'عرض مواقع الزيارات على الخريطة التفاعلية',   group: 'features' },
];

interface Office   { id: number; name: string; }
interface Company  { id: number; name: string; officeId: number; }
interface Line     { id: number; name?: string; companyId: number; }
interface Item     { id: number; name: string; }
interface Area     { id: number; name: string; }
interface UserRow  {
  id: number; username: string; displayName?: string; role: string; phone?: string;
  isActive: boolean; officeId?: number; office?: { name: string };
  permissions?: string | null;
  _count?: { companyAssignments: number; areas: number; };
}
interface UserDetail extends UserRow {
  companyAssignments: { companyId: number; company: { name: string } }[];
  lineAssignments:    { lineId: number;    line:    { name?: string; companyId: number } }[];
  itemAssignments:    { itemId: number;    item:    { name: string } }[];
  areaAssignments:    { areaId: number;    area:    { name: string } }[];
  managersOfUser:     { managerId: number; manager: { username: string; displayName?: string } }[];
}

export default function UsersPage() {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const viewAsUser = async (u: UserRow) => {
    if (!u.isActive) { alert('المستخدم غير نشط'); return; }
    const res = await fetch(`/api/super-admin/impersonate/${u.id}`, { method: 'POST', headers: H() });
    const d = await res.json();
    if (!res.ok) { alert(d.error || 'فشل'); return; }
    localStorage.setItem('_imp', JSON.stringify({ token: d.token, user: d.user }));
    window.open('/?imp=1', '_blank');
  };

  const [users,     setUsers]     = useState<UserRow[]>([]);
  const [offices,   setOffices]   = useState<Office[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [lines,     setLines]     = useState<Line[]>([]);
  const [items,     setItems]     = useState<Item[]>([]);
  const [areas,     setAreas]     = useState<Area[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [detail,    setDetail]    = useState<UserDetail | null>(null);
  const [form,      setForm]      = useState<any | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [tab,       setTab]       = useState<'info'|'companies'|'lines'|'items'|'areas'|'managers'|'features'>('info');
  const [search,    setSearch]    = useState('');

  // ── Draft assignment states (must be at top level — Rules of Hooks) ──────
  const [draftCompanyIds,    setDraftCompanyIds]    = useState<number[]>([]);
  const [draftLineIds,       setDraftLineIds]       = useState<number[]>([]);
  const [draftItemIds,       setDraftItemIds]       = useState<number[]>([]);
  const [draftAreaIds,       setDraftAreaIds]       = useState<number[]>([]);
  const [draftMgrIds,        setDraftMgrIds]        = useState<number[]>([]);
  const [draftDisabledFeats, setDraftDisabledFeats] = useState<string[]>([]);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/sa/users',     { headers: H() }).then(r => r.json()),
      fetch('/api/sa/offices',   { headers: H() }).then(r => r.json()),
      fetch('/api/sa/companies', { headers: H() }).then(r => r.json()),
    ]).then(([u, o, c]) => {
      if (u.success) setUsers(u.data);
      if (o.success) setOffices(o.data);
      if (c.success) setCompanies(c.data);
    }).finally(() => setLoading(false));
  };

  const loadRefs = async () => {
    const [li, it, ar] = await Promise.all([
      fetch('/api/sa/companies/all-lines', { headers: H() }).then(r => r.json()),
      fetch('/api/sa/items',  { headers: H() }).then(r => r.json()),
      fetch('/api/sa/areas',  { headers: H() }).then(r => r.json()),
    ]);
    if (li.success) setLines(li.data);
    if (it.success) setItems(it.data);
    if (ar.success) setAreas(ar.data);
  };

  useEffect(load, []);

  // Reset drafts whenever detail changes
  useEffect(() => {
    if (!detail) return;
    setDraftCompanyIds(detail.companyAssignments.map(a => a.companyId));
    setDraftLineIds(detail.lineAssignments.map(a => a.lineId));
    setDraftItemIds(detail.itemAssignments.map(a => a.itemId));
    setDraftAreaIds(detail.areaAssignments.map(a => a.areaId));
    setDraftMgrIds(detail.managersOfUser.map(a => a.managerId));
    try {
      const p = JSON.parse(detail.permissions || '{}');
      setDraftDisabledFeats(p.disabledFeatures ?? []);
    } catch { setDraftDisabledFeats([]); }
  }, [detail?.id]);

  const loadDetail = (id: number) => {
    fetch(`/api/sa/users/${id}`, { headers: H() }).then(r => r.json()).then(d => {
      if (d.success) { setDetail(d.data); setTab('info'); }
    });
    loadRefs();
  };

  const saveUser = async () => {
    if (!form?.username?.trim()) { setError('اسم المستخدم مطلوب'); return; }
    if (!form.id && !form.password?.trim()) { setError('كلمة المرور مطلوبة'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const payload: any = { username: form.username, displayName: form.displayName, role: form.role, phone: form.phone, officeId: form.officeId || null };
    if (form.password) payload.password = form.password;
    const res = await fetch(isEdit ? `/api/sa/users/${form.id}` : '/api/sa/users', {
      method: isEdit ? 'PUT' : 'POST', headers: H(), body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
    if (detail?.id === form.id) loadDetail(form.id);
  };

  const saveAssignment = async (type: string, ids: number[]) => {
    if (!detail) return;
    setSaving(true);
    const keyMap: Record<string, string> = {
      companies: 'companyIds', lines: 'lineIds', items: 'itemIds', areas: 'areaIds', managers: 'managerIds',
    };
    try {
      await fetch(`/api/sa/users/${detail.id}/${type}`, {
        method: 'PUT', headers: H(), body: JSON.stringify({ [keyMap[type]]: ids }),
      });
      loadDetail(detail.id);
    } catch (e) {
      console.error('saveAssignment error:', e);
    } finally {
      setSaving(false);
    }
  };

  const saveFeatures = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await fetch(`/api/sa/users/${detail.id}/features`, {
        method: 'PUT', headers: H(), body: JSON.stringify({ disabledFeatures: draftDisabledFeats }),
      });
      loadDetail(detail.id);
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = async (u: UserRow) => {
    await fetch(`/api/sa/users/${u.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !u.isActive }) });
    load();
  };

  const delUser = async (u: UserRow) => {
    if (!confirm(`حذف مستخدم "${u.username}"؟`)) return;
    await fetch(`/api/sa/users/${u.id}`, { method: 'DELETE', headers: H() });
    load(); if (detail?.id === u.id) setDetail(null);
  };

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    (u.displayName || '').toLowerCase().includes(search.toLowerCase())
  );

  // ── DETAIL VIEW ────────────────────────────────────────────
  if (detail) {
    const selCompanyIds = draftCompanyIds;
    const selLineIds    = draftLineIds;
    const selItemIds    = draftItemIds;
    const selAreaIds    = draftAreaIds;
    const selMgrIds     = draftMgrIds;

    const TabBtn = ({ id, label }: { id: typeof tab; label: string }) => (
      <button onClick={() => setTab(id)} style={{
        padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
        background: tab === id ? '#0f172a' : '#f1f5f9', color: tab === id ? '#fff' : '#374151',
      }}>{label}</button>
    );

    const CheckList = ({ allItems, selIds, onToggle }: { allItems: { id: number; label: string }[]; selIds: number[]; onToggle: (id: number, checked: boolean) => void }) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {allItems.map(i => (
          <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" checked={selIds.includes(i.id)} onChange={e => onToggle(i.id, e.target.checked)} />
            {i.label}
          </label>
        ))}
        {allItems.length === 0 && <div style={{ color: '#94a3b8', fontSize: 13, padding: 8 }}>لا توجد عناصر</div>}
      </div>
    );

    const mkToggle = (selIds: number[], setter: (ids: number[]) => void) =>
      (id: number, checked: boolean) => setter(checked ? [...selIds, id] : selIds.filter(x => x !== id));

    return (
      <div>
        <button onClick={() => setDetail(null)} style={{ ...btnStyle('#64748b', true), marginBottom: 20 }}>← رجوع</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>👤 {detail.displayName || detail.username}</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>{detail.username} · {ROLES.find(r => r.value === detail.role)?.label || detail.role} · {detail.office?.name || '—'}</span>
          </div>
          <button onClick={() => setForm({ ...detail, password: '' })} style={btnStyle('#3b82f6', true)}>تعديل البيانات</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <TabBtn id="info"      label="معلومات" />
          <TabBtn id="companies" label={`الشركات (${selCompanyIds.length})`} />
          <TabBtn id="lines"     label={`اللاينات (${selLineIds.length})`} />
          <TabBtn id="items"     label={`الايتمات (${selItemIds.length})`} />
          <TabBtn id="areas"     label={`المناطق (${selAreaIds.length})`} />
          <TabBtn id="managers"  label={`المدراء (${selMgrIds.length})`} />
          <TabBtn id="features"  label="🎛️ المميزات" />
        </div>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20 }}>
          {tab === 'info' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {[
                ['اسم المستخدم', detail.username],
                ['الاسم الظاهر', detail.displayName || '—'],
                ['الدور', ROLES.find(r => r.value === detail.role)?.label || detail.role],
                ['الهاتف', detail.phone || '—'],
                ['المكتب', detail.office?.name || '—'],
                ['الحالة', detail.isActive ? '🟢 نشط' : '🔴 معطل'],
              ].map(([k, v]) => (
                <div key={k}><div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 3 }}>{k}</div><div style={{ fontWeight: 600 }}>{v}</div></div>
              ))}
            </div>
          )}
          {tab === 'companies' && (
            <div>
              <CheckList allItems={companies.map(c => ({ id: c.id, label: c.name }))} selIds={draftCompanyIds} onToggle={mkToggle(draftCompanyIds, setDraftCompanyIds)} />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('companies', draftCompanyIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'lines' && (
            <div>
              <CheckList allItems={lines.map(l => ({ id: l.id, label: l.name || `لاين #${l.id}` }))} selIds={draftLineIds} onToggle={mkToggle(draftLineIds, setDraftLineIds)} />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('lines', draftLineIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'items' && (
            <div>
              <CheckList allItems={items.map(i => ({ id: i.id, label: i.name }))} selIds={draftItemIds} onToggle={mkToggle(draftItemIds, setDraftItemIds)} />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('items', draftItemIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'areas' && (
            <div>
              <CheckList allItems={areas.map(a => ({ id: a.id, label: a.name }))} selIds={draftAreaIds} onToggle={mkToggle(draftAreaIds, setDraftAreaIds)} />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('areas', draftAreaIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'managers' && (
            <div>
              <CheckList allItems={users.filter(u => u.id !== detail.id).map(u => ({ id: u.id, label: `${u.displayName || u.username} (${ROLES.find(r => r.value === u.role)?.label || u.role})` }))} selIds={draftMgrIds} onToggle={mkToggle(draftMgrIds, setDraftMgrIds)} />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('managers', draftMgrIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'features' && (
            <div>
              <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 16 }}>
                تحكم في الميزات المتاحة لهذا المستخدم. أي ميزة مُعطَّلة لن تظهر عند تسجيل دخوله.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['pages', 'features'] as const).map(group => (
                  <div key={group}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, marginTop: group === 'features' ? 14 : 0 }}>
                      {group === 'pages' ? '📄 الصفحات والأقسام' : '⚙️ ميزات داخل التطبيق'}
                    </div>
                    {FEATURES.filter(f => f.group === group).map(f => {
                      const isDisabled = draftDisabledFeats.includes(f.key);
                      return (
                        <div key={f.key} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '12px 16px', borderRadius: 10, border: `1.5px solid ${isDisabled ? '#fee2e2' : '#dcfce7'}`,
                          background: isDisabled ? '#fff7f7' : '#f0fdf4', marginBottom: 8,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 22 }}>{f.icon}</span>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>{f.label}</div>
                              <div style={{ fontSize: 12, color: '#94a3b8' }}>{f.desc}</div>
                            </div>
                          </div>
                          <label style={{ position: 'relative', display: 'inline-block', width: 48, height: 26, cursor: 'pointer', flexShrink: 0 }}>
                            <input type="checkbox" checked={!isDisabled}
                              onChange={e => {
                                if (e.target.checked) setDraftDisabledFeats(prev => prev.filter(k => k !== f.key));
                                else setDraftDisabledFeats(prev => [...prev, f.key]);
                              }}
                              style={{ opacity: 0, width: 0, height: 0 }} />
                            <span style={{
                              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                              background: isDisabled ? '#e2e8f0' : '#22c55e',
                              borderRadius: 26, transition: 'background 0.2s',
                            }} />
                            <span style={{
                              position: 'absolute', top: 3, left: isDisabled ? 3 : 25, width: 20, height: 20,
                              background: '#fff', borderRadius: '50%', transition: 'left 0.2s',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                            }} />
                          </label>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={saveFeatures} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ المميزات'}</button>
              </div>
            </div>
          )}
        </div>

        {form && (
          <Modal onClose={() => { setForm(null); setError(''); }} title="تعديل المستخدم">
            <UserFormFields form={form} setForm={setForm} offices={offices} isEdit />
            {error && <ErrBox msg={error} />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
              <button onClick={saveUser} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  // ── LIST VIEW ────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>👥 المستخدمون</h2>
        <button onClick={() => setForm({ username: '', password: '', displayName: '', role: 'scientific_rep', officeId: '', phone: '' })} style={btnStyle('#0f172a')}>+ إضافة مستخدم</button>
      </div>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="🔍 بحث..."
        style={{ width: '100%', padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 14, marginBottom: 20, boxSizing: 'border-box' }}
      />
      {loading ? <Spinner /> : (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                {['المستخدم', 'الدور', 'المكتب', 'الشركات', 'الحالة', ''].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'right', fontSize: 12, color: '#64748b', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((u, i) => (
                <tr key={u.id} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600 }}>{u.displayName || u.username}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>@{u.username}</div>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13 }}>{ROLES.find(r => r.value === u.role)?.label || u.role}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748b' }}>{u.office?.name || '—'}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13 }}>{u._count?.companyAssignments ?? 0}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ background: u.isActive ? '#dcfce7' : '#fee2e2', color: u.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
                      {u.isActive ? 'نشط' : 'معطل'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => viewAsUser(u)} title="دخول كهذا المستخدم" style={btnStyle('#0ea5e9', true)}>👁️ مراقبة</button>
                      <button onClick={() => loadDetail(u.id)} style={btnStyle('#6366f1', true)}>تفاصيل</button>
                      <button onClick={() => setForm({ ...u, password: '' })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                      <button onClick={() => toggleUser(u)} style={btnStyle(u.isActive ? '#f59e0b' : '#10b981', true)}>{u.isActive ? 'تعطيل' : 'تفعيل'}</button>
                      <button onClick={() => delUser(u)} style={btnStyle('#ef4444', true)}>حذف</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>لا توجد نتائج</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {form && !detail && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل المستخدم' : 'إضافة مستخدم'}>
          <UserFormFields form={form} setForm={setForm} offices={offices} isEdit={Boolean(form.id)} />
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveUser} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserFormFields({ form, setForm, offices, isEdit }: { form: any; setForm: any; offices: Office[]; isEdit: boolean }) {
  return (
    <>
      <Field label="اسم المستخدم *" value={form.username || ''} onChange={v => setForm((f: any) => ({ ...f, username: v }))} />
      <Field label={isEdit ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور *'} value={form.password || ''} onChange={v => setForm((f: any) => ({ ...f, password: v }))} type="password" />
      <Field label="الاسم الظاهر" value={form.displayName || ''} onChange={v => setForm((f: any) => ({ ...f, displayName: v }))} />
      <Field label="الهاتف" value={form.phone || ''} onChange={v => setForm((f: any) => ({ ...f, phone: v }))} />
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>الدور</label>
        <select value={form.role || ''} onChange={e => setForm((f: any) => ({ ...f, role: e.target.value }))}
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
          {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>المكتب العلمي</label>
        <select value={form.officeId || ''} onChange={e => setForm((f: any) => ({ ...f, officeId: e.target.value ? Number(e.target.value) : null }))}
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
          <option value="">-- بدون مكتب --</option>
          {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
    </>
  );
}
