import { useMemo, useState, Fragment } from 'react';
import { btnStyle } from './OfficesPage';
import { FEATURE_TREE } from '../../config/featureConfig';
import type { FeatureNode } from '../../config/featureConfig';

const ROLES: Record<string, string> = {
  office_manager:         'مدير مكتب',
  office_hr:              'HR مكتب',
  office_employee:        'موظف مكتب',
  company_manager:        'مدير شركة',
  supervisor:             'مشرف',
  product_manager:        'مدير منتج',
  team_leader:            'قائد فريق',
  scientific_rep:         'مندوب علمي',
  commercial_supervisor:  'مشرف تجاري',
  commercial_team_leader: 'قائد فريق تجاري',
  commercial_rep:         'مندوب تجاري',
  admin:                  'مدير (admin)',
  manager:                'مدير (manager)',
};

interface UserRow {
  id: number; username: string; displayName?: string; role: string; isActive: boolean;
  officeId?: number; office?: { id: number; name: string }; permissions?: string | null;
}

// يُبنى مرة واحدة: خانة لكل صفحة (المفتاح الأم) + optgroup لميزاتها الفرعية إن وُجدت
const FEATURE_BLOCKS = FEATURE_TREE
  .map(node => ({
    groupLabel: node.label,
    groupIcon:  node.icon,
    parent:     node.key ? { key: node.key, label: node.label, icon: node.icon } : null,
    children:   (node.children ?? []).filter((c): c is FeatureNode & { key: string } => !!c.key),
  }))
  .filter(b => b.parent || b.children.length > 0);

const FEATURE_LABEL_BY_KEY: Record<string, string> = {};
const FEATURE_DESC_BY_KEY: Record<string, string | undefined> = {};
for (const node of FEATURE_TREE) {
  if (node.key) { FEATURE_LABEL_BY_KEY[node.key] = `${node.icon} ${node.label}`; FEATURE_DESC_BY_KEY[node.key] = node.desc; }
  for (const c of node.children ?? []) {
    if (c.key) { FEATURE_LABEL_BY_KEY[c.key] = `${node.icon} ${node.label} ‹ ${c.icon} ${c.label}`; FEATURE_DESC_BY_KEY[c.key] = c.desc; }
  }
}

function isEnabledFor(u: UserRow, featureKey: string): boolean {
  if (!featureKey) return true;
  try {
    const p = JSON.parse(u.permissions || '{}');
    return !((p.disabledFeatures ?? []) as string[]).includes(featureKey);
  } catch { return true; }
}

export default function BulkFeatureToggleModal({ users, token, onClose, onApplied }: {
  users: UserRow[]; token: string | null; onClose: () => void; onApplied: () => void;
}) {
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [featureKey, setFeatureKey] = useState('');
  const [search,     setSearch]     = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [selected,   setSelected]   = useState<Set<number>>(new Set());
  const [applying,   setApplying]   = useState<'' | 'enable' | 'disable'>('');
  const [result,     setResult]     = useState<{ updated: number; failed: number } | null>(null);
  const [error,      setError]      = useState('');

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter(u => !roleFilter || u.role === roleFilter)
      .filter(u => !q || u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
      .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
  }, [users, search, roleFilter]);

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible    = () => setSelected(prev => new Set([...prev, ...filteredUsers.map(u => u.id)]));
  const deselectAllVisible  = () => setSelected(prev => { const next = new Set(prev); for (const u of filteredUsers) next.delete(u.id); return next; });
  const selectVisibleWhere  = (want: 'enabled' | 'disabled') =>
    setSelected(prev => new Set([...prev, ...filteredUsers.filter(u => isEnabledFor(u, featureKey) === (want === 'enabled')).map(u => u.id)]));

  const apply = async (enabled: boolean) => {
    if (!featureKey || selected.size === 0) return;
    setApplying(enabled ? 'enable' : 'disable');
    setError(''); setResult(null);
    try {
      const res = await fetch('/api/sa/users/bulk-features', {
        method: 'PUT', headers: H(),
        body: JSON.stringify({ userIds: Array.from(selected), featureKey, enabled }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { setError(j.error || 'فشل التطبيق'); return; }
      setResult({ updated: j.updated ?? selected.size, failed: (j.failed ?? []).length });
      setSelected(new Set());
      onApplied();
    } catch {
      setError('تعذّر الاتصال بالخادم');
    } finally {
      setApplying('');
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 26, width: '100%', maxWidth: 820, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 16 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#0f172a' }}>⚡ تفعيل / تعطيل ميزة بالجملة</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b' }}>
          اختر الميزة، ثم حدّد مجموعة الحسابات التي تريد تفعيلها أو تعطيلها عندهم دفعة واحدة — بدل الدخول لكل حساب على حدة.
        </div>

        {/* ── اختيار الميزة ── */}
        <div>
          <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#334155', marginBottom: 5 }}>الميزة</label>
          <select
            value={featureKey}
            onChange={e => { setFeatureKey(e.target.value); setResult(null); setError(''); }}
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box' }}
          >
            <option value="">اختر ميزة...</option>
            {FEATURE_BLOCKS.map(b => (
              <Fragment key={b.groupLabel}>
                {b.parent && <option value={b.parent.key}>{b.parent.icon} {b.parent.label}</option>}
                {b.children.length > 0 && (
                  <optgroup label={`${b.groupIcon} ${b.groupLabel}`}>
                    {b.children.map(c => <option key={c.key} value={c.key}>{c.icon} {c.label}</option>)}
                  </optgroup>
                )}
              </Fragment>
            ))}
          </select>
          {featureKey && FEATURE_DESC_BY_KEY[featureKey] && (
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 5 }}>{FEATURE_DESC_BY_KEY[featureKey]}</div>
          )}
        </div>

        {featureKey && (
          <>
            {/* ── فلاتر وبحث ── */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="🔍 بحث بالاسم..."
                style={{ flex: '1 1 180px', padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
              />
              <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={{ padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}>
                <option value="">كل الأدوار</option>
                {Object.entries(ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <button onClick={selectAllVisible} style={{ ...btnStyle('#2563eb', true), fontSize: 12, padding: '4px 10px' }}>✓ تحديد كل الظاهرين ({filteredUsers.length})</button>
              <button onClick={deselectAllVisible} style={{ ...btnStyle('#64748b', true), fontSize: 12, padding: '4px 10px' }}>✗ إلغاء تحديد الظاهرين</button>
              <button onClick={() => selectVisibleWhere('disabled')} style={{ ...btnStyle('#ef4444', true), fontSize: 12, padding: '4px 10px' }}>تحديد من هي معطّلة عندهم حالياً</button>
              <button onClick={() => selectVisibleWhere('enabled')} style={{ ...btnStyle('#22c55e', true), fontSize: 12, padding: '4px 10px' }}>تحديد من هي مفعّلة عندهم حالياً</button>
            </div>

            {/* ── قائمة المستخدمين ── */}
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: 320, overflowY: 'auto' }}>
              {filteredUsers.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>لا يوجد مستخدمون مطابقون</div>}
              {filteredUsers.map(u => {
                const enabled = isEnabledFor(u, featureKey);
                const checked = selected.has(u.id);
                return (
                  <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: checked ? '#eff6ff' : '#fff' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleOne(u.id)} />
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: enabled ? '#22c55e' : '#ef4444', flexShrink: 0 }} title={enabled ? 'مفعّلة حالياً' : 'معطّلة حالياً'} />
                    <span style={{ fontSize: 13.5, color: '#1e293b', flex: 1 }}>{u.displayName || u.username}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{ROLES[u.role] || u.role}{u.office?.name ? ` · ${u.office.name}` : ''}</span>
                  </label>
                );
              })}
            </div>

            {error && <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>{error}</div>}
            {result && (
              <div style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                ✅ تم التطبيق على {result.updated} حساب{result.failed ? `، فشل ${result.failed}` : ''}.
              </div>
            )}

            {/* ── أزرار التطبيق ── */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12.5, color: '#64748b' }}>{selected.size} حساب محدّد</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => apply(false)} disabled={!featureKey || selected.size === 0 || !!applying} style={btnStyle('#dc2626', true)}>
                  {applying === 'disable' ? '...' : '🚫 تعطيل للمحددين'}
                </button>
                <button onClick={() => apply(true)} disabled={!featureKey || selected.size === 0 || !!applying} style={btnStyle('#16a34a', true)}>
                  {applying === 'enable' ? '...' : '✅ تفعيل للمحددين'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
