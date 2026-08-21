import { useState, useEffect, useRef } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';
import { getVisiblePageNodes, STANDALONE_FEATURES } from '../../config/featureConfig';
import type { FeatureNode } from '../../config/featureConfig';

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

// ملاحظة: شجرة الميزات (FEATURE_TREE) أصبحت مبنية تلقائياً من src/config/featureConfig.ts —
// نفس الملف الذي يبني منه القائمة الجانبية الحقيقية (Sidebar.tsx)، فأي صفحة جديدة تُضاف
// إلى NAV_ITEMS هناك تظهر هنا تلقائياً بنفس الاسم والأيقونة دون أي تعديل في هذا الملف.
// الميزات الفرعية (تبويب/زر داخل صفحة) لا تزال تُضاف يدوياً في PAGE_CHILDREN هناك.

interface Office   { id: number; name: string; }
interface Company  { id: number; name: string; officeId: number; }
interface Line     { id: number; name?: string; companyId: number; }
interface Item     { id: number; name: string; companyId?: number | null; companyName?: string; }
interface Area     { id: number; name: string; provinceId?: number | null; provinceConflict?: string | null; subProvinceId?: number | null; }
interface Province { id: number; name: string; sortOrder?: number; areaCount?: number; }
interface SubProvince { id: number; name: string; provinceId: number; sortOrder?: number; areaCount?: number; }
interface UserRow  {
  id: number; username: string; displayName?: string; role: string; phone?: string;
  isActive: boolean; officeId?: number; office?: { id: number; name: string };
  permissions?: string | null;
  _count?: { companyAssignments: number; areas: number; };
  companyAssignments?: { companyId: number; isPrimary?: boolean; company: { id: number; name: string } }[];
  managersOfUser?:     { managerId: number; manager: { id: number; username: string; displayName?: string } }[];
}
interface UserDetail extends UserRow {
  linkedRepId?: number | null;
  linkedRep?:   { id: number; name: string } | null;
  companyAssignments: { companyId: number; isPrimary?: boolean; company: { id: number; name: string } }[];
  lineAssignments:    { lineId: number;    line:    { name?: string; companyId: number } }[];
  itemAssignments:    { itemId: number;    item:    { name: string } }[];
  areaAssignments:    { areaId: number;    area:    { name: string } }[];
  provinceAssignments?: { provinceId: number; province: { id: number; name: string } }[];
  subProvinceAssignments?: { subProvinceId: number; subProvince: { id: number; name: string; provinceId: number } }[];
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
  const [provinces, setProvinces] = useState<Province[]>([]);
  const [subProvinces, setSubProvinces] = useState<SubProvince[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);
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
  const [draftPrimaryCompanyId, setDraftPrimaryCompanyId] = useState<number | null>(null);
  const [draftLineIds,       setDraftLineIds]       = useState<number[]>([]);
  const [draftItemIds,       setDraftItemIds]       = useState<number[]>([]);
  const [draftAreaIds,       setDraftAreaIds]       = useState<number[]>([]);
  // تعيين المحافظة ديناميكي: يُحفظ كمحافظة لا كقائمة مناطق، فتدخل نطاقَ
  // المستخدم تلقائياً أي منطقة تُضاف لها لاحقاً.
  const [draftProvinceIds,   setDraftProvinceIds]   = useState<number[]>([]);
  const [draftSubProvinceIds, setDraftSubProvinceIds] = useState<number[]>([]);
  const [collapsedProvinces, setCollapsedProvinces] = useState<Set<string>>(new Set());
  const [bulkTargetProvince, setBulkTargetProvince] = useState<number | ''>('');
  const [bulkTargetSub,      setBulkTargetSub]      = useState<number | ''>('');
  // أي صف منطقة مفتوح له منتقي المحافظة السريع الآن (بدل عرض قائمة منسدلة
  // بكل صف دائماً — كانت تُثقّل القائمة بصرياً مع مئات المناطق)
  const [openProvincePicker,  setOpenProvincePicker]  = useState<number | null>(null);
  const [draftMgrIds,        setDraftMgrIds]        = useState<number[]>([]);
  const [itemSearch,         setItemSearch]         = useState('');
  const [areaSearch,         setAreaSearch]         = useState('');
  const [mergeSugs,          setMergeSugs]          = useState<{ a: { id: number; name: string; sales: number }; b: { id: number; name: string; sales: number } }[] | null>(null);
  const [mergeBusy,          setMergeBusy]          = useState(false);
  // ── Area CRUD (manual add / rename / delete) ──────────────────────────────
  const [newAreaName,        setNewAreaName]        = useState('');
  const [editingAreaId,      setEditingAreaId]      = useState<number | null>(null);
  const [editingAreaName,    setEditingAreaName]    = useState('');
  const [areaCrudBusy,       setAreaCrudBusy]       = useState(false);
  const [deleteAreaInfo,     setDeleteAreaInfo]     = useState<{ id: number; name: string; usage: Record<string, number>; total: number; blocking: boolean } | null>(null);
  const [deleteTransferTo,   setDeleteTransferTo]   = useState<number | ''>('');
  const [draftDisabledFeats, setDraftDisabledFeats] = useState<string[]>([]);
  const [featSection,        setFeatSection]        = useState<string>(() => localStorage.getItem('sa_user_feat_section') || 'gps');
  const [draftRequireGps,    setDraftRequireGps]    = useState(true);
  const [draftDoctorFilter,  setDraftDoctorFilter]  = useState<{ byArea: boolean; planMode: string; surveyOnly: boolean }>({ byArea: true, planMode: 'plan_and_all', surveyOnly: false });
  const [draftDisableActLog, setDraftDisableActLog] = useState(false);
  const [repInfoData,        setRepInfoData]        = useState<any | null>(null);

  const load = (restoreScroll = false) => {
    const scrollPos = restoreScroll ? (getMainEl()?.scrollTop ?? 0) : 0;
    setLoading(true);
    Promise.all([
      fetch('/api/sa/users',     { headers: H() }).then(r => r.json()),
      fetch('/api/sa/offices',   { headers: H() }).then(r => r.json()),
      fetch('/api/sa/companies', { headers: H() }).then(r => r.json()),
    ]).then(([u, o, c]) => {
      if (u.success) setUsers(u.data);
      if (o.success) setOffices(o.data);
      if (c.success) setCompanies(c.data);
    }).finally(() => {
      setLoading(false);
      if (restoreScroll) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const m = getMainEl();
          if (m) m.scrollTop = scrollPos;
        }));
      }
    });
  };

  const loadRefs = async () => {
    setRefsLoading(true);
    try {
      // ملاحظة: قائمة الايتمات لم تعد تُحمَّل هنا عمومياً — صارت مقيّدة بشركات المستخدم
      // وتُحمَّل لكل مستخدم على حدة عبر /api/sa/users/:id/company-items (تأثير detail?.id).
      const [li, ar, pr, sp] = await Promise.all([
        fetch('/api/sa/companies/all-lines', { headers: H() }).then(r => r.json()),
        fetch('/api/sa/areas',  { headers: H() }).then(r => r.json()),
        fetch('/api/sa/provinces', { headers: H() }).then(r => r.json()),
        fetch('/api/sa/sub-provinces', { headers: H() }).then(r => r.json()),
      ]);
      if (li.success) setLines(li.data);
      if (ar.success) setAreas(ar.data);
      if (pr.success) setProvinces(pr.data);
      if (sp.success) setSubProvinces(sp.data);
    } finally {
      setRefsLoading(false);
    }
  };

  useEffect(load, []);

  // Persist detail user + tab to localStorage
  useEffect(() => {
    if (detail) localStorage.setItem('sa_user_detail_id', String(detail.id));
    else localStorage.removeItem('sa_user_detail_id');
  }, [detail?.id]);
  useEffect(() => { localStorage.setItem('sa_user_tab', tab); }, [tab]);
  useEffect(() => { localStorage.setItem('sa_user_feat_section', featSection); }, [featSection]);

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

  // ايتمات كتالوج الشركات المعيّنة للمستخدم (تُغذّي تبويب «الايتمات»)
  const loadCompanyItems = (userId: number) => {
    fetch(`/api/sa/users/${userId}/company-items`, { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setItems(d.data); })
      .catch(() => {});
  };

  // Reset drafts whenever detail changes
  useEffect(() => {
    if (!detail) { setItems([]); return; }
    loadCompanyItems(detail.id);
    setDraftCompanyIds(detail.companyAssignments.map(a => a.companyId));
    setDraftPrimaryCompanyId(detail.companyAssignments.find(a => a.isPrimary)?.companyId ?? detail.companyAssignments[0]?.companyId ?? null);
    setDraftLineIds(detail.lineAssignments.map(a => a.lineId));
    setDraftItemIds(detail.itemAssignments.map(a => a.itemId));
    setDraftAreaIds(detail.areaAssignments.map(a => a.areaId));
    setDraftProvinceIds((detail.provinceAssignments ?? []).map(p => p.provinceId));
    setDraftSubProvinceIds((detail.subProvinceAssignments ?? []).map(s => s.subProvinceId));
    setDraftMgrIds(detail.managersOfUser.map(a => a.managerId));
    try {
      const p = JSON.parse(detail.permissions || '{}');
      setDraftDisabledFeats(p.disabledFeatures ?? []);
      setDraftRequireGps(p.requireGps !== false);
      setDraftDisableActLog(p.disableActivityLog === true);
      setDraftDoctorFilter({
        byArea: p.doctorFilterByArea !== false,
        planMode: p.doctorFilterPlanMode || 'plan_and_all',
        surveyOnly: p.doctorFilterSurveyOnly === true,
      });
    } catch { setDraftDisabledFeats([]); setDraftRequireGps(true); setDraftDisableActLog(false); setDraftDoctorFilter({ byArea: true, planMode: 'plan_and_all', surveyOnly: false }); }
  }, [detail?.id]);

  // طيّ افتراضي عند فتح مستخدم: نطوي كل مجموعة (محافظة أو «غير محدد») لا صلة لها
  // بهذا المستخدم، ونُبقي مفتوحاً فقط ما يخصّه فعلاً — بدل عرض ~19 مجموعة/مئات
  // الصفوف دفعة واحدة (كان هذا سبب الازدحام والتشوّش في العرض). لا يعيد الطيّ
  // عند كل تحديث بيانات (مثل الحفظ) — فقط عند تبديل المستخدم نفسه.
  useEffect(() => {
    if (!detail || areas.length === 0) return;
    const committedAreaIds = new Set(detail.areaAssignments.map(a => a.areaId));
    const committedProvinceIds = new Set((detail.provinceAssignments ?? []).map(p => p.provinceId));
    const relevantKeys = new Set<string>();
    for (const a of areas) {
      if (!committedAreaIds.has(a.id)) continue;
      relevantKeys.add(a.provinceId != null ? String(a.provinceId) : 'none');
    }
    for (const pid of committedProvinceIds) relevantKeys.add(String(pid));

    const toCollapse = new Set<string>();
    for (const p of provinces) if (!relevantKeys.has(String(p.id))) toCollapse.add(String(p.id));
    if (!relevantKeys.has('none')) toCollapse.add('none');

    // مستوى الأقسام: اطوِ أي قسم لا منطقة مُعيَّنة فيه ولا هو معيَّن بذاته،
    // كي لا تنفتح كرخ ورصافة معاً بمئات الصفوف حين يخصّ المستخدمَ جانبٌ واحد.
    const committedSubIds = new Set((detail.subProvinceAssignments ?? []).map(s => s.subProvinceId));
    const relevantSubKeys = new Set<string>();
    for (const a of areas) {
      if (!committedAreaIds.has(a.id)) continue;
      const pKey = a.provinceId != null ? String(a.provinceId) : 'none';
      relevantSubKeys.add(pKey + ':' + (a.subProvinceId != null ? String(a.subProvinceId) : 'direct'));
    }
    for (const s of subProvinces) {
      const key = String(s.provinceId) + ':' + String(s.id);
      const wholeProvince = committedProvinceIds.has(s.provinceId);
      if (!wholeProvince && !committedSubIds.has(s.id) && !relevantSubKeys.has(key)) toCollapse.add(key);
    }
    setCollapsedProvinces(toCollapse);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, areas.length, provinces.length, subProvinces.length]);

  const loadDetail = (id: number, opts: { keepTab?: boolean } = {}) => {
    // Save current scroll position before entering detail
    const main = getMainEl();
    if (main) savedScrollRef.current = main.scrollTop;
    setRepInfoData(null);
    fetch(`/api/sa/users/${id}`, { headers: H() }).then(r => r.json()).then(d => {
      if (d.success) {
        setDetail(d.data);
        if (!opts.keepTab) {
          setTab('info');
          localStorage.setItem('sa_user_tab', 'info');
          // Scroll to top of detail view
          requestAnimationFrame(() => { const m = getMainEl(); if (m) m.scrollTop = 0; });
        }
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
    if (!isEdit && form.companyId && d.data?.id) {
      await fetch(`/api/sa/users/${d.data.id}/companies`, {
        method: 'PUT', headers: H(), body: JSON.stringify({ companyIds: [form.companyId], primaryCompanyId: form.companyId }),
      });
    }
    setSaving(false); setForm(null); load(true);
    if (detail?.id === form.id) loadDetail(form.id);
  };

  // Lightweight toast for save feedback
  const showToast = (msg: string, color: string = '#16a34a') => {
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
  };

  // حفظ المحافظات — مستقل عن المناطق: المحافظة لا تُسطَّح إلى مناطق، بل تبقى
  // تعييناً يُوسَّع وقت الاستعلام (راجع server/lib/areaScope.js).
  const saveProvinces = async (ids: number[]) => {
    if (!detail) return false;
    const res = await fetch(`/api/sa/users/${detail.id}/provinces`, {
      method: 'PUT', headers: H(), body: JSON.stringify({ provinceIds: ids }),
    });
    if (!res.ok) {
      if (res.status === 401) { showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626'); logout(); return false; }
      let errMsg = 'فشل حفظ المحافظات';
      try { const j = await res.json(); if (j?.error) errMsg = j.error; } catch {}
      showToast('❌ ' + errMsg, '#dc2626');
      return false;
    }
    return true;
  };

  // زر «حفظ التغييرات» في تبويب المناطق يحفظ الاثنين معاً بترتيب ثابت:
  // المحافظات أولاً، فإن فشلت لا نحفظ المناطق ونترك الحالة كما هي.
  const saveSubProvinces = async (ids: number[]) => {
    if (!detail) return false;
    const res = await fetch(`/api/sa/users/${detail.id}/sub-provinces`, {
      method: 'PUT', headers: H(), body: JSON.stringify({ subProvinceIds: ids }),
    });
    if (!res.ok) {
      if (res.status === 401) { showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626'); logout(); return false; }
      let errMsg = 'فشل حفظ الأقسام';
      try { const j = await res.json(); if (j?.error) errMsg = j.error; } catch {}
      showToast('❌ ' + errMsg, '#dc2626');
      return false;
    }
    return true;
  };

  const saveAreasAndProvinces = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const ok = await saveProvinces(draftProvinceIds);
      if (!ok) return;
      const okSub = await saveSubProvinces(draftSubProvinceIds);
      if (!okSub) return;
    } catch {
      showToast('❌ تعذّر الاتصال بالخادم', '#dc2626');
      return;
    } finally {
      setSaving(false);
    }
    await saveAssignment('areas', draftAreaIds);
  };

  const saveAssignment = async (type: string, ids: number[]) => {
    if (!detail) return;
    setSaving(true);
    const keyMap: Record<string, string> = {
      companies: 'companyIds', lines: 'lineIds', items: 'itemIds', areas: 'areaIds', managers: 'managerIds',
    };
    try {
      const body: Record<string, any> = { [keyMap[type]]: ids };
      if (type === 'companies') {
        // ضمان أن الرئيسية ضمن المختارة؛ وإلا أول شركة
        body.primaryCompanyId = ids.includes(draftPrimaryCompanyId as number) ? draftPrimaryCompanyId : (ids[0] ?? null);
      }
      const res = await fetch(`/api/sa/users/${detail.id}/${type}`, {
        method: 'PUT', headers: H(), body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 401) {
          showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626');
          logout();
          return;
        }
        let errMsg = 'فشل الحفظ';
        try { const j = await res.json(); if (j?.error) errMsg = j.error; } catch {}
        showToast('❌ ' + errMsg, '#dc2626');
        return;
      }
      // Reload detail but keep the user on the same tab (don't snap back to 'info')
      loadDetail(detail.id, { keepTab: true });
      // تغيير الشركات يغيّر مجموعة الايتمات المتاحة → أعد جلبها (نفس الـid لا يُشغّل الـeffect)
      if (type === 'companies') loadCompanyItems(detail.id);
      if (type === 'areas') window.dispatchEvent(new Event('areas-changed'));
      showToast('✅ تم الحفظ');
    } catch (e) {
      console.error('saveAssignment error:', e);
      showToast('❌ تعذّر الاتصال بالخادم', '#dc2626');
    } finally {
      setSaving(false);
    }
  };

  // ── Area CRUD handlers ────────────────────────────────────────────────────
  const createArea = async () => {
    const name = newAreaName.trim();
    if (!name) return;
    setAreaCrudBusy(true);
    try {
      const r = await fetch('/api/sa/areas', { method: 'POST', headers: H(), body: JSON.stringify({ name }) });
      const j = await r.json();
      if (j.success) { setAreas(j.data); setNewAreaName(''); showToast('✅ تمت إضافة المنطقة'); }
      else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  const renameArea = async (id: number) => {
    const name = editingAreaName.trim();
    if (!name) return;
    setAreaCrudBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ name }) });
      const j = await r.json();
      if (j.success) { setAreas(j.data); setEditingAreaId(null); setEditingAreaName(''); showToast('✅ تم تعديل الاسم'); }
      else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  // نقل منطقة (أو عدة مناطق) إلى محافظة. يمسح شارة التعارض لأن قرار المدير
  // يحسمها. السيرفر يعيد قائمة المناطق كاملة فنستبدل الحالة بها.
  const assignAreaProvince = async (areaIds: number[], provinceId: number | null) => {
    setAreaCrudBusy(true);
    try {
      const r = await fetch('/api/sa/areas/province-bulk', {
        method: 'PUT', headers: H(), body: JSON.stringify({ areaIds, provinceId }),
      });
      const j = await r.json();
      if (j.success) {
        setAreas(j.data);
        await loadProvinceCounts();
        showToast(`✅ تم نقل ${j.updated} منطقة`);
      } else showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  // نقل مناطق إلى قسم (كرخ/رصافة). السيرفر يضبط provinceId ليطابق محافظة
  // القسم، فلا يمكن أن تنتهي منطقة تحت قسم لا يتبع محافظتها.
  const assignAreaSubProvince = async (areaIds: number[], subProvinceId: number | null) => {
    if (areaIds.length === 0) return;
    setAreaCrudBusy(true);
    try {
      const r = await fetch('/api/sa/areas/sub-province-bulk', {
        method: 'PUT', headers: H(), body: JSON.stringify({ areaIds, subProvinceId }),
      });
      const j = await r.json();
      if (j.success) {
        setAreas(j.data);
        await loadProvinceCounts();
        showToast(`✅ تم نقل ${j.updated} منطقة`);
      } else showToast('❌ ' + (j.error || 'فشل النقل'), '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  // أعداد المناطق لكل محافظة تتغيّر بعد أي نقل — أعد جلبها
  const loadProvinceCounts = async () => {
    try {
      const [r, rs] = await Promise.all([
        fetch('/api/sa/provinces', { headers: H() }),
        fetch('/api/sa/sub-provinces', { headers: H() }),
      ]);
      const j = await r.json();
      if (j.success) setProvinces(j.data);
      const js = await rs.json();
      if (js.success) setSubProvinces(js.data);
    } catch { /* غير حابس */ }
  };

  const openDeleteArea = async (id: number, name: string) => {
    setAreaCrudBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${id}/usage`, { headers: H() });
      const j = await r.json();
      if (!j.success) { showToast('❌ ' + j.error, '#dc2626'); return; }
      setDeleteTransferTo('');
      setDeleteAreaInfo({ id, name, usage: j.usage, total: j.total, blocking: j.blocking });
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  const confirmDeleteArea = async (mode: 'detach' | 'transfer') => {
    if (!deleteAreaInfo) return;
    const body = mode === 'transfer' ? { transferTo: deleteTransferTo } : {};
    if (mode === 'transfer' && !deleteTransferTo) { showToast('اختر منطقة لنقل البيانات إليها', '#dc2626'); return; }
    setAreaCrudBusy(true);
    try {
      const r = await fetch(`/api/sa/areas/${deleteAreaInfo.id}`, { method: 'DELETE', headers: H(), body: JSON.stringify(body) });
      const j = await r.json();
      if (j.success) {
        setAreas(j.data);
        setDraftAreaIds(prev => prev.filter(x => x !== deleteAreaInfo.id));
        setDeleteAreaInfo(null);
        showToast(mode === 'transfer' ? '✅ تم نقل البيانات وحذف المنطقة' : '✅ تم حذف المنطقة');
      } else showToast('❌ ' + j.error, '#dc2626');
    } catch { showToast('❌ تعذّر الاتصال بالخادم', '#dc2626'); }
    finally { setAreaCrudBusy(false); }
  };

  const saveFeatures = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/sa/users/${detail.id}/features`, {
        method: 'PUT', headers: H(), body: JSON.stringify({
          disabledFeatures: draftDisabledFeats,
          requireGps: draftRequireGps,
          disableActivityLog: draftDisableActLog,
          doctorFilterByArea: draftDoctorFilter.byArea,
          doctorFilterPlanMode: draftDoctorFilter.planMode,
          doctorFilterSurveyOnly: draftDoctorFilter.surveyOnly,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          showToast('انتهت صلاحية الجلسة — يرجى إعادة تسجيل الدخول', '#dc2626');
          logout();
          return;
        }
        let errMsg = 'فشل الحفظ';
        try { const j = await res.json(); if (j?.error) errMsg = j.error; } catch {}
        showToast('❌ ' + errMsg, '#dc2626');
        return;
      }
      loadDetail(detail.id, { keepTab: true });
      showToast('✅ تم الحفظ');
    } catch (e) {
      console.error('saveFeatures error:', e);
      showToast('❌ تعذّر الاتصال بالخادم', '#dc2626');
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = async (u: UserRow) => {
    await fetch(`/api/sa/users/${u.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !u.isActive }) });
    load();
  };

  const delUser = async (u: UserRow) => {
    if (!confirm(
      `حذف مستخدم "${u.username}"؟\n\n` +
      `سيُحذف حساب الدخول فقط. المبيعات والملفات المرفوعة وسجل الزيارات والمناديب المرتبطة بهذا الحساب لا تُحذف — تبقى محفوظة بدون ربط بحساب. إن أردت إيقاف الحساب مؤقتاً مع الاحتفاظ بكل شيء كما هو، استخدم "تعطيل" بدلاً من الحذف.\n\n` +
      `لن يمكن التراجع عن هذا الإجراء.`
    )) return;
    try {
      const res = await fetch(`/api/sa/users/${u.id}`, { method: 'DELETE', headers: H() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(`❌ ${json.error || 'تعذّر حذف المستخدم'}`, '#dc2626');
        return;
      }
      load(); if (detail?.id === u.id) setDetail(null);
      showToast('✅ تم حذف المستخدم');
    } catch (e) {
      console.error('delUser error:', e);
      showToast('❌ تعذّر الاتصال بالخادم', '#dc2626');
    }
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
    const selProvinceIds = draftProvinceIds;
    const selMgrIds     = draftMgrIds;

    // The areas list comes from the active survey (deduped). A user may still be
    // assigned to areas NOT in that survey list (legacy / non-survey areas). Those
    // count toward the assignment total but would otherwise be invisible — surface
    // them as extra rows so the tab count matches what's shown and the admin can
    // see/uncheck them.
    const assignedExtraAreas = (detail.areaAssignments ?? [])
      .filter(aa => !areas.some(a => a.id === aa.areaId))
      .map(aa => ({
        id: aa.areaId, name: aa.area?.name ?? `#${aa.areaId}`,
        provinceId: null as number | null, provinceConflict: null as string | null,
        subProvinceId: null as number | null,
        _extra: true as const,
      }));
    const displayAreas = [...areas, ...assignedExtraAreas];

    // ── تجميع المناطق حسب المحافظة ─────────────────────────────────────────
    // المناطق «خارج السيرفي» وأي منطقة بلا محافظة تقع في مجموعة «غير محدد».
    const provinceById = new Map(provinces.map(p => [p.id, p]));
    const filteredAreas = displayAreas.filter(
      a => !areaSearch || a.name.toLowerCase().includes(areaSearch.toLowerCase()),
    );
    // ── بناء الشجرة: محافظة ← قسم (كرخ/رصافة) ← مناطق ────────────────────
    // القسم مستوى اختياري: مناطق المحافظة التي لا قسم لها تظهر مباشرة تحتها
    // في مجموعة فرعية ضمنية (subKey='direct')، فلا تختفي.
    type SubGroup = { subKey: string; sub: SubProvince | null; areas: typeof filteredAreas };
    type Group = { key: string; province: Province | null; areas: typeof filteredAreas; subs: SubGroup[] };

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

    for (const a of filteredAreas) {
      const p = a.provinceId != null ? provinceById.get(a.provinceId) ?? null : null;
      const g = ensureGroup(p ? String(p.id) : 'none', p);
      g.areas.push(a);
      // القسم يُحتسب فقط داخل محافظته — منطقة بقسم لا يتبع محافظتها تُعامَل كبلا قسم
      const s = a.subProvinceId != null ? subById.get(a.subProvinceId) ?? null : null;
      ensureSub(g, s && p && s.provinceId === p.id ? s : null).areas.push(a);
    }

    // محافظات/أقسام معيّنة للمستخدم لكن بلا مناطق بعد — تظهر كي لا يصير التعيين خفياً
    if (!areaSearch) {
      for (const pid of draftProvinceIds) {
        if (provinceById.has(pid)) ensureGroup(String(pid), provinceById.get(pid)!);
      }
      for (const sid of draftSubProvinceIds) {
        const s = subById.get(sid);
        if (!s) continue;
        const p = provinceById.get(s.provinceId) ?? null;
        ensureSub(ensureGroup(p ? String(p.id) : 'none', p), s);
      }
      // أقسام موجودة أصلاً داخل محافظة معروضة — تظهر فارغة بدل أن تختفي
      for (const s of subProvinces) {
        const key = String(s.provinceId);
        if (groupsMap.has(key)) ensureSub(groupsMap.get(key)!, s);
      }
    }

    const areaGroups = [...groupsMap.values()].sort((x, y) => {
      if (!x.province) return 1;   // «غير محدد» دائماً في الأسفل
      if (!y.province) return -1;
      return (x.province.sortOrder ?? 0) - (y.province.sortOrder ?? 0)
          || x.province.name.localeCompare(y.province.name, 'ar');
    });
    // «بلا قسم» أسفل الأقسام المسمّاة داخل كل محافظة
    for (const g of areaGroups) {
      g.subs.sort((x, y) => {
        if (!x.sub) return 1;
        if (!y.sub) return -1;
        return (x.sub.sortOrder ?? 0) - (y.sub.sortOrder ?? 0)
            || x.sub.name.localeCompare(y.sub.name, 'ar');
      });
    }

    // مشمولة ضمنياً = عبر المحافظة كاملة، أو عبر قسم معيَّن منها
    const impliedAreaIds = new Set(
      displayAreas.filter(a =>
        (a.provinceId != null && draftProvinceIds.includes(a.provinceId))
        || (a.subProvinceId != null && draftSubProvinceIds.includes(a.subProvinceId)),
      ).map(a => a.id),
    );
    const effectiveAreaCount = new Set([...draftAreaIds, ...impliedAreaIds]).size;
    const conflictCount = displayAreas.filter(a => a.provinceConflict).length;


    // ايتمات كتالوج شركات المستخدم، مفلترة بالبحث ومجمّعة حسب الشركة (لتبويب «الايتمات»).
    const filteredItems = items.filter(i => !itemSearch || i.name.toLowerCase().includes(itemSearch.toLowerCase()));
    const itemGroups = Object.entries(
      filteredItems.reduce<Record<string, Item[]>>((acc, i) => {
        const key = i.companyName || '—';
        (acc[key] ||= []).push(i);
        return acc;
      }, {})
    );

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
          <TabBtn id="areas"     label={`المناطق (${effectiveAreaCount})`} />
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
                <button onClick={() => { setDraftCompanyIds(companies.map(c => c.id)); if (draftPrimaryCompanyId == null) setDraftPrimaryCompanyId(companies[0]?.id ?? null); }} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => { setDraftCompanyIds([]); setDraftPrimaryCompanyId(null); }} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل</button>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>⭐ الشركة الرئيسية تُحدَّد على أساسها التيمات والهيكل الإداري وربط المدير. الشركات الثانوية: عمل كامل وتظهر ايتماتها، لكن خارج تكوين الفريق.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {companies.map(c => {
                  const checked = draftCompanyIds.includes(c.id);
                  const isPrimary = draftPrimaryCompanyId === c.id;
                  return (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: isPrimary ? '#fef9c3' : '#f8fafc', borderRadius: 8, fontSize: 14, border: isPrimary ? '1.5px solid #eab308' : '1.5px solid transparent' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}>
                        <input type="checkbox" checked={checked} onChange={e => {
                          if (e.target.checked) { setDraftCompanyIds([...draftCompanyIds, c.id]); if (draftPrimaryCompanyId == null) setDraftPrimaryCompanyId(c.id); }
                          else { setDraftCompanyIds(draftCompanyIds.filter(x => x !== c.id)); if (draftPrimaryCompanyId === c.id) setDraftPrimaryCompanyId(draftCompanyIds.filter(x => x !== c.id)[0] ?? null); }
                        }} />
                        {c.name}
                      </label>
                      {checked && (
                        <button type="button" onClick={() => setDraftPrimaryCompanyId(c.id)} title={isPrimary ? 'الشركة الرئيسية' : 'تعيين كرئيسية'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: isPrimary ? 1 : 0.35 }}>
                          {isPrimary ? '⭐ رئيسية' : '☆'}
                        </button>
                      )}
                    </div>
                  );
                })}
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
              <div style={{ fontSize: 12.5, color: '#0369a1', marginBottom: 12, lineHeight: 1.9, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 12px' }}>
                💊 هذه ايتمات الشركات المعيّنة لهذا المستخدم. اختر عدداً منها ليعمل عليها المستخدم فقط.
                <br />
                ℹ️ إذا لم تختر أي ايتم، يعمل المستخدم على <b>كل</b> ايتمات شركاته — وأي ايتم يُضاف للشركة لاحقاً يظهر له تلقائياً.
              </div>
              <input
                type="text"
                placeholder="🔍 بحث عن ايتم..."
                value={itemSearch}
                onChange={e => setItemSearch(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setDraftItemIds(items.map(i => i.id))} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px' }}>✓ اختيار الكل</button>
                <button onClick={() => setDraftItemIds([])} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}>✗ إلغاء الكل (= كل الايتمات)</button>
              </div>
              {items.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 13, padding: 20, textAlign: 'center', background: '#f8fafc', borderRadius: 8 }}>
                  لا توجد ايتمات — عيّن شركة لهذا المستخدم من تبويب «الشركات» أولاً، وستظهر ايتمات كتالوجها هنا.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 360, overflowY: 'auto' }}>
                  {itemGroups.map(([companyName, groupItems]) => {
                    const groupIds = groupItems.map(i => i.id);
                    const allSel = groupIds.every(id => draftItemIds.includes(id));
                    return (
                      <div key={companyName}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>🏭 {companyName} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({groupItems.length})</span></div>
                          <button
                            onClick={() => allSel
                              ? setDraftItemIds(draftItemIds.filter(x => !groupIds.includes(x)))
                              : setDraftItemIds([...new Set([...draftItemIds, ...groupIds])])}
                            style={{ ...btnStyle(allSel ? '#64748b' : '#2563eb', true), fontSize: 11, padding: '2px 10px' }}>
                            {allSel ? 'إلغاء الشركة' : 'تحديد الشركة'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {groupItems.map(i => {
                            const on = draftItemIds.includes(i.id);
                            return (
                              <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: on ? '#eff6ff' : '#f8fafc', borderRadius: 8, cursor: 'pointer', fontSize: 14, border: on ? '1px solid #bfdbfe' : '1px solid transparent' }}>
                                <input type="checkbox" checked={on} onChange={e => setDraftItemIds(e.target.checked ? [...draftItemIds, i.id] : draftItemIds.filter(x => x !== i.id))} />
                                {i.name}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: draftItemIds.length === 0 ? '#16a34a' : '#64748b', fontWeight: 600 }}>
                  {draftItemIds.length === 0
                    ? '✓ لم تُختر ايتمات → المستخدم يعمل على كل ايتمات شركاته'
                    : `مُختار ${draftItemIds.length} ايتم — المستخدم يعمل عليها فقط`}
                </span>
                <button onClick={() => saveAssignment('items', draftItemIds)} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
            </div>
          )}
          {tab === 'areas' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <button
                  disabled={saving || mergeBusy}
                  title="دمج المناطق المتطابقة بعد التطبيع (الحارثية = الحارثيه) دون فقدان أي بيانات"
                  onClick={async () => {
                    if (!confirm('سيتم دمج المناطق المكررة المتطابقة بالاسم (مثل الحارثية/الحارثيه) في منطقة واحدة، مع نقل كل مبيعاتها. لا تُحذف أي بيانات. متابعة؟')) return;
                    setMergeBusy(true);
                    try {
                      const r = await fetch('/api/sa/areas/merge-duplicates', { method: 'POST', headers: H() });
                      const j = await r.json();
                      if (j.success) {
                        setAreas(j.data);
                        setDraftAreaIds(prev => prev.filter(id => j.data.some((a: any) => a.id === id)));
                        alert(j.mergedCount > 0 ? `✅ تم دمج ${j.mergedCount} منطقة مكررة` : '✅ لا توجد مناطق مكررة متطابقة');
                      } else { alert('❌ ' + j.error); }
                    } finally { setMergeBusy(false); }
                  }}
                  style={{ ...btnStyle('#0d9488', true), fontSize: 12, padding: '4px 14px' }}
                >
                  {mergeBusy ? '...' : '🧹 دمج المكررات'}
                </button>
                <button
                  disabled={saving || mergeBusy}
                  title="عرض المناطق المتشابهة (وليست متطابقة) لمراجعتها ودمجها يدوياً"
                  onClick={async () => {
                    setMergeBusy(true);
                    try {
                      const r = await fetch('/api/sa/areas/merge-suggestions', { headers: H() });
                      const j = await r.json();
                      if (j.success) setMergeSugs(j.data);
                      else alert('❌ ' + j.error);
                    } finally { setMergeBusy(false); }
                  }}
                  style={{ ...btnStyle('#d97706', true), fontSize: 12, padding: '4px 14px' }}
                >
                  {mergeBusy ? '...' : '🔍 اقتراحات الدمج'}
                </button>
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
                <button
                  disabled={saving}
                  title="يُسند محافظة لكل منطقة بلا محافظة: أولاً من عمود المحافظة داخل بيانات المبيعات المحفوظة، ثم بمطابقة اسم المنطقة نفسه"
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const r = await fetch('/api/sa/provinces/auto-match', {
                        method: 'POST', headers: H(), body: JSON.stringify({}),
                      });
                      const j = await r.json();
                      if (j.success) {
                        setAreas(j.data);
                        await loadProvinceCounts();
                        const s = j.stats || {};
                        alert(`✅ المطابقة التلقائية للمحافظات\n\n• من بيانات المبيعات: ${s.matchedFromSales ?? 0}\n• من اسم المنطقة: ${s.matchedFromName ?? 0}\n• بقيت بلا محافظة: ${s.unresolved ?? 0}\n\n(فُحصت ${s.scanned ?? 0} منطقة)`);
                      } else alert('❌ ' + j.error);
                    } finally { setSaving(false); }
                  }}
                  style={{ ...btnStyle('#0d9488', true), fontSize: 12, padding: '4px 14px' }}
                >
                  {saving ? '...' : '🗺️ مطابقة المحافظات تلقائياً'}
                </button>
                <button
                  disabled={saving}
                  title="ينشئ الكرخ والرصافة تحت بغداد ويوزّع مناطقها المعروفة عليهما. ما هو غير واضح يبقى «بلا قسم» لتحدده يدوياً."
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const r = await fetch('/api/sa/sub-provinces/auto-match', {
                        method: 'POST', headers: H(), body: JSON.stringify({}),
                      });
                      const j = await r.json();
                      if (j.success) {
                        setAreas(j.data);
                        await loadProvinceCounts();
                        const s = j.stats || {};
                        alert(`✅ توزيع مناطق بغداد على الكرخ/الرصافة\n\n• تم توزيع: ${s.matched ?? 0}\n• بقيت بلا قسم: ${s.unresolved ?? 0}\n\n(فُحصت ${s.scanned ?? 0} منطقة)`);
                      } else alert('❌ ' + j.error);
                    } finally { setSaving(false); }
                  }}
                  style={{ ...btnStyle('#4f46e5', true), fontSize: 12, padding: '4px 14px' }}
                >
                  {saving ? '...' : '🏙️ توزيع كرخ/رصافة'}
                </button>
              </div>
              {conflictCount > 0 && (
                <div style={{ marginBottom: 10, border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10, padding: '8px 12px', fontSize: 12, color: '#991b1b' }}>
                  ⚠️ <strong>{conflictCount}</strong> منطقة ورد اسمها في ملف بمحافظة تختلف عن المحفوظة. اختر المحافظة الصحيحة من القائمة بجانب المنطقة لحسم التعارض.
                </div>
              )}
              {mergeSugs !== null && (
                <div style={{ marginBottom: 12, border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 13, color: '#92400e' }}>🔍 اقتراحات دمج المناطق المتشابهة ({mergeSugs.length})</strong>
                    <button onClick={() => setMergeSugs(null)} style={{ ...btnStyle('#64748b', true), fontSize: 11, padding: '3px 10px' }}>✕ إغلاق</button>
                  </div>
                  {mergeSugs.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#78716c', padding: '6px 2px' }}>لا توجد مناطق متشابهة تحتاج مراجعة.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                      {mergeSugs.map((s, i) => {
                        // Default: keep the row with more sales as canonical (survivor)
                        const keep = s.b.sales > s.a.sales ? s.b : s.a;
                        const drop = keep === s.a ? s.b : s.a;
                        const doMerge = async (toId: number, fromId: number) => {
                          if (!confirm(`دمج "${mergeSugs[i][fromId === s.a.id ? 'a' : 'b'].name}" داخل "${mergeSugs[i][toId === s.a.id ? 'a' : 'b'].name}"؟ ستُنقل كل المبيعات.`)) return;
                          setMergeBusy(true);
                          try {
                            const r = await fetch('/api/sa/areas/merge', { method: 'POST', headers: H(), body: JSON.stringify({ fromId, toId }) });
                            const j = await r.json();
                            if (j.success) {
                              setAreas(j.data);
                              setDraftAreaIds(prev => prev.filter(id => j.data.some((a: any) => a.id === id)));
                              setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev);
                            } else { alert('❌ ' + j.error); }
                          } finally { setMergeBusy(false); }
                        };
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 10px', fontSize: 13, flexWrap: 'wrap' }}>
                            <span style={{ flex: 1, minWidth: 140 }}>
                              <b>{s.a.name}</b> <span style={{ color: '#94a3b8', fontSize: 11 }}>({s.a.sales} مبيعة)</span>
                              <span style={{ color: '#d97706', margin: '0 6px' }}>↔</span>
                              <b>{s.b.name}</b> <span style={{ color: '#94a3b8', fontSize: 11 }}>({s.b.sales} مبيعة)</span>
                            </span>
                            <button disabled={mergeBusy} onClick={() => doMerge(keep.id, drop.id)} style={{ ...btnStyle('#0d9488', true), fontSize: 11, padding: '3px 10px' }}>
                              دمج في «{keep.name}»
                            </button>
                            <button disabled={mergeBusy} onClick={() => setMergeSugs(prev => prev ? prev.filter((_, idx) => idx !== i) : prev)} style={{ ...btnStyle('#94a3b8', true), fontSize: 11, padding: '3px 10px' }}>
                              تجاهل
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <input
                type="text"
                placeholder="🔍 بحث عن منطقة..."
                value={areaSearch}
                onChange={e => setAreaSearch(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', marginBottom: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
              />
              {refsLoading ? (
                <div style={{ textAlign: 'center', padding: '24px', color: '#94a3b8', fontSize: 14 }}>⏳ جاري تحميل قائمة المناطق...</div>
              ) : (
              <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button
                  onClick={() => { if (displayAreas.length > 0) setDraftAreaIds(displayAreas.map(a => a.id)); }}
                  title="يؤشّر كل المناطق فردياً (ثابت). لتعيين ديناميكي أشّر المحافظة نفسها."
                  disabled={displayAreas.length === 0}
                  style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 12px', opacity: displayAreas.length === 0 ? 0.4 : 1 }}
                >✓ اختيار الكل</button>
                <button
                  onClick={() => {
                    if ((draftAreaIds.length > 0 || draftProvinceIds.length > 0 || draftSubProvinceIds.length > 0)
                        && !confirm('سيتم إلغاء تحديد جميع المناطق والمحافظات والأقسام. هل أنت متأكد؟')) return;
                    setDraftAreaIds([]);
                    setDraftProvinceIds([]);
                    setDraftSubProvinceIds([]);
                  }}
                  style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 12px' }}
                >✗ إلغاء الكل</button>
              </div>
              {/* ➕ إضافة منطقة جديدة يدوياً */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  type="text"
                  placeholder="➕ اسم منطقة جديدة..."
                  value={newAreaName}
                  onChange={e => setNewAreaName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') createArea(); }}
                  disabled={areaCrudBusy}
                  style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
                />
                <button
                  onClick={createArea}
                  disabled={areaCrudBusy || !newAreaName.trim()}
                  style={{ ...btnStyle('#16a34a', true), fontSize: 13, padding: '4px 16px', opacity: (areaCrudBusy || !newAreaName.trim()) ? 0.5 : 1 }}
                >{areaCrudBusy ? '...' : '➕ إضافة'}</button>
              </div>
              {/* شريط ملخّص + طيّ/فتح الكل — يعوّض غياب سياق واضح مع ~19 مجموعة محتملة */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, fontSize: 12, color: '#64748b' }}>
                <span>{areaGroups.length} مجموعة (محافظة أو «غير محدد»)</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => setCollapsedProvinces(new Set())}
                    style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}
                  >▼ فتح الكل</button>
                  <button
                    onClick={() => setCollapsedProvinces(new Set(areaGroups.map(g => g.key)))}
                    style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}
                  >◀ طيّ الكل</button>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 460, overflowY: 'auto', paddingInlineEnd: 2 }}>
                {areaGroups.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8', fontSize: 13 }}>لا توجد مناطق مطابقة</div>
                )}
                {areaGroups.map(group => {
                  const pid = group.province?.id ?? null;
                  const provinceChecked = pid != null && draftProvinceIds.includes(pid);
                  const groupAreaIds = group.areas.map(a => a.id);
                  const directChecked = groupAreaIds.filter(id => draftAreaIds.includes(id)).length;
                  const allChecked  = groupAreaIds.length > 0 && directChecked === groupAreaIds.length;
                  const someChecked = directChecked > 0 && !allChecked;
                  // أثناء البحث: افتح كل مجموعة فيها نتائج، بصرف النظر عن حالة الطيّ المحفوظة
                  const isCollapsed = areaSearch.trim() ? false : collapsedProvinces.has(group.key);
                  const toggleCollapse = () => setCollapsedProvinces(prev => {
                    const next = new Set(prev);
                    if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                    return next;
                  });

                  return (
                    <div key={group.key} style={{ border: `1px solid ${provinceChecked ? '#86efac' : '#e2e8f0'}`, borderRadius: 10, background: provinceChecked ? '#f0fdf4' : '#fff' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px', padding: '8px 12px', background: provinceChecked ? '#dcfce7' : '#f8fafc', borderBottom: isCollapsed ? 'none' : '1px solid #e2e8f0', borderRadius: isCollapsed ? 9 : '9px 9px 0 0' }}>
                        <button
                          onClick={toggleCollapse}
                          title={isCollapsed ? 'عرض المناطق' : 'إخفاء المناطق'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#475569', padding: 0, width: 18, flexShrink: 0 }}
                        >{isCollapsed ? '◀' : '▼'}</button>

                        {pid != null ? (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, color: '#0f172a' }}>
                            <input
                              type="checkbox"
                              checked={provinceChecked}
                              onChange={e => setDraftProvinceIds(
                                e.target.checked
                                  ? [...draftProvinceIds, pid]
                                  : draftProvinceIds.filter(x => x !== pid),
                              )}
                            />
                            🗺️ {group.province!.name}
                            <span style={{ fontWeight: 500, fontSize: 12, color: '#64748b' }}>({group.areas.length})</span>
                          </label>
                        ) : (
                          <span style={{ fontWeight: 700, fontSize: 14, color: '#92400e' }}>
                            ⚠️ غير محدد <span style={{ fontWeight: 500, fontSize: 12, color: '#a16207' }}>({group.areas.length})</span>
                          </span>
                        )}

                        {provinceChecked && (
                          <span title="تعيين ديناميكي: أي منطقة تُضاف لهذه المحافظة لاحقاً تدخل نطاق المستخدم تلقائياً" style={{ fontSize: 10, fontWeight: 700, color: '#166534', background: '#bbf7d0', border: '1px solid #86efac', borderRadius: 6, padding: '1px 6px' }}>المحافظة كاملة</span>
                        )}

                        {/* يدفع باقي عناصر الرأس (الأزرار) لطرف السطر؛ ويلتف تلقائياً تحته
                            بفضل flexWrap إن ضاقت المساحة، بدل أن تُقصّ خارج الرؤية */}
                        <div style={{ flex: 1 }} />
                        {!provinceChecked && groupAreaIds.length > 0 && (
                          <button
                            onClick={() => setDraftAreaIds(
                              allChecked
                                ? draftAreaIds.filter(id => !groupAreaIds.includes(id))
                                : [...new Set([...draftAreaIds, ...groupAreaIds])],
                            )}
                            title={allChecked ? 'إلغاء تحديد مناطق هذه المجموعة' : 'تحديد مناطق هذه المجموعة فقط (ثابت، غير ديناميكي)'}
                            style={{ ...btnStyle(someChecked ? '#f59e0b' : '#64748b', true), fontSize: 11, padding: '3px 10px', flexShrink: 0 }}
                          >{allChecked ? '✗ إلغاء الكل' : someChecked ? `◐ ${directChecked}/${groupAreaIds.length}` : '✓ تحديد الكل'}</button>
                        )}

                        {/* نقل المناطق المُحدَّدة (المؤشَّرة لهذا المستخدم) في مجموعة «غير
                            محدد» دفعة واحدة إلى محافظة — أسرع من تعديل كل منطقة على حدة.
                            في سطر مستقل (basis:100%) كي لا يزدحم مع بقية أزرار الرأس. */}
                        {pid === null && directChecked > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexBasis: '100%' }}>
                            <select
                              value={bulkTargetProvince}
                              onChange={e => setBulkTargetProvince(e.target.value === '' ? '' : Number(e.target.value))}
                              disabled={areaCrudBusy}
                              style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #cbd5e1', direction: 'rtl', maxWidth: 160 }}
                            >
                              <option value="">نقل المحدد ({directChecked}) إلى...</option>
                              {provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <button
                              disabled={areaCrudBusy || bulkTargetProvince === ''}
                              onClick={() => {
                                if (bulkTargetProvince === '') return;
                                const checkedIds = groupAreaIds.filter(id => draftAreaIds.includes(id));
                                assignAreaProvince(checkedIds, Number(bulkTargetProvince));
                                setBulkTargetProvince('');
                              }}
                              title="ينقل فقط المناطق المؤشَّرة (المُعيَّنة لهذا المستخدم) ضمن هذه المجموعة إلى المحافظة المختارة"
                              style={{ ...btnStyle('#0d9488', true), fontSize: 11, padding: '3px 10px' }}
                            >📍 نقل</button>
                          </div>
                        )}
                      </div>

                      {!isCollapsed && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
                          {group.areas.length === 0 && (
                            <div style={{ fontSize: 12, color: '#94a3b8', padding: '4px 8px' }}>لا توجد مناطق في هذه المحافظة بعد — ستدخل تلقائياً عند رفع ملف يحتوي عليها.</div>
                          )}
                          {group.subs.map(sg => {
                            const subId = sg.sub?.id ?? null;
                            const subChecked = subId != null && draftSubProvinceIds.includes(subId);
                            const subAreaIds = sg.areas.map(a => a.id);
                            const subDirect = subAreaIds.filter(id => draftAreaIds.includes(id)).length;
                            const subAll = subAreaIds.length > 0 && subDirect === subAreaIds.length;
                            const subSome = subDirect > 0 && !subAll;
                            const subKeyFull = group.key + ':' + sg.subKey;
                            const subCollapsed = areaSearch.trim() ? false : collapsedProvinces.has(subKeyFull);
                            const toggleSub = () => setCollapsedProvinces(prev => {
                              const next = new Set(prev);
                              if (next.has(subKeyFull)) next.delete(subKeyFull); else next.add(subKeyFull);
                              return next;
                            });
                            // محافظة كاملة معيّنة ⇒ القسم مشمول ضمناً، فلا معنى لتأشيره منفرداً
                            const subImplied = provinceChecked;

                            return (
                              <div key={sg.subKey} style={{ border: `1px solid ${subChecked ? '#86efac' : '#eef2f7'}`, borderRadius: 8, background: subChecked ? '#f0fdf4' : '#fcfdfe' }}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', padding: '6px 10px', background: subChecked ? '#dcfce7' : '#f1f5f9', borderBottom: subCollapsed ? 'none' : '1px solid #e8edf3', borderRadius: subCollapsed ? 7 : '7px 7px 0 0' }}>
                                  <button
                                    onClick={toggleSub}
                                    title={subCollapsed ? 'عرض المناطق' : 'إخفاء المناطق'}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#64748b', padding: 0, width: 16, flexShrink: 0 }}
                                  >{subCollapsed ? '◀' : '▼'}</button>

                                  {sg.sub ? (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: subImplied ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, color: '#334155', opacity: subImplied ? 0.7 : 1 }}>
                                      <input
                                        type="checkbox"
                                        checked={subChecked || subImplied}
                                        disabled={subImplied}
                                        title={subImplied ? 'مشمول تلقائياً لأن المحافظة كاملة معيّنة' : 'تعيين ديناميكي: أي منطقة تُضاف لهذا القسم لاحقاً تدخل نطاق المستخدم تلقائياً'}
                                        onChange={e => setDraftSubProvinceIds(
                                          e.target.checked
                                            ? [...draftSubProvinceIds, sg.sub!.id]
                                            : draftSubProvinceIds.filter(x => x !== sg.sub!.id),
                                        )}
                                      />
                                      🏙️ {sg.sub.name}
                                      <span style={{ fontWeight: 500, fontSize: 11, color: '#64748b' }}>({sg.areas.length})</span>
                                      {subChecked && !subImplied && (
                                        <span style={{ fontSize: 10, fontWeight: 700, color: '#166534', background: '#bbf7d0', border: '1px solid #86efac', borderRadius: 6, padding: '1px 6px' }}>القسم كامل</span>
                                      )}
                                    </label>
                                  ) : (
                                    <span style={{ fontWeight: 600, fontSize: 13, color: '#64748b' }}>
                                      ▪️ بلا قسم <span style={{ fontWeight: 500, fontSize: 11 }}>({sg.areas.length})</span>
                                    </span>
                                  )}

                                  <div style={{ flex: 1 }} />
                                  {!provinceChecked && !subChecked && subAreaIds.length > 0 && (
                                    <button
                                      onClick={() => setDraftAreaIds(
                                        subAll
                                          ? draftAreaIds.filter(id => !subAreaIds.includes(id))
                                          : [...new Set([...draftAreaIds, ...subAreaIds])],
                                      )}
                                      title={subAll ? 'إلغاء تحديد مناطق هذا القسم' : 'تحديد مناطق هذا القسم فقط (ثابت، غير ديناميكي)'}
                                      style={{ ...btnStyle(subSome ? '#f59e0b' : '#94a3b8', true), fontSize: 10, padding: '2px 8px', flexShrink: 0 }}
                                    >{subAll ? '✗ إلغاء' : subSome ? `◐ ${subDirect}/${subAreaIds.length}` : '✓ تحديد'}</button>
                                  )}

                                  {/* نقل مناطق مؤشَّرة بين الكرخ/الرصافة — يظهر داخل «بلا قسم»
                                      وأي قسم آخر، بشرط وجود أقسام في هذه المحافظة أصلاً. */}
                                  {subDirect > 0 && group.province && subProvinces.some(s => s.provinceId === group.province!.id) && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexBasis: '100%', paddingTop: 4 }}>
                                      <select
                                        value={bulkTargetSub}
                                        onChange={e => setBulkTargetSub(e.target.value === '' ? '' : Number(e.target.value))}
                                        disabled={areaCrudBusy}
                                        style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #cbd5e1', direction: 'rtl', maxWidth: 170 }}
                                      >
                                        <option value="">نقل المحدد ({subDirect}) إلى قسم...</option>
                                        {subProvinces.filter(s => s.provinceId === group.province!.id).map(s => (
                                          <option key={s.id} value={s.id}>{s.name}</option>
                                        ))}
                                      </select>
                                      <button
                                        disabled={areaCrudBusy || bulkTargetSub === ''}
                                        onClick={() => {
                                          if (bulkTargetSub === '') return;
                                          assignAreaSubProvince(subAreaIds.filter(id => draftAreaIds.includes(id)), Number(bulkTargetSub));
                                          setBulkTargetSub('');
                                        }}
                                        title="ينقل المناطق المؤشَّرة ضمن هذا القسم إلى القسم المختار"
                                        style={{ ...btnStyle('#0d9488', true), fontSize: 11, padding: '3px 10px' }}
                                      >🏙️ نقل</button>
                                    </div>
                                  )}
                                </div>

                                {!subCollapsed && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 6 }}>
                                    {sg.areas.length === 0 && (
                                      <div style={{ fontSize: 11, color: '#94a3b8', padding: '3px 6px' }}>لا توجد مناطق في هذا القسم بعد.</div>
                                    )}
                                    {sg.areas.map(a => {
                            const implied = impliedAreaIds.has(a.id);
                            const checked = implied || draftAreaIds.includes(a.id);
                            const pickerOpen = openProvincePicker === a.id;
                            return (
                              <div key={a.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', padding: '5px 10px', background: checked ? '#f0fdf4' : '#f8fafc', border: `1px solid ${checked ? '#bbf7d0' : 'transparent'}`, borderRadius: 8, fontSize: 14 }}>
                                {editingAreaId === a.id ? (
                                  <>
                                    <input
                                      type="text"
                                      value={editingAreaName}
                                      onChange={e => setEditingAreaName(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') renameArea(a.id); if (e.key === 'Escape') setEditingAreaId(null); }}
                                      autoFocus
                                      disabled={areaCrudBusy}
                                      style={{ flex: 1, minWidth: 120, padding: '5px 10px', borderRadius: 6, border: '1px solid #93c5fd', fontSize: 14, direction: 'rtl' }}
                                    />
                                    <button onClick={() => renameArea(a.id)} disabled={areaCrudBusy || !editingAreaName.trim()} title="حفظ الاسم" style={{ ...btnStyle('#16a34a', true), fontSize: 12, padding: '4px 10px' }}>💾</button>
                                    <button onClick={() => { setEditingAreaId(null); setEditingAreaName(''); }} disabled={areaCrudBusy} title="إلغاء" style={{ ...btnStyle('#94a3b8', true), fontSize: 12, padding: '4px 10px' }}>✕</button>
                                  </>
                                ) : (
                                  <>
                                    <label style={{ flex: 1, minWidth: 160, display: 'flex', alignItems: 'center', gap: 10, cursor: implied ? 'default' : 'pointer', opacity: implied ? 0.75 : 1, color: '#1e293b' }}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={implied}
                                        title={implied ? 'مشمولة تلقائياً عبر تعيين المحافظة' : undefined}
                                        onChange={e => setDraftAreaIds(e.target.checked ? [...draftAreaIds, a.id] : draftAreaIds.filter(x => x !== a.id))}
                                      />
                                      <span>{a.name}</span>
                                      {implied && <span style={{ fontSize: 10, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, padding: '1px 6px' }}>عبر المحافظة</span>}
                                      {a.provinceConflict && (
                                        <span title={`ورد اسم هذه المنطقة في ملف بمحافظة «${a.provinceConflict}» تختلف عن المحفوظة — راجعها واحسم التعارض`} style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '1px 6px' }}>⚠️ {a.provinceConflict}</span>
                                      )}
                                      {(a as any)._extra && <span title="منطقة معيّنة للمستخدم لكنها غير موجودة في السيرفي الحالي" style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, padding: '1px 6px' }}>خارج السيرفي</span>}
                                    </label>
                                    {pickerOpen ? (
                                      <>
                                        <select
                                          autoFocus
                                          defaultValue={a.provinceId ?? ''}
                                          onChange={e => {
                                            assignAreaProvince([a.id], e.target.value === '' ? null : Number(e.target.value));
                                            setOpenProvincePicker(null);
                                          }}
                                          onBlur={() => setOpenProvincePicker(null)}
                                          disabled={areaCrudBusy}
                                          style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #93c5fd', direction: 'rtl', maxWidth: 140 }}
                                        >
                                          <option value="">— بلا محافظة</option>
                                          {provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                        </select>
                                        <button onClick={() => setOpenProvincePicker(null)} disabled={areaCrudBusy} title="إلغاء" style={{ ...btnStyle('#94a3b8', true), fontSize: 12, padding: '4px 8px' }}>✕</button>
                                      </>
                                    ) : (
                                      <button
                                        onClick={() => setOpenProvincePicker(a.id)}
                                        disabled={areaCrudBusy}
                                        title={`المحافظة الحالية: ${a.provinceId != null ? (provinces.find(p => p.id === a.provinceId)?.name ?? '—') : 'بلا محافظة'} — اضغط للتغيير`}
                                        style={{ ...btnStyle('#64748b', true), fontSize: 11, padding: '3px 8px' }}
                                      >🗺️ {a.provinceId != null ? (provinces.find(p => p.id === a.provinceId)?.name ?? '؟') : '—'}</button>
                                    )}
                                    <button onClick={() => { setEditingAreaId(a.id); setEditingAreaName(a.name); }} disabled={areaCrudBusy} title="تعديل الاسم" style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 10px' }}>✏️</button>
                                    <button onClick={() => openDeleteArea(a.id, a.name)} disabled={areaCrudBusy} title="حذف المنطقة" style={{ ...btnStyle('#dc2626', true), fontSize: 12, padding: '4px 10px' }}>🗑️</button>
                                  </>
                                )}
                              </div>
                            );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              </>
              )}
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    if (draftAreaIds.length === 0 && draftProvinceIds.length === 0 && draftSubProvinceIds.length === 0
                        && (detail.areaAssignments.length > 0 || (detail.provinceAssignments ?? []).length > 0
                            || (detail.subProvinceAssignments ?? []).length > 0)) {
                      if (!confirm(`سيتم حذف جميع المناطق والمحافظات المُعيَّنة لهذا المستخدم. هل أنت متأكد؟`)) return;
                    }
                    saveAreasAndProvinces();
                  }}
                  disabled={saving || refsLoading}
                  style={btnStyle('#0f172a', true)}
                >{saving ? '...' : 'حفظ التغييرات'}</button>
              </div>
              {/* 🗑️ نافذة حذف منطقة — تنبيه بالبيانات + نقل أو تصفير */}
              {deleteAreaInfo && (() => {
                const labels: Record<string, string> = {
                  sales: 'مبيعات', plans: 'خطط شهرية', doctors: 'أطباء', pharmacies: 'صيدليات',
                  pharmacyVisits: 'زيارات صيدليات', sciReps: 'مناديب علميون', reps: 'مناديب',
                  assignments: 'مستخدمون معيّنون', surveyDoctors: 'سجلات سيرفي',
                };
                const rows = Object.entries(deleteAreaInfo.usage).filter(([, v]) => v > 0);
                const isEmpty = deleteAreaInfo.total === 0;
                return (
                  <div onClick={() => !areaCrudBusy && setDeleteAreaInfo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 'min(460px, 92vw)', maxHeight: '85vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
                      <h3 style={{ margin: '0 0 12px', fontSize: 17, color: '#0f172a' }}>🗑️ حذف منطقة «{deleteAreaInfo.name}»</h3>
                      {isEmpty ? (
                        <p style={{ fontSize: 14, color: '#475569', margin: '0 0 16px' }}>لا توجد أي بيانات مرتبطة بهذه المنطقة. يمكن حذفها مباشرة.</p>
                      ) : (
                        <>
                          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: 12, marginBottom: 14 }}>
                            <strong style={{ fontSize: 13, color: '#92400e' }}>⚠️ هذه المنطقة مرتبطة ببيانات:</strong>
                            <ul style={{ margin: '8px 0 0', paddingInlineStart: 20, fontSize: 13, color: '#78350f' }}>
                              {rows.map(([k, v]) => <li key={k}>{labels[k] || k}: <b>{v}</b></li>)}
                            </ul>
                          </div>
                          {deleteAreaInfo.blocking && (
                            <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '0 0 12px' }}>
                              ⛔ لوجود مبيعات مرتبطة لا يمكن «تصفير» المنطقة — يجب <b>نقل</b> بياناتها إلى منطقة أخرى قبل الحذف.
                            </p>
                          )}
                          {/* خيار النقل */}
                          <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>① نقل البيانات إلى منطقة أخرى ثم الحذف:</div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <select
                                value={deleteTransferTo}
                                onChange={e => setDeleteTransferTo(e.target.value ? Number(e.target.value) : '')}
                                disabled={areaCrudBusy}
                                style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, direction: 'rtl' }}
                              >
                                <option value="">— اختر منطقة الوجهة —</option>
                                {areas.filter(a => a.id !== deleteAreaInfo.id).map(a => (
                                  <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                              </select>
                              <button onClick={() => confirmDeleteArea('transfer')} disabled={areaCrudBusy || !deleteTransferTo} style={{ ...btnStyle('#0d9488', true), fontSize: 13, padding: '4px 14px', opacity: (areaCrudBusy || !deleteTransferTo) ? 0.5 : 1 }}>نقل وحذف</button>
                            </div>
                          </div>
                        </>
                      )}
                      {/* خيار التصفير / الحذف المباشر */}
                      {!deleteAreaInfo.blocking && (
                        <div style={{ marginBottom: 14 }}>
                          {!isEmpty && <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>② تصفير (فصل) البيانات ثم الحذف:</div>}
                          <button onClick={() => confirmDeleteArea('detach')} disabled={areaCrudBusy} style={{ ...btnStyle('#dc2626', true), fontSize: 13, padding: '6px 16px', width: '100%' }}>
                            {areaCrudBusy ? '...' : (isEmpty ? '🗑️ حذف المنطقة' : '🗑️ تصفير البيانات وحذف المنطقة')}
                          </button>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <button onClick={() => setDeleteAreaInfo(null)} disabled={areaCrudBusy} style={{ ...btnStyle('#64748b', true), fontSize: 13, padding: '5px 16px' }}>إلغاء</button>
                      </div>
                    </div>
                  </div>
                );
              })()}
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

            // صفحات حساب هذا المستخدم — بنفس تسميتها وأيقوناتها وترتيب ظهورها الحقيقي
            // في القائمة الجانبية الفعلية لدوره (مصدرها src/config/featureConfig.ts، وهو
            // نفس الملف الذي تُبنى منه Sidebar.tsx الحقيقية).
            const visiblePages      = getVisiblePageNodes(detail.role);
            const visibleStandalone = STANDALONE_FEATURES.filter(n => !n.onlyRoles || n.onlyRoles.includes(detail.role));
            const activeNode = [...visiblePages.map(p => p.node), ...visibleStandalone]
              .find(n => (n.key || n.label) === featSection) ?? null;

            const DOT_COLOR: Record<string, string> = { on: '#22c55e', partial: '#f59e0b', off: '#ef4444' };

            const SidebarBtn = ({ id, icon, label, dot }: { id: string; icon: string; label: string; dot?: { color: string } | null }) => (
              <button
                onClick={() => setFeatSection(id)}
                className={`sidebar-nav-item${featSection === id ? ' sidebar-nav-item--active' : ''}`}
                style={{ marginBottom: 2 }}
              >
                <span className="sidebar-nav-icon">{icon}</span>
                <span className="sidebar-nav-label">{label}</span>
                {dot
                  ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot.color, flexShrink: 0 }} />
                  : <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.08)', color: '#64748b', borderRadius: 4, padding: '1px 5px', flexShrink: 0, whiteSpace: 'nowrap' }}>دائماً</span>
                }
              </button>
            );

            const SectionLabel = ({ text }: { text: string }) => (
              <div style={{ fontSize: 9, fontWeight: 800, color: '#4b5d7c', padding: '4px 8px 6px', letterSpacing: 1.2, textTransform: 'uppercase' }}>{text}</div>
            );

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11.5, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                  🪟 معاينة حيّة للقائمة الجانبية كما تظهر فعلياً داخل حساب <b>{detail.displayName || detail.username}</b> — بدّل أي خانة مباشرة من هنا
                </div>
                <div style={{ display: 'flex', borderRadius: 12, overflow: 'hidden', border: '1.5px solid #e2e8f0', minHeight: 560 }}>

                  {/* ════ LEFT: نسخة طبق الأصل من الشريط الجانبي الحقيقي ════ */}
                  <div style={{ width: 240, background: 'linear-gradient(180deg, #0f1e35 0%, #0a1628 100%)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                    {/* Brand header — matches the real sidebar-brand */}
                    <div className="sidebar-brand" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                      <span className="sidebar-brand-icon">🔷</span>
                      <span className="sidebar-brand-text">Ordine</span>
                    </div>

                    {/* Whose account this is */}
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#1a56db', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, flexShrink: 0 }}>
                        {(detail.displayName || detail.username || '?')[0].toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#e0e8f4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail.displayName || detail.username}</div>
                        <div style={{ fontSize: 10.5, color: '#8fa0be' }}>{ROLES.find(r => r.value === detail.role)?.label || detail.role}</div>
                      </div>
                    </div>

                    {/* Settings section */}
                    <div style={{ padding: '8px 8px 0' }}><SectionLabel text="الإعدادات" /></div>
                    <div className="sidebar-nav" style={{ flex: 'none', padding: '0 8px' }}>
                      <SidebarBtn id="gps"           icon="📍" label="GPS / الموقع"  dot={{ color: draftRequireGps ? '#f97316' : '#22c55e' }} />
                      <SidebarBtn id="activity_log"  icon="🕵️" label="سجل الحركات"  dot={{ color: draftDisableActLog ? '#94a3b8' : '#22c55e' }} />
                      <SidebarBtn id="doctor_filter" icon="🔍" label="فلتر الأطباء"  dot={{ color: '#6366f1' }} />
                    </div>

                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '8px 12px' }} />

                    {/* Real nav pages — same order/labels/icons the user actually sees */}
                    <div style={{ padding: '0 8px' }}><SectionLabel text="صفحات الحساب" /></div>
                    <nav className="sidebar-nav" style={{ flex: 1, minHeight: 0, padding: '0 8px' }}>
                      {visiblePages.map(({ node }) => {
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
                      {visiblePages.length === 0 && (
                        <div style={{ color: '#4b5d7c', fontSize: 11.5, padding: '8px' }}>لا توجد صفحات مرئية لهذا الدور</div>
                      )}
                    </nav>

                    {/* Standalone / global features */}
                    {visibleStandalone.length > 0 && (
                      <>
                        <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 12px' }} />
                        <div style={{ padding: '4px 8px 0' }}><SectionLabel text="ميزات عامة" /></div>
                        <div style={{ padding: '0 8px 6px' }}>
                          {visibleStandalone.map(node => {
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
                      </>
                    )}

                    {/* Save button */}
                    <div style={{ padding: '12px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                      <button onClick={saveFeatures} disabled={saving}
                        style={{ width: '100%', padding: '9px', borderRadius: 8, border: 'none', cursor: saving ? 'wait' : 'pointer', background: '#1a56db', color: '#fff', fontWeight: 700, fontSize: 12 }}>
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

                  {/* ── Activity Log ── */}
                  {featSection === 'activity_log' && (
                    <div>
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>🕵️ سجل الحركات</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>تحديد ما إذا كانت تصرفات هذا المستخدم تُحفظ في سجل الحركات</div>
                      </div>
                      <div style={{
                        borderRadius: 14, border: `2px solid ${draftDisableActLog ? '#94a3b8' : '#22c55e'}`,
                        background: draftDisableActLog ? '#f8fafc' : '#f0fdf4',
                        padding: '18px 20px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div style={{ width: 52, height: 52, borderRadius: 14, background: draftDisableActLog ? '#e2e8f0' : '#bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🕵️</div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>تسجيل حركات المستخدم</div>
                            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                              {draftDisableActLog ? '⚫ معطّل — لن تُسجَّل تصرفات هذا المستخدم' : '🟢 مفعّل — جميع تصرفاته محفوظة في السجل'}
                            </div>
                          </div>
                        </div>
                        <label style={{ position: 'relative', display: 'inline-block', width: 56, height: 30, cursor: 'pointer', flexShrink: 0 }}>
                          <input type="checkbox" checked={!draftDisableActLog} onChange={e => setDraftDisableActLog(!e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                          <span style={{ position: 'absolute', inset: 0, background: !draftDisableActLog ? '#22c55e' : '#e2e8f0', borderRadius: 30, transition: 'background 0.2s' }} />
                          <span style={{ position: 'absolute', top: 5, left: !draftDisableActLog ? 31 : 5, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
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
    const companies = u.companyAssignments ?? [];
    const primaryCa = companies.find(ca => ca.isPrimary) ?? companies[0];
    const extraCompanies = companies.filter(ca => ca.companyId !== primaryCa?.companyId);
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{u.displayName || u.username}</span>
              {extraCompanies.length > 0 && (
                <span
                  title={`شركات إضافية: ${extraCompanies.map(ca => ca.company.name).join('، ')}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 2,
                    background: '#ede9fe', color: '#5b21b6', borderRadius: 20,
                    padding: '1px 7px', fontSize: 10, fontWeight: 700, flexShrink: 0,
                  }}
                >🏭 +{extraCompanies.length}</span>
              )}
            </div>
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
      // Only place the user under their primary company's chart — secondary
      // companies are indicated with a small badge on the card, not a duplicate node.
      const primaryCa = userCompanies.find(ca => ca.isPrimary) ?? userCompanies[0];
      let cg = og.companyGroups.find(g => g.company?.id === primaryCa.company.id);
      if (!cg) { cg = { company: primaryCa.company, users: [] }; og.companyGroups.push(cg); }
      if (!cg.users.find(x => x.id === u.id)) cg.users.push(u);
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
          <UserFormFields form={form} setForm={setForm} offices={offices} companies={companies} isEdit={Boolean(form.id)} />
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

function UserFormFields({ form, setForm, offices, companies, isEdit }: { form: any; setForm: any; offices: Office[]; companies: Company[]; isEdit: boolean }) {
  const officeCompanies = form.officeId ? companies.filter(c => c.officeId === Number(form.officeId)) : [];
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
        <select value={form.officeId || ''} onChange={e => setForm((f: any) => ({ ...f, officeId: e.target.value ? Number(e.target.value) : null, companyId: null }))}
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
          <option value="">-- بدون مكتب --</option>
          {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      {officeCompanies.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>الشركة</label>
          <select value={form.companyId || ''} onChange={e => setForm((f: any) => ({ ...f, companyId: e.target.value ? Number(e.target.value) : null }))}
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
            <option value="">-- بدون شركة --</option>
            {officeCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
    </>
  );
}
