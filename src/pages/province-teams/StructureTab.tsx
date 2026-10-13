// «الهيكلية» (إدارة المكتب): فريق لكل محافظة ← تيم ليدر ← مندوبون، كل مندوب
// بشركة وايتماتها. المندوب المشترك = تعيين لكل شركة. مندوبان لنفس الشركة في
// نفس المحافظة يتقاسمان الايتمات — والخادم يرفض أي تقاطع ويسمّيه.

import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Archive, Search, Users } from 'lucide-react';
import { api, jsonBody, ApiError } from './api';
import type { CatalogItem, Options, Team } from './types';

interface Props { token: string | null; teams: Team[]; onChanged: () => void }

interface FlatAssignment { assignmentId: number; repUserId: number; repName: string; companyId: number; companyName: string; allItems: boolean; itemCount: number; explicitItemIds: number[] }

const flatten = (t: Team): FlatAssignment[] =>
  t.reps.flatMap(r => r.companies.map(c => ({
    assignmentId: c.assignmentId, repUserId: r.repUserId, repName: r.repName,
    companyId: c.companyId, companyName: c.companyName, allItems: c.allItems,
    itemCount: c.itemCount, explicitItemIds: c.explicitItemIds,
  })));

export default function StructureTab({ token, teams, onChanged }: Props) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState({ provinceId: '', leaderUserId: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<Options>(token, '/options').then(setOpts).catch(e => setErr(e.message));
  }, [token]);

  const usedProvinces = new Set(teams.map(t => t.provinceId));

  const createTeam = async () => {
    if (!newTeam.provinceId) return;
    setSaving(true); setErr(null);
    try {
      await api(token, '/teams', { method: 'POST', ...jsonBody({ provinceId: Number(newTeam.provinceId), leaderUserId: newTeam.leaderUserId ? Number(newTeam.leaderUserId) : null }) });
      setNewTeam({ provinceId: '', leaderUserId: '' });
      onChanged();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  if (!opts) return <div className="pt-skeleton" style={{ height: 200 }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="pt-note">
        <span>🧭</span>
        <span>
          لكل محافظة <strong>فريق واحد</strong> يقوده تيم ليدر مشترك لكل الشركات. أضف المندوب مع <strong>شركته وايتماتها</strong> —
          والمندوب الذي يعمل لشركتين يُضاف مرتين (مرة لكل شركة). يُربط مندوبو الفريق بالتيم ليدر تلقائياً فتظهر زياراتهم وبلاناتهم له.
        </span>
      </div>

      <div className="pt-panel">
        <div className="pt-panel__head"><div className="pt-panel__title">إضافة فريق محافظة</div></div>
        <div className="pt-panel__body">
          <div className="pt-form-grid" style={{ alignItems: 'end' }}>
            <div className="pt-field">
              <label>المحافظة</label>
              <select className="form-input" value={newTeam.provinceId} onChange={e => setNewTeam(n => ({ ...n, provinceId: e.target.value }))}>
                <option value="">اختر…</option>
                {opts.provinces.filter(p => !usedProvinces.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="pt-field">
              <label>تيم ليدر المحافظة</label>
              <select className="form-input" value={newTeam.leaderUserId} onChange={e => setNewTeam(n => ({ ...n, leaderUserId: e.target.value }))}>
                <option value="">— يُعيَّن لاحقاً —</option>
                {opts.leaders.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="pt-field">
              <button className="btn btn--primary" disabled={!newTeam.provinceId || saving} onClick={createTeam}><Plus size={14} /> إنشاء الفريق</button>
            </div>
          </div>
          {err && <div className="pt-note pt-note--warn" style={{ marginTop: 10 }}>⚠️ {err}</div>}
        </div>
      </div>

      {teams.map(t => <TeamBlock key={t.id} token={token} team={t} opts={opts} onChanged={onChanged} />)}
    </div>
  );
}

function TeamBlock({ token, team, opts, onChanged }: { token: string | null; team: Team; opts: Options; onChanged: () => void }) {
  const [editing, setEditing] = useState<FlatAssignment | 'new' | null>(null);
  const rows = flatten(team);

  const setLeader = async (leaderUserId: string) => {
    try { await api(token, `/teams/${team.id}`, { method: 'PATCH', ...jsonBody({ leaderUserId: leaderUserId ? Number(leaderUserId) : null }) }); onChanged(); }
    catch (e: any) { alert(e.message); }
  };
  const archive = async () => {
    if (!window.confirm(`إيقاف فريق ${team.provinceName}؟ تُوقف تعييناته، ويبقى الجهد الشخصي المسجّل محفوظاً.`)) return;
    try { await api(token, `/teams/${team.id}`, { method: 'DELETE' }); onChanged(); } catch (e: any) { alert(e.message); }
  };
  const removeAssignment = async (a: FlatAssignment) => {
    if (!window.confirm(`إزالة ${a.repName} من ${a.companyName} في ${team.provinceName}؟`)) return;
    try { await api(token, `/assignments/${a.assignmentId}`, { method: 'DELETE' }); onChanged(); } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="pt-team-block">
      <div className="pt-panel__head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="pt-panel__title">{team.provinceName}</div>
          <select className="form-input" style={{ width: 'auto', minWidth: 200, padding: '5px 10px' }} value={team.leaderUserId ?? ''} onChange={e => setLeader(e.target.value)} aria-label="تيم ليدر المحافظة">
            <option value="">— بلا تيم ليدر —</option>
            {opts.leaders.map(u => <option key={u.id} value={u.id}>تيم ليدر: {u.name}</option>)}
          </select>
          <span className="pt-chip"><Users size={11} style={{ verticalAlign: -1 }} /> {team.reps.length} مندوب · {rows.length} تعيين</span>
        </div>
        <div className="pt-actions">
          <button className="btn btn--primary btn--sm" onClick={() => setEditing('new')}><Plus size={14} /> إضافة مندوب</button>
          <button className="pt-icon-btn" title="إيقاف الفريق" onClick={archive}><Archive size={14} /></button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="pt-scroll">
          <table className="pt-table">
            <thead><tr><th>المندوب</th><th>الشركة</th><th>الايتمات</th><th /></tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.assignmentId}>
                  <td>{a.repName}{team.reps.find(r => r.repUserId === a.repUserId)!.companies.length > 1 && <span className="pt-chip" style={{ marginRight: 6 }}>مشترك</span>}</td>
                  <td><span className="pt-chip pt-chip--accent">{a.companyName}</span></td>
                  <td>{a.allItems ? 'كل ايتمات الشركة' : `${a.itemCount} ايتم`}</td>
                  <td>
                    <div className="pt-actions" style={{ justifyContent: 'flex-end' }}>
                      <button className="pt-icon-btn" title="تعديل" onClick={() => setEditing(a)}><Pencil size={14} /></button>
                      <button className="pt-icon-btn" title="إزالة" onClick={() => removeAssignment(a)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <AssignmentEditor
          token={token} team={team} opts={opts} siblings={rows}
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function AssignmentEditor({ token, team, opts, siblings, initial, onCancel, onSaved }: {
  token: string | null; team: Team; opts: Options; siblings: FlatAssignment[]; initial: FlatAssignment | null;
  onCancel: () => void; onSaved: () => void;
}) {
  const [repUserId, setRepUserId] = useState<number | ''>(initial?.repUserId ?? '');
  const [companyId, setCompanyId] = useState<number | ''>(initial?.companyId ?? '');
  const [allItems, setAllItems] = useState<boolean>(initial?.allItems ?? false);
  const [picked, setPicked] = useState<Set<number>>(new Set(initial?.explicitItemIds ?? []));
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!token || !companyId) { setItems([]); return; }
    api<{ items: CatalogItem[] }>(token, `/companies/${companyId}/items`).then(r => setItems(r.items)).catch(() => setItems([]));
  }, [token, companyId]);

  // ايتمات محجوزة لمندوب آخر لنفس الشركة في هذه المحافظة.
  const takenBy = useMemo(() => {
    const m = new Map<number, string>();
    let wholeCompany: string | null = null;
    for (const s of siblings) {
      if (s.companyId !== companyId || s.repUserId === repUserId) continue;
      if (s.allItems) wholeCompany = s.repName;
      for (const id of s.explicitItemIds) m.set(id, s.repName);
    }
    return { m, wholeCompany };
  }, [siblings, companyId, repUserId]);

  const visible = items.filter(i => !q || i.name.toLowerCase().includes(q.toLowerCase()) || (i.scientificName ?? '').toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const freeVisible = visible.filter(i => !takenBy.m.has(i.id));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await api(token, `/teams/${team.id}/assignments`, {
        method: 'POST',
        ...jsonBody({ id: initial?.assignmentId ?? null, repUserId, companyId, allItems, itemIds: allItems ? [] : [...picked] }),
      });
      onSaved();
    } catch (e: any) { setErr(e instanceof ApiError ? e : new ApiError(String(e?.message ?? e))); } finally { setSaving(false); }
  };

  return (
    <div className="pt-panel__body" style={{ borderTop: '1px solid var(--c-border-light)', background: '#fafbfd', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="pt-form-grid">
        <div className="pt-field">
          <label>المندوب العلمي</label>
          <select className="form-input" value={repUserId} disabled={!!initial} onChange={e => setRepUserId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">اختر…</option>
            {opts.reps.map(u => <option key={u.id} value={u.id}>{u.name}{u.company ? ` (${u.company})` : ''}</option>)}
          </select>
        </div>
        <div className="pt-field">
          <label>الشركة</label>
          <select className="form-input" value={companyId} disabled={!!initial} onChange={e => { setCompanyId(e.target.value ? Number(e.target.value) : ''); setPicked(new Set()); }}>
            <option value="">اختر…</option>
            {opts.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="pt-field">
          <label>نطاق الايتمات</label>
          <div className="pt-segment">
            <button className={!allItems ? 'is-active' : ''} onClick={() => setAllItems(false)}>ايتمات محدّدة</button>
            <button className={allItems ? 'is-active' : ''} onClick={() => setAllItems(true)} disabled={!!takenBy.wholeCompany || takenBy.m.size > 0}
              title={takenBy.m.size || takenBy.wholeCompany ? 'مندوب آخر لهذه الشركة في المحافظة — قسّما الايتمات' : ''}>
              كل ايتمات الشركة
            </button>
          </div>
        </div>
      </div>

      {takenBy.wholeCompany && (
        <div className="pt-note pt-note--warn">{takenBy.wholeCompany} معيَّن على كل ايتمات هذه الشركة في {team.provinceName} — عدّل تعيينه إلى ايتمات محدّدة أولاً.</div>
      )}

      {!allItems && companyId !== '' && (
        <>
          <div className="pt-actions">
            <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
              <Search size={14} style={{ position: 'absolute', right: 10, top: 10, color: 'var(--c-text-muted)' }} />
              <input className="form-input" style={{ paddingRight: 30 }} placeholder="بحث بالاسم التجاري أو العلمي…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <button className="btn btn--secondary btn--sm" onClick={() => setPicked(s => new Set([...s, ...freeVisible.map(i => i.id)]))}>تحديد الظاهر المتاح</button>
            <button className="btn btn--secondary btn--sm" onClick={() => setPicked(new Set())}>مسح</button>
            <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{picked.size} / {items.length} محدّد</span>
          </div>
          <div className="pt-checklist">
            {visible.map(i => {
              const owner = takenBy.m.get(i.id);
              return (
                <label key={i.id} className={`pt-check ${owner ? 'is-taken' : ''}`} title={owner ? `معيَّن لـ ${owner}` : i.scientificName ?? ''}>
                  <input type="checkbox" checked={picked.has(i.id)} disabled={!!owner && !picked.has(i.id)} onChange={() => toggle(i.id)} />
                  <span>{i.name}</span>
                  {owner && <small>{owner}</small>}
                </label>
              );
            })}
            {!visible.length && <div style={{ fontSize: 12, color: 'var(--c-text-muted)', padding: 8 }}>لا ايتمات في كتالوج هذه الشركة</div>}
          </div>
        </>
      )}

      {err && (
        <div className="pt-note pt-note--warn">
          <span>⚠️</span>
          <span>
            {err.message}
            {err.code === 'ITEM_CONFLICT' && <div style={{ marginTop: 4 }}>كل ايتم يُنسب لمندوب واحد فقط داخل نفس الشركة والمحافظة.</div>}
          </span>
        </div>
      )}

      <div className="pt-actions">
        <button className="btn btn--primary" disabled={saving || !repUserId || !companyId || (!allItems && !picked.size)} onClick={save}>
          {saving ? 'جارٍ الحفظ…' : initial ? 'حفظ التعديل' : 'إضافة'}
        </button>
        <button className="btn btn--secondary" onClick={onCancel}>إلغاء</button>
      </div>
    </div>
  );
}
