import { useEffect, useState } from 'react';
import { smartPlanApi } from './api';
import type { AmbiguousGroup, SmartPlan, SmartPlanCandidate } from './types';

const MATCH_TIER_LABEL: Record<string, string> = {
  linked: 'مطابقة محفوظة', exact: 'تطابق تام', ai_resolved: '✨ حسم بالذكاء الاصطناعي', new: 'طبيب جديد',
};

function Badge({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' | 'muted' }) {
  const bg = tone === 'ok' ? 'var(--c-success-bg)' : tone === 'warn' ? 'var(--c-danger-bg)' : 'var(--c-border-light)';
  const color = tone === 'ok' ? 'var(--c-success)' : tone === 'warn' ? 'var(--c-danger)' : 'var(--c-text-muted)';
  return <span style={{ background: bg, color, borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>{children}</span>;
}

function AmbiguousReview({ token, planId, onResolved }: { token: string; planId: number; onResolved: () => void }) {
  const [groups, setGroups] = useState<AmbiguousGroup[] | null>(null);
  const [picks, setPicks] = useState<Record<number, number | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { groups } = await smartPlanApi.getAmbiguous(token, planId);
      setGroups(groups);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [planId]);

  if (loading) return <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>جارٍ التحميل...</div>;
  if (error) return <div style={{ color: 'var(--c-danger)', fontSize: 13 }}>{error}</div>;
  if (!groups?.length) return null;

  const submit = async () => {
    const entries = Object.entries(picks).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const picksPayload = entries.map(([candidateId, doctorId]) => ({ candidateId: Number(candidateId), doctorId }));
    await smartPlanApi.confirmMatches(token, planId, picksPayload);
    setPicks({});
    await load();
    onResolved();
  };

  const runAi = async () => {
    setLoading(true);
    try { await smartPlanApi.resolveAi(token, planId); await load(); onResolved(); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      background: 'var(--c-surface)', border: '1px solid var(--c-danger-border)', borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ fontSize: 14, color: 'var(--c-text-primary)' }}>
          🔎 أسماء بحاجة لمراجعة ({groups.length})
        </strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={runAi} style={{
            padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: 'none',
            background: 'var(--c-accent-light)', color: 'var(--c-accent)', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>✨ حسم تلقائي بالذكاء الاصطناعي</button>
          <button onClick={submit} disabled={!Object.keys(picks).length} style={{
            padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: 'none',
            background: 'var(--c-accent)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
            opacity: Object.keys(picks).length ? 1 : 0.5,
          }}>تأكيد الاختيارات ({Object.keys(picks).length})</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
        {groups.map(g => (
          <div key={g.candidateId} style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--c-bg)',
          }}>
            <div style={{ minWidth: 140, fontSize: 13, fontWeight: 600, color: 'var(--c-text-primary)' }}>{g.raw}</div>
            <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{g.areaName || '—'} {g.pharmacyName ? `· ${g.pharmacyName}` : ''}</div>
            <select
              value={picks[g.candidateId] ?? ''}
              onChange={e => setPicks(prev => ({ ...prev, [g.candidateId]: e.target.value === 'new' ? null : e.target.value === '' ? undefined as any : Number(e.target.value) }))}
              style={{ marginInlineStart: 'auto', padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 12 }}
            >
              <option value="">اختر...</option>
              {g.suggestions.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({Math.round(s.score * 100)}%){s.crossArea ? ' — منطقة مختلفة' : ''}</option>
              ))}
              <option value="new">طبيب جديد كلياً</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ResultsView({
  token, plan, candidates, onChanged,
}: {
  token: string; plan: SmartPlan; candidates: SmartPlanCandidate[]; onChanged: () => void;
}) {
  const resolvedCount = candidates.filter(c => c.doctorId).length;
  const askCount = candidates.filter(c => c.matchTier === 'ask').length;

  const bucketLabel = (key: string | null) => plan.ratioConfig.find(b => b.key === key)?.label ?? 'غير مصنَّف';
  const selected = candidates.filter(c => c.selected);
  const byBucket = new Map<string, SmartPlanCandidate[]>();
  for (const c of selected) {
    const key = c.assignedBucketKey || '—';
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(c);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--c-text-secondary)' }}>
        <span>مرشّحون محسومون: <strong style={{ color: 'var(--c-text-primary)' }}>{resolvedCount}</strong></span>
        {askCount > 0 && <span style={{ color: 'var(--c-danger)' }}>بانتظار المراجعة: <strong>{askCount}</strong></span>}
      </div>

      {askCount > 0 && <AmbiguousReview token={token} planId={plan.id} onResolved={onChanged} />}

      {plan.resultSummary?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {plan.resultSummary.map(s => (
            <div key={s.key} style={{
              flex: '1 1 160px', background: 'var(--c-surface)', border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius-md)', padding: 12,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 6 }}>{s.label}</div>
              <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginBottom: 4 }}>
                {s.percent}% — المطلوب {s.quota}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Badge tone="ok">تم اختيار {s.filledCount ?? 0}</Badge>
                {s.shortfall > 0 && <Badge tone="warn">نقص {s.shortfall}</Badge>}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selected.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[...byBucket.entries()].map(([key, list]) => (
            <div key={key} style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
              <strong style={{ fontSize: 13, color: 'var(--c-text-primary)' }}>{bucketLabel(key === '—' ? null : key)} ({list.length})</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {list.map(c => (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--c-bg)', fontSize: 12,
                  }}>
                    <strong style={{ color: 'var(--c-text-primary)' }}>{c.doctor?.name ?? c.rawName}</strong>
                    <span style={{ color: 'var(--c-text-muted)' }}>{c.doctor?.area?.name ?? c.areaName ?? '—'}</span>
                    {c.pharmacyName && <span style={{ color: 'var(--c-text-muted)' }}>🏬 {c.pharmacyName}</span>}
                    {c.matchTier && <Badge tone="muted">{MATCH_TIER_LABEL[c.matchTier] ?? c.matchTier}</Badge>}
                    {c.aiReason && <span style={{ color: 'var(--c-accent)', fontStyle: 'italic' }}>💡 {c.aiReason}</span>}
                    <button
                      onClick={() => smartPlanApi.updateCandidate(token, plan.id, c.id, { selected: false }).then(onChanged)}
                      style={{ marginInlineStart: 'auto', border: 'none', background: 'transparent', color: 'var(--c-danger)', cursor: 'pointer', fontSize: 12 }}
                    >استبعاد</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
