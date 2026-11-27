// ════════════════════════════════════════════════════════════════════════════
// DailyLiquidationModal — زر «اللكوديشن اليومي» في الرئيسية.
//
// عرض مختصر ولطيف لمبيع اللكوديشن يوماً بيوم: شريط أيام الشهر (ارتفاع كل عمود = مبيع
// اليوم)، رقم اليوم الكبير، وبطاقة لكل محافظة. الضغط على محافظة يفتح مندوبيها وما باعوه.
// بالكمية فقط — الرئيسية بلا فلوس (طلب صريح).
//
// المصدر: GET /api/rep-sales/daily-liquidation?fileIds=&month= — نفس عمود اللكوديشن في
// «مندوبين المحافظات» بعرض العلميين (مبيعات المندوبين المؤكدة + ميركاتو + ملف اللكوديشن، بلا تكرار).
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const API = import.meta.env.VITE_API_URL || '';

interface LiqItem { name: string; qty: number }
interface LiqRep { name: string; qty: number; items: LiqItem[] }
interface LiqProv { name: string; qty: number; reps: LiqRep[] }
interface LiqDay { day: string; qty: number; provinces: LiqProv[] }

const cache = new Map<string, LiqDay[]>();

const AR_MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const PLAY_MS = 2600;

/** عدّاد يتحرّك من القيمة السابقة إلى الجديدة */
function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      const cur = a + (target - a) * e;
      from.current = cur;
      setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Count({ value, ms }: { value: number; ms?: number }) {
  return <>{fmt(useCountUp(value, ms))}</>;
}

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join(' ');

export default function DailyLiquidationModal({ fileKey, month, token, onClose, imageOf }: {
  fileKey: string; month: string; token: string | null; onClose: () => void;
  /** صورة معلم المحافظة (نفس صور لوحة المحافظات) */
  imageOf?: (province: string) => string | null;
}) {
  const key = `${fileKey}|${month}`;
  const [days, setDays] = useState<LiqDay[] | null>(cache.get(key) ?? null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [openProv, setOpenProv] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const hit = cache.get(key);
    setDays(hit ?? null);
    if (hit || !token || !month) return;
    const ac = new AbortController();
    setErr('');
    fetch(`${API}/api/rep-sales/daily-liquidation?${new URLSearchParams({ fileIds: fileKey, month })}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر تحميل اللكوديشن');
        cache.set(key, j.days ?? []);
        setDays(j.days ?? []);
      })
      .catch(e => { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل اللكوديشن'); });
    return () => ac.abort();
  }, [key, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // أيام الشهر كلها في الشريط (حتى اليوم إن كان الشهر الحالي) — الفارغة باهتة
  const strip = useMemo(() => {
    if (!month) return [];
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const now = new Date();
    const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
    const lastDataDay = Number(days?.[days.length - 1]?.day.slice(8, 10) ?? 0);
    const end = isCurrent ? Math.max(now.getDate(), lastDataDay) : last;
    const byDay = new Map((days ?? []).map(d => [d.day, d]));
    return Array.from({ length: Math.min(end, last) }, (_, i) => {
      const day = `${month}-${String(i + 1).padStart(2, '0')}`;
      return { day, n: i + 1, data: byDay.get(day) ?? null };
    });
  }, [month, days]);
  const withData = useMemo(() => strip.filter(s => s.data && s.data.qty > 0), [strip]);
  const maxDay = Math.max(1, ...strip.map(s => s.data?.qty ?? 0));
  const monthTotal = (days ?? []).reduce((t, d) => t + d.qty, 0);

  // الافتراضي: آخر يوم فيه مبيع
  useEffect(() => {
    if (!days) return;
    if (!sel || !strip.some(s => s.day === sel)) setSel(withData[withData.length - 1]?.day ?? strip[strip.length - 1]?.day ?? '');
  }, [days, strip, withData]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenProv(null); }, [sel]);

  const cur = strip.find(s => s.day === sel)?.data ?? null;
  const go = (dir: 1 | -1) => {
    const i = withData.findIndex(s => s.day === sel);
    const next = i < 0 ? withData[dir > 0 ? 0 : withData.length - 1] : withData[i + dir];
    if (next) setSel(next.day);
    return !!next;
  };

  // تشغيل تلقائي: يمرّ على أيام المبيع واحداً واحداً ويتوقف في آخرها
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setSel(s => {
        const i = withData.findIndex(x => x.day === s);
        const next = withData[i + 1];
        if (!next) { setPlaying(false); return s; }
        return next.day;
      });
    }, PLAY_MS);
    return () => clearInterval(t);
  }, [playing, withData]);
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    // من البداية إن كنّا على آخر يوم
    if (withData.length && withData[withData.length - 1].day === sel) setSel(withData[0].day);
    setPlaying(true);
  };

  // لوحة المفاتيح: Esc يغلق، والأسهم بنفس اتجاه اللوحة (الأيام اللاحقة يساراً)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') { setPlaying(false); go(1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setPlaying(false); go(-1); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // كل رسم — go يقرأ sel الحالي

  // الشريط يمرّر اليوم المختار إلى منتصفه
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.dl-day.is-sel');
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [sel]);

  const dateLabel = (day: string) => {
    const d = new Date(`${day}T12:00:00Z`);
    return `${AR_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${AR_MONTHS[d.getUTCMonth()]}`;
  };
  const monthLabel = month ? `${AR_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` : '';
  const repCount = cur ? new Set(cur.provinces.flatMap(p => p.reps.map(r => r.name))).size : 0;
  const provs = cur ? [...cur.provinces].sort((a, b) => Number(a.name === 'غير محدد') - Number(b.name === 'غير محدد') || b.qty - a.qty) : [];
  const dayMax = Math.max(1, ...provs.map(p => p.qty));

  return createPortal(
    <div className="dl-overlay" onClick={onClose}>
      <DlStyles />
      <div className="dl-panel" onClick={e => e.stopPropagation()} dir="rtl" role="dialog" aria-label="اللكوديشن اليومي">
        <div className="dl-head">
          <div className="dl-orbs" aria-hidden><span /><span /><span /></div>
          <div className="dl-title">
            <div className="dl-title-main">اللكوديشن اليومي</div>
            <div className="dl-title-sub">{monthLabel}{days && <> · مجموع الشهر <b><Count value={monthTotal} ms={1200} /></b> قطعة</>}</div>
          </div>
          <div className="dl-head-btns">
            {withData.length > 1 && (
              <button className={`dl-play ${playing ? 'is-on' : ''}`} onClick={togglePlay} title={playing ? 'إيقاف' : 'تشغيل الأيام تلقائياً'}>
                {playing ? '❚❚' : '▶'}
              </button>
            )}
            <button className="dl-close" onClick={onClose} aria-label="إغلاق">✕</button>
          </div>
        </div>

        {err && <div className="dl-msg">{err}</div>}
        {!days && !err && (
          <div className="dl-loading"><span /><span /><span /></div>
        )}

        {days && (
          <>
            <div className="dl-strip-wrap">
              <button className="dl-nav" onClick={() => { setPlaying(false); go(-1); }} aria-label="اليوم السابق">›</button>
              <div className="dl-strip" ref={stripRef}>
                {strip.map(s => {
                  const q = s.data?.qty ?? 0;
                  const h = q > 0 ? Math.max(8, (q / maxDay) * 100) : 0;
                  const wd = new Date(`${s.day}T12:00:00Z`).getUTCDay();
                  return (
                    <button key={s.day}
                      className={`dl-day ${s.day === sel ? 'is-sel' : ''} ${q > 0 ? '' : 'is-empty'} ${wd === 5 ? 'is-fri' : ''}`}
                      disabled={!(q > 0)} onClick={() => { setPlaying(false); setSel(s.day); }}
                      title={q > 0 ? `${dateLabel(s.day)} — ${fmt(q)} قطعة` : dateLabel(s.day)}>
                      <span className="dl-bar"><span style={{ height: `${h}%`, animationDelay: `${s.n * 18}ms` }} /></span>
                      <span className="dl-n">{s.n}</span>
                    </button>
                  );
                })}
              </div>
              <button className="dl-nav" onClick={() => { setPlaying(false); go(1); }} aria-label="اليوم التالي">‹</button>
            </div>
            {playing && <div className="dl-progress" key={`p-${sel}`} style={{ animationDuration: `${PLAY_MS}ms` }} />}

            {withData.length === 0 ? (
              <div className="dl-msg">لا يوجد مبيع لكوديشن في {monthLabel}.</div>
            ) : cur && (
              <div className="dl-body" key={sel}>
                <div className="dl-hero">
                  <div className="dl-hero-date">{dateLabel(sel)}</div>
                  <div className="dl-hero-num"><Count value={cur.qty} /> <small>قطعة</small></div>
                  <div className="dl-hero-meta">
                    <span>📍 {provs.length} {provs.length === 1 ? 'محافظة' : 'محافظات'}</span>
                    <span>👤 {repCount} {repCount === 1 ? 'مندوب' : 'مندوبين'}</span>
                  </div>
                </div>

                <div className="dl-grid">
                  {provs.map((p, i) => {
                    const open = openProv === p.name;
                    const img = imageOf?.(p.name);
                    const share = cur.qty > 0 ? Math.round((p.qty / cur.qty) * 100) : 0;
                    return (
                      <div key={p.name} className={`dl-card ${open ? 'is-open' : ''}`} style={{ animationDelay: `${i * 70}ms` }}>
                        <button className="dl-card-btn" onClick={() => setOpenProv(open ? null : p.name)}>
                          <span className="dl-card-img" style={img ? { backgroundImage: `url(${img})` } : undefined}>
                            <span className="dl-card-name">{p.name}</span>
                            {share > 0 && <span className="dl-card-share">{share}%</span>}
                          </span>
                          <span className="dl-card-body">
                            <span className="dl-card-qty"><Count value={p.qty} ms={1000 + i * 80} /> <small>قطعة</small></span>
                            <span className="dl-track"><span style={{ width: `${Math.max(3, (p.qty / dayMax) * 100)}%`, animationDelay: `${200 + i * 70}ms` }} /></span>
                            <span className="dl-avatars">
                              {p.reps.slice(0, 5).map(r => <span key={r.name} className="dl-av" title={r.name}>{initials(r.name)}</span>)}
                              {p.reps.length > 5 && <span className="dl-av is-more">+{p.reps.length - 5}</span>}
                              <span className="dl-chev">{open ? '▴' : '▾'}</span>
                            </span>
                          </span>
                        </button>
                        {open && (
                          <div className="dl-reps">
                            {p.reps.map((r, j) => (
                              <div key={r.name} className="dl-rep" style={{ animationDelay: `${j * 60}ms` }}>
                                <div className="dl-rep-head">
                                  <span className="dl-av">{initials(r.name)}</span>
                                  <span className="dl-rep-name">{r.name}</span>
                                  <span className="dl-rep-qty">{fmt(r.qty)}</span>
                                </div>
                                <div className="dl-chips">
                                  {r.items.map(it => (
                                    <span key={it.name} className={`dl-chip ${it.qty < 0 ? 'is-neg' : ''}`}>
                                      <span dir="ltr">{it.name}</span> <b>{fmt(it.qty)}</b>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function DlStyles() {
  return <style>{`
.dl-overlay { position: fixed; inset: 0; z-index: 1200; background: rgba(10,20,40,.45); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center; padding: 16px; animation: dl-fade .25s ease; }
.dl-panel { width: 100%; max-width: 1000px; max-height: calc(100vh - 32px); overflow: auto; background: #f6f8fc;
  border-radius: 24px; box-shadow: 0 30px 80px rgba(10,20,40,.35); animation: dl-rise .4s cubic-bezier(.2,.9,.3,1.2);
  color: var(--c-primary, #0f1e35); font-family: inherit; }
.dl-head { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 18px 22px; color: #fff; background: linear-gradient(120deg, #0f1e35 0%, #1a3a7a 55%, #1a56db 100%);
  position: sticky; top: 0; z-index: 3; }
.dl-orbs span { position: absolute; border-radius: 50%; filter: blur(2px); opacity: .35; pointer-events: none;
  background: radial-gradient(circle, rgba(147,197,253,.9), transparent 70%); animation: dl-float 9s ease-in-out infinite; }
.dl-orbs span:nth-child(1) { width: 140px; height: 140px; top: -50px; left: 8%; }
.dl-orbs span:nth-child(2) { width: 90px; height: 90px; bottom: -40px; left: 40%; animation-delay: -3s; animation-duration: 11s; }
.dl-orbs span:nth-child(3) { width: 60px; height: 60px; top: 10px; right: 45%; animation-delay: -6s; }
.dl-title { position: relative; }
.dl-title-main { font-size: 20px; font-weight: 800; }
.dl-title-sub { font-size: 12.5px; opacity: .85; margin-top: 2px; }
.dl-title-sub b { font-weight: 800; }
.dl-head-btns { position: relative; display: flex; gap: 8px; }
.dl-close, .dl-play { width: 36px; height: 36px; border-radius: 12px; border: 1px solid rgba(255,255,255,.25); cursor: pointer;
  background: rgba(255,255,255,.12); color: #fff; font-size: 15px; transition: background .2s, transform .2s; }
.dl-close:hover, .dl-play:hover { background: rgba(255,255,255,.25); transform: scale(1.06); }
.dl-play.is-on { background: #fff; color: #1a56db; }

.dl-strip-wrap { display: flex; align-items: stretch; gap: 6px; padding: 14px 14px 4px; }
.dl-nav { flex: 0 0 30px; border: 0; border-radius: 10px; background: #fff; box-shadow: 0 2px 8px rgba(15,30,53,.08);
  cursor: pointer; font-size: 20px; color: #1a56db; font-weight: 700; }
.dl-nav:hover { background: #eef3ff; }
.dl-strip { flex: 1; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; padding: 2px; }
.dl-strip::-webkit-scrollbar { display: none; }
.dl-day { flex: 1 0 24px; min-width: 24px; display: flex; flex-direction: column; align-items: center; gap: 4px; border: 0;
  background: none; cursor: pointer; padding: 4px 0; border-radius: 10px; font-family: inherit; transition: background .2s; }
.dl-day:hover:not(:disabled) { background: rgba(26,86,219,.07); }
.dl-day:disabled { cursor: default; }
.dl-bar { height: 54px; width: 12px; display: flex; align-items: flex-end; }
.dl-bar span { display: block; width: 100%; border-radius: 6px 6px 3px 3px; background: linear-gradient(180deg, #93c5fd, #60a5fa);
  transform-origin: bottom; animation: dl-grow .6s cubic-bezier(.2,.9,.3,1.2) both; transition: background .25s; }
.dl-day.is-empty .dl-bar { height: 54px; }
.dl-day.is-empty .dl-bar::after { content: ''; display: block; width: 100%; height: 3px; border-radius: 3px; background: rgba(15,30,53,.1); }
.dl-n { font-size: 11px; font-weight: 700; color: #64748b; }
.dl-day.is-fri .dl-n { color: #cbd5e1; }
.dl-day.is-sel .dl-bar span { background: linear-gradient(180deg, #1a56db, #0f1e35); box-shadow: 0 4px 14px rgba(26,86,219,.45); }
.dl-day.is-sel .dl-n { color: #fff; background: #1a56db; border-radius: 999px; padding: 0 6px; }
.dl-progress { height: 3px; margin: 2px 50px 0; border-radius: 3px; background: #1a56db; transform-origin: right;
  animation: dl-prog linear both; }

.dl-body { padding: 8px 18px 22px; }
.dl-hero { text-align: center; padding: 10px 0 16px; animation: dl-pop .5s cubic-bezier(.2,.9,.3,1.3) both; }
.dl-hero-date { font-size: 14px; font-weight: 700; color: #64748b; }
.dl-hero-num { font-size: 52px; font-weight: 900; line-height: 1.1; letter-spacing: -1px;
  background: linear-gradient(90deg, #0f1e35, #1a56db); -webkit-background-clip: text; background-clip: text; color: transparent; }
.dl-hero-num small { font-size: 16px; font-weight: 700; -webkit-text-fill-color: #64748b; }
.dl-hero-meta { display: flex; justify-content: center; gap: 10px; margin-top: 6px; font-size: 13px; font-weight: 700; }
.dl-hero-meta span { background: #fff; border-radius: 999px; padding: 4px 12px; box-shadow: 0 2px 8px rgba(15,30,53,.06); }

.dl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
.dl-card { background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 4px 16px rgba(15,30,53,.07);
  animation: dl-card-in .55s cubic-bezier(.2,.9,.3,1.2) both; transition: transform .25s, box-shadow .25s; }
.dl-card:hover { transform: translateY(-4px); box-shadow: 0 12px 28px rgba(15,30,53,.14); }
.dl-card.is-open { grid-column: 1 / -1; transform: none; }
.dl-card-btn { display: block; width: 100%; border: 0; background: none; padding: 0; cursor: pointer; text-align: inherit; font-family: inherit; color: inherit; }
.dl-card-img { position: relative; display: flex; align-items: flex-end; justify-content: space-between; height: 82px; padding: 10px 12px;
  background: linear-gradient(120deg, #1a3a7a, #1a56db) center/cover; overflow: hidden; }
.dl-card-img::before { content: ''; position: absolute; inset: 0; background: linear-gradient(0deg, rgba(10,20,40,.75), rgba(10,20,40,.05)); }
.dl-card-img[style] { transition: background-size .6s; }
.dl-card:hover .dl-card-img[style] { background-size: 112%; }
.dl-card-name { position: relative; color: #fff; font-size: 18px; font-weight: 800; text-shadow: 0 2px 8px rgba(0,0,0,.4); }
.dl-card-share { position: relative; color: #fff; font-size: 12px; font-weight: 800; background: rgba(255,255,255,.2);
  backdrop-filter: blur(4px); border-radius: 999px; padding: 2px 8px; }
.dl-card-body { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.dl-card-qty { font-size: 24px; font-weight: 900; color: #1a56db; }
.dl-card-qty small { font-size: 12px; font-weight: 700; color: #64748b; }
.dl-track { height: 6px; border-radius: 6px; background: #eef2f8; overflow: hidden; }
.dl-track span { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, #60a5fa, #1a56db);
  transform-origin: right; animation: dl-fill .9s cubic-bezier(.2,.9,.3,1) both; }
.dl-avatars { display: flex; align-items: center; }
.dl-av { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 800; color: #1a56db; background: #eaf1ff; border: 2px solid #fff; margin-inline-start: -6px; flex: 0 0 auto; }
.dl-av:first-child { margin-inline-start: 0; }
.dl-av.is-more { background: #0f1e35; color: #fff; }
.dl-chev { margin-inline-start: auto; color: #94a3b8; font-size: 13px; }

.dl-reps { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; padding: 0 12px 14px; }
.dl-rep { background: #f6f8fc; border-radius: 14px; padding: 10px; animation: dl-card-in .45s ease both; }
.dl-rep-head { display: flex; align-items: center; gap: 8px; }
.dl-rep-head .dl-av { margin: 0; border: 0; }
.dl-rep-name { font-weight: 800; font-size: 14px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-rep-qty { font-weight: 900; color: #1a56db; }
.dl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dl-chip { font-size: 12px; background: #fff; border: 1px solid #e3e9f4; border-radius: 999px; padding: 3px 10px; }
.dl-chip b { color: #1a56db; margin-inline-start: 4px; }
.dl-chip.is-neg b { color: #dc2626; }

.dl-msg { text-align: center; padding: 40px 16px; color: #64748b; font-weight: 600; }
.dl-loading { display: flex; justify-content: center; gap: 8px; padding: 60px 0; }
.dl-loading span { width: 12px; height: 12px; border-radius: 50%; background: #1a56db; animation: dl-bounce 1s ease-in-out infinite; }
.dl-loading span:nth-child(2) { animation-delay: .15s; }
.dl-loading span:nth-child(3) { animation-delay: .3s; }

@keyframes dl-fade { from { opacity: 0; } }
@keyframes dl-rise { from { opacity: 0; transform: translateY(30px) scale(.96); } }
@keyframes dl-pop { from { opacity: 0; transform: scale(.85); } }
@keyframes dl-card-in { from { opacity: 0; transform: translateY(18px) scale(.95); } }
@keyframes dl-grow { from { transform: scaleY(0); } }
@keyframes dl-fill { from { transform: scaleX(0); } }
@keyframes dl-prog { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes dl-bounce { 0%, 100% { transform: translateY(0); opacity: .5; } 50% { transform: translateY(-12px); opacity: 1; } }
@keyframes dl-float { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(24px, 12px); } }

@media (max-width: 640px) {
  .dl-overlay { padding: 0; align-items: stretch; }
  .dl-panel { max-height: 100vh; border-radius: 0; }
  .dl-head { padding: 14px 16px; }
  .dl-hero-num { font-size: 40px; }
  .dl-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
  .dl-card-name { font-size: 15px; }
  .dl-card-qty { font-size: 19px; }
  .dl-body { padding: 6px 12px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .dl-overlay *, .dl-overlay { animation-duration: .01ms !important; transition: none !important; }
}
`}</style>;
}
