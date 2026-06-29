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

// ── Pharmacy Net visual language: white cards on light-slate background,
// navy as the single accent color, red reserved for true alerts only ──
const PAGE_BG = '#f0f4f8';
const NAVY = '#1e40af';
const TEXT_DARK = '#1e293b';
const TEXT_MUTED = '#64748b';
const BORDER = '#e2e8f0';

const CARD: React.CSSProperties = { background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '14px 16px', marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,.04)' };
const INPUT: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: `1px solid ${BORDER}`, fontSize: 13, color: TEXT_DARK, boxSizing: 'border-box' };
const TH: React.CSSProperties = { padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' };
const TD: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 12.5, color: '#374151' };

function btnPrimary(): React.CSSProperties { return { background: NAVY, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }; }
function btnNeutral(): React.CSSProperties { return { background: '#f1f5f9', color: TEXT_DARK, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }; }
function btnDanger(): React.CSSProperties { return { background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }; }

// Visited cards get a soft green tint, postponed ones a muted/dimmed tint —
// makes the "done vs. still pending" split obvious without extra chrome.
function entryCardStyle(status: Entry['status']): React.CSSProperties {
  if (status === 'visited') return { border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 6, padding: '10px 12px' };
  if (status === 'postponed') return { border: `1px solid ${BORDER}`, background: '#f8fafc', borderRadius: 6, padding: '10px 12px', opacity: 0.85 };
  return { border: '1px solid #f1f5f9', background: '#fff', borderRadius: 6, padding: '10px 12px' };
}

function StatusChip({ status }: { status: Entry['status'] }) {
  const icon = status === 'visited' ? '✓' : status === 'postponed' ? '⏸' : '○';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: status === 'visited' ? NAVY : TEXT_MUTED, border: `1px solid ${status === 'visited' ? NAVY : BORDER}`, borderRadius: 5, padding: '1px 7px' }}>
      {icon} {STATUS_LABEL[status]}
    </span>
  );
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
  // when a manager is browsing a rep's plan, the per-entry actions collapse into a "⋮" menu
  const [actionsMenuFor, setActionsMenuFor] = useState<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

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

  // A manager browsing a rep's plan gets the actions tucked into a menu instead of
  // three always-visible buttons per row — keeps the oversight view uncluttered.
  const viewingOthersPlan = isManager && !!selectedRep;

  const ach = view?.achievement;
  const quota = view?.newDoctorQuota;
  const lowAch = !!(ach && view && ach.percent < view.settings.lowAchievementThreshold);

  // ─── Render ───
  return (
    <div dir="rtl" style={{ fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif', background: PAGE_BG, minHeight: '100vh', padding: '16px 18px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: NAVY, borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: 20 }}>📆</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: TEXT_DARK }}>البلان اليومي</h1>
            <p style={{ margin: 0, fontSize: 12, color: TEXT_MUTED }}>خطة زيارات اليوم ونسبة التحقيق</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {isManager && (
            <select value={selectedRep ?? ''} onChange={e => setSelectedRep(e.target.value ? Number(e.target.value) : null)} style={INPUT}>
              <option value="">— بلاني (نفسي) —</option>
              {subReps.map(s => <option key={s.userId} value={s.userId}>{s.name}</option>)}
            </select>
          )}
          <input type="date" value={date} onChange={e => setDate(e.target.value)} onKeyDown={dateArrowKeyHandler(date, setDate)} style={INPUT} />
          {isCompanyManager && <button onClick={openSettings} style={btnNeutral()}>⚙ إعدادات</button>}
        </div>
      </div>

      {msg && <div style={{ background: '#eef2f6', color: NAVY, padding: '8px 12px', borderRadius: 6, marginBottom: 10, fontSize: 12.5, border: `1px solid ${BORDER}` }}>{msg}</div>}
      {error && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 6, marginBottom: 10, fontSize: 12.5, border: '1px solid #fecaca' }}>{error}</div>}
      {loading && <div style={{ color: TEXT_MUTED, fontSize: 13 }}>جاري التحميل...</div>}

      {isManager && !selectedRep && (
        <div style={CARD}>
          <span style={{ fontSize: 12.5, color: TEXT_MUTED }}>اختر مندوباً من القائمة أعلاه لعرض بلانه اليومي ونسبة تحقيقه والتعليق عليه وتعديله، أو اترك "نفسي" لعرض بلانك.</span>
        </div>
      )}

      {view && (
        <>
          {/* Achievement summary */}
          {ach && (
            <div style={CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                <strong style={{ fontSize: 13.5, color: TEXT_DARK }}>نسبة التحقيق اليومي</strong>
                <span style={{ fontSize: 12.5, color: TEXT_MUTED }}>تمت {ach.visited} من {ach.total} — مؤجل {ach.postponed}</span>
              </div>
              <div style={{ height: 10, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${ach.percent}%`, height: '100%', background: lowAch ? '#dc2626' : NAVY, transition: 'width .3s' }} />
              </div>
              <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 17, color: lowAch ? '#dc2626' : TEXT_DARK, marginTop: 6 }}>{ach.percent}%</div>
              {quota && quota.required > 0 && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: quota.planned >= quota.required ? TEXT_DARK : '#b91c1c' }}>
                  حصة الأطباء الجدد: {quota.planned}/{quota.required} مخطط · {quota.visited} تمت زيارته
                  {quota.planned < quota.required && ' — أقل من الحصة المطلوبة'}
                </div>
              )}
            </div>
          )}

          {/* Add entry tools */}
          <div style={CARD}>
            <strong style={{ fontSize: 13.5, color: TEXT_DARK, display: 'block', marginBottom: 10 }}>إضافة إلى بلان اليوم</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ position: 'relative', flex: '1 1 240px' }}>
                <input value={docSearch} onChange={e => setDocSearch(e.target.value)} placeholder="ابحث عن طبيب لإضافته…"
                  style={{ ...INPUT, width: '100%' }} />
                {filteredDoctors.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.08)', marginTop: 2, maxHeight: 280, overflowY: 'auto' }}>
                    {filteredDoctors.map(d => (
                      <div key={d.id} onClick={() => addDoctor(d.id)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 12.5, borderBottom: '1px solid #f1f5f9' }}>
                        <div style={{ color: TEXT_DARK, fontWeight: 600 }}>{d.name}</div>
                        <div style={{ color: TEXT_MUTED, fontSize: 11, marginTop: 2 }}>
                          {[d.specialty, d.area?.name, d.pharmacyName].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div ref={pharmBoxRef} style={{ position: 'relative', flex: '1 1 200px' }}>
                <input value={pharmName} onChange={e => setPharmName(e.target.value)} onFocus={() => pharmSugg.length > 0 && setPharmOpen(true)}
                  placeholder="اسم صيدلية…" style={{ ...INPUT, width: '100%' }} />
                {pharmOpen && pharmSugg.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.08)', marginTop: 2, maxHeight: 220, overflowY: 'auto' }}>
                    {pharmSugg.map(n => (
                      <div key={n} onMouseDown={() => { setPharmName(n); setPharmOpen(false); addPharmacy(n); }}
                        style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, color: TEXT_DARK, borderBottom: '1px solid #f1f5f9' }}>
                        {n}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <select value={pharmArea} onChange={e => setPharmArea(e.target.value ? Number(e.target.value) : '')} style={INPUT}>
                <option value="">المنطقة (اختياري)</option>
                {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={() => addPharmacy()} style={btnPrimary()}>+ صيدلية</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => loadSuggestions('new')} style={btnNeutral()}>اقترح أطباء جدد</button>
              <button onClick={() => loadSuggestions('carryover')} style={btnNeutral()}>ترحيل مؤجلي أمس</button>
              {suggestMode && <button onClick={() => { setSuggestMode(''); setSuggestions([]); }} style={btnNeutral()}>إغلاق</button>}
            </div>
            {suggestMode && (
              <div style={{ marginTop: 10, borderTop: `1px dashed ${BORDER}`, paddingTop: 10 }}>
                <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 6 }}>
                  {suggestMode === 'new' ? 'أطباء من مناطقك لم تتم زيارتهم بعد:' : 'أطباء أُجّلوا أمس:'}
                </div>
                {suggestions.length === 0 ? <div style={{ fontSize: 12.5, color: '#94a3b8' }}>لا توجد اقتراحات</div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {suggestions.map((s: any) => (
                      <div key={s.doctorId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '7px 10px', borderRadius: 6 }}>
                        <span style={{ fontSize: 12.5, color: TEXT_DARK }}>
                          {s.name}
                          <span style={{ color: TEXT_MUTED }}> · {[s.specialty, s.areaName, s.pharmacyName].filter(Boolean).join(' · ')}</span>
                          {s.postponeReason && <span style={{ color: '#b45309' }}> · {POSTPONE_REASONS[s.postponeReason] ?? s.postponeReason}</span>}
                        </span>
                        <button onClick={() => addDoctor(s.doctorId)} style={btnPrimary()}>أضف</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Reminder: pick the target item for the doctor just added — optional, skippable */}
          {itemPromptEntryId != null && (
            <div style={{ ...CARD, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: TEXT_DARK }}>
                  تمت إضافة <strong>{itemPromptName}</strong> — اختر الايتم المستهدف لهذه الزيارة (اختياري، يمكنك تخطّيه):
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <select value={itemPromptValue} onChange={e => setItemPromptValue(e.target.value ? Number(e.target.value) : '')} style={INPUT}>
                    <option value="">— بدون تحديد —</option>
                    {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </select>
                  <button onClick={confirmItemPrompt} style={btnPrimary()}>تأكيد</button>
                  <button onClick={skipItemPrompt} style={btnNeutral()}>تخطّي</button>
                </div>
              </div>
            </div>
          )}

          {/* Entries list */}
          <div style={CARD}>
            <strong style={{ fontSize: 13.5, color: TEXT_DARK, display: 'block', marginBottom: 10 }}>قائمة اليوم ({view.entries.length})</strong>
            {view.entries.length === 0 ? <div style={{ fontSize: 12.5, color: '#94a3b8' }}>لا توجد أسماء في بلان اليوم بعد.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sortedEntries.map((e, idx) => {
                  const rep = e.doctorId ? repeatByDoctor.get(e.doctorId) : null;
                  const name = e.entryType === 'doctor' ? (e.doctor?.name ?? `#${e.doctorId}`) : e.pharmacyName;
                  const showDivider = e.status !== 'planned' && idx > 0 && sortedEntries[idx - 1].status === 'planned';
                  return (
                    <Fragment key={e.id}>
                      {showDivider && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
                          <div style={{ flex: 1, height: 1, background: BORDER }} />
                          <span style={{ fontSize: 11, color: TEXT_MUTED, whiteSpace: 'nowrap' }}>منتهية (تمت / مؤجلة)</span>
                          <div style={{ flex: 1, height: 1, background: BORDER }} />
                        </div>
                      )}
                      <div style={entryCardStyle(e.status)}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 13.5, color: TEXT_DARK }}>{name}</strong>
                            {e.entryType === 'doctor' && e.doctor?.specialty && <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>· {e.doctor.specialty}</span>}
                            {e.isNewDoctor && <span style={{ fontSize: 11, color: NAVY, border: `1px solid ${NAVY}`, borderRadius: 5, padding: '1px 6px' }}>جديد</span>}
                            {e.status !== 'planned' && <StatusChip status={e.status} />}
                            {e.currentFeedback && <span style={{ fontSize: 11, color: TEXT_MUTED, border: `1px solid ${BORDER}`, borderRadius: 5, padding: '1px 7px' }}>{FEEDBACK_LABELS[e.currentFeedback] ?? e.currentFeedback}</span>}
                            {e.addedByManager && (
                              <span title="أضافه المدير إلى بلانك" style={{ fontSize: 11, color: '#7c2d12', border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 5, padding: '1px 7px' }}>
                                من المدير{e.addedByName ? ` (${e.addedByName})` : ''}
                              </span>
                            )}
                            {rep?.flagged && (
                              <span title={`أيام التخطيط: ${rep.plannedDays.join('، ')} | أيام الزيارة: ${rep.visitedDays.join('، ') || '—'}`}
                                style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', border: '1px solid #fecaca', borderRadius: 5, padding: '1px 7px' }}>
                                مكرر ×{rep.plannedCount}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {viewingOthersPlan ? (
                              <div ref={actionsMenuFor === e.id ? actionsMenuRef : undefined} style={{ position: 'relative' }}>
                                <button onClick={() => setActionsMenuFor(actionsMenuFor === e.id ? null : e.id)} style={btnNeutral()}>⋮</button>
                                {actionsMenuFor === e.id && (
                                  <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 60, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.08)', marginTop: 4, minWidth: 130, overflow: 'hidden' }}>
                                    {e.status === 'planned' && (
                                      <button onClick={() => { setRecordFor(e); setRecordFeedback('writing'); setRecordItemId(e.itemId ?? ''); setActionsMenuFor(null); }}
                                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, color: NAVY }}>
                                        سجّل كول
                                      </button>
                                    )}
                                    {e.status === 'planned' && (
                                      <button onClick={() => { setPostponeFor(e); setPostponeReason('absent'); setPostponeDate(''); setActionsMenuFor(null); }}
                                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, color: TEXT_DARK, borderTop: `1px solid ${BORDER}` }}>
                                        تأجيل
                                      </button>
                                    )}
                                    <button onClick={() => { removeEntry(e.id); setActionsMenuFor(null); }}
                                      style={{ display: 'block', width: '100%', textAlign: 'right', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, color: '#b91c1c', borderTop: `1px solid ${BORDER}` }}>
                                      حذف
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <>
                                {e.status === 'planned' && <button onClick={() => { setRecordFor(e); setRecordFeedback('writing'); setRecordItemId(e.itemId ?? ''); }} style={btnPrimary()}>سجّل كول</button>}
                                {e.status === 'planned' && <button onClick={() => { setPostponeFor(e); setPostponeReason('absent'); setPostponeDate(''); }} style={btnNeutral()}>تأجيل</button>}
                                <button onClick={() => removeEntry(e.id)} style={btnDanger()}>حذف</button>
                              </>
                            )}
                          </div>
                        </div>
                        {e.entryType === 'doctor' && (
                          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span style={{ fontSize: 11, color: TEXT_MUTED, flexShrink: 0 }}>الايتم المستهدف:</span>
                            <select value={e.itemId ?? ''} onChange={ev => setEntryItem(e.id, ev.target.value ? Number(ev.target.value) : '')}
                              style={{ ...INPUT, padding: '2px 8px', fontSize: 11.5, flex: 1, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                              <option value="">— غير محدد —</option>
                              {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                            </select>
                          </div>
                        )}
                        {e.status === 'postponed' && (
                          <div style={{ marginTop: 6, fontSize: 11.5, color: '#92400e' }}>
                            {e.autoPostponed
                              ? 'تأجيل تلقائي: لم يقم المندوب بأي إجراء خلال 24 ساعة'
                              : (e.postponeReason && <>سبب التأجيل: {POSTPONE_REASONS[e.postponeReason] ?? e.postponeReason}{e.postponeNote ? ` — ${e.postponeNote}` : ''}</>)}
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
            <div style={CARD}>
              <strong style={{ fontSize: 13.5, color: TEXT_DARK, display: 'block', marginBottom: 10 }}>الأطباء المكرّرون (آخر 30 يوم)</strong>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ background: NAVY, color: '#fff' }}>
                    <th style={TH}>الطبيب</th><th style={TH}>مرات التخطيط</th>
                    <th style={TH}>أيام التخطيط</th><th style={TH}>أيام الزيارة</th><th style={TH}>آخر نتيجة</th>
                  </tr></thead>
                  <tbody>
                    {repeats.map(r => (
                      <tr key={r.doctorId}>
                        <td style={TD}>{r.flagged && <span style={{ color: '#dc2626', fontWeight: 700 }}>● </span>}{r.name}</td>
                        <td style={{ ...TD, fontWeight: 700 }}>{r.plannedCount}</td>
                        <td style={{ ...TD, color: TEXT_MUTED }}>{r.plannedDays.join('، ')}</td>
                        <td style={{ ...TD, color: TEXT_MUTED }}>{r.visitedDays.join('، ') || '—'}</td>
                        <td style={TD}>{r.lastFeedback ? (FEEDBACK_LABELS[r.lastFeedback] ?? r.lastFeedback) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Postpone analytics — collapsed by default, toggled by its own header */}
          {postpone && postpone.total > 0 && (
            <div style={CARD} ref={postponeBoxRef}>
              <button onClick={() => setPostponeAnalysisOpen(o => !o)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}>
                <strong style={{ fontSize: 13.5, color: TEXT_DARK }}>تحليل أسباب التأجيل (آخر 30 يوم) — {postpone.total}</strong>
                <span style={{ fontSize: 12, color: TEXT_MUTED }}>{postponeAnalysisOpen ? '▲ إغلاق' : '▼ عرض'}</span>
              </button>
              {postponeAnalysisOpen && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                  {Object.entries(POSTPONE_REASONS).map(([k, label]) => (
                    <div key={k} style={{ background: '#f8fafc', border: `1px solid ${BORDER}`, borderRadius: 6, padding: '8px 14px', minWidth: 110 }}>
                      <div style={{ fontSize: 11, color: TEXT_MUTED }}>{label}</div>
                      <div style={{ fontSize: 17, fontWeight: 700, color: TEXT_DARK }}>{postpone.counts[k] ?? 0}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Comments */}
          <div style={CARD}>
            <strong style={{ fontSize: 13.5, color: TEXT_DARK, display: 'block', marginBottom: 10 }}>ملاحظات وتعليقات</strong>
            {view.comments.length === 0 ? <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 8 }}>لا توجد تعليقات.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {view.comments.map(c => (
                  <div key={c.id} style={{ background: '#f8fafc', border: `1px solid ${BORDER}`, padding: '8px 10px', borderRadius: 6 }}>
                    <div style={{ fontSize: 12.5, color: TEXT_DARK }}>{c.content}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{c.by} · {new Date(c.createdAt).toLocaleString('ar-IQ-u-nu-latn')}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="أضف ملاحظة للمندوب…"
                style={{ ...INPUT, flex: 1 }} />
              <button onClick={addComment} style={btnPrimary()}>إرسال</button>
            </div>
          </div>
        </>
      )}

      {/* Record-visit modal */}
      {recordFor && (
        <Modal title="تسجيل كول" onClose={() => setRecordFor(null)}>
          <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 10 }}>{recordFor.entryType === 'doctor' ? (recordFor.doctor?.name ?? 'طبيب') : recordFor.pharmacyName}</div>
          {recordFor.entryType === 'doctor' && (
            <>
              <div style={{ marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: TEXT_MUTED, display: 'block', marginBottom: 6 }}>النتيجة (feedback)</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {FEEDBACK_OPTIONS.map(f => (
                    <button key={f} type="button" onClick={() => setRecordFeedback(f)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                        minWidth: 72, padding: '10px 8px', borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${recordFeedback === f ? NAVY : BORDER}`,
                        background: recordFeedback === f ? '#eff6ff' : '#fff',
                        color: recordFeedback === f ? NAVY : TEXT_DARK,
                        fontWeight: recordFeedback === f ? 700 : 500,
                      }}>
                      <span style={{ fontSize: 20 }}>{FEEDBACK_ICONS[f]}</span>
                      <span style={{ fontSize: 11 }}>{FEEDBACK_LABELS[f]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <label style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: TEXT_MUTED }}>الايتم المستهدف (اختياري)</span>
                <select value={recordItemId} onChange={e => setRecordItemId(e.target.value ? Number(e.target.value) : '')} style={{ ...INPUT, width: '100%', marginTop: 4 }}>
                  <option value="">— بدون تحديد —</option>
                  {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                </select>
              </label>
            </>
          )}
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: TEXT_MUTED }}>ملاحظة (اختياري)</span>
            <input value={recordNote} onChange={e => setRecordNote(e.target.value)} style={{ ...INPUT, width: '100%', marginTop: 4 }} />
          </label>
          <button onClick={submitRecord} style={{ ...btnPrimary(), width: '100%', padding: '9px' }}>تأكيد التسجيل (مع الموقع)</button>
        </Modal>
      )}

      {/* Postpone modal */}
      {postponeFor && (
        <Modal title="تأجيل الزيارة" onClose={() => setPostponeFor(null)}>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: TEXT_MUTED, display: 'block', marginBottom: 6 }}>السبب</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(POSTPONE_REASONS).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setPostponeReason(k)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    minWidth: 78, padding: '10px 8px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${postponeReason === k ? NAVY : BORDER}`,
                    background: postponeReason === k ? '#eff6ff' : '#fff',
                    color: postponeReason === k ? NAVY : TEXT_DARK,
                    fontWeight: postponeReason === k ? 700 : 500,
                  }}>
                  <span style={{ fontSize: 20 }}>{POSTPONE_REASON_ICONS[k]}</span>
                  <span style={{ fontSize: 11 }}>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: TEXT_MUTED }}>تأجيل إلى تاريخ جديد (اختياري) — سيُضاف الاسم تلقائياً لبلان ذلك اليوم</span>
            <input type="date" min={todayLocal()} value={postponeDate} onChange={e => setPostponeDate(e.target.value)}
              onClick={e => { try { (e.currentTarget as any).showPicker?.(); } catch { /* unsupported browser — falls back to native input */ } }}
              onKeyDown={dateArrowKeyHandler(postponeDate, setPostponeDate, todayLocal())}
              style={{ ...INPUT, width: '100%', marginTop: 4, cursor: 'pointer' }} />
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: TEXT_MUTED }}>ملاحظة (اختياري)</span>
            <input value={postponeNote} onChange={e => setPostponeNote(e.target.value)} style={{ ...INPUT, width: '100%', marginTop: 4 }} />
          </label>
          <button onClick={submitPostpone} style={{ ...btnPrimary(), width: '100%', padding: '9px' }}>تأكيد التأجيل</button>
        </Modal>
      )}

      {/* Settings modal */}
      {settingsOpen && settingsDraft && (
        <Modal title="إعدادات البلان اليومي (مدير الشركة)" onClose={() => setSettingsOpen(false)}>
          <NumField label="عدد أيام نافذة التكرار" value={settingsDraft.repeatWindowDays} onChange={v => setSettingsDraft({ ...settingsDraft, repeatWindowDays: v })} />
          <NumField label="عدد مرات التكرار للتنبيه" value={settingsDraft.repeatThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, repeatThreshold: v })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 12.5, color: TEXT_DARK }}>
            <input type="checkbox" checked={settingsDraft.alertOnRepeatAfterPositive} onChange={e => setSettingsDraft({ ...settingsDraft, alertOnRepeatAfterPositive: e.target.checked })} />
            تنبيه عند إعادة طبيب بعد زيارة ناجحة / تنزيل طلبية
          </label>
          <NumField label="حد الإنجاز المنخفض % (للإشعار)" value={settingsDraft.lowAchievementThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, lowAchievementThreshold: v })} />
          <NumField label="حصة الأطباء الجدد يومياً (0 = معطّل)" value={settingsDraft.minNewDoctorsPerDay} onChange={v => setSettingsDraft({ ...settingsDraft, minNewDoctorsPerDay: v })} />
          <button onClick={saveSettings} style={{ ...btnPrimary(), width: '100%', padding: '9px', marginTop: 8 }}>حفظ الإعدادات</button>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 10, padding: 18, width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,.18)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 14.5, color: TEXT_DARK }}>{title}</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ fontSize: 12, color: TEXT_MUTED }}>{label}</span>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))} style={{ ...INPUT, width: '100%', marginTop: 4 }} />
    </label>
  );
}
