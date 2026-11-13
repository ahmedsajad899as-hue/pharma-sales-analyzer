// ════════════════════════════════════════════════════════════════════════════
// UsersDirectory — قائمة المستخدمين للسوبر أدمن: أقسام ثابتة + جدول هادئ + لوحة
// جانبية. الصف يعرض الأساس فقط، وكل تفصيلة وإجراء آخر في اللوحة أو قائمة «⋯».
// الجلب والحفظ يبقيان في UsersPage؛ هذا الملف عرض وتنقّل فقط.
// ════════════════════════════════════════════════════════════════════════════
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Spinner } from './OfficesPage';
import ProvinceSeatsPanel from './ProvinceSeatsPanel';
import type { ProvSeat } from './ProvinceSeatsPanel';
import ProvinceMarketersPanel from './ProvinceMarketersPanel';
import type { ProvMarketer, ProvMarketerManager } from './ProvinceMarketersPanel';
import { OFFICE_SCOPED_ROLES, formRoleOf, isMarketer, roleLabelOf } from './usersCommon';
import type { ProvTeam, RowMenuItem, RowOpts, UserRow } from './usersCommon';
import './UsersDirectory.css';

const ADMIN_ROLES = ['admin', 'manager'];
const ROLE_ORDER = ['company_manager', 'supervisor', 'product_manager', 'team_leader', 'scientific_rep', 'commercial_supervisor', 'commercial_team_leader', 'commercial_rep', 'office_manager', 'office_hr', 'office_employee'];
const sortUsers = (list: UserRow[]) => [...list].sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || a.id - b.id);
const nameOf = (u: { displayName?: string; username: string }) => u.displayName || u.username;

const isAdminUser = (u: UserRow) => (!u.officeId && !isMarketer(u)) || ADMIN_ROLES.includes(u.role);
const isOfficeLevel = (u: UserRow) => OFFICE_SCOPED_ROLES.has(u.role) || u.role === 'product_manager';

const VIEW_KEY = 'sa_users_view';
const OFFICE_KEY = 'sa_users_office';

type MenuItem = RowMenuItem | 'sep';
interface Place { label: string; view: string; officeId?: number; more: string[] }

const Svg = ({ size = 15, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconSearch = () => <Svg><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>;
const IconClose = ({ size = 12 }: { size?: number }) => <Svg size={size}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
const IconEye = () => <Svg><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>;
const IconMore = () => <Svg><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>;
const IconLeft = ({ size = 13 }: { size?: number }) => <Svg size={size}><path d="m15 18-6-6 6-6" /></Svg>;
const IconRight = ({ size = 13 }: { size?: number }) => <Svg size={size}><path d="m9 18 6-6-6-6" /></Svg>;
const IconDown = ({ size = 13 }: { size?: number }) => <Svg size={size}><path d="m6 9 6 6 6-6" /></Svg>;

// ── القائمة المنبثقة: موضعها يُحسب من الزر كي لا يقصّها حدّ الجدول أو أسفل الشاشة ──────
function PopMenu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const top = a.bottom + 4 + m.height > window.innerHeight ? Math.max(6, a.top - m.height - 4) : a.bottom + 4;
    el.style.top = `${top}px`;
    el.style.left = `${Math.min(Math.max(6, a.left), window.innerWidth - m.width - 6)}px`;
    el.querySelector('button')?.focus();
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); anchor.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(ref.current?.querySelectorAll('button') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
  };
  return (
    <div ref={ref} className="ud-menu" role="menu" onKeyDown={onKey} onClick={e => e.stopPropagation()} style={{ top: -9999, left: -9999 }}>
      {items.map((it, i) => it === 'sep'
        ? <hr key={`s${i}`} />
        : <button key={it.label} type="button" role="menuitem" className={it.danger ? 'is-danger' : undefined} onClick={() => { onClose(); it.onClick(); }}>{it.label}</button>)}
    </div>
  );
}

// ── صف المستخدم ────────────────────────────────────────────────────────────────
interface DirCtx {
  placeOf: (u: UserRow) => Place;
  openDrawer: (id: number) => void;
  openMenu: (anchor: HTMLElement, items: MenuItem[]) => void;
  userMenu: (u: UserRow, extra?: RowMenuItem[]) => MenuItem[];
  onImpersonate: (u: UserRow) => void;
}
const Ctx = createContext<DirCtx | null>(null);

function Status({ active }: { active: boolean }) {
  return <span className={`ud-status${active ? '' : ' is-off'}`}><i />{active ? 'نشط' : 'معطّل'}</span>;
}

function More({ names }: { names: string[] }) {
  return names.length ? <span className="ud-more" title={names.join('، ')}>+{names.length}</span> : null;
}

function UserLine({ u, level = 0, compact, opts }: { u: UserRow; level?: number; compact?: boolean; opts?: RowOpts }) {
  const c = useContext(Ctx)!;
  const mgrs = (u.managersOfUser ?? []).map(m => nameOf(m.manager));
  const place = c.placeOf(u);
  const sub = [`@${u.username}`, opts?.note].filter(Boolean).join(' · ');
  return (
    <div role="button" tabIndex={0} className={`ud-cols ud-row${compact ? ' is-compact' : ''}${u.isActive ? '' : ' is-off'}${level ? ` ud-indent-${level}` : ''}`}
      onClick={() => c.openDrawer(u.id)}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) c.openDrawer(u.id); }}>
      <div className="ud-name">
        <span className={`ud-avatar${u.isActive ? '' : ' is-off'}`}>{nameOf(u).trim().charAt(0).toUpperCase()}</span>
        <div className="ud-name-text">
          <div className="ud-name-main"><span>{nameOf(u)}</span>{opts?.tag && <span className="ud-tag" title={opts.tag}>{opts.tag}</span>}</div>
          <div className="ud-name-sub" title={sub}>{sub}</div>
        </div>
      </div>
      <div className="ud-cell ud-col-role">{roleLabelOf(u)}</div>
      {!compact && <div className="ud-cell is-muted ud-col-place">{place.label}<More names={place.more} /></div>}
      {!compact && (
        <div className="ud-cell is-muted ud-col-mgr">
          {mgrs.length ? <>{mgrs[0]}<More names={mgrs.slice(1)} /></> : <span style={{ color: '#cbd5e1' }}>—</span>}
        </div>
      )}
      <Status active={u.isActive} />
      <div className="ud-actions" onClick={e => e.stopPropagation()}>
        <button type="button" className="ud-icon-btn ud-eye" title="مراقبة الحساب" aria-label={`مراقبة حساب ${nameOf(u)}`} onClick={() => c.onImpersonate(u)}><IconEye /></button>
        <button type="button" className="ud-icon-btn" title="إجراءات" aria-haspopup="menu" aria-label={`إجراءات ${nameOf(u)}`}
          onClick={e => c.openMenu(e.currentTarget, c.userMenu(u, opts?.extra))}><IconMore /></button>
      </div>
    </div>
  );
}

function TableHead() {
  return (
    <div className="ud-cols ud-thead">
      <div>الاسم</div><div className="ud-col-role">الدور</div><div className="ud-col-place">الجهة</div><div className="ud-col-mgr">المدير</div><div>الحالة</div><div />
    </div>
  );
}

// ── اللوحة الجانبية: كل تفاصيل الحساب بلا مغادرة القائمة ──────────────────────────
function UserDrawer({ u, users, onClose, onGoPlace, onOpenProfile, onEdit, onToggle, onDelete }: {
  u: UserRow; users: UserRow[]; onClose: () => void; onGoPlace: (p: Place) => void;
  onOpenProfile: (id: number) => void; onEdit: (u: UserRow) => void; onToggle: (u: UserRow) => void; onDelete: (u: UserRow) => void;
}) {
  const c = useContext(Ctx)!;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, [u.id]);
  const place = c.placeOf(u);
  const companies = [...(u.companyAssignments ?? [])].sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary));
  const managers = u.managersOfUser ?? [];
  const subs = users.filter(x => x.managersOfUser?.some(m => m.managerId === u.id));
  const person = (id: number, name: string, hint?: string) => (
    <button key={id} type="button" onClick={() => c.openDrawer(id)}><span>{name}</span>{hint && <small>{hint}</small>}</button>
  );
  return (
    <>
      <div className="ud-scrim" onClick={onClose} />
      <aside ref={ref} tabIndex={-1} className="ud-drawer" role="dialog" aria-label={`تفاصيل ${nameOf(u)}`} translate="no">
        <div className="ud-drawer-head">
          <span className={`ud-avatar is-lg${u.isActive ? '' : ' is-off'}`}>{nameOf(u).trim().charAt(0).toUpperCase()}</span>
          <div className="ud-drawer-name"><h3>{nameOf(u)}</h3><div>@{u.username}</div></div>
          <button type="button" className="ud-icon-btn" aria-label="إغلاق" onClick={onClose}><IconClose size={15} /></button>
        </div>
        <div className="ud-drawer-meta"><span>{roleLabelOf(u)}</span><Status active={u.isActive} /></div>
        <div className="ud-drawer-cta">
          <button type="button" className="ud-btn is-primary" onClick={() => onOpenProfile(u.id)}>إدارة التعيينات والصلاحيات</button>
          <button type="button" className="ud-btn" onClick={() => onEdit(u)}>تعديل البيانات</button>
          <button type="button" className="ud-btn" onClick={() => c.onImpersonate(u)}>مراقبة الحساب</button>
        </div>
        <div className="ud-drawer-body">
          <section className="ud-dsec">
            <dl className="ud-dl">
              <dt>الجهة</dt>
              <dd><button type="button" className="ud-dlink" onClick={() => onGoPlace(place)}>{place.label}</button>{place.more.length > 0 && <> ، {place.more.join('، ')}</>}</dd>
              <dt>المكتب</dt><dd>{u.office?.name || '—'}</dd>
              <dt>الهاتف</dt><dd dir="ltr" style={{ textAlign: 'right' }}>{u.phone || '—'}</dd>
              {u.side && <><dt>القسم</dt><dd>{u.side}</dd></>}
              {u._count?.doctorVisits != null && <><dt>زيارات الأطباء</dt><dd>{u._count.doctorVisits.toLocaleString('en-US')}</dd></>}
            </dl>
          </section>
          <section className="ud-dsec">
            <h4>الشركات <small>{companies.length}</small></h4>
            {OFFICE_SCOPED_ROLES.has(u.role) && <div className="ud-dempty">كل شركات المكتب تلقائياً</div>}
            {!OFFICE_SCOPED_ROLES.has(u.role) && !companies.length && <div className="ud-dempty">لا توجد شركات</div>}
            <div className="ud-dlist">
              {companies.map(ca => <div key={ca.companyId}><span>{ca.company.name}</span>{ca.isPrimary && <small>رئيسية</small>}</div>)}
            </div>
          </section>
          <section className="ud-dsec">
            <h4>المدراء <small>{managers.length}</small></h4>
            {!managers.length && <div className="ud-dempty">بلا مدير</div>}
            <div className="ud-dlist">{managers.map(m => person(m.managerId, nameOf(m.manager)))}</div>
          </section>
          {subs.length > 0 && (
            <section className="ud-dsec">
              <h4>الموظفون التابعون <small>{subs.length}</small></h4>
              <div className="ud-dlist">{sortUsers(subs).map(s => person(s.id, nameOf(s), roleLabelOf(s)))}</div>
            </section>
          )}
        </div>
        <div className="ud-drawer-foot">
          <button type="button" className="ud-btn" onClick={() => onToggle(u)}>{u.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}</button>
          <button type="button" className="ud-btn is-danger" onClick={() => onDelete(u)}>حذف الحساب</button>
        </div>
      </aside>
    </>
  );
}

function SeatMeter({ filled, total }: { filled: number; total: number }) {
  return (
    <div className={`ud-meter${total > 0 && filled === total ? ' is-full' : ''}`} aria-label={`${filled} من ${total} مقعد`}>
      <div className="ud-meter-bar">{Array.from({ length: total }, (_, i) => <i key={i} className={i < filled ? 'on' : undefined} />)}</div>
      <span>{filled}/{total}</span>
    </div>
  );
}

// ── الصفحة ─────────────────────────────────────────────────────────────────────
interface Props {
  users: UserRow[];
  offices: { id: number; name: string }[];
  loading: boolean;
  search: string;
  setSearch: (v: string) => void;
  provTeams: ProvTeam[];
  provList: { id: number; name: string }[];
  provSeats: ProvSeat[];
  provMarketers: ProvMarketer[];
  provMarketerManagers: ProvMarketerManager[];
  provSaving: boolean;
  token: string | null;
  /** نافذة فوق اللوحة: Esc يخصّها لا اللوحة الجانبية. */
  modalOpen: boolean;
  onOpenProfile: (id: number) => void;
  onImpersonate: (u: UserRow) => void;
  onEdit: (u: UserRow) => void;
  onToggle: (u: UserRow) => void;
  onDelete: (u: UserRow) => void;
  onAdd: () => void;
  onBulkFeature: () => void;
  onBulkImport: () => void;
  onSetLeader: (officeId: number, provinceId: number, leaderUserId: number | null) => void;
  onReloadStructure: () => void;
}

export default function UsersDirectory(props: Props) {
  const { users, offices, loading, search, setSearch, provTeams, provList, provSeats, provMarketers, provMarketerManagers, provSaving, token, modalOpen } = props;

  const [view, setViewState] = useState<string>(() => localStorage.getItem(VIEW_KEY) || 'all');
  const [officeId, setOfficeIdState] = useState<number | null>(() => Number(localStorage.getItem(OFFICE_KEY)) || null);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'off'>('');
  const [provFilter, setProvFilter] = useState<'all' | 'vacant' | 'full' | 'none'>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [companiesOpen, setCompaniesOpen] = useState(() => (localStorage.getItem(VIEW_KEY) || '').startsWith('compan'));
  const searchRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();
  const searching = !!q;

  // المكاتب الظاهرة = التي فيها مستخدمون؛ المكتب المحفوظ قد يكون حُذف.
  const officeChoices = useMemo(() => {
    const ids = new Set(users.map(u => u.officeId).filter(Boolean));
    const known = offices.filter(o => ids.has(o.id));
    return known.length ? known : offices;
  }, [users, offices]);
  const activeOfficeId = officeChoices.some(o => o.id === officeId) ? officeId! : officeChoices[0]?.id ?? 0;
  const officeName = officeChoices.find(o => o.id === activeOfficeId)?.name ?? '';

  const closeMenu = useRef(() => setMenu(null)).current;

  const scrollTop = () => { const m = document.querySelector<HTMLElement>('main[style]'); if (m) m.scrollTop = 0; };
  const go = (next: string, nextOffice?: number) => {
    setViewState(next);
    localStorage.setItem(VIEW_KEY, next);
    if (nextOffice) { setOfficeIdState(nextOffice); localStorage.setItem(OFFICE_KEY, String(nextOffice)); }
    if (next.startsWith('compan')) setCompaniesOpen(true);
    setSearch('');
    scrollTop();
  };

  // ── تصنيف المستخدمين: كل مستخدم له جهة واحدة، نفس قواعد القائمة القديمة ──
  const provLeaderIds = useMemo(() => new Set(provTeams.map(t => t.leaderUserId).filter((x): x is number => x != null)), [provTeams]);
  const provUserIds = useMemo(() => new Set<number>([...provLeaderIds, ...provTeams.flatMap(t => t.reps.map(r => r.userId))]), [provTeams, provLeaderIds]);
  const provMarketerIds = useMemo(() => new Set([...provMarketers.map(m => m.userId), ...provMarketerManagers.filter(m => m.handlesProvinces).map(m => m.managerUserId)]), [provMarketers, provMarketerManagers]);
  const provName = useMemo(() => new Map(provList.map(p => [p.id, p.name])), [provList]);

  const placeOf = (u: UserRow): Place => {
    if (isAdminUser(u)) return { label: 'إدارة التطبيق', view: 'admin', more: [] };
    if (isOfficeLevel(u)) return { label: 'إدارة المكتب', view: 'office', officeId: u.officeId, more: [] };
    if (provMarketerIds.has(u.id)) {
      const pm = provMarketers.find(m => m.userId === u.id);
      const names = (pm?.provinceIds ?? []).map(id => provName.get(id)).filter((x): x is string => !!x);
      return names.length
        ? { label: names[0], view: `pm:${pm!.provinceIds[0]}`, officeId: u.officeId, more: names.slice(1) }
        : { label: 'مسوقو المحافظات', view: 'pm', officeId: u.officeId, more: [] };
    }
    if (isMarketer(u)) return { label: u.side ? `مسوقين بغداد · ${u.side}` : 'مسوقين بغداد', view: 'marketers', more: [] };
    if (provUserIds.has(u.id)) {
      const teams = provTeams.filter(t => t.leaderUserId === u.id || t.reps.some(r => r.userId === u.id));
      return { label: teams[0].provinceName, view: `province:${teams[0].provinceId}`, officeId: teams[0].officeId, more: teams.slice(1).map(t => t.provinceName) };
    }
    const cs = u.companyAssignments ?? [];
    if (!cs.length) return { label: 'بدون شركة', view: 'company:none', officeId: u.officeId, more: [] };
    const primary = cs.find(ca => ca.isPrimary) ?? cs[0];
    return { label: primary.company.name, view: `company:${primary.company.id}`, officeId: u.officeId, more: cs.filter(ca => ca.companyId !== primary.companyId).map(ca => ca.company.name) };
  };

  const match = (u: UserRow) => {
    if (statusFilter && (statusFilter === 'active') !== u.isActive) return false;
    if (roleFilter && formRoleOf(u) !== roleFilter) return false;
    if (!q) return true;
    return u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q) || (u.phone || '').includes(q);
  };
  const filtering = searching || !!roleFilter || !!statusFilter;
  const visible = useMemo(() => users.filter(match), [users, q, roleFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const adminUsers = users.filter(isAdminUser);
  const officeUsers = users.filter(u => u.officeId === activeOfficeId && !ADMIN_ROLES.includes(u.role));
  const officeStaff = officeUsers.filter(isOfficeLevel);
  const allMarketers = users.filter(u => isMarketer(u) && !ADMIN_ROLES.includes(u.role) && !provMarketerIds.has(u.id));

  type CompanyGroup = { key: string; company: { id: number; name: string } | null; users: UserRow[] };
  const companyGroups = useMemo(() => {
    const groups = new Map<string, CompanyGroup>();
    for (const u of officeUsers) {
      if (isOfficeLevel(u) || isMarketer(u) || provUserIds.has(u.id)) continue;
      const cs = u.companyAssignments ?? [];
      // المستخدم تحت شركته الرئيسية وحدها؛ الشركات الأخرى تظهر «+N» في عمود الجهة.
      const primary = cs.find(ca => ca.isPrimary) ?? cs[0];
      const key = primary ? String(primary.company.id) : 'none';
      if (!groups.has(key)) groups.set(key, { key, company: primary?.company ?? null, users: [] });
      groups.get(key)!.users.push(u);
    }
    return [...groups.values()].sort((a, b) => {
      if (!a.company) return 1;
      if (!b.company) return -1;
      return a.company.name.localeCompare(b.company.name);
    });
  }, [users, activeOfficeId, provUserIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const officeSeats = provSeats.filter(s => s.officeId === activeOfficeId);
  const teamOf = (pid: number) => provTeams.find(t => t.officeId === activeOfficeId && t.provinceId === pid) ?? null;
  const seatStats = (pid: number) => {
    const t = teamOf(pid);
    const vacant = officeSeats.filter(s => !t?.reps.some(r => r.seatManagerIds.includes(s.managerUserId))).length + (t?.leaderUserId == null ? 1 : 0);
    const total = officeSeats.length + 1;
    return { team: t, vacant, total, filled: total - vacant };
  };
  const userById = useMemo(() => new Map(users.map(x => [x.id, x])), [users]);

  const pmManagers = provMarketerManagers.filter(m => m.officeId === activeOfficeId);
  const pmMarketers = provMarketers.filter(m => m.officeId === activeOfficeId);
  const pmProvinces = provList.filter(p => p.name !== 'بغداد');
  const pmHeads = pmManagers.some(m => m.handlesProvinces) ? pmManagers.filter(m => m.handlesProvinces) : pmManagers;
  const marketersOf = (pid: number) => pmMarketers.filter(m => m.provinceIds.includes(pid)).map(m => userById.get(m.userId)).filter((u): u is UserRow => !!u);
  const hasPm = pmManagers.length > 0 || pmMarketers.length > 0;

  // ── الاختصارات ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (e.key === '/' && !typing && !modalOpen) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape' && !modalOpen) {
        if (drawerId != null) setDrawerId(null);
        else if (t === searchRef.current) setSearch('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerId, modalOpen, setSearch]);

  // حُذف الحساب المفتوح في اللوحة.
  useEffect(() => { if (drawerId != null && users.length && !userById.has(drawerId)) setDrawerId(null); }, [drawerId, userById, users.length]);

  const drawerUser = drawerId != null ? userById.get(drawerId) : undefined;

  const userMenu = (u: UserRow, extra?: RowMenuItem[]): MenuItem[] => [
    { label: 'التعيينات والصلاحيات', onClick: () => props.onOpenProfile(u.id) },
    { label: 'مراقبة الحساب', onClick: () => props.onImpersonate(u) },
    { label: 'تعديل البيانات', onClick: () => props.onEdit(u) },
    ...(extra ?? []),
    'sep',
    { label: u.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب', onClick: () => props.onToggle(u) },
    { label: 'حذف الحساب', danger: true, onClick: () => props.onDelete(u) },
  ];

  const ctx: DirCtx = {
    placeOf,
    openDrawer: setDrawerId,
    openMenu: (anchor, items) => setMenu({ anchor, items }),
    userMenu,
    onImpersonate: props.onImpersonate,
  };

  // ── أدوات الجدول ───────────────────────────────────────────────────────────
  const roleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of users) seen.set(formRoleOf(u), roleLabelOf(u));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ar'));
  }, [users]);

  const filterTools = (
    <div className="ud-pane-tools">
      {(roleFilter || statusFilter) && <button type="button" className="ud-link" onClick={() => { setRoleFilter(''); setStatusFilter(''); }}>مسح الفلتر</button>}
      <select className="ud-select" aria-label="فلتر الدور" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
        <option value="">كل الأدوار</option>
        {roleOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select className="ud-select" aria-label="فلتر الحالة" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}>
        <option value="">كل الحالات</option>
        <option value="active">نشط</option>
        <option value="off">معطّل</option>
      </select>
    </div>
  );

  const emptyRows = <div className="ud-empty">لا يوجد مستخدمون مطابقون</div>;

  const group = (key: string, label: string, rows: ReactNode[]) => {
    if (!rows.length) return null;
    const open = !collapsed.has(key);
    return (
      <div className="ud-group" key={key}>
        <button type="button" className={`ud-group-head${open ? ' is-open' : ''}`} aria-expanded={open}
          onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
          <IconLeft size={12} /><span>{label}</span><b>{rows.length}</b>
        </button>
        {open && rows}
      </div>
    );
  };

  const paneHead = (title: ReactNode, sub?: ReactNode, tools?: ReactNode) => (
    <div className="ud-pane-head">
      {typeof title === 'string' ? <h3 className="ud-pane-title">{title}</h3> : title}
      {sub && <span className="ud-pane-sub">{sub}</span>}
      {tools}
    </div>
  );

  const crumb = (parentLabel: string, parentView: string, label: string) => (
    <div className="ud-crumb">
      <button type="button" onClick={() => go(parentView)}>{parentLabel}</button>
      <IconLeft size={12} />
      <span>{label}</span>
    </div>
  );

  const flatTable = (rows: UserRow[]) => {
    const shown = sortUsers(rows.filter(match));
    return <div className="ud-table"><TableHead />{shown.length ? shown.map(u => <UserLine key={u.id} u={u} />) : emptyRows}</div>;
  };

  // ── العروض ─────────────────────────────────────────────────────────────────
  const renderAll = () => <>
    {paneHead('كل المستخدمين', `${visible.length} من ${users.length}`, filterTools)}
    {flatTable(users)}
  </>;

  const renderAdmin = () => <>
    {paneHead('حسابات إدارة التطبيق', `${adminUsers.length} حساب`, filterTools)}
    {flatTable(adminUsers)}
  </>;

  const renderOffice = () => <>
    {paneHead('إدارة المكتب', 'مدير مكتب · HR · موظف مكتب · مدير منتج', filterTools)}
    {flatTable(officeStaff)}
  </>;

  const renderCompanies = () => <>
    {paneHead('الشركات', `${companyGroups.filter(g => g.company).length} شركة في ${officeName}`)}
    <div className="ud-table">
      <div className="ud-cols-co ud-thead"><div>الشركة</div><div>المدير</div><div>المندوبون</div><div>المجموع</div></div>
      {companyGroups.map(g => {
        const managers = g.users.filter(u => u.role === 'company_manager');
        return (
          <button key={g.key} type="button" className={`ud-cols-co ud-link-row${g.company ? '' : ' is-empty'}`} onClick={() => go(`company:${g.key}`)}>
            <strong>{g.company?.name ?? 'بدون شركة'}</strong>
            <span className="ud-cell is-muted">{managers.length ? <>{nameOf(managers[0])}<More names={managers.slice(1).map(nameOf)} /></> : '—'}</span>
            <span className="ud-num">{g.users.length - managers.length}</span>
            <span className="ud-num">{g.users.length}</span>
          </button>
        );
      })}
      {!companyGroups.length && <div className="ud-empty">لا توجد شركات فيها مستخدمون</div>}
    </div>
  </>;

  const renderCompany = (key: string) => {
    const g = companyGroups.find(x => x.key === key);
    if (!g) return renderCompanies();
    const sorted = sortUsers(g.users).filter(match);
    const managers = sorted.filter(u => u.role === 'company_manager');
    const reps = sorted.filter(u => u.role !== 'company_manager');
    const mgrTotal = g.users.filter(u => u.role === 'company_manager').length;
    return <>
      {paneHead(crumb('الشركات', 'companies', g.company?.name ?? 'بدون شركة'), `${mgrTotal} مدير · ${g.users.length - mgrTotal} مندوب`, filterTools)}
      <div className="ud-table">
        <TableHead />
        {group(`co-${key}-m`, 'مدراء الشركة', managers.map(u => <UserLine key={u.id} u={u} />))}
        {group(`co-${key}-r`, 'المندوبون', reps.map(u => <UserLine key={u.id} u={u} />))}
        {!sorted.length && emptyRows}
      </div>
    </>;
  };

  const provRows = provList.map(p => ({ p, ...seatStats(p.id) }));
  const provCounts = {
    all: provRows.length,
    vacant: provRows.filter(r => r.team && r.vacant > 0).length,
    full: provRows.filter(r => r.team && r.vacant === 0).length,
    none: provRows.filter(r => !r.team).length,
  };
  const withTeam = provCounts.all - provCounts.none;
  const totalVacant = provRows.reduce((n, r) => n + r.vacant, 0);

  const renderProvinces = () => {
    const shown = provRows.filter(r => provFilter === 'all' ? true : provFilter === 'none' ? !r.team : provFilter === 'full' ? !!r.team && r.vacant === 0 : !!r.team && r.vacant > 0);
    const segs: [typeof provFilter, string][] = [['all', 'الكل'], ['vacant', 'فيها شاغر'], ['full', 'مكتملة'], ['none', 'بلا فريق']];
    return <>
      {paneHead('فرق المحافظات', `${withTeam} لها فريق من ${provRows.length} · ${totalVacant} مقعد شاغر`, (
        <div className="ud-pane-tools">
          <div className="ud-seg" role="group" aria-label="فلتر المحافظات">
            {segs.map(([k, l]) => <button key={k} type="button" className={provFilter === k ? 'is-active' : undefined} aria-pressed={provFilter === k} onClick={() => setProvFilter(k)}>{l}<small>{provCounts[k]}</small></button>)}
          </div>
        </div>
      ))}
      <div className="ud-table">
        <div className="ud-cols-prov ud-thead"><div>المحافظة</div><div className="ud-prov-leader">تيم ليدر</div><div className="ud-prov-reps">المندوبون</div><div>المقاعد</div><div>الحالة</div></div>
        {shown.map(({ p, team, vacant, total, filled }) => {
          const leader = team?.leaderUserId != null ? userById.get(team.leaderUserId) : null;
          return (
            <button key={p.id} type="button" className={`ud-cols-prov ud-link-row${team ? '' : ' is-empty'}`} onClick={() => go(`province:${p.id}`)}>
              <strong>{p.name}</strong>
              <span className="ud-cell is-muted ud-prov-leader">{leader ? nameOf(leader) : team ? 'بلا تيم ليدر' : '—'}</span>
              <span className="ud-num ud-prov-reps">{team ? team.reps.length : '—'}</span>
              <SeatMeter filled={filled} total={total} />
              <span className={`ud-state ${!team ? 'none' : vacant ? 'warn' : 'ok'}`}>{!team ? 'بلا فريق' : vacant ? `${vacant} شاغر` : 'مكتملة'}</span>
            </button>
          );
        })}
        {!shown.length && <div className="ud-empty">لا توجد محافظات بهذا التصنيف</div>}
      </div>
    </>;
  };

  const siblingNav = (ids: number[], current: number, prefix: string) => {
    const i = ids.indexOf(current);
    return (
      <div className="ud-pane-tools">
        <button type="button" className="ud-icon-btn is-border" title="السابق" aria-label="السابق" disabled={i <= 0} onClick={() => go(`${prefix}${ids[i - 1]}`)}><IconRight /></button>
        <button type="button" className="ud-icon-btn is-border" title="التالي" aria-label="التالي" disabled={i < 0 || i >= ids.length - 1} onClick={() => go(`${prefix}${ids[i + 1]}`)}><IconLeft /></button>
      </div>
    );
  };

  const renderProvince = (pid: number) => {
    const p = provList.find(x => x.id === pid);
    if (!p) return renderProvinces();
    const t = teamOf(pid);
    const { vacant, total, filled } = seatStats(pid);
    // قائد حالي خارج الأدوار المسموحة (مندوب عُيِّن سابقاً) يبقى ظاهراً في القائمة.
    const currentLeader = t?.leaderUserId != null ? userById.get(t.leaderUserId) : undefined;
    const allowed = users.filter(x => x.officeId === activeOfficeId && x.isActive && !isMarketer(x) && ['team_leader', 'supervisor'].includes(x.role));
    const choices = currentLeader && !allowed.some(x => x.id === currentLeader.id) ? [currentLeader, ...allowed] : allowed;
    return <>
      {paneHead(crumb('فرق المحافظات', 'provinces', p.name), `${vacant} شاغر · ${filled} ممتلئ من ${total} مقعد`, siblingNav(provList.map(x => x.id), pid, 'province:'))}
      <ProvinceSeatsPanel<UserRow> key={`${activeOfficeId}-${p.id}`}
        officeId={activeOfficeId} province={p}
        leaderUserId={t?.leaderUserId ?? null} reps={t?.reps ?? []}
        seats={officeSeats} splits={t?.splits ?? []}
        leaderChoices={choices.map(x => ({ id: x.id, label: nameOf(x) }))}
        saving={provSaving} userById={userById}
        renderUser={(u, opts) => <UserLine u={u} compact opts={opts} />}
        userLabel={nameOf}
        onSetLeader={id => props.onSetLeader(activeOfficeId, p.id, id)}
        onCreated={props.onReloadStructure}
        token={token} />
    </>;
  };

  const renderPm = () => <>
    {paneHead('مسوقو المحافظات', `${pmMarketers.length} مسوق · يتبعون مدير المسوقين، مستقلون عن العلميين`)}
    {pmHeads.length > 0 && (
      <div className="ud-table" style={{ marginBottom: 12 }}>
        <div className="ud-section-head">مدير المسوقين</div>
        <div className="ud-section-body">
          {pmHeads.map(m => { const u = userById.get(m.managerUserId); return u ? <UserLine key={u.id} u={u} compact /> : null; })}
        </div>
      </div>
    )}
    <div className="ud-table">
      <div className="ud-cols-pm ud-thead"><div>المحافظة</div><div>المسوقون</div><div>العدد</div></div>
      {pmProvinces.map(p => {
        const list = marketersOf(p.id);
        return (
          <button key={p.id} type="button" className={`ud-cols-pm ud-link-row${list.length ? '' : ' is-empty'}`} onClick={() => go(`pm:${p.id}`)}>
            <strong>{p.name}</strong>
            <span className="ud-cell is-muted" title={list.map(nameOf).join('، ')}>{list.length ? list.map(nameOf).join('، ') : 'لا يوجد مسوق'}</span>
            <span className="ud-num">{list.length || '—'}</span>
          </button>
        );
      })}
      {(() => {
        // مسوق محافظة (عبر مديره مدير مسوقي المحافظات) بلا محافظة محددة بعد
        const list = pmMarketers.filter(m => !m.provinceIds.length).map(m => userById.get(m.userId)).filter((u): u is UserRow => !!u);
        return list.length ? (
          <div className="ud-cols-pm ud-link-row">
            <strong>بلا محافظة محددة</strong>
            <span className="ud-cell is-muted" title={list.map(nameOf).join('، ')}>{list.map(nameOf).join('، ')}</span>
            <span className="ud-num">{list.length}</span>
          </div>
        ) : null;
      })()}
    </div>
  </>;

  const renderPmProvince = (pid: number) => {
    const p = pmProvinces.find(x => x.id === pid);
    if (!p) return renderPm();
    const list = marketersOf(pid);
    return <>
      {paneHead(crumb('مسوقو المحافظات', 'pm', p.name), list.length ? `${list.length} مسوق` : 'لا يوجد مسوق بعد', siblingNav(pmProvinces.map(x => x.id), pid, 'pm:'))}
      <ProvinceMarketersPanel<UserRow> key={`${activeOfficeId}-${p.id}`}
        officeId={activeOfficeId} province={p}
        marketers={list} managers={pmManagers}
        userKey={u => u.id}
        renderUser={u => <UserLine u={u} compact />}
        onCreated={props.onReloadStructure}
        token={token} />
    </>;
  };

  // «مسوقين بغداد»: مدير المسوقين ← الأقسام ← كل تيم ليدر ومندوبوه ← بلا قائد.
  const renderMarketers = () => {
    const sorted = sortUsers(allMarketers);
    const managers = sorted.filter(u => u.role === 'company_manager');
    const leaders = sorted.filter(u => u.role === 'team_leader');
    const leaderIds = new Set(leaders.map(l => l.id));
    const leaderOf = (u: UserRow) => (u.managersOfUser ?? []).map(m => m.managerId).find(id => leaderIds.has(id));
    const others = sorted.filter(u => u.role !== 'company_manager' && u.role !== 'team_leader');
    const loose = others.filter(u => leaderOf(u) == null);
    const sideRank = (n: string) => /كرخ/.test(n) ? 0 : /رصاف/.test(n) ? 1 : n === 'بلا قسم' ? 3 : 2;
    const sideOf = (u: UserRow) => u.side || 'بلا قسم';
    const sides = [...new Set([...leaders, ...loose].map(sideOf))].sort((a, b) => sideRank(a) - sideRank(b) || a.localeCompare(b, 'ar'));
    const groups = sides.map(side => {
      const rows: ReactNode[] = [];
      for (const l of leaders.filter(x => sideOf(x) === side)) {
        const team = others.filter(u => leaderOf(u) === l.id).filter(match);
        if (match(l) || team.length) rows.push(<UserLine key={l.id} u={l} />);
        for (const u of team) rows.push(<UserLine key={u.id} u={u} level={1} />);
      }
      for (const u of loose.filter(x => sideOf(x) === side).filter(match)) rows.push(<UserLine key={u.id} u={u} />);
      return group(`mk-${side}`, side, rows);
    });
    const shownManagers = managers.filter(match);
    return <>
      {paneHead('مسوقين بغداد', `${leaders.length} تيم ليدر · ${others.length} مندوب`, filterTools)}
      <div className="ud-table">
        <TableHead />
        {shownManagers.map(u => <UserLine key={u.id} u={u} />)}
        {groups}
        {!shownManagers.length && groups.every(g => !g) && emptyRows}
      </div>
    </>;
  };

  const renderSearch = () => {
    const shown = sortUsers(visible);
    const provMatches = provList.filter(p => p.name.toLowerCase().includes(q));
    const coMatches = companyGroups.filter(g => g.company?.name.toLowerCase().includes(q));
    return <>
      {paneHead(`نتائج «${search.trim()}»`, `${shown.length} مستخدم`, filterTools)}
      {(provMatches.length > 0 || coMatches.length > 0) && (
        <div className="ud-match">
          <span>انتقل إلى:</span>
          {coMatches.map(g => <button key={g.key} type="button" onClick={() => go(`company:${g.key}`)}>شركة {g.company!.name}</button>)}
          {provMatches.map(p => <button key={p.id} type="button" onClick={() => go(`province:${p.id}`)}>محافظة {p.name}</button>)}
        </div>
      )}
      <div className="ud-table"><TableHead />{shown.length ? shown.map(u => <UserLine key={u.id} u={u} />) : emptyRows}</div>
    </>;
  };

  const [viewKind, viewArg] = view.split(':');
  const renderView = () => {
    switch (viewKind) {
      case 'admin': return renderAdmin();
      case 'office': return renderOffice();
      case 'companies': return renderCompanies();
      case 'company': return renderCompany(viewArg);
      case 'provinces': return renderProvinces();
      case 'province': return renderProvince(Number(viewArg));
      case 'pm': return !hasPm ? renderAll() : viewArg ? renderPmProvince(Number(viewArg)) : renderPm();
      case 'marketers': return allMarketers.length ? renderMarketers() : renderAll();
      default: return renderAll();
    }
  };

  // ── القائمة الجانبية ───────────────────────────────────────────────────────
  const countOf = (list: UserRow[]) => (filtering ? list.filter(match).length : list.length);
  const isActive = (...keys: string[]) => !searching && keys.includes(viewKind);
  const railItem = (key: string, label: string, count: ReactNode, active: boolean, sub?: boolean) => (
    <button key={key} type="button" title={label} aria-current={active ? 'true' : undefined}
      className={`ud-rail-item${active ? ' is-active' : ''}${sub ? ' is-sub' : ''}${filtering && count === 0 ? ' is-dim' : ''}`}
      onClick={() => go(key)}>
      <span>{label}</span><b>{count}</b>
    </button>
  );
  const provPeople = users.filter(u => u.officeId === activeOfficeId && provUserIds.has(u.id) && !isMarketer(u));
  const pmPeople = users.filter(u => u.officeId === activeOfficeId && provMarketerIds.has(u.id));

  const rail = (
    <nav className="ud-rail" aria-label="أقسام المستخدمين">
      <div className="ud-rail-office">
        {officeChoices.length > 1
          ? <select aria-label="المكتب" value={activeOfficeId} onChange={e => { const id = Number(e.target.value); setOfficeIdState(id); localStorage.setItem(OFFICE_KEY, String(id)); }}>
              {officeChoices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          : officeName}
      </div>
      {railItem('all', 'كل المستخدمين', visible.length, isActive('all'))}
      <div className="ud-rail-group">الإدارة</div>
      {adminUsers.length > 0 && railItem('admin', 'حسابات إدارة التطبيق', countOf(adminUsers), isActive('admin'))}
      {officeStaff.length > 0 && railItem('office', 'إدارة المكتب', countOf(officeStaff), isActive('office'))}
      <div className="ud-rail-group">الشركات</div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{railItem('companies', 'كل الشركات', companyGroups.filter(g => g.company).length, isActive('companies'))}</div>
        <button type="button" className={`ud-icon-btn ud-rail-toggle${companiesOpen ? ' is-open' : ''}`} style={{ width: 26, height: 26 }} aria-expanded={companiesOpen} aria-label="عرض الشركات" onClick={() => setCompaniesOpen(o => !o)}><IconLeft size={12} /></button>
      </div>
      {companiesOpen && companyGroups.map(g => railItem(`company:${g.key}`, g.company?.name ?? 'بدون شركة', countOf(g.users), !searching && view === `company:${g.key}`, true))}
      <div className="ud-rail-group">المحافظات</div>
      {provList.length > 0 && railItem('provinces', 'فرق المحافظات', filtering ? countOf(provPeople) : `${withTeam}/${provList.length}`, isActive('provinces', 'province'))}
      {hasPm && railItem('pm', 'مسوقو المحافظات', countOf(pmPeople), isActive('pm'))}
      {allMarketers.length > 0 && <>
        <div className="ud-rail-group">المسوقون</div>
        {railItem('marketers', 'مسوقين بغداد', countOf(allMarketers), isActive('marketers'))}
      </>}
    </nav>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="ud notranslate" translate="no" dir="rtl">
        <div className="ud-head">
          <h2 className="ud-title">المستخدمون <small>{users.length}</small></h2>
          <div className="ud-search">
            <IconSearch />
            <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالاسم أو اسم الدخول أو الهاتف" aria-label="بحث في المستخدمين" />
            {search && <button type="button" className="ud-search-x" aria-label="مسح البحث" onClick={() => { setSearch(''); searchRef.current?.focus(); }}><IconClose size={11} /></button>}
          </div>
          <button type="button" className="ud-btn" aria-haspopup="menu" onClick={e => setMenu({ anchor: e.currentTarget, items: [
            { label: 'تفعيل جماعي للميزات', onClick: props.onBulkFeature },
            { label: 'استيراد من إكسل', onClick: props.onBulkImport },
          ] })}>إجراءات جماعية <IconDown /></button>
          <button type="button" className="ud-btn is-primary" onClick={props.onAdd}>+ إضافة مستخدم</button>
        </div>

        {loading && users.length === 0 ? <Spinner /> : (
          <div className="ud-layout">
            {rail}
            <div style={{ minWidth: 0 }}>
              {loading && <div className="ud-progress" />}
              {searching && <div className="ud-pane" key="search">{renderSearch()}</div>}
              {/* يبقى العرض مركّباً أثناء البحث كي لا تضيع أسماء كُتبت في مقعد شاغر. */}
              <div className="ud-pane" key={`${view}-${activeOfficeId}`} hidden={searching}>{renderView()}</div>
            </div>
          </div>
        )}

        {drawerUser && (
          <UserDrawer u={drawerUser} users={users} onClose={() => setDrawerId(null)}
            onGoPlace={p => { setDrawerId(null); go(p.view, p.officeId); }}
            onOpenProfile={props.onOpenProfile} onEdit={props.onEdit} onToggle={props.onToggle} onDelete={props.onDelete} />
        )}
        {menu && <PopMenu anchor={menu.anchor} items={menu.items} onClose={closeMenu} />}
      </div>
    </Ctx.Provider>
  );
}
