import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { TabPill, Note, PickerBar, GroupCard, ChipGrid, Chip, Empty, setMany, iconBtn, ACCENT } from './AssignUI';

// تعيين المستخدم الجديد: تبويبات (الشركات، الايتمات، المناطق، المدراء، التابعون) بنفس
// مكوّنات تبويبات صفحة المستخدم. كل الخيارات تظهر كاملة بلا سقف، مجمّعة: الايتمات
// بالشركة، المناطق بالمحافظة ← القسم، المستخدمون بالدور. القيم تُحفظ في form وتُرسل
// بعد إنشاء الحساب (saveUser في UsersPage). تعديل حساب موجود يبقى في صفحة المستخدم.

interface Named { id: number; name: string }
interface AreaRow extends Named { provinceId?: number | null; subProvinceId?: number | null }
interface SubRow extends Named { provinceId: number }
interface ItemRow extends Named { companyId: number; companyName: string }
interface UserLite {
  id: number; username: string; displayName?: string; role: string; officeId?: number; isActive: boolean;
  companyAssignments?: { isPrimary?: boolean; company?: { name: string } | null }[];
}
interface AreaGroup { key: string; title: string; sub: SubRow | null; province: Named | null; areas: AreaRow[] }
type Load = 'loading' | 'ok' | 'error';
type Key = 'companies' | 'items' | 'areas' | 'managers' | 'subs';

const MANAGER_ROLES = new Set(['company_manager', 'team_leader', 'supervisor', 'product_manager', 'office_manager', 'commercial_supervisor', 'commercial_team_leader']);
const userName = (u: UserLite) => u.displayName || u.username;
const primaryCompany = (u: UserLite) => {
  const cas = u.companyAssignments ?? [];
  return (cas.find(a => a.isPrimary) ?? cas[0])?.company?.name ?? '';
};

// البحث يتجاوز فروق الكتابة: الحارثية = الحارثيه = حارثيه.
const norm = (s: string) => String(s ?? '').trim().toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[ـً-ٟ]/g, '')
  .replace(/(^|\s)ال/g, '$1')
  .replace(/\s+/g, ' ');

const listStyle: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingInlineEnd: 2 };

// شريط المختار: يبقى ظاهراً مهما طُويت المجموعات، والإزالة منه مباشرة.
function SelectedTray({ tags }: { tags: { key: string; label: string; onRemove?: () => void }[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!tags.length) return null;
  const LIMIT = 10;
  const shown = expanded ? tags : tags.slice(0, LIMIT);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, alignItems: 'center' }}>
      {shown.map(t => (
        <span key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#eef2ff', color: '#3730a3', border: '1px solid #c7d2fe', borderRadius: 14, padding: '2px 9px', fontSize: 12 }}>
          {t.label}
          {t.onRemove && <button type="button" onClick={t.onRemove} title="إزالة" style={{ ...iconBtn('#6366f1'), padding: '0 2px' }}>✕</button>}
        </span>
      ))}
      {tags.length > LIMIT && (
        <button type="button" onClick={() => setExpanded(x => !x)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: ACCENT, fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>
          {expanded ? 'عرض أقل' : `+${tags.length - LIMIT} أخرى`}
        </button>
      )}
    </div>
  );
}

function UserGroups({ list, selected, onChange, forceOpen, roles, emptyText, bulk }: {
  list: UserLite[]; selected: number[]; onChange: (ids: number[], on: boolean) => void; forceOpen: boolean;
  roles: { value: string; label: string }[]; emptyText: string; bulk?: boolean;
}) {
  const order = (r: string) => { const i = roles.findIndex(x => x.value === r); return i < 0 ? 999 : i; };
  const groups = Object.entries(list.reduce<Record<string, UserLite[]>>((acc, u) => { (acc[u.role] ||= []).push(u); return acc; }, {}))
    .sort(([a], [b]) => order(a) - order(b));
  if (!groups.length) return <Empty>{emptyText}</Empty>;
  return (
    <>
      {groups.map(([role, members]) => {
        const ids = members.map(u => u.id);
        return (
          <GroupCard
            key={role}
            icon="👤"
            title={roles.find(r => r.value === role)?.label || role}
            sel={ids.filter(id => selected.includes(id)).length}
            total={ids.length}
            onToggleAll={bulk ? on => onChange(ids, on) : undefined}
            forceOpen={forceOpen}
            defaultOpen={groups.length <= 4}
          >
            <ChipGrid min={190}>
              {[...members].sort((a, b) => userName(a).localeCompare(userName(b), 'ar')).map(u => (
                <Chip key={u.id} wrap checked={selected.includes(u.id)} label={userName(u)} sub={primaryCompany(u) || `@${u.username}`}
                  onChange={on => onChange([u.id], on)} />
              ))}
            </ChipGrid>
          </GroupCard>
        );
      })}
    </>
  );
}

export default function NewUserAssignments({ form, setForm, role, companies, offices, users, roles, token, isOfficeRole, isMarketer }: {
  form: any; setForm: any;
  role: string;            // الدور الفعلي (بعد تحويل خيارات الفارمسي)
  companies: (Named & { officeId: number })[];
  offices: Named[];
  users: UserLite[];
  roles: { value: string; label: string }[];
  token?: string;
  isOfficeRole: boolean;   // أدوار المكتب تأخذ كل شركاته تلقائياً
  isMarketer: boolean;     // المسوق: بلا شركة رئيسية
}) {
  const [tab, setTab] = useState<Key>('companies');
  const [q, setQ] = useState<Record<Key, string>>({ companies: '', items: '', areas: '', managers: '', subs: '' });
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [provinces, setProvinces] = useState<Named[]>([]);
  const [subProvinces, setSubProvinces] = useState<SubRow[]>([]);
  const [areasLoad, setAreasLoad] = useState<Load>('loading');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [itemsLoad, setItemsLoad] = useState<Load>('ok');
  const H = { Authorization: `Bearer ${token}` };

  const companyIds: number[] = form.companyIds ?? [];
  const itemIds: number[] = form.itemIds ?? [];
  const areaIds: number[] = form.areaIds ?? [];
  const subProvinceIds: number[] = form.subProvinceIds ?? [];
  const managerIds: number[] = form.managerIds ?? [];
  const subIds: number[] = form.subordinateIds ?? [];
  const provinceId = form.provinceId ? Number(form.provinceId) : null;
  const canHaveSubs = MANAGER_ROLES.has(role);
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  useEffect(() => {
    Promise.all([
      fetch('/api/sa/areas', { headers: H }).then(r => r.json()).catch(() => null),
      fetch('/api/sa/sub-provinces', { headers: H }).then(r => r.json()).catch(() => null),
      fetch('/api/sa/provinces', { headers: H }).then(r => r.json()).catch(() => null),
    ]).then(([a, sp, p]) => {
      if (sp?.success) setSubProvinces(sp.data);
      if (p?.success) setProvinces(p.data);
      if (a?.success) setAreas(a.data);
      setAreasLoad(a?.success ? 'ok' : 'error');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ايتمات الشركات المختارة (معاينة بلا حفظ — نفس endpoint تبويب «الايتمات»).
  useEffect(() => {
    if (!companyIds.length) { setItems([]); setItemsLoad('ok'); return; }
    let stale = false;
    setItemsLoad('loading');
    fetch(`/api/sa/users/0/company-items?companyIds=${companyIds.join(',')}`, { headers: H })
      .then(r => r.json())
      .then(j => { if (stale) return; setItems(j?.success ? j.data : []); setItemsLoad(j?.success ? 'ok' : 'error'); })
      .catch(() => { if (!stale) { setItems([]); setItemsLoad('error'); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyIds.join(',')]);

  // تغيير الدور يُخفي بعض الأقسام: لا يبقى منها اختيار خفي يُحفظ دون أن يُرى.
  useEffect(() => {
    const patch: any = {};
    if (!canHaveSubs && subIds.length) patch.subordinateIds = [];
    if (isOfficeRole && form.provinceId) patch.provinceId = null;
    if (Object.keys(patch).length) set(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, isOfficeRole]);

  const officeCompanies = form.officeId ? companies.filter(c => c.officeId === Number(form.officeId)) : companies;
  const officeUsers = users.filter(u => u.isActive && (!form.officeId || u.officeId === Number(form.officeId)));
  const managerChoices = officeUsers.filter(u => MANAGER_ROLES.has(u.role) && !subIds.includes(u.id));
  const subChoices = officeUsers.filter(u => !managerIds.includes(u.id));
  const showOfficeName = !form.officeId && offices.length > 1;

  const matcher = (k: Key) => {
    const t = norm(q[k]);
    return (s: string) => !t || norm(s).includes(t);
  };
  const matchUser = (k: Key) => {
    const m = matcher(k);
    return (u: UserLite) => m(userName(u)) || m(u.username);
  };
  const searching = (k: Key) => !!q[k].trim();

  // ── المناطق: محافظة ← قسم (كرخ/رصافة)، وما بلا محافظة في الأسفل ──────────────
  const areaGroups = useMemo<AreaGroup[]>(() => {
    const provById = new Map(provinces.map(p => [p.id, p]));
    const subById = new Map(subProvinces.map(s => [s.id, s]));
    const provOrder = new Map(provinces.map((p, i) => [p.id, i]));
    const subOrder = new Map(subProvinces.map((s, i) => [s.id, i]));
    const provHasSubs = new Set(areas.filter(a => a.subProvinceId != null).map(a => a.provinceId));
    const map = new Map<string, AreaGroup>();
    for (const a of areas) {
      const province = a.provinceId != null ? provById.get(a.provinceId) ?? null : null;
      const s = a.subProvinceId != null ? subById.get(a.subProvinceId) ?? null : null;
      const sub = s && province && s.provinceId === province.id ? s : null;
      const key = `${province?.id ?? 'none'}:${sub?.id ?? 'direct'}`;
      if (!map.has(key)) {
        const title = !province ? 'بلا محافظة'
          : sub ? `${province.name} — ${sub.name}`
          : provHasSubs.has(province.id) ? `${province.name} — بلا قسم`
          : province.name;
        map.set(key, { key, title, sub, province, areas: [] });
      }
      map.get(key)!.areas.push(a);
    }
    const rank = (g: AreaGroup) => [
      g.province ? provOrder.get(g.province.id) ?? 998 : 999,
      g.sub ? subOrder.get(g.sub.id) ?? 998 : 999,
    ];
    const groups = [...map.values()].sort((x, y) => {
      const [xp, xs] = rank(x); const [yp, ys] = rank(y);
      return xp - yp || xs - ys;
    });
    for (const g of groups) g.areas.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return groups;
  }, [areas, provinces, subProvinces]);

  // مشمولة ضمنياً: عبر المحافظة المختارة بالأعلى، أو عبر قسم مؤشَّر كاملاً.
  const provinceAreaIds = useMemo(() => new Set(areas.filter(a => provinceId != null && a.provinceId === provinceId).map(a => a.id)), [areas, provinceId]);
  const subAreaIds = useMemo(() => new Set(areas.filter(a => a.subProvinceId != null && subProvinceIds.includes(a.subProvinceId)).map(a => a.id)), [areas, subProvinceIds]);
  const effectiveAreaCount = new Set([...areaIds, ...provinceAreaIds, ...subAreaIds]).size;

  const toggleArea = (a: AreaRow, on: boolean) => {
    // إلغاء منطقة من قسم مؤشَّر كاملاً: يتحوّل القسم إلى مناطق مفردة ما عداها.
    if (!on && a.subProvinceId != null && subProvinceIds.includes(a.subProvinceId)) {
      const rest = areas.filter(x => x.subProvinceId === a.subProvinceId && x.id !== a.id).map(x => x.id);
      set({ subProvinceIds: subProvinceIds.filter(x => x !== a.subProvinceId), areaIds: setMany(areaIds, rest, true) });
      return;
    }
    set({ areaIds: setMany(areaIds, [a.id], on) });
  };
  const toggleAreaGroup = (g: AreaGroup, on: boolean) => {
    const ids = g.areas.map(a => a.id);
    if (g.sub) {
      set({ subProvinceIds: setMany(subProvinceIds, [g.sub.id], on), areaIds: setMany(areaIds, ids, false) });
    } else {
      set({ areaIds: setMany(areaIds, ids, on) });
    }
  };

  // ── الشركات / الايتمات ─────────────────────────────────────────────────────
  const toggleCompany = (id: number, on: boolean) => {
    const next = setMany(companyIds, [id], on);
    const removedItems = on ? new Set<number>() : new Set(items.filter(i => i.companyId === id).map(i => i.id));
    set({
      companyIds: next,
      primaryCompanyId: next.includes(form.primaryCompanyId) ? form.primaryCompanyId : (next[0] ?? null),
      itemIds: itemIds.filter(x => !removedItems.has(x)),
    });
  };
  const itemGroups = useMemo(() => {
    const map = new Map<number, { id: number; name: string; items: ItemRow[] }>();
    for (const i of items) {
      if (!map.has(i.companyId)) map.set(i.companyId, { id: i.companyId, name: i.companyName, items: [] });
      map.get(i.companyId)!.items.push(i);
    }
    return [...map.values()];
  }, [items]);

  const tabs: { key: Key; icon: string; label: string; count: number; show: boolean }[] = [
    { key: 'companies', icon: '🏭', label: 'الشركات',  count: isOfficeRole ? officeCompanies.length : companyIds.length, show: true },
    { key: 'items',     icon: '💊', label: 'الايتمات', count: itemIds.length,      show: !isOfficeRole },
    { key: 'areas',     icon: '📍', label: 'المناطق',  count: effectiveAreaCount,  show: true },
    { key: 'managers',  icon: '⬆️', label: 'المدراء',  count: managerIds.length,   show: true },
    { key: 'subs',      icon: '⬇️', label: 'التابعون', count: subIds.length,       show: canHaveSubs },
  ];
  const visibleTabs = tabs.filter(t => t.show);
  const active: Key = visibleTabs.some(t => t.key === tab) ? tab : 'companies';
  // اللوحات تبقى مركّبة مخفية كي لا يضيع طيّ المجموعات عند التنقل بين التبويبات.
  const panel = (k: Key): CSSProperties => ({ display: active === k ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 });
  const searchProps = (k: Key, placeholder: string) => ({ search: q[k], onSearch: (v: string) => setQ(p => ({ ...p, [k]: v })), placeholder });
  const hint = (children: ReactNode) => <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8, lineHeight: 1.6 }}>{children}</div>;
  const noMatch = <Empty>لا توجد نتائج مطابقة</Empty>;

  const matchCompany = matcher('companies');
  const shownCompanies = officeCompanies.filter(c => matchCompany(c.name));
  const matchItem = matcher('items');
  const shownItemGroups = itemGroups.map(g => ({ ...g, shown: g.items.filter(i => matchItem(i.name)) })).filter(g => g.shown.length > 0);
  const matchArea = matcher('areas');
  const shownAreaGroups = areaGroups.map(g => ({ ...g, shown: g.areas.filter(a => matchArea(a.name)) })).filter(g => g.shown.length > 0);

  const areaTags = [
    ...(provinceId != null ? [{ key: `p${provinceId}`, label: `${provinces.find(p => p.id === provinceId)?.name ?? ''} كاملة` }] : []),
    ...subProvinces.filter(s => subProvinceIds.includes(s.id)).map(s => ({
      key: `s${s.id}`, label: `${s.name} كامل`, onRemove: () => set({ subProvinceIds: subProvinceIds.filter(x => x !== s.id) }),
    })),
    ...areas.filter(a => areaIds.includes(a.id) && !provinceAreaIds.has(a.id) && !subAreaIds.has(a.id)).map(a => ({
      key: `a${a.id}`, label: a.name, onRemove: () => set({ areaIds: areaIds.filter(x => x !== a.id) }),
    })),
  ];
  const userTags = (ids: number[], field: string) => ids.map(id => users.find(u => u.id === id)).filter((u): u is UserLite => !!u).map(u => ({
    key: `u${u.id}`, label: userName(u), onRemove: () => set({ [field]: ids.filter(x => x !== u.id) }),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="m-scroll-row m-nu-sticky" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {visibleTabs.map(t => <TabPill key={t.key} active={active === t.key} icon={t.icon} label={t.label} count={t.count} onClick={() => setTab(t.key)} />)}
      </div>

      {/* ── الشركات ── */}
      <div style={panel('companies')}>
        {isOfficeRole ? (
          <>
            <Note>هذا الدور يعمل على مستوى المكتب: يحصل تلقائياً على كل شركات المكتب.</Note>
            <div className="m-nu-scroll" style={listStyle}>
              {officeCompanies.length === 0 ? <Empty>لا توجد شركات لهذا المكتب.</Empty> : (
                <ChipGrid min={180}>{officeCompanies.map(c => <Chip key={c.id} wrap checked disabled onChange={() => {}} label={c.name} />)}</ChipGrid>
              )}
            </div>
          </>
        ) : (
          <>
            <PickerBar selected={companyIds.length} total={officeCompanies.length}
              onAll={() => set({ companyIds: officeCompanies.map(c => c.id), primaryCompanyId: form.primaryCompanyId ?? officeCompanies[0]?.id ?? null })}
              onNone={() => set({ companyIds: [], primaryCompanyId: null, itemIds: [] })}
              {...searchProps('companies', 'بحث عن شركة...')} />
            {showOfficeName && hint('لم يُختر مكتب، لذلك تظهر شركات كل المكاتب. اختر المكتب لعرض شركاته فقط.')}
            {!isMarketer && companyIds.length > 1 && hint('★ تحدد الشركة الرئيسية للمستخدم.')}
            <div className="m-nu-scroll" style={listStyle}>
              {officeCompanies.length === 0 ? <Empty>لا توجد شركات لهذا المكتب.</Empty>
                : shownCompanies.length === 0 ? noMatch : (
                <ChipGrid min={180} style={{ padding: 0 }}>
                  {shownCompanies.map(c => {
                    const on = companyIds.includes(c.id);
                    const primary = !isMarketer && on && form.primaryCompanyId === c.id;
                    return (
                      <Chip key={c.id} wrap checked={on} label={c.name}
                        sub={primary ? 'الشركة الرئيسية' : showOfficeName ? offices.find(o => o.id === c.officeId)?.name : undefined}
                        onChange={v => toggleCompany(c.id, v)}
                        trailing={!isMarketer && on ? (
                          <button type="button" title="تعيينها الشركة الرئيسية" onClick={() => set({ primaryCompanyId: c.id })} style={{ ...iconBtn(primary ? '#b45309' : '#94a3b8'), fontSize: 15 }}>{primary ? '★' : '☆'}</button>
                        ) : undefined} />
                    );
                  })}
                </ChipGrid>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── الايتمات ── */}
      <div style={panel('items')}>
        {companyIds.length === 0 ? <Empty>اختر شركة أولاً من تبويب «الشركات» لتظهر ايتماتها هنا.</Empty> : (
          <>
            <PickerBar selected={itemIds.length} total={items.length}
              onAll={() => set({ itemIds: items.map(i => i.id) })}
              onNone={() => set({ itemIds: [] })} noneLabel="رجوع إلى كل الايتمات"
              {...searchProps('items', 'بحث عن ايتم...')} />
            {hint(itemIds.length === 0 ? '✓ بلا اختيار: يعمل المستخدم على كل ايتمات شركاته.' : 'يعمل المستخدم على الايتمات المؤشَّرة فقط.')}
            <div className="m-nu-scroll" style={listStyle}>
              {itemsLoad === 'loading' && items.length === 0 ? <Empty>جاري تحميل الايتمات...</Empty>
                : itemsLoad === 'error' ? <Empty>تعذّر تحميل الايتمات. أعد فتح النافذة وحاول مرة أخرى.</Empty>
                : items.length === 0 ? <Empty>لا توجد ايتمات في كتالوج الشركات المختارة.</Empty>
                : shownItemGroups.length === 0 ? noMatch
                : shownItemGroups.map(g => {
                  const ids = g.items.map(i => i.id);
                  return (
                    <GroupCard key={g.id} icon="🏭" title={g.name} total={ids.length}
                      sel={ids.filter(id => itemIds.includes(id)).length}
                      onToggleAll={on => set({ itemIds: setMany(itemIds, ids, on) })}
                      forceOpen={searching('items')} defaultOpen={itemGroups.length <= 3}>
                      <ChipGrid min={190}>
                        {g.shown.map(i => <Chip key={i.id} wrap checked={itemIds.includes(i.id)} label={i.name} onChange={on => set({ itemIds: setMany(itemIds, [i.id], on) })} />)}
                      </ChipGrid>
                    </GroupCard>
                  );
                })}
            </div>
          </>
        )}
      </div>

      {/* ── المناطق ── */}
      <div style={panel('areas')}>
        <PickerBar selected={effectiveAreaCount} total={areas.length}
          onAll={() => set({ areaIds: areas.filter(a => !provinceAreaIds.has(a.id) && !subAreaIds.has(a.id)).map(a => a.id) })}
          onNone={() => set({ areaIds: [], subProvinceIds: [] })}
          {...searchProps('areas', 'بحث عن منطقة...')} />
        {subProvinces.length > 0 && hint('مربع القسم (الكرخ / الرصافة) يعيّن القسم كاملاً، بما يُضاف إليه من مناطق لاحقاً.')}
        <SelectedTray tags={areaTags} />
        <div className="m-nu-scroll" style={listStyle}>
          {areasLoad === 'loading' ? <Empty>جاري تحميل المناطق...</Empty>
            : areasLoad === 'error' ? <Empty>تعذّر تحميل المناطق. أعد فتح النافذة وحاول مرة أخرى.</Empty>
            : areas.length === 0 ? <Empty>لا توجد مناطق معرّفة في النظام.</Empty>
            : shownAreaGroups.length === 0 ? noMatch
            : shownAreaGroups.map(g => {
              const viaProvince = provinceId != null && g.province?.id === provinceId;
              const wholeSub = !!g.sub && subProvinceIds.includes(g.sub.id);
              return (
                <GroupCard key={g.key} icon="📍" title={g.title} total={g.areas.length}
                  sel={g.areas.filter(a => areaIds.includes(a.id) || provinceAreaIds.has(a.id) || subAreaIds.has(a.id)).length}
                  onToggleAll={viaProvince ? undefined : on => toggleAreaGroup(g, on)}
                  badge={viaProvince ? <GroupBadge>عبر المحافظة</GroupBadge> : wholeSub ? <GroupBadge>القسم كامل</GroupBadge> : undefined}
                  forceOpen={searching('areas')} defaultOpen={areaGroups.length <= 4 || areaGroups.findIndex(x => x.key === g.key) < 2}>
                  <ChipGrid min={150}>
                    {g.shown.map(a => (
                      <Chip key={a.id} wrap disabled={provinceAreaIds.has(a.id)} label={a.name}
                        checked={areaIds.includes(a.id) || provinceAreaIds.has(a.id) || subAreaIds.has(a.id)}
                        onChange={on => toggleArea(a, on)} />
                    ))}
                  </ChipGrid>
                </GroupCard>
              );
            })}
        </div>
      </div>

      {/* ── المدراء ── */}
      <div style={panel('managers')}>
        <PickerBar selected={managerIds.length} total={managerChoices.length}
          onNone={() => set({ managerIds: [] })}
          {...searchProps('managers', 'بحث عن مدير...')} />
        <SelectedTray tags={userTags(managerIds, 'managerIds')} />
        <div className="m-nu-scroll" style={listStyle}>
          <UserGroups list={managerChoices.filter(matchUser('managers'))} selected={managerIds} roles={roles} forceOpen={searching('managers')}
            emptyText={searching('managers') ? 'لا توجد نتائج مطابقة' : 'لا يوجد مدراء في هذا المكتب.'}
            onChange={(ids, on) => set({ managerIds: setMany(managerIds, ids, on) })} />
        </div>
      </div>

      {/* ── التابعون ── */}
      <div style={panel('subs')}>
        <PickerBar selected={subIds.length} total={subChoices.length}
          onAll={() => set({ subordinateIds: subChoices.map(u => u.id) })}
          onNone={() => set({ subordinateIds: [] })}
          {...searchProps('subs', 'بحث عن موظف...')} />
        <SelectedTray tags={userTags(subIds, 'subordinateIds')} />
        <div className="m-nu-scroll" style={listStyle}>
          <UserGroups bulk list={subChoices.filter(matchUser('subs'))} selected={subIds} roles={roles} forceOpen={searching('subs')}
            emptyText={searching('subs') ? 'لا توجد نتائج مطابقة' : 'لا يوجد موظفون في هذا المكتب.'}
            onChange={(ids, on) => set({ subordinateIds: setMany(subIds, ids, on) })} />
        </div>
      </div>
    </div>
  );
}

function GroupBadge({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color: '#166534', background: '#dcfce7', borderRadius: 10, padding: '1px 8px' }}>{children}</span>;
}
