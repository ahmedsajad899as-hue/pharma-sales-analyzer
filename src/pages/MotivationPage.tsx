// ════════════════════════════════════════════════════════════════════════════
// MotivationPage — «التحفيز»: سباق المندوبين نحو التارگت + الأوسمة + منصّة التتويج.
//
// • المصدر: GET /api/rep-followup/race (server/modules/rep-followup/race.js) —
//   يقرأ لقطات «متابعة المندوبين» الجاهزة، فلا رقم هنا يخالف تلك الصفحة.
// • المندوب يرى زملاء فريقه بالنسب والأوسمة فقط (بلا قيم مالية).
// • الاحتفال (confetti) مرة واحدة لكل وسام جديد على هذا المتصفح — يُحفظ ما رآه.
// • كل الحركات CSS/canvas خفيفة بلا مكتبات، وتُطفأ مع prefers-reduced-motion.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

interface RaceRep {
  repUserId: number; repName: string; company: string | null; score: number; status: string;
  achievementPct: number | null; projectedPct: number | null; targetTotal: number; achieved: number;
  orderCount: number; growthPct: number | null; doctorVisits: number; newDoctors: number;
  firstOrderAt: string | null; badges: string[];
}
interface PodiumRow { repUserId: number; repName: string; achievementPct: number }
interface RaceData {
  periodKey: string; month: number; year: number; isCurrentMonth: boolean;
  monthProgressPct: number | null; computedAt: string | null; canRecompute: boolean; me: number;
  reps: RaceRep[]; podium: PodiumRow[]; prevPodium: PodiumRow[]; prevPeriodKey: string;
}

const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const monthLabel = (key: string) => { const [y, m] = key.split('-').map(Number); return `${AR_MONTHS[m - 1]} ${y}`; };
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

const BADGES: Record<string, { icon: string; label: string; desc: string }> = {
  target:     { icon: '🎯', label: 'محقق التارگت',            desc: 'وصل 100% من تارگت الشهر' },
  streak3:    { icon: '🔥', label: 'محقق التارگت 3 أشهر',     desc: 'حقق التارگت ثلاثة أشهر متتالية' },
  firstOrder: { icon: '⚡', label: 'أول طلبية بالشهر',         desc: 'أول مندوب سجّل طلبية بهذا الشهر' },
  newDoctors: { icon: '🩺', label: '10 أطباء جدد',             desc: 'زار 10 أطباء أو أكثر لأول مرة بهذا الشهر' },
  topGrowth:  { icon: '🚀', label: 'أعلى نمو',                 desc: 'أعلى نسبة نمو بالمبيع عن الشهر السابق' },
  topVisits:  { icon: '👟', label: 'ملك الزيارات',             desc: 'أكثر عدد زيارات أطباء بالشهر' },
};

/** لون التقدّم: أحمر → برتقالي → أزرق → ذهبي عند التحقيق */
const pctColor = (p: number | null) =>
  p === null ? '#94a3b8' : p >= 100 ? '#d97706' : p >= 80 ? '#2563eb' : p >= 50 ? '#f59e0b' : '#ef4444';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── confetti خفيف على canvas — بلا مكتبة ────────────────────────────────────
function fireConfetti(durationMs = 2600) {
  if (reducedMotion()) return;
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  if (!ctx) { c.remove(); return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = window.innerWidth * dpr; c.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = window.innerWidth, H = window.innerHeight;
  const colors = ['#f59e0b', '#2563eb', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#facc15'];
  const parts = Array.from({ length: Math.min(180, Math.round(W / 6)) }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    s: 5 + Math.random() * 6, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    col: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  const tick = (t: number) => {
    const el = t - t0;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - el / durationMs);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.col; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (el < durationMs) requestAnimationFrame(tick); else c.remove();
  };
  requestAnimationFrame(tick);
}

const SEEN_KEY = 'motivation-seen-v1';
const loadSeen = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } };
const saveSeen = (s: Set<string>) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-400))); } catch { /* تخزين غير متاح */ } };

/** يُرجع true بعد إطار واحد — لتحريك الأشرطة والحلقات من الصفر إلى قيمتها. */
function useMounted(dep: unknown) {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(false); const id = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true))); return () => cancelAnimationFrame(id); }, [dep]);
  return on;
}

/** عدّاد يصعد من 0 إلى القيمة */
function CountUp({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (reducedMotion()) { setV(value); return; }
    let raf = 0; const t0 = performance.now(); const D = 1100;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / D); setV(value * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{Math.round(v).toLocaleString('en-US')}{suffix}</>;
}

// ── حلقة التارگت ───────────────────────────────────────────────────────────
function TargetRing({ rep, isMe, animate }: { rep: RaceRep; isMe: boolean; animate: boolean }) {
  const p = rep.achievementPct;
  const R = 46, C = 2 * Math.PI * R;
  const shown = p === null ? 0 : Math.min(100, p);
  const done = p !== null && p >= 100;
  const col = pctColor(p);
  return (
    <div className={`mv-ring-card ${done ? 'is-done' : ''} ${isMe ? 'is-me' : ''}`}>
      <div className={`mv-ring ${done && animate ? 'mv-shake' : ''}`}>
        <svg viewBox="0 0 110 110" width="110" height="110">
          <defs>
            <linearGradient id={`g${rep.repUserId}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={col} stopOpacity="0.65" />
              <stop offset="100%" stopColor={col} />
            </linearGradient>
          </defs>
          <circle cx="55" cy="55" r={R} fill="none" stroke="var(--mv-track)" strokeWidth="10" />
          <circle cx="55" cy="55" r={R} fill="none" stroke={`url(#g${rep.repUserId})`} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={animate ? C * (1 - shown / 100) : C}
            transform="rotate(-90 55 55)" style={{ transition: 'stroke-dashoffset 1.3s cubic-bezier(.2,.8,.2,1)' }} />
        </svg>
        <div className="mv-ring-val" style={{ color: col }}>
          {p === null ? <span className="mv-muted">—</span> : <>{animate ? <CountUp value={p} /> : 0}<small>%</small></>}
          {done && <span className="mv-ring-party">🎉</span>}
        </div>
      </div>
      <div className="mv-ring-name">{rep.repName}{isMe && <span className="mv-me-tag">أنت</span>}</div>
      <div className="mv-ring-sub">
        {p === null ? 'بلا تارگت لهذا الشهر' : `${fmt(rep.achieved)} / ${fmt(rep.targetTotal)} قطعة`}
      </div>
      {rep.badges.length > 0 && (
        <div className="mv-ring-badges">
          {rep.badges.map(b => <span key={b} className="mv-badge-dot" title={`${BADGES[b]?.label} — ${BADGES[b]?.desc}`}>{BADGES[b]?.icon}</span>)}
        </div>
      )}
    </div>
  );
}

// ── منصّة التتويج ──────────────────────────────────────────────────────────
function Podium({ rows, title, big }: { rows: PodiumRow[]; title: string; big?: boolean }) {
  const on = useMounted(rows.map(r => r.repUserId).join(','));
  if (!rows.length) return null;
  // ترتيب المنصّة البصري: الثاني · الأول · الثالث
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as PodiumRow[];
  const meta = (r: PodiumRow) => {
    const i = rows.indexOf(r);
    return [{ medal: '🥇', h: 100, cls: 'gold' }, { medal: '🥈', h: 72, cls: 'silver' }, { medal: '🥉', h: 52, cls: 'bronze' }][i];
  };
  return (
    <div className={`mv-podium ${big ? 'is-big' : ''}`}>
      <div className="mv-podium-title">{title}</div>
      <div className="mv-podium-row">
        {order.map(r => {
          const m = meta(r);
          return (
            <div key={r.repUserId} className="mv-podium-col">
              <div className="mv-podium-medal">{m.medal}</div>
              <div className="mv-podium-name">{r.repName}</div>
              <div className="mv-podium-pct">{r.achievementPct}%</div>
              <div className={`mv-podium-block ${m.cls}`} style={{ height: on ? (big ? m.h * 1.3 : m.h) : 0 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MotivationPage() {
  const { token, user } = useAuth();
  const now = new Date();
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [period, setPeriod] = useState(months[0]);
  const [data, setData] = useState<RaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [recomputing, setRecomputing] = useState(false);
  const celebrated = useRef<string>('');

  const load = useCallback(async () => {
    if (!token) return;
    const [y, m] = period.split('-').map(Number);
    setLoading(true); setErr('');
    try {
      const j = await fetch(`${API}/api/rep-followup/race?month=${m}&year=${y}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'تعذّر التحميل');
      setData(j);
    } catch (e: any) { setErr(e.message || 'تعذّر التحميل'); setData(null); }
    finally { setLoading(false); }
  }, [token, period]);
  useEffect(() => { load(); }, [load]);

  const recompute = async () => {
    const [y, m] = period.split('-').map(Number);
    setRecomputing(true); setErr('');
    try {
      const j = await fetch(`${API}/api/rep-followup/recompute`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: m, year: y }),
      }).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'تعذّر الحساب');
      await load();
    } catch (e: any) { setErr(e.message || 'تعذّر الحساب'); }
    finally { setRecomputing(false); }
  };

  const animate = useMounted(data?.periodKey ?? '');

  // احتفال مرة واحدة لكل وسام جديد (أو منصّة شهر منتهٍ) على هذا المتصفح
  useEffect(() => {
    if (!data || celebrated.current === data.periodKey) return;
    celebrated.current = data.periodKey;
    const seen = loadSeen();
    const isRep = user?.role === 'scientific_rep';
    const fresh: string[] = [];
    for (const r of data.reps) {
      if (isRep && r.repUserId !== data.me) continue; // المندوب يحتفل بأوسمته هو
      for (const b of r.badges) {
        const k = `${data.periodKey}:${r.repUserId}:${b}`;
        if (!seen.has(k)) { fresh.push(k); seen.add(k); }
      }
    }
    if (data.podium.length) {
      const k = `${data.periodKey}:podium`;
      if (!seen.has(k)) { fresh.push(k); seen.add(k); }
    }
    if (fresh.length) { saveSeen(seen); window.setTimeout(() => fireConfetti(), 900); }
  }, [data, user?.role]);

  const withTarget = data?.reps.filter(r => r.achievementPct !== null) ?? [];
  const noTarget = data?.reps.filter(r => r.achievementPct === null) ?? [];
  const leader = withTarget[0];
  const badgeHolders = useMemo(() => {
    const map = new Map<string, RaceRep[]>();
    for (const r of data?.reps ?? []) for (const b of r.badges) { if (!map.has(b)) map.set(b, []); map.get(b)!.push(r); }
    return map;
  }, [data]);
  // سلّم السباق: 0..120% — خط النهاية عند 100
  const SCALE = 120;
  const pos = (p: number) => `${Math.max(0, Math.min(SCALE, p)) / SCALE * 100}%`;

  return (
    <div className="mv-page" dir="rtl">
      <style>{CSS}</style>

      <div className="mv-head">
        <div>
          <h2 className="mv-title">🏆 التحفيز</h2>
          <div className="mv-muted">سباق التارگت والأوسمة — {data?.isCurrentMonth ? 'مباشر لهذا الشهر' : 'نتيجة نهائية'}</div>
        </div>
        <div className="mv-head-tools">
          <select className="form-input mv-select" value={period} onChange={e => setPeriod(e.target.value)}>
            {months.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </select>
          {data?.canRecompute && (
            <button type="button" className="btn btn-primary mv-btn" disabled={recomputing} onClick={recompute}
              title="يعيد حساب لقطات المندوبين لهذا الشهر (قد يستغرق دقيقة)">
              {recomputing ? '⏳ جاري الحساب…' : '🔄 احسب الآن'}
            </button>
          )}
        </div>
      </div>
      {data?.computedAt && <div className="mv-muted mv-small">آخر تحديث للأرقام: {new Date(data.computedAt).toLocaleString('ar-IQ')}</div>}
      {err && <div className="mv-err">{err}</div>}
      {loading && !data && <div className="mv-muted mv-center">جاري التحميل…</div>}

      {data && data.reps.length === 0 && (
        <div className="mv-empty">
          <div style={{ fontSize: 42 }}>🏁</div>
          <div>لا توجد أرقام محسوبة لهذا الشهر بعد.</div>
          <div className="mv-muted mv-small">
            {data.canRecompute ? 'اضغط «احسب الآن» لحساب أرقام المندوبين — أو انتظر الحساب التلقائي الليلي.' : 'الأرقام تُحسب تلقائياً كل ليلة — ارجع لاحقاً.'}
          </div>
        </div>
      )}

      {data && data.reps.length > 0 && (
        <>
          {/* ── المنصّة ── */}
          {!data.isCurrentMonth && data.podium.length > 0 && <Podium rows={data.podium} title={`🏆 أبطال ${monthLabel(data.periodKey)}`} big />}

          {/* ── شريط عناوين سريع ── */}
          <div className="mv-kpis">
            <div className="mv-kpi"><span>🏃 المتسابقون</span><b><CountUp value={data.reps.length} /></b></div>
            <div className="mv-kpi"><span>🎯 حققوا التارگت</span><b><CountUp value={withTarget.filter(r => (r.achievementPct ?? 0) >= 100).length} /></b></div>
            {data.isCurrentMonth && data.monthProgressPct != null && <div className="mv-kpi"><span>📅 مضى من الشهر</span><b><CountUp value={data.monthProgressPct} suffix="%" /></b></div>}
            {leader && <div className="mv-kpi is-lead"><span>👑 المتصدّر</span><b>{leader.repName}</b></div>}
          </div>

          {/* ── سباق المندوبين ── */}
          <section className="mv-card">
            <div className="mv-card-title">🏁 سباق التارگت</div>
            {withTarget.length === 0 ? (
              <div className="mv-muted">لا يوجد تارگت مُدخَل لهذا الشهر — أدخله من صفحة التارگت ليبدأ السباق.</div>
            ) : (
              <div className="mv-race">
                {withTarget.map((r, i) => {
                  const p = r.achievementPct ?? 0;
                  const isMe = r.repUserId === data.me;
                  return (
                    <div key={r.repUserId} className={`mv-lane ${isMe ? 'is-me' : ''}`}>
                      <div className="mv-lane-rank">{i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</div>
                      <div className="mv-lane-name" title={r.company ?? ''}>{r.repName}{isMe && <span className="mv-me-tag">أنت</span>}</div>
                      <div className="mv-track">
                        <div className="mv-track-fill" style={{ width: animate ? pos(p) : 0, background: pctColor(p) }} />
                        {data.isCurrentMonth && data.monthProgressPct != null && (
                          <div className="mv-pace" style={{ insetInlineStart: pos(data.monthProgressPct) }} title={`المفروض تكون هنا اليوم (${data.monthProgressPct}%)`} />
                        )}
                        {data.isCurrentMonth && r.projectedPct != null && r.projectedPct > p && (
                          <div className="mv-ghost" style={{ insetInlineStart: pos(r.projectedPct) }} title={`المتوقّع بنهاية الشهر بنفس السرعة: ${r.projectedPct}%`} />
                        )}
                        <div className="mv-finish" style={{ insetInlineStart: pos(100) }}>🏁</div>
                        <div className={`mv-runner ${p >= 100 ? 'is-won' : ''}`} style={{ insetInlineStart: animate ? pos(p) : 0 }}>
                          {p >= 100 ? '🏆' : '🏃'}
                        </div>
                      </div>
                      <div className="mv-lane-pct" style={{ color: pctColor(p) }}>{p}%</div>
                      <div className="mv-lane-badges">{r.badges.map(b => <span key={b} title={BADGES[b]?.label}>{BADGES[b]?.icon}</span>)}</div>
                    </div>
                  );
                })}
                <div className="mv-legend">
                  <span><i className="mv-lg-pace" /> المفروض تكون هنا اليوم</span>
                  <span><i className="mv-lg-ghost" /> المتوقّع بنهاية الشهر بنفس السرعة</span>
                  <span>🏁 خط التارگت 100%</span>
                </div>
              </div>
            )}
          </section>

          {/* ── عدّادات التارگت ── */}
          <section className="mv-card">
            <div className="mv-card-title">⭕ عدّادات التارگت</div>
            <div className="mv-rings">
              {[...withTarget, ...noTarget].map(r => <TargetRing key={r.repUserId} rep={r} isMe={r.repUserId === data.me} animate={animate} />)}
            </div>
          </section>

          {/* ── الأوسمة ── */}
          <section className="mv-card">
            <div className="mv-card-title">🎖️ الأوسمة والإنجازات</div>
            <div className="mv-badges">
              {Object.entries(BADGES).map(([k, b]) => {
                const holders = badgeHolders.get(k) ?? [];
                return (
                  <div key={k} className={`mv-badge ${holders.length ? 'is-earned' : ''}`}>
                    <div className="mv-badge-icon">{b.icon}</div>
                    <div className="mv-badge-body">
                      <div className="mv-badge-label">{b.label}</div>
                      <div className="mv-muted mv-small">{b.desc}</div>
                      <div className="mv-badge-holders">
                        {holders.length ? holders.map(h => <span key={h.repUserId} className={h.repUserId === data.me ? 'is-me' : ''}>{h.repName}</span>) : <span className="mv-muted">لم يُحرَز بعد</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {data.isCurrentMonth && data.prevPodium.length > 0 && (
            <Podium rows={data.prevPodium} title={`🏆 أبطال ${monthLabel(data.prevPeriodKey)}`} />
          )}
        </>
      )}
    </div>
  );
}

const CSS = `
.mv-page { --mv-track: #e2e8f0; padding: 16px; max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.mv-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mv-title { margin: 0; font-size: 22px; font-weight: 900; }
.mv-head-tools { display: flex; gap: 8px; align-items: center; }
.mv-select { height: 36px; min-width: 160px; }
.mv-btn { height: 36px; padding: 0 14px; white-space: nowrap; }
.mv-muted { color: var(--c-text-secondary, #64748b); }
.mv-small { font-size: 11.5px; }
.mv-center { text-align: center; padding: 30px 0; }
.mv-err { color: var(--c-danger, #dc2626); font-weight: 700; }
.mv-empty { text-align: center; padding: 40px 16px; background: var(--c-surface, #fff); border: 1px dashed var(--c-border, #cbd5e1); border-radius: 16px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.mv-card { background: var(--c-surface, #fff); border: 1px solid var(--c-border-light, #e2e8f0); border-radius: 16px; padding: 14px 16px; box-shadow: 0 2px 10px rgba(15,30,53,.05); }
.mv-card-title { font-weight: 900; font-size: 15px; margin-bottom: 12px; }
.mv-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.mv-kpi { background: var(--c-surface, #fff); border: 1px solid var(--c-border-light, #e2e8f0); border-radius: 14px; padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; }
.mv-kpi span { font-size: 12px; color: var(--c-text-secondary, #64748b); }
.mv-kpi b { font-size: 22px; font-weight: 900; }
.mv-kpi.is-lead { background: linear-gradient(135deg, #fffbeb, #fef3c7); border-color: #fcd34d; }
.mv-kpi.is-lead b { font-size: 16px; color: #92400e; }
.mv-me-tag { margin-inline-start: 6px; font-size: 10px; background: var(--c-accent, #1a56db); color: #fff; border-radius: 999px; padding: 1px 7px; vertical-align: middle; }

/* السباق */
.mv-race { display: flex; flex-direction: column; gap: 10px; }
.mv-lane { display: grid; grid-template-columns: 34px minmax(90px, 160px) 1fr 52px auto; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 12px; }
.mv-lane.is-me { background: var(--c-accent-light, #eff6ff); box-shadow: inset 0 0 0 1.5px var(--c-accent, #1a56db); }
.mv-lane-rank { font-size: 18px; text-align: center; font-weight: 900; color: var(--c-text-secondary, #64748b); }
.mv-lane-name { font-weight: 800; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-track { position: relative; height: 30px; background: var(--mv-track); border-radius: 999px; overflow: visible; }
.mv-track-fill { position: absolute; inset-block: 9px; inset-inline-start: 0; border-radius: 999px; opacity: .85; transition: width 1.4s cubic-bezier(.2,.8,.2,1); }
.mv-runner { position: absolute; top: 50%; transform: translate(50%, -55%); font-size: 22px; transition: inset-inline-start 1.4s cubic-bezier(.2,.8,.2,1); filter: drop-shadow(0 2px 2px rgba(0,0,0,.25)); }
.mv-runner.is-won { transform: translate(50%, -55%); animation: mvBounce 1s ease-in-out infinite; }
.mv-finish { position: absolute; top: -6px; transform: translateX(50%); font-size: 16px; }
.mv-finish::after { content: ''; position: absolute; top: 20px; left: 50%; width: 2px; height: 22px; background: repeating-linear-gradient(#0f172a 0 4px, #fff 4px 8px); }
.mv-pace { position: absolute; top: -3px; bottom: -3px; width: 3px; transform: translateX(50%); background: #0f172a; border-radius: 2px; opacity: .55; }
.mv-ghost { position: absolute; top: 50%; width: 14px; height: 14px; transform: translate(50%, -50%); border-radius: 50%; border: 2px dashed #64748b; opacity: .7; }
.mv-lane-pct { font-weight: 900; font-size: 15px; text-align: center; }
.mv-lane-badges { display: flex; gap: 2px; font-size: 16px; min-width: 20px; }
.mv-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; color: var(--c-text-secondary, #64748b); padding-top: 4px; }
.mv-legend i { display: inline-block; vertical-align: middle; margin-inline-end: 4px; }
.mv-lg-pace { width: 3px; height: 12px; background: #0f172a; opacity: .55; }
.mv-lg-ghost { width: 10px; height: 10px; border-radius: 50%; border: 2px dashed #64748b; }

/* الحلقات */
.mv-rings { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.mv-ring-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 8px; border-radius: 14px; border: 1px solid var(--c-border-light, #e2e8f0); background: var(--c-bg, #f8fafc); }
.mv-ring-card.is-done { background: linear-gradient(160deg, #fffbeb, #fef3c7); border-color: #fcd34d; }
.mv-ring-card.is-me { box-shadow: 0 0 0 2px var(--c-accent, #1a56db); }
.mv-ring { position: relative; width: 110px; height: 110px; }
.mv-ring-val { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 900; }
.mv-ring-val small { font-size: 13px; }
.mv-ring-party { position: absolute; top: -4px; right: -4px; font-size: 22px; animation: mvBounce 1.1s ease-in-out infinite; }
.mv-ring-name { font-weight: 800; font-size: 13px; text-align: center; }
.mv-ring-sub { font-size: 11px; color: var(--c-text-secondary, #64748b); }
.mv-ring-badges { display: flex; gap: 3px; font-size: 16px; }
.mv-badge-dot { cursor: help; }
.mv-shake { animation: mvShake .7s ease-in-out 1.4s 2; }

/* الأوسمة */
.mv-badges { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.mv-badge { display: flex; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--c-border-light, #e2e8f0); background: var(--c-bg, #f8fafc); filter: grayscale(.85); opacity: .7; }
.mv-badge.is-earned { filter: none; opacity: 1; background: linear-gradient(135deg, #f5f3ff, #ede9fe); border-color: #c4b5fd; }
.mv-badge-icon { font-size: 30px; line-height: 1; }
.mv-badge.is-earned .mv-badge-icon { animation: mvPop .6s cubic-bezier(.34,1.56,.64,1); }
.mv-badge-label { font-weight: 900; font-size: 13.5px; }
.mv-badge-holders { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; font-size: 11.5px; }
.mv-badge-holders span:not(.mv-muted) { background: #fff; border: 1px solid #c4b5fd; border-radius: 999px; padding: 1px 8px; font-weight: 700; color: #5b21b6; }
.mv-badge-holders span.is-me { background: var(--c-accent, #1a56db); color: #fff; border-color: transparent; }

/* المنصّة */
.mv-podium { background: radial-gradient(120% 90% at 50% 0%, #fef3c7 0%, var(--c-surface, #fff) 60%); border: 1px solid #fde68a; border-radius: 18px; padding: 14px 12px 0; overflow: hidden; }
.mv-podium-title { text-align: center; font-weight: 900; font-size: 16px; color: #92400e; }
.mv-podium-row { display: flex; justify-content: center; align-items: flex-end; gap: 10px; margin-top: 10px; }
.mv-podium-col { display: flex; flex-direction: column; align-items: center; width: min(30%, 150px); }
.mv-podium-medal { font-size: 30px; animation: mvPop .7s cubic-bezier(.34,1.56,.64,1); }
.mv-podium.is-big .mv-podium-medal { font-size: 40px; }
.mv-podium-name { font-weight: 900; font-size: 13px; text-align: center; }
.mv-podium-pct { font-weight: 800; font-size: 12px; color: #b45309; margin-bottom: 4px; }
.mv-podium-block { width: 100%; border-radius: 10px 10px 0 0; transition: height 1.1s cubic-bezier(.2,.8,.2,1); }
.mv-podium-block.gold { background: linear-gradient(#fcd34d, #d97706); }
.mv-podium-block.silver { background: linear-gradient(#e2e8f0, #94a3b8); }
.mv-podium-block.bronze { background: linear-gradient(#fdba74, #c2410c); }

@keyframes mvBounce { 0%,100% { translate: 0 0; } 50% { translate: 0 -5px; } }
@keyframes mvShake { 0%,100% { transform: rotate(0); } 20% { transform: rotate(-6deg); } 40% { transform: rotate(6deg); } 60% { transform: rotate(-4deg); } 80% { transform: rotate(4deg); } }
@keyframes mvPop { from { transform: scale(.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .mv-page * { animation: none !important; transition: none !important; } }
@media (max-width: 640px) {
  .mv-lane { grid-template-columns: 26px 1fr 46px; grid-template-areas: 'r n p' 't t t' 'b b b'; row-gap: 4px; }
  .mv-lane-rank { grid-area: r; } .mv-lane-name { grid-area: n; } .mv-lane-pct { grid-area: p; }
  .mv-track { grid-area: t; } .mv-lane-badges { grid-area: b; }
}
`;
