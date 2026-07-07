import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

// ─── Types ───────────────────────────────────────────────────
interface Doctor { id: number; name: string; specialty?: string | null; pharmacyName?: string | null; area?: { id: number; name: string } | null; areaId?: number | null; }
interface Area { id: number; name: string; }
interface Item { id: number; name: string; }
interface Entry {
  id: number; entryType: 'doctor' | 'pharmacy'; doctorId: number | null; pharmacyName: string | null;
  areaId: number | null; status: 'planned' | 'visited' | 'postponed';
  postponeReason: string | null; postponeNote: string | null; postponeToDate: string | null; autoPostponed: boolean;
  isNewDoctor: boolean; createdAt: string;
  addedByManager: boolean; addedByName: string | null;
  doctor?: { id: number; name: string; specialty?: string | null; pharmacyName?: string | null } | null;
  area?: { id: number; name: string } | null; currentFeedback?: string | null;
  itemId: number | null; item?: { id: number; name: string } | null;
}
interface Achievement { total: number; visited: number; postponed: number; planned: number; percent: number; visitedNames: string[]; pendingNames: string[]; }
interface Quota { required: number; planned: number; visited: number; }
interface Settings { repeatWindowDays: number; repeatThreshold: number; alertOnRepeatAfterPositive: boolean; lowAchievementThreshold: number; minNewDoctorsPerDay: number; }
interface Comment { id: number; content: string; createdAt: string; by: string; userId: number; }
interface PlanView { plan: { id: number; planDate: string; status: string; notes: string | null; isManagerView: boolean }; entries: Entry[]; achievement: Achievement; newDoctorQuota: Quota; settings: Settings; comments: Comment[]; }
interface RepeatRow { doctorId: number; name: string; specialty?: string | null; plannedCount: number; plannedDays: string[]; visitedDays: string[]; lastFeedback: string | null; hadPositive: boolean; flagged: boolean; }
interface SubRep { userId: number; name: string; linkedRepId: number | null; }

const FEEDBACK_LABELS: Record<string, string> = {
  writing: 'يكتب', stocked: 'نزل الايتم', interested: 'مهتم',
  not_interested: 'غير مهتم', unavailable: 'غير متوفر', pending: 'معلق',
};
const FEEDBACK_OPTIONS = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
const FEEDBACK_ICONS: Record<string, string> = {
  writing: '✍️', stocked: '📦', interested: '👍', not_interested: '👎', unavailable: '🚫', pending: '⏳',
};
const POSTPONE_REASONS: Record<string, string> = { absent: 'الطبيب غير موجود', traveling: 'مسافر', declined: 'اعتذر عن الاستقبال', other: 'سبب آخر' };
const POSTPONE_REASON_ICONS: Record<string, string> = { absent: '🚪', traveling: '✈️', declined: '🙅', other: '❓' };
const STATUS_LABEL: Record<string, string> = { planned: 'مخطط', visited: 'تمت الزيارة', postponed: 'مؤجل' };

const NAVY = '#1e40af';
const RED = '#dc2626';

const getLocation = (): Promise<{ lat: number; lng: number } | null> =>
  new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 12000, maximumAge: 0, enableHighAccuracy: false },
    );
  });

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shiftDateStr = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ←/→ step the date by a full day (instead of the browser's default per-segment jump),
// so paging through days doesn't require typing or opening the calendar each time.
function dateArrowKeyHandler(currentValue: string, setValue: (v: string) => void, min?: string) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = shiftDateStr(currentValue || todayLocal(), e.key === 'ArrowRight' ? 1 : -1);
    if (min && next < min) return;
    setValue(next);
  };
}

// ── Design system (Pharma Net): white cards on a cool slate ground, a single navy
// accent, red reserved for real alerts. All responsive/interactive behavior lives in
// this stylesheet so the JSX stays declarative and the layout collapses cleanly on phones.
const STYLES = `
.dp-root,.dp-root *{ box-sizing:border-box; }
.dp-root{ font-family:'Segoe UI',Tahoma,Arial,sans-serif; background:#eef2f7; min-height:100vh; color:#1e293b; -webkit-tap-highlight-color:transparent; }
.dp-wrap{ max-width:780px; margin:0 auto; padding:0 12px 48px; }

.dp-header{ position:sticky; top:0; z-index:50; background:rgba(238,242,247,.9); backdrop-filter:saturate(180%) blur(12px); -webkit-backdrop-filter:saturate(180%) blur(12px); padding:12px 0 11px; margin-bottom:12px; border-bottom:1px solid #e2e8f0; }
.dp-header-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.dp-brand{ display:flex; align-items:center; gap:11px; min-width:0; }
.dp-logo{ width:40px; height:40px; border-radius:12px; background:linear-gradient(135deg,#1e40af,#3b5bff); display:flex; align-items:center; justify-content:center; font-size:19px; box-shadow:0 4px 12px rgba(30,64,175,.30); flex-shrink:0; }
.dp-h1{ margin:0; font-size:17.5px; font-weight:800; letter-spacing:-.2px; line-height:1.2; }
.dp-sub{ margin:1px 0 0; font-size:11px; color:#64748b; font-weight:500; }
.dp-controls{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

.dp-datenav{ display:flex; align-items:center; gap:2px; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:3px; box-shadow:0 1px 2px rgba(16,24,40,.05); }
.dp-datenav>button{ width:30px; height:30px; border:none; background:none; border-radius:8px; cursor:pointer; font-size:17px; color:#475569; display:flex; align-items:center; justify-content:center; transition:background .15s; }
.dp-datenav>button:hover{ background:#f1f5f9; }
.dp-datenav>button:active{ background:#e2e8f0; }
.dp-dateinput{ border:none; background:none; font:inherit; font-size:12.5px; font-weight:700; color:#1e293b; text-align:center; width:122px; cursor:pointer; }
.dp-dateinput::-webkit-calendar-picker-indicator{ opacity:.45; cursor:pointer; }

.dp-card{ background:#fff; border:1px solid #e8edf3; border-radius:14px; padding:15px 16px; margin-bottom:12px; box-shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.05); }
.dp-card--info{ background:#eff4ff; border-color:#dbe6ff; }
.dp-card-title{ font-size:13px; font-weight:800; color:#1e293b; letter-spacing:-.1px; }

.dp-input,.dp-select{ padding:9px 12px; border-radius:9px; border:1px solid #dbe3ec; font-size:13px; color:#1e293b; background:#fff; outline:none; transition:border-color .15s,box-shadow .15s; font-family:inherit; }
.dp-input:focus,.dp-select:focus{ border-color:#1e40af; box-shadow:0 0 0 3px rgba(30,64,175,.13); }
.dp-input::placeholder{ color:#94a3b8; }
.dp-select{ cursor:pointer; }

.dp-btn{ display:inline-flex; align-items:center; justify-content:center; gap:5px; border-radius:9px; padding:8px 15px; cursor:pointer; font-size:12.5px; font-weight:700; font-family:inherit; border:1px solid transparent; transition:transform .08s,background .15s,box-shadow .15s; white-space:nowrap; min-height:36px; }
.dp-btn:active{ transform:translateY(1px); }
.dp-btn--primary{ background:#1e40af; color:#fff; box-shadow:0 2px 6px rgba(30,64,175,.28); }
.dp-btn--primary:hover{ background:#1b399e; }
.dp-btn--neutral{ background:#f1f5f9; color:#334155; border-color:#e2e8f0; }
.dp-btn--neutral:hover{ background:#e9eef4; }
.dp-btn--danger{ background:#fff; color:#b91c1c; border-color:#fecaca; }
.dp-btn--danger:hover{ background:#fef2f2; }
.dp-btn--ghost{ background:none; color:#64748b; }
.dp-btn--ghost:hover{ background:#f1f5f9; }
.dp-btn--icon{ padding:8px 12px; min-width:38px; font-size:16px; }
.dp-btn--block{ width:100%; padding:12px; min-height:46px; font-size:13.5px; }

.dp-seg{ display:flex; background:#eef2f7; border:1px solid #e2e8f0; border-radius:11px; padding:3px; gap:3px; }
.dp-seg>button{ flex:1; border:none; background:none; border-radius:8px; padding:9px; font-size:12.5px; font-weight:700; color:#64748b; cursor:pointer; font-family:inherit; transition:all .15s; min-height:38px; }
.dp-seg>button.active{ background:#fff; color:#1e40af; box-shadow:0 1px 3px rgba(16,24,40,.14); }

.dp-fields{ display:flex; gap:8px; align-items:stretch; }
.dp-fields .grow{ flex:1 1 auto; min-width:0; }
.dp-quickrow{ display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }

.dp-chip{ display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:700; border-radius:7px; padding:2px 8px; line-height:1.7; border:1px solid transparent; white-space:nowrap; }

.dp-suggest{ position:absolute; top:100%; right:0; left:0; z-index:50; background:#fff; border:1px solid #e2e8f0; border-radius:11px; box-shadow:0 12px 32px rgba(16,24,40,.16); margin-top:5px; max-height:300px; overflow-y:auto; }
.dp-suggest>div{ padding:10px 13px; cursor:pointer; border-bottom:1px solid #f1f5f9; transition:background .12s; }
.dp-suggest>div:hover{ background:#f6f9fc; }
.dp-suggest>div:last-child{ border-bottom:none; }

.dp-sugg-list{ display:flex; flex-direction:column; gap:6px; margin-top:11px; padding-top:11px; border-top:1px dashed #e2e8f0; }
.dp-sugg-item{ display:flex; justify-content:space-between; align-items:center; gap:8px; background:#f8fafc; border:1px solid #eef2f7; padding:9px 11px; border-radius:10px; }

.dp-menu{ position:absolute; z-index:60; background:#fff; border:1px solid #e2e8f0; border-radius:11px; box-shadow:0 12px 32px rgba(16,24,40,.16); overflow:hidden; padding:4px; }
.dp-menu>button{ display:block; width:100%; text-align:right; padding:10px 12px; border:none; background:none; cursor:pointer; font-size:13px; font-family:inherit; border-radius:7px; color:#334155; }
.dp-menu>button:hover{ background:#f6f9fc; }

.dp-progress{ height:9px; background:#eef2f7; border-radius:999px; overflow:hidden; margin-top:12px; }
.dp-progress>span{ display:block; height:100%; border-radius:999px; transition:width .5s ease; }
.dp-pct{ font-size:22px; font-weight:800; padding:1px 12px; border-radius:10px; letter-spacing:-.5px; }
.dp-pct--ok{ background:#eff4ff; color:#1e40af; }
.dp-pct--low{ background:#fef2f2; color:#dc2626; }
.dp-statgrid{ display:flex; gap:8px; margin-top:12px; }
.dp-stat{ flex:1; background:#f8fafc; border:1px solid #eef2f7; border-radius:11px; padding:9px 6px; text-align:center; }
.dp-stat b{ display:block; font-size:17px; font-weight:800; line-height:1.1; }
.dp-stat span{ font-size:10.5px; color:#64748b; font-weight:600; }
.dp-quota{ margin-top:12px; font-size:12px; font-weight:600; border-radius:10px; padding:9px 12px; }
.dp-quota--ok{ background:#f8fafc; color:#475569; border:1px solid #eef2f7; }
.dp-quota--warn{ background:#fff7ed; color:#b45309; border:1px solid #fed7aa; }

.dp-list{ display:flex; flex-direction:column; gap:9px; }
.dp-entry{ border-radius:12px; padding:12px 13px; border:1px solid #eef2f7; background:#fff; transition:box-shadow .15s; }
.dp-entry--visited{ border-color:#bbf7d0; background:#f4fdf6; }
.dp-entry--postponed{ border-color:#e2e8f0; background:#f8fafc; }
.dp-entry-top{ display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
.dp-entry-info{ display:flex; align-items:center; gap:7px; flex-wrap:wrap; min-width:0; }
.dp-entry-name{ font-size:14px; font-weight:800; color:#1e293b; }
.dp-actions{ display:flex; gap:6px; margin-inline-start:auto; }
.dp-item-row{ display:flex; align-items:center; gap:7px; margin-top:9px; }
.dp-item-row>span{ font-size:11px; color:#64748b; flex-shrink:0; }
.dp-item-row .dp-select{ flex:1; min-width:0; padding:5px 9px; font-size:11.5px; }
.dp-postpone-note{ margin-top:8px; font-size:11.5px; color:#92400e; background:#fffbeb; border:1px solid #fef3c7; border-radius:8px; padding:6px 9px; }
.dp-divider{ display:flex; align-items:center; gap:9px; margin:3px 0; }
.dp-divider>span{ font-size:10.5px; color:#94a3b8; white-space:nowrap; font-weight:600; }
.dp-divider>i{ flex:1; height:1px; background:#e2e8f0; }

.dp-table-wrap{ overflow-x:auto; }
.dp-table{ width:100%; border-collapse:collapse; font-size:12.5px; }
.dp-table thead th{ background:#1e40af; color:#fff; padding:9px 10px; text-align:right; font-weight:700; font-size:11.5px; white-space:nowrap; }
.dp-table thead th:first-child{ border-radius:0 8px 8px 0; }
.dp-table thead th:last-child{ border-radius:8px 0 0 8px; }
.dp-table td{ padding:8px 10px; border-bottom:1px solid #f1f5f9; font-size:12px; color:#374151; }

.dp-comment{ background:#f8fafc; border:1px solid #eef2f7; padding:9px 11px; border-radius:10px; }
.dp-banner{ padding:9px 13px; border-radius:10px; margin-bottom:10px; font-size:12.5px; font-weight:600; border:1px solid; }
.dp-banner--info{ background:#eff4ff; color:#1e40af; border-color:#dbe6ff; }
.dp-banner--error{ background:#fef2f2; color:#b91c1c; border-color:#fecaca; }
.dp-banner--muted{ background:#fff; color:#64748b; border-color:#e8edf3; }
.dp-collapse{ display:flex; justify-content:space-between; align-items:center; width:100%; background:none; border:none; cursor:pointer; padding:0; font:inherit; }

.dp-overlay{ position:fixed; inset:0; background:rgba(15,23,42,.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px; animation:dp-fade .2s ease; }
.dp-modal{ background:#fff; border-radius:16px; padding:18px; width:100%; max-width:430px; box-shadow:0 24px 60px rgba(16,24,40,.32); animation:dp-pop .22s cubic-bezier(.2,.8,.3,1); max-height:90vh; overflow-y:auto; }
.dp-modal-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; }
.dp-modal-head strong{ font-size:15px; font-weight:800; color:#1e293b; }
.dp-modal-x{ background:#f1f5f9; border:none; width:30px; height:30px; border-radius:8px; font-size:19px; line-height:1; cursor:pointer; color:#64748b; display:flex; align-items:center; justify-content:center; }
.dp-modal-x:hover{ background:#e2e8f0; }
.dp-label{ display:block; margin-bottom:13px; }
.dp-label>span{ font-size:12px; color:#64748b; display:block; margin-bottom:5px; font-weight:600; }
.dp-label .dp-input,.dp-label .dp-select{ width:100%; }
.dp-choices{ display:flex; gap:8px; flex-wrap:wrap; }
.dp-choice{ display:flex; flex-direction:column; align-items:center; gap:5px; min-width:70px; flex:1; padding:11px 8px; border-radius:11px; cursor:pointer; border:1px solid #e2e8f0; background:#fff; transition:all .12s; font-family:inherit; color:#334155; }
.dp-choice.active{ border-color:#1e40af; background:#eff4ff; color:#1e40af; box-shadow:0 2px 8px rgba(30,64,175,.16); }
.dp-choice b{ font-size:20px; font-weight:400; }
.dp-choice span{ font-size:11px; font-weight:700; }

@keyframes dp-fade{ from{opacity:0} to{opacity:1} }
@keyframes dp-pop{ from{opacity:0; transform:translateY(12px) scale(.98)} to{opacity:1; transform:none} }
@keyframes dp-sheet{ from{transform:translateY(100%)} to{transform:none} }

@media (max-width:600px){
  .dp-controls{ width:100%; }
  .dp-controls .dp-select{ flex:1 1 100%; }
  .dp-datenav{ flex:1; justify-content:space-between; }
  .dp-dateinput{ flex:1; width:auto; }
  .dp-fields{ flex-direction:column; }
  .dp-fields>*{ width:100%; }
  .dp-btn{ min-height:42px; }
  .dp-quickrow>.dp-btn{ flex:1; }
  .dp-overlay{ padding:0; align-items:flex-end; }
  .dp-modal{ max-width:none; border-radius:20px 20px 0 0; padding:18px 16px calc(20px + env(safe-area-inset-bottom)); animation:dp-sheet .26s cubic-bezier(.2,.8,.3,1); max-height:92vh; }
}
`;

function StatusChip({ status }: { status: Entry['status'] }) {
  const m = status === 'visited'
    ? { t: 'تمت', c: '#166534', bg: '#dcfce7', b: '#bbf7d0', i: '✓' }
    : status === 'postponed'
    ? { t: 'مؤجل', c: '#b45309', bg: '#fffbeb', b: '#fde68a', i: '⏸' }
    : { t: 'مخطط', c: '#64748b', bg: '#f1f5f9', b: '#e2e8f0', i: '○' };
  return <span className="dp-chip" style={{ color: m.c, background: m.bg, borderColor: m.b }}>{m.i} {m.t}</span>;
}

export default function DailyPlanPage() {
  const { user, token, isManagerOrAdmin } = useAuth();
  const role = user?.role ?? 'user';
  const isManager = isManagerOrAdmin;
  const isCompanyManager = role === 'company_manager' || role === 'admin';

  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [date, setDate] = useState(todayLocal());
  const [selectedRep, setSelectedRep] = useState<number | null>(null); // repUserId for manager view; null = self
  const [subReps, setSubReps] = useState<SubRep[]>([]);
  const [view, setView] = useState<PlanView | null>(null);
  const [repeats, setRepeats] = useState<RepeatRow[]>([]);
  const [postpone, setPostpone] = useState<{ total: number; counts: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // doctor/area pickers
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [addMode, setAddMode] = useState<'doctor' | 'pharmacy'>('doctor');
  const [docSearch, setDocSearch] = useState('');
  const [pharmName, setPharmName] = useState('');
  const [pharmArea, setPharmArea] = useState<number | ''>('');
  const [pharmSugg, setPharmSugg] = useState<string[]>([]);
  const [pharmOpen, setPharmOpen] = useState(false);
  const pharmBoxRef = useRef<HTMLDivElement>(null);

  // suggestions
  const [suggestMode, setSuggestMode] = useState<'' | 'new' | 'carryover'>('');
  const [suggestions, setSuggestions] = useState<any[]>([]);

  // record-visit modal
  const [recordFor, setRecordFor] = useState<Entry | null>(null);
  const [recordFeedback, setRecordFeedback] = useState('writing');
  const [recordNote, setRecordNote] = useState('');
  const [recordItemId, setRecordItemId] = useState<number | ''>('');
  // postpone modal
  const [postponeFor, setPostponeFor] = useState<Entry | null>(null);
  const [postponeReason, setPostponeReason] = useState('absent');
  const [postponeNote, setPostponeNote] = useState('');
  const [postponeDate, setPostponeDate] = useState('');
  // comments / settings
  const [commentText, setCommentText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  // collapsible postpone-reasons analysis panel
  const [postponeAnalysisOpen, setPostponeAnalysisOpen] = useState(false);
  const postponeBoxRef = useRef<HTMLDivElement>(null);
  // post-add reminder: pick the target item for a just-added doctor (skippable)
  const [itemPromptEntryId, setItemPromptEntryId] = useState<number | null>(null);
  const [itemPromptName, setItemPromptName] = useState('');
  const [itemPromptValue, setItemPromptValue] = useState<number | ''>('');
  // per-entry "⋮" actions menu (postpone / delete tucked away for a clean row)
  const [actionsMenuFor, setActionsMenuFor] = useState<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  // Doctor history popup (company_manager/admin) — visit dates + daily-plan dates across all reps, to spot repetition
  const [doctorHistoryFor, setDoctorHistoryFor] = useState<{ doctorId: number; name: string } | null>(null);
  const [doctorHistoryData, setDoctorHistoryData] = useState<{ visits: { date: string; feedback: string; repName: string }[]; planEntries: { planDate: string; status: string; repName: string }[] } | null>(null);
  const [doctorHistoryLoading, setDoctorHistoryLoading] = useState(false);
  const openDoctorHistory = async (doctorId: number, name: string) => {
    setDoctorHistoryFor({ doctorId, name });
    setDoctorHistoryData(null);
    setDoctorHistoryLoading(true);
    try {
      const r = await fetch(`${API}/api/monthly-plans/doctor-history/${doctorId}`, { headers: H() });
      const j = await r.json();
      if (r.ok && j.success) setDoctorHistoryData(j.data);
    } catch {}
    setDoctorHistoryLoading(false);
  };

  const repParam = selectedRep ? `&repUserId=${selectedRep}` : '';
  const repQS = selectedRep ? `repUserId=${selectedRep}` : '';

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  // ── Load manager's subordinate reps ──
  useEffect(() => {
    if (!isManager || !token) return;
    fetch(`${API}/api/doctors/sub-reps`, { headers: H() })
      .then(r => r.ok ? r.json() : { reps: [] })
      .then(j => setSubReps(Array.isArray(j.reps) ? j.reps : []))
      .catch(() => {});
  }, [isManager, token, H]);

  // ── Load own doctors + areas + items (used for the add-entry pickers) ──
  useEffect(() => {
    if (!token) return;
    Promise.all([
      fetch(`${API}/api/doctors`, { headers: H() }).then(r => r.ok ? r.json() : []),
      fetch(`${API}/api/areas`, { headers: H() }).then(r => r.ok ? r.json() : []),
      fetch(`${API}/api/items`, { headers: H() }).then(r => r.ok ? r.json() : []),
    ]).then(([dj, aj, ij]) => {
      setDoctors(Array.isArray(dj) ? dj : (dj.data ?? dj.doctors ?? []));
      setAreas(Array.isArray(aj) ? aj : (aj.data ?? []));
      setItems(Array.isArray(ij) ? ij : (ij.data ?? ij.items ?? []));
    }).catch(() => {});
  }, [token, H]);

  // ── Close the postpone-reasons analysis panel on outside click ──
  useEffect(() => {
    if (!postponeAnalysisOpen) return;
    const handler = (e: MouseEvent) => { if (postponeBoxRef.current && !postponeBoxRef.current.contains(e.target as Node)) setPostponeAnalysisOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [postponeAnalysisOpen]);

  // ── Close the per-entry "⋮" actions menu on outside click ──
  useEffect(() => {
    if (actionsMenuFor == null) return;
    const handler = (e: MouseEvent) => { if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) setActionsMenuFor(null); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [actionsMenuFor]);

  // ── Pharmacy name suggestions (server-side, like the doctor search) ──
  useEffect(() => {
    if (!token || !pharmName.trim()) { setPharmSugg([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${API}/api/doctors/pharmacy-names?q=${encodeURIComponent(pharmName.trim())}`, { headers: H(), signal: ctrl.signal })
        .then(r => r.ok ? r.json() : [])
        .then(list => { setPharmSugg(Array.isArray(list) ? list : []); setPharmOpen(true); })
        .catch(() => {});
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [pharmName, token, H]);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (pharmBoxRef.current && !pharmBoxRef.current.contains(e.target as Node)) setPharmOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Load plan view + repeats + postpone stats ──
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const r = await fetch(`${API}/api/daily-plans?date=${date}${repParam}`, { headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || `خطأ ${r.status}`);
      setView(j.data);

      const [rr, ps] = await Promise.all([
        fetch(`${API}/api/daily-plans/repeats?${repQS}`, { headers: H() }).then(x => x.ok ? x.json() : { data: [] }),
        fetch(`${API}/api/daily-plans/postpone-stats?${repQS}`, { headers: H() }).then(x => x.ok ? x.json() : { data: null }),
      ]);
      setRepeats(rr.data ?? []);
      setPostpone(ps.data ?? null);
    } catch (e: any) {
      setError(e.message || 'فشل تحميل البلان اليومي');
      setView(null);
    } finally { setLoading(false); }
  }, [token, date, repParam, repQS, H]);

  useEffect(() => { load(); }, [load]);

  const repeatByDoctor = useMemo(() => { const m = new Map<number, RepeatRow>(); repeats.forEach(r => m.set(r.doctorId, r)); return m; }, [repeats]);

  // ── Actions ──
  const planId = view?.plan.id;

  const addDoctor = async (doctorId: number) => {
    if (!planId) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/${planId}/entries`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ entryType: 'doctor', doctorId, repUserId: selectedRep ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر الإضافة');
      if (j.data?.repeat?.flagged) {
        const rp = j.data.repeat;
        flash(`تنبيه تكرار: الطبيب مخطط في ${rp.count} أيام${rp.hadPositive ? ' وسبق زيارته بنجاح' : ''} — تم إعلام المدير.`);
      } else flash('تمت الإضافة');
      setDocSearch('');
      const newEntryId = j.data?.entry?.id;
      if (newEntryId) {
        setItemPromptEntryId(newEntryId);
        setItemPromptName(doctors.find(d => d.id === doctorId)?.name ?? 'الطبيب');
        setItemPromptValue('');
      }
      await load();
    } catch (e: any) { setError(e.message); }
  };

  // Reminder after adding a doctor (rep or manager): pick the target item now, or skip — never mandatory.
  const confirmItemPrompt = async () => {
    if (itemPromptEntryId == null) return;
    if (itemPromptValue) await setEntryItem(itemPromptEntryId, itemPromptValue);
    setItemPromptEntryId(null); setItemPromptName(''); setItemPromptValue('');
  };
  const skipItemPrompt = () => { setItemPromptEntryId(null); setItemPromptName(''); setItemPromptValue(''); };

  const addPharmacy = async (nameOverride?: string) => {
    const name = (nameOverride ?? pharmName).trim();
    if (!planId || !name) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/${planId}/entries`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ entryType: 'pharmacy', pharmacyName: name, areaId: pharmArea || undefined, repUserId: selectedRep ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر الإضافة');
      setPharmName(''); setPharmArea(''); setPharmOpen(false); flash('تمت إضافة الصيدلية');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const removeEntry = async (entryId: number) => {
    try {
      const r = await fetch(`${API}/api/daily-plans/entries/${entryId}`, {
        method: 'DELETE', headers: H(), body: JSON.stringify({ repUserId: selectedRep ?? undefined }),
      });
      if (!r.ok) throw new Error('تعذّر الحذف');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const submitRecord = async () => {
    if (!recordFor || !planId) return;
    const loc = await getLocation();
    try {
      const body: any = { repUserId: selectedRep ?? undefined, latitude: loc?.lat, longitude: loc?.lng, notes: recordNote };
      if (recordFor.entryType === 'doctor') { body.feedback = recordFeedback; body.itemId = recordItemId || undefined; }
      const r = await fetch(`${API}/api/daily-plans/${planId}/entries/${recordFor.id}/record-visit`, {
        method: 'POST', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر التسجيل');
      setRecordFor(null); setRecordNote(''); setRecordFeedback('writing'); setRecordItemId(''); flash('تم تسجيل الكول');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const submitPostpone = async () => {
    if (!postponeFor) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/entries/${postponeFor.id}`, {
        method: 'PATCH', headers: H(),
        body: JSON.stringify({ status: 'postponed', postponeReason, postponeNote, postponeToDate: postponeDate || undefined, repUserId: selectedRep ?? undefined }),
      });
      if (!r.ok) throw new Error('تعذّر التأجيل');
      setPostponeFor(null); setPostponeNote(''); setPostponeReason('absent');
      flash(postponeDate ? `تم التأجيل، وسيُضاف الاسم تلقائياً ليوم ${postponeDate}` : 'تم التأجيل');
      setPostponeDate('');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const setEntryItem = async (entryId: number, itemId: number | '') => {
    try {
      const r = await fetch(`${API}/api/daily-plans/entries/${entryId}`, {
        method: 'PATCH', headers: H(),
        body: JSON.stringify({ itemId: itemId || null, repUserId: selectedRep ?? undefined }),
      });
      if (!r.ok) throw new Error('تعذّر تحديد الايتم');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const loadSuggestions = async (mode: 'new' | 'carryover') => {
    setSuggestMode(mode); setSuggestions([]);
    try {
      const r = await fetch(`${API}/api/daily-plans/suggest?mode=${mode}&date=${date}&${repQS}`, { headers: H() });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر جلب الاقتراحات');
      setSuggestions(j.data ?? []);
    } catch (e: any) { setSuggestions([]); setError(e.message); }
  };

  const addComment = async () => {
    if (!planId || !commentText.trim()) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/${planId}/comments`, {
        method: 'POST', headers: H(), body: JSON.stringify({ content: commentText.trim(), repUserId: selectedRep ?? undefined }),
      });
      if (!r.ok) throw new Error('تعذّر إضافة التعليق');
      setCommentText(''); await load();
    } catch (e: any) { setError(e.message); }
  };

  // ── Settings ──
  const openSettings = async () => {
    try {
      const r = await fetch(`${API}/api/daily-plans/settings`, { headers: H() });
      const j = await r.json();
      setSettingsDraft(j.data); setSettingsOpen(true);
    } catch (e: any) { setError(e.message); }
  };
  const saveSettings = async () => {
    if (!settingsDraft) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/settings`, { method: 'PUT', headers: H(), body: JSON.stringify(settingsDraft) });
      if (!r.ok) throw new Error('تعذّر الحفظ');
      setSettingsOpen(false); flash('تم حفظ الإعدادات'); await load();
    } catch (e: any) { setError(e.message); }
  };

  const filteredDoctors = useMemo(() => {
    const q = docSearch.trim().toLowerCase();
    if (!q) return [];
    const inPlan = new Set((view?.entries ?? []).filter(e => e.entryType === 'doctor').map(e => e.doctorId));
    return doctors.filter(d => d.name.toLowerCase().includes(q) && !inPlan.has(d.id)).slice(0, 8);
  }, [docSearch, doctors, view]);

  // Pending (no action yet) entries float to the top; visited/postponed sink to the
  // bottom as a finished group — keeps the active to-do list scannable at a glance.
  const sortedEntries = useMemo(() => {
    const rank = (e: Entry) => (e.status === 'planned' ? 0 : 1);
    return [...(view?.entries ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [view]);

  const ach = view?.achievement;
  const quota = view?.newDoctorQuota;
  const lowAch = !!(ach && view && ach.percent < view.settings.lowAchievementThreshold);
  const isToday = date === todayLocal();

  // ─── Render ───
  return (
    <div dir="rtl" className="dp-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="dp-wrap">

        {/* Sticky header: brand + rep picker + day stepper + settings */}
        <header className="dp-header">
          <div className="dp-header-row">
            <div className="dp-brand">
              <div className="dp-logo">📅</div>
              <div>
                <h1 className="dp-h1">البلان اليومي</h1>
                <p className="dp-sub">زيارات اليوم ونسبة التحقيق</p>
              </div>
            </div>
            <div className="dp-controls">
              {isManager && (
                <select className="dp-select" value={selectedRep ?? ''} onChange={e => setSelectedRep(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">— بلاني —</option>
                  {subReps.map(s => <option key={s.userId} value={s.userId}>{s.name}</option>)}
                </select>
              )}
              <div className="dp-datenav">
                <button onClick={() => setDate(shiftDateStr(date, -1))} aria-label="اليوم السابق">›</button>
                <input type="date" className="dp-dateinput" value={date} onChange={e => setDate(e.target.value)} onKeyDown={dateArrowKeyHandler(date, setDate)} />
                <button onClick={() => setDate(shiftDateStr(date, 1))} aria-label="اليوم التالي">‹</button>
              </div>
              {!isToday && <button className="dp-btn dp-btn--ghost" style={{ padding: '6px 11px', minHeight: 0 }} onClick={() => setDate(todayLocal())}>اليوم</button>}
              {isCompanyManager && <button className="dp-btn dp-btn--neutral dp-btn--icon" onClick={openSettings} title="إعدادات" aria-label="إعدادات">⚙</button>}
            </div>
          </div>
        </header>

        {msg && <div className="dp-banner dp-banner--info">{msg}</div>}
        {error && <div className="dp-banner dp-banner--error">{error}</div>}
        {loading && <div style={{ color: '#64748b', fontSize: 13, padding: '4px 2px' }}>جاري التحميل…</div>}

        {isManager && !selectedRep && (
          <div className="dp-banner dp-banner--muted">اختر مندوباً من القائمة أعلاه لعرض بلانه ونسبة تحقيقه والتعليق عليه، أو اترك «بلاني» لعرض بلانك.</div>
        )}

        {view && (
          <>
            {/* Achievement summary */}
            {ach && (
              <div className="dp-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span className="dp-card-title">نسبة التحقيق اليومي</span>
                  <span className={`dp-pct ${lowAch ? 'dp-pct--low' : 'dp-pct--ok'}`}>{ach.percent}%</span>
                </div>
                <div className="dp-progress"><span style={{ width: `${ach.percent}%`, background: lowAch ? RED : NAVY }} /></div>
                <div className="dp-statgrid">
                  <div className="dp-stat"><b style={{ color: '#16a34a' }}>{ach.visited}</b><span>تمت</span></div>
                  <div className="dp-stat"><b style={{ color: '#d97706' }}>{ach.postponed}</b><span>مؤجل</span></div>
                  <div className="dp-stat"><b style={{ color: NAVY }}>{ach.planned}</b><span>مخطط</span></div>
                  <div className="dp-stat"><b style={{ color: '#334155' }}>{ach.total}</b><span>الكل</span></div>
                </div>
                {quota && quota.required > 0 && (
                  <div className={`dp-quota ${quota.planned >= quota.required ? 'dp-quota--ok' : 'dp-quota--warn'}`}>
                    حصة الأطباء الجدد: {quota.planned}/{quota.required} مخطط · {quota.visited} تمت
                    {quota.planned < quota.required ? ' — أقل من المطلوب' : ''}
                  </div>
                )}
              </div>
            )}

            {/* Add entry — segmented doctor/pharmacy keeps only the relevant field on screen */}
            <div className="dp-card">
              <div className="dp-card-title" style={{ marginBottom: 12 }}>إضافة إلى البلان</div>
              <div className="dp-seg" style={{ marginBottom: 12 }}>
                <button className={addMode === 'doctor' ? 'active' : ''} onClick={() => setAddMode('doctor')}>👨‍⚕️ طبيب</button>
                <button className={addMode === 'pharmacy' ? 'active' : ''} onClick={() => setAddMode('pharmacy')}>🏪 صيدلية</button>
              </div>

              {addMode === 'doctor' ? (
                <div style={{ position: 'relative' }}>
                  <input className="dp-input" style={{ width: '100%' }} value={docSearch} onChange={e => setDocSearch(e.target.value)} placeholder="ابحث باسم الطبيب…" />
                  {filteredDoctors.length > 0 && (
                    <div className="dp-suggest">
                      {filteredDoctors.map(d => (
                        <div key={d.id} onClick={() => addDoctor(d.id)}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{d.name}</div>
                          <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{[d.specialty, d.area?.name, d.pharmacyName].filter(Boolean).join(' · ') || '—'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="dp-fields">
                  <div className="grow" style={{ position: 'relative' }} ref={pharmBoxRef}>
                    <input className="dp-input" style={{ width: '100%' }} value={pharmName} onChange={e => setPharmName(e.target.value)}
                      onFocus={() => pharmSugg.length > 0 && setPharmOpen(true)} placeholder="اسم الصيدلية…" />
                    {pharmOpen && pharmSugg.length > 0 && (
                      <div className="dp-suggest">
                        {pharmSugg.map(n => (
                          <div key={n} onMouseDown={() => { setPharmName(n); setPharmOpen(false); addPharmacy(n); }} style={{ fontSize: 13, fontWeight: 600 }}>{n}</div>
                        ))}
                      </div>
                    )}
                  </div>
                  <select className="dp-select" value={pharmArea} onChange={e => setPharmArea(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">المنطقة (اختياري)</option>
                    {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button className="dp-btn dp-btn--primary" onClick={() => addPharmacy()}>إضافة</button>
                </div>
              )}

              <div className="dp-quickrow">
                <button className="dp-btn dp-btn--neutral" onClick={() => loadSuggestions('new')}>➕ أطباء جدد</button>
                <button className="dp-btn dp-btn--neutral" onClick={() => loadSuggestions('carryover')}>↻ مؤجلو أمس</button>
                {suggestMode && <button className="dp-btn dp-btn--ghost" onClick={() => { setSuggestMode(''); setSuggestions([]); }}>إغلاق</button>}
              </div>

              {suggestMode && (
                <div className="dp-sugg-list">
                  <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 2 }}>{suggestMode === 'new' ? 'أطباء من مناطقك لم تتم زيارتهم:' : 'أطباء أُجّلوا أمس:'}</div>
                  {suggestions.length === 0 ? <div style={{ fontSize: 12.5, color: '#94a3b8' }}>لا توجد اقتراحات</div> : (
                    suggestions.map((s: any) => (
                      <div key={s.doctorId} className="dp-sugg-item">
                        <span style={{ fontSize: 12.5, minWidth: 0 }}>
                          <b style={{ fontWeight: 700 }}>{s.name}</b>
                          <span style={{ color: '#64748b' }}> · {[s.specialty, s.areaName, s.pharmacyName].filter(Boolean).join(' · ')}</span>
                          {s.postponeReason && <span style={{ color: '#b45309' }}> · {POSTPONE_REASONS[s.postponeReason] ?? s.postponeReason}</span>}
                        </span>
                        <button className="dp-btn dp-btn--primary" onClick={() => addDoctor(s.doctorId)}>أضف</button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Reminder: pick the target item for the doctor just added — optional, skippable */}
            {itemPromptEntryId != null && (
              <div className="dp-card dp-card--info">
                <div style={{ fontSize: 12.5, color: '#1e293b', marginBottom: 10 }}>تمت إضافة <b>{itemPromptName}</b> — اختر الايتم المستهدف (اختياري):</div>
                <div className="dp-fields">
                  <select className="dp-select grow" value={itemPromptValue} onChange={e => setItemPromptValue(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">— بدون تحديد —</option>
                    {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </select>
                  <button className="dp-btn dp-btn--primary" onClick={confirmItemPrompt}>تأكيد</button>
                  <button className="dp-btn dp-btn--neutral" onClick={skipItemPrompt}>تخطّي</button>
                </div>
              </div>
            )}

            {/* Entries list */}
            <div className="dp-card">
              <div className="dp-card-title" style={{ marginBottom: 12 }}>قائمة اليوم · {view.entries.length}</div>
              {view.entries.length === 0 ? (
                <div style={{ fontSize: 12.5, color: '#94a3b8', textAlign: 'center', padding: '18px 0' }}>لا توجد أسماء في بلان اليوم بعد.</div>
              ) : (
                <div className="dp-list">
                  {sortedEntries.map((e, idx) => {
                    const rep = e.doctorId ? repeatByDoctor.get(e.doctorId) : null;
                    const name = e.entryType === 'doctor' ? (e.doctor?.name ?? `#${e.doctorId}`) : e.pharmacyName;
                    const showDivider = e.status !== 'planned' && idx > 0 && sortedEntries[idx - 1].status === 'planned';
                    const cls = e.status === 'visited' ? 'dp-entry dp-entry--visited' : e.status === 'postponed' ? 'dp-entry dp-entry--postponed' : 'dp-entry';
                    return (
                      <Fragment key={e.id}>
                        {showDivider && <div className="dp-divider"><i /><span>منتهية</span><i /></div>}
                        <div className={cls}>
                          <div className="dp-entry-top">
                            <div className="dp-entry-info">
                              <span className="dp-entry-name">
                                {isCompanyManager && e.entryType === 'doctor' && e.doctorId ? (
                                  <span onClick={ev => { ev.stopPropagation(); openDoctorHistory(e.doctorId as number, name as string); }}
                                    title="عرض سجلّ الطبيب" style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer' }}>{name}</span>
                                ) : name}
                              </span>
                              {e.entryType === 'doctor' && e.doctor?.specialty && <span style={{ fontSize: 11, color: '#64748b' }}>{e.doctor.specialty}</span>}
                              {e.isNewDoctor && <span className="dp-chip" style={{ color: NAVY, background: '#eff4ff', borderColor: '#dbe6ff' }}>جديد</span>}
                              {e.status !== 'planned' && <StatusChip status={e.status} />}
                              {e.currentFeedback && <span className="dp-chip" style={{ color: '#64748b', background: '#f1f5f9', borderColor: '#e2e8f0' }}>{FEEDBACK_LABELS[e.currentFeedback] ?? e.currentFeedback}</span>}
                              {e.addedByManager && <span className="dp-chip" style={{ color: '#92400e', background: '#fffbeb', borderColor: '#fde68a' }} title="أضافه المدير">من المدير{e.addedByName ? ` (${e.addedByName})` : ''}</span>}
                              {rep?.flagged && <span className="dp-chip" style={{ color: '#dc2626', background: '#fef2f2', borderColor: '#fecaca' }} title={`تخطيط: ${rep.plannedDays.join('، ')} | زيارة: ${rep.visitedDays.join('، ') || '—'}`}>مكرر ×{rep.plannedCount}</span>}
                            </div>
                            <div className="dp-actions">
                              {e.status === 'planned' && <button className="dp-btn dp-btn--primary" onClick={() => { setRecordFor(e); setRecordFeedback('writing'); setRecordItemId(e.itemId ?? ''); }}>سجّل كول</button>}
                              <div ref={actionsMenuFor === e.id ? actionsMenuRef : undefined} style={{ position: 'relative' }}>
                                <button className="dp-btn dp-btn--neutral dp-btn--icon" onClick={() => setActionsMenuFor(actionsMenuFor === e.id ? null : e.id)} aria-label="خيارات">⋮</button>
                                {actionsMenuFor === e.id && (
                                  <div className="dp-menu" style={{ top: '100%', left: 0, marginTop: 5, minWidth: 150 }}>
                                    {e.status === 'planned' && <button onClick={() => { setPostponeFor(e); setPostponeReason('absent'); setPostponeDate(''); setActionsMenuFor(null); }}>⏸ تأجيل الزيارة</button>}
                                    <button style={{ color: '#b91c1c' }} onClick={() => { removeEntry(e.id); setActionsMenuFor(null); }}>🗑 حذف</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          {e.entryType === 'doctor' && (
                            <div className="dp-item-row">
                              <span>🎯 الايتم:</span>
                              <select className="dp-select" value={e.itemId ?? ''} onChange={ev => setEntryItem(e.id, ev.target.value ? Number(ev.target.value) : '')}>
                                <option value="">— غير محدد —</option>
                                {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                              </select>
                            </div>
                          )}
                          {e.status === 'postponed' && (
                            <div className="dp-postpone-note">
                              {e.autoPostponed
                                ? 'تأجيل تلقائي: لم يُتّخذ أي إجراء خلال 24 ساعة'
                                : (e.postponeReason && <>السبب: {POSTPONE_REASONS[e.postponeReason] ?? e.postponeReason}{e.postponeNote ? ` — ${e.postponeNote}` : ''}</>)}
                              {e.postponeToDate && <span> · أُضيف تلقائياً ليوم {e.postponeToDate}</span>}
                            </div>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Repeats report */}
            {repeats.length > 0 && (
              <div className="dp-card">
                <div className="dp-card-title" style={{ marginBottom: 12 }}>الأطباء المكرّرون · آخر 30 يوم</div>
                <div className="dp-table-wrap">
                  <table className="dp-table">
                    <thead><tr><th>الطبيب</th><th>مرات التخطيط</th><th>أيام التخطيط</th><th>أيام الزيارة</th><th>آخر نتيجة</th></tr></thead>
                    <tbody>
                      {repeats.map(r => (
                        <tr key={r.doctorId}>
                          <td>{r.flagged && <span style={{ color: '#dc2626', fontWeight: 700 }}>● </span>}{r.name}</td>
                          <td style={{ fontWeight: 700 }}>{r.plannedCount}</td>
                          <td style={{ color: '#64748b' }}>{r.plannedDays.join('، ')}</td>
                          <td style={{ color: '#64748b' }}>{r.visitedDays.join('، ') || '—'}</td>
                          <td>{r.lastFeedback ? (FEEDBACK_LABELS[r.lastFeedback] ?? r.lastFeedback) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Postpone analytics — collapsed by default */}
            {postpone && postpone.total > 0 && (
              <div className="dp-card" ref={postponeBoxRef}>
                <button className="dp-collapse" onClick={() => setPostponeAnalysisOpen(o => !o)}>
                  <span className="dp-card-title">أسباب التأجيل · 30 يوم <span style={{ color: '#94a3b8', fontWeight: 600 }}>({postpone.total})</span></span>
                  <span style={{ fontSize: 12, color: '#64748b' }}>{postponeAnalysisOpen ? '▲' : '▼'}</span>
                </button>
                {postponeAnalysisOpen && (
                  <div className="dp-statgrid" style={{ flexWrap: 'wrap' }}>
                    {Object.entries(POSTPONE_REASONS).map(([k, label]) => (
                      <div key={k} className="dp-stat" style={{ minWidth: 90 }}>
                        <b style={{ color: '#1e293b', fontSize: 18 }}>{postpone.counts[k] ?? 0}</b>
                        <span>{POSTPONE_REASON_ICONS[k]} {label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Comments */}
            <div className="dp-card">
              <div className="dp-card-title" style={{ marginBottom: 12 }}>الملاحظات والتعليقات</div>
              {view.comments.length === 0 ? <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 10 }}>لا توجد تعليقات.</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12 }}>
                  {view.comments.map(c => (
                    <div key={c.id} className="dp-comment">
                      <div style={{ fontSize: 12.5, color: '#1e293b' }}>{c.content}</div>
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>{c.by} · {new Date(c.createdAt).toLocaleString('ar-IQ-u-nu-latn')}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="dp-fields">
                <input className="dp-input grow" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="أضف ملاحظة…" />
                <button className="dp-btn dp-btn--primary" onClick={addComment}>إرسال</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Record-visit modal */}
      {recordFor && (
        <Modal title="تسجيل كول" onClose={() => setRecordFor(null)}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', marginBottom: 14 }}>{recordFor.entryType === 'doctor' ? (recordFor.doctor?.name ?? 'طبيب') : recordFor.pharmacyName}</div>
          {recordFor.entryType === 'doctor' && (
            <>
              <div style={{ marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 8, fontWeight: 600 }}>النتيجة</span>
                <div className="dp-choices">
                  {FEEDBACK_OPTIONS.map(f => (
                    <button key={f} type="button" className={`dp-choice ${recordFeedback === f ? 'active' : ''}`} onClick={() => setRecordFeedback(f)}>
                      <b>{FEEDBACK_ICONS[f]}</b><span>{FEEDBACK_LABELS[f]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="dp-label">
                <span>الايتم المستهدف (اختياري)</span>
                <select className="dp-select" value={recordItemId} onChange={e => setRecordItemId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">— بدون تحديد —</option>
                  {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                </select>
              </label>
            </>
          )}
          <label className="dp-label">
            <span>ملاحظة (اختياري)</span>
            <input className="dp-input" value={recordNote} onChange={e => setRecordNote(e.target.value)} />
          </label>
          <button className="dp-btn dp-btn--primary dp-btn--block" onClick={submitRecord}>📍 تسجيل الكول</button>
        </Modal>
      )}

      {/* Postpone modal */}
      {postponeFor && (
        <Modal title="تأجيل الزيارة" onClose={() => setPostponeFor(null)}>
          <div style={{ marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 8, fontWeight: 600 }}>السبب</span>
            <div className="dp-choices">
              {Object.entries(POSTPONE_REASONS).map(([k, label]) => (
                <button key={k} type="button" className={`dp-choice ${postponeReason === k ? 'active' : ''}`} onClick={() => setPostponeReason(k)}>
                  <b>{POSTPONE_REASON_ICONS[k]}</b><span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="dp-label">
            <span>تأجيل إلى تاريخ (اختياري) — يُضاف تلقائياً لبلان ذلك اليوم</span>
            <input type="date" className="dp-input" min={todayLocal()} value={postponeDate} onChange={e => setPostponeDate(e.target.value)}
              onClick={e => { try { (e.currentTarget as any).showPicker?.(); } catch { /* unsupported browser — falls back to native input */ } }}
              onKeyDown={dateArrowKeyHandler(postponeDate, setPostponeDate, todayLocal())} style={{ cursor: 'pointer' }} />
          </label>
          <label className="dp-label">
            <span>ملاحظة (اختياري)</span>
            <input className="dp-input" value={postponeNote} onChange={e => setPostponeNote(e.target.value)} />
          </label>
          <button className="dp-btn dp-btn--primary dp-btn--block" onClick={submitPostpone}>تأكيد التأجيل</button>
        </Modal>
      )}

      {/* Settings modal */}
      {settingsOpen && settingsDraft && (
        <Modal title="إعدادات البلان اليومي" onClose={() => setSettingsOpen(false)}>
          <NumField label="عدد أيام نافذة التكرار" value={settingsDraft.repeatWindowDays} onChange={v => setSettingsDraft({ ...settingsDraft, repeatWindowDays: v })} />
          <NumField label="عدد مرات التكرار للتنبيه" value={settingsDraft.repeatThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, repeatThreshold: v })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '4px 0 14px', fontSize: 12.5, color: '#1e293b', cursor: 'pointer' }}>
            <input type="checkbox" checked={settingsDraft.alertOnRepeatAfterPositive} onChange={e => setSettingsDraft({ ...settingsDraft, alertOnRepeatAfterPositive: e.target.checked })} />
            تنبيه عند إعادة طبيب بعد زيارة ناجحة / تنزيل طلبية
          </label>
          <NumField label="حد الإنجاز المنخفض % (للإشعار)" value={settingsDraft.lowAchievementThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, lowAchievementThreshold: v })} />
          <NumField label="حصة الأطباء الجدد يومياً (0 = معطّل)" value={settingsDraft.minNewDoctorsPerDay} onChange={v => setSettingsDraft({ ...settingsDraft, minNewDoctorsPerDay: v })} />
          <button className="dp-btn dp-btn--primary dp-btn--block" style={{ marginTop: 6 }} onClick={saveSettings}>حفظ الإعدادات</button>
        </Modal>
      )}

      {/* Doctor history popup (company_manager/admin): visit dates + daily-plan dates across all reps */}
      {doctorHistoryFor && (
        <Modal title={`🗓 سجلّ ${doctorHistoryFor.name}`} onClose={() => setDoctorHistoryFor(null)}>
          {doctorHistoryLoading ? (
            <p style={{ textAlign: 'center', color: '#94a3b8', padding: '20px 0' }}>جاري التحميل…</p>
          ) : !doctorHistoryData ? (
            <p style={{ textAlign: 'center', color: '#ef4444', padding: '20px 0' }}>تعذّر تحميل السجلّ</p>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <strong style={{ fontSize: 12.5, color: '#374151', display: 'block', marginBottom: 8 }}>تواريخ الزيارات الفعلية ({doctorHistoryData.visits.length})</strong>
                {doctorHistoryData.visits.length === 0 ? <p style={{ fontSize: 12.5, color: '#94a3b8', margin: 0 }}>لا توجد زيارات مسجّلة</p> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 180, overflowY: 'auto' }}>
                    {doctorHistoryData.visits.map((v, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, padding: '7px 11px', fontSize: 12.5 }}>
                        <span style={{ color: '#166534', fontWeight: 700 }}>{new Date(v.date).toLocaleDateString('en-CA')}</span>
                        <span style={{ color: '#374151' }}>{v.repName}</span>
                        <span style={{ color: '#64748b' }}>{FEEDBACK_LABELS[v.feedback] ?? v.feedback}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <strong style={{ fontSize: 12.5, color: '#374151', display: 'block', marginBottom: 8 }}>تواريخ الإضافة للبلان اليومي ({doctorHistoryData.planEntries.length})</strong>
                {doctorHistoryData.planEntries.length === 0 ? <p style={{ fontSize: 12.5, color: '#94a3b8', margin: 0 }}>لم يُضَف لأي بلان يومي</p> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 180, overflowY: 'auto' }}>
                    {doctorHistoryData.planEntries.map((p, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 9, padding: '7px 11px', fontSize: 12.5 }}>
                        <span style={{ color: '#1e40af', fontWeight: 700 }}>{p.planDate}</span>
                        <span style={{ color: '#374151' }}>{p.repName}</span>
                        <span style={{ color: '#64748b' }}>{STATUS_LABEL[p.status] ?? p.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="dp-overlay" onClick={onClose}>
      <div className="dp-modal" dir="rtl" onClick={e => e.stopPropagation()}>
        <div className="dp-modal-head">
          <strong>{title}</strong>
          <button className="dp-modal-x" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="dp-label">
      <span>{label}</span>
      <input type="number" className="dp-input" value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  );
}
