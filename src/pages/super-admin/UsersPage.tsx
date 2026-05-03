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
      { key: 'archive_tab',        label: 'أرشيف السيرفي',             icon: '📚', desc: 'تبويب أرشيف يدوي مستقل لتتبع أطباء السيرفي'    },
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
      { key: 'currency_convert', label: 'تحويل العملة في التحليل', icon: '💱', desc: 'تحويل أسعار الملفات من الدينار إلى الدولار عند التحليل — يُضبط لكل ملف على حدة', onlyRoles: REP_ROLES },
    ],
  },
  // ── 7. سيرفي اوردين
  { key: 'master_survey', label: 'سيرفي اوردين', icon: '🗂️', desc: 'صفحة سيرفي اوردين — الاطلاع على قوائم الأطباء والصيدليات المركزية' },
  // ── 8. تحليل مبيعات الموزعين
  { key: 'distributor_sales', label: 'تحليل مبيعات الموزعين', icon: '📦', desc: 'رفع وتحليل ملفات Excel بتنسيق امازون / فريق — شهر3 / شهر4 / اعادة الفوترة' },
  // ── 9. بيانات المبيعات (Sales Data — ستوك المخازن)
  {
    key: 'sales_data', label: 'بيانات المبيعات', icon: '📊',
    desc: 'صفحة تحليل ستوكات المخازن — رفع ملفات Excel وعرض الجداول والتحليل',
    children: [
      { key: 'sales_data_upload',    label: 'رفع ملف / استيراد',           icon: '📥', desc: 'زر استيراد ملف Excel جديد وإضافته للقائمة'            },
      { key: 'sales_data_delete',    label: 'حذف الملف',                    icon: '🗑️', desc: 'حذف الملف من القائمة والخادم'                          },
      { key: 'sales_data_merge',     label: 'دمج الملفات',                  icon: '🔗', desc: 'دمج ملفين أو أكثر في ملف موحد'                         },
      { key: 'sales_data_export',    label: 'تصدير (Excel / Word / صورة)', icon: '⬇️', desc: 'قائمة تصدير الجدول بصيغ Excel وWord والصورة'          },
      { key: 'sales_data_shortage',  label: 'رادار النقص',                  icon: '🔴', desc: 'عرض الأصناف الناقصة أو المنعدمة في المخازن'            },
      { key: 'sales_data_classify',  label: 'تصنيف المذاخر (A/B/C)',       icon: '🏷️', desc: 'رفع ملف تصنيف المذاخر وتفعيل ألوان A/B/C على الجدول'  },
      { key: 'sales_data_value',     label: 'عرض القيمة المالية',           icon: '💰', desc: 'زر تبديل عرض الكميات ↔ القيم المالية'                 },
      { key: 'sales_data_analysis',  label: 'تبويب التحليل',               icon: '📈', desc: 'تبويب التحليل البياني حسب المنطقة والمخزن'             },
    ],
  },
  // ── 10. قائمة المستخدمين
  { key: 'users_list', label: 'قائمة المستخدمين',        icon: '👥', desc: 'صفحة عرض وإدارة قائمة المستخدمين'   },
  // ── 8. قائمة الطلبات (السيرفي)
  { key: 'wish_list',  label: 'قائمة الطلبات (السيرفي)', icon: '📋', desc: 'خاصية عرض قائمة الأطباء المستهدفين' },
  // ── 9. تبديل الحساب
  { key: 'switch_account', label: 'تبديل الحساب (Switch Account)', icon: '⇄', desc: 'زر في الشريط الجانبي لتبديل الحسابات المحفوظة بدون تسجيل خروج' },
  // ── 11. التارگت الشهري
  { key: 'targets_tab', label: '🎯 التارگت الشهري', icon: '🎯', desc: 'تبويب إدارة التارگت الشهري للمندوبين العلميين والتجاريين ومقارنته بالمبيعات' },
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
  const { token, logout } = useSuperAdmin();
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
  const [tab,       setTab]       = useState<'info'|'companies'|'lines'|'items'|'areas'|'managers'|'features'>(() => {
    const saved = localStorage.getItem('sa_user_tab');
    return (saved as any) || 'info';
  });
  const [search,    setSearch]    = useState('');

  // ── Draft assignment states (must be at top level — Rules of Hooks) ──────
  const [draftCompanyIds,    setDraftCompanyIds]    = useState<number[]>([]);
  const [draftLineIds,       setDraftLineIds]       = useState<number[]>([]);
  const [draftItemIds,       setDraftItemIds]       = useState<number[]>([]);
  const [draftAreaIds,       setDraftAreaIds]       = useState<number[]>([]);
  const [draftMgrIds,        setDraftMgrIds]        = useState<number[]>([]);
  const [itemSearch,         setItemSearch]         = useState('');
  const [areaSearch,         setAreaSearch]         = useState('');
  const [draftDisabledFeats, setDraftDisabledFeats] = useState<string[]>([]);
  const [featSection,        setFeatSection]        = useState<string>('gps');
  const [draftRequireGps,    setDraftRequireGps]    = useState(true);
  const [draftDoctorFilter,  setDraftDoctorFilter]  = useState<{ byArea: boolean; planMode: string; surveyOnly: boolean }>({ byArea: true, planMode: 'plan_and_all', surveyOnly: false });
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

  // Persist detail user + tab to localStorage
  useEffect(() => {
    if (detail) localStorage.setItem('sa_user_detail_id', String(detail.id));
    else localStorage.removeItem('sa_user_detail_id');
  }, [detail?.id]);
  useEffect(() => { localStorage.setItem('sa_user_tab', tab); }, [tab]);

  // Restore detail view on mount (page refresh)
  useEffect(() => {
    const savedId = localStorage.getItem('sa_user_detail_id');
    if (savedId && !jumpUserId) {
      const id = parseInt(savedId);
      if (id > 0) {
        fetch(`/api/sa/users/${id}`, { headers: H() }).then(r => r.json()).then(d => {
          if (d.success) setDetail(d.data);
        });
        loadRefs();
      }
    }
  }, []);

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
      setDraftDoctorFilter({
        byArea: p.doctorFilterByArea !== false,
        planMode: p.doctorFilterPlanMode || 'plan_and_all',
        surveyOnly: p.doctorFilterSurveyOnly === true,
      });
    } catch { setDraftDisabledFeats([]); setDraftRequireGps(true); setDraftDoctorFilter({ byArea: true, planMode: 'plan_and_all', surveyOnly: false }); }
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
        localStorage.setItem('sa_user_tab', 'info');
        // Scroll to top of detail view
        requestAnimationFrame(() => { const m = getMainEl(); if (m) m.scrollTop = 0; });
      }
    });
    loadRefs();
  };

  const goBack = () => {
    setDetail(null);
    localStorage.removeItem('sa_user_detail_id');
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
    if (!res.ok) {
      if (res.status === 401) {
        setError('انتهت صلاحية جلسة السوبر أدمن — يرجى تسجيل الخروج وإعادة الدخول');
        logout();
      } else {
        setError(d.error || 'خطأ');
      }
      setSaving(false); return;
    }
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
      if (type === 'areas') window.dispatchEvent(new Event('areas-changed'));
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
        method: 'PUT', headers: H(), body: JSON.stringify({
          disabledFeatures: draftDisabledFeats,
          requireGps: draftRequireGps,
          doctorFilterByArea: draftDoctorFilter.byArea,
          doctorFilterPlanMode: draftDoctorFilter.planMode,
          doctorFilterSurveyOnly: draftDoctorFilter.surveyOnly,
        }),
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
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftCompanyIds(companies.map(c => c.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftCompanyIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {companies.map(c => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={draftCompanyIds.includes(c.id)} onChange={e => setDraftCompanyIds(e.target.checked ? [...draftCompanyIds, c.id] : draftCompanyIds.filter(x => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('companies', draftCompanyIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'lines' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftLineIds(lines.map(l => l.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftLineIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {lines.map(l => (
                  <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={draftLineIds.includes(l.id)} onChange={e => setDraftLineIds(e.target.checked ? [...draftLineIds, l.id] : draftLineIds.filter(x => x !== l.id))} />
                    {l.name || `لاين #${l.id}`}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('lines', draftLineIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'items' && (
            <div>
              <input
                type="text"
                placeholder="🔍 بحث عن ايتم..."
                value={itemSearch}
                onChange={e => setItemSearch(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftItemIds(items.map(i => i.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftItemIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {items.filter(i => !itemSearch || i.name.toLowerCase().includes(itemSearch.toLowerCase())).map(i => (
                  <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={draftItemIds.includes(i.id)} onChange={e => setDraftItemIds(e.target.checked ? [...draftItemIds, i.id] : draftItemIds.filter(x => x !== i.id))} />
                    {i.name}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('items', draftItemIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'areas' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button
                  disabled={saving}
                  onClick={async () => {
                    if (!confirm('سيتم مسح المناطق الموجودة وإعادة تحميلها من السيرفي الرئيسي. هل أنت متأكد؟')) return;
                    setSaving(true);
                    try {
                      const r = await fetch('/api/sa/areas/reset-from-survey', { method: 'POST', headers: H() });
                      const j = await r.json();
                      if (j.success) {
                        setAreas(j.data);
                        setDraftAreaIds(prev => prev.filter(id => j.data.some((a: any) => a.id === id)));
                        alert(`✅ تم التحديث — ${j.count} منطقة من السيرفي`);
                      } else {
                        alert('❌ ' + j.error);
                      }
                    } finally { setSaving(false); }
                  }}
                  style={{ ...btnStyle('#7c3aed', true), fontSize: 12, padding: '4px 14px' }}
                >
                  {saving ? '...' : '🔄 تحديث من السيرفي'}
                </button>
              </div>
              <input
                type="text"
                placeholder="🔍 بحث عن منطقة..."
                value={areaSearch}
                onChange={e => setAreaSearch(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftAreaIds(areas.map(a => a.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftAreaIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {areas.filter(a => !areaSearch || a.name.toLowerCase().includes(areaSearch.toLowerCase())).map(a => (
                  <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={draftAreaIds.includes(a.id)} onChange={e => setDraftAreaIds(e.target.checked ? [...draftAreaIds, a.id] : draftAreaIds.filter(x => x !== a.id))} />
                    {a.name}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('areas', draftAreaIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'managers' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftMgrIds(users.filter(u => u.id !== detail.id).map(u => u.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftMgrIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {users.filter(u => u.id !== detail.id).map(u => (
                  <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={draftMgrIds.includes(u.id)} onChange={e => setDraftMgrIds(e.target.checked ? [...draftMgrIds, u.id] : draftMgrIds.filter(x => x !== u.id))} />
                    {u.displayName || u.username} ({ROLES.find(r => r.value === u.role)?.label || u.role})
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => saveAssignment('managers', draftMgrIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'features' && (() => {
            // ── helpers ──────────────────────────────────────────────────────
            const getNodeStatus = (node: FeatureNode): 'always' | 'on' | 'partial' | 'off' => {
              const allKeys: string[] = [];
              if (node.key) allKeys.push(node.key);
              for (const c of node.children ?? []) { if (c.key) allKeys.push(c.key); }
              if (allKeys.length === 0) return 'always';
              const disabled = allKeys.filter(k => draftDisabledFeats.includes(k)).length;
              if (disabled === 0) return 'on';
              if (disabled === allKeys.length) return 'off';
              return 'partial';
            };

            const MiniToggle = ({ fKey, size = 'md' }: { fKey: string; size?: 'sm' | 'md' | 'lg' }) => {
              const off = draftDisabledFeats.includes(fKey);
              const dims = size === 'lg' ? { w: 56, h: 30, ball: 22 } : size === 'sm' ? { w: 38, h: 22, ball: 16 } : { w: 46, h: 26, ball: 20 };
              return (
                <label style={{ position: 'relative', display: 'inline-block', width: dims.w, height: dims.h, cursor: 'pointer', flexShrink: 0 }}>
                  <input type="checkbox" checked={!off}
                    onChange={e => {
                      if (e.target.checked) setDraftDisabledFeats(p => p.filter(k => k !== fKey));
                      else setDraftDisabledFeats(p => [...p, fKey]);
                    }}
                    style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{ position: 'absolute', inset: 0, background: off ? '#e2e8f0' : '#22c55e', borderRadius: dims.h, transition: 'background 0.2s' }} />
                  <span style={{ position: 'absolute', top: (dims.h - dims.ball) / 2, left: off ? (dims.h - dims.ball) / 2 : dims.w - dims.ball - (dims.h - dims.ball) / 2, width: dims.ball, height: dims.ball, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
                </label>
              );
            };

            const visibleNodes = FEATURE_TREE.filter(n => !n.onlyRoles || n.onlyRoles.includes(detail.role));
            const activeNode   = visibleNodes.find(n => (n.key || n.label) === featSection) ?? null;

            const SidebarBtn = ({ id, icon, label, dot }: { id: string; icon: string; label: string; dot?: { color: string } | null }) => (
              <button
                onClick={() => setFeatSection(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '10px 12px', border: 'none', cursor: 'pointer', direction: 'rtl',
                  borderRadius: 8, marginBottom: 2,
                  background: featSection === id ? 'rgba(99,102,241,0.18)' : 'transparent',
                  color: featSection === id ? '#c7d2fe' : '#94a3b8',
                  borderRight: `3px solid ${featSection === id ? '#6366f1' : 'transparent'}`,
                  transition: 'all 0.12s',
                }}
              >
                <span style={{ fontSize: 17, flexShrink: 0 }}>{icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1, textAlign: 'right', lineHeight: 1.3 }}>{label}</span>
                {dot
                  ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot.color, flexShrink: 0 }} />
                  : <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.08)', color: '#64748b', borderRadius: 4, padding: '1px 5px', flexShrink: 0, whiteSpace: 'nowrap' }}>دائماً</span>
                }
              </button>
            );

            const DOT_COLOR: Record<string, string> = { on: '#22c55e', partial: '#f59e0b', off: '#ef4444' };

            return (
              <div style={{ display: 'flex', borderRadius: 12, overflow: 'hidden', border: '1.5px solid #e2e8f0', minHeight: 520 }}>

                {/* ════ LEFT SIDEBAR ════ */}
                <div style={{ width: 210, background: '#0f172a', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                  {/* Brand header */}
                  <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', letterSpacing: 1.2, textTransform: 'uppercase' }}>صلاحيات المستخدم</div>
                    <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>{detail.displayName || detail.username}</div>
                  </div>

                  {/* Settings section */}
                  <div style={{ padding: '10px 8px 4px' }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: '#334155', padding: '0 4px 6px', letterSpacing: 1.2, textTransform: 'uppercase' }}>الإعدادات</div>
                    <SidebarBtn id="gps"           icon="📍" label="GPS / الموقع"  dot={{ color: draftRequireGps ? '#f97316' : '#22c55e' }} />
                    <SidebarBtn id="doctor_filter" icon="🔍" label="فلتر الأطباء"  dot={{ color: '#6366f1' }} />
                  </div>

                  {/* Divider */}
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 12px' }} />

                  {/* Features section */}
                  <div style={{ padding: '6px 8px', flex: 1, overflowY: 'auto' }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: '#334155', padding: '0 4px 6px', letterSpacing: 1.2, textTransform: 'uppercase' }}>الميزات</div>
                    {visibleNodes.map(node => {
                      const st = getNodeStatus(node);
                      return (
                        <SidebarBtn
                          key={node.key || node.label}
                          id={node.key || node.label}
                          icon={node.icon}
                          label={node.label}
                          dot={st === 'always' ? null : { color: DOT_COLOR[st] }}
                        />
                      );
                    })}
                  </div>

                  {/* Save button */}
                  <div style={{ padding: '12px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <button onClick={saveFeatures} disabled={saving}
                      style={{ width: '100%', padding: '9px', borderRadius: 8, border: 'none', cursor: saving ? 'wait' : 'pointer', background: '#6366f1', color: '#fff', fontWeight: 700, fontSize: 12 }}>
                      {saving ? '...' : '💾 حفظ التغييرات'}
                    </button>
                  </div>
                </div>

                {/* ════ RIGHT CONTENT ════ */}
                <div style={{ flex: 1, overflowY: 'auto', background: '#f8fafc', padding: '22px 24px' }}>

                  {/* ── GPS ── */}
                  {featSection === 'gps' && (
                    <div>
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>📍 إلزام الموقع الجغرافي</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>تحديد ما إذا كان المستخدم ملزماً بتفعيل GPS عند إرسال التقارير</div>
                      </div>
                      <div style={{
                        borderRadius: 14, border: `2px solid ${draftRequireGps ? '#f97316' : '#e2e8f0'}`,
                        background: draftRequireGps ? '#fff7ed' : '#fff',
                        padding: '18px 20px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div style={{ width: 52, height: 52, borderRadius: 14, background: draftRequireGps ? '#fed7aa' : '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>📍</div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>إلزام تفعيل الموقع الجغرافي</div>
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                              {draftRequireGps ? '🔴 مفعّل — لا يستطيع الإرسال بدون GPS' : '🟢 معطّل — يُظهر تحذير لكن يسمح بالإرسال'}
                            </div>
                          </div>
                        </div>
                        <label style={{ position: 'relative', display: 'inline-block', width: 56, height: 30, cursor: 'pointer', flexShrink: 0 }}>
                          <input type="checkbox" checked={draftRequireGps} onChange={e => setDraftRequireGps(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                          <span style={{ position: 'absolute', inset: 0, background: draftRequireGps ? '#f97316' : '#e2e8f0', borderRadius: 30, transition: 'background 0.2s' }} />
                          <span style={{ position: 'absolute', top: 5, left: draftRequireGps ? 31 : 5, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
                        </label>
                      </div>
                    </div>
                  )}

                  {/* ── Doctor Filter ── */}
                  {featSection === 'doctor_filter' && (
                    <div>
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>🔍 فلتر بحث الأطباء</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>تحديد أي أطباء تظهر في البحث لهذا المستخدم عند تسجيل الزيارة</div>
                      </div>

                      <div style={{ borderRadius: 14, border: '2px solid #6366f1', background: '#eef2ff', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {/* Filter by Area */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 20 }}>📍</span>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>فلتر حسب المناطق</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>عرض فقط أطباء المناطق المعيّنة للمستخدم</div>
                            </div>
                          </div>
                          <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, cursor: 'pointer', flexShrink: 0 }}>
                            <input type="checkbox" checked={draftDoctorFilter.byArea} onChange={e => setDraftDoctorFilter(p => ({ ...p, byArea: e.target.checked }))} style={{ opacity: 0, width: 0, height: 0 }} />
                            <span style={{ position: 'absolute', inset: 0, background: draftDoctorFilter.byArea ? '#6366f1' : '#e2e8f0', borderRadius: 24, transition: 'background 0.2s' }} />
                            <span style={{ position: 'absolute', top: 3, left: draftDoctorFilter.byArea ? 23 : 3, width: 18, height: 18, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
                          </label>
                        </div>

                        {/* Plan Mode */}
                        <div style={{ padding: '12px 14px', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <span style={{ fontSize: 20 }}>📅</span>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>فلتر البلان الشهري</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>تحديد علاقة نتائج البحث بالبلان الشهري</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 28 }}>
                            {[
                              { value: 'plan_only',    label: 'فقط أطباء البلان',        desc: 'يظهر فقط الأطباء الموجودين في البلان الشهري الحالي' },
                              { value: 'plan_and_all', label: 'أطباء البلان + الباقي',   desc: 'أطباء البلان أولاً ثم جميع الأطباء (الافتراضي)' },
                              { value: 'all',          label: 'جميع الأطباء',            desc: 'عرض كل الأطباء بدون تمييز بلان' },
                            ].map(opt => (
                              <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: draftDoctorFilter.planMode === opt.value ? '#eef2ff' : 'transparent', border: draftDoctorFilter.planMode === opt.value ? '1px solid #c7d2fe' : '1px solid transparent' }}>
                                <input type="radio" name="planMode" value={opt.value} checked={draftDoctorFilter.planMode === opt.value} onChange={() => setDraftDoctorFilter(p => ({ ...p, planMode: opt.value }))} style={{ marginTop: 2, accentColor: '#6366f1' }} />
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: 12, color: '#1e293b' }}>{opt.label}</div>
                                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{opt.desc}</div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* Survey Filter */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 20 }}>🏥</span>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>فقط أطباء السيرفي</div>
                              <div style={{ fontSize: 11, color: '#94a3b8' }}>عرض فقط الأطباء المسجلين في الماستر سيرفي</div>
                            </div>
                          </div>
                          <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, cursor: 'pointer', flexShrink: 0 }}>
                            <input type="checkbox" checked={draftDoctorFilter.surveyOnly} onChange={e => setDraftDoctorFilter(p => ({ ...p, surveyOnly: e.target.checked }))} style={{ opacity: 0, width: 0, height: 0 }} />
                            <span style={{ position: 'absolute', inset: 0, background: draftDoctorFilter.surveyOnly ? '#6366f1' : '#e2e8f0', borderRadius: 24, transition: 'background 0.2s' }} />
                            <span style={{ position: 'absolute', top: 3, left: draftDoctorFilter.surveyOnly ? 23 : 3, width: 18, height: 18, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
                          </label>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Feature Node ── */}
                  {activeNode && (() => {
                    const kids = (activeNode.children ?? []).filter(c => !c.onlyRoles || c.onlyRoles.includes(detail.role));
                    const parentOff = activeNode.key ? draftDisabledFeats.includes(activeNode.key) : false;
                    return (
                      <div>
                        {/* Node header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 }}>
                          <div style={{ width: 58, height: 58, borderRadius: 16, background: parentOff ? '#fee2e2' : '#f0fdf4', border: `2px solid ${parentOff ? '#fca5a5' : '#bbf7d0'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, flexShrink: 0 }}>
                            {activeNode.icon}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>{activeNode.label}</div>
                            {activeNode.desc && <div style={{ fontSize: 12, color: '#64748b' }}>{activeNode.desc}</div>}
                            {parentOff && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4, fontWeight: 600 }}>⛔ هذه الصفحة / الميزة معطّلة بالكامل</div>}
                          </div>
                          {activeNode.key
                            ? <MiniToggle fKey={activeNode.key} size="lg" />
                            : <span style={{ background: '#e2e8f0', color: '#475569', borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 700 }}>دائماً متاح</span>
                          }
                        </div>

                        {/* Children */}
                        {kids.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 4, paddingRight: 4 }}>الميزات الفرعية</div>
                            {kids.map(child => {
                              const childOff = child.key ? draftDisabledFeats.includes(child.key) : false;
                              return (
                                <div key={child.key || child.label} style={{
                                  display: 'flex', alignItems: 'center', gap: 14,
                                  padding: '12px 16px',
                                  background: childOff ? '#fff5f5' : '#fff',
                                  border: `1.5px solid ${childOff ? '#fca5a5' : '#e2e8f0'}`,
                                  borderRadius: 12,
                                  opacity: parentOff ? 0.45 : 1,
                                  transition: 'all 0.15s',
                                }}>
                                  <div style={{ width: 40, height: 40, borderRadius: 11, background: childOff ? '#fee2e2' : '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>
                                    {child.icon}
                                  </div>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{child.label}</div>
                                    {child.desc && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{child.desc}</div>}
                                  </div>
                                  {child.key && <MiniToggle fKey={child.key} size="sm" />}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {kids.length === 0 && (
                          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '48px 0', background: '#fff', borderRadius: 12, border: '1.5px solid #e2e8f0' }}>
                            لا توجد ميزات فرعية — يمكن تفعيل / تعطيل هذه الميزة من الزر أعلاه
                          </div>
                        )}
                      </div>
                    );
                  })()}

                </div>
              </div>
            );
          })()}
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
