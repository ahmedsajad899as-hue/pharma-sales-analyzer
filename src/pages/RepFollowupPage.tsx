// ════════════════════════════════════════════════════════════════════════════
// RepFollowupPage — متابعة المندوبين (المرحلة الأولى: القياس + المعايير).
//
// ثلاث طبقات عمق مقصودة: جدول الفريق ← صفّ المندوب مفتوحاً (الأسباب + التفصيل)
// ← تبويب المعايير. المدير لا يقرأ 15 عموداً، يقرأ مؤشّراً وسبباً.
//
// الصفحة **لا تحسب شيئاً**: تقرأ لقطات محفوظة. الحساب ثقيل (تقرير مبيعات لكل
// مندوب مرتين) فيجري ليلاً أو بزرّ «احسب الآن» صريح.
// ════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

const MANAGER_ROLES = new Set([
  'admin', 'manager', 'company_manager', 'team_leader', 'supervisor',
  'office_manager', 'product_manager', 'commercial_supervisor',
  'commercial_team_leader', 'office_employee', 'office_hr',
]);

const MONTHS_AR = ['كانون2', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين1', 'تشرين2', 'كانون1'];

type Status = 'excellent' | 'good' | 'watch' | 'behind' | 'no_data' | 'error';

const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  excellent: { label: 'ممتاز', color: '#047857', bg: 'rgba(16,185,129,0.14)' },
  good: { label: 'جيد', color: '#1e40af', bg: 'rgba(59,130,246,0.12)' },
  watch: { label: 'يحتاج متابعة', color: '#b45309', bg: 'rgba(245,158,11,0.16)' },
  behind: { label: 'متأخر', color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
  no_data: { label: 'بلا بيانات', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
  error: { label: 'خطأ بالحساب', color: '#7c2d12', bg: 'rgba(124,45,18,0.12)' },
};

interface Standards {
  doctorVisitsPerDay: number; pharmacyVisitsPerDay: number; workDaysPerMonth: number;
  restWeekdays: string; doctorRevisitDays: number;
  doctorCoverageTargetPct: number; pharmacyCoverageTargetPct: number; areaIdleDays: number;
  targetAchievementMinPct: number; growthTargetPct: number;
  weightSales: number; weightVisits: number; weightCoverage: number; weightGrowth: number; weightDiscipline: number;
  digestEnabled: boolean; digestRepHour: number; digestManagerHour: number;
  digestChannels: string; maxLinesPerDigest: number;
  isSaved?: boolean;
}

interface OverrideRow {
  scientificRepId: number; repName: string; note: string | null;
  doctorVisitsPerDay: number | null; pharmacyVisitsPerDay: number | null;
  workDaysPerMonth: number | null; doctorRevisitDays: number | null;
  doctorCoverageTargetPct: number | null; pharmacyCoverageTargetPct: number | null;
  areaIdleDays: number | null; targetAchievementMinPct: number | null; growthTargetPct: number | null;
}

interface AreaRow {
  areaName: string; totalDoctors: number; visitedDoctors: number; doctorVisitCount: number;
  totalPharmacies: number; pharmacyVisitCount: number; visitedPharmacies: number; lastVisitAt: string | null;
}

interface Metrics {
  sales: { netValue: number; orderCount: number; prevNetValue: number; prevOrderCount: number; hasData: boolean };
  target: {
    total: number; achieved: number; achievementPct: number | null; projectedPct: number | null;
    gapQty: number; neededPerDay: number; remainingWorkDays: number; itemCount: number;
    zeroSaleItems: { itemId: number; itemName: string; target: number }[];
    weakest: { itemId: number; itemName: string; target: number; actual: number; achievementPct: number | null }[];
  };
  visits: {
    doctorVisits: number; pharmacyVisits: number; expectedDoctorVisits: number; expectedPharmacyVisits: number;
    doctorVisitPct: number | null; pharmacyVisitPct: number | null;
    workDaysElapsed: number; workDaysTotal: number; monthProgressPct: number;
    activeDays: number; zeroDays: number; zeroDayList: number[];
  };
  coverage: {
    visitedDoctors: number; totalDoctors: number; doctorCoveragePct: number | null;
    visitedPharmacies: number; totalPharmacies: number; pharmacyCoveragePct: number | null;
    areasWithNoVisits: string[]; areaCount: number; areas: AreaRow[];
  };
  growth: { growthPct: number | null; orderGrowthPct: number | null };
  discipline: { planned: number; visited: number; postponed: number; autoPostponed: number; adherencePct: number | null; hasData: boolean };
  standardsUsed: Record<string, number | boolean | string | null>;
}

interface Card {
  repUserId: number; scientificRepId: number | null; repName: string;
  company: { id: number; name: string } | null;
  score: number; status: Status;
  components: Record<string, { weight: number; pct: number }>;
  reasons: string[];
  metrics: Metrics | null;
  fileScope: { count: number; synced: boolean; source: string } | null;
  computedAt: string;
}

interface TelegramStatus {
  managerLinked: boolean; managerChats: string[];
  reps: { repUserId: number; repName: string; linked: boolean; chats: string[] }[];
  linkedCount: number; totalCount: number;
}

interface DigestPreview {
  kind: 'rep' | 'manager';
  empty: boolean; missingSnapshot: boolean;
  title: string | null; body: string | null;
  channels: string; digestEnabled: boolean;
  telegramLinked: boolean; telegramChats: string[];
}

const fmtNum = (v: number | null | undefined) => Math.round(v || 0).toLocaleString('en-US');
const fmtUSD = (v: number | null | undefined) => `$${fmtNum(v)}`;
const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);

export default function RepFollowupPage() {
  const { token, user, hasFeature } = useAuth();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const isManager = MANAGER_ROLES.has(user?.role ?? '');
  // مفاتيح شاشة «المميزات» عند الأدمن (featureConfig.ts) — إغلاق أيٍّ منها يُخفي
  // جزءه فقط، والصفحة كاملة تُخفى بمفتاح rep_followup من الشريط الجانبي.
  const canEditStandards = hasFeature('rep_followup_standards');
  const canUseDigest     = hasFeature('rep_followup_digest');
  const canRecompute     = hasFeature('rep_followup_recompute');

  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [tab, setTab] = useState<'team' | 'standards'>('team');

  const [cards, setCards] = useState<Card[] | null>(null);
  const [standards, setStandards] = useState<Standards | null>(null);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [fileScope, setFileScope] = useState<Card['fileScope']>(null);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [myCard, setMyCard] = useState<Card | null>(null);
  const [tg, setTg] = useState<TelegramStatus | null>(null);

  // ── تحميل اللقطات (قراءة فقط) ─────────────────────────────────────────────
  const loadScorecards = useCallback(() => {
    if (!token || !isManager) return;
    setLoading(true);
    setErr(null);
    fetch(`${API}/api/rep-followup/scorecards?month=${month}&year=${year}`, { headers, cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل اللقطات');
        setCards(j.reps ?? []);
        setStandards(j.standards ?? null);
        setComputedAt(j.computedAt ?? null);
        setFileScope(j.fileScope ?? null);
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [token, headers, month, year, isManager]);

  const loadStandards = useCallback(() => {
    if (!token) return;
    fetch(`${API}/api/rep-followup/standards`, { headers })
      .then(r => r.json())
      .then(j => {
        if (j.success) { setStandards(j.standards); setOverrides(j.overrides ?? []); }
      })
      .catch(() => {});
  }, [token, headers]);

  const loadMine = useCallback(() => {
    if (!token || isManager) return;
    fetch(`${API}/api/rep-followup/me?month=${month}&year=${year}`, { headers, cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.success) { setMyCard(j.card ?? null); setStandards(j.standards ?? null); } })
      .catch(() => {});
  }, [token, headers, month, year, isManager]);

  const loadTelegramStatus = useCallback(() => {
    if (!token || !isManager) return;
    fetch(`${API}/api/rep-followup/digest/telegram-status?month=${month}&year=${year}`, { headers, cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.success) setTg(j); })
      .catch(() => {});
  }, [token, headers, month, year, isManager]);

  useEffect(() => { loadScorecards(); }, [loadScorecards]);
  useEffect(() => { loadStandards(); }, [loadStandards]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadTelegramStatus(); }, [loadTelegramStatus]);

  // ── احسب الآن ─────────────────────────────────────────────────────────────
  const recompute = async () => {
    setComputing(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/api/rep-followup/recompute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, year }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحساب');
      setCards(j.reps ?? []);
      setStandards(j.standards ?? null);
      setComputedAt(j.computedAt ?? null);
      setFileScope(j.fileScope ?? null);
      loadTelegramStatus();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'فشل الحساب');
    } finally {
      setComputing(false);
    }
  };

  const kpis = useMemo(() => {
    const list = cards ?? [];
    const measurable = list.filter(c => c.status !== 'no_data' && c.status !== 'error');
    const avg = measurable.length ? Math.round(measurable.reduce((s, c) => s + c.score, 0) / measurable.length) : 0;
    return {
      total: list.length,
      avg,
      behind: list.filter(c => c.status === 'behind').length,
      noData: list.filter(c => c.status === 'no_data').length,
    };
  }, [cards]);

  return (
    <div className="page" dir="rtl" style={{ maxWidth: 1500 }}>
      <div className="page-header">
        <div>
          <div className="page-title">🎯 متابعة المندوبين</div>
          <div className="page-subtitle">
            مؤشّر واحد لكل مندوب من خمس عائلات: التارجت · الزيارات · التغطية · التطوّر · الانضباط — بمعاييرك أنت لا بأرقام ثابتة
          </div>
        </div>
      </div>

      {isManager && (
        <div className="tabs">
          <button className={`tab ${tab === 'team' ? 'tab--active' : ''}`} onClick={() => setTab('team')}>📊 الفريق</button>
          {canEditStandards && (
            <button className={`tab ${tab === 'standards' ? 'tab--active' : ''}`} onClick={() => setTab('standards')}>⚙️ المعايير</button>
          )}
        </div>
      )}

      {/* ── شريط الفترة ───────────────────────────────────────────────── */}
      <div className="filter-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div className="form-group" style={{ minWidth: 130 }}>
          <label className="form-label">الشهر</label>
          <select className="form-input" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
            {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ minWidth: 110 }}>
          <label className="form-label">السنة</label>
          <select className="form-input" value={year} onChange={e => setYear(parseInt(e.target.value))}>
            {[year + 1, year, year - 1, year - 2].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b - a).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        {isManager && canRecompute && (
          <button className="btn btn--primary" onClick={recompute} disabled={computing}>
            {computing ? '⏳ جاري الحساب…' : '🔄 احسب الآن'}
          </button>
        )}
        <div style={{ fontSize: 12, color: '#64748b', marginRight: 'auto', textAlign: 'left', lineHeight: 1.7 }}>
          {computedAt
            ? <>آخر حساب: {new Date(computedAt).toLocaleString('ar-IQ-u-nu-latn')}<br /></>
            : <>لم تُحسب لقطة لهذه الفترة بعد — اضغط «احسب الآن».<br /></>}
          {fileScope && (
            <span style={{ color: fileScope.synced ? '#64748b' : '#b45309', fontWeight: fileScope.synced ? 400 : 700 }}>
              حُسب على {fileScope.count} ملف — {fileScope.source}
            </span>
          )}
        </div>
      </div>

      {err && <div className="info-banner" style={{ background: 'rgba(239,68,68,0.1)', color: '#b91c1c' }}>⚠️ {err}</div>}

      {/* ملاحظة الملفات غير المُزامَنة — السبب الأول لاختلاف الأرقام عن الشاشات الأخرى */}
      {fileScope && !fileScope.synced && (
        <div className="info-banner" style={{ background: 'rgba(245,158,11,0.12)', color: '#92400e' }}>
          ℹ️ لم تُزامَن «الملفات المفعّلة» لهذا الحساب بعد، فحُسب على كل ملفات المكتب. افتح صفحة تحليل المبيعات
          وفعّل الملفات التي تريد المحاسبة عليها، ثم اضغط «احسب الآن» ليطابق الرقم ما تراه في بقية الشاشات.
        </div>
      )}

      {/* حالة الربط بتلكرام — السبب الأول لعدم وصول الرسائل */}
      {isManager && canUseDigest && tg && standards?.digestEnabled && tg.totalCount > 0 && tg.linkedCount < tg.totalCount && (
        <div className="info-banner" style={{ background: 'rgba(245,158,11,0.12)', color: '#92400e' }}>
          📨 الملخّص مفعّل، لكن {tg.totalCount - tg.linkedCount} من {tg.totalCount} مندوباً غير مربوط بكروب تلكرام —
          هؤلاء سيستلمون الإشعار داخل التطبيق فقط. الربط: يُضاف البوت لكروب المندوب، فيردّ البوت برقم الكروب،
          ثم لوحة الماستر أدمن ← روابط تيليجرام ← ربط كروب جديد بحساب ذلك المندوب.
        </div>
      )}

      {/* ══ عرض المندوب لنفسه ══════════════════════════════════════════ */}
      {!isManager && (
        myCard
          ? <RepSelfView card={myCard} />
          : <div className="card" style={{ textAlign: 'center', color: '#64748b', padding: 30 }}>
              لا توجد لقطة محسوبة لك في هذه الفترة بعد — تُحسب تلقائياً كل ليلة.
            </div>
      )}

      {/* ══ تبويب الفريق ══════════════════════════════════════════════ */}
      {isManager && tab === 'team' && (
        <>
          <div className="stats-grid">
            {[
              { label: 'عدد المندوبين', value: fmtNum(kpis.total), icon: '👥', color: '#1e40af', bg: 'rgba(59,130,246,0.12)' },
              { label: 'متوسط المؤشّر', value: `${kpis.avg}/100`, icon: '📊', color: '#047857', bg: 'rgba(16,185,129,0.14)' },
              { label: 'متأخرون', value: fmtNum(kpis.behind), icon: '🔻', color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
              { label: 'بلا بيانات قابلة للقياس', value: fmtNum(kpis.noData), icon: '❔', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
            ].map((k, i) => (
              <div key={i} className="stat-card" style={{ borderTop: `4px solid ${k.color}` }}>
                <div className="stat-card-icon" style={{ background: k.bg, color: k.color }}>{k.icon}</div>
                <div className="stat-card-body">
                  <div className="stat-card-value" style={{ color: k.color }}>{k.value}</div>
                  <div className="stat-card-label">{k.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-title">جدول الفريق — اضغط على أي مندوب لتفصيل أسبابه</div>
            {loading && <div style={{ textAlign: 'center', color: '#64748b', padding: 20 }}>جاري التحميل…</div>}
            {!loading && (!cards || cards.length === 0) && (
              <div style={{ textAlign: 'center', color: '#64748b', padding: 24, lineHeight: 1.9 }}>
                لا توجد لقطات لهذه الفترة.<br />
                اضغط «احسب الآن» — ثم تُحدَّث تلقائياً كل ليلة بعد ذلك.
              </div>
            )}
            {!loading && cards && cards.length > 0 && (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>#</th>
                      <th>المندوب</th>
                      <th style={{ width: 92 }}>المؤشّر</th>
                      <th style={{ width: 130 }}>التارجت</th>
                      <th style={{ width: 120 }}>زيارات أطباء</th>
                      <th style={{ width: 120 }}>زيارات صيدليات</th>
                      <th style={{ width: 110 }}>تغطية الأطباء</th>
                      <th style={{ width: 90 }}>التطوّر</th>
                      <th style={{ width: 120 }}>الحالة</th>
                      <th style={{ width: 30 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((c, i) => {
                      const meta = STATUS_META[c.status] ?? STATUS_META.watch;
                      const m = c.metrics;
                      const open = expanded === c.repUserId;
                      return (
                        <Fragment key={c.repUserId}>
                          <tr onClick={() => setExpanded(open ? null : c.repUserId)} style={{ cursor: 'pointer' }}>
                            <td style={{ color: '#94a3b8' }}>{i + 1}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700 }}>
                              {c.repName}
                              {c.company && (
                                <span style={{ marginRight: 6, fontSize: 10, fontWeight: 700, background: '#f1f5f9', color: '#334155', borderRadius: 4, padding: '1px 8px' }}>
                                  {c.company.name}
                                </span>
                              )}
                              {m?.standardsUsed?.hasOverride && (
                                <span title="لهذا المندوب معايير خاصة" style={{ marginRight: 6, fontSize: 10, fontWeight: 700, background: 'rgba(139,92,246,0.14)', color: '#6d28d9', borderRadius: 4, padding: '1px 7px' }}>
                                  معيار خاص
                                </span>
                              )}
                              {tg && (() => {
                                const row = tg.reps.find(r => r.repUserId === c.repUserId);
                                if (!row) return null;
                                return row.linked
                                  ? <span title={`تلكرام: ${row.chats.join('، ')}`} style={{ marginRight: 6, fontSize: 10 }}>📨</span>
                                  : <span title="غير مربوط بتلكرام — يستلم إشعار التطبيق فقط" style={{ marginRight: 6, fontSize: 10, opacity: 0.45 }}>🚫📨</span>;
                              })()}
                            </td>
                            <td>
                              <span style={{ background: meta.bg, color: meta.color, borderRadius: 4, padding: '2px 10px', fontWeight: 800 }}>{c.score}</span>
                            </td>
                            <td>
                              {m && m.target.total > 0 ? (
                                <>
                                  <div style={{ fontWeight: 700 }}>{pctText(m.target.achievementPct)}</div>
                                  {m.target.projectedPct !== null && (
                                    <div style={{ fontSize: 10, color: m.target.projectedPct < 90 ? '#b91c1c' : '#047857' }}>
                                      متوقَّع {m.target.projectedPct}%
                                    </div>
                                  )}
                                </>
                              ) : <span style={{ color: '#94a3b8', fontSize: 11 }}>بلا تارجت</span>}
                            </td>
                            <td>
                              {m ? <>
                                <div style={{ fontWeight: 700 }}>{fmtNum(m.visits.doctorVisits)}</div>
                                <div style={{ fontSize: 10, color: '#64748b' }}>من {fmtNum(m.visits.expectedDoctorVisits)} ({pctText(m.visits.doctorVisitPct)})</div>
                              </> : '—'}
                            </td>
                            <td>
                              {m ? <>
                                <div style={{ fontWeight: 700 }}>{fmtNum(m.visits.pharmacyVisits)}</div>
                                <div style={{ fontSize: 10, color: '#64748b' }}>من {fmtNum(m.visits.expectedPharmacyVisits)} ({pctText(m.visits.pharmacyVisitPct)})</div>
                              </> : '—'}
                            </td>
                            <td>
                              {m ? <>
                                <div style={{ fontWeight: 700 }}>{pctText(m.coverage.doctorCoveragePct)}</div>
                                <div style={{ fontSize: 10, color: '#64748b' }}>{fmtNum(m.coverage.visitedDoctors)} من {fmtNum(m.coverage.totalDoctors)}</div>
                              </> : '—'}
                            </td>
                            <td>
                              {m?.growth.growthPct !== null && m?.growth.growthPct !== undefined ? (
                                <span style={{ fontWeight: 700, color: m.growth.growthPct >= 0 ? '#047857' : '#b91c1c' }}>
                                  {m.growth.growthPct >= 0 ? '▲' : '▼'} {Math.abs(m.growth.growthPct)}%
                                </span>
                              ) : <span style={{ color: '#94a3b8' }}>—</span>}
                            </td>
                            <td>
                              <span style={{ background: meta.bg, color: meta.color, borderRadius: 4, padding: '2px 9px', fontWeight: 700, fontSize: 11 }}>{meta.label}</span>
                            </td>
                            <td style={{ color: '#94a3b8', fontSize: 11 }}>{open ? '▲' : '▼'}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={10} style={{ background: '#f8fafc', padding: '14px 18px', textAlign: 'right' }}>
                                <CardDetail
                                  card={c}
                                  headers={headers}
                                  existingOverride={overrides.find(o => o.scientificRepId === c.scientificRepId) ?? null}
                                  onOverridesChanged={setOverrides}
                                  month={month}
                                  year={year}
                                  canUseDigest={canUseDigest}
                                  canEditOverride={canEditStandards}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ══ تبويب المعايير ════════════════════════════════════════════ */}
      {isManager && canEditStandards && tab === 'standards' && standards && (
        <StandardsTab
          standards={standards}
          overrides={overrides}
          headers={headers}
          onSaved={(s) => { setStandards(s); loadStandards(); }}
          onOverridesChanged={(list) => setOverrides(list)}
          tg={tg}
          month={month}
          year={year}
          canUseDigest={canUseDigest}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// تفصيل المندوب
// ════════════════════════════════════════════════════════════════════════════

const COMPONENT_LABELS: Record<string, string> = {
  sales: 'المبيع/التارجت', visits: 'الزيارات', coverage: 'التغطية',
  growth: 'التطوّر', discipline: 'الانضباط',
};

function CardDetail({ card, headers, canEditOverride, existingOverride, onOverridesChanged, month, year, canUseDigest }: {
  card: Card;
  headers?: Record<string, string>;
  canEditOverride?: boolean;
  existingOverride?: OverrideRow | null;
  onOverridesChanged?: (list: OverrideRow[]) => void;
  month?: number;
  year?: number;
  canUseDigest?: boolean;
}) {
  const m = card.metrics;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* الأسباب — أول ما يُقرأ */}
      {card.reasons.length > 0 && (
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>لماذا هذه الحالة</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 2, fontSize: 13 }}>
            {card.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* مكوّنات المؤشّر */}
      {Object.keys(card.components).length > 0 && (
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>من أين جاء المؤشّر</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
            {Object.entries(card.components).map(([k, v]) => (
              <div key={k} style={{ background: '#fff', borderRadius: 6, padding: '8px 10px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{COMPONENT_LABELS[k] ?? k}</span>
                  <span>وزن {v.weight}</span>
                </div>
                <div style={{ height: 6, background: '#eef2f7', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, v.pct)}%`, height: '100%', background: v.pct >= 85 ? '#10b981' : v.pct >= 60 ? '#3b82f6' : '#ef4444' }} />
                </div>
                <div style={{ fontSize: 12, fontWeight: 800, marginTop: 4 }}>{v.pct}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {m && (
        <>
          {/* أرقام سريعة */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, fontSize: 12 }}>
            <Fact label="صافي المبيع" value={fmtUSD(m.sales.netValue)} sub={`الشهر الماضي ${fmtUSD(m.sales.prevNetValue)}`} />
            <Fact label="عدد الطلبيات" value={fmtNum(m.sales.orderCount)} sub={m.growth.orderGrowthPct !== null ? `${m.growth.orderGrowthPct >= 0 ? '+' : ''}${m.growth.orderGrowthPct}% عن الماضي` : undefined} />
            {/* «س / ص» ينقلب بصرياً في RTL فيُقرأ مقلوباً — نكتبها «س من ص» */}
            <Fact
              label="التارجت (كمية)"
              value={m.target.total > 0 ? `${fmtNum(m.target.achieved)} من ${fmtNum(m.target.total)}` : '—'}
              sub={m.target.total > 0
                ? (m.target.gapQty > 0 ? `ناقص ${fmtNum(m.target.gapQty)} — ${fmtNum(m.target.neededPerDay)} باليوم` : 'مكتمل')
                : 'لا تارجت مُدخَل لهذا الشهر'}
            />
            <Fact label="أيام العمل" value={`${m.visits.workDaysElapsed} من ${m.visits.workDaysTotal}`} sub={`مرّ ${m.visits.monthProgressPct}% من الشهر`} />
            <Fact label="أيام بلا زيارة" value={fmtNum(m.visits.zeroDays)} sub={m.visits.zeroDayList.length ? `أيام ${m.visits.zeroDayList.join('، ')}` : undefined} danger={m.visits.zeroDays > 0} />
            <Fact label="تغطية الصيدليات" value={pctText(m.coverage.pharmacyCoveragePct)} sub={`${fmtNum(m.coverage.visitedPharmacies)} من ${fmtNum(m.coverage.totalPharmacies)}`} />
            <Fact label="التزام البلان" value={pctText(m.discipline.adherencePct)} sub={m.discipline.hasData ? `${m.discipline.visited}/${m.discipline.planned} مدخلاً` : 'لا بلان مُسجَّل'} />
            <Fact label="المناطق" value={fmtNum(m.coverage.areaCount)} sub={m.coverage.areasWithNoVisits.length ? `${m.coverage.areasWithNoVisits.length} بلا زيارة` : 'كلها مزارة'} danger={m.coverage.areasWithNoVisits.length > 0} />
          </div>

          {/* أضعف الايتمات على التارجت */}
          {m.target.weakest.length > 0 && (
            <div>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>أضعف الايتمات على التارجت</div>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead><tr><th>الايتم</th><th style={{ width: 90 }}>التارجت</th><th style={{ width: 90 }}>المنجز</th><th style={{ width: 80 }}>الإنجاز</th></tr></thead>
                  <tbody>
                    {m.target.weakest.map(it => (
                      <tr key={it.itemId}>
                        <td style={{ textAlign: 'right' }}>{it.itemName}</td>
                        <td>{fmtNum(it.target)}</td>
                        <td>{fmtNum(it.actual)}</td>
                        <td style={{ fontWeight: 700, color: (it.achievementPct ?? 0) >= 90 ? '#047857' : (it.achievementPct ?? 0) >= 50 ? '#b45309' : '#b91c1c' }}>
                          {pctText(it.achievementPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* المناطق */}
          {m.coverage.areas.length > 0 && (
            <div>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>تفصيل المناطق</div>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>المنطقة</th>
                      <th style={{ width: 110 }}>أطباء مزارون</th>
                      <th style={{ width: 90 }}>كولات</th>
                      <th style={{ width: 120 }}>صيدليات مزارة</th>
                      <th style={{ width: 90 }}>زيارات</th>
                      <th style={{ width: 100 }}>آخر زيارة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.coverage.areas.map((a, i) => (
                      <tr key={i} style={{ background: (a.doctorVisitCount + a.pharmacyVisitCount) === 0 ? 'rgba(239,68,68,0.06)' : undefined }}>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{a.areaName}</td>
                        <td>{a.totalDoctors > 0 ? `${a.visitedDoctors} من ${a.totalDoctors}` : '—'}</td>
                        <td>{a.doctorVisitCount || '—'}</td>
                        <td>{a.totalPharmacies > 0 ? `${a.visitedPharmacies} من ${a.totalPharmacies}` : '—'}</td>
                        <td>{a.pharmacyVisitCount || '—'}</td>
                        <td style={{ fontSize: 11, color: '#64748b' }}>{a.lastVisitAt ?? 'بلا زيارة'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            حُسب بمعايير: {String(m.standardsUsed.doctorVisitsPerDay)} طبيب/يوم · {String(m.standardsUsed.pharmacyVisitsPerDay)} صيدلية/يوم ·
            تغطية مطلوبة {String(m.standardsUsed.doctorCoverageTargetPct)}% · أدنى تحقّق {String(m.standardsUsed.targetAchievementMinPct)}%
            {m.standardsUsed.overrideNote ? ` · استثناء: ${m.standardsUsed.overrideNote}` : ''}
          </div>
        </>
      )}

      {headers && canUseDigest && (
        <DigestTester headers={headers} repUserId={card.repUserId} repName={card.repName} month={month} year={year} />
      )}
      {canEditOverride && headers && (
        <OverrideEditor
          card={card}
          headers={headers}
          existing={existingOverride ?? null}
          onChanged={onOverridesChanged}
        />
      )}
    </div>
  );
}

// ── معاينة رسالة الملخّص وإرسال تجربة ──────────────────────────────────────
// المعاينة تُبنى من اللقطة المحفوظة نفسها، فما يُعرض هنا هو ما يُرسَل حرفياً.
// الإرسال لمندوب يستأذن أولاً: الرسالة تصل شخصاً آخر ولا تُسترَدّ.
function DigestTester({ headers, repUserId, repName, month, year }: {
  headers: Record<string, string>;
  repUserId: number | null;   // null = ملخّص المدير لنفسه
  repName?: string;
  month?: number;
  year?: number;
}) {
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (month) p.set('month', String(month));
    if (year) p.set('year', String(year));
    if (repUserId != null) p.set('repUserId', String(repUserId));
    return p.toString();
  }, [month, year, repUserId]);

  const load = async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await fetch(`${API}/api/rep-followup/digest/preview?${qs}`, { headers, cache: 'no-store' });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'تعذّرت المعاينة');
      setPreview(j);
    } catch (e: unknown) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : 'تعذّرت المعاينة'}`);
    } finally { setLoading(false); }
  };

  const send = async () => {
    if (repUserId != null) {
      const ok = window.confirm(`سترسل رسالة تجربة الآن إلى ${repName ?? 'هذا المندوب'} — سيستلمها فعلاً على تلكرام/التطبيق. متابعة؟`);
      if (!ok) return;
    }
    setSending(true); setMsg(null);
    try {
      const r = await fetch(`${API}/api/rep-followup/digest/send-test`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, year, repUserId }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الإرسال');
      if (j.empty) setMsg('ℹ️ لا يوجد ما يستحق رسالة اليوم لهذا المستلم — صمت مقصود لا خطأ.');
      else if (!j.sent) {
        setMsg(j.reason === 'no-telegram-link'
          ? '⚠️ لم يُرسَل: لا كروب تلكرام مربوط بهذا الحساب (وقناة التطبيق غير مفعّلة في الإعدادات).'
          : '⚠️ لم تنجح أي قناة — راجع القنوات في تبويب المعايير.');
      } else setMsg(`✅ أُرسلت التجربة على: ${(j.channels ?? []).join('، ')} — ولم تُستهلك رسالة اليوم الحقيقية.`);
    } catch (e: unknown) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : 'فشل الإرسال'}`);
    } finally { setSending(false); }
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn--secondary btn--sm" onClick={load} disabled={loading}>
          {loading ? '⏳' : '👁 معاينة الرسالة'}
        </button>
        <button className="btn btn--primary btn--sm" onClick={send} disabled={sending}>
          {sending ? '⏳ جاري الإرسال…' : repUserId == null ? '📤 أرسل لي تجربة الآن' : '📤 أرسل تجربة له الآن'}
        </button>
        {msg && <span style={{ fontSize: 11, fontWeight: 700 }}>{msg}</span>}
      </div>

      {preview && (
        <div style={{ marginTop: 10 }}>
          {!preview.digestEnabled && (
            <div style={{ fontSize: 11, color: '#92400e', marginBottom: 6 }}>
              ⚠️ الملخّص اليومي معطّل حالياً — التجربة تعمل، لكن لا شيء يُرسَل تلقائياً حتى تُفعّله من تبويب المعايير.
            </div>
          )}
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
            القنوات: {preview.channels} ·{' '}
            {preview.telegramLinked
              ? `تلكرام مربوط (${preview.telegramChats.join('، ') || 'كروب'})`
              : 'تلكرام غير مربوط لهذا الحساب'}
          </div>
          {preview.missingSnapshot ? (
            <div style={{ fontSize: 12, color: '#b45309' }}>لا توجد لقطة محسوبة لهذا المندوب في هذه الفترة — اضغط «احسب الآن».</div>
          ) : preview.empty ? (
            <div style={{ fontSize: 12, color: '#64748b' }}>لا يوجد ما يستحق رسالة اليوم — الملخّص يصمت بدل أن يُرسل رسالة فارغة.</div>
          ) : (
            <pre style={{
              margin: 0, padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
              fontSize: 12, lineHeight: 1.9, whiteSpace: 'pre-wrap', fontFamily: 'inherit', textAlign: 'right',
            }}>{preview.title}{'\n\n'}{preview.body}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── محرّر استثناء مندوب واحد ────────────────────────────────────────────────
// حقل فارغ = «ارجع لرقم المكتب» لا صفر — لذلك القيم نصوص هنا لا أرقام، فالصفر
// رقم مقصود يختلف عن الفراغ.
const OVERRIDE_FIELDS: { key: keyof OverrideRow; label: string }[] = [
  { key: 'doctorVisitsPerDay', label: 'أطباء/يوم' },
  { key: 'pharmacyVisitsPerDay', label: 'صيدليات/يوم' },
  { key: 'workDaysPerMonth', label: 'أيام العمل' },
  { key: 'doctorRevisitDays', label: 'دورة زيارة الطبيب' },
  { key: 'doctorCoverageTargetPct', label: 'تغطية أطباء %' },
  { key: 'pharmacyCoverageTargetPct', label: 'تغطية صيدليات %' },
  { key: 'areaIdleDays', label: 'منطقة مهجورة (يوم)' },
  { key: 'targetAchievementMinPct', label: 'أدنى تحقّق %' },
  { key: 'growthTargetPct', label: 'نمو مطلوب %' },
];

function OverrideEditor({ card, headers, existing, onChanged }: {
  card: Card;
  headers: Record<string, string>;
  existing: OverrideRow | null;
  onChanged?: (list: OverrideRow[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of OVERRIDE_FIELDS) {
      const v = existing ? (existing[f.key] as number | null) : null;
      next[String(f.key)] = v === null || v === undefined ? '' : String(v);
    }
    setVals(next);
    setNote(existing?.note ?? '');
  }, [existing, open]);

  if (!card.scientificRepId) {
    return (
      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        لا يمكن إضافة معيار خاص لهذا الحساب — لا يوجد سجل «مندوب علمي» مرتبط به.
      </div>
    );
  }

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const body: Record<string, number | string | null> = { note };
      for (const f of OVERRIDE_FIELDS) {
        const raw = vals[String(f.key)];
        body[String(f.key)] = raw === '' ? null : (parseInt(raw) || 0);
      }
      const r = await fetch(`${API}/api/rep-followup/standards/override/${card.scientificRepId}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      onChanged?.(j.overrides ?? []);
      setMsg('✅ حُفظ — اضغط «احسب الآن» ليُطبَّق على أرقام هذا الشهر.');
    } catch (e: unknown) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : 'فشل الحفظ'}`);
    } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <div>
        <button className="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>
          ⚙️ {existing ? 'تعديل المعيار الخاص بهذا المندوب' : 'معيار خاص لهذا المندوب'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>معيار خاص — {card.repName}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
        اتركه فارغاً ليورث رقم المكتب. الصفر رقم مقصود ويختلف عن الفراغ.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {OVERRIDE_FIELDS.map(f => (
          <div className="form-group" key={String(f.key)}>
            <label className="form-label" style={{ fontSize: 11 }}>{f.label}</label>
            <input
              className="form-input" type="number" min={0} placeholder="المكتب"
              value={vals[String(f.key)] ?? ''}
              onChange={e => setVals(p => ({ ...p, [String(f.key)]: e.target.value }))}
            />
          </div>
        ))}
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label className="form-label" style={{ fontSize: 11 }}>سبب الاستثناء</label>
          <input className="form-input" value={note} placeholder="منطقة واسعة / مندوب جديد…"
            onChange={e => setNote(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}>{saving ? '⏳' : '💾 حفظ'}</button>
        <button className="btn btn--secondary btn--sm" onClick={() => setOpen(false)} disabled={saving}>إغلاق</button>
        {msg && <span style={{ fontSize: 11, fontWeight: 700 }}>{msg}</span>}
      </div>
    </div>
  );
}

function Fact({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: danger ? '#b91c1c' : '#0f172a' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function RepSelfView({ card }: { card: Card }) {
  const meta = STATUS_META[card.status] ?? STATUS_META.watch;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 28, fontWeight: 900, color: meta.color }}>{card.score}<span style={{ fontSize: 14, color: '#94a3b8' }}>/100</span></div>
        <span style={{ background: meta.bg, color: meta.color, borderRadius: 5, padding: '3px 12px', fontWeight: 800 }}>{meta.label}</span>
        <div style={{ fontSize: 12, color: '#64748b', marginRight: 'auto' }}>
          آخر تحديث: {new Date(card.computedAt).toLocaleString('ar-IQ-u-nu-latn')}
        </div>
      </div>
      <CardDetail card={card} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// تبويب المعايير — كل رقم يُحاسَب عليه المندوب يُضبط من هنا
// ════════════════════════════════════════════════════════════════════════════

const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const NUM_FIELDS: { key: keyof Standards; label: string; hint: string; group: string }[] = [
  { key: 'doctorVisitsPerDay', label: 'زيارات الأطباء في اليوم', hint: 'المتوقَّع اليومي — يُضرب بأيام العمل المنقضية', group: 'الزيارات' },
  { key: 'pharmacyVisitsPerDay', label: 'زيارات الصيدليات في اليوم', hint: 'نفس المنطق للصيدليات', group: 'الزيارات' },
  { key: 'workDaysPerMonth', label: 'أيام العمل الشهرية', hint: 'يُستعمل مرجعاً؛ الحساب الفعلي يستبعد أيام الراحة', group: 'الزيارات' },
  { key: 'doctorRevisitDays', label: 'كل كم يوم يُزار الطبيب', hint: 'الطبيب الذي تجاوزها يظهر كمتأخر في الملخّص اليومي', group: 'الزيارات' },
  { key: 'doctorCoverageTargetPct', label: 'تغطية الأطباء المطلوبة %', hint: 'نسبة أطباء السيرفي في مناطقه الذين يجب زيارتهم', group: 'التغطية' },
  { key: 'pharmacyCoverageTargetPct', label: 'تغطية الصيدليات المطلوبة %', hint: 'نفس المنطق للصيدليات', group: 'التغطية' },
  { key: 'areaIdleDays', label: 'منطقة مهجورة بعد (يوم)', hint: 'منطقة بلا أي زيارة خلال هذه المدة تظهر كتنبيه', group: 'التغطية' },
  { key: 'targetAchievementMinPct', label: 'أدنى تحقّق تارجت مقبول %', hint: 'خط النجاح — الوصول إليه = كامل درجة المبيع', group: 'المبيع' },
  { key: 'growthTargetPct', label: 'نمو شهر/شهر المطلوب %', hint: 'الوصول إليه = كامل درجة التطوّر', group: 'المبيع' },
];

const WEIGHT_FIELDS: { key: keyof Standards; label: string }[] = [
  { key: 'weightSales', label: 'المبيع/التارجت' },
  { key: 'weightVisits', label: 'الزيارات' },
  { key: 'weightCoverage', label: 'التغطية' },
  { key: 'weightGrowth', label: 'التطوّر' },
  { key: 'weightDiscipline', label: 'الانضباط' },
];

function StandardsTab({ standards, overrides, headers, onSaved, onOverridesChanged, tg, month, year, canUseDigest }: {
  standards: Standards;
  overrides: OverrideRow[];
  headers: Record<string, string>;
  onSaved: (s: Standards) => void;
  onOverridesChanged: (list: OverrideRow[]) => void;
  tg: TelegramStatus | null;
  month: number;
  year: number;
  canUseDigest?: boolean;
}) {
  const [form, setForm] = useState<Standards>(standards);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { setForm(standards); }, [standards]);

  const set = <K extends keyof Standards>(k: K, v: Standards[K]) => setForm(p => ({ ...p, [k]: v }));

  const rest = useMemo(() => new Set(String(form.restWeekdays ?? '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))), [form.restWeekdays]);
  const toggleRest = (d: number) => {
    const next = new Set(rest);
    if (next.has(d)) next.delete(d); else next.add(d);
    set('restWeekdays', [...next].sort().join(','));
  };

  const channels = useMemo(() => new Set(String(form.digestChannels ?? '').split(',').map(s => s.trim()).filter(Boolean)), [form.digestChannels]);
  const toggleChannel = (c: string) => {
    const next = new Set(channels);
    if (next.has(c)) next.delete(c); else next.add(c);
    set('digestChannels', [...next].join(',') || 'app');
  };

  const weightSum = WEIGHT_FIELDS.reduce((s, f) => s + (Number(form[f.key]) || 0), 0);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(`${API}/api/rep-followup/standards`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      onSaved(j.standards);
      setMsg('✅ حُفظت المعايير — اضغط «احسب الآن» في تبويب الفريق لتطبيقها على أرقام هذا الشهر.');
    } catch (e: unknown) {
      setMsg(`⚠️ ${e instanceof Error ? e.message : 'فشل الحفظ'}`);
    } finally { setSaving(false); }
  };

  const removeOverride = async (repId: number) => {
    const r = await fetch(`${API}/api/rep-followup/standards/override/${repId}`, { method: 'DELETE', headers });
    const j = await r.json();
    if (j.success) onOverridesChanged(j.overrides ?? []);
  };

  const groups = [...new Set(NUM_FIELDS.map(f => f.group))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!standards.isSaved && (
        <div className="info-banner">
          ℹ️ هذه القيم افتراضية ولم تُحفظ بعد. حفظها هو ما يُفعّل الحساب الليلي التلقائي لفريقك.
        </div>
      )}

      {groups.map(g => (
        <div className="card" key={g}>
          <div className="section-title">{g}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {NUM_FIELDS.filter(f => f.group === g).map(f => (
              <div className="form-group" key={String(f.key)}>
                <label className="form-label">{f.label}</label>
                <input
                  className="form-input" type="number" min={0}
                  value={String(form[f.key] ?? '')}
                  onChange={e => set(f.key, (parseInt(e.target.value) || 0) as never)}
                />
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{f.hint}</div>
              </div>
            ))}
          </div>
          {g === 'الزيارات' && (
            <div style={{ marginTop: 12 }}>
              <label className="form-label">أيام الراحة (تُستبعد من أيام العمل والأيام الضائعة)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {WEEKDAYS_AR.map((d, i) => (
                  <button
                    key={i} type="button"
                    className={`btn btn--sm ${rest.has(i) ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => toggleRest(i)}
                  >{d}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {/* الأوزان */}
      <div className="card">
        <div className="section-title">أوزان المؤشّر {weightSum !== 100 && <span style={{ color: '#b45309', fontSize: 12, fontWeight: 700 }}>(المجموع {weightSum} — يُفضَّل 100)</span>}</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 1.8 }}>
          العائلة التي لا بيانات لها (مثل مندوب بلا تارجت مُدخَل) تُستبعد من المقام تلقائياً فلا تُحتسب صفراً —
          المؤشّر يبقى عادلاً مهما كان المجموع.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          {WEIGHT_FIELDS.map(f => (
            <div className="form-group" key={String(f.key)}>
              <label className="form-label">{f.label}</label>
              <input className="form-input" type="number" min={0} max={100}
                value={String(form[f.key] ?? '')}
                onChange={e => set(f.key, (parseInt(e.target.value) || 0) as never)} />
            </div>
          ))}
        </div>
      </div>

      {/* الملخّص اليومي */}
      {canUseDigest && (
      <div className="card">
        <div className="section-title">الملخّص اليومي — «المدير الآلي»</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 1.8 }}>
          رسالة واحدة في اليوم لكل مندوب (وأخرى لك)، بأهم البنود فقط ومرتَّبة بالأهمية. الصيدليات المتأخرة عن
          الطلب لها تنبيهها المنفصل في Pharmacy Net ولا تُكرَّر هنا.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'end' }}>
          <div className="form-group">
            <label className="form-label">تشغيل الملخّص</label>
            <select className="form-input" value={form.digestEnabled ? '1' : '0'} onChange={e => set('digestEnabled', e.target.value === '1')}>
              <option value="0">معطّل</option>
              <option value="1">مفعّل</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">ساعة ملخّص المندوب</label>
            <select className="form-input" value={form.digestRepHour} onChange={e => set('digestRepHour', parseInt(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">ساعة ملخّص المدير</label>
            <select className="form-input" value={form.digestManagerHour} onChange={e => set('digestManagerHour', parseInt(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">أقصى عدد بنود في الرسالة</label>
            <input className="form-input" type="number" min={1} max={20} value={form.maxLinesPerDigest}
              onChange={e => set('maxLinesPerDigest', parseInt(e.target.value) || 1)} />
          </div>
          <div className="form-group">
            <label className="form-label">القنوات</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className={`btn btn--sm ${channels.has('app') ? 'btn--primary' : 'btn--secondary'}`} onClick={() => toggleChannel('app')}>داخل التطبيق</button>
              <button type="button" className={`btn btn--sm ${channels.has('telegram') ? 'btn--primary' : 'btn--secondary'}`} onClick={() => toggleChannel('telegram')}>تلكرام</button>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>تلكرام يُرسل لكروب الحساب المرتبط</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
          كل الأوقات بتوقيت بغداد. اللقطات تُحسب تلقائياً كل ليلة الساعة 03:00 لكل من حفظ معاييره.
        </div>

        {/* طلب التقرير من البوت — ميزة غير مكتشفة إن لم تُكتب هنا */}
        <div style={{ marginTop: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>🤖 اطلب التقرير من البوت بأي وقت</div>
          <div style={{ fontSize: 12, color: '#475569', lineHeight: 2 }}>
            اكتب في كروب تلكرام المربوط بحسابك:
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <code style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 5, padding: '4px 8px', width: 'fit-content' }}>متابعة محمد باقر</code>
              <code style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 5, padding: '4px 8px', width: 'fit-content' }}>متابعة محمد باقر شهر 9</code>
              <code style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 5, padding: '4px 8px', width: 'fit-content' }}>محمد باقر مبيع شهر 9</code>
            </div>
            <div style={{ marginTop: 6, color: '#64748b' }}>
              «متابعة/تقييم/مستوى» يعطي تقرير المتابعة، و«مبيع شهر N» يعطي المبيع والطلبيات.
              الشهر اختياري في المتابعة (الافتراضي: الشهر الحالي). المندوب يكتب «متابعتي» فيستلم تقييمه هو فقط.
            </div>
          </div>
        </div>

        {tg && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#475569', lineHeight: 1.9 }}>
            <b>الربط بتلكرام:</b> {tg.linkedCount} من {tg.totalCount} مندوباً مربوط ·{' '}
            حسابك {tg.managerLinked ? `مربوط (${tg.managerChats.join('، ') || 'كروب'})` : 'غير مربوط'}
            {tg.reps.some(r => !r.linked) && (
              <div style={{ color: '#92400e' }}>
                غير مربوطين: {tg.reps.filter(r => !r.linked).map(r => r.repName).join('، ')}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <DigestTester headers={headers} repUserId={null} month={month} year={year} />
        </div>
      </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? '⏳ جاري الحفظ…' : '💾 حفظ المعايير'}</button>
        <button className="btn btn--secondary" onClick={() => setForm(standards)} disabled={saving}>إلغاء التغييرات</button>
        {msg && <span style={{ fontSize: 12, fontWeight: 700 }}>{msg}</span>}
      </div>

      {/* الاستثناءات */}
      <div className="card">
        <div className="section-title">استثناءات لمندوبين معيّنين</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 1.8 }}>
          المندوب الجديد أو صاحب المنطقة الصعبة يُقاس بأرقامه هو. الاستثناء يُضاف من زرّ «معيار خاص» داخل صفّ
          المندوب في تبويب الفريق، والحقل المتروك فارغاً يورث رقم المكتب تلقائياً.
        </div>
        {overrides.length === 0 ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>لا استثناءات — كل الفريق يُقاس بأرقام المكتب.</div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>المندوب</th>
                  <th style={{ width: 110 }}>أطباء/يوم</th>
                  <th style={{ width: 110 }}>صيدليات/يوم</th>
                  <th style={{ width: 110 }}>تغطية %</th>
                  <th style={{ width: 110 }}>أدنى تحقّق %</th>
                  <th>السبب</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {overrides.map(o => (
                  <tr key={o.scientificRepId}>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.repName}</td>
                    <td>{o.doctorVisitsPerDay ?? '—'}</td>
                    <td>{o.pharmacyVisitsPerDay ?? '—'}</td>
                    <td>{o.doctorCoverageTargetPct ?? '—'}</td>
                    <td>{o.targetAchievementMinPct ?? '—'}</td>
                    <td style={{ textAlign: 'right', fontSize: 12, color: '#64748b' }}>{o.note ?? '—'}</td>
                    <td>
                      <button className="btn-icon btn-icon--red" title="حذف الاستثناء" onClick={() => removeOverride(o.scientificRepId)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
