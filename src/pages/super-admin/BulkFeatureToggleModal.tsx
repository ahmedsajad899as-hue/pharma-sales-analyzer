import { useMemo, useState } from 'react';
import { btnStyle } from './OfficesPage';
import { FEATURE_TREE, NAV_ITEMS, STANDALONE_FEATURES } from '../../config/featureConfig';
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

// صفحات NAV_ITEMS مقرونة بخانتها الأم في FEATURE_TREE (نفس الترتيب تماماً — راجع
// buildFeatureTree في featureConfig.ts) — بلا أي فلترة حسب دور، لأن هذه الخريطة
// عامة لكل الحسابات دفعة واحدة وليست لحساب بعينه.
const PAGES: { id: string; node: FeatureNode }[] = NAV_ITEMS.map((item, i) => ({ id: item.id, node: FEATURE_TREE[i] }));

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

  const [featSection, setFeatSection] = useState<string>(PAGES[0]?.id || '');
  const [featureKey,  setFeatureKey]  = useState('');
  const [search,      setSearch]      = useState('');
  const [roleFilter,  setRoleFilter]  = useState('');
  const [selected,    setSelected]    = useState<Set<number>>(new Set());
  const [applying,    setApplying]    = useState<'' | 'enable' | 'disable'>('');
  const [result,      setResult]      = useState<{ updated: number; failed: number } | null>(null);
  const [error,       setError]       = useState('');

  // ── نسبة التفعيل الحالية لمفتاح معيّن عبر كل الحسابات — تلوّن نقطة كل صف في الخريطة ──
  const dotFor = (key?: string): { color: string } | null => {
    if (!key) return null;
    let on = 0, off = 0;
    for (const u of users) { if (isEnabledFor(u, key)) on++; else off++; }
    if (off === 0) return { color: '#22c55e' };
    if (on === 0)  return { color: '#ef4444' };
    return { color: '#f59e0b' };
  };

  const pickFeature = (key?: string) => {
    if (!key) return;
    setFeatureKey(key);
    setResult(null); setError('');
  };

  const activeNode = PAGES.find(p => p.id === featSection)?.node
    ?? STANDALONE_FEATURES.find(n => (n.key || n.label) === featSection)
    ?? null;

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

  const SectionLabel = ({ text }: { text: string }) => (
    <div style={{ fontSize: 9, fontWeight: 800, color: '#4b5d7c', padding: '4px 8px 6px', letterSpacing: 1.2, textTransform: 'uppercase' }}>{text}</div>
  );

  // صف في الخريطة الجانبية: الضغط عليه يفتح تفاصيله يميناً، وإن كان له مفتاح
  // خاص به (خانة أم قابلة للتعطيل) يصبح هو المستهدف بالتفعيل/التعطيل الجماعي فوراً.
  const SidebarBtn = ({ id, icon, label, node }: { id: string; icon: string; label: string; node: FeatureNode }) => {
    const dot = dotFor(node.key);
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => { setFeatSection(id); pickFeature(node.key); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFeatSection(id); pickFeature(node.key); } }}
        className={`sidebar-nav-item${featSection === id ? ' sidebar-nav-item--active' : ''}`}
        style={{ marginBottom: 2 }}
      >
        <span className="sidebar-nav-icon">{icon}</span>
        <span className="sidebar-nav-label">{label}</span>
        {dot
          ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot.color, flexShrink: 0 }} />
          : (!node.children?.length && <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.08)', color: '#64748b', borderRadius: 4, padding: '1px 5px', flexShrink: 0, whiteSpace: 'nowrap' }}>دائماً</span>)
        }
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 980, maxHeight: '94vh', overflowY: 'auto', direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 14 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#0f172a' }}>⚡ تفعيل / تعطيل ميزة بالجملة</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
        </div>
        <div style={{ fontSize: 11.5, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          🪟 نفس خريطة الميزات التي تظهر عند فتح حساب مستخدم — اضغط على أي صفحة أو ميزة فرعية لتحديدها، ثم اختر الحسابات أسفل وطبّق التفعيل/التعطيل عليها دفعة واحدة.
          <span style={{ marginRight: 'auto', display: 'flex', gap: 10 }}>
            <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginLeft: 4 }} />مفعّلة للجميع</span>
            <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', marginLeft: 4 }} />متفاوتة</span>
            <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#ef4444', marginLeft: 4 }} />معطّلة للجميع</span>
          </span>
        </div>

        {/* ════ خريطة الميزات (نسخة من الشريط الجانبي الحقيقي) ════ */}
        <div style={{ display: 'flex', borderRadius: 12, overflow: 'hidden', border: '1.5px solid #e2e8f0', minHeight: 420 }}>
          {/* LEFT: sidebar */}
          <div style={{ width: 230, background: 'linear-gradient(180deg, #0f1e35 0%, #0a1628 100%)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div className="sidebar-brand" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span className="sidebar-brand-icon">🔷</span>
              <span className="sidebar-brand-text">Ordine</span>
            </div>
            <div style={{ padding: '0 8px' }}><SectionLabel text="صفحات التطبيق" /></div>
            <nav className="sidebar-nav" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px' }}>
              {PAGES.map(({ id, node }) => (
                <SidebarBtn key={node.key || id} id={id} icon={node.icon} label={node.label} node={node} />
              ))}
            </nav>
            {STANDALONE_FEATURES.length > 0 && (
              <>
                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 12px' }} />
                <div style={{ padding: '4px 8px 0' }}><SectionLabel text="ميزات عامة" /></div>
                <div style={{ padding: '0 8px 10px' }}>
                  {STANDALONE_FEATURES.map(node => (
                    <SidebarBtn key={node.key || node.label} id={node.key || node.label} icon={node.icon} label={node.label} node={node} />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* RIGHT: تفاصيل الصفحة/الميزة المختارة */}
          <div style={{ flex: 1, overflowY: 'auto', background: '#f8fafc', padding: '18px 20px' }}>
            {activeNode && (() => {
              const kids = activeNode.children ?? [];
              const parentDot = dotFor(activeNode.key);
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
                    <div style={{ width: 50, height: 50, borderRadius: 14, background: '#eef2ff', border: '2px solid #c7d2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0 }}>
                      {activeNode.icon}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', marginBottom: 2 }}>{activeNode.label}</div>
                      {activeNode.desc && <div style={{ fontSize: 11.5, color: '#64748b' }}>{activeNode.desc}</div>}
                    </div>
                    {activeNode.key
                      ? (
                        <button
                          onClick={() => pickFeature(activeNode.key)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                            border: `1.5px solid ${featureKey === activeNode.key ? '#4f46e5' : '#e2e8f0'}`,
                            background: featureKey === activeNode.key ? '#eef2ff' : '#fff',
                            borderRadius: 20, padding: '6px 14px', fontSize: 12, fontWeight: 700, color: '#334155',
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: parentDot?.color }} />
                          {featureKey === activeNode.key ? 'مُحدَّدة الآن' : 'اختيار هذه الخانة'}
                        </button>
                      )
                      : <span style={{ background: '#e2e8f0', color: '#475569', borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 700 }}>دائماً متاح</span>
                    }
                  </div>

                  {kids.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 2, paddingRight: 4 }}>الميزات الفرعية — اضغط لتحديدها</div>
                      {kids.map(child => {
                        if (!child.key) return null;
                        const dot = dotFor(child.key);
                        const active = featureKey === child.key;
                        return (
                          <div
                            key={child.key}
                            role="button" tabIndex={0}
                            onClick={() => pickFeature(child.key)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFeature(child.key); } }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer',
                              background: active ? '#eef2ff' : '#fff',
                              border: `1.5px solid ${active ? '#4f46e5' : '#e2e8f0'}`,
                              borderRadius: 10, transition: 'all 0.15s',
                            }}
                          >
                            <div style={{ width: 34, height: 34, borderRadius: 9, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>
                              {child.icon}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 12.5, color: '#1e293b' }}>{child.label}</div>
                              {child.desc && <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 1 }}>{child.desc}</div>}
                            </div>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot?.color, flexShrink: 0 }} />
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {kids.length === 0 && !activeNode.key && (
                    <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '32px 0' }}>لا توجد ميزات قابلة للتعطيل هنا</div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* ════ المستهدَف الآن + اختيار الحسابات وتطبيق التغيير ════ */}
        {!featureKey && (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '10px 0' }}>اضغط على أي صفحة أو ميزة فرعية في الخريطة أعلاه لتبدأ</div>
        )}
        {featureKey && (
          <>
            <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '8px 14px', fontSize: 12.5, color: '#3730a3', fontWeight: 600 }}>
              الميزة المستهدَفة الآن: {featureKey}
            </div>

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

            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: 260, overflowY: 'auto' }}>
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

            <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12.5, color: '#64748b' }}>{selected.size} حساب محدّد</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => apply(false)} disabled={selected.size === 0 || !!applying} style={btnStyle('#dc2626', true)}>
                  {applying === 'disable' ? '...' : '🚫 تعطيل للمحددين'}
                </button>
                <button onClick={() => apply(true)} disabled={selected.size === 0 || !!applying} style={btnStyle('#16a34a', true)}>
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
