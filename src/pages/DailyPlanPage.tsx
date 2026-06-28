import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

// ─── Types ───────────────────────────────────────────────────
interface Doctor { id: number; name: string; specialty?: string | null; pharmacyName?: string | null; area?: { id: number; name: string } | null; areaId?: number | null; }
interface Area { id: number; name: string; }
interface Entry {
  id: number; entryType: 'doctor' | 'pharmacy'; doctorId: number | null; pharmacyName: string | null;
  areaId: number | null; status: 'planned' | 'visited' | 'postponed';
  postponeReason: string | null; postponeNote: string | null; isNewDoctor: boolean;
  doctor?: { id: number; name: string; specialty?: string | null; pharmacyName?: string | null } | null;
  area?: { id: number; name: string } | null; currentFeedback?: string | null;
}
interface Achievement { total: number; visited: number; postponed: number; planned: number; percent: number; visitedNames: string[]; pendingNames: string[]; }
interface Quota { required: number; planned: number; visited: number; }
interface Settings { repeatWindowDays: number; repeatThreshold: number; alertOnRepeatAfterPositive: boolean; lowAchievementThreshold: number; minNewDoctorsPerDay: number; }
interface Comment { id: number; content: string; createdAt: string; by: string; userId: number; }
interface PlanView { plan: { id: number; planDate: string; status: string; notes: string | null; isManagerView: boolean }; entries: Entry[]; achievement: Achievement; newDoctorQuota: Quota; settings: Settings; comments: Comment[]; }
interface RepeatRow { doctorId: number; name: string; specialty?: string | null; plannedCount: number; plannedDays: string[]; visitedDays: string[]; lastFeedback: string | null; hadPositive: boolean; flagged: boolean; }
interface SubRep { userId: number; name: string; linkedRepId: number | null; }

const FEEDBACK_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  writing: { label: 'يكتب', color: '#166534', bg: '#dcfce7' },
  stocked: { label: 'نزل الايتم', color: '#1e40af', bg: '#dbeafe' },
  interested: { label: 'مهتم', color: '#7c3aed', bg: '#ede9fe' },
  not_interested: { label: 'غير مهتم', color: '#991b1b', bg: '#fee2e2' },
  unavailable: { label: 'غير متوفر', color: '#92400e', bg: '#fef3c7' },
  pending: { label: 'معلق', color: '#475569', bg: '#f1f5f9' },
};
const FEEDBACK_OPTIONS = ['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'];
const POSTPONE_REASONS: Record<string, string> = { absent: 'الطبيب غير موجود', traveling: 'مسافر', declined: 'اعتذر عن الاستقبال', other: 'سبب آخر' };

const STATUS_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  planned: { label: 'مخطط', color: '#475569', bg: '#f1f5f9' },
  visited: { label: 'تمت الزيارة', color: '#166534', bg: '#dcfce7' },
  postponed: { label: 'مؤجل', color: '#92400e', bg: '#fef3c7' },
};

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

const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600 });

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

  // doctor/area pickers (self mode)
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [docSearch, setDocSearch] = useState('');
  const [pharmName, setPharmName] = useState('');
  const [pharmArea, setPharmArea] = useState<number | ''>('');

  // suggestions
  const [suggestMode, setSuggestMode] = useState<'' | 'new' | 'carryover'>('');
  const [suggestions, setSuggestions] = useState<any[]>([]);

  // record-visit modal
  const [recordFor, setRecordFor] = useState<Entry | null>(null);
  const [recordFeedback, setRecordFeedback] = useState('writing');
  const [recordNote, setRecordNote] = useState('');
  // postpone modal
  const [postponeFor, setPostponeFor] = useState<Entry | null>(null);
  const [postponeReason, setPostponeReason] = useState('absent');
  const [postponeNote, setPostponeNote] = useState('');
  // comments / settings
  const [commentText, setCommentText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);

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

  // ── Load own doctors + areas (for the self-mode picker) ──
  useEffect(() => {
    if (!token) return;
    Promise.all([
      fetch(`${API}/api/doctors`, { headers: H() }).then(r => r.ok ? r.json() : []),
      fetch(`${API}/api/areas`, { headers: H() }).then(r => r.ok ? r.json() : []),
    ]).then(([dj, aj]) => {
      setDoctors(Array.isArray(dj) ? dj : (dj.data ?? dj.doctors ?? []));
      setAreas(Array.isArray(aj) ? aj : (aj.data ?? []));
    }).catch(() => {});
  }, [token, H]);

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

  const flaggedDoctorIds = useMemo(() => new Set(repeats.filter(r => r.flagged).map(r => r.doctorId)), [repeats]);
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
        flash(`⚠️ تنبيه تكرار: الطبيب مخطط في ${rp.count} أيام${rp.hadPositive ? ' وسبق زيارته بنجاح' : ''} — تم إعلام المدير.`);
      } else flash('تمت الإضافة');
      setDocSearch('');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const addPharmacy = async () => {
    if (!planId || !pharmName.trim()) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/${planId}/entries`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ entryType: 'pharmacy', pharmacyName: pharmName.trim(), areaId: pharmArea || undefined, repUserId: selectedRep ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر الإضافة');
      setPharmName(''); setPharmArea(''); flash('تمت إضافة الصيدلية');
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
      if (recordFor.entryType === 'doctor') body.feedback = recordFeedback;
      const r = await fetch(`${API}/api/daily-plans/${planId}/entries/${recordFor.id}/record-visit`, {
        method: 'POST', headers: H(), body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || j.message || 'تعذّر التسجيل');
      setRecordFor(null); setRecordNote(''); setRecordFeedback('writing'); flash('تم تسجيل الكول');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const submitPostpone = async () => {
    if (!postponeFor) return;
    try {
      const r = await fetch(`${API}/api/daily-plans/entries/${postponeFor.id}`, {
        method: 'PATCH', headers: H(),
        body: JSON.stringify({ status: 'postponed', postponeReason, postponeNote, repUserId: selectedRep ?? undefined }),
      });
      if (!r.ok) throw new Error('تعذّر التأجيل');
      setPostponeFor(null); setPostponeNote(''); setPostponeReason('absent'); flash('تم التأجيل');
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const loadSuggestions = async (mode: 'new' | 'carryover') => {
    setSuggestMode(mode); setSuggestions([]);
    try {
      const r = await fetch(`${API}/api/daily-plans/suggest?mode=${mode}&date=${date}&${repQS}`, { headers: H() });
      const j = await r.json();
      setSuggestions(j.data ?? []);
    } catch { setSuggestions([]); }
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

  const ach = view?.achievement;
  const quota = view?.newDoctorQuota;

  // ─── Render ───
  return (
    <div style={{ minHeight: '100%', background: '#f8fafc', padding: 16, direction: 'rtl' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <h1 style={{ fontSize: 19, fontWeight: 800, color: '#0f172a', margin: 0 }}>📆 البلان اليومي</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {isManager && (
            <select value={selectedRep ?? ''} onChange={e => setSelectedRep(e.target.value ? Number(e.target.value) : null)}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13 }}>
              <option value="">— بلاني (نفسي) —</option>
              {subReps.map(s => <option key={s.userId} value={s.userId}>{s.name}</option>)}
            </select>
          )}
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13 }} />
          {isCompanyManager && <button onClick={openSettings} style={btn('#475569')}>⚙️ إعدادات</button>}
        </div>
      </div>

      {msg && <div style={{ background: '#ecfdf5', color: '#065f46', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{msg}</div>}
      {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{error}</div>}
      {loading && <div style={{ color: '#64748b', fontSize: 13 }}>جاري التحميل…</div>}

      {isManager && !selectedRep && (
        <div style={{ background: '#eff6ff', color: '#1e40af', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          اختر مندوباً من القائمة أعلاه لعرض بلانه اليومي ونسبة تحقيقه، أو اترك "نفسي" لعرض بلانك.
        </div>
      )}

      {view && (
        <>
          {/* Achievement summary */}
          {ach && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                <strong style={{ fontSize: 14, color: '#0f172a' }}>نسبة التحقيق اليومي</strong>
                <span style={{ fontSize: 13, color: '#475569' }}>تمت {ach.visited} من {ach.total} — مؤجل {ach.postponed}</span>
              </div>
              <div style={{ height: 12, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${ach.percent}%`, height: '100%', background: ach.percent >= 70 ? '#16a34a' : ach.percent >= 40 ? '#f59e0b' : '#ef4444', transition: 'width .3s' }} />
              </div>
              <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 18, color: '#0f172a', marginTop: 6 }}>{ach.percent}%</div>
              {quota && quota.required > 0 && (
                <div style={{ marginTop: 8, fontSize: 13, color: quota.planned >= quota.required ? '#166534' : '#b45309' }}>
                  حصة الأطباء الجدد: {quota.planned}/{quota.required} مخطط · {quota.visited} تمت زيارته
                  {quota.planned < quota.required && ' ⚠️ أقل من الحصة المطلوبة'}
                </div>
              )}
            </div>
          )}

          {/* Add entry tools */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <strong style={{ fontSize: 14, color: '#0f172a', display: 'block', marginBottom: 8 }}>إضافة إلى بلان اليوم</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {!selectedRep && (
                <div style={{ position: 'relative', flex: '1 1 240px' }}>
                  <input value={docSearch} onChange={e => setDocSearch(e.target.value)} placeholder="🔎 ابحث عن طبيب لإضافته…"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box' }} />
                  {filteredDoctors.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.1)', marginTop: 2 }}>
                      {filteredDoctors.map(d => (
                        <div key={d.id} onClick={() => addDoctor(d.id)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}>
                          {d.name} {d.specialty && <span style={{ color: '#94a3b8' }}>· {d.specialty}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <input value={pharmName} onChange={e => setPharmName(e.target.value)} placeholder="🏥 اسم صيدلية…"
                style={{ flex: '1 1 160px', padding: '8px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box' }} />
              <select value={pharmArea} onChange={e => setPharmArea(e.target.value ? Number(e.target.value) : '')}
                style={{ padding: '8px 10px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13 }}>
                <option value="">المنطقة (اختياري)</option>
                {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={addPharmacy} style={btn('#0ea5e9')}>+ صيدلية</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => loadSuggestions('new')} style={btn('#6366f1')}>💡 اقترح أطباء جدد</button>
              <button onClick={() => loadSuggestions('carryover')} style={btn('#f59e0b')}>↩️ ترحيل مؤجلي أمس</button>
              {suggestMode && <button onClick={() => { setSuggestMode(''); setSuggestions([]); }} style={btn('#e2e8f0', '#334155')}>إغلاق</button>}
            </div>
            {suggestMode && (
              <div style={{ marginTop: 10, borderTop: '1px dashed #e2e8f0', paddingTop: 10 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                  {suggestMode === 'new' ? 'أطباء من مناطقك لم تتم زيارتهم بعد:' : 'أطباء أُجّلوا أمس:'}
                </div>
                {suggestions.length === 0 ? <div style={{ fontSize: 13, color: '#94a3b8' }}>لا توجد اقتراحات</div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {suggestions.map((s: any) => (
                      <div key={s.doctorId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '6px 10px', borderRadius: 8 }}>
                        <span style={{ fontSize: 13 }}>{s.name} {s.specialty && <span style={{ color: '#94a3b8' }}>· {s.specialty}</span>} {s.postponeReason && <span style={{ color: '#b45309' }}>· {POSTPONE_REASONS[s.postponeReason] ?? s.postponeReason}</span>}</span>
                        <button onClick={() => addDoctor(s.doctorId)} style={btn('#16a34a')}>أضف</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Entries list */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <strong style={{ fontSize: 14, color: '#0f172a', display: 'block', marginBottom: 10 }}>قائمة اليوم ({view.entries.length})</strong>
            {view.entries.length === 0 ? <div style={{ fontSize: 13, color: '#94a3b8' }}>لا توجد أسماء في بلان اليوم بعد.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {view.entries.map(e => {
                  const chip = STATUS_CHIP[e.status];
                  const fb = e.currentFeedback ? FEEDBACK_LABELS[e.currentFeedback] : null;
                  const rep = e.doctorId ? repeatByDoctor.get(e.doctorId) : null;
                  const name = e.entryType === 'doctor' ? (e.doctor?.name ?? `#${e.doctorId}`) : e.pharmacyName;
                  return (
                    <div key={e.id} style={{ border: '1px solid #f1f5f9', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 16 }}>{e.entryType === 'doctor' ? '🩺' : '🏥'}</span>
                          <strong style={{ fontSize: 14, color: '#0f172a' }}>{name}</strong>
                          {e.entryType === 'doctor' && e.doctor?.specialty && <span style={{ fontSize: 12, color: '#94a3b8' }}>· {e.doctor.specialty}</span>}
                          {e.isNewDoctor && <span style={{ fontSize: 11, background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: 6 }}>جديد</span>}
                          <span style={{ fontSize: 11, background: chip.bg, color: chip.color, padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>{chip.label}</span>
                          {fb && <span style={{ fontSize: 11, background: fb.bg, color: fb.color, padding: '2px 8px', borderRadius: 6 }}>{fb.label}</span>}
                          {rep?.flagged && (
                            <span title={`أيام التخطيط: ${rep.plannedDays.join('، ')} | أيام الزيارة: ${rep.visitedDays.join('، ') || '—'}`}
                              style={{ fontSize: 11, background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>
                              ⚠️ مكرر ×{rep.plannedCount}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {e.status !== 'visited' && <button onClick={() => { setRecordFor(e); setRecordFeedback('writing'); }} style={btn('#16a34a')}>📞 سجّل كول</button>}
                          {e.status !== 'visited' && <button onClick={() => { setPostponeFor(e); setPostponeReason('absent'); }} style={btn('#f59e0b')}>⏸ تأجيل</button>}
                          <button onClick={() => removeEntry(e.id)} style={btn('#ef4444')}>🗑</button>
                        </div>
                      </div>
                      {e.status === 'postponed' && e.postponeReason && (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>سبب التأجيل: {POSTPONE_REASONS[e.postponeReason] ?? e.postponeReason}{e.postponeNote ? ` — ${e.postponeNote}` : ''}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Repeats report */}
          {repeats.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <strong style={{ fontSize: 14, color: '#0f172a', display: 'block', marginBottom: 10 }}>🔁 الأطباء المكرّرون (آخر 30 يوم)</strong>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ color: '#64748b', textAlign: 'right' }}>
                    <th style={{ padding: '4px 8px' }}>الطبيب</th><th style={{ padding: '4px 8px' }}>مرات التخطيط</th>
                    <th style={{ padding: '4px 8px' }}>أيام التخطيط</th><th style={{ padding: '4px 8px' }}>أيام الزيارة</th><th style={{ padding: '4px 8px' }}>آخر نتيجة</th>
                  </tr></thead>
                  <tbody>
                    {repeats.map(r => (
                      <tr key={r.doctorId} style={{ borderTop: '1px solid #f1f5f9', background: r.flagged ? '#fff7ed' : undefined }}>
                        <td style={{ padding: '6px 8px' }}>{r.flagged && '⚠️ '}{r.name}</td>
                        <td style={{ padding: '6px 8px', fontWeight: 700 }}>{r.plannedCount}</td>
                        <td style={{ padding: '6px 8px', color: '#64748b' }}>{r.plannedDays.join('، ')}</td>
                        <td style={{ padding: '6px 8px', color: '#64748b' }}>{r.visitedDays.join('، ') || '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{r.lastFeedback ? (FEEDBACK_LABELS[r.lastFeedback]?.label ?? r.lastFeedback) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Postpone analytics */}
          {postpone && postpone.total > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <strong style={{ fontSize: 14, color: '#0f172a', display: 'block', marginBottom: 10 }}>📊 تحليل أسباب التأجيل (آخر 30 يوم) — {postpone.total}</strong>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {Object.entries(POSTPONE_REASONS).map(([k, label]) => (
                  <div key={k} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 14px', minWidth: 110 }}>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>{postpone.counts[k] ?? 0}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14 }}>
            <strong style={{ fontSize: 14, color: '#0f172a', display: 'block', marginBottom: 10 }}>💬 ملاحظات وتعليقات</strong>
            {view.comments.length === 0 ? <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>لا توجد تعليقات.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {view.comments.map(c => (
                  <div key={c.id} style={{ background: '#f8fafc', padding: '8px 10px', borderRadius: 8 }}>
                    <div style={{ fontSize: 13, color: '#0f172a' }}>{c.content}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{c.by} · {new Date(c.createdAt).toLocaleString('ar-IQ-u-nu-latn')}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="أضف ملاحظة للمندوب…"
                style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box' }} />
              <button onClick={addComment} style={btn('#1e40af')}>إرسال</button>
            </div>
          </div>
        </>
      )}

      {/* Record-visit modal */}
      {recordFor && (
        <Modal title="تسجيل كول" onClose={() => setRecordFor(null)}>
          <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>{recordFor.entryType === 'doctor' ? (recordFor.doctor?.name ?? 'طبيب') : recordFor.pharmacyName}</div>
          {recordFor.entryType === 'doctor' && (
            <label style={{ display: 'block', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: '#64748b' }}>النتيجة (feedback)</span>
              <select value={recordFeedback} onChange={e => setRecordFeedback(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1.5px solid #e2e8f0', marginTop: 4 }}>
                {FEEDBACK_OPTIONS.map(f => <option key={f} value={f}>{FEEDBACK_LABELS[f].label}</option>)}
              </select>
            </label>
          )}
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>ملاحظة (اختياري)</span>
            <input value={recordNote} onChange={e => setRecordNote(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1.5px solid #e2e8f0', marginTop: 4, boxSizing: 'border-box' }} />
          </label>
          <button onClick={submitRecord} style={{ ...btn('#16a34a'), width: '100%', padding: '10px' }}>تأكيد التسجيل (مع الموقع)</button>
        </Modal>
      )}

      {/* Postpone modal */}
      {postponeFor && (
        <Modal title="تأجيل الزيارة" onClose={() => setPostponeFor(null)}>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>السبب</span>
            <select value={postponeReason} onChange={e => setPostponeReason(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1.5px solid #e2e8f0', marginTop: 4 }}>
              {Object.entries(POSTPONE_REASONS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>ملاحظة (اختياري)</span>
            <input value={postponeNote} onChange={e => setPostponeNote(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1.5px solid #e2e8f0', marginTop: 4, boxSizing: 'border-box' }} />
          </label>
          <button onClick={submitPostpone} style={{ ...btn('#f59e0b'), width: '100%', padding: '10px' }}>تأكيد التأجيل</button>
        </Modal>
      )}

      {/* Settings modal */}
      {settingsOpen && settingsDraft && (
        <Modal title="إعدادات البلان اليومي (مدير الشركة)" onClose={() => setSettingsOpen(false)}>
          <NumField label="عدد أيام نافذة التكرار" value={settingsDraft.repeatWindowDays} onChange={v => setSettingsDraft({ ...settingsDraft, repeatWindowDays: v })} />
          <NumField label="عدد مرات التكرار للتنبيه" value={settingsDraft.repeatThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, repeatThreshold: v })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13 }}>
            <input type="checkbox" checked={settingsDraft.alertOnRepeatAfterPositive} onChange={e => setSettingsDraft({ ...settingsDraft, alertOnRepeatAfterPositive: e.target.checked })} />
            تنبيه عند إعادة طبيب بعد زيارة ناجحة / تنزيل طلبية
          </label>
          <NumField label="حد الإنجاز المنخفض % (للإشعار)" value={settingsDraft.lowAchievementThreshold} onChange={v => setSettingsDraft({ ...settingsDraft, lowAchievementThreshold: v })} />
          <NumField label="حصة الأطباء الجدد يومياً (0 = معطّل)" value={settingsDraft.minNewDoctorsPerDay} onChange={v => setSettingsDraft({ ...settingsDraft, minNewDoctorsPerDay: v })} />
          <button onClick={saveSettings} style={{ ...btn('#1e40af'), width: '100%', padding: '10px', marginTop: 8 }}>حفظ الإعدادات</button>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 18, width: '100%', maxWidth: 420, direction: 'rtl' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 15, color: '#0f172a' }}>{title}</strong>
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
      <span style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1.5px solid #e2e8f0', marginTop: 4, boxSizing: 'border-box' }} />
    </label>
  );
}
