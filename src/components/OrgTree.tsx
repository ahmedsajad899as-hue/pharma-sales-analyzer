// Reusable company org-chart (top-down hierarchy of users by manager/subordinate links).
// Extracted so both the super-admin CompaniesPage and the company-manager
// «الهيكلية» page can render the same chart.
//
// Rendered as a vertical, collapsible, indented list (not a horizontal box tree):
// far more names fit on screen at once (scroll is vertical, unconstrained by
// viewport width), no horizontal panning is needed to reach a branch, and rows
// stay legible regardless of name length. The hierarchy math (who is whose
// canonical single parent) is unchanged — only how it's drawn.
import { useMemo, useState } from 'react';

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

const ORG_CSS = `
  .oview-list { font-size: 13px; }
  .oview-toolbar { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:12px; }
  .oview-toolbar-btn {
    display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:8px;
    font-size:12px; font-weight:600; cursor:pointer;
    border:1px solid var(--c-border, #dde3ef); background: var(--c-surface, #fff); color: var(--c-text-secondary, #5a6a8a);
  }
  .oview-toolbar-btn:hover { background: var(--c-accent-light, #ebf0fc); color: var(--c-accent, #1a56db); border-color: var(--c-accent, #1a56db); }
  .oview-root-group { border-radius: 12px; }
  .oview-root-group + .oview-root-group { margin-top: 10px; padding-top: 12px; border-top: 1px dashed var(--c-border, #dde3ef); }
  .oview-row {
    display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; cursor:pointer;
    transition: background .12s;
  }
  .oview-row:hover { background: var(--c-border-light, #edf0f7); }
  .oview-toggle {
    width:18px; height:18px; flex-shrink:0; border:none; background:transparent; cursor:pointer; padding:0;
    display:flex; align-items:center; justify-content:center; font-size:10px; color: var(--c-text-muted, #8fa0be);
    border-radius:4px;
  }
  .oview-toggle:hover { background: var(--c-border, #dde3ef); }
  .oview-toggle-spacer { width:18px; flex-shrink:0; }
  .oview-icon {
    width:26px; height:26px; border-radius:8px; flex-shrink:0; font-size:13px;
    display:flex; align-items:center; justify-content:center;
  }
  .oview-name { font-weight:700; font-size:12.5px; color: var(--c-text-primary, #1a2332); white-space:nowrap; }
  .oview-badge { font-size:10px; font-weight:600; border-radius:20px; padding:1.5px 8px; white-space:nowrap; flex-shrink:0; }
  .oview-phone { font-size:11px; color: var(--c-text-muted, #8fa0be); flex-shrink:0; white-space:nowrap; }
  .oview-off { font-size:10px; color: var(--c-danger, #dc2626); font-weight:700; background: var(--c-danger-bg, #fef2f2); border-radius:6px; padding:1px 6px; flex-shrink:0; white-space:nowrap; }
  .oview-count { font-size:10.5px; color: var(--c-text-muted, #8fa0be); flex-shrink:0; margin-inline-start:auto; padding-inline-start:8px; }
  .oview-children { padding-inline-start:20px; margin-inline-start:12px; border-inline-start:1.5px solid var(--c-border, #dde3ef); }
`;

function OrgRow({ u, childrenMap, onSelect, collapsed, toggleCollapse, visited }: {
  u: OrgUser; childrenMap: Map<number, OrgUser[]>;
  onSelect?: (u: OrgUser) => void;
  collapsed: Set<number>; toggleCollapse: (id: number) => void;
  visited: Set<number>;
}) {
  if (visited.has(u.id)) return null; // safety net against malformed cyclic manager links
  const next = new Set(visited); next.add(u.id);
  const m = ROLE_META[u.role] ?? DEF_META;
  const children = childrenMap.get(u.id) ?? [];
  const isOpen = !collapsed.has(u.id);
  return (
    <div className="oview-node">
      <div className="oview-row" onClick={() => onSelect?.(u)}>
        {children.length > 0 ? (
          <button
            type="button" className="oview-toggle"
            onClick={e => { e.stopPropagation(); toggleCollapse(u.id); }}
            title={isOpen ? 'طيّ' : 'فرد'}
          >{isOpen ? '▾' : '◂'}</button>
        ) : <span className="oview-toggle-spacer" />}
        <span className="oview-icon" style={{ background: `${m.color}18` }}>{m.icon}</span>
        <span className="oview-name">{u.displayName || u.username}</span>
        <span className="oview-badge" style={{ color: m.color, background: `${m.color}15`, border: `1px solid ${m.color}30` }}>{m.label}</span>
        {u.phone && <span className="oview-phone">{u.phone}</span>}
        {!u.isActive && <span className="oview-off">معطل</span>}
        {children.length > 0 && <span className="oview-count">{children.length}</span>}
      </div>
      {isOpen && children.length > 0 && (
        <div className="oview-children">
          {children.map(c => (
            <OrgRow key={c.id} u={c} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={next} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OrgTree({ users, onSelect }: { users: OrgUser[]; onSelect?: (u: OrgUser) => void }) {
  // كل المستخدمين مفروودون افتراضياً — الهدف إظهار أكبر عدد من الأسماء دفعة
  // واحدة؛ الطيّ متاح لكل عقدة (وزر «طيّ الكل») لمن يريد تضييق فرع كبير.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapse = (id: number) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const { roots, childrenMap } = useMemo(() => {
    const canonicalParents = buildCanonicalParentMap(users);
    const byParent = new Map<number, OrgUser[]>();
    for (const u of users) {
      const pid = canonicalParents.get(u.id);
      if (pid == null) continue;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(u);
    }
    const rootList = users.filter(u => canonicalParents.get(u.id) == null);
    return { roots: rootList.length > 0 ? rootList : users, childrenMap: byParent };
  }, [users]);

  const collapseAll = () => setCollapsed(new Set(childrenMap.keys()));
  const expandAll = () => setCollapsed(new Set());

  if (users.length === 0) return (
    <div style={{ textAlign: 'center', color: 'var(--c-text-muted, #8fa0be)', padding: '40px 0', fontSize: 14 }}>
      لا يوجد مستخدمون مرتبطون بعد
    </div>
  );

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ORG_CSS }} />
      <div className="oview-list">
        {childrenMap.size > 0 && (
          <div className="oview-toolbar">
            <button type="button" className="oview-toolbar-btn" onClick={expandAll}>⊞ فرد الكل</button>
            <button type="button" className="oview-toolbar-btn" onClick={collapseAll}>⊟ طيّ الكل</button>
          </div>
        )}
        {roots.map(u => (
          <div key={u.id} className="oview-root-group">
            <OrgRow u={u} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={new Set()} />
          </div>
        ))}
      </div>
    </>
  );
}
