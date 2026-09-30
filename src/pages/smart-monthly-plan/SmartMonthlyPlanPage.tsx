import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Icon } from '../../config/icons';
import { smartPlanApi } from './api';
import UploadStep from './UploadStep';
import AreaDoctorsPanel from './AreaDoctorsPanel';
import RatioEditor from './RatioEditor';
import ResultsView from './ResultsView';
import { exportSmartPlan } from './exportSmartPlan';
import { btnGhost, btnMini, btnPrimary, card, inputStyle, panel, sectionTitle, Tag } from './ui';
import type { RatioBucket, SmartPlan, SmartPlanCandidate, SmartPlanUpload, SmartRep } from './types';

const API = import.meta.env.VITE_API_URL || '';
const MONTHS_AR = ['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];

const STATUS_AR: Record<SmartPlan['status'], { label: string; tone: 'neutral' | 'accent' | 'success' }> = {
  draft:     { label: 'مسودة',       tone: 'neutral' },
  resolving: { label: 'قيد التصنيف', tone: 'accent' },
  ready:     { label: 'جاهز',        tone: 'accent' },
  exported:  { label: 'تم التصدير',  tone: 'success' },
};

/** قسم قابل للطي بعنوان ورقم خطوة — يوحّد إيقاع الصفحة ويختصر الطول. */
function Section({
  step, title, icon, hint, defaultOpen = true, right, children,
}: {
  step: number; title: string; icon: string; hint?: string;
  defaultOpen?: boolean; right?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1, minWidth: 0 }}>
          <span style={{
            width: 22, height: 22, borderRadius: 7, flexShrink: 0, fontSize: 11.5, fontWeight: 700,
            background: 'var(--c-accent-light)', color: 'var(--c-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{step}</span>
          <h3 style={sectionTitle}>
            <Icon name={icon as any} size={15} style={{ color: 'var(--c-accent)' }} />
            {title}
          </h3>
          {hint && <span style={{ fontSize: 11.5, color: 'var(--c-text-muted)' }}>{hint}</span>}
        </div>
        {right}
        <span onClick={() => setOpen(o => !o)} style={{ fontSize: 11, color: 'var(--c-text-muted)', cursor: 'pointer' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  );
}

/** شريط تقدّم أفقي مختصر — أين وصلت الجلسة في الخطوات الأربع. */
function Progress({ steps }: { steps: { label: string; done: boolean }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ width: 14, height: 1, background: 'var(--c-border)' }} />}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600,
            color: s.done ? 'var(--c-success)' : 'var(--c-text-muted)',
          }}>
            <Icon name={s.done ? 'checkCircle' : 'empty'} size={12} />
            {s.label}
          </span>
        </span>
      ))}
    </div>
  );
}

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

  const pageHeader = (subtitle?: React.ReactNode, actions?: React.ReactNode) => (
    <div style={{
      position: 'sticky', top: 0, zIndex: 30, background: 'var(--c-bg)',
      paddingBottom: 12, marginBottom: 16, borderBottom: '1px solid var(--c-border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 2 }}>
        <button onClick={activePlan ? () => setActivePlan(null) : onBack} style={btnGhost}>
          <Icon name="chevronRight" size={13} /> {activePlan ? 'الجلسات' : 'البلان الشهري'}
        </button>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 16.5, color: 'var(--c-text-primary)', margin: 0, fontWeight: 700 }}>البلان الشهري الذكي</h2>
          {subtitle && <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', marginTop: 3 }}>{subtitle}</div>}
        </div>
        {actions && <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </div>
    </div>
  );

  if (!activePlan) {
    return (
      <div className="page-container" dir="rtl" style={{ maxWidth: 1000, margin: '0 auto' }}>
        {pageHeader('أنشئ جلسة لمندوب علمي وشهر معيّن، ثم ارفع الملفات ووزّع النسب.')}
        {error && <div style={{ color: 'var(--c-danger)', marginBottom: 12, fontSize: 13 }}>{error}</div>}

        <div style={panel}>
          <h3 style={{ ...sectionTitle, marginBottom: 12 }}>
            <Icon name="add" size={15} style={{ color: 'var(--c-accent)' }} />
            جلسة جديدة
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <select value={newRepId} onChange={e => setNewRepId(e.target.value)} style={{ ...inputStyle, minWidth: 180, cursor: 'pointer' }}>
              <option value="">اختر المندوب العلمي…</option>
              {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={newMonth} onChange={e => setNewMonth(Number(e.target.value))} style={{ ...inputStyle, cursor: 'pointer' }}>
              {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <input type="number" value={newYear} onChange={e => setNewYear(Number(e.target.value))} title="السنة" style={{ ...inputStyle, width: 88 }} />
            <input type="number" min={1} value={newCount} onChange={e => setNewCount(Number(e.target.value))} title="عدد الأطباء المستهدَف" style={{ ...inputStyle, width: 88 }} />
            <input placeholder="عنوان الجلسة (اختياري)" value={newTitle} onChange={e => setNewTitle(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 150 }} />
            <button disabled={!newRepId || busy === 'create'} onClick={createPlan} style={{ ...btnPrimary, opacity: !newRepId || busy === 'create' ? 0.55 : 1 }}>
              {busy === 'create'
                ? <><Icon name="loading" size={13} className="icon-spin" /> جارٍ الإنشاء…</>
                : <><Icon name="add" size={13} /> إنشاء جلسة</>}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginTop: 9 }}>
            الحقول بالترتيب: المندوب · الشهر · السنة · عدد الأطباء المستهدَف · عنوان اختياري.
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <h3 style={{ ...sectionTitle, marginBottom: 10 }}>
            <Icon name="history" size={15} style={{ color: 'var(--c-text-muted)' }} />
            جلسات سابقة
            {!loadingList && plans.length > 0 && <span style={{ fontSize: 11.5, color: 'var(--c-text-muted)', fontWeight: 500 }}>({plans.length})</span>}
          </h3>
          {loadingList ? (
            <div style={{ color: 'var(--c-text-muted)', fontSize: 13 }}>جارٍ التحميل…</div>
          ) : plans.length === 0 ? (
            <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--c-text-muted)', fontSize: 13 }}>
              لا توجد جلسات بعد — ابدأ بإنشاء واحدة من الأعلى.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {plans.map(p => {
                const st = STATUS_AR[p.status] ?? { label: p.status, tone: 'neutral' as const };
                return (
                  <div key={p.id} onClick={() => loadPlanDetail(p.id)} style={{
                    ...card, padding: '13px 14px', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="person" size={14} style={{ color: 'var(--c-text-muted)', flexShrink: 0 }} />
                      <strong style={{ color: 'var(--c-text-primary)', fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.scientificRep?.name ?? '—'}
                      </strong>
                      <Tag tone={st.tone}>{st.label}</Tag>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--c-text-secondary)', flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="calendar" size={12} style={{ color: 'var(--c-text-muted)' }} />
                        {MONTHS_AR[p.month - 1]} {p.year}
                      </span>
                      <span style={{ color: 'var(--c-text-muted)' }}>·</span>
                      <span>{p.targetDoctorCount} طبيب مستهدَف</span>
                    </div>
                    {p.title && <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)' }}>{p.title}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  const st = STATUS_AR[activePlan.status] ?? { label: activePlan.status, tone: 'neutral' as const };
  const steps = [
    { label: 'الملفات', done: uploadedCount > 0 },
    { label: 'تصنيف الأسماء', done: candidates.length > 0 },
    { label: 'توليد البلان', done: !!activePlan.resultSummary?.length },
    { label: 'التصدير', done: !!activePlan.exportedAt },
  ];

  const actions = (
    <>
      <button disabled={busy !== null || uploadedCount === 0} onClick={runResolve}
        title={uploadedCount === 0 ? 'ارفع ملفاً واحداً على الأقل أولاً' : 'مطابقة أسماء الملفات مع أطباء السيرفي'}
        style={{ ...btnGhost, opacity: busy || uploadedCount === 0 ? 0.55 : 1 }}>
        {busy === 'resolve'
          ? <><Icon name="loading" size={13} className="icon-spin" /> جارٍ التصنيف…</>
          : <><Icon name="link" size={13} /> تصنيف الأسماء</>}
      </button>
      <button disabled={busy !== null} onClick={runCompute} style={{ ...btnPrimary, opacity: busy ? 0.55 : 1 }}>
        {busy === 'compute'
          ? <><Icon name="loading" size={13} className="icon-spin" /> جارٍ التوليد…</>
          : <><Icon name="aiBot" size={13} /> توليد البلان</>}
      </button>
      <button disabled={!hasSelected} onClick={doExport} title={hasSelected ? 'تنزيل البلان كملف Excel' : 'ولّد البلان أولاً'}
        style={{
          ...btnGhost, opacity: hasSelected ? 1 : 0.5,
          borderColor: hasSelected ? 'var(--c-success-border)' : 'var(--c-border)',
          background: hasSelected ? 'var(--c-success-bg)' : 'var(--c-surface)',
          color: hasSelected ? 'var(--c-success)' : 'var(--c-text-secondary)',
        }}>
        <Icon name="excel" size={13} /> تصدير Excel
      </button>
    </>
  );

  return (
    <div className="page-container" dir="rtl" style={{ maxWidth: 1180, margin: '0 auto' }}>
      {pageHeader(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--c-text-primary)' }}>{activePlan.scientificRep?.name}</strong>
          <span style={{ color: 'var(--c-text-muted)' }}>·</span>
          {MONTHS_AR[activePlan.month - 1]} {activePlan.year}
          <Tag tone={st.tone}>{st.label}</Tag>
        </span>,
        actions,
      )}

      <div style={{ marginBottom: 14 }}><Progress steps={steps} /></div>

      {error && <div style={{
        color: 'var(--c-danger)', background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)',
        borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 12.5,
      }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Section
          step={1} title="ملفات الجلسة" icon="file"
          hint={`${uploadedCount} من 3 ملفات مرفوعة`}
          defaultOpen={uploadedCount === 0}
          right={uploadedCount > 0 ? <Tag tone="success">جاهز</Tag> : <Tag>ابدأ من هنا</Tag>}
        >
          <UploadStep token={token!} planId={activePlan.id} uploads={uploads} onChanged={refreshActivePlan} />
        </Section>

        <AreaDoctorsPanel
          token={token!}
          planId={activePlan.id}
          refreshKey={uploads.map(u => `${u.kind}:${u.id}`).join('|')}
        />

        <RatioEditor
          buckets={activePlan.ratioConfig}
          targetDoctorCount={activePlan.targetDoctorCount}
          onChange={b => saveRatio(b, activePlan.targetDoctorCount)}
          onTargetChange={n => saveRatio(activePlan.ratioConfig, n)}
        />

        <ResultsView token={token!} plan={activePlan} candidates={candidates} onChanged={refreshActivePlan} />
      </div>

      <div style={{ height: 24 }} />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button onClick={() => setActivePlan(null)} style={btnMini}>← رجوع لقائمة الجلسات</button>
      </div>
    </div>
  );
}
