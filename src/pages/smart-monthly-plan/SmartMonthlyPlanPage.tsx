import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Icon } from '../../config/icons';
import { smartPlanApi } from './api';
import UploadStep from './UploadStep';
import AreaDoctorsPanel from './AreaDoctorsPanel';
import RatioEditor from './RatioEditor';
import ResultsView from './ResultsView';
import { exportSmartPlan } from './exportSmartPlan';
import { btnGhost, btnMini, btnPrimary, card, inputStyle, panel, sectionTitle, Tag } from './ui';
import type { BucketSummary, RatioBucket, SmartPlan, SmartPlanCandidate, SmartPlanUpload, SmartRep } from './types';
import ProvinceRepsToggle, { useProvinceRepScope, filterByProvinceScope } from '../../components/ProvinceRepsToggle';

const API = import.meta.env.VITE_API_URL || '';
const MONTHS_AR = ['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];

const STATUS_AR: Record<SmartPlan['status'], { label: string; tone: 'neutral' | 'accent' | 'success' }> = {
  draft:     { label: 'مسودة',       tone: 'neutral' },
  resolving: { label: 'قيد التصنيف', tone: 'accent' },
  ready:     { label: 'جاهز',        tone: 'accent' },
  exported:  { label: 'تم التصدير',  tone: 'success' },
};

type StepId = 1 | 2 | 3 | 4;

/**
 * تبويبات الخطوات الأربع — خطوة واحدة ظاهرة في كل لحظة بدل عمود طويل من الأقسام.
 * كل تبويب قابل للنقر في أي وقت، ويحمل علامة «تم» وملخّصاً قصيراً لحالته.
 */
function StepTabs({ steps, current, onPick }: {
  steps: { id: StepId; label: string; icon: string; done: boolean; badge?: React.ReactNode }[];
  current: StepId; onPick: (s: StepId) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginBottom: 14 }}>
      {steps.map(s => {
        const active = s.id === current;
        return (
          <button key={s.id} onClick={() => onPick(s.id)} style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 12,
            cursor: 'pointer', fontFamily: 'inherit', textAlign: 'start',
            background: active ? 'var(--c-accent-light)' : 'var(--c-surface)',
            border: `1px solid ${active ? 'var(--c-accent)' : 'var(--c-border)'}`,
            boxShadow: active ? 'var(--shadow-sm)' : 'none',
          }}>
            <span style={{
              width: 26, height: 26, borderRadius: 8, flexShrink: 0, fontSize: 12, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: s.done ? 'var(--c-success-bg)' : active ? 'var(--c-accent)' : 'var(--c-bg)',
              color: s.done ? 'var(--c-success)' : active ? '#fff' : 'var(--c-text-muted)',
              border: `1px solid ${s.done ? 'var(--c-success-border)' : 'transparent'}`,
            }}>{s.done ? <Icon name="check" size={13} /> : s.id}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, color: active ? 'var(--c-accent)' : 'var(--c-text-primary)' }}>
                <Icon name={s.icon as any} size={13} /> {s.label}
              </span>
              {s.badge && <span style={{ display: 'block', fontSize: 11, color: 'var(--c-text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.badge}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function SmartMonthlyPlanPage({ onBack }: { onBack: () => void }) {
  const { token } = useAuth();
  const [repsAll, setReps] = useState<SmartRep[]>([]);
  // بغداد افتراضياً؛ زر «مندوبي المحافظات» يعرضهم وحدهم
  const [onlyProvince, setOnlyProvince] = useProvinceRepScope('smart-plan');
  const reps = filterByProvinceScope(repsAll, onlyProvince);
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
  const [newCount] = useState(75);

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

  const [step, setStep] = useState<StepId>(1);
  const [selCount, setSelCount] = useState({ selected: 0, total: 0 });
  const [preview, setPreview] = useState<{ summary: BucketSummary[]; eligibleCount: number; pendingCount: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // بصمة الملفات عند آخر تصنيف — تغيّرها يعني أن المرشّحين قديمون ويحتاجون تصنيفاً جديداً
  const resolvedSig = useRef<string | null>(null);
  const uploadsSig = uploads.map(u => `${u.kind}:${u.id}`).join('|');

  const loadPlanDetail = async (id: number, opts: { pickStep?: boolean } = {}) => {
    if (!token) return;
    const { plan, uploads, candidates } = await smartPlanApi.getOne(token, id);
    setActivePlan(plan); setUploads(uploads); setCandidates(candidates);
    if (opts.pickStep) {
      resolvedSig.current = candidates.length ? uploads.map(u => `${u.kind}:${u.id}`).join('|') : null;
      setPreview(null);
      const realUploads = uploads.filter(u => !u.fileName.startsWith('(تلقائي')).length;
      setStep(plan.resultSummary?.length ? 4 : realUploads > 0 ? 2 : 1);
    }
  };

  const refreshActivePlan = () => (activePlan ? loadPlanDetail(activePlan.id) : Promise.resolve());

  const createPlan = async () => {
    if (!token || !newRepId) return;
    setBusy('create'); setError('');
    try {
      const { plan } = await smartPlanApi.create(token, {
        scientificRepId: Number(newRepId), month: newMonth, year: newYear,
        title: newTitle || undefined, targetDoctorCount: newCount,
      });
      setPlans(prev => [plan, ...prev]);
      await loadPlanDetail(plan.id, { pickStep: true });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  /** تصنيف الأسماء فقط إن تغيّرت الملفات منذ آخر تصنيف — يجري تلقائياً لا بزر مستقل. */
  const ensureResolved = async () => {
    if (!token || !activePlan || resolvedSig.current === uploadsSig) return;
    await smartPlanApi.resolve(token, activePlan.id);
    resolvedSig.current = uploadsSig;
  };

  /** زر واحد: تصنيف (إن لزم) ثم توليد، ثم الانتقال لخطوة النتيجة. */
  const runGenerate = async () => {
    if (!token || !activePlan) return;
    setError('');
    try {
      setBusy('resolve');
      await ensureResolved();
      setBusy('compute');
      await smartPlanApi.compute(token, activePlan.id);
      await refreshActivePlan();
      setStep(4);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const saveRatio = async (ratioConfig: RatioBucket[], targetDoctorCount: number) => {
    if (!token || !activePlan) return;
    setActivePlan(prev => (prev ? { ...prev, ratioConfig, targetDoctorCount } : prev));
    try { await smartPlanApi.update(token, activePlan.id, { ratioConfig, targetDoctorCount }); }
    catch (e: any) { setError(e.message); }
  };

  // معاينة الحصص/النقص في خطوة النسب — تُعاد عند تغيّر النسب أو العدد أو التحديد.
  // التأخير أطول من تأخير حفظ التحديد (500ms) حتى تقرأ المعاينة التحديد المحفوظ.
  const ratioSig = activePlan ? JSON.stringify([activePlan.ratioConfig, activePlan.targetDoctorCount]) : '';
  useEffect(() => {
    if (step !== 3 || !token || !activePlan) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        if (resolvedSig.current !== uploadsSig) {
          setBusy('resolve');
          try { await ensureResolved(); } finally { setBusy(null); }
        }
        const r = await smartPlanApi.preview(token, activePlan.id, {
          ratioConfig: activePlan.ratioConfig, targetDoctorCount: activePlan.targetDoctorCount,
        });
        if (!cancelled) setPreview(r);
      } catch (e: any) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) setPreviewLoading(false); }
    }, 900);
    return () => { cancelled = true; clearTimeout(t); };
  }, [step, ratioSig, selCount.selected, uploadsSig]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <ProvinceRepsToggle reps={repsAll} value={onlyProvince} onChange={v => { setOnlyProvince(v); setNewRepId(''); }} compact />
            <select value={newMonth} onChange={e => setNewMonth(Number(e.target.value))} style={{ ...inputStyle, cursor: 'pointer' }}>
              {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <input type="number" value={newYear} onChange={e => setNewYear(Number(e.target.value))} title="السنة" style={{ ...inputStyle, width: 88 }} />
            <input placeholder="عنوان الجلسة (اختياري)" value={newTitle} onChange={e => setNewTitle(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 150 }} />
            <button disabled={!newRepId || busy === 'create'} onClick={createPlan} style={{ ...btnPrimary, opacity: !newRepId || busy === 'create' ? 0.55 : 1 }}>
              {busy === 'create'
                ? <><Icon name="loading" size={13} className="icon-spin" /> جارٍ الإنشاء…</>
                : <><Icon name="add" size={13} /> إنشاء جلسة</>}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginTop: 9 }}>
            الحقول بالترتيب: المندوب · الشهر · السنة · عنوان اختياري. عدد الأطباء المستهدَف ({newCount}) يُعدَّل لاحقاً في خطوة النسب.
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
                  <div key={p.id} onClick={() => loadPlanDetail(p.id, { pickStep: true })} style={{
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
  const ratioTotal = activePlan.ratioConfig.reduce((t, b) => t + (Number(b.percent) || 0), 0);
  const ratioOk = Math.round(ratioTotal) === 100;
  const selectedInPlan = candidates.filter(c => c.selected).length;
  const target = activePlan.targetDoctorCount;
  // 0 محدَّد = لا قيد (كل أطباء السيرفي مؤهَّلون)؛ أقل من الهدف = البلان قد يطلع ناقصاً
  const selectionShort = selCount.selected > 0 && selCount.selected < target;

  const steps = [
    { id: 1 as StepId, label: 'الملفات', icon: 'file', done: uploadedCount > 0, badge: `${uploadedCount} من 4 مرفوعة` },
    {
      id: 2 as StepId, label: 'الأطباء', icon: 'location', done: selCount.selected > 0,
      badge: selCount.selected ? `محدَّد ${selCount.selected} من ${selCount.total}` : 'بلا تحديد = الكل مؤهَّل',
    },
    { id: 3 as StepId, label: 'النسب', icon: 'category', done: ratioOk, badge: `${activePlan.ratioConfig.length} فئات · ${ratioTotal}% · ${target} طبيب` },
    {
      id: 4 as StepId, label: 'النتيجة', icon: 'target', done: !!activePlan.resultSummary?.length,
      badge: activePlan.exportedAt ? 'تم التصدير' : selectedInPlan ? `${selectedInPlan} طبيب في البلان` : 'لم يُولَّد بعد',
    },
  ];

  const generating = busy === 'resolve' || busy === 'compute';
  const generateBtn = (label = 'توليد البلان') => (
    <button disabled={busy !== null || !ratioOk} onClick={runGenerate}
      title={!ratioOk ? 'مجموع النسب يجب أن يساوي 100%' : 'تصنيف الأسماء تلقائياً ثم توليد البلان'}
      style={{ ...btnPrimary, opacity: busy !== null || !ratioOk ? 0.55 : 1 }}>
      {generating
        ? <><Icon name="loading" size={13} className="icon-spin" /> {busy === 'resolve' ? 'جارٍ تصنيف الأسماء…' : 'جارٍ التوليد…'}</>
        : <><Icon name="aiBot" size={13} /> {label}</>}
    </button>
  );
  const exportBtn = (
    <button disabled={!hasSelected} onClick={doExport} title={hasSelected ? 'تنزيل البلان كملف Excel' : 'ولّد البلان أولاً'}
      style={{
        ...btnGhost, opacity: hasSelected ? 1 : 0.5,
        borderColor: hasSelected ? 'var(--c-success-border)' : 'var(--c-border)',
        background: hasSelected ? 'var(--c-success-bg)' : 'var(--c-surface)',
        color: hasSelected ? 'var(--c-success)' : 'var(--c-text-secondary)',
      }}>
      <Icon name="excel" size={13} /> تصدير Excel
    </button>
  );
  const nextBtn = (to: StepId, label: string) => (
    <button onClick={() => setStep(to)} style={btnPrimary}>{label} <Icon name="chevronLeft" size={13} /></button>
  );
  const primaryAction = step === 1 ? nextBtn(2, 'التالي: الأطباء')
    : step === 2 ? nextBtn(3, 'التالي: النسب')
    : step === 3 ? generateBtn()
    : hasSelected ? exportBtn : generateBtn();

  const show = (id: StepId): React.CSSProperties => ({ display: step === id ? 'block' : 'none' });

  return (
    <div className="page-container" dir="rtl" style={{ maxWidth: 1180, margin: '0 auto' }}>
      {pageHeader(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--c-text-primary)' }}>{activePlan.scientificRep?.name}</strong>
          <span style={{ color: 'var(--c-text-muted)' }}>·</span>
          {MONTHS_AR[activePlan.month - 1]} {activePlan.year}
          <Tag tone={st.tone}>{st.label}</Tag>
        </span>,
        exportBtn,
      )}

      <StepTabs steps={steps} current={step} onPick={setStep} />

      {error && <div style={{
        color: 'var(--c-danger)', background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)',
        borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 12.5,
      }}>{error}</div>}

      {/* كل الخطوات تبقى مركّبة (مخفية فقط) حتى لا يضيع البحث/الفتح/عدّاد التحديد عند التنقل */}
      <div style={show(1)}>
        <div style={panel}>
          <h3 style={{ ...sectionTitle, marginBottom: 4 }}>
            <Icon name="file" size={15} style={{ color: 'var(--c-accent)' }} /> ملفات الجلسة
          </h3>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-muted)', marginBottom: 12 }}>
            كل الملفات اختيارية — بدون سيرفي مرفوع تُستخدم بيانات السيرفي المسجَّلة لمناطق المندوب تلقائياً.
          </div>
          <UploadStep token={token!} planId={activePlan.id} uploads={uploads} onChanged={refreshActivePlan} />
        </div>
      </div>

      <div style={show(2)}>
        <div style={panel}>
          <AreaDoctorsPanel
            token={token!}
            planId={activePlan.id}
            refreshKey={uploadsSig}
            onSelectionChange={(selected, total) => setSelCount({ selected, total })}
          />
        </div>
      </div>

      <div style={show(3)}>
        <RatioEditor
          buckets={activePlan.ratioConfig}
          targetDoctorCount={activePlan.targetDoctorCount}
          onChange={b => saveRatio(b, activePlan.targetDoctorCount)}
          onTargetChange={n => saveRatio(activePlan.ratioConfig, n)}
          preview={preview}
          previewLoading={previewLoading}
        />
      </div>

      <div style={show(4)}>
        <ResultsView token={token!} plan={activePlan} candidates={candidates} onChanged={refreshActivePlan} />
        {activePlan.resultSummary?.length ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>{generateBtn('إعادة التوليد')}</div>
        ) : null}
      </div>

      {/* شريط سفلي ثابت: حالة التحديد مقابل الهدف + التنقل */}
      <div style={{
        position: 'sticky', bottom: 0, zIndex: 30, marginTop: 16,
        background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 14,
        boxShadow: 'var(--shadow-md)', padding: '10px 14px',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--c-text-secondary)', flex: 1, minWidth: 0 }}>
          <Icon name="person" size={14} style={{ color: 'var(--c-text-muted)' }} />
          {selCount.selected
            ? <span>محدَّد <strong style={{ color: 'var(--c-text-primary)' }}>{selCount.selected}</strong> من {selCount.total}</span>
            : <span>لا تحديد — كل أطباء السيرفي ({selCount.total}) مؤهَّلون</span>}
          <span style={{ color: 'var(--c-text-muted)' }}>·</span>
          <span>الهدف <strong style={{ color: 'var(--c-text-primary)' }}>{target}</strong></span>
          {selectionShort && (
            <Tag tone="danger" title="أطباء السيرفي غير المحدَّدين لا يدخلون البلان — قد يطلع البلان ناقصاً إن لم تكفِ الملفات المرفوعة">
              <Icon name="warning" size={11} /> المحدَّد أقل من الهدف
            </Tag>
          )}
          {!ratioOk && <Tag tone="danger">مجموع النسب {ratioTotal}%</Tag>}
        </div>
        {step > 1 && <button onClick={() => setStep((step - 1) as StepId)} style={btnGhost}><Icon name="chevronRight" size={13} /> السابق</button>}
        {primaryAction}
      </div>

      <div style={{ height: 12 }} />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button onClick={() => setActivePlan(null)} style={btnMini}>← رجوع لقائمة الجلسات</button>
      </div>
    </div>
  );
}
