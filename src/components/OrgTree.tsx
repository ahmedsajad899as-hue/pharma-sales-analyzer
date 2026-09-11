// Reusable company org-chart (top-down hierarchy of users by manager/subordinate links).
// Extracted so both the super-admin CompaniesPage and the company-manager
// «الهيكلية» page can render the same chart.
//
// Rendered as a vertical, collapsible, indented list (not a horizontal box tree):
// far more names fit on screen at once (scroll is vertical, unconstrained by
// viewport width), no horizontal panning is needed to reach a branch, and rows
// stay legible regardless of name length. The hierarchy math (who is whose
// canonical single parent) is unchanged — only how it's drawn.
import { useMemo, useRef, useState } from 'react';
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

  /* ── وضع «الشجرة» — جذع مركزي عمودي وخطوط تفرّع أفقية إلى كل ابن (شكل شجرة
     عائلة/تنظيمية كلاسيكي)، بدل التمدد الأفقي العريض القديم لأننا نطوي الفروع
     الكبيرة بدل عرضها كاملة. direction:ltr على الحاويات فقط (هيكل الخطوط)
     تفادياً لانعكاس زوايا الوصلات في RTL؛ محتوى كل بطاقة يبقى RTL طبيعياً. ── */
  .cview-wrap { direction:ltr; overflow-x:auto; overflow-y:visible; padding:6px 6px 14px; cursor:grab; }
  .cview-wrap--dragging { cursor:grabbing; user-select:none; }
  .cview-root { list-style:none; margin:0; padding:0; display:flex; flex-wrap:nowrap; justify-content:flex-start; direction:ltr; }
  .cview-ul {
    list-style:none; margin:0; padding:0;
    display:flex; flex-wrap:nowrap; justify-content:flex-start;
    padding-top:14px; position:relative; direction:ltr;
  }
  .cview-ul::before {
    content:''; position:absolute; top:0; left:50%; transform:translateX(-50%);
    border-left:1.5px solid #94a3b8; width:0; height:14px;
  }
  .cview-li {
    display:inline-flex; flex-direction:column; align-items:center;
    position:relative; padding:14px 4px 0; text-align:center;
  }
  .cview-li::before, .cview-li::after {
    content:''; position:absolute; top:0;
    border-top:1.5px solid #94a3b8; width:50%; height:14px;
  }
  .cview-li::before { right:50%; }
  .cview-li::after  { left:50%; border-left:1.5px solid #94a3b8; }
  .cview-li:only-child::before, .cview-li:only-child::after { display:none; }
  .cview-li:only-child { padding-top:0; }
  .cview-li:first-child::before, .cview-li:last-child::after { border:0 none; }
  .cview-li:last-child::before  { border-right:1.5px solid #94a3b8; border-radius:0 4px 0 0; }
  .cview-li:first-child::after  { border-radius:4px 0 0 0; }
  .cview-card {
    position:relative; direction:rtl;
    background: var(--c-surface, #fff); border-radius: 7px;
    border: 1px solid var(--c-border, #dde3ef); border-top: 2px solid var(--role-color, #64748b);
    padding: 4px 8px; min-width: 76px; max-width: 132px;
    box-shadow: 0 1px 3px rgba(15,23,42,0.05);
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:1px;
    transition: box-shadow .15s, transform .15s;
  }
  .cview-card:hover { box-shadow: 0 5px 14px rgba(15,23,42,0.13); transform: translateY(-2px); }
  .cview-card--root { border-radius: 999px; padding: 6px 14px; min-width:90px; }
  .cview-card-icon { width:16px; height:16px; border-radius:5px; display:flex; align-items:center; justify-content:center; font-size:9px; margin-bottom:1px; }
  .cview-card--root .cview-card-icon { border-radius:50%; }
  .cview-card-name { font-weight:700; font-size:9px; color: var(--c-text-primary, #1a2332); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px; }
  .cview-card-badge { font-size:7px; font-weight:600; border-radius:20px; padding:0.5px 5px; white-space:nowrap; }
  .cview-card-phone { font-size:7px; color: var(--c-text-muted, #8fa0be); }
  .cview-card-off { font-size:6.5px; color: var(--c-danger, #dc2626); font-weight:700; }
  .cview-card-toggle {
    margin-top:2px; border:1px solid var(--c-border, #dde3ef); background: var(--c-bg, #f0f2f7);
    border-radius: 20px; padding: 0 6px; font-size:7.5px; font-weight:700; color: var(--c-text-secondary, #5a6a8a); cursor:pointer;
  }
  .cview-card-toggle:hover { background: var(--c-accent-light, #ebf0fc); color: var(--c-accent, #1a56db); border-color: var(--c-accent, #1a56db); }

  /* موظف/HR المكتب: خط جانبي (متقطّع، لا عمودي) يتفرّع من جهة البطاقة قبل خط
     مدراء الشركات الأساسي أسفلها — تمييزاً بين علاقة الدعم الإداري (جانبية)
     وعلاقة الإدارة التنفيذية (عمودية تنزل للأسفل بالخط الصلب المعتاد). */
  .cview-node-row { display:flex; align-items:center; }
  .cview-staff { display:flex; align-items:center; flex-shrink:0; }
  .cview-staff-cards { display:flex; align-items:center; gap:4px; }
  .cview-staff-connector { width:14px; height:0; border-top:1.5px dashed #94a3b8; flex-shrink:0; }
  .cview-mini-card {
    position:relative; direction:rtl; display:flex; align-items:center; gap:3px;
    background: var(--c-surface, #fff); border-radius:20px;
    border:1px dashed var(--c-border, #dde3ef); border-inline-start:2px dashed var(--role-color, #64748b);
    padding:2.5px 7px; cursor:pointer; white-space:nowrap; max-width:110px;
  }
  .cview-mini-card:hover { background: var(--c-accent-light, #ebf0fc); }
  .cview-mini-card-icon { font-size:8px; }
  .cview-mini-card-name { font-weight:700; font-size:7.5px; color: var(--c-text-primary, #1a2332); overflow:hidden; text-overflow:ellipsis; }
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

// موظف مكتب/HR: علاقة دعم إداري لا إدارة تنفيذية — يُعرض كبطاقة صغيرة على خط
// جانبي متقطّع بجهة البطاقة الأصلية، قبل (يسار) خط الفروع التنفيذي أسفلها،
// بدل أن يُحسب ابناً عادياً في السلسلة العمودية الرئيسية.
const STAFF_ROLES = new Set(['office_employee', 'office_hr']);

// عقدة واحدة في «الشجرة الكلاسيكية»: بطاقة، وإن كانت لها فروع فـ<ul> تحتها
// يحمل خط جذع عمودي (::before) وخطوط تفرّع أفقية لكل ابن (::before/::after) —
// نفس تقنية CSS المستعملة في الرسم المطلوب: جذع مركزي وخط أفقي إلى كل بطاقة.
function ClassicBranch({ u, childrenMap, onSelect, collapsed, toggleCollapse, visited, isRoot }: {
  u: OrgUser; childrenMap: Map<number, OrgUser[]>;
  onSelect?: (u: OrgUser) => void;
  collapsed: Set<number>; toggleCollapse: (id: number) => void;
  visited: Set<number>; isRoot?: boolean;
}) {
  if (visited.has(u.id)) return null; // safety net against malformed cyclic manager links
  const next = new Set(visited); next.add(u.id);
  const m = ROLE_META[u.role] ?? DEF_META;
  const allChildren = childrenMap.get(u.id) ?? [];
  const staffChildren = allChildren.filter(c => STAFF_ROLES.has(c.role));
  const lineChildren = allChildren.filter(c => !STAFF_ROLES.has(c.role));
  const isOpen = !collapsed.has(u.id);
  return (
    <li className="cview-li">
      <div className="cview-node-row">
        {staffChildren.length > 0 && (
          <div className="cview-staff">
            <div className="cview-staff-cards">
              {staffChildren.map(s => {
                const sm = ROLE_META[s.role] ?? DEF_META;
                return (
                  <div
                    key={s.id} className="cview-mini-card"
                    style={{ '--role-color': sm.color } as CSSProperties}
                    onClick={() => onSelect?.(s)} title={`${s.displayName || s.username} — ${sm.label}`}
                  >
                    <span className="cview-mini-card-icon">{sm.icon}</span>
                    <span className="cview-mini-card-name">{s.displayName || s.username}</span>
                  </div>
                );
              })}
            </div>
            <span className="cview-staff-connector" />
          </div>
        )}
        <div
          className={`cview-card${isRoot ? ' cview-card--root' : ''}`}
          style={{ '--role-color': m.color } as CSSProperties}
          onClick={() => onSelect?.(u)}
        >
          <span className="cview-card-icon" style={{ background: `${m.color}18` }}>{m.icon}</span>
          <span className="cview-card-name">{u.displayName || u.username}</span>
          <span className="cview-card-badge" style={{ color: m.color, background: `${m.color}15`, border: `1px solid ${m.color}30` }}>{m.label}</span>
          {u.phone && <span className="cview-card-phone">{u.phone}</span>}
          {!u.isActive && <span className="cview-card-off">معطل</span>}
          {lineChildren.length > 0 && (
            <button
              type="button" className="cview-card-toggle"
              onClick={e => { e.stopPropagation(); toggleCollapse(u.id); }}
              title={isOpen ? 'طيّ الفرع' : 'فرد الفرع'}
            >{isOpen ? `− ${lineChildren.length}` : `+ ${lineChildren.length}`}</button>
          )}
        </div>
      </div>
      {isOpen && lineChildren.length > 0 && (
        <ul className="cview-ul">
          {lineChildren.map(c => (
            <ClassicBranch key={c.id} u={c} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={next} />
          ))}
        </ul>
      )}
    </li>
  );
}

// حاوية «الشجرة الكلاسيكية» — سحب بالماوس للتمرير الأفقي عند اتساع الفروع
// المفرودة (نفس أسلوب التصميم الأصلي القديم قبل إعادة التصميم كقائمة مضغوطة).
function ClassicTreeView({ roots, childrenMap, onSelect, collapsed, toggleCollapse }: {
  roots: OrgUser[]; childrenMap: Map<number, OrgUser[]>;
  onSelect?: (u: OrgUser) => void;
  collapsed: Set<number>; toggleCollapse: (id: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cview-card')) return; // لا تسحب عند النقر على بطاقة (يفتح تفاصيلها)
    const el = wrapRef.current;
    if (!el) return;
    dragRef.current = { startX: e.clientX, startScrollLeft: el.scrollLeft };
    setDragging(true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const st = dragRef.current;
    const el = wrapRef.current;
    if (!st || !el) return;
    el.scrollLeft = st.startScrollLeft - (e.clientX - st.startX);
  };
  const endDrag = () => { dragRef.current = null; setDragging(false); };

  return (
    <div
      ref={wrapRef} className={`cview-wrap${dragging ? ' cview-wrap--dragging' : ''}`}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag}
    >
      <ul className="cview-root">
        {roots.map(u => (
          <ClassicBranch key={u.id} u={u} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} visited={new Set()} isRoot />
        ))}
      </ul>
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
        )) : (
          <ClassicTreeView roots={roots} childrenMap={childrenMap} onSelect={onSelect} collapsed={collapsed} toggleCollapse={toggleCollapse} />
        )}
      </div>
    </>
  );
}
