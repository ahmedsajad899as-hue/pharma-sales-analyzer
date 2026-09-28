import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { smartPlanApi } from './api';
import UploadStep from './UploadStep';
import RatioEditor from './RatioEditor';
import ResultsView from './ResultsView';
import { exportSmartPlan } from './exportSmartPlan';
import { DEFAULT_RATIO_CONFIG } from './types';
import type { RatioBucket, SmartPlan, SmartPlanCandidate, SmartPlanUpload, SmartRep } from './types';

const API = import.meta.env.VITE_API_URL || '';
const MONTHS_AR = ['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];

const panel: React.CSSProperties = {
  background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-lg)',
  padding: 20, boxShadow: 'var(--shadow-sm)',
};

const primaryBtn: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
  background: 'var(--c-accent)', color: '#fff', fontWeight: 700, fontSize: 13,
};

const ghostBtn: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 700, fontSize: 13,
  background: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)',
};

export default function SmartMonthlyPlanPage({ onBack }: { onBack: () => void }) {
  const { token } = useAuth();
  const [reps, setReps] = useState<SmartRep[]>([]);
  const [plans, setPlans] = useState<SmartPlan[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const [activePlan, setActivePlan] = useState<SmartPlan | null>(null);
  const [uploads, setUploads] = useState<SmartPlanUpload[]>([]);
  const [candidates, setCandidates] = useState<SmartPlanCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // نموذج إنشاء جلسة جديدة
  const now = new Date();
  const [newRepId, setNewRepId] = useState('');
  const [newMonth, setNewMonth] = useState(now.getMonth() + 1);
  const [newYear, setNewYear] = useState(now.getFullYear());
  const [newTitle, setNewTitle] = useState('');
  const [newCount, setNewCount] = useState(75);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const [repsRes, plansRes] = await Promise.all([
          fetch(`${API}/api/scientific-reps`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
          smartPlanApi.list(token),
        ]);
        const repsArr = Array.isArray(repsRes) ? repsRes : Array.isArray(repsRes?.data) ? repsRes.data : [];
        setReps(repsArr);
        setPlans(plansRes.plans);
      } catch (e: any) { setError(e.message); }
      finally { setLoadingList(false); }
    })();
  }, [token]);

  const loadPlanDetail = async (id: number) => {
    if (!token) return;
    const { plan, uploads, candidates } = await smartPlanApi.getOne(token, id);
    setActivePlan(plan); setUploads(uploads); setCandidates(candidates);
  };

  const refreshActivePlan = () => { if (activePlan) loadPlanDetail(activePlan.id); };

  const createPlan = async () => {
    if (!token || !newRepId) return;
    setBusy('create'); setError('');
    try {
      const { plan } = await smartPlanApi.create(token, {
        scientificRepId: Number(newRepId), month: newMonth, year: newYear,
        title: newTitle || undefined, targetDoctorCount: newCount,
      });
      setPlans(prev => [plan, ...prev]);
      await loadPlanDetail(plan.id);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const runResolve = async () => {
    if (!token || !activePlan) return;
    setBusy('resolve'); setError('');
    try { await smartPlanApi.resolve(token, activePlan.id); await refreshActivePlan(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const runCompute = async () => {
    if (!token || !activePlan) return;
    setBusy('compute'); setError('');
    try { await smartPlanApi.compute(token, activePlan.id); await refreshActivePlan(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const saveRatio = async (ratioConfig: RatioBucket[], targetDoctorCount: number) => {
    if (!token || !activePlan) return;
    setActivePlan(prev => (prev ? { ...prev, ratioConfig, targetDoctorCount } : prev));
    try { await smartPlanApi.update(token, activePlan.id, { ratioConfig, targetDoctorCount }); }
    catch (e: any) { setError(e.message); }
  };

  const doExport = async () => {
    if (!token || !activePlan) return;
    exportSmartPlan(activePlan, candidates);
    try { await smartPlanApi.markExported(token, activePlan.id); await refreshActivePlan(); } catch { /* التصدير نجح محلياً بصرف النظر */ }
  };

  const hasSelected = candidates.some(c => c.selected);
  const uploadedCount = uploads.filter(u => !u.fileName.startsWith('(تلقائي')).length;

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
      <button onClick={activePlan ? () => setActivePlan(null) : onBack} style={ghostBtn}>
        {activePlan ? '← رجوع للجلسات' : '← رجوع للبلان الشهري'}
      </button>
      <h2 style={{ fontSize: 18, color: 'var(--c-primary)', margin: 0 }}>✨ البلان الشهري الذكي</h2>
    </div>
  );

  if (!activePlan) {
    return (
      <div style={{ padding: 20, maxWidth: 980, margin: '0 auto' }}>
        {header}
        {error && <div style={{ color: 'var(--c-danger)', marginBottom: 12 }}>{error}</div>}

        <div style={panel}>
          <h3 style={{ fontSize: 15, marginBottom: 12, color: 'var(--c-text-primary)' }}>إنشاء جلسة بلان ذكي جديدة</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <select value={newRepId} onChange={e => setNewRepId(e.target.value)} style={{ padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', minWidth: 180 }}>
              <option value="">اختر المندوب العلمي...</option>
              {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={newMonth} onChange={e => setNewMonth(Number(e.target.value))} style={{ padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)' }}>
              {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <input type="number" value={newYear} onChange={e => setNewYear(Number(e.target.value))} style={{ width: 90, padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)' }} />
            <input type="number" min={1} value={newCount} onChange={e => setNewCount(Number(e.target.value))} title="عدد الأطباء المستهدَف" style={{ width: 90, padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)' }} />
            <input placeholder="عنوان الجلسة (اختياري)" value={newTitle} onChange={e => setNewTitle(e.target.value)} style={{ flex: 1, minWidth: 160, padding: 8, borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)' }} />
            <button disabled={!newRepId || busy === 'create'} onClick={createPlan} style={{ ...primaryBtn, opacity: !newRepId || busy === 'create' ? 0.6 : 1 }}>
              {busy === 'create' ? 'جارٍ الإنشاء...' : '+ إنشاء جلسة'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: 15, marginBottom: 10, color: 'var(--c-text-primary)' }}>جلسات سابقة</h3>
          {loadingList ? (
            <div style={{ color: 'var(--c-text-muted)' }}>جارٍ التحميل...</div>
          ) : plans.length === 0 ? (
            <div style={{ color: 'var(--c-text-muted)' }}>لا توجد جلسات بعد.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plans.map(p => (
                <div key={p.id} onClick={() => loadPlanDetail(p.id)} style={{
                  ...panel, padding: 12, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <strong style={{ color: 'var(--c-text-primary)' }}>{p.scientificRep?.name ?? '—'}</strong>
                    <span style={{ color: 'var(--c-text-muted)', marginInlineStart: 8, fontSize: 13 }}>
                      {MONTHS_AR[p.month - 1]} {p.year} {p.title ? `— ${p.title}` : ''}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      {header}
      {error && <div style={{ color: 'var(--c-danger)', marginBottom: 12 }}>{error}</div>}

      <div style={{ marginBottom: 6, fontSize: 14, color: 'var(--c-text-secondary)' }}>
        <strong style={{ color: 'var(--c-text-primary)' }}>{activePlan.scientificRep?.name}</strong>
        {' — '}{MONTHS_AR[activePlan.month - 1]} {activePlan.year}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <UploadStep token={token!} planId={activePlan.id} uploads={uploads} onChanged={refreshActivePlan} />

        <RatioEditor
          buckets={activePlan.ratioConfig}
          targetDoctorCount={activePlan.targetDoctorCount}
          onChange={b => saveRatio(b, activePlan.targetDoctorCount)}
          onTargetChange={n => saveRatio(activePlan.ratioConfig, n)}
        />

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button disabled={busy !== null || uploadedCount === 0} onClick={runResolve} style={{ ...primaryBtn, opacity: busy || uploadedCount === 0 ? 0.6 : 1 }}>
            {busy === 'resolve' ? 'جارٍ التصنيف...' : '1️⃣ تصنيف الأسماء'}
          </button>
          <button disabled={busy !== null} onClick={runCompute} style={{ ...primaryBtn, background: 'var(--c-success)', opacity: busy ? 0.6 : 1 }}>
            {busy === 'compute' ? 'جارٍ التوليد...' : '2️⃣ توليد البلان'}
          </button>
          <button disabled={!hasSelected} onClick={doExport} style={{ ...ghostBtn, opacity: hasSelected ? 1 : 0.5 }}>
            ⬇️ تصدير Excel
          </button>
        </div>

        <ResultsView token={token!} plan={activePlan} candidates={candidates} onChanged={refreshActivePlan} />
      </div>
    </div>
  );
}
