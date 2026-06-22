// Reusable company org-chart (top-down hierarchy of users by manager/subordinate links).
// Extracted so both the super-admin CompaniesPage and the company-manager
// «الهيكلية» page can render the same chart.

export interface OrgUser {
  id: number; username: string; displayName?: string | null;
  role: string; isActive: boolean; phone?: string | null;
  managerIds: number[]; subordinateIds: number[];
}

export const ROLE_META: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  company_manager:        { label: 'مدير شركة',          color: '#7c3aed', bg: '#f5f3ff', icon: '👔' },
  supervisor:             { label: 'مشرف',                color: '#1d4ed8', bg: '#eff6ff', icon: '🗂️' },
  product_manager:        { label: 'مدير منتج',           color: '#0369a1', bg: '#e0f2fe', icon: '📦' },
  team_leader:            { label: 'قائد فريق',           color: '#0891b2', bg: '#ecfeff', icon: '👥' },
  scientific_rep:         { label: 'مندوب علمي',          color: '#059669', bg: '#f0fdf4', icon: '🔬' },
  commercial_supervisor:  { label: 'مشرف تجاري',          color: '#b45309', bg: '#fffbeb', icon: '💼' },
  commercial_team_leader: { label: 'قائد فريق تجاري',     color: '#c2410c', bg: '#fff7ed', icon: '🏢' },
  commercial_rep:         { label: 'مندوب تجاري',         color: '#dc2626', bg: '#fff1f2', icon: '🏷️' },
  office_manager:         { label: 'مدير مكتب',           color: '#4f46e5', bg: '#eef2ff', icon: '🏛️' },
  office_hr:              { label: 'HR مكتب',             color: '#0d9488', bg: '#f0fdfa', icon: '👤' },
  office_employee:        { label: 'موظف مكتب',           color: '#6b7280', bg: '#f9fafb', icon: '🖥️' },
  admin:                  { label: 'مدير',                 color: '#374151', bg: '#f9fafb', icon: '⚙️' },
  manager:                { label: 'مدير',                 color: '#374151', bg: '#f9fafb', icon: '⚙️' },
};
export const DEF_META = { label: 'مستخدم', color: '#64748b', bg: '#f8fafc', icon: '👤' };

// direction:ltr forced on tree containers so RTL layout doesn't reverse the
// connectors / corner styles.
const ORG_CSS = `
  .otree-wrap { direction:ltr; overflow-x:auto; overflow-y:visible; padding:4px 8px 12px; }
  .otree-root { list-style:none; margin:0; padding:0; display:flex; flex-wrap:nowrap; justify-content:center; direction:ltr; }
  .otree-ul   {
    list-style:none; margin:0; padding:0;
    display:flex; flex-wrap:nowrap; justify-content:center;
    padding-top:16px; position:relative; direction:ltr;
  }
  .otree-ul::before {
    content:''; position:absolute; top:0; left:50%;
    transform:translateX(-50%);
    border-left:1.5px solid #94a3b8; width:0; height:16px;
  }
  .otree-li {
    display:inline-flex; flex-direction:column; align-items:center;
    position:relative; padding:16px 4px 0; text-align:center;
  }
  .otree-li::before, .otree-li::after {
    content:''; position:absolute; top:0;
    border-top:1.5px solid #94a3b8; width:50%; height:16px;
  }
  .otree-li::before { right:50%; }
  .otree-li::after  { left:50%; border-left:1.5px solid #94a3b8; }
  .otree-li:only-child::before, .otree-li:only-child::after { display:none; }
  .otree-li:only-child { padding-top:0; }
  .otree-li:first-child::before, .otree-li:last-child::after { border:0 none; }
  .otree-li:last-child::before  { border-right:1.5px solid #94a3b8; border-radius:0 4px 0 0; }
  .otree-li:first-child::after  { border-radius:4px 0 0 0; }
  .otree-card {
    position:relative; direction:rtl;
    background:#fff; border-radius:8px;
    padding:5px 7px; min-width:82px; max-width:108px;
    box-shadow:0 1px 5px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05);
    cursor:pointer; transition:transform .15s, box-shadow .15s;
    display:flex; flex-direction:column; align-items:center; gap:2px;
  }
  .otree-card:hover { transform:translateY(-2px); box-shadow:0 4px 14px rgba(0,0,0,0.11); }
  .otree-card-icon {
    width:26px; height:26px; border-radius:7px;
    display:flex; align-items:center; justify-content:center;
    font-size:12px; margin-bottom:1px; flex-shrink:0;
  }
  .otree-card-name  { font-weight:700; font-size:9.5px; color:#1e293b; line-height:1.3; }
  .otree-card-badge { font-size:7.5px; font-weight:600; border-radius:20px; padding:1px 5px; white-space:nowrap; }
  .otree-card-phone { font-size:7.5px; color:#94a3b8; }
  .otree-card-off   { font-size:7px; color:#dc2626; font-weight:700; }
`;

function OrgCard({ u, onSelect }: { u: OrgUser; onSelect?: (u: OrgUser) => void }) {
  const m = ROLE_META[u.role] ?? DEF_META;
  return (
    <div className="otree-card" onClick={() => onSelect?.(u)} style={{ borderTop: `3px solid ${m.color}`, opacity: u.isActive ? 1 : 0.6 }}>
      <div className="otree-card-icon" style={{ background: `${m.color}18` }}>{m.icon}</div>
      <div className="otree-card-name">{u.displayName || u.username}</div>
      <span className="otree-card-badge" style={{ color: m.color, background: `${m.color}15`, border: `1px solid ${m.color}30` }}>{m.label}</span>
      {u.phone && <div className="otree-card-phone">{u.phone}</div>}
      {!u.isActive && <div className="otree-card-off">⚠️ معطل</div>}
    </div>
  );
}

// When a user has multiple managers, render them only under their deepest/most-direct
// manager so the tree stays a clean top-down hierarchy without duplicate branches.
function _orgIsAncestor(ancestorId: number, userId: number, userMap: Map<number, OrgUser>, visited = new Set<number>()): boolean {
  if (visited.has(userId)) return false;
  visited.add(userId);
  const u = userMap.get(userId);
  if (!u) return false;
  if (u.managerIds.includes(ancestorId)) return true;
  return u.managerIds.some(mid => _orgIsAncestor(ancestorId, mid, userMap, visited));
}
function buildCanonicalParentMap(users: OrgUser[]): Map<number, number | null> {
  const userMap = new Map(users.map(u => [u.id, u]));
  const result  = new Map<number, number | null>();
  for (const u of users) {
    if (u.managerIds.length === 0) { result.set(u.id, null); continue; }
    if (u.managerIds.length === 1) { result.set(u.id, u.managerIds[0]); continue; }
    const deepest = u.managerIds.find(mid =>
      u.managerIds.filter(id => id !== mid).every(otherId => _orgIsAncestor(otherId, mid, userMap))
    );
    result.set(u.id, deepest ?? u.managerIds[0]);
  }
  return result;
}

function OrgBranch({ u, all, canonicalParents, visited, onSelect }: {
  u: OrgUser; all: OrgUser[]; canonicalParents: Map<number, number | null>;
  visited: Set<number>; onSelect?: (u: OrgUser) => void
}) {
  if (visited.has(u.id)) return null;
  const next = new Set(visited); next.add(u.id);
  const children = all.filter(c => canonicalParents.get(c.id) === u.id && !next.has(c.id));
  return (
    <li className="otree-li">
      <OrgCard u={u} onSelect={onSelect} />
      {children.length > 0 && (
        <ul className="otree-ul">
          {children.map(c => <OrgBranch key={c.id} u={c} all={all} canonicalParents={canonicalParents} visited={next} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

export function OrgTree({ users, onSelect }: { users: OrgUser[]; onSelect?: (u: OrgUser) => void }) {
  if (users.length === 0) return (
    <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0', fontSize: 14 }}>
      لا يوجد مستخدمون مرتبطون بعد
    </div>
  );
  const canonicalParents = buildCanonicalParentMap(users);
  const roots = users.filter(u => canonicalParents.get(u.id) === null);
  const startNodes = roots.length > 0 ? roots : users;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ORG_CSS }} />
      <div className="otree-wrap">
        <ul className="otree-root">
          {startNodes.map(u => <OrgBranch key={u.id} u={u} all={users} canonicalParents={canonicalParents} visited={new Set()} onSelect={onSelect} />)}
        </ul>
      </div>
    </>
  );
}
