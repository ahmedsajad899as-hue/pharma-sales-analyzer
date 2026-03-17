import { useState, useEffect, useRef } from 'react';
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

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  MANDATORY RULE — FEATURE_TREE                                          ║
// ║  أي صفحة أو تبويب أو زر أو حقل أو ميزة جديدة تُضاف للتطبيق            ║
// ║  يجب إضافتها هنا في FEATURE_TREE فوراً بـ key عربي ووصف وأيقونة        ║
// ║  ثم تُغلق في المكوّن المناسب عبر:  hasFeature('key')                   ║
// ║  وإن كانت صفحة كاملة: أضفها أيضاً في featurePageMap بـ Sidebar.tsx     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Role groups for feature-tree visibility ──────────────────────────────────
const COMMERCIAL_ROLES = ['commercial_rep','commercial_team_leader','commercial_supervisor','admin','manager','office_manager','company_manager'];
const REP_ROLES        = ['scientific_rep','team_leader','supervisor','admin','manager','company_manager','product_manager','office_manager'];

interface FeatureNode {
  key?:       string;
  label:      string;
  icon:       string;
  desc?:      string;
  onlyRoles?: string[];
  children?:  FeatureNode[];
}

const FEATURE_TREE: FeatureNode[] = [
  // ── 1. لوحة الرئيسية
  {
    label: 'لوحة الرئيسية', icon: '🏠',
    desc: 'الشاشة الرئيسية — متاحة دائماً لجميع المستخدمين',
    children: [
      { key: 'call_log',    label: 'سجل إضافة الزيارات',    icon: '📝', desc: 'نموذج تسجيل الزيارة اليومية وإدخال البيانات' },
      { key: 'voice_visit', label: 'الزيارة الصوتية',         icon: '🎤', desc: 'زر تسجيل الزيارة عبر الصوت (الميكروفون)'     },
      { key: 'daily_map',   label: 'خريطة الزيارات اليومية',  icon: '🗺️', desc: 'عرض مواقع الزيارات على الخريطة التفاعلية'   },
    ],
  },
  // ── 2. مساعد الذكاء الاصطناعي
  { key: 'ai_assistant', label: 'مساعد الذكاء الاصطناعي', icon: '🤖', desc: 'الزر العائم للأوامر الصوتية والنصية الذكية' },
  // ── 3. قائمة السيرفي
  {
    label: 'قائمة السيرفي', icon: '🏥',
    desc: 'صفحة إدارة الأطباء والزيارات — متاحة لجميع الأدوار',
    children: [
      { key: 'visit_analysis_tab', label: 'تحليل الزيارات',           icon: '📍', desc: 'تبويب تحليل أداء الزيارات اليومية'               },
      { key: 'doctors_list_tab',   label: 'قائمة الأطباء',             icon: '📋', desc: 'تبويب عرض وإدارة قائمة الأطباء'                 },
      { key: 'my_visits_tab',      label: 'زياراتي',                  icon: '📝', desc: 'تبويب زيارات المندوب التجاري', onlyRoles: COMMERCIAL_ROLES },
      { key: 'pharmacies_tab',     label: 'قائمة الصيدليات',           icon: '🏪', desc: 'تبويب قائمة الصيدليات',        onlyRoles: COMMERCIAL_ROLES },
      { key: 'doctor_fields',      label: 'الحقول التفصيلية للطبيب',  icon: '🩺', desc: 'التخصص والمنطقة والصيدلية والملاحظات'          },
    ],
  },
  // ── 4. البلانات الشهرية
  { key: 'monthly_plans', label: 'البلانات الشهرية', icon: '📅', desc: 'صفحة إنشاء وإدارة البلانات الشهرية' },
  // ── 5. التقارير
  {
    key: 'reports', label: 'التقارير', icon: '📊', desc: 'صفحة عرض التقارير والإحصائيات',
    children: [
      { key: 'export_report', label: 'تصدير التقارير', icon: '⬇️', desc: 'إمكانية تصدير وطباعة التقارير' },
    ],
  },
  // ── 6. تحليل ملفات المندوبين
  {
    key: 'rep_analysis', label: 'تحليل ملفات المندوبين', icon: '📂',
    desc: 'صفحة رفع وتحليل ملفات بيانات المندوبين', onlyRoles: REP_ROLES,
    children: [
      { key: 'rep_files', label: 'رفع وعرض الملفات', icon: '📤', desc: 'رفع ملفات Excel وعرض نتائج التحليل', onlyRoles: REP_ROLES },
    ],
  },
  // ── 7. قائمة المستخدمين
  { key: 'users_list', label: 'قائمة المستخدمين',        icon: '👥', desc: 'صفحة عرض وإدارة قائمة المستخدمين'   },
  // ── 8. قائمة الطلبات (السيرفي)
  { key: 'wish_list',  label: 'قائمة الطلبات (السيرفي)', icon: '📋', desc: 'خاصية عرض قائمة الأطباء المستهدفين' },
  // ── 9. تبديل الحساب
  { key: 'switch_account', label: 'تبديل الحساب (Switch Account)', icon: '⇄', desc: 'زر في الشريط الجانبي لتبديل الحسابات المحفوظة بدون تسجيل خروج' },
];

interface Office   { id: number; name: string; }
interface Company  { id: number; name: string; officeId: number; }
interface Line     { id: number; name?: string; companyId: number; }
interface Item     { id: number; name: string; }
interface Area     { id: number; name: string; }
interface UserRow  {
  id: number; username: string; displayName?: string; role: string; phone?: string;
  isActive: boolean; officeId?: number; office?: { id: number; name: string };
  permissions?: string | null;
  _count?: { companyAssignments: number; areas: number; };
  companyAssignments?: { companyId: number; company: { id: number; name: string } }[];
  managersOfUser?:     { managerId: number; manager: { id: number; username: string; displayName?: string } }[];
}
interface UserDetail extends UserRow {
  linkedRepId?: number | null;
  linkedRep?:   { id: number; name: string } | null;
  companyAssignments: { companyId: number; company: { id: number; name: string } }[];
  lineAssignments:    { lineId: number;    line:    { name?: string; companyId: number } }[];
  itemAssignments:    { itemId: number;    item:    { name: string } }[];
  areaAssignments:    { areaId: number;    area:    { name: string } }[];
  managersOfUser:     { managerId: number; manager: { id: number; username: string; displayName?: string } }[];
}

export default function UsersPage({ jumpUserId, onJumpClear }: { jumpUserId?: number | null; onJumpClear?: () => void } = {}) {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  // Preserve scroll position when entering/leaving detail view
  const savedScrollRef = useRef<number>(0);
  const getMainEl = () => document.querySelector<HTMLElement>('main[style]');

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
  const [draftRequireGps,    setDraftRequireGps]    = useState(true);
  const [repInfoData,        setRepInfoData]        = useState<any | null>(null);

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

  // Auto-open a user when navigated from another page
  useEffect(() => {
    if (!jumpUserId) return;
    loadDetail(jumpUserId);
    onJumpClear?.();
  }, [jumpUserId]);

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
      setDraftRequireGps(p.requireGps !== false);
    } catch { setDraftDisabledFeats([]); setDraftRequireGps(true); }
  }, [detail?.id]);

  const loadDetail = (id: number) => {
    // Save current scroll position before entering detail
    const main = getMainEl();
    if (main) savedScrollRef.current = main.scrollTop;
    setRepInfoData(null);
    fetch(`/api/sa/users/${id}`, { headers: H() }).then(r => r.json()).then(d => {
      if (d.success) {
        setDetail(d.data);
        setTab('info');
        // Scroll to top of detail view
        requestAnimationFrame(() => { const m = getMainEl(); if (m) m.scrollTop = 0; });
      }
    });
    loadRefs();
  };

  const goBack = () => {
    setDetail(null);
    // Restore scroll position after list re-renders
    requestAnimationFrame(() => {
      const m = getMainEl();
      if (m) m.scrollTop = savedScrollRef.current;
    });
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
        method: 'PUT', headers: H(), body: JSON.stringify({ disabledFeatures: draftDisabledFeats, requireGps: draftRequireGps }),
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
        <button onClick={goBack} style={{ ...btnStyle('#64748b', true), marginBottom: 20 }}>← رجوع</button>
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
              {/* Linked Rep row */}
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 6 }}>المندوب المرتبط (linkedRepId)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: detail.linkedRepId ? '#f0fdf4' : '#fff7ed', border: `1px solid ${detail.linkedRepId ? '#86efac' : '#fed7aa'}`, borderRadius: 8, padding: '10px 14px', flexWrap: 'wrap' }}>
                  {detail.linkedRepId ? (
                    <>
                      <span style={{ fontWeight: 700 }}>🔗 #{detail.linkedRepId} — {detail.linkedRep?.name || '؟'}</span>
                      <button
                        onClick={async () => {
                          if (!confirm(`فك ارتباط المندوب عن ${detail.displayName || detail.username}؟`)) return;
                          const r = await fetch(`/api/sa/users/${detail.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ linkedRepId: null }) });
                          if (r.ok) { setRepInfoData(null); loadDetail(detail.id); }
                        }}
                        style={{ ...btnStyle('#ef4444', true), marginRight: 'auto', fontSize: 12, padding: '5px 12px' }}
                      >🔓 فك الارتباط</button>
                    </>
                  ) : (
                    <span style={{ color: '#92400e', fontWeight: 600 }}>⚠️ لا يوجد مندوب مرتبط — سيُنشأ تلقائياً عند أول تحميل للتقارير</span>
                  )}
                  <button
                    onClick={async () => {
                      const r = await fetch(`/api/sa/users/${detail.id}/rep-info`, { headers: H() });
                      const d = await r.json();
                      setRepInfoData(d.success ? d.data : null);
                    }}
                    style={{ ...btnStyle('#6366f1', true), fontSize: 12, padding: '5px 12px' }}
                  >🔍 تشخيص المندوبين</button>
                </div>
                {repInfoData && (
                  <div style={{ marginTop: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 14, fontSize: 13 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8, color: '#0f172a' }}>📊 سجلات ScientificRepresentative المرتبطة بهذا المستخدم:</div>
                    {repInfoData.repsByUserId.length === 0 ? (
                      <div style={{ color: '#64748b' }}>لا توجد سجلات بـ userId = {detail.id}</div>
                    ) : (
                      repInfoData.repsByUserId.map((r: any) => (
                        <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
                          <span style={{ background: repInfoData.user.linkedRepId === r.id ? '#dcfce7' : '#f1f5f9', color: repInfoData.user.linkedRepId === r.id ? '#16a34a' : '#475569', borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>
                            #{r.id} {repInfoData.user.linkedRepId === r.id ? '✓ مرتبط حالياً' : ''}
                          </span>
                          <span>{r.name}</span>
                          <span style={{ color: '#94a3b8' }}>· زيارات أطباء: {r._count.doctorVisits} · زيارات صيادليات: {r._count.pharmacyVisits}</span>
                          {repInfoData.user.linkedRepId !== r.id && (
                            <button
                              onClick={async () => {
                                if (!confirm(`ربط المستخدم بالمندوب #${r.id}؟`)) return;
                                const res = await fetch(`/api/sa/users/${detail.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ linkedRepId: r.id }) });
                                if (res.ok) { setRepInfoData(null); loadDetail(detail.id); }
                              }}
                              style={{ ...btnStyle('#0ea5e9', true), fontSize: 11, padding: '3px 8px' }}
                            >ربط</button>
                          )}
                        </div>
                      ))
                    )}
                    {repInfoData.linkedRep && repInfoData.linkedRep.userId !== detail.id && (
                      <div style={{ marginTop: 8, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: 8, color: '#991b1b', fontWeight: 600 }}>
                        ⚠️ المندوب المرتبط حالياً #{repInfoData.linkedRep.id} — userId في قاعدة البيانات = {repInfoData.linkedRep.userId ?? 'null'} (ليس {detail.id})
                        · زيارات: {repInfoData.linkedRep._count.doctorVisits + repInfoData.linkedRep._count.pharmacyVisits}
                      </div>
                    )}
                  </div>
                )}
              </div>
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
              <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 20 }}>
                تحكم في صلاحيات هذا المستخدم بحسب دوره. أي بند مُعطَّل لن يظهر له عند تسجيل دخوله.
              </p>

              {/* ── GPS Constraint Card ───────────────────────────────── */}
              <div style={{
                borderRadius: 14, border: `2px solid ${draftRequireGps ? '#f97316' : '#e2e8f0'}`,
                background: draftRequireGps ? '#fff7ed' : '#f8fafc',
                padding: '14px 18px', marginBottom: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 28 }}>📍</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>إلزام تفعيل الموقع الجغرافي</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                      {draftRequireGps
                        ? '🔴 مفعّل — المستخدم لا يستطيع إرسال أي تقرير بدون GPS'
                        : '🟢 معطّل — يُظهر تحذير الموقع لكن يسمح بالإرسال بدونه'}
                    </div>
                  </div>
                </div>
                {/* Toggle */}
                <label style={{ position: 'relative', display: 'inline-block', width: 52, height: 28, cursor: 'pointer', flexShrink: 0 }}>
                  <input type="checkbox" checked={draftRequireGps}
                    onChange={e => setDraftRequireGps(e.target.checked)}
                    style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{ position: 'absolute', inset: 0, background: draftRequireGps ? '#f97316' : '#e2e8f0', borderRadius: 28, transition: 'background 0.2s' }} />
                  <span style={{ position: 'absolute', top: 4, left: draftRequireGps ? 28 : 4, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
                </label>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {FEATURE_TREE.filter(n => !n.onlyRoles || n.onlyRoles.includes(detail.role)).map(node => {
                  const parentOff = node.key ? draftDisabledFeats.includes(node.key) : false;
                  const kids = (node.children ?? []).filter(c => !c.onlyRoles || c.onlyRoles.includes(detail.role));

                  const MiniToggle = ({ fKey, small }: { fKey: string; small?: boolean }) => {
                    const off = draftDisabledFeats.includes(fKey);
                    const w = small ? 40 : 48; const h = small ? 22 : 26; const ball = small ? 16 : 20;
                    return (
                      <label style={{ position: 'relative', display: 'inline-block', width: w, height: h, cursor: 'pointer', flexShrink: 0 }}>
                        <input type="checkbox" checked={!off}
                          onChange={e => {
                            if (e.target.checked) setDraftDisabledFeats(p => p.filter(k => k !== fKey));
                            else setDraftDisabledFeats(p => [...p, fKey]);
                          }}
                          style={{ opacity: 0, width: 0, height: 0 }} />
                        <span style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: off ? '#e2e8f0' : '#22c55e', borderRadius: h, transition: 'background 0.2s' }} />
                        <span style={{ position: 'absolute', top: 3, left: off ? 3 : w - ball - 3, width: ball, height: ball, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
                      </label>
                    );
                  };

                  return (
                    <div key={node.key || node.label} style={{
                      borderRadius: 12, overflow: 'hidden',
                      border: `1.5px solid ${node.key ? (parentOff ? '#fecaca' : '#bbf7d0') : '#e2e8f0'}`,
                    }}>
                      {/* ── header row ── */}
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '13px 16px',
                        background: node.key ? (parentOff ? '#fff7f7' : '#f0fdf4') : '#f8fafc',
                        borderBottom: kids.length > 0 ? '1px solid #e2e8f0' : 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 22 }}>{node.icon}</span>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>{node.label}</div>
                            {node.desc && <div style={{ fontSize: 12, color: '#64748b' }}>{node.desc}</div>}
                          </div>
                        </div>
                        {node.key
                          ? <MiniToggle fKey={node.key} />
                          : <span style={{ fontSize: 11, color: '#64748b', background: '#e2e8f0', borderRadius: 20, padding: '2px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>دائماً متاح</span>
                        }
                      </div>
                      {/* ── children rows ── */}
                      {kids.map((child, idx) => {
                        const childOff = child.key ? draftDisabledFeats.includes(child.key) : false;
                        return (
                          <div key={child.key || child.label} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '10px 16px 10px 40px',
                            background: childOff ? '#fef9f9' : '#fafffe',
                            borderBottom: idx < kids.length - 1 ? '1px solid #f1f5f9' : 'none',
                            opacity: parentOff ? 0.45 : 1, transition: 'opacity 0.2s',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13, color: '#cbd5e1', userSelect: 'none' }}>└─</span>
                              <span style={{ fontSize: 18 }}>{child.icon}</span>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{child.label}</div>
                                {child.desc && <div style={{ fontSize: 11, color: '#94a3b8' }}>{child.desc}</div>}
                              </div>
                            </div>
                            {child.key && <MiniToggle fKey={child.key} small />}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
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

  // Role colour helpers
  const ROLE_COLOR: Record<string, { bg: string; color: string }> = {
    admin:                  { bg: '#f1f5f9', color: '#475569' },
    manager:                { bg: '#f1f5f9', color: '#475569' },
    office_manager:         { bg: '#eef2ff', color: '#4f46e5' },
    office_hr:              { bg: '#f0fdfa', color: '#0d9488' },
    office_employee:        { bg: '#f8fafc', color: '#64748b' },
    company_manager:        { bg: '#f5f3ff', color: '#7c3aed' },
    supervisor:             { bg: '#eff6ff', color: '#1d4ed8' },
    product_manager:        { bg: '#e0f2fe', color: '#0369a1' },
    team_leader:            { bg: '#ecfeff', color: '#0891b2' },
    scientific_rep:         { bg: '#f0fdf4', color: '#059669' },
    commercial_supervisor:  { bg: '#fffbeb', color: '#b45309' },
    commercial_team_leader: { bg: '#fff7ed', color: '#c2410c' },
    commercial_rep:         { bg: '#fff1f2', color: '#dc2626' },
  };

  // Inline user card used inside group blocks
  const UserCard = ({ u, indent = false }: { u: UserRow; indent?: boolean }) => {
    const rc = ROLE_COLOR[u.role] ?? { bg: '#f8fafc', color: '#64748b' };
    const mgrs = u.managersOfUser ?? [];
    const mgrLabel = mgrs.length > 0
      ? mgrs.map(m => m.manager.displayName || m.manager.username).join('، ')
      : null;
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: '#fff',
        borderRadius: 10, border: '1px solid #e9eef5',
        marginRight: indent ? 28 : 0,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, cursor: 'pointer', minWidth: 0 }} onClick={() => loadDetail(u.id)}>
          {indent && <span style={{ color: '#cbd5e1', fontSize: 14, flexShrink: 0 }}>└─</span>}
          <div style={{ width: 38, height: 38, borderRadius: 10, background: rc.bg, border: `1.5px solid ${rc.color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
            {u.isActive ? '👤' : '🚫'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{u.displayName || u.username}</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>@{u.username}{u.phone ? ` · ${u.phone}` : ''}</div>
            {mgrLabel && <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 1 }}>↑ {mgrLabel}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginRight: 8 }}>
          <span style={{ background: rc.bg, color: rc.color, border: `1px solid ${rc.color}33`, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {ROLES.find(r => r.value === u.role)?.label || u.role}
          </span>
          <span style={{ background: u.isActive ? '#dcfce7' : '#fee2e2', color: u.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
            {u.isActive ? 'نشط' : 'معطل'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <button onClick={() => viewAsUser(u)} title="مراقبة" style={btnStyle('#0ea5e9', true)}>👁️</button>
          <button onClick={() => setForm({ ...u, password: '' })} style={btnStyle('#3b82f6', true)}>تعديل</button>
          <button onClick={() => toggleUser(u)} style={btnStyle(u.isActive ? '#f59e0b' : '#10b981', true)}>{u.isActive ? 'تعطيل' : 'تفعيل'}</button>
          <button onClick={() => delUser(u)} style={btnStyle('#ef4444', true)}>حذف</button>
        </div>
      </div>
    );
  };

  // Admin users = no office OR role admin/manager
  const ADMIN_ROLES = ['admin', 'manager'];
  const adminUsers   = filtered.filter(u => !u.officeId || ADMIN_ROLES.includes(u.role));
  // Office users — grouped by office, then by company
  const officeUsers  = filtered.filter(u => u.officeId && !ADMIN_ROLES.includes(u.role));

  // Build grouped structure: office → company → users
  type CompanyGroup = { company: { id: number; name: string } | null; users: UserRow[] };
  type OfficeGroup  = { office: { id: number; name: string }; companyGroups: CompanyGroup[] };

  const officeMap = new Map<number, OfficeGroup>();
  for (const u of officeUsers) {
    const oid = u.officeId!;
    if (!officeMap.has(oid)) {
      officeMap.set(oid, { office: { id: oid, name: u.office?.name || `مكتب #${oid}` }, companyGroups: [] });
    }
    const og = officeMap.get(oid)!;
    const userCompanies = u.companyAssignments ?? [];
    if (userCompanies.length === 0) {
      // No company — put in null group
      let nullGroup = og.companyGroups.find(g => g.company === null);
      if (!nullGroup) { nullGroup = { company: null, users: [] }; og.companyGroups.push(nullGroup); }
      nullGroup.users.push(u);
    } else {
      for (const ca of userCompanies) {
        let cg = og.companyGroups.find(g => g.company?.id === ca.company.id);
        if (!cg) { cg = { company: ca.company, users: [] }; og.companyGroups.push(cg); }
        if (!cg.users.find(x => x.id === u.id)) cg.users.push(u);
      }
    }
  }
  // Sort company groups: named companies first, null last
  for (const og of officeMap.values()) {
    og.companyGroups.sort((a, b) => {
      if (a.company === null) return 1;
      if (b.company === null) return -1;
      return a.company.name.localeCompare(b.company.name);
    });
  }
  const officeGroups = Array.from(officeMap.values());

  // Sort users inside a company group: managers first
  const ROLE_ORDER = ['company_manager','supervisor','product_manager','team_leader','scientific_rep','commercial_supervisor','commercial_team_leader','commercial_rep','office_manager','office_hr','office_employee'];
  const sortUsers = (list: UserRow[]) =>
    [...list].sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || a.id - b.id);

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── 1. حسابات إدارة التطبيق ────────────────────────────────── */}
          {adminUsers.length > 0 && (
            <div style={{ border: '2px solid #6366f1', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ background: 'linear-gradient(135deg,#4f46e5,#6366f1)', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>⚙️</span>
                <span style={{ fontWeight: 700, fontSize: 15, color: '#fff' }}>حسابات إدارة التطبيق</span>
                <span style={{ fontSize: 12, color: '#c7d2fe', marginRight: 'auto' }}>{adminUsers.length} حساب</span>
              </div>
              <div style={{ background: '#fafbff', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {adminUsers.map(u => <UserCard key={u.id} u={u} />)}
              </div>
            </div>
          )}

          {/* ── 2. مكاتب + شركات ───────────────────────────────────────── */}
          {officeGroups.map(og => (
            <div key={og.office.id} style={{ border: '2px solid #3b82f6', borderRadius: 14, overflow: 'hidden' }}>
              {/* Office header */}
              <div style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>🏢</span>
                <span style={{ fontWeight: 700, fontSize: 15, color: '#fff' }}>مكتب: {og.office.name}</span>
                <span style={{ fontSize: 12, color: '#bfdbfe', marginRight: 'auto' }}>
                  {officeUsers.filter(u => u.officeId === og.office.id).length} مستخدم
                </span>
              </div>

              <div style={{ background: '#f8fafc', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {og.companyGroups.map((cg, ci) => (
                  <div key={cg.company?.id ?? 'none'} style={{
                    border: `1.5px solid ${cg.company ? '#a5b4fc' : '#e2e8f0'}`,
                    borderRadius: 12, overflow: 'hidden',
                    background: '#fff',
                  }}>
                    {/* Company sub-header */}
                    <div style={{
                      background: cg.company ? '#eef2ff' : '#f1f5f9',
                      padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8,
                      borderBottom: '1px solid #e2e8f0',
                    }}>
                      <span style={{ fontSize: 16 }}>{cg.company ? '🏭' : '📌'}</span>
                      <span style={{ fontWeight: 700, fontSize: 13, color: cg.company ? '#4338ca' : '#64748b' }}>
                        {cg.company ? cg.company.name : 'بدون شركة'}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 'auto' }}>{cg.users.length} مستخدم</span>
                    </div>
                    {/* Users sorted by role */}
                    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {sortUsers(cg.users).map((u, ui) => <UserCard key={`${u.id}-${ci}`} u={u} indent={ui > 0} />)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>لا توجد نتائج</div>
          )}
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
