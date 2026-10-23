import { useEffect, useMemo, useState } from 'react';
import { ACCENT } from './AssignUI';

// تعيين مختصر عند إنشاء مستخدم جديد: الشركات، الايتمات، المناطق (أو الكرخ/الرصافة
// كاملة)، المدير المباشر، والموظفون التابعون. كل قسم سطر واحد مطوي بملخّصه، ينفتح
// بالضغط. القيم تُحفظ في form وتُرسل بعد إنشاء الحساب (saveUser في UsersPage).
// تعديل حساب موجود يبقى في تبويبات صفحة المستخدم المفصّلة.

interface Named { id: number; name: string }
interface UserLite { id: number; username: string; displayName?: string; role: string; officeId?: number; isActive: boolean }

const MANAGER_ROLES = new Set(['company_manager', 'team_leader', 'supervisor', 'product_manager', 'office_manager', 'commercial_supervisor', 'commercial_team_leader']);
const userName = (u: UserLite) => u.displayName || u.username;

type Key = 'companies' | 'items' | 'areas' | 'manager' | 'subs';

export default function NewUserAssignments({ form, setForm, role, companies, users, token, isOfficeRole, isMarketer }: {
  form: any; setForm: any;
  role: string;            // الدور الفعلي (بعد تحويل خيارات الفارمسي)
  companies: (Named & { officeId: number })[];
  users: UserLite[];
  token?: string;
  isOfficeRole: boolean;   // أدوار المكتب تأخذ كل شركاته تلقائياً
  isMarketer: boolean;     // المسوق: بلا شركة رئيسية
}) {
  const [open, setOpen] = useState<Key | null>(null);
  const [q, setQ] = useState('');
  const [areas, setAreas] = useState<(Named & { subProvinceId?: number | null })[]>([]);
  const [subProvinces, setSubProvinces] = useState<Named[]>([]);
  const [items, setItems] = useState<Named[]>([]);
  const H = { Authorization: `Bearer ${token}` };

  const companyIds: number[] = form.companyIds ?? [];
  const itemIds: number[] = form.itemIds ?? [];
  const areaIds: number[] = form.areaIds ?? [];
  const subProvinceIds: number[] = form.subProvinceIds ?? [];
  const subIds: number[] = form.subordinateIds ?? [];
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const toggleIn = (list: number[], id: number) => list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  useEffect(() => {
    Promise.all([
      fetch('/api/sa/areas', { headers: H }).then(r => r.json()).catch(() => null),
      fetch('/api/sa/sub-provinces', { headers: H }).then(r => r.json()).catch(() => null),
    ]).then(([a, sp]) => {
      if (a?.success) setAreas(a.data);
      if (sp?.success) setSubProvinces(sp.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ايتمات الشركات المختارة (معاينة بلا حفظ — نفس endpoint تبويب «الايتمات»).
  useEffect(() => {
    if (!companyIds.length) { setItems([]); return; }
    fetch(`/api/sa/users/0/company-items?companyIds=${companyIds.join(',')}`, { headers: H })
      .then(r => r.json()).then(j => setItems(j?.success ? j.data : [])).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyIds.join(',')]);

  const officeCompanies = form.officeId ? companies.filter(c => c.officeId === Number(form.officeId)) : companies;
  const officeUsers = users.filter(u => u.isActive && (!form.officeId || u.officeId === Number(form.officeId)));
  const managerChoices = officeUsers.filter(u => MANAGER_ROLES.has(u.role));
  const subChoices = officeUsers;
  const sideAreaIds = useMemo(() => new Set(areas.filter(a => a.subProvinceId && subProvinceIds.includes(a.subProvinceId)).map(a => a.id)), [areas, subProvinceIds]);

  const toggleOpen = (k: Key) => { setOpen(o => o === k ? null : k); setQ(''); };
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  const summary: Record<Key, string> = {
    companies: isOfficeRole ? 'كل شركات المكتب تلقائياً' : companyIds.length ? `${companyIds.length} شركة${!isMarketer && form.primaryCompanyId ? ` · الرئيسية: ${companies.find(c => c.id === form.primaryCompanyId)?.name ?? ''}` : ''}` : 'لا شيء',
    items:     itemIds.length ? `${itemIds.length} ايتم` : 'كل ايتمات الشركات',
    areas:     [subProvinceIds.length ? subProvinces.filter(s => subProvinceIds.includes(s.id)).map(s => `${s.name} كاملة`).join('، ') : '', areaIds.length ? `${areaIds.length} منطقة` : ''].filter(Boolean).join(' + ') || 'لا شيء',
    manager:   form.managerId ? userName(users.find(u => u.id === form.managerId) as UserLite) : 'لا أحد',
    subs:      subIds.length ? `${subIds.length} موظف` : 'لا أحد',
  };

  const rows: { key: Key; icon: string; label: string; show: boolean }[] = [
    { key: 'companies', icon: '🏭', label: 'الشركات',  show: true },
    { key: 'items',     icon: '💊', label: 'الايتمات', show: !isOfficeRole && companyIds.length > 0 },
    { key: 'areas',     icon: '📍', label: 'المناطق',  show: true },
    { key: 'manager',   icon: '⬆️', label: 'المدير',   show: true },
    { key: 'subs',      icon: '⬇️', label: 'الموظفون التابعون', show: MANAGER_ROLES.has(role) },
  ];

  const chip = (on: boolean, label: string, onClick: () => void, extra?: React.ReactNode) => (
    <button type="button" onClick={onClick} style={{
      border: `1px solid ${on ? '#c7d2fe' : '#e5e7eb'}`, background: on ? '#eef2ff' : '#fff',
      color: on ? '#3730a3' : '#475569', borderRadius: 16, padding: '4px 10px', fontSize: 12.5,
      cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>{on ? '✓ ' : ''}{label}{extra}</button>
  );
  const searchBox = (
    <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث..." autoComplete="off"
      style={{ width: '100%', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12.5, boxSizing: 'border-box', marginBottom: 8 }} />
  );
  const wrap = { display: 'flex', flexWrap: 'wrap' as const, gap: 5, maxHeight: 180, overflowY: 'auto' as const };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      {rows.filter(r => r.show).map((r, i) => (
        <div key={r.key} style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
          <button type="button" onClick={() => !(r.key === 'companies' && isOfficeRole) && toggleOpen(r.key)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
            background: open === r.key ? '#f8fafc' : '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'right',
          }}>
            <span style={{ fontSize: 14 }}>{r.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{r.label}</span>
            <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{summary[r.key]}</span>
            {!(r.key === 'companies' && isOfficeRole) && <span style={{ fontSize: 10, color: '#94a3b8' }}>{open === r.key ? '▼' : '◀'}</span>}
          </button>

          {open === r.key && (
            <div style={{ padding: '4px 12px 12px', background: '#f8fafc' }}>
              {r.key === 'companies' && (
                <>
                  {officeCompanies.length > 8 && searchBox}
                  <div style={wrap}>
                    {officeCompanies.filter(c => match(c.name)).map(c => chip(companyIds.includes(c.id), c.name, () => {
                      const next = toggleIn(companyIds, c.id);
                      const primary = next.includes(form.primaryCompanyId) ? form.primaryCompanyId : (next[0] ?? null);
                      set({ companyIds: next, primaryCompanyId: primary, itemIds: [] });
                    }, !isMarketer && companyIds.includes(c.id) && form.primaryCompanyId === c.id ? <span style={{ color: '#b45309' }}> ⭐</span> : null))}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 12 }}>
                    <button type="button" onClick={() => set({ companyIds: officeCompanies.map(c => c.id), primaryCompanyId: form.primaryCompanyId ?? officeCompanies[0]?.id ?? null })} style={linkBtn}>تحديد الكل</button>
                    <button type="button" onClick={() => set({ companyIds: [], primaryCompanyId: null, itemIds: [] })} style={{ ...linkBtn, color: '#64748b' }}>إلغاء</button>
                    {!isMarketer && companyIds.length > 1 && (
                      <select value={form.primaryCompanyId ?? ''} onChange={e => set({ primaryCompanyId: Number(e.target.value) })}
                        style={{ marginRight: 'auto', fontSize: 12, padding: '2px 6px', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                        {companyIds.map(id => <option key={id} value={id}>⭐ الرئيسية: {companies.find(c => c.id === id)?.name}</option>)}
                      </select>
                    )}
                  </div>
                </>
              )}

              {r.key === 'items' && (
                <>
                  <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 6 }}>بلا اختيار = كل ايتمات الشركات المختارة.</div>
                  {searchBox}
                  <div style={wrap}>
                    {items.filter(it => match(it.name)).map(it => chip(itemIds.includes(it.id), it.name, () => set({ itemIds: toggleIn(itemIds, it.id) })))}
                  </div>
                  {itemIds.length > 0 && <button type="button" onClick={() => set({ itemIds: [] })} style={{ ...linkBtn, color: '#64748b', marginTop: 8 }}>رجوع إلى كل الايتمات</button>}
                </>
              )}

              {r.key === 'areas' && (
                <>
                  {subProvinces.length > 0 && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                      {subProvinces.map(s => chip(subProvinceIds.includes(s.id), `${s.name} كاملة`, () => set({ subProvinceIds: toggleIn(subProvinceIds, s.id) })))}
                    </div>
                  )}
                  {searchBox}
                  <div style={wrap}>
                    {areas.filter(a => !sideAreaIds.has(a.id) && (match(a.name) || areaIds.includes(a.id)))
                      .sort((a, b) => Number(areaIds.includes(b.id)) - Number(areaIds.includes(a.id)))
                      .slice(0, q.trim() ? 200 : 60)
                      .map(a => chip(areaIds.includes(a.id), a.name, () => set({ areaIds: toggleIn(areaIds, a.id) })))}
                  </div>
                  {!q.trim() && areas.length > 60 && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>اكتب في البحث لعرض بقية المناطق.</div>}
                </>
              )}

              {r.key === 'manager' && (
                <select value={form.managerId ?? ''} onChange={e => set({ managerId: e.target.value ? Number(e.target.value) : null })}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
                  <option value="">— بلا مدير —</option>
                  {managerChoices.map(u => <option key={u.id} value={u.id}>{userName(u)}</option>)}
                </select>
              )}

              {r.key === 'subs' && (
                <>
                  {searchBox}
                  <div style={wrap}>
                    {subChoices.filter(u => match(userName(u)) || subIds.includes(u.id))
                      .map(u => chip(subIds.includes(u.id), userName(u), () => set({ subordinateIds: toggleIn(subIds, u.id) })))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: ACCENT, fontWeight: 700, fontSize: 12, padding: 0, fontFamily: 'inherit' };
