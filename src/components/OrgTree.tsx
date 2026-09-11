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
import type { CSSProperties } from 'react';

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
  .oview-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  .oview-switch { display:inline-flex; align-items:center; gap:2px; padding:3px; border-radius:10px; background: var(--c-bg, #f0f2f7); border:1px solid var(--c-border, #dde3ef); }
  .oview-switch-btn {
    display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:8px; border:none; cursor:pointer;
    font-size:12px; font-weight:600; background:transparent; color: var(--c-text-secondary, #5a6a8a);
  }
  .oview-switch-btn--active { background: var(--c-surface, #fff); color: var(--c-accent, #1a56db); box-shadow: 0 1px 3px rgba(15,23,42,0.08); }
  .oview-toolbar-actions { display:flex; align-items:center; gap:8px; }
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

  /* ── وضع «الشجرة» — بطاقات موصولة بخطوط، عمودياً (لا فروع أفقية عريضة) ── */
  .tview-root-group + .tview-root-group { margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--c-border, #dde3ef); }
  .tview-row { display:flex; align-items:center; gap:6px; }
  .tview-toggle {
    width:20px; height:20px; flex-shrink:0; border:1px solid var(--c-border, #dde3ef); background: var(--c-surface, #fff);
    cursor:pointer; padding:0; border-radius:50%; font-size:10px; color: var(--c-text-muted, #8fa0be);
    display:flex; align-items:center; justify-content:center;
  }
  .tview-toggle:hover { background: var(--c-accent-light, #ebf0fc); color: var(--c-accent, #1a56db); border-color: var(--c-accent, #1a56db); }
  .tview-card {
    position:relative; background: var(--c-surface, #fff); border-radius: 12px;
    border: 1px solid var(--c-border, #dde3ef); border-top: 3px solid var(--role-color, #64748b);
    padding: 7px 12px; min-width: 160px; max-width: 260px;
    box-shadow: 0 1px 3px rgba(15,23,42,0.05);
    cursor:pointer; display:flex; align-items:center; gap:9px;
    transition: box-shadow .15s, transform .15s;
  }
  .tview-card:hover { box-shadow: 0 5px 16px rgba(15,23,42,0.12); transform: translateY(-1px); }
  .tview-card-icon { width:30px; height:30px; border-radius:9px; flex-shrink:0; font-size:15px; display:flex; align-items:center; justify-content:center; }
  .tview-card-body { min-width:0; }
  .tview-card-name { font-weight:700; font-size:12.5px; color: var(--c-text-primary, #1a2332); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tview-card-meta { display:flex; align-items:center; gap:6px; margin-top:3px; }
  .tview-card-badge { font-size:10px; font-weight:600; border-radius:20px; padding:1px 7px; white-space:nowrap; }
  .tview-card-phone { font-size:10.5px; color: var(--c-text-muted, #8fa0be); white-space:nowrap; }
  .tview-card-off { font-size:9.5px; color: var(--c-danger, #dc2626); font-weight:700; background: var(--c-danger-bg, #fef2f2); border-radius:6px; padding:1px 6px; white-space:nowrap; }
  .tview-children {
    margin-inline-start: 27px; padding-inline-start: 22px; margin-top: 12px;
    border-inline-start: 2px solid var(--c-border, #dde3ef);
    display:flex; flex-direction:column; gap:12px;
  }
  .tview-children > .tview-node { position:relative; }
  .tview-children > .tview-node::before {
    content:''; position:absolute; top:18px; inset-inline-start:-22px; width:22px; height:0;
    border-top: 2px solid var(--c-border, #dde3ef);
  }
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

function TreeNode({ u, childrenMap, onSelect, collapsed, toggleCollapse, visited }: {
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
    <div className="tview-node">
      <div className="tview-row">
        <div className="tview-card" style={{ '--role-color': m.color } as CSSProperties} onClick={() => onSelect?.(u)}>
          <span className="tview-card-icon" style={{ background: `${m.color}18` }}>{m.icon}</span>
          <div className="tview-card-body">
            <div className="tview-card-name">{u.displayName || u.username}</div>
            <div className="tview-card-meta">
              <span className="tview-card-badge" style={{ color: m.color, background: `${m.color}15`, border: `1px solid ${m.color}30` }}>{m.label}</span>
              {u.phone && <span className="tview-card-phone">{u.phone}</span>}
              {!u.isActive && <span className="tview-card-off">معطل</span>}
            </div>
          </div>
        </div>
        {children.length > 0 && (
          <button
            type="button" className="tview-toggle"
            onClick={e => { e.stopPropagation(); toggleCollapse(u.id); }}
            title={isOpen ? `طيّ (${children.length})` : `فرد (${children.length})`}
          >{isOpen ? '▾' : '◂'}</button>
        )}
      </div>
      {isOpen && children.length > 0 && (
        <div className="tview-children">
          {children.map(c => (
            <TreeNode key={c.id} u={c} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={next} />
          ))}
        </div>
      )}
    </div>
  );
}

type OrgViewMode = 'list' | 'tree';

export function OrgTree({ users, onSelect }: { users: OrgUser[]; onSelect?: (u: OrgUser) => void }) {
  // كل المستخدمين مفروودون افتراضياً — الهدف إظهار أكبر عدد من الأسماء دفعة
  // واحدة؛ الطيّ متاح لكل عقدة (وزر «طيّ الكل») لمن يريد تضييق فرع كبير.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<OrgViewMode>(() => (localStorage.getItem('orgtree_view_mode') as OrgViewMode) || 'list');
  const setModeAndPersist = (m: OrgViewMode) => { setMode(m); localStorage.setItem('orgtree_view_mode', m); };
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
        <div className="oview-toolbar">
          <div className="oview-switch">
            <button type="button" className={`oview-switch-btn${mode === 'list' ? ' oview-switch-btn--active' : ''}`} onClick={() => setModeAndPersist('list')}>☰ قائمة</button>
            <button type="button" className={`oview-switch-btn${mode === 'tree' ? ' oview-switch-btn--active' : ''}`} onClick={() => setModeAndPersist('tree')}>🌳 شجرة</button>
          </div>
          {childrenMap.size > 0 && (
            <div className="oview-toolbar-actions">
              <button type="button" className="oview-toolbar-btn" onClick={expandAll}>⊞ فرد الكل</button>
              <button type="button" className="oview-toolbar-btn" onClick={collapseAll}>⊟ طيّ الكل</button>
            </div>
          )}
        </div>
        {mode === 'list' ? roots.map(u => (
          <div key={u.id} className="oview-root-group">
            <OrgRow u={u} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={new Set()} />
          </div>
        )) : roots.map(u => (
          <div key={u.id} className="tview-root-group">
            <TreeNode u={u} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={new Set()} />
          </div>
        ))}
      </div>
    </>
  );
}
