import { useEffect, useState } from 'react';
import { smartPlanApi } from './api';
import { Icon } from '../../config/icons';
import { btnMini, inputStyle, panel, sectionTitle, Tag } from './ui';
import type { AmbiguousGroup, SmartPlan, SmartPlanCandidate } from './types';

const MATCH_TIER_LABEL: Record<string, string> = {
  linked: 'مطابقة محفوظة', exact: 'تطابق تام', ai_resolved: 'حسم بالذكاء الاصطناعي', new: 'طبيب جديد',
};

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

  if (loading) return <div style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>جارٍ التحميل…</div>;
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
    <div style={{ ...panel, border: '1px solid var(--c-danger-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={sectionTitle}>
          <Icon name="alert" size={15} style={{ color: 'var(--c-danger)' }} />
          أسماء بحاجة لمراجعة
          <Tag tone="danger">{groups.length}</Tag>
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={runAi} style={{ ...btnMini, padding: '7px 12px', fontSize: 12, background: 'var(--c-accent-light)', color: 'var(--c-accent)', border: '1px solid var(--c-purple-border)' }}>
            <Icon name="aiBot" size={12} /> حسم تلقائي بالذكاء الاصطناعي
          </button>
          <button onClick={submit} disabled={!Object.keys(picks).length} style={{
            ...btnMini, padding: '7px 12px', fontSize: 12,
            background: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)',
            opacity: Object.keys(picks).length ? 1 : 0.5,
          }}>تأكيد الاختيارات ({Object.keys(picks).length})</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {groups.map(g => (
          <div key={g.candidateId} style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '8px 10px', borderRadius: 9, background: 'var(--c-bg)', border: '1px solid var(--c-border)',
          }}>
            <div style={{ minWidth: 130, fontSize: 12.5, fontWeight: 600, color: 'var(--c-text-primary)' }}>{g.raw}</div>
            <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)' }}>{g.areaName || '—'} {g.pharmacyName ? `· ${g.pharmacyName}` : ''}</div>
            <select
              value={picks[g.candidateId] ?? ''}
              onChange={e => setPicks(prev => ({ ...prev, [g.candidateId]: e.target.value === 'new' ? null : e.target.value === '' ? undefined as any : Number(e.target.value) }))}
              style={{ ...inputStyle, marginInlineStart: 'auto', padding: '5px 8px', fontSize: 12, cursor: 'pointer' }}
            >
              <option value="">اختر…</option>
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

  if (!candidates.length && !plan.resultSummary?.length) {
    return (
      <div style={{ ...panel, textAlign: 'center', color: 'var(--c-text-muted)', fontSize: 12.5, padding: 22 }}>
        لم يُولَّد البلان بعد — ارفع الملفات، حدّد الأطباء، ثم اضغط «توليد البلان» في الأعلى.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {askCount > 0 && <AmbiguousReview token={token} planId={plan.id} onResolved={onChanged} />}

      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <h3 style={sectionTitle}>
            <Icon name="target" size={15} style={{ color: 'var(--c-accent)' }} />
            نتيجة البلان
          </h3>
          <Tag tone="neutral">محسومون {resolvedCount}</Tag>
          {askCount > 0 && <Tag tone="danger">بانتظار المراجعة {askCount}</Tag>}
          {selected.length > 0 && <Tag tone="accent">مختارون {selected.length}</Tag>}
        </div>

        {plan.resultSummary?.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: selected.length ? 14 : 0 }}>
            {plan.resultSummary.map(s => (
              <div key={s.key} style={{
                flex: '1 1 155px', background: 'var(--c-bg)', border: '1px solid var(--c-border)',
                borderRadius: 11, padding: '10px 12px',
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--c-text-primary)', marginBottom: 5 }}>{s.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginBottom: 6 }}>{s.percent}% · المطلوب {s.quota}</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <Tag tone="success">تم اختيار {s.filledCount ?? 0}</Tag>
                  {s.shortfall > 0 && <Tag tone="danger">نقص {s.shortfall}</Tag>}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {selected.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...byBucket.entries()].map(([key, list]) => (
              <div key={key} style={{ border: '1px solid var(--c-border)', borderRadius: 11, overflow: 'hidden' }}>
                <div style={{ padding: '9px 12px', background: 'var(--c-bg)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 12.5, color: 'var(--c-text-primary)' }}>{bucketLabel(key === '—' ? null : key)}</strong>
                  <Tag tone="accent">{list.length}</Tag>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {list.map(c => (
                    <div key={c.id} style={{
                      display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
                      padding: '8px 12px', borderTop: '1px solid var(--c-border-light)', fontSize: 12,
                    }}>
                      <strong style={{ color: 'var(--c-text-primary)' }}>{c.doctor?.name ?? c.rawName}</strong>
                      <span style={{ color: 'var(--c-text-muted)' }}>{c.doctor?.area?.name ?? c.areaName ?? '—'}</span>
                      {c.pharmacyName && <span style={{ color: 'var(--c-text-muted)' }}>· {c.pharmacyName}</span>}
                      {c.matchTier && <Tag>{MATCH_TIER_LABEL[c.matchTier] ?? c.matchTier}</Tag>}
                      {c.aiReason && <span style={{ color: 'var(--c-accent)', fontSize: 11.5 }}>{c.aiReason}</span>}
                      <button
                        onClick={() => smartPlanApi.updateCandidate(token, plan.id, c.id, { selected: false }).then(onChanged)}
                        style={{ ...btnMini, marginInlineStart: 'auto', padding: '3px 9px', fontSize: 11, color: 'var(--c-danger)', borderColor: 'var(--c-danger-border)' }}
                      >استبعاد</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
