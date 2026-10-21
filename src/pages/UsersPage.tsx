import { useState, useEffect, useCallback } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import ProvinceRepsToggle, { useProvinceRepScope } from '../components/ProvinceRepsToggle';

interface ScientificRep { id: number; name: string; }

interface User {
  id: number;
  username: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  linkedRepId: number | null;
  linkedRep: ScientificRep | null;
}

interface CompanyMember {
  id: number;
  username: string;
  role: string;
  isActive: boolean;
  linkedRepId: number | null;
  linkedRep: ScientificRep | null;
  displayName?: string | null;
  areas: AreaItem[];
  companies: { id: number; name: string; isPrimary?: boolean }[];
  managerIds?: number[];
  isProvinceMember?: boolean;
}

interface AreaItem {
  id: number; name: string;
  province?: string | null;
  subProvince?: string | null;       // الكرخ / الرصافة
  subProvinceOrder?: number | null;
}

const NO_PROVINCE = 'بلا محافظة';

/** «منطقة عمل» = القسم إن وُجد (بغداد — الكرخ) وإلا المحافظة. */
interface Region<T> { key: string; province: string; sub: string | null; subOrder: number | null; areas: T[]; }
const regionLabel = (r: { province: string; sub: string | null }) => r.sub ? `${r.province} — ${r.sub}` : r.province;
const subSort = (a: { sub: string | null; subOrder: number | null }, b: { sub: string | null; subOrder: number | null }) =>
  (a.sub ? 0 : 1) - (b.sub ? 0 : 1) || (a.subOrder ?? 999) - (b.subOrder ?? 999) || (a.sub || '').localeCompare(b.sub || '', 'ar');

/** تجميع المناطق حسب (المحافظة × القسم): المحافظة الأكبر أولاً، وداخلها الكرخ ثم الرصافة ثم بلا قسم. */
function groupByRegion<T extends AreaItem>(areas: T[]): Region<T>[] {
  const map = new Map<string, Region<T>>();
  const provCount = new Map<string, number>();
  for (const a of areas) {
    const province = a.province || NO_PROVINCE;
    const sub = a.province ? (a.subProvince || null) : null;
    const key = `${province}|${sub ?? ''}`;
    if (!map.has(key)) map.set(key, { key, province, sub, subOrder: a.subProvinceOrder ?? null, areas: [] });
    map.get(key)!.areas.push(a);
    provCount.set(province, (provCount.get(province) || 0) + 1);
  }
  return [...map.values()]
    .map(r => ({ ...r, areas: r.areas.sort((x, y) => x.name.localeCompare(y.name, 'ar')) }))
    .sort((a, b) =>
      (a.province === NO_PROVINCE ? 1 : 0) - (b.province === NO_PROVINCE ? 1 : 0)
      || (provCount.get(b.province)! - provCount.get(a.province)!)
      || a.province.localeCompare(b.province, 'ar')
      || subSort(a, b));
}
/** تجميع المناطق حسب المحافظة — الأكبر أولاً، «بلا محافظة» آخراً. */
function groupByProvince<T extends AreaItem>(areas: T[]): { province: string; areas: T[] }[] {
  const map = new Map<string, T[]>();
  for (const a of areas) {
    const k = a.province || NO_PROVINCE;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(a);
  }
  return [...map.entries()]
    .map(([province, list]) => ({ province, areas: list.sort((x, y) => x.name.localeCompare(y.name, 'ar')) }))
    .sort((a, b) => (a.province === NO_PROVINCE ? 1 : 0) - (b.province === NO_PROVINCE ? 1 : 0) || b.areas.length - a.areas.length);
}
interface LockedArea { name: string; reason: 'outside' | 'province'; }

const NO_AREAS_SECTION = 'بلا مناطق';
const ROLE_RANK: Record<string, number> = { supervisor: 0, team_leader: 1 };

/**
 * تصفيط الموظفين في أقسام حسب منطقة عملهم الغالبة (أكثر قسم/محافظة فيه
 * مناطق له): بغداد — الكرخ، بغداد — الرصافة، ثم بقية المحافظات، و«بلا مناطق» آخراً.
 * داخل القسم: المشرف/التيم ليدر أولاً ثم بالاسم.
 */
function memberSections<M extends { areas: AreaItem[]; role: string; username: string; displayName?: string | null }>(members: M[]) {
  type Sec = { key: string; province: string; sub: string | null; subOrder: number | null; members: M[] };
  const map = new Map<string, Sec>();
  for (const m of members) {
    const regions = groupByRegion(m.areas);
    const main = regions.reduce<Region<AreaItem> | null>((best, r) => (!best || r.areas.length > best.areas.length ? r : best), null);
    const key = main ? main.key : NO_AREAS_SECTION;
    if (!map.has(key)) {
      map.set(key, main
        ? { key, province: main.province, sub: main.sub, subOrder: main.subOrder, members: [] }
        : { key, province: NO_AREAS_SECTION, sub: null, subOrder: null, members: [] });
    }
    map.get(key)!.members.push(m);
  }
  const provCount = new Map<string, number>();
  for (const s of map.values()) provCount.set(s.province, (provCount.get(s.province) || 0) + s.members.length);
  const last = (p: string) => (p === NO_AREAS_SECTION ? 2 : p === NO_PROVINCE ? 1 : 0);
  return [...map.values()]
    .map(s => ({
      ...s,
      members: s.members.sort((a, b) =>
        (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
        || (a.displayName || a.username).localeCompare(b.displayName || b.username, 'ar')),
    }))
    .sort((a, b) =>
      last(a.province) - last(b.province)
      || provCount.get(b.province)! - provCount.get(a.province)!
      || a.province.localeCompare(b.province, 'ar')
      || subSort(a, b));
}

const NO_COMPANY_SECTION = 'بلا شركة';
/** عرض المكتب يُظهر الميدان فقط: التيم ليدر والمندوب العلمي — لا إدارة المكتب/الشركات. */
const OFFICE_VIEW_ROLES = new Set(['team_leader', 'scientific_rep']);
/** عضو محافظة = معلَّم من فرق المحافظات، أو كل مناطقه خارج بغداد. */
const isProvinceSide = (m: { isProvinceMember?: boolean; areas: AreaItem[] }) =>
  !!m.isProvinceMember || (m.areas.length > 0 && !m.areas.some(a => a.province === 'بغداد'));
const HIER_RANK: Record<string, number> = {
  company_manager: 0, product_manager: 1, supervisor: 2, commercial_supervisor: 2,
  team_leader: 3, commercial_team_leader: 3,
};
interface MemberNode<M> { member: M; children: MemberNode<M>[]; }

/**
 * عرض المكتب: أقسام حسب الشركة (الرئيسية للموظف، وإلا أول شركة)، وداخل كل شركة
 * شجرة الهيكلية من UserManagerAssignment: مدير الشركة ← التيم ليدر ← المندوبين.
 * من لا مدير له داخل نفس الشركة يظهر في أعلى الشجرة. موظف المكتب لا يُحتسب مديراً
 * (يُعيَّن «مديراً» فقط لرؤية الزيارات — نفس منطق getCompanyOrg).
 */
function companySections<M extends { id: number; role: string; username: string; displayName?: string | null;
  companies: { id: number; name: string; isPrimary?: boolean }[]; managerIds?: number[] }>(members: M[]) {
  const homeOf = (m: M) => m.companies.find(c => c.isPrimary) ?? m.companies[0] ?? null;
  const byCompany = new Map<string, { key: string; name: string; members: M[] }>();
  for (const m of members) {
    const c = homeOf(m);
    const key = c ? String(c.id) : NO_COMPANY_SECTION;
    if (!byCompany.has(key)) byCompany.set(key, { key, name: c ? c.name : NO_COMPANY_SECTION, members: [] });
    byCompany.get(key)!.members.push(m);
  }
  const cmp = (a: M, b: M) =>
    (HIER_RANK[a.role] ?? 9) - (HIER_RANK[b.role] ?? 9)
    || (a.displayName || a.username).localeCompare(b.displayName || b.username, 'ar');

  return [...byCompany.values()]
    .map(sec => {
      const inSec = new Map(sec.members.map(m => [m.id, m]));
      const nodes = new Map(sec.members.map(m => [m.id, { member: m, children: [] } as MemberNode<M>]));
      const roots: MemberNode<M>[] = [];
      for (const m of sec.members) {
        // أعلى مدير رتبةً داخل نفس الشركة (غير موظف مكتب)
        const parent = (m.managerIds ?? [])
          .map(id => inSec.get(id))
          .filter((p): p is M => !!p && p.id !== m.id && p.role !== 'office_employee')
          .sort((a, b) => (HIER_RANK[b.role] ?? 9) - (HIER_RANK[a.role] ?? 9))[0];
        if (parent) nodes.get(parent.id)!.children.push(nodes.get(m.id)!);
        else roots.push(nodes.get(m.id)!);
      }
      // حلقة في الهيكلية (أ مدير ب وب مدير أ): من لم يُصَل إليه من الجذور يصبح جذراً
      const reached = new Set<number>();
      const walk = (n: MemberNode<M>) => { if (reached.has(n.member.id)) return; reached.add(n.member.id); n.children.forEach(walk); };
      roots.forEach(walk);
      for (const n of nodes.values()) if (!reached.has(n.member.id)) { roots.push(n); walk(n); }
      const sortTree = (list: MemberNode<M>[]) => { list.sort((a, b) => cmp(a.member, b.member)); list.forEach(n => sortTree(n.children)); };
      sortTree(roots);
      return { ...sec, roots };
    })
    .sort((a, b) =>
      (a.key === NO_COMPANY_SECTION ? 1 : 0) - (b.key === NO_COMPANY_SECTION ? 1 : 0)
      || b.members.length - a.members.length
      || a.name.localeCompare(b.name, 'ar'));
}

const ALL_ROLES: { value: string; label: string }[] = [
  { value: 'user',                   label: '👤 مستخدم' },
  { value: 'scientific_rep',         label: '🔬 مندوب علمي' },
  { value: 'team_leader',            label: '🎯 قائد فريق' },
  { value: 'supervisor',             label: '🔷 مشرف' },
  { value: 'product_manager',        label: '📦 مدير منتج' },
  { value: 'company_manager',        label: '🏭 مدير شركة' },
  { value: 'office_manager',         label: '🏢 مدير مكتب' },
  { value: 'commercial_rep',         label: '💼 مندوب تجاري' },
  { value: 'commercial_team_leader', label: '💼 قائد فريق تجاري' },
  { value: 'commercial_supervisor',  label: '💼 مشرف تجاري' },
  { value: 'manager',                label: '🛡️ مدير الفريق' },
  { value: 'admin',                  label: '👑 مدير النظام' },
];

type ModalType = 'add' | 'edit' | 'password' | null;

export default function UsersPage() {
  const { user: currentUser, token } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  // مدير الشركة و HR المكتب: عرض أعضاء الفريق + تعديل مناطقهم ضمن نطاقهم (company-members)
  // مدير المكتب / موظف المكتب / HR: نفس القائمة لكن مصفوفة حسب الشركة ← التيم ليدر ← المندوبين
  const isOfficeView = currentUser?.role === 'office_manager' || currentUser?.role === 'office_employee' || currentUser?.role === 'office_hr';
  const isCompanyManager = currentUser?.role === 'company_manager' || isOfficeView;

  const [users, setUsers]     = useState<User[]>([]);
  const [sciReps, setSciReps] = useState<ScientificRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modal, setModal]     = useState<ModalType>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [saving, setSaving]   = useState(false);

  // Company manager: company members view
  const [companyMembers, setCompanyMembers]       = useState<CompanyMember[]>([]);
  const [membersLoading, setMembersLoading]       = useState(true);
  const [membersError, setMembersError]           = useState('');
  const [canEditMembers, setCanEditMembers]       = useState(true);
  const [onlyProvince, setOnlyProvince]           = useProvinceRepScope('users');
  const [areasModalMember, setAreasModalMember]   = useState<CompanyMember | null>(null);
  // تعديل اسم الموظف + تفعيل/تعطيل حسابه (PATCH /api/company-members/:id)
  const [accountMember, setAccountMember]         = useState<CompanyMember | null>(null);
  const [accName, setAccName]                     = useState('');
  const [accActive, setAccActive]                 = useState(true);
  const [accSaving, setAccSaving]                 = useState(false);

  // Back button: close open modals in priority order
  useBackHandler([
    [accountMember !== null,    () => setAccountMember(null)],
    [areasModalMember !== null, () => setAreasModalMember(null)],
    [modal !== null,            () => setModal(null)],
  ]);
  const [allAreas, setAllAreas]                   = useState<AreaItem[]>([]);
  const [selectedAreaIds, setSelectedAreaIds]     = useState<Set<number>>(new Set());
  const [areasLoading, setAreasLoading]           = useState(false);
  const [areasSaving, setAreasSaving]             = useState(false);
  const [lockedAreas, setLockedAreas]             = useState<LockedArea[]>([]);
  // مناطق داخلة عبر تعيين محافظة/قسم — محدَّدة وقابلة للتعديل، تُعلَّم بـ🗺️
  const [provinceAreaIds, setProvinceAreaIds]     = useState<Set<number>>(new Set());
  const [scopeIsEmpty, setScopeIsEmpty]           = useState(false);
  const [areaSearch, setAreaSearch]               = useState('');
  const [openProvinces, setOpenProvinces]         = useState<Set<string>>(new Set());
  const [expandedMembers, setExpandedMembers]     = useState<Set<number>>(new Set());
  const [memberSearch, setMemberSearch]           = useState('');

  // Form fields
  const [fUsername,     setFUsername]     = useState('');
  const [fPassword,     setFPassword]     = useState('');
  const [fRole,         setFRole]         = useState<string>('user');
  const [fIsActive,     setFIsActive]     = useState(true);
  const [fLinkedRepId,  setFLinkedRepId]  = useState<number | ''>('');
  const [fNewPass,      setFNewPass]      = useState('');
  const [fConfirm,      setFConfirm]      = useState('');

  const load = useCallback(async () => {
    if (isCompanyManager) {
      setMembersLoading(true);
      setMembersError('');
      try {
        const r = await fetch('/api/company-members', { headers: authH() });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'فشل تحميل أعضاء الشركة');
        setCompanyMembers(j.data ?? []);
        setCanEditMembers(j.canEdit !== false);
      } catch (err: any) { setMembersError(err.message || 'فشل تحميل أعضاء الشركة'); }
      finally { setMembersLoading(false); }
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [ur, rr] = await Promise.all([
        fetch('/api/admin/users', { headers: authH() }),
        fetch('/api/scientific-reps', { headers: authH() }),
      ]);
      const uj = await ur.json();
      const rj = await rr.json();
      if (!ur.ok) throw new Error(uj.error || 'فشل تحميل المستخدمين');
      setUsers(Array.isArray(uj.data) ? uj.data : []);
      const repsArr = Array.isArray(rj) ? rj : Array.isArray(rj?.data) ? rj.data : [];
      setSciReps(repsArr.map((r: any) => ({ id: r.id, name: r.name })));
    } catch (err: any) { setError(err.message || 'فشل تحميل المستخدمين'); }
    finally   { setLoading(false); }
  }, [isCompanyManager]);

  useEffect(() => { load(); }, [load]);

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      if (action === 'open-add-user') {
        setFUsername(''); setFPassword(''); setFRole('scientific_rep'); setFIsActive(true); setFLinkedRepId('');
        setSelected(null);
        setModal('add');
      }
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  const openAdd = () => {
    setFUsername(''); setFPassword(''); setFRole('scientific_rep'); setFIsActive(true); setFLinkedRepId('');
    setSelected(null);
    setModal('add');
  };

  const openEdit = (u: User) => {
    setSelected(u);
    setFUsername(u.username);
    setFRole(u.role);
    setFIsActive(u.isActive);
    setFLinkedRepId(u.linkedRepId ?? '');
    setFPassword('');
    setModal('edit');
  };

  const openChangePassword = (u: User) => {
    setSelected(u);
    setFNewPass(''); setFConfirm('');
    setModal('password');
  };

  const saveUser = async () => {
    if (!fUsername.trim()) return setError('اسم المستخدم مطلوب.');
    if (modal === 'add' && (!fPassword || fPassword.length < 6)) return setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    setSaving(true);
    try {
      const body: any = {
        username: fUsername.trim(),
        role: fRole,
        isActive: fIsActive,
        linkedRepId: (fRole === 'user' || fRole === 'scientific_rep') && fLinkedRepId !== '' ? fLinkedRepId : null,
      };
      if (modal === 'add') body.password = fPassword;

      const url    = modal === 'add' ? '/api/admin/users' : `/api/admin/users/${selected!.id}`;
      const method = modal === 'add' ? 'POST' : 'PATCH';
      const r      = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(body) });
      const j      = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل الحفظ');
      setModal(null);
      load();
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const savePassword = async () => {
    if (!fNewPass || fNewPass.length < 6) return setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    if (fNewPass !== fConfirm) return setError('كلمات المرور غير متطابقة.');
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/users/${selected!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ password: fNewPass }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل تغيير كلمة المرور');
      setModal(null);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const deleteUser = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم وجميع بياناته؟')) return;
    let r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: authH() });
    // If the user has activity data that blocks a normal delete, offer a force delete.
    if (r.status === 409) {
      const j = await r.json().catch(() => ({}));
      if (j.code === 'HAS_DEPENDENCIES') {
        const ok = confirm(
          'لهذا المستخدم بيانات مرتبطة (بلان يومي، فواتير تجارية، كشوفات استحصال، إعجابات/تعليقات على الزيارات).\n\n' +
          '⚠️ الحذف النهائي سيحذف هذه البيانات نهائياً ولا يمكن التراجع.\n' +
          '(المبيعات والملفات والكيانات المشتركة — الأطباء/الصيدليات/الايتمات/المناطق — تبقى في النظام دون نسبتها له.)\n\n' +
          'هل تريد الحذف النهائي مع كل بياناته؟'
        );
        if (!ok) return;
        r = await fetch(`/api/admin/users/${id}?force=1`, { method: 'DELETE', headers: authH() });
      }
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(j.error || 'فشل الحذف');
      return;
    }
    load();
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString('ar-SA');

  const ROLE_LABELS: Record<string, string> = {
    scientific_rep: '🔬 مندوب علمي', team_leader: '🎯 قائد فريق', supervisor: '🔷 مشرف',
    product_manager: '📦 مدير منتج', company_manager: '🏭 مدير شركة',
    office_manager: '🏢 مدير مكتب', commercial_rep: '💼 مندوب تجاري',
    commercial_team_leader: '💼 قائد تجاري', commercial_supervisor: '💼 مشرف تجاري',
    manager: '🛡️ مدير', admin: '👑 أدمن', user: '👤 مستخدم',
  };

  const openAreasModal = async (member: CompanyMember) => {
    setAreasModalMember(member);
    setSelectedAreaIds(new Set());
    setAllAreas([]);
    setLockedAreas([]);
    setProvinceAreaIds(new Set());
    setScopeIsEmpty(false);
    setAreaSearch('');
    setAreasLoading(true);
    try {
      const r = await fetch(`/api/company-members/${member.id}/areas`, { headers: authH() });
      const j = await r.json();
      if (r.ok) {
        const opts: AreaItem[] = j.allAreas ?? [];
        const sel = new Set<number>(j.assignedAreaIds ?? []);
        setAllAreas(opts);
        setSelectedAreaIds(sel);
        // افتح فقط المحافظات التي فيها مناطق محددة؛ إن كانت محافظة واحدة افتحها
        const groups = groupByProvince(opts);
        const open = new Set(groups.filter(g => g.areas.some(a => sel.has(a.id))).map(g => g.province));
        if (groups.length === 1) open.add(groups[0].province);
        setOpenProvinces(open);
        setLockedAreas(j.lockedAreas ?? []);
        setProvinceAreaIds(new Set<number>(j.provinceAreaIds ?? []));
        setScopeIsEmpty(!!j.scopeIsEmpty);
      } else {
        alert(j.error || 'فشل تحميل المناطق');
        setAreasModalMember(null);
      }
    } catch { /* keep existing */ }
    finally { setAreasLoading(false); }
  };

  const saveAreas = async () => {
    if (!areasModalMember) return;
    setAreasSaving(true);
    try {
      const r = await fetch(`/api/company-members/${areasModalMember.id}/areas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ areaIds: [...selectedAreaIds] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل حفظ المناطق');
      // Update member's areas locally
      setCompanyMembers(prev => prev.map(m =>
        m.id === areasModalMember.id ? { ...m, areas: j.areas ?? [] } : m
      ));
      setAreasModalMember(null);
      window.dispatchEvent(new Event('areas-changed'));
    } catch (err: any) { alert(err.message || 'فشل حفظ المناطق'); }
    finally { setAreasSaving(false); }
  };

  const openAccountModal = (member: CompanyMember) => {
    setAccountMember(member);
    setAccName(member.displayName || member.username);
    setAccActive(member.isActive);
  };

  const saveAccount = async () => {
    if (!accountMember) return;
    const name = accName.replace(/\s+/g, ' ').trim();
    if (!name) return alert('الاسم لا يمكن أن يكون فارغاً.');
    if (!accActive && accountMember.isActive &&
        !confirm(`تعطيل حساب «${name}»؟\nلن يستطيع تسجيل الدخول، ويُسجَّل خروجه خلال دقيقة إن كان متصلاً.`)) return;
    setAccSaving(true);
    try {
      const r = await fetch(`/api/company-members/${accountMember.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ displayName: name, isActive: accActive }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل حفظ الحساب');
      setCompanyMembers(prev => prev.map(m =>
        m.id === accountMember.id
          ? { ...m, displayName: j.data?.displayName ?? name, isActive: j.data?.isActive ?? accActive }
          : m
      ));
      setAccountMember(null);
    } catch (err: any) { alert(err.message || 'فشل حفظ الحساب'); }
    finally { setAccSaving(false); }
  };

  // عرض المكتب: التيم ليدر + المندوبون العلميون فقط، بغداد افتراضياً و«مندوبي المحافظات» بالزر
  const officeFieldMembers = companyMembers
    .filter(m => OFFICE_VIEW_ROLES.has(m.role))
    .map(m => ({ ...m, isProvinceMember: isProvinceSide(m) }));
  const visibleMembers = isOfficeView
    ? officeFieldMembers.filter(m => m.isProvinceMember === onlyProvince)
    : companyMembers;

  // ── Company Manager View ─────────────────────────────────────
  if (isCompanyManager) {
    return (
      <div className="page">
        <div className="page-header" style={{ justifyContent: 'flex-end' }}>
          <button onClick={load} style={{ fontSize: 13, padding: '6px 14px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>🔄 تحديث</button>
        </div>

        {membersError && <div className="alert alert--error">{membersError}</div>}

        {membersLoading ? (
          <div className="loading-spinner">جاري التحميل...</div>
        ) : companyMembers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
            <p>لا يوجد موظفون تابعون لك حتى الآن</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>يربط السوبر أدمن الموظفين بك من تبويب «المدراء» في حساباتهم</p>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <input
                value={memberSearch}
                onChange={e => setMemberSearch(e.target.value)}
                placeholder={isOfficeView ? "🔍 بحث باسم الموظف أو الشركة أو المنطقة..." : "🔍 بحث باسم الموظف أو المنطقة..."}
                style={{ flex: '1 1 240px', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 13 }}
              />
              {isOfficeView && <ProvinceRepsToggle reps={officeFieldMembers} value={onlyProvince} onChange={setOnlyProvince} />}
              <span style={{ fontSize: 12, color: '#64748b' }}>{visibleMembers.length} موظف</span>
            </div>
            {(() => {
              const q = memberSearch.trim();
              const filtered = visibleMembers.filter(m =>
                !q || (m.displayName || '').includes(q) || m.username.includes(q) || m.areas.some(a => a.name.includes(q))
                || m.companies.some(c => c.name.includes(q)));

              // صف موظف واحد — depth = مستوى التداخل في شجرة الشركة (عرض المكتب)
              const renderMember = (member: CompanyMember, idx: number, depth = 0, childCount = 0) => {
                const name = member.displayName || member.username;
                const groups = groupByRegion(member.areas);
                const expanded = expandedMembers.has(member.id);
                const toggle = () => setExpandedMembers(prev => {
                  const next = new Set(prev);
                  if (next.has(member.id)) next.delete(member.id); else next.add(member.id);
                  return next;
                });
                const isLead = childCount > 0;
                return (
                  <div key={member.id} style={{
                    borderTop: idx ? '1px solid #f1f5f9' : 'none',
                    background: !member.isActive ? '#fef2f2' : isLead ? '#fafaff' : undefined,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', paddingInlineStart: 16 + depth * 28, flexWrap: 'wrap' }}>
                      {depth > 0 && <span style={{ color: '#cbd5e1', fontSize: 14, marginInlineEnd: -6 }}>└</span>}
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                        background: isLead ? '#4f46e5' : '#eef2ff', color: isLead ? '#fff' : '#4f46e5',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 16,
                      }}>{name[0]?.toUpperCase()}</div>

                      <div style={{ minWidth: 150, flex: '0 1 220px' }}>
                        <div style={{ fontWeight: isLead ? 900 : 700, fontSize: 14, color: '#1e293b' }}>{name}</div>
                        <div style={{ fontSize: 11, color: '#6366f1', marginTop: 2 }}>
                          {ROLE_LABELS[member.role] ?? member.role}
                          {isLead && <span style={{ color: '#64748b', marginRight: 6 }}>· {childCount} تحته</span>}
                          {!member.isActive && <span style={{ color: '#ef4444', marginRight: 6 }}>● غير نشط</span>}
                        </div>
                      </div>

                      {/* ملخّص: عدد المناطق + توزيعها على المحافظات */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {member.areas.length === 0 ? (
                          <span style={{ fontSize: 12, color: '#94a3b8' }}>لا مناطق محددة</span>
                        ) : (
                          <>
                            <span style={{ fontSize: 12, fontWeight: 800, color: '#0369a1', background: '#e0f2fe', padding: '3px 10px', borderRadius: 12 }}>
                              📍 {member.areas.length} منطقة
                            </span>
                            {groups.slice(0, 4).map(g => (
                              <span key={g.key} title={regionLabel(g)} style={{ fontSize: 11, color: '#475569', background: '#f1f5f9', padding: '3px 8px', borderRadius: 12 }}>
                                {g.sub || g.province} <b>{g.areas.length}</b>
                              </span>
                            ))}
                            {groups.length > 4 && <span style={{ fontSize: 11, color: '#94a3b8' }}>+{groups.length - 4}</span>}
                          </>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {member.areas.length > 0 && (
                          <button onClick={toggle} style={{
                            padding: '6px 10px', fontSize: 12, fontWeight: 600, background: '#f8fafc', color: '#475569',
                            border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer',
                          }}>{expanded ? '▴ إخفاء' : '▾ عرض'}</button>
                        )}
                        {canEditMembers && (
                          <>
                            <button onClick={() => openAccountModal(member)} style={{
                              padding: '6px 12px', fontSize: 12, fontWeight: 700, background: '#f8fafc', color: '#334155',
                              border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                            }}>👤 تعديل الحساب</button>
                            <button onClick={() => openAreasModal(member)} style={{
                              padding: '6px 12px', fontSize: 12, fontWeight: 700, background: '#eef2ff', color: '#4f46e5',
                              border: '1px solid #c7d2fe', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                            }}>✏️ تعديل المناطق</button>
                          </>
                        )}
                      </div>
                    </div>

                    {expanded && (
                      <div style={{ padding: '0 16px 12px 16px', paddingInlineStart: 16 + depth * 28, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {groups.map(g => (
                          <div key={g.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline', background: '#f8fafc', borderRadius: 8, padding: '6px 10px' }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color: '#334155', minWidth: 120, flexShrink: 0 }}>
                              🗺️ {regionLabel(g)} <span style={{ color: '#94a3b8', fontWeight: 600 }}>({g.areas.length})</span>
                            </span>
                            <span style={{ fontSize: 12, color: '#475569', lineHeight: 1.8 }}>
                              {g.areas.map(a => a.name).join(' · ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              };

              const sectionHeader = (icon: string, label: string, count: number) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 8px' }}>
                  <span style={{ fontSize: 14, fontWeight: 900, color: '#1e293b' }}>{icon} {label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#4f46e5', background: '#eef2ff', padding: '2px 8px', borderRadius: 10 }}>
                    {count}
                  </span>
                  <span style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
                </div>
              );

              // ── عرض المكتب: الشركة ← التيم ليدر ← المندوبين ──
              if (isOfficeView) {
                return companySections(filtered).map(section => {
                  const rows: JSX.Element[] = [];
                  const countAll = (n: MemberNode<CompanyMember>): number => n.children.reduce((s, c) => s + 1 + countAll(c), 0);
                  const walk = (n: MemberNode<CompanyMember>, depth: number) => {
                    rows.push(renderMember(n.member, rows.length, depth, countAll(n)));
                    n.children.forEach(c => walk(c, depth + 1));
                  };
                  section.roots.forEach(r => walk(r, 0));
                  return (
                    <div key={section.key} style={{ marginBottom: 18 }}>
                      {sectionHeader(section.key === NO_COMPANY_SECTION ? '⚪' : '🏢', section.name, section.members.length)}
                      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                        {rows}
                      </div>
                    </div>
                  );
                });
              }

              // ── عرض مدير الشركة: حسب منطقة العمل ──
              return memberSections(filtered).map(section => (
                <div key={section.key} style={{ marginBottom: 18 }}>
                  {sectionHeader(section.province === NO_AREAS_SECTION ? '⚪' : '🗺️', regionLabel(section), section.members.length)}
                  <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                    {section.members.map((member, idx) => renderMember(member, idx))}
                  </div>
                </div>
              ));
            })()}
          </>
        )}

        {/* ── Account Modal: الاسم + التفعيل ── */}
        {accountMember && (
          <div className="modal-overlay" onClick={() => setAccountMember(null)}>
            <div className="modal" style={{ maxWidth: 440, width: '95vw' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>👤 تعديل حساب {accountMember.displayName || accountMember.username}</h2>
                <button className="modal-close" onClick={() => setAccountMember(null)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">الاسم</label>
                  <input className="form-input" value={accName} onChange={e => setAccName(e.target.value)} maxLength={120} />
                  <small style={{ color: '#64748b', fontSize: 12 }}>
                    يتغيّر الاسم عند السوبر أدمن وفي كل الحسابات والتقارير. اسم الدخول ({accountMember.username}) لا يتغيّر.
                  </small>
                </div>
                <div className="form-group">
                  <label className="form-label">حالة الحساب</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[true, false].map(v => (
                      <button key={String(v)} type="button" onClick={() => setAccActive(v)} style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                        border: `1.5px solid ${accActive === v ? (v ? '#10b981' : '#ef4444') : '#e2e8f0'}`,
                        background: accActive === v ? (v ? '#ecfdf5' : '#fef2f2') : '#fff',
                        color: accActive === v ? (v ? '#047857' : '#b91c1c') : '#64748b',
                      }}>{v ? '✅ مفعّل' : '🚫 معطّل'}</button>
                    ))}
                  </div>
                  {!accActive && (
                    <small style={{ color: '#b91c1c', fontSize: 12 }}>الحساب المعطّل لا يستطيع تسجيل الدخول. بياناته ومناطقه تبقى كما هي.</small>
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn--secondary" onClick={() => setAccountMember(null)}>إلغاء</button>
                <button className="btn btn--primary" onClick={saveAccount} disabled={accSaving}>
                  {accSaving ? '⏳ جاري الحفظ...' : '💾 حفظ'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Areas Modal ── */}
        {areasModalMember && (
          <div className="modal-overlay" onClick={() => setAreasModalMember(null)}>
            <div className="modal" style={{ maxWidth: 600, width: '95vw' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>📍 مناطق عمل {areasModalMember.displayName || areasModalMember.username}</h2>
                <button className="modal-close" onClick={() => setAreasModalMember(null)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
                  القائمة تعرض مناطقك أنت فقط. التعديل يُحفظ مباشرةً في نفس مناطق المندوب لدى السوبر أدمن ويظهر لكل الحسابات فوراً.
                </p>
                {lockedAreas.length > 0 && (
                  <div style={{ marginBottom: 10, padding: '8px 10px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>🔒 مناطق أخرى للمندوب (من السوبر أدمن — لا تتأثر بحفظك):</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {lockedAreas.map(a => (
                        <span key={a.name} title={a.reason === 'province' ? 'عبر تعيين محافظة' : 'خارج نطاق مناطقك'} style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 12, background: '#e2e8f0', color: '#475569',
                        }}>{a.reason === 'province' ? '🗺️' : '🔒'} {a.name}</span>
                      ))}
                    </div>
                  </div>
                )}
                {!areasLoading && allAreas.length > 0 && (
                  <div style={{ fontSize: 12, color: '#4f46e5', fontWeight: 700, marginBottom: 6 }}>
                    المحدد: {selectedAreaIds.size} من {allAreas.length}
                  </div>
                )}
                {!areasLoading && provinceAreaIds.size > 0 && (
                  <div style={{ fontSize: 11.5, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>
                    🗺️ {provinceAreaIds.size} منطقة آتية من تعيين محافظة كاملة. إبقاؤها كلها يُبقي التعيين كما هو (تصله المناطق الجديدة تلقائياً)؛
                    إلغاء أي منها يحوّل التعيين إلى مناطق مفردة.
                  </div>
                )}
                {!areasLoading && allAreas.length > 8 && (
                  <input
                    value={areaSearch}
                    onChange={e => setAreaSearch(e.target.value)}
                    placeholder="🔍 بحث عن منطقة..."
                    style={{ width: '100%', padding: '7px 10px', marginBottom: 8, border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
                  />
                )}
                {areasLoading ? (
                  <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8' }}>⏳ جاري التحميل...</div>
                ) : scopeIsEmpty ? (
                  <div style={{ textAlign: 'center', padding: 20, color: '#b45309' }}>لم تُحدَّد لحسابك مناطق بعد — اطلب من السوبر أدمن تحديد مناطقك أولاً.</div>
                ) : (
                  <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {groupByProvince(allAreas.filter(a => !areaSearch.trim() || a.name.includes(areaSearch.trim()))).map(g => {
                      const ids = g.areas.map(a => a.id);
                      const selCount = ids.filter(id => selectedAreaIds.has(id)).length;
                      const isOpen = !!areaSearch.trim() || openProvinces.has(g.province);
                      const setAll = (on: boolean) => setSelectedAreaIds(prev => {
                        const next = new Set(prev);
                        ids.forEach(id => { if (on) next.add(id); else next.delete(id); });
                        return next;
                      });
                      return (
                        <div key={g.province} style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: selCount ? '#eef2ff' : '#f8fafc' }}>
                            <input
                              type="checkbox"
                              checked={selCount === ids.length}
                              ref={el => { if (el) el.indeterminate = selCount > 0 && selCount < ids.length; }}
                              onChange={e => setAll(e.target.checked)}
                              style={{ width: 16, height: 16, accentColor: '#6366f1' }}
                              title="تحديد / إلغاء كل مناطق المحافظة"
                            />
                            <button
                              onClick={() => setOpenProvinces(prev => {
                                const next = new Set(prev);
                                if (next.has(g.province)) next.delete(g.province); else next.add(g.province);
                                return next;
                              })}
                              style={{ flex: 1, display: 'flex', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 800, color: '#1e293b' }}
                            >
                              <span>🗺️ {g.province}</span>
                              <span style={{ fontSize: 12, color: selCount ? '#4f46e5' : '#94a3b8', fontWeight: 700 }}>
                                {selCount}/{ids.length} {isOpen ? '▴' : '▾'}
                              </span>
                            </button>
                          </div>
                          {isOpen && (() => {
                            const grid = (list: AreaItem[]) => (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 4, padding: 8 }}>
                                {list.map(area => {
                                  const on = selectedAreaIds.has(area.id);
                                  return (
                                    <label key={area.id} style={{
                                      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                                      background: on ? '#eef2ff' : 'transparent', fontSize: 13, color: '#1e293b',
                                    }}>
                                      <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={e => setSelectedAreaIds(prev => {
                                          const next = new Set(prev);
                                          if (e.target.checked) next.add(area.id); else next.delete(area.id);
                                          return next;
                                        })}
                                        style={{ width: 14, height: 14, accentColor: '#6366f1' }}
                                      />
                                      {provinceAreaIds.has(area.id) && <span title="عبر تعيين محافظة" style={{ fontSize: 11 }}>🗺️</span>}
                                      {area.name}
                                    </label>
                                  );
                                })}
                              </div>
                            );
                            const subs = groupByRegion(g.areas);
                            // محافظة بلا أقسام: شبكة واحدة كما هي
                            if (subs.length === 1 && !subs[0].sub) return grid(g.areas);
                            // محافظة مقسَّمة (بغداد): الكرخ أولاً ثم الرصافة ثم ما لا قسم له
                            return subs.map(sg => {
                              const sIds = sg.areas.map(a => a.id);
                              const sSel = sIds.filter(id => selectedAreaIds.has(id)).length;
                              return (
                                <div key={sg.key} style={{ borderTop: '1px solid #f1f5f9' }}>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 2px', cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={sSel === sIds.length}
                                      ref={el => { if (el) el.indeterminate = sSel > 0 && sSel < sIds.length; }}
                                      onChange={e => setSelectedAreaIds(prev => {
                                        const next = new Set(prev);
                                        sIds.forEach(id => { if (e.target.checked) next.add(id); else next.delete(id); });
                                        return next;
                                      })}
                                      style={{ width: 14, height: 14, accentColor: '#0ea5e9' }}
                                    />
                                    <span style={{ fontSize: 12, fontWeight: 800, color: '#0369a1' }}>
                                      🏙️ {sg.sub || 'بلا قسم'}
                                    </span>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: sSel ? '#0369a1' : '#94a3b8' }}>
                                      {sSel}/{sIds.length}
                                    </span>
                                    <span style={{ flex: 1, height: 1, background: '#e0f2fe' }} />
                                  </label>
                                  {grid(sg.areas)}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn--secondary" onClick={() => setAreasModalMember(null)}>إلغاء</button>
                <button className="btn btn--primary" onClick={saveAreas} disabled={areasSaving}>
                  {areasSaving ? '⏳ جاري الحفظ...' : '💾 حفظ المناطق'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn--primary" onClick={openAdd}>{t.users.addBtn}</button>
      </div>

      {error && <div className="alert alert--error" onClick={() => setError('')}>{error} ✕</div>}

      {loading ? (
        <div className="loading-spinner">{t.common.loading}</div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t.users.colUsername}</th>
                <th>{t.users.colRole}</th>
                <th>المندوب المرتبط</th>
                <th>{t.reps.colStatus}</th>
                <th>{t.dashboard.colDate}</th>
                <th>{t.users.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td colSpan={7} className="empty-row">{t.users.noUsers}</td></tr>
              ) : users.map(u => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    <strong>{u.username}</strong>
                    {u.id === currentUser?.id && <span className="tag tag--blue" style={{ marginRight: 8 }}>أنت</span>}
                  </td>
                  <td>
                    <span className={`badge ${
                      u.role === 'admin' ? 'badge--purple'
                      : u.role === 'manager' ? 'badge--orange'
                      : u.role === 'company_manager' || u.role === 'office_manager' ? 'badge--orange'
                      : u.role === 'scientific_rep' || u.role === 'team_leader' || u.role === 'supervisor' ? 'badge--green'
                      : 'badge--blue'
                    }`}>
                      {ALL_ROLES.find(r => r.value === u.role)?.label ?? `👤 ${u.role}`}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, color: '#475569' }}>
                    {u.linkedRep ? (
                      <span className="tag tag--blue">🔬 {u.linkedRep.name}</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${u.isActive ? 'badge--green' : 'badge--red'}`}>
                      {u.isActive ? t.reps.active : t.reps.inactive}
                    </span>
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="action-btns">
                      <button className="btn-icon btn-icon--blue"   onClick={() => openEdit(u)}           title="تعديل">✏️</button>
                      <button className="btn-icon btn-icon--orange" onClick={() => openChangePassword(u)} title="تغيير كلمة المرور">🔑</button>
                      {u.id !== currentUser?.id && (
                        <button className="btn-icon btn-icon--red" onClick={() => deleteUser(u.id)} title="حذف">🗑️</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add / Edit Modal ── */}
      {(modal === 'add' || modal === 'edit') && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{modal === 'add' ? `➕ ${t.users.addTitle}` : `✏️ ${t.users.editTitle}`}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">{t.users.colUsername} *</label>
                <input className="form-input" value={fUsername} onChange={e => setFUsername(e.target.value)} placeholder={t.users.usernamePlaceholder} />
              </div>
              {modal === 'add' && (
                <div className="form-group">
                  <label className="form-label">{t.users.passwordPlaceholder} * (6+)</label>
                  <input className="form-input" type="password" value={fPassword} onChange={e => setFPassword(e.target.value)} placeholder="••••••••" />
                </div>
              )}
              <div className="form-group">
                <label className="form-label">{t.users.colRole}</label>
                <select className="form-input" value={fRole} onChange={e => setFRole(e.target.value)}>
                  {ALL_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              {(fRole === 'user' || fRole === 'scientific_rep') && (
                <div className="form-group">
                  <label className="form-label">🔬 ربط بمندوب علمي (اختياري)</label>
                  <select
                    className="form-input"
                    value={fLinkedRepId}
                    onChange={e => setFLinkedRepId(e.target.value === '' ? '' : parseInt(e.target.value))}
                  >
                    <option value="">— بدون ربط</option>
                    {sciReps.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <small style={{ color: '#64748b', fontSize: 12 }}>ربط هذا الحساب بمندوب علمي محدد حتى يستلم بلاناته.</small>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">{t.reps.colStatus}</label>
                <select className="form-input" value={fIsActive ? 'true' : 'false'} onChange={e => setFIsActive(e.target.value === 'true')}>
                  <option value="true">✅ {t.reps.active}</option>
                  <option value="false">🚫 {t.reps.inactive}</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>{t.users.cancel}</button>
              <button className="btn btn--primary" onClick={saveUser} disabled={saving}>
                {saving ? t.common.loading : `💾 ${t.users.save}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Password Modal ── */}
      {modal === 'password' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🔑 تغيير كلمة مرور: {selected?.username}</h2>
              <button className="modal-close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">كلمة المرور الجديدة *</label>
                <input className="form-input" type="password" value={fNewPass} onChange={e => setFNewPass(e.target.value)} placeholder="••••••••" />
              </div>
              <div className="form-group">
                <label className="form-label">تأكيد كلمة المرور *</label>
                <input className="form-input" type="password" value={fConfirm} onChange={e => setFConfirm(e.target.value)} placeholder="••••••••" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setModal(null)}>إلغاء</button>
              <button className="btn btn--primary" onClick={savePassword} disabled={saving}>
                {saving ? '⏳...' : '🔑 تغيير'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
