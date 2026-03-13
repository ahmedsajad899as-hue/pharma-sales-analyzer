import { useEffect, useRef, useState } from 'react';
import type { PageId } from '../App';
import AnalysisRenderer from '../components/AnalysisRenderer';
import DailyCallsMap, { type VisitPoint } from '../components/DailyCallsMap';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface Stats { sciRepsCount: number; filesCount: number; areasCount: number; totalSales: number; totalReturns: number; }
interface UploadedFile { id: number; originalName: string; rowCount: number; uploadedAt: string; _count?: { sales: number }; }
interface FileMonetary { id: number; name: string; salesValue: number; returnsValue: number; }
interface ActiveStats { totalSalesValue: number; totalReturnsValue: number; files: FileMonetary[]; }
interface DailyRep { id: number; name: string; }
interface DailyCallsData { visits: VisitPoint[]; reps: DailyRep[]; total: number; }

export default function DashboardPage({ onNavigate, activeFileIds, onFileActivated }: { onNavigate: (p: PageId) => void; activeFileIds: number[]; onFileActivated: (id: number) => void }) {
  const { token, user, hasFeature } = useAuth();
  const { t } = useLanguage();
  const authH = () => ({ Authorization: `Bearer ${token}` });
  const [stats, setStats]         = useState<Stats>({ sciRepsCount: 0, filesCount: 0, areasCount: 0, totalSales: 0, totalReturns: 0 });
  const [loading, setLoading]     = useState(true);

  // Active-files monetary stats
  const [activeStats, setActiveStats]       = useState<ActiveStats>({ totalSalesValue: 0, totalReturnsValue: 0, files: [] });
  const [activeStatsLoading, setActiveStatsLoading] = useState(false);
  const [openDropdown, setOpenDropdown]     = useState<'sales' | 'returns' | 'net' | null>(null);
  const [dropdownPos, setDropdownPos]       = useState<{ top: number; left: number; width: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Files panel
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles]         = useState<UploadedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Areas panel
  const [showAreas, setShowAreas]     = useState(false);
  const [areas, setAreas]             = useState<{ id: number; name: string }[]>([]);
  const [areasLoading, setAreasLoading] = useState(false);
  const [areaSearch, setAreaSearch]   = useState('');

  // Per-file analysis
  const [analyzeFile, setAnalyzeFile]   = useState<UploadedFile | null>(null);
  const [analysisText, setAnalysisText] = useState('');
  const [analyzeLoading, setAnalyzeLoading] = useState(false);

  // ── Daily Calls ───────────────────────────────────────────
  const _todayLocal = new Date();
  const todayStr = `${_todayLocal.getFullYear()}-${String(_todayLocal.getMonth() + 1).padStart(2, '0')}-${String(_todayLocal.getDate()).padStart(2, '0')}`;
  const [callsDateFrom, setCallsDateFrom] = useState<string>(todayStr);
  const [callsDateTo,   setCallsDateTo]   = useState<string>(todayStr);
  const [callsRepId, setCallsRepId]       = useState<number | ''>('');
  const [callsData, setCallsData]       = useState<DailyCallsData | null>(null);
  const [callsLoading, setCallsLoading] = useState(false);
  const [showMap, setShowMap]           = useState(false);
  const isManagerOrAdmin = useAuth().isManagerOrAdmin;
  const isScientificRep  = ['scientific_rep', 'team_leader', 'supervisor'].includes(user?.role ?? '');
  const [likingVisit, setLikingVisit]   = useState<number | null>(null);
  const [showLikersId, setShowLikersId] = useState<number | null>(null);
  const likeTimer = useRef<any>(null);

  // ── Quick Call Log ──────────────────────────────────────────
  const [showCallLog, setShowCallLog]         = useState(false);
  const [activePlan, setActivePlan]           = useState<any>(null);
  const [clDoctor, setClDoctor]               = useState('');
  const [clSuggestions, setClSuggestions]     = useState<any[]>([]);
  const [clShowSugg, setClShowSugg]           = useState(false);
  const [clSelectedEntry, setClSelectedEntry] = useState<any>(null);
  const [clNotInPlan, setClNotInPlan]         = useState(false);
  const [clAddToPlan, setClAddToPlan]         = useState(false);
  const [clOtherDocId, setClOtherDocId]       = useState<number | null>(null);
  const [clOtherDoc, setClOtherDoc]           = useState<any>(null);     // catalog doctor full object
  const [clManualMode, setClManualMode]       = useState(false);         // no match anywhere
  const [clManualSpecialty, setClManualSpecialty] = useState('');
  const [clManualPharmacy, setClManualPharmacy]   = useState('');
  const [clManualAreaId, setClManualAreaId]       = useState('');
  const [clAreas, setClAreas]                 = useState<any[]>([]);
  const [clItemId, setClItemId]               = useState('');
  const [clItemName, setClItemName]           = useState('');
  const [clItemSugg, setClItemSugg]           = useState<any[]>([]);
  const [clItemShowSugg, setClItemShowSugg]   = useState(false);
  const [clAllItems, setClAllItems]           = useState<any[]>([]);
  const [clFeedback, setClFeedback]           = useState('pending');
  const [clNotes, setClNotes]                 = useState('');
  const [clSaving, setClSaving]               = useState(false);
  const [clError, setClError]                 = useState('');
  const [clNow, setClNow]                     = useState('');
  const [clLat, setClLat]                     = useState<number | null>(null);
  const [clLng, setClLng]                     = useState<number | null>(null);
  const [clAccuracy, setClAccuracy]           = useState<number | null>(null);
  const [clGpsStatus, setClGpsStatus]         = useState<'idle'|'getting'|'got'|'denied'>('idle');
  const [clGpsWarning, setClGpsWarning]         = useState(false); // show GPS alert before submit
  const clTimerRef = useRef<any>(null);
  const clGpsWatchRef = useRef<number | null>(null);
  const clGpsBestAccRef = useRef<number>(Infinity);
  // ── Call Type (doctor / pharmacy) ─────────────────────────
  const [callType, setCallType]               = useState<'doctor' | 'pharmacy'>('doctor');
  const [isDoubleVisit, setIsDoubleVisit]     = useState(false);
  // ── Pharmacy Call Fields ───────────────────────────────────
  const [clPharmacyName, setClPharmacyName]       = useState('');
  const [clPharmacyAreaId, setClPharmacyAreaId]   = useState('');
  const [clPharmacyAreaName, setClPharmacyAreaName] = useState('');
  interface PharmacyItem { tempId: number; itemId: string; itemName: string; notes: string; showSugg: boolean; sugg: any[]; }
  const [clPharmacyItems, setClPharmacyItems]     = useState<PharmacyItem[]>([{ tempId: 1, itemId: '', itemName: '', notes: '', showSugg: false, sugg: [] }]);
  const clPharmacyItemCounter = useRef(2);
  const [clPharmacyAreaSugg, setClPharmacyAreaSugg]         = useState<any[]>([]);
  const [clPharmacyAreaShowSugg, setClPharmacyAreaShowSugg] = useState(false);
  const [clPharmacyNameSugg, setClPharmacyNameSugg]         = useState<string[]>([]);
  const [clPharmacyNameShowSugg, setClPharmacyNameShowSugg] = useState(false);
  const [clPharmacyIsNew, setClPharmacyIsNew]               = useState(false);
  // ── Calls list filter / single-visit map ──────────────────
  const [mapSingleVisit, setMapSingleVisit] = useState<VisitPoint | null>(null);
  const [fSearch, setFSearch]               = useState('');
  const [fType, setFType]                   = useState<'all' | 'doctor' | 'pharmacy'>('all');
  const [fDouble, setFDouble]               = useState(false);
  // ── Voice ──────────────────────────────────────────────────
  const [voiceListening, setVoiceListening]   = useState(false);
  const [voiceParsing, setVoiceParsing]       = useState(false);
  const [voiceOverlay, setVoiceOverlay]       = useState(false);
  const [voiceReady, setVoiceReady]           = useState(false); // panel open, not recording yet
  const [voiceError, setVoiceError]           = useState('');
  const voiceMediaRef  = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartRef  = useRef<number>(0);
  const voiceAutoStop  = useRef<any>(null);

  // ── Commercial Rep dashboard state ─────────────────────────
  const isCommercialRep = user?.role === 'commercial_rep';
  interface CommRepDash {
    monthlySales: number; monthlyReturns: number; netSales: number;
    myAreas: { id: number; name: string }[];
    sciReps: { id: number; name: string; company: string; phone: string; areas: string[] }[];
    salesByCompany: { name: string; total: number }[];
  }
  const [commDash, setCommDash]               = useState<CommRepDash | null>(null);
  const [commDashLoading, setCommDashLoading] = useState(false);
  const [commDashError, setCommDashError]     = useState<string | null>(null);
  const [showSciRepsPanel, setShowSciRepsPanel] = useState(false);
  const [showMyAreasPanel, setShowMyAreasPanel] = useState(false);
  const [showSalesBreakdown, setShowSalesBreakdown] = useState<'sales' | 'returns' | 'net' | null>(null);
  const now0 = new Date();
  const [commDashMonth, setCommDashMonth] = useState<{ month: number; year: number } | null>(() => ({
    month: now0.getMonth() + 1, year: now0.getFullYear(),
  }));

  const loadDailyCalls = (dateFrom: string, dateTo: string, repId: number | '') => {
    setCallsLoading(true);
    const params = new URLSearchParams({ dateFrom, dateTo });
    if (repId) params.set('repId', String(repId));
    fetch(`/api/doctor-visits/daily?${params}`, { headers: authH() })
      .then(r => r.json())
      .then(json => { if (json.success) setCallsData(json.data); })
      .catch(() => {})
      .finally(() => setCallsLoading(false));
  };

  // Load commercial rep dashboard data
  useEffect(() => {
    if (!isCommercialRep) return;
    setCommDashLoading(true);
    setCommDashError(null);
    const params = commDashMonth ? `?month=${commDashMonth.month}&year=${commDashMonth.year}` : '';
    fetch(`/api/commercial/rep-dashboard${params}`, { headers: authH() })
      .then(r => { if (!r.ok) throw new Error(`خطأ ${r.status}`); return r.json(); })
      .then(data => setCommDash(data))
      .catch(e => setCommDashError(e.message))
      .finally(() => setCommDashLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommercialRep, token, commDashMonth]);

  const toggleDashLike = async (visitId: number) => {
    if (likingVisit === visitId) return;
    setLikingVisit(visitId);
    try {
      const res = await fetch(`/api/monthly-plans/visits/${visitId}/like`, { method: 'POST', headers: { ...authH(), 'Content-Type': 'application/json' } });
      if (res.ok) {
        const { likes } = await res.json();
        setCallsData(prev => prev ? { ...prev, visits: prev.visits.map(v => v.id === visitId ? { ...v, likes } : v) } : prev);
      }
    } finally { setLikingVisit(null); }
  };

  useEffect(() => { loadDailyCalls(todayStr, todayStr, ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // AI assistant page-action listener
  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent).detail || {};
      switch (action) {
        case 'open-call-log':   setShowCallLog(true); break;
        case 'open-voice-call': setShowCallLog(true); setVoiceOverlay(true); setVoiceReady(true); break;
        case 'open-map':        setShowMap(true); break;
      }
    };
    window.addEventListener('ai-page-action', handler);
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  // Load active plan for scientific rep (used by Quick Call Log)
  useEffect(() => {
    if (!isScientificRep) return;
    fetch(`/api/monthly-plans`, { headers: authH() })
      .then(r => r.json())
      .then(plans => {
        if (!Array.isArray(plans) || plans.length === 0) return;
        const now = new Date();
        const plan = plans.find((p: any) => p.month === now.getMonth() + 1 && p.year === now.getFullYear()) || plans[0];
        setActivePlan(plan || null);
      })
      .catch(() => {});
  }, [isScientificRep]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCallsDateFromChange = (d: string) => {
    setCallsDateFrom(d);
    // if from > to, snap to to = from
    const to = d > callsDateTo ? d : callsDateTo;
    setCallsDateTo(to);
    loadDailyCalls(d, to, callsRepId);
  };

  const handleCallsDateToChange = (d: string) => {
    setCallsDateTo(d);
    // if to < from, snap from = to
    const from = d < callsDateFrom ? d : callsDateFrom;
    setCallsDateFrom(from);
    loadDailyCalls(from, d, callsRepId);
  };

  const handleCallsRepChange = (rid: number | '') => {
    setCallsRepId(rid);
    loadDailyCalls(callsDateFrom, callsDateTo, rid);
  };

  // Feedback words that must NOT be treated as item/drug names
  const FEEDBACK_AR_WORDS = new Set(['مهتم','مهتمه','غير مهتم','مو مهتم','يكتب','كاتب','نزل','معلق','غير متوفر','مو موجود']);

  // Non-blocking beep — fire and forget, never throws
  const safeBeep = (freq: number, dur = 0.18) => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.value = freq; g.gain.setValueAtTime(0.35, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
      setTimeout(() => { try { ctx.close(); } catch {} }, (dur + 0.1) * 1000);
    } catch {}
  };

  // ── Voice handlers ─────────────────────────────────────────
  // Step 1: open reminder panel (no recording yet)
  const openVoicePanel = () => {
    // For doctor mode we still need a plan; for pharmacy we don't
    if (callType === 'doctor' && !activePlan) {
      setVoiceError('لا يوجد خطة نشطة — يمكنك التبديل لزيارة صيدلية');
      setVoiceOverlay(true);
      setVoiceReady(true);
      return;
    }
    setVoiceError(''); setVoiceReady(true); setVoiceOverlay(true);
  };
  // Step 2: start actual mic recording
  const startRecordingNow = async () => {
    setVoiceReady(false);
    // beeps are non-blocking — don't await
    safeBeep(660); setTimeout(() => safeBeep(880), 130);
    setVoiceError('');
    // navigator.mediaDevices is undefined over plain HTTP on mobile browsers
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setVoiceError('الميكروفون غير متاح — يجب فتح التطبيق عبر HTTPS أو من localhost');
      setVoiceReady(false); return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const msg = (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError')
        ? 'لم يُسمح بالوصول للميكروفون — تحقق من الإذن في إعدادات الهاتف'
        : `خطأ في الميكروفون: ${err?.message ?? err}`;
      setVoiceError(msg); setVoiceReady(false); return;
    }
    voiceChunksRef.current = [];
    // Detect best supported MIME safely — iOS only supports audio/mp4
    let mime = '';
    const candidateMimes = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4'];
    try { mime = candidateMimes.find(t => MediaRecorder.isTypeSupported(t)) ?? ''; } catch {}
    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      try { rec = new MediaRecorder(stream); } catch (e2: any) {
        stream.getTracks().forEach(t => t.stop());
        setVoiceError(`لا يدعم هذا الجهاز التسجيل: ${e2?.message ?? ''}`); return;
      }
    }
    voiceMediaRef.current = rec;
    rec.ondataavailable = e => { if (e.data && e.data.size > 0) voiceChunksRef.current.push(e.data); };
    rec.onerror = (e: any) => {
      setVoiceError(`خطأ في التسجيل: ${e?.error?.message ?? 'unknown'}`);
      setVoiceListening(false); setVoiceOverlay(false);
      stream.getTracks().forEach(t => t.stop());
    };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      safeBeep(880); setTimeout(() => safeBeep(550), 130);
      setVoiceListening(false);
      const finalMime = rec.mimeType || mime || 'audio/webm';
      const blob = new Blob(voiceChunksRef.current, { type: finalMime });
      const dur = (Date.now() - voiceStartRef.current) / 1000;
      if (blob.size < 300 || dur < 1.5) { setVoiceOverlay(false); setVoiceError('التسجيل قصير جداً — حاول مجدداً'); return; }
      setVoiceParsing(true);
      try {
        const ext = finalMime.split('/')[1]?.split(';')[0]?.replace('mpeg','mp3') ?? 'webm';
        const fd = new FormData();
        fd.append('audio', blob, `voice.${ext}`);

        // ── Pharmacy voice path ─────────────────────────────
        if (callType === 'pharmacy') {
          const r = await fetch('/api/pharmacy-visits/voice-record', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (data.pharmacyName) setClPharmacyName(data.pharmacyName);
          if (data.areaId)       { setClPharmacyAreaId(String(data.areaId)); setClPharmacyAreaName(data.areaName || ''); }
          else if (data.areaName){ setClPharmacyAreaName(data.areaName); }
          if (Array.isArray(data.items) && data.items.length > 0) {
            const parsed = data.items.map((it: any, idx: number) => ({
              tempId:   clPharmacyItemCounter.current + idx,
              itemId:   it.itemId ? String(it.itemId) : '',
              itemName: it.itemName || '',
              notes:    it.notes   || '',
              showSugg: false,
              sugg:     [],
            }));
            clPharmacyItemCounter.current += parsed.length;
            setClPharmacyItems(parsed.length > 0 ? parsed : [{ tempId: clPharmacyItemCounter.current++, itemId: '', itemName: '', notes: '', showSugg: false, sugg: [] }]);
          }
          setVoiceOverlay(false);
          openCallLog_noReset();
          return;
        }

        // ── Doctor voice path ───────────────────────────────
        const r = await fetch(`/api/monthly-plans/${activePlan.id}/voice-record`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const visits: any[] = data.visits ?? [];
        if (visits.length === 0) { setVoiceError('لم يتم التعرف على بيانات الزيارة'); setVoiceOverlay(false); return; }
        const v = visits[0];
        if (v.entryId) {
          const entry = (activePlan.entries ?? []).find((e: any) => e.id === v.entryId);
          if (entry) {
            setClDoctor(entry.doctor.name); setClSelectedEntry({ ...entry, _inPlan: true }); setClNotInPlan(false); setClOtherDoc(null);
            if (v.itemName && !FEEDBACK_AR_WORDS.has(v.itemName.trim())) {
              if (v.itemId) { setClItemId(String(v.itemId)); }
              setClItemName(v.itemName);
            } else {
              const its = entry.targetItems ?? [];
              if (its.length > 0) { setClItemId(String(its[0].item.id)); setClItemName(its[0].item.name); }
            }
          }
        } else if (v.doctorName) {
          setClDoctor(v.doctorName); setClNotInPlan(true); setClAddToPlan(true);
          const lv = v.doctorName.toLowerCase();
          const catalog = clSuggestions.find((s: any) => !s._inPlan && s.doctor.name.toLowerCase().includes(lv));
          if (catalog) { setClOtherDocId(catalog.doctor.id); setClOtherDoc(catalog.doctor); }
          else {
            setClManualMode(true);
            if (v.specialty)    setClManualSpecialty(v.specialty);
            if (v.pharmacyName) setClManualPharmacy(v.pharmacyName);
            if (v.areaName) {
              const matchArea = (areas: any[]) => {
                const vn = (v.areaName as string).toLowerCase();
                const matched = areas.find((a: any) => a.name.toLowerCase().includes(vn) || vn.includes(a.name.toLowerCase()));
                if (matched) setClManualAreaId(String(matched.id));
              };
              if (clAreas.length > 0) {
                matchArea(clAreas);
              } else {
                fetch('/api/areas', { headers: authH() })
                  .then(r => r.json())
                  .then(json => {
                    const areas = Array.isArray(json.data) ? json.data : [];
                    setClAreas(areas);
                    matchArea(areas);
                  })
                  .catch(() => {});
              }
            }
          }
          if (v.itemName && !FEEDBACK_AR_WORDS.has(v.itemName.trim())) {
            if (v.itemId) { setClItemId(String(v.itemId)); }
            setClItemName(v.itemName);
          }
        }
        if (v.feedback) setClFeedback(v.feedback);
        if (v.notes)    setClNotes(v.notes);
        setVoiceOverlay(false);
        openCallLog_noReset();
      } catch (e: any) { setVoiceError('خطأ في التحليل: ' + (e.message ?? '')); setVoiceOverlay(false); }
      finally { setVoiceParsing(false); }
    };
    try {
      rec.start(500); // 500ms timeslice — safer on iOS than 250ms
    } catch (startErr: any) {
      stream.getTracks().forEach(t => t.stop());
      setVoiceError(`فشل بدء التسجيل: ${startErr?.message ?? startErr}`); return;
    }
    voiceStartRef.current = Date.now(); setVoiceListening(true);
    voiceAutoStop.current = setTimeout(() => {
      try { if (voiceMediaRef.current?.state === 'recording') voiceMediaRef.current.stop(); } catch {}
    }, 60000);
  };
  const stopVoice = () => {
    if (voiceReady) { setVoiceReady(false); setVoiceOverlay(false); return; }
    clearTimeout(voiceAutoStop.current);
    try {
      if (voiceMediaRef.current?.state === 'recording') voiceMediaRef.current.stop();
      else { setVoiceOverlay(false); setVoiceListening(false); }
    } catch { setVoiceOverlay(false); setVoiceListening(false); }
  };

  // ── Shared GPS helper ──────────────────────────────────────
  // Uses watchPosition to keep improving accuracy until ≤50m or 30s timeout.
  // Falls back to low-accuracy on permission-only browsers.
  const stopGpsWatch = () => {
    if (clGpsWatchRef.current !== null) {
      navigator.geolocation.clearWatch(clGpsWatchRef.current);
      clGpsWatchRef.current = null;
    }
  };

  const startGpsCapture = () => {
    // GPS requires a Secure Context (HTTPS or localhost).
    // On plain HTTP (local network IP) mobile browsers block it entirely.
    const isSecure = window.isSecureContext ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';
    if (!isSecure) { setClGpsStatus('denied'); return; }
    if (!navigator.geolocation) { setClGpsStatus('denied'); return; }
    stopGpsWatch();
    setClLat(null); setClLng(null); setClAccuracy(null); setClGpsStatus('getting');
    clGpsBestAccRef.current = Infinity;

    const GOOD_ACCURACY = 50; // metres — accept immediately if ≤ this

    const applyPosition = (pos: GeolocationPosition) => {
      const acc = pos.coords.accuracy;
      // Only update if this reading is better than the current best
      if (acc < clGpsBestAccRef.current) {
        clGpsBestAccRef.current = acc;
        setClLat(pos.coords.latitude);
        setClLng(pos.coords.longitude);
        setClAccuracy(Math.round(acc));
        setClGpsStatus('got');
      }
      // Stop watching once accuracy is good enough
      if (acc <= GOOD_ACCURACY) { stopGpsWatch(); }
    };

    // Step 1: get an immediate network/WiFi-based position (fast, ~100–500 m accuracy)
    // This makes the dot turn green quickly even before real GPS locks in
    navigator.geolocation.getCurrentPosition(
      applyPosition,
      () => {}, // ignore quick-fail — high-accuracy watch below will handle it
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
    );

    // Step 2: watch for accurate GPS — do NOT stop on TIMEOUT/UNAVAILABLE errors;
    // watchPosition will keep retrying automatically on those.
    const handleWatchError = (err: GeolocationPositionError) => {
      if (err.code === 1 /* PERMISSION_DENIED */) {
        stopGpsWatch();
        if (clGpsBestAccRef.current === Infinity) setClGpsStatus('denied');
      }
      // err.code 2 (POSITION_UNAVAILABLE) or 3 (TIMEOUT): do nothing —
      // watchPosition keeps trying on its own; we already have a network fix from step 1.
    };

    clGpsWatchRef.current = navigator.geolocation.watchPosition(
      applyPosition,
      handleWatchError,
      { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 }
    );

    // Hard stop after 90 s — keep whatever best reading we got
    setTimeout(() => {
      if (clGpsWatchRef.current !== null) {
        stopGpsWatch();
        // If still no reading at all (step 1 also failed), try one last low-accuracy call
        if (clGpsBestAccRef.current === Infinity) {
          navigator.geolocation.getCurrentPosition(
            applyPosition,
            () => setClGpsStatus('denied'),
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
          );
        }
      }
    }, 90000);
  };

  // Open device location settings — works on Android via geo: prompt
  const openLocationSettings = () => {
    // Try to force a new geolocation prompt; if denied, user must go to browser settings manually
    startGpsCapture();
    // For Android Chrome: opening a geo: URI triggers location prompt if not yet asked
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) {
      try { window.open('geo:0,0', '_blank'); } catch {}
    }
  };

  // Detect if running on plain HTTP (local IP) — GPS not available
  const isInsecureHttp = !window.isSecureContext &&
    location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

  // Retry GPS: if already denied → open phone settings; otherwise just retry
  const retryGps = () => {
    setClGpsWarning(false);
    if (clGpsStatus === 'denied') {
      openLocationSettings();
    } else {
      startGpsCapture();
    }
  };

  // open call log without resetting already-filled fields (used after voice parse)
  const openCallLog_noReset = () => {
    const tick = () => setClNow(new Date().toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick(); clTimerRef.current = setInterval(tick, 1000);
    startGpsCapture();
    setShowCallLog(true);
    // Load areas + items for autocomplete (same as openCallLog)
    if (clAreas.length === 0) {
      fetch('/api/areas', { headers: authH() })
        .then(r => r.json())
        .then(json => setClAreas(Array.isArray(json.data) ? json.data : []))
        .catch(() => {});
    }
    if (clAllItems.length === 0) {
      fetch('/api/items', { headers: authH() })
        .then(r => r.json())
        .then(json => setClAllItems(Array.isArray(json.data) ? json.data : []))
        .catch(() => {});
    }
  };
  const openCallLog = () => {
    setVoiceError('');
    setCallType('doctor');
    setClDoctor(''); setClSelectedEntry(null); setClNotInPlan(false);
    setClAddToPlan(false); setClOtherDocId(null); setClOtherDoc(null);
    setClManualMode(false); setClManualSpecialty(''); setClManualPharmacy(''); setClManualAreaId('');
    setClItemId(''); setClItemName(''); setClItemSugg([]); setClItemShowSugg(false);
    setClFeedback('pending'); setClNotes('');
    setClPharmacyName(''); setClPharmacyAreaId(''); setClPharmacyAreaName('');
    setClPharmacyAreaSugg([]); setClPharmacyAreaShowSugg(false);
    setClPharmacyNameSugg([]); setClPharmacyNameShowSugg(false); setClPharmacyIsNew(false);
    setClPharmacyItems([{ tempId: 1, itemId: '', itemName: '', notes: '', showSugg: false, sugg: [] }]);
    clPharmacyItemCounter.current = 2;
    setClError(''); setClSaving(false); setClShowSugg(false);
    // Live clock
    const tick = () => setClNow(new Date().toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick();
    clTimerRef.current = setInterval(tick, 1000);
    // GPS
    startGpsCapture();
    setShowCallLog(true);
    // Load areas + items for autocomplete
    if (clAreas.length === 0) {
      fetch('/api/areas', { headers: authH() })
        .then(r => r.json())
        .then(json => setClAreas(Array.isArray(json.data) ? json.data : []))
        .catch(() => {});
    }
    if (clAllItems.length === 0) {
      fetch('/api/items', { headers: authH() })
        .then(r => r.json())
        .then(json => setClAllItems(Array.isArray(json.data) ? json.data : []))
        .catch(() => {});
    }
  };

  const handleClDoctorChange = (val: string) => {
    setClDoctor(val);
    setClSelectedEntry(null);
    setClNotInPlan(false);
    setClAddToPlan(false);
    setClOtherDocId(null);
    setClOtherDoc(null);
    setClManualMode(false);
    if (!val.trim() || !activePlan) { setClSuggestions([]); setClShowSugg(false); return; }
    const lv = val.toLowerCase();
    // Show plan matches immediately
    const planMatches = (activePlan.entries ?? [])
      .filter((e: any) => e.doctor.name.toLowerCase().includes(lv))
      .slice(0, 5)
      .map((e: any) => ({ ...e, _inPlan: true }));
    setClSuggestions(planMatches);
    setClShowSugg(true);
    // Also search out-of-plan doctors from API (min 2 chars)
    if (val.trim().length >= 2) {
      fetch(`/api/monthly-plans/${activePlan.id}/available-doctors?q=${encodeURIComponent(val)}`, { headers: authH() })
        .then(r => r.json())
        .then(docs => {
          if (!Array.isArray(docs)) return;
          setClSuggestions(prev => {
            const inPlan = prev.filter((x: any) => x._inPlan);
            const outside = docs.slice(0, 5).map((d: any) => ({ doctor: d, id: null, _inPlan: false }));
            return [...inPlan, ...outside];
          });
        })
        .catch(() => {});
    }
  };

  const selectClEntry = (entry: any) => {
    setClDoctor(entry.doctor.name);
    setClSuggestions([]);
    setClShowSugg(false);
    if (entry._inPlan) {
      setClSelectedEntry(entry);
      setClNotInPlan(false);
      setClOtherDocId(null);
      // Auto-select first target item if assigned
      const items = entry.targetItems ?? [];
      if (items.length > 0) {
        setClItemId(String(items[0].item.id));
        setClItemName(items[0].item.name);
      }
    } else {
      setClSelectedEntry(null);
      setClNotInPlan(true);
      setClAddToPlan(true);
      setClOtherDocId(entry.doctor.id);
      setClOtherDoc(entry.doctor);
      setClManualMode(false);
    }
  };

  const detectNotInPlan = () => {
    if (!clDoctor.trim() || clSelectedEntry || clOtherDocId || !activePlan) return;
    const lv = clDoctor.toLowerCase();
    const match = (activePlan.entries ?? []).find((e: any) => e.doctor.name.toLowerCase() === lv);
    if (match) return;
    setClNotInPlan(true);
    setClShowSugg(false);
    // If no catalog suggestions either, go directly to manual mode
    const hasCatalog = clSuggestions.some((s: any) => !s._inPlan);
    if (!hasCatalog) setClManualMode(true);
  };

  const submitCallLog = async () => {
    // ── Pharmacy call path ─────────────────────────────────
    if (callType === 'pharmacy') {
      if (!clPharmacyName.trim()) { setClError('الرجاء إدخال اسم الصيدلية'); return; }
      const validItems = clPharmacyItems.filter(it => it.itemId || it.itemName.trim());
      if (validItems.length === 0) { setClError('الرجاء إدخال ايتم واحد على الأقل'); return; }
      if (clGpsStatus !== 'got' && !clGpsWarning) { setClGpsWarning(true); return; }
      setClGpsWarning(false);
      setClSaving(true); setClError('');
      try {
        const now       = new Date();
        const [vy, vm, vd] = callsDateFrom.split('-').map(Number);
        const visitDate = new Date(vy, vm - 1, vd, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
        const res = await fetch('/api/pharmacy-visits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({
            pharmacyName: clPharmacyName.trim(),
            areaId:       clPharmacyAreaId || undefined,
            areaName:     clPharmacyAreaName.trim() || undefined,
            items:        validItems.map(it => ({ itemId: it.itemId || null, itemName: it.itemName || null, notes: it.notes })),
            notes:        clNotes.trim() || undefined,
            isDoubleVisit,
            visitDate,
            ...(clLat != null ? { latitude: clLat, longitude: clLng } : {}),
          }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'فشل تسجيل زيارة الصيدلية'); }
        clearInterval(clTimerRef.current);
        setShowCallLog(false);
        setIsDoubleVisit(false);
        loadDailyCalls(callsDateFrom, callsDateTo, callsRepId);
      } catch (err: any) {
        setClError(err.message || 'حدث خطأ أثناء الحفظ');
      } finally {
        setClSaving(false);
      }
      return;
    }
    // ── Doctor call path ───────────────────────────────────
    if (!activePlan) { setClError('لا يوجد خطة شهرية نشطة'); return; }
    if (!clSelectedEntry && !clOtherDocId && !clManualMode) {
      setClError('الرجاء اختيار طبيب أو إدخال بياناته يدوياً');
      return;
    }
    if (clManualMode && !clDoctor.trim()) { setClError('الرجاء إدخال اسم الطبيب'); return; }
    // GPS check — warn user if location not obtained yet
    if (clGpsStatus !== 'got' && !clGpsWarning) {
      setClGpsWarning(true);
      return;
    }
    setClGpsWarning(false);
    setClSaving(true);
    setClError('');
    try {
      let entryId = clSelectedEntry?.id;
      if (!clSelectedEntry) {
        let doctorId = clOtherDocId;
        // Manual mode: create the doctor first
        if (clManualMode) {
          const docRes = await fetch('/api/doctors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authH() },
            body: JSON.stringify({
              name: clDoctor.trim(),
              specialty: clManualSpecialty.trim() || undefined,
              pharmacyName: clManualPharmacy.trim() || undefined,
              areaId: clManualAreaId ? parseInt(clManualAreaId) : undefined,
            }),
          });
          if (!docRes.ok) { const e = await docRes.json().catch(() => ({})); throw new Error(e.error || 'فشل إنشاء الطبيب'); }
          const newDoc = await docRes.json();
          doctorId = newDoc.id;
        }
        const addRes = await fetch(`/api/monthly-plans/${activePlan.id}/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authH() },
          body: JSON.stringify({ doctorId }),
        });
        if (!addRes.ok) { const e = await addRes.json().catch(() => ({})); throw new Error(e.error || 'فشل إضافة الطبيب للبلان'); }
        const newEntry = await addRes.json();
        entryId = newEntry.id;
      }
      const now      = new Date();
      const [vy2, vm2, vd2] = callsDateFrom.split('-').map(Number);
      const visitDate = new Date(vy2, vm2 - 1, vd2, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
      // Resolve itemId locally if possible; also send itemName so server can resolve as fallback
      let resolvedItemId = clItemId;
      if (!resolvedItemId && clItemName.trim()) {
        const lv = clItemName.trim().toLowerCase();
        const found = clAllItems.find((i: any) => i.name.toLowerCase().includes(lv) || lv.includes(i.name.toLowerCase()));
        if (found) resolvedItemId = String(found.id);
      }
      const visitRes  = await fetch(`/api/monthly-plans/${activePlan.id}/entries/${entryId}/visits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ visitDate, feedback: clFeedback, notes: clNotes, isDoubleVisit, ...(resolvedItemId ? { itemId: resolvedItemId } : {}), ...(clItemName.trim() ? { itemName: clItemName.trim() } : {}), ...(clLat != null ? { latitude: clLat, longitude: clLng } : {}) }),
      });
      if (!visitRes.ok) { const e = await visitRes.json().catch(() => ({})); throw new Error(e.error || 'فشل تسجيل الزيارة'); }
      clearInterval(clTimerRef.current);
      setShowCallLog(false);
      setIsDoubleVisit(false);
      loadDailyCalls(callsDateFrom, callsDateTo, callsRepId);
      // Refresh plan entries
      fetch(`/api/monthly-plans`, { headers: authH() })
        .then(r => r.json())
        .then(plans => {
          if (!Array.isArray(plans) || plans.length === 0) return;
          const n = new Date();
          const p = plans.find((x: any) => x.month === n.getMonth() + 1 && x.year === n.getFullYear()) || plans[0];
          setActivePlan(p || null);
        }).catch(() => {});
    } catch (err: any) {
      setClError(err.message || 'حدث خطأ أثناء الحفظ');
    } finally {
      setClSaving(false);
    }
  };

  // Load dashboard stats
  useEffect(() => {
    fetch(`/api/dashboard/stats`, { headers: authH() })
      .then(r => r.json())
      .then(json => { if (json.success) setStats(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load active-files monetary stats whenever activeFileIds changes
  useEffect(() => {
    if (activeFileIds.length === 0) {
      setActiveStats({ totalSalesValue: 0, totalReturnsValue: 0, files: [] });
      return;
    }
    setActiveStatsLoading(true);
    fetch(`/api/dashboard/active-stats?fileIds=${activeFileIds.join(',')}`, { headers: authH() })
      .then(r => r.json())
      .then(json => { if (json.success) setActiveStats(json.data); })
      .catch(() => {})
      .finally(() => setActiveStatsLoading(false));
  }, [activeFileIds, token]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    if (openDropdown) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openDropdown]);

  const toggleDropdown = (type: 'sales' | 'returns' | 'net', e: React.MouseEvent<HTMLDivElement>) => {
    if (openDropdown === type) { setOpenDropdown(null); return; }
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + window.scrollY + 6, left: rect.left + window.scrollX, width: Math.max(rect.width, 280) });
    setOpenDropdown(type);
  };

  const fmtMoney = (v: number) => v.toLocaleString('ar-IQ-u-nu-latn', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  // Load areas list when panel opens
  const openAreasPanel = () => {
    setShowAreas(true);
    setAreaSearch('');
    setAreasLoading(true);
    fetch(`/api/areas`, { headers: authH() })
      .then(r => r.json())
      .then(json => setAreas(Array.isArray(json.data) ? json.data : []))
      .catch(() => {})
      .finally(() => setAreasLoading(false));
  };

  // Load files list when panel opens
  const openFilesPanel = () => {
    setShowFiles(true);
    setFilesLoading(true);
    fetch(`/api/files`, { headers: authH() })
      .then(r => r.json())
      .then(json => setFiles(Array.isArray(json.data) ? json.data : []))
      .catch(() => {})
      .finally(() => setFilesLoading(false));
  };

  // Trigger AI analysis for a specific file
  const runAnalysis = async (file: UploadedFile) => {
    setAnalyzeFile(file);
    setAnalysisText('');
    setAnalyzeLoading(true);
    try {
      const res  = await fetch(`/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authH() },
        body: JSON.stringify({ fileId: file.id }),
      });
      const json = await res.json();
      setAnalysisText(json.analysis || t.dashboard.noAnalysis);
    } catch {
      setAnalysisText(t.dashboard.analysisError);
    } finally {
      setAnalyzeLoading(false);
    }
  };

  const TZ = 'Asia/Baghdad';
  const fmtDate    = (d: string) => new Date(d).toLocaleDateString('ar-IQ-u-nu-latn', { timeZone: TZ });
  const fmtTime    = (d: string) => new Date(d).toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const fmtDateTime = (d: string) => {
    const dt = new Date(d);
    const dateStr = dt.toLocaleDateString('ar-IQ-u-nu-latn', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: TZ });
    const timeStr = dt.toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    return `${dateStr} — ${timeStr}`;
  };
  const fmtDateAndTime = (d: string) => {
    const dt = new Date(d);
    const dateStr = dt.toLocaleDateString('ar-IQ-u-nu-latn', { day: 'numeric', month: 'numeric', timeZone: TZ });
    const timeStr = dt.toLocaleTimeString('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    return { date: dateStr, time: timeStr };
  };
  const isMultiDay  = callsDateFrom !== callsDateTo;

  const feedbackLabel = (fb: string) => {
    const td = t.dashboard as any;
    const map: Record<string, string> = {
      writing:        td.feedbackWriting,
      stocked:        td.feedbackStocked,
      interested:     td.feedbackInterested,
      not_interested: td.feedbackNotInterested,
      unavailable:    td.feedbackUnavailable,
      pending:        td.feedbackPending,
    };
    return map[fb] ?? fb;
  };
  const feedbackColor: Record<string, string> = {
    writing:       '#10b981', stocked: '#0ea5e9', interested: '#6366f1',
    not_interested:'#ef4444', unavailable: '#9ca3af', pending: '#f59e0b',
  };

  const quickActions = [
    { label: t.dashboard.uploadFile,   desc: t.dashboard.uploadFileDesc,   icon: '📤', page: 'upload'          as PageId, color: '#6366f1' },
    { label: t.dashboard.manageReps,   desc: t.dashboard.manageRepsDesc,   icon: '👥', page: 'representatives' as PageId, color: '#0ea5e9' },
    { label: t.dashboard.viewReports,  desc: t.dashboard.viewReportsDesc,  icon: '📋', page: 'reports'         as PageId, color: '#10b981' },
  ];

  const netValue = activeStats.totalSalesValue - activeStats.totalReturnsValue;

  const moneyCards: { type: 'sales' | 'returns' | 'net'; label: string; value: string; icon: string; color: string; bg: string }[] = [
    {
      type: 'sales',
      label: t.dashboard.totalSales,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(activeStats.totalSalesValue),
      icon: '📦', color: '#10b981', bg: '#d1fae5',
    },
    {
      type: 'returns',
      label: t.dashboard.returns,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(activeStats.totalReturnsValue),
      icon: '↩', color: '#ef4444', bg: '#fee2e2',
    },
    {
      type: 'net',
      label: t.dashboard.net,
      value: activeStatsLoading ? '...' : activeFileIds.length === 0 ? '—' : fmtMoney(netValue),
      icon: '🏆', color: '#6366f1', bg: '#eef2ff',
    },
  ];

  const statCards = [
    ...moneyCards.map(c => ({ ...c, onClick: undefined as undefined | (() => void) })),
    {
      label: t.dashboard.sciReps, value: loading ? '...' : stats.sciRepsCount,
      icon: '🔬', color: '#8b5cf6', bg: '#ede9fe', onClick: () => onNavigate('scientific-reps'),
      type: undefined,
    },
    {
      label: t.dashboard.areas, value: loading ? '...' : stats.areasCount,
      icon: '📍', color: '#0ea5e9', bg: '#e0f2fe', onClick: openAreasPanel,
      type: undefined,
    },
    {
      label: t.dashboard.uploadedFiles, value: loading ? '...' : stats.filesCount,
      icon: '📂', color: '#10b981', bg: '#d1fae5', onClick: openFilesPanel,
      type: undefined,
    },
    {
      label: t.dashboard.aiAnalysis, value: loading ? '...' : '✓',
      icon: '🤖', color: '#f59e0b', bg: '#fef3c7', onClick: undefined as undefined | (() => void),
      type: undefined,
    },
  ];

  // Filtered visits (shared between both dashboard views)
  const filteredVisits = (callsData?.visits ?? []).filter(v => {
    if (fType === 'doctor' && (v as any)._visitType === 'pharmacy') return false;
    if (fType === 'pharmacy' && (v as any)._visitType !== 'pharmacy') return false;
    if (fDouble && !(v as any)._isDoubleVisit) return false;
    if (fSearch.trim()) {
      const q = fSearch.trim().toLowerCase();
      const hit = v.doctor.name.toLowerCase().includes(q)
        || (v.doctor.pharmacyName?.toLowerCase().includes(q) ?? false)
        || (v.doctor.area?.name.toLowerCase().includes(q) ?? false)
        || (v.item?.name.toLowerCase().includes(q) ?? false)
        || ((v as any).pharmItems?.some((pi: any) =>
            pi.item?.name?.toLowerCase().includes(q) || pi.itemName?.toLowerCase().includes(q)
          ) ?? false);
      if (!hit) return false;
    }
    return true;
  });

  // ── Commercial Rep dashboard: monthly invoices stats ──────
  if (isCommercialRep) {
    const fmtNum = (n: number) => n.toLocaleString('ar-IQ-u-nu-latn', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const selectedMonthName = commDashMonth
      ? `${MONTHS_AR[commDashMonth.month - 1]} ${commDashMonth.year}`
      : 'كل الفترات';
    // Build last 6 month options
    const nowRef = new Date();
    const monthOptions: { month: number; year: number; label: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(nowRef.getFullYear(), nowRef.getMonth() - i, 1);
      monthOptions.push({ month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS_AR[d.getMonth()]} ${d.getFullYear()}` });
    }

    const commCards = [
      {
        label: 'مبيعات إجمالية',
        value: commDashLoading ? '...' : fmtNum(commDash?.monthlySales ?? 0),
        icon: '📦', color: '#10b981', bg: '#d1fae5',
        desc: 'إجمالي فواتير الشهر (د.ع)',
        onClick: () => setShowSalesBreakdown('sales'),
      },
      {
        label: 'ارجاعات',
        value: commDashLoading ? '...' : fmtNum(commDash?.monthlyReturns ?? 0),
        icon: '↩', color: '#ef4444', bg: '#fee2e2',
        desc: 'استرجاع البضاعة هذا الشهر (د.ع)',
        onClick: () => setShowSalesBreakdown('returns'),
      },
      {
        label: 'صافي (نت)',
        value: commDashLoading ? '...' : fmtNum(commDash?.netSales ?? 0),
        icon: '🏆', color: '#6366f1', bg: '#eef2ff',
        desc: 'المبيع الصافي = إجمالي − ارجاع',
        onClick: () => setShowSalesBreakdown('net'),
      },
      {
        label: 'المندوبون العلميون',
        value: commDashLoading ? '...' : (commDash?.sciReps.length ?? 0),
        icon: '🔬', color: '#8b5cf6', bg: '#ede9fe',
        desc: 'مندوبون علميون على نفس مناطقك',
        onClick: () => setShowSciRepsPanel(true),
      },
      {
        label: 'المناطق',
        value: commDashLoading ? '...' : (commDash?.myAreas.length ?? 0),
        icon: '📍', color: '#0ea5e9', bg: '#e0f2fe',
        desc: 'مناطق عملك',
        onClick: () => setShowMyAreasPanel(true),
      },
    ];

    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">{t.dashboard.title}</h1>
          <p className="page-subtitle">لوحة متابعة المندوب التجاري · {selectedMonthName}</p>
        </div>

        {/* Month selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20, flexWrap: 'wrap', direction: 'rtl' }}>
          <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>📅 الشهر:</span>
          {monthOptions.map(o => {
            const active = commDashMonth?.month === o.month && commDashMonth?.year === o.year;
            return (
              <button key={`${o.month}-${o.year}`}
                onClick={() => setCommDashMonth({ month: o.month, year: o.year })}
                style={{
                  fontSize: 11, fontWeight: active ? 700 : 400, padding: '4px 10px', borderRadius: 14,
                  border: `1px solid ${active ? '#10b981' : '#e2e8f0'}`,
                  background: active ? '#d1fae5' : 'transparent',
                  color: active ? '#065f46' : '#94a3b8', cursor: 'pointer',
                }}>{o.label}</button>
            );
          })}
        </div>

        {commDashError && (
          <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
            ⚠️ {commDashError}
          </div>
        )}

        {/* Stat Cards */}
        <div className="stats-grid">
          {commCards.map(card => (
            <div
              key={card.label}
              className="stat-card"
              style={{ borderTop: `4px solid ${card.color}`, cursor: card.onClick ? 'pointer' : 'default' }}
              onClick={card.onClick}
            >
              <div className="stat-card-icon" style={{ background: card.bg, color: card.color }}>{card.icon}</div>
              <div className="stat-card-body">
                <div className="stat-card-value" style={{ color: card.color }}>{card.value}</div>
                <div className="stat-card-label">{card.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{card.desc}</div>
              </div>
              {card.onClick && <span style={{ color: card.color, fontSize: '1.1rem' }}>←</span>}
            </div>
          ))}
        </div>

        {/* Sci-Reps Panel */}
        {showSciRepsPanel && (
          <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setShowSciRepsPanel(false)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 480, width: '90%', maxHeight: '75vh', overflowY: 'auto', direction: 'rtl' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>🔬 المندوبون العلميون في مناطقك</h2>
                <button onClick={() => setShowSciRepsPanel(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}>✕</button>
              </div>
              {(commDash?.sciReps.length ?? 0) === 0 ? (
                <p style={{ color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>لا يوجد مندوبون علميون على مناطقك حالياً</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {commDash!.sciReps.map(rep => (
                    <div key={rep.id} style={{ background: '#f8fafc', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#ede9fe', color: '#8b5cf6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 18, flexShrink: 0 }}>
                        {rep.name[0]?.toUpperCase() ?? '?'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{rep.name}</div>
                        {rep.company && <div style={{ fontSize: 12, color: '#6366f1' }}>🏢 {rep.company}</div>}
                        {rep.phone && <div style={{ fontSize: 12, color: '#64748b' }}>📞 {rep.phone}</div>}
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>📍 {rep.areas.join('، ')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* My Areas Panel */}
        {showMyAreasPanel && (
          <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setShowMyAreasPanel(false)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 400, width: '90%', maxHeight: '70vh', overflowY: 'auto', direction: 'rtl' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>📍 مناطق عملك</h2>
                <button onClick={() => setShowMyAreasPanel(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}>✕</button>
              </div>
              {(commDash?.myAreas.length ?? 0) === 0 ? (
                <p style={{ color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>لم يتم تعيين مناطق لك بعد</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {commDash!.myAreas.map(area => (
                    <div key={area.id} style={{ background: '#f0f9ff', borderRadius: 10, padding: '10px 14px', color: '#0369a1', fontWeight: 600, fontSize: 14 }}>
                      📍 {area.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sales Breakdown Panel */}
        {showSalesBreakdown && (() => {
          const byCompany = commDash?.salesByCompany ?? [];
          const totalSales = commDash?.monthlySales ?? 0;
          const totalReturns = commDash?.monthlyReturns ?? 0;
          const totalNet = commDash?.netSales ?? 0;
          const maxVal = byCompany[0]?.total ?? 1;
          const titleMap = {
            sales:   { icon: '📦', label: 'المبيعات الإجمالية حسب الشركة', color: '#10b981', totalLabel: 'إجمالي المبيعات', total: totalSales },
            returns: { icon: '↩',  label: 'الارجاعات',                       color: '#ef4444', totalLabel: 'إجمالي الارجاعات', total: totalReturns },
            net:     { icon: '🏆', label: 'صافي المبيع حسب الشركة',          color: '#6366f1', totalLabel: 'صافي المبيع',      total: totalNet },
          } as const;
          const t2 = titleMap[showSalesBreakdown];
          return (
            <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => setShowSalesBreakdown(null)}>
              <div style={{ background: '#fff', borderRadius: 18, padding: 24, maxWidth: 500, width: '92%', maxHeight: '80vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
                onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: t2.color }}>{t2.icon} {t2.label}</h2>
                  <button onClick={() => setShowSalesBreakdown(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
                </div>

                {/* Total badge */}
                <div style={{ background: `${t2.color}18`, borderRadius: 12, padding: '10px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>{t2.totalLabel}</span>
                  <span style={{ fontSize: 20, fontWeight: 900, color: t2.color }}>{fmtNum(t2.total)} د.ع</span>
                </div>

                {/* Company breakdown (shown for sales and net) */}
                {showSalesBreakdown !== 'returns' && (
                  <>
                    {byCompany.length === 0 ? (
                      <p style={{ textAlign: 'center', color: '#94a3b8', padding: '20px 0', fontSize: 14 }}>لا توجد بيانات تفصيلية للشركات هذا الشهر</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {byCompany.map((co, idx) => {
                          const barPct = maxVal > 0 ? (co.total / maxVal) * 100 : 0;
                          const rowColor = [t2.color, '#f59e0b', '#0ea5e9', '#8b5cf6', '#ec4899', '#14b8a6'][idx % 6];
                          const displayTotal = showSalesBreakdown === 'net'
                            ? co.total - (totalReturns * (totalSales > 0 ? co.total / totalSales : 0))
                            : co.total;
                          return (
                            <div key={co.name} style={{ background: '#f8fafc', borderRadius: 12, padding: '10px 14px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>🏢 {co.name}</span>
                                <span style={{ fontWeight: 800, fontSize: 15, color: rowColor }}>{fmtNum(Math.round(displayTotal))} د.ع</span>
                              </div>
                              <div style={{ height: 7, background: '#e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${barPct}%`, background: rowColor, borderRadius: 8, transition: 'width 0.5s ease' }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {/* Returns: show note */}
                {showSalesBreakdown === 'returns' && (
                  <div style={{ textAlign: 'center', padding: '16px 0', color: '#64748b', fontSize: 13 }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>📋</div>
                    <p style={{ margin: 0 }}>الارجاعات مسجلة على مستوى الفاتورة الإجمالية</p>
                    <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: 12 }}>لا يتوفر تفصيل حسب الشركة للارجاعات حالياً</p>
                  </div>
                )}

                {showSalesBreakdown === 'net' && byCompany.length > 0 && (
                  <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12, textAlign: 'center' }}>* صافي الشركة = مبيعات الشركة − حصتها من الارجاعات الإجمالية</p>
                )}
              </div>
            </div>
          );
        })()}

        {/* Quick Actions */}
        <h2 className="section-title">{t.dashboard.quickActions}</h2>
        <div className="quick-actions-grid">
          <button className="quick-action-card" onClick={() => onNavigate('commercial' as PageId)} style={{ borderColor: '#6366f1' }}>
            <div className="quick-action-icon" style={{ background: '#6366f1' }}>💵</div>
            <div className="quick-action-body">
              <div className="quick-action-label">الاستحصالات والفواتير</div>
              <div className="quick-action-desc">متابعة فواتير الصيدليات</div>
            </div>
            <span className="quick-action-arrow" style={{ color: '#6366f1' }}>←</span>
          </button>
        </div>
      </div>
    );
  }

  // ── Scientific Rep dashboard: daily calls only ─────────────
  if (isScientificRep) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">📞 {(t.dashboard as any).dailyCalls}</h1>
          <p className="page-subtitle">
            {callsDateFrom === callsDateTo ? callsDateFrom : `${callsDateFrom} — ${callsDateTo}`}
          </p>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
          {/* Row 1: Date range pickers */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#f8fafc', borderRadius: '8px', padding: '4px 10px', border: '1px solid #e2e8f0', alignSelf: 'flex-start', flexWrap: 'nowrap' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap' }}>📅 من:</span>
            <input
              type="date"
              className="form-input"
              style={{ padding: '2px 4px', fontSize: '11px', width: 120, border: 'none', background: 'transparent', outline: 'none', lineHeight: 1.5 }}
              value={callsDateFrom}
              onChange={e => handleCallsDateFromChange(e.target.value)}
            />
            <span style={{ fontSize: '11px', color: '#d1d5db', whiteSpace: 'nowrap' }}>|</span>
            <span style={{ fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap' }}>إلى:</span>
            <input
              type="date"
              className="form-input"
              style={{ padding: '2px 4px', fontSize: '11px', width: 120, border: 'none', background: 'transparent', outline: 'none', lineHeight: 1.5 }}
              value={callsDateTo}
              min={callsDateFrom}
              onChange={e => handleCallsDateToChange(e.target.value)}
            />
            {callsDateFrom !== callsDateTo && (
              <button
                onClick={() => { setCallsDateFrom(todayStr); setCallsDateTo(todayStr); loadDailyCalls(todayStr, todayStr, callsRepId); }}
                title="العودة لليوم الحالي"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#6366f1', fontWeight: 700, padding: '1px 4px', whiteSpace: 'nowrap' }}
              >اليوم</button>
            )}
          </div>
          {/* Row 2: Action buttons — all equal height, evenly arranged */}
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '8px', flexWrap: 'wrap' }}>
            {hasFeature('call_log') && (
              <button
                className="btn btn--primary"
                style={{ flex: '1 1 auto', minWidth: '110px', padding: '9px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: '#059669', borderColor: '#059669' }}
                onClick={openCallLog}
              >
                ✏️ تسجيل زيارة
              </button>
            )}
            {hasFeature('daily_map') && callsData && callsData.visits.length > 0 && (
              <button
                className="btn btn--primary"
                style={{ flex: '1 1 auto', minWidth: '110px', padding: '9px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                onClick={() => setShowMap(true)}
              >
                {(t.dashboard as any).dailyCallsMapBtn}
              </button>
            )}
            <button
              title={isDoubleVisit ? 'زيارة مزدوجة — اضغط لإيقاف' : 'زيارة منفردة — اضغط لتفعيل الزيارة المزدوجة'}
              onClick={() => setIsDoubleVisit(p => !p)}
              style={{
                flex: '0 0 auto',
                padding: '9px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                background: isDoubleVisit ? '#7c3aed' : '#f3f4f6',
                border: `2px solid ${isDoubleVisit ? '#7c3aed' : '#d1d5db'}`,
                borderRadius: '8px', color: isDoubleVisit ? '#fff' : '#6b7280',
                fontWeight: 700, cursor: 'pointer', transition: 'all .2s',
              }}
            >
              {isDoubleVisit ? '👥' : '👤'}
              <span style={{ fontSize: '12px' }}>{isDoubleVisit ? 'مزدوجة' : 'منفردة'}</span>
            </button>
            {hasFeature('voice_visit') && (
              <button
                style={{
                  flex: '1 1 auto', minWidth: '120px',
                  padding: '9px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  background: voiceListening ? '#ef4444' : '#f97316',
                  border: 'none', borderRadius: '8px', color: '#fff', fontWeight: 700, cursor: 'pointer',
                  animation: voiceListening ? 'clGpsPulse 1.2s ease-in-out infinite' : 'none',
                }}
                onClick={() => (voiceListening || voiceReady) ? stopVoice() : openVoicePanel()}
                disabled={voiceParsing}
                title={voiceListening ? 'إيقاف التسجيل' : 'زيارة صوتية'}
              >
                {voiceParsing ? '⏳ جاري التحليل...' : voiceListening ? '⏹ إيقاف' : '🎤 زيارة صوتية'}
              </button>
            )}
          </div>
        </div>

        {/* Table card */}
        <div style={{ background: '#fff', border: '2px solid #6366f1', borderRadius: '14px', overflow: 'hidden', boxShadow: '0 4px 16px rgba(99,102,241,0.12)' }}>
          {callsLoading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
              {(t.dashboard as any).dailyCallsLoading}
            </div>
          ) : !callsData || callsData.visits.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: '14px' }}>
              📭 {(t.dashboard as any).dailyCallsNoData}
            </div>
          ) : (
            <>
              <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: '14px', color: '#374151' }}>
                  📞 {(t.dashboard as any).dailyCallsTotal}: {filteredVisits.length}{filteredVisits.length !== callsData.visits.length && <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: '12px' }}> / {callsData.visits.length}</span>}
                </span>
              </div>
              {/* Filter bar */}
              <div style={{ padding: '8px 10px', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="🔍 بحث: طبيب، صيدلية، منطقة، ايتم..."
                  value={fSearch}
                  onChange={e => setFSearch(e.target.value)}
                  style={{ flex: 1, minWidth: 150, padding: '5px 10px', fontSize: '12px', borderRadius: '8px', border: '1px solid #d1d5db', outline: 'none', direction: 'rtl', background: '#fff' }}
                />
                <button onClick={() => setFType(fType === 'doctor' ? 'all' : 'doctor')}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fType === 'doctor' ? '#6366f1' : '#d1d5db'}`, background: fType === 'doctor' ? '#eef2ff' : '#fff', color: fType === 'doctor' ? '#4338ca' : '#6b7280', fontWeight: fType === 'doctor' ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  👨‍⚕️ طبيب
                </button>
                <button onClick={() => setFType(fType === 'pharmacy' ? 'all' : 'pharmacy')}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fType === 'pharmacy' ? '#059669' : '#d1d5db'}`, background: fType === 'pharmacy' ? '#f0fdf4' : '#fff', color: fType === 'pharmacy' ? '#065f46' : '#6b7280', fontWeight: fType === 'pharmacy' ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  🏪 صيدلية
                </button>
                <button onClick={() => setFDouble(p => !p)}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fDouble ? '#7c3aed' : '#d1d5db'}`, background: fDouble ? '#ede9fe' : '#fff', color: fDouble ? '#6d28d9' : '#6b7280', fontWeight: fDouble ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  👥 مزدوجة
                </button>
                {(fSearch || fType !== 'all' || fDouble) && (
                  <button onClick={() => { setFSearch(''); setFType('all'); setFDouble(false); }}
                    style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1.5px solid #ef4444', background: '#fff', color: '#ef4444', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    ✕ مسح
                  </button>
                )}
              </div>
              <div style={{ overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>#</th>
                      <th>{(t.dashboard as any).dailyCallsColDoctor}</th>
                      <th>الصيدلية / المنطقة</th>
                      <th>{isMultiDay ? 'التاريخ والوقت' : (t.dashboard as any).dailyCallsColTime}</th>
                      <th>{(t.dashboard as any).dailyCallsColItem}</th>
                      <th>{(t.dashboard as any).dailyCallsColFeedback}</th>
                      <th>الملاحظات</th>
                      <th>{(t.dashboard as any).dailyCallsColLocation}</th>
                      <th style={{ width: 44 }}>❤️</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVisits
                      .slice()
                      .sort((a, b) => new Date(a.visitDate).getTime() - new Date(b.visitDate).getTime())
                      .reduce<React.ReactNode[]>((rows, v, idx, arr) => {
                        // Date separator between days (only in multi-day view)
                        if (isMultiDay) {
                          const curDay  = new Date(v.visitDate).toLocaleDateString('ar-IQ');
                          const prevDay = idx > 0 ? new Date(arr[idx - 1].visitDate).toLocaleDateString('ar-IQ') : null;
                          if (curDay !== prevDay) {
                            const colCount = isManagerOrAdmin ? 9 : 8;
                            rows.push(
                              <tr key={`sep-${curDay}`} style={{ background: 'transparent' }}>
                                <td colSpan={colCount} style={{ padding: idx === 0 ? '4px 0 0' : '12px 0 0', border: 'none' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                                    <div style={{ flex: 1, height: 2, background: '#e2e8f0' }} />
                                    <span style={{
                                      fontSize: 12, fontWeight: 800, color: '#fff',
                                      background: '#475569',
                                      borderRadius: 6, padding: '4px 16px',
                                      whiteSpace: 'nowrap', letterSpacing: '0.3px',
                                      boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
                                    }}>
                                      📅 {curDay}
                                    </span>
                                    <div style={{ flex: 1, height: 2, background: '#e2e8f0' }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          }
                        }
                        rows.push(
                          <tr key={(v as any)._visitType === 'pharmacy' ? `ph-${v.id}` : v.id}
                            style={
                              (v as any)._isDoubleVisit
                                ? { background: '#f5f3ff' }
                                : (v as any)._visitType === 'pharmacy' ? { background: '#f0fdf4' }
                                : (v as any)._outOfPlan ? { background: '#fff7ed' } : undefined
                            }>
                          <td style={{ textAlign: 'center', color: '#94a3b8' }}>{idx + 1}</td>
                          <td>
                            {(v as any)._visitType === 'pharmacy' ? (
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: '15px' }}>🏪 {v.doctor.name}</strong>
                                <span style={{ fontSize: '10px', background: '#d1fae5', color: '#065f46', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>صيدلية</span>
                                {(v as any)._isDoubleVisit && (
                                  <span style={{ fontSize: '10px', background: '#ede9fe', color: '#6d28d9', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>👥 مزدوجة</span>
                                )}
                              </div>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: '15px' }}>{v.doctor.name}</strong>
                                {(v as any)._outOfPlan && (
                                  <span style={{ fontSize: '10px', background: '#fed7aa', color: '#9a3412', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>خارج البلان</span>
                                )}
                                {(v as any)._isDoubleVisit && (
                                  <span style={{ fontSize: '10px', background: '#ede9fe', color: '#6d28d9', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>👥 مزدوجة</span>
                                )}
                              </div>
                            )}
                            {v.doctor.specialty && (
                              <div style={{ fontSize: '12px', color: '#6b7280' }}>{v.doctor.specialty}</div>
                            )}
                          </td>
                          <td style={{ fontSize: '13px', color: '#374151' }}>
                            {(v as any)._visitType === 'pharmacy' ? (
                              v.doctor.area?.name ? <div style={{ fontSize: '11px', color: '#6b7280' }}>{v.doctor.area.name}</div> : '—'
                            ) : (
                              v.doctor.pharmacyName || v.doctor.area?.name ? (
                                <>
                                  {v.doctor.pharmacyName && <div>{v.doctor.pharmacyName}</div>}
                                  {v.doctor.area?.name && (
                                    <div style={{ fontSize: '11px', color: '#6b7280' }}>{v.doctor.area.name}</div>
                                  )}
                                </>
                              ) : '—'
                            )}
                          </td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '13px' }}>
                            {isMultiDay ? (() => { const { date, time } = fmtDateAndTime(v.visitDate); return <><div style={{ fontWeight: 600, color: '#374151' }}>{date}</div><div style={{ fontSize: '11px', color: '#6b7280' }}>{time}</div></>; })() : (() => { const { date, time } = fmtDateAndTime(v.visitDate); return <><div>{time}</div><div style={{ fontSize: '11px', color: '#9ca3af' }}>{date}</div></>; })()}
                          </td>
                          <td style={{ fontSize: '13px' }}>
                            {(v as any)._visitType === 'pharmacy' ? (
                              (v as any).pharmItems?.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                  {(v as any).pharmItems.map((pi: any, i: number) => (
                                    <div key={i}>
                                      <span>{pi.item?.name ?? pi.itemName ?? '—'}</span>
                                      {pi.notes && <span style={{ fontSize: '11px', color: '#6b7280', marginRight: '4px' }}>({pi.notes})</span>}
                                    </div>
                                  ))}
                                </div>
                              ) : '—'
                            ) : (
                              v.item?.name ?? '—'
                            )}
                          </td>
                          <td>
                            {(v as any)._visitType === 'pharmacy' ? (
                              <span style={{ background: '#d1fae522', color: '#065f46', border: '1px solid #d1fae555', borderRadius: '6px', padding: '2px 8px', fontSize: '12px', fontWeight: 500 }}>صيدلية</span>
                            ) : (
                              <span style={{
                                background: (feedbackColor[v.feedback] ?? '#e5e7eb') + '22',
                                color:      feedbackColor[v.feedback] ?? '#374151',
                                border:     `1px solid ${feedbackColor[v.feedback] ?? '#e5e7eb'}55`,
                                borderRadius: '6px', padding: '2px 8px', fontSize: '12px', fontWeight: 500,
                              }}>
                                {feedbackLabel(v.feedback)}
                              </span>
                            )}
                          </td>
                          <td style={{ fontSize: '12px', color: '#6b7280', maxWidth: '200px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5' }}>
                            {v.notes || '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {v.latitude != null
                              ? <button onClick={() => setMapSingleVisit(v)} title="عرض الموقع على الخريطة" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '22px', padding: '2px', lineHeight: 1 }}>📍</button>
                              : <span style={{ color: '#d1d5db', fontSize: '12px' }}>—</span>}
                          </td>
                          {/* Like cell — only for doctor visits */}
                          <td style={{ textAlign: 'center', position: 'relative' }}>
                            {(v as any)._visitType !== 'pharmacy' && (() => {
                              const likes = (v as any).likes ?? [];
                              const likeCount = likes.length;
                              const liked = !!(likes.find((l: any) => l.userId === user?.id));
                              return (
                                <div style={{ position: 'relative', display: 'inline-block' }}>
                                  <button
                                    title={isManagerOrAdmin ? 'إعجاب — اضغط مطولاً لعرض المعجبين' : 'اضغط مطولاً لعرض المعجبين'}
                                    disabled={!isManagerOrAdmin || likingVisit === v.id}
                                    onClick={() => isManagerOrAdmin && toggleDashLike(v.id)}
                                    onMouseDown={() => { likeTimer.current = setTimeout(() => setShowLikersId(v.id), 600); }}
                                    onMouseUp={() => clearTimeout(likeTimer.current)}
                                    onMouseLeave={() => clearTimeout(likeTimer.current)}
                                    onTouchStart={() => { likeTimer.current = setTimeout(() => setShowLikersId(v.id), 600); }}
                                    onTouchEnd={() => clearTimeout(likeTimer.current)}
                                    style={{
                                      position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                      width: 28, height: 28, borderRadius: '50%', padding: 0,
                                      border: 'none', background: 'transparent',
                                      cursor: isManagerOrAdmin ? 'pointer' : 'default', lineHeight: 1,
                                      transition: 'opacity 0.15s',
                                    }}>
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill={likeCount > 0 ? '#ef4444' : 'none'} stroke={likeCount > 0 ? '#ef4444' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                    {likeCount > 0 && (
                                      <span style={{
                                        position: 'absolute', top: -5, right: -5,
                                        background: '#ef4444', color: '#fff', borderRadius: '50%',
                                        fontSize: 9, fontWeight: 800, width: 15, height: 15,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        lineHeight: 1, border: '1.5px solid #fff',
                                      }}>{likeCount}</span>
                                    )}
                                  </button>
                                  {showLikersId === v.id && (
                                    <div style={{
                                      position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)',
                                      background: '#1e293b', color: '#fff', borderRadius: 8, padding: '6px 10px',
                                      fontSize: 11, whiteSpace: 'nowrap', zIndex: 999,
                                      boxShadow: '0 4px 12px rgba(0,0,0,0.25)', minWidth: 110,
                                    }} onClick={() => setShowLikersId(null)}>
                                      <div style={{ fontWeight: 700, marginBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: 3 }}>❤️ المعجبون</div>
                                      {likeCount === 0
                                        ? <div style={{ color: '#94a3b8' }}>لا أحد بعد</div>
                                        : likes.map((l: any) => <div key={l.id}>👤 {l.user.username}</div>)
                                      }
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                        );
                        return rows;
                      }, [])}
                  </tbody>
                </table>
              </div>

              {/* ── Statistics summary ── */}
              {(() => {
                const doctorCalls   = filteredVisits.filter(v => (v as any)._visitType !== 'pharmacy');
                const pharmacyCalls = filteredVisits.filter(v => (v as any)._visitType === 'pharmacy');

                // Count calls per item
                const itemCounts: Record<string, number> = {};
                filteredVisits.forEach(v => {
                  if ((v as any)._visitType === 'pharmacy') {
                    const items: any[] = (v as any).pharmItems ?? [];
                    if (items.length === 0) {
                      const k = '—';
                      itemCounts[k] = (itemCounts[k] ?? 0) + 1;
                    } else {
                      items.forEach((pi: any) => {
                        const k = pi.item?.name ?? pi.itemName ?? '—';
                        itemCounts[k] = (itemCounts[k] ?? 0) + 1;
                      });
                    }
                  } else {
                    const k = (v as any).item?.name ?? '—';
                    itemCounts[k] = (itemCounts[k] ?? 0) + 1;
                  }
                });
                const itemEntries = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);

                return (
                  <div style={{ margin: '8px 0 4px', padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', direction: 'rtl' }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#1e293b', marginBottom: 8 }}>📊 إحصائيات الكولات</div>
                    {/* Totals row */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 10px' }}>
                        <span style={{ fontSize: 12 }}>👨‍⚕️</span>
                        <div>
                          <div style={{ fontSize: 9, color: '#64748b', lineHeight: 1 }}>أطباء</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: '#4f46e5', lineHeight: 1.2 }}>{doctorCalls.length}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '4px 10px' }}>
                        <span style={{ fontSize: 12 }}>🏪</span>
                        <div>
                          <div style={{ fontSize: 9, color: '#64748b', lineHeight: 1 }}>صيدليات</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: '#059669', lineHeight: 1.2 }}>{pharmacyCalls.length}</div>
                        </div>
                      </div>
                    </div>
                    {/* Per-item counts */}
                    {itemEntries.length > 0 && (
                      <>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', marginBottom: 5 }}>📦 حسب الايتم</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {itemEntries.map(([name, count]) => (
                            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '3px 8px', fontSize: 11 }}>
                              <span style={{ fontWeight: 600, color: '#1e293b' }}>{name}</span>
                              <span style={{ background: '#eef2ff', color: '#4f46e5', borderRadius: 4, padding: '1px 6px', fontWeight: 800, fontSize: 11 }}>{count}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>

        {/* Voice overlay — two-step: reminder panel then recording */}
        {voiceOverlay && (() => {
          // Collect unique target items across all plan entries
          const planItems: string[] = activePlan
            ? [...new Set<string>((activePlan.entries ?? []).flatMap((e: any) =>
                (e.targetItems ?? []).map((ti: any) => String(ti.item?.name ?? '')).filter(Boolean)
              ))]
            : [];
          return (
            <div
              onClick={voiceListening || voiceParsing ? undefined : stopVoice}
              style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.78)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: voiceListening || voiceParsing ? 'default' : 'pointer' }}
            >
              <div onClick={e => e.stopPropagation()}
                style={{ background: '#fff', borderRadius: '20px', padding: '28px 24px 24px',
                  maxWidth: 360, width: '94%', textAlign: 'center', direction: 'rtl',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
              >
                {/* ── Step 1: Reminder panel (before recording) ── */}
                {voiceReady && !voiceListening && !voiceParsing && (
                  <>
                    <div style={{ fontSize: 44, marginBottom: 8 }}>🎙️</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: '#111827', marginBottom: 10 }}>نوع الزيارة الصوتية</div>
                    {/* Call type selector */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: 14, justifyContent: 'center' }}>
                      <button
                        onClick={() => setCallType('doctor')}
                        style={{ flex: 1, padding: '8px 12px', borderRadius: '10px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                          border: `2px solid ${callType === 'doctor' ? '#6366f1' : '#e5e7eb'}`,
                          background: callType === 'doctor' ? '#eef2ff' : '#fff',
                          color: callType === 'doctor' ? '#4338ca' : '#6b7280' }}
                      >👨‍⚕️ طبيب</button>
                      <button
                        onClick={() => setCallType('pharmacy')}
                        style={{ flex: 1, padding: '8px 12px', borderRadius: '10px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                          border: `2px solid ${callType === 'pharmacy' ? '#059669' : '#e5e7eb'}`,
                          background: callType === 'pharmacy' ? '#f0fdf4' : '#fff',
                          color: callType === 'pharmacy' ? '#065f46' : '#6b7280' }}
                      >🏪 صيدلية</button>
                    </div>
                    {callType === 'doctor' ? (
                      <>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>اذكر بالترتيب: اسم الطبيب ← الايتم ← النتيجة ← ملاحظات</div>
                        {planItems.length > 0 && (
                          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px',
                            padding: '10px 14px', marginBottom: 16, textAlign: 'right' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 6 }}>📦 الايتمات في بلانك:</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' }}>
                              {planItems.map((name, i) => (
                                <span key={i} style={{ background: '#dcfce7', color: '#166534', borderRadius: '6px',
                                  padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{name}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px',
                        padding: '10px 14px', marginBottom: 16, textAlign: 'right' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>🏪 اذكر بالترتيب لزيارة الصيدلية:</div>
                        <div style={{ fontSize: 12, color: '#374151' }}>اسم الصيدلية ← المنطقة ← الايتمات (مع ملاحظة كل ايتم)</div>
                      </div>
                    )}
                    <button
                      onClick={startRecordingNow}
                      style={{ width: '100%', background: callType === 'pharmacy' ? '#059669' : '#f97316', color: '#fff', border: 'none',
                        borderRadius: '10px', padding: '11px', fontSize: 15, fontWeight: 800, cursor: 'pointer',
                        marginBottom: 8 }}
                    >
                      🎤 ابدأ التسجيل
                    </button>
                    <button onClick={stopVoice}
                      style={{ width: '100%', background: '#f1f5f9', color: '#374151', border: 'none',
                        borderRadius: '10px', padding: '9px', fontSize: 13, cursor: 'pointer' }}
                    >
                      إلغاء
                    </button>
                  </>
                )}

                {/* ── Step 2: Recording in progress ── */}
                {voiceListening && !voiceParsing && (
                  <>
                    <div style={{ fontSize: 52, marginBottom: 8, animation: 'clGpsPulse 1.2s ease-in-out infinite', color: '#ef4444' }}>🎤</div>
                    <div style={{ fontWeight: 800, fontSize: 17, color: '#111827', marginBottom: 4 }}>{callType === 'pharmacy' ? 'جاري تسجيل زيارة صيدلية...' : 'جاري التسجيل...'}</div>
                    {callType === 'doctor' && planItems.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', justifyContent: 'center',
                        marginBottom: 14 }}>
                        {planItems.map((name, i) => (
                          <span key={i} style={{ background: '#fef3c7', color: '#92400e', borderRadius: '6px',
                            padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{name}</span>
                        ))}
                      </div>
                    )}
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px' }}>
                      {callType === 'pharmacy'
                        ? 'اذكر: الصيدلية ← المنطقة ← الايتمات ← الملاحظات'
                        : 'اذكر: الطبيب ← الايتم ← النتيجة ← ملاحظات'}
                    </p>
                    <button onClick={stopVoice}
                      style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: '10px',
                        padding: '10px 32px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                    >
                      ⏹ إيقاف التسجيل
                    </button>
                  </>
                )}

                {/* ── Parsing / loading ── */}
                {voiceParsing && (
                  <>
                    <div style={{ fontSize: 52, marginBottom: 8 }}>⏳</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>جاري تحليل الكلام...</div>
                  </>
                )}

                {voiceError && (
                  <p style={{ fontSize: 13, color: '#ef4444', marginTop: 10 }}>{voiceError}</p>
                )}
              </div>
            </div>
          );
        })()}

        {showMap && callsData && (
          <DailyCallsMap visits={callsData.visits} onClose={() => setShowMap(false)} />
        )}
        {mapSingleVisit && (
          <DailyCallsMap visits={[mapSingleVisit]} onClose={() => setMapSingleVisit(null)} />
        )}

        {/* ── Quick Call Log Modal ── */}
        {showCallLog && (
          <div
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
            onClick={e => { if (e.target === e.currentTarget) setShowCallLog(false); }}
          >
            <div style={{ background: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '500px', direction: 'rtl', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', maxHeight: '92vh', overflowY: 'auto' }}>

              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#111827' }}>
                  {callType === 'pharmacy' ? '🏪 تسجيل زيارة صيدلية' : '✏️ تسجيل زيارة طبيب'}
                </h3>
                {/* Date / time / GPS */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ textAlign: 'left', lineHeight: 1.3 }}>
                    <div style={{ fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {new Date().toLocaleDateString('ar-IQ-u-nu-latn', { weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric' })}
                    </div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{clNow}</div>
                  </div>
                  {/* GPS status widget — tap to retry */}
                  <div
                    onClick={() => { if (clGpsStatus !== 'got') startGpsCapture(); }}
                    title={
                      clGpsStatus === 'got'
                        ? `تم تحديد الموقع${clAccuracy !== null ? ` ±${clAccuracy}م` : ''}`
                        : clGpsStatus === 'getting' ? 'جاري تحديد الموقع...'
                        : 'فشل GPS — اضغط للإعادة'
                    }
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                      cursor: clGpsStatus !== 'got' ? 'pointer' : 'default', userSelect: 'none', flexShrink: 0 }}
                  >
                    {/* Ripple dot */}
                    <div style={{ position: 'relative', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {(clGpsStatus === 'got' || clGpsStatus === 'getting') && (
                        <div
                          className="gps-ripple"
                          style={{
                            background: clGpsStatus === 'got' ? '#10b981' : '#f59e0b',
                            animation: 'gpsRipple 1.6s ease-out infinite',
                          }}
                        />
                      )}
                      <div style={{
                        width: 12, height: 12, borderRadius: '50%', position: 'relative', zIndex: 1, flexShrink: 0,
                        background: clGpsStatus === 'got' ? '#10b981' : clGpsStatus === 'getting' ? '#f59e0b' : '#ef4444',
                        animation: clGpsStatus === 'getting' ? 'clGpsPulse 1s ease-in-out infinite' : 'none',
                      }} />
                    </div>
                    {/* Status label */}
                    <span style={{ fontSize: '9px', fontWeight: 700, whiteSpace: 'nowrap', lineHeight: 1,
                      color: clGpsStatus === 'got' ? '#10b981' : clGpsStatus === 'getting' ? '#d97706' : '#ef4444' }}>
                      {clGpsStatus === 'got'
                        ? (clAccuracy !== null ? `±${clAccuracy}م` : '✓ محدَّد')
                        : clGpsStatus === 'getting' ? 'جاري...'
                        : '✕ موقع'}
                    </span>
                  </div>
                  <button onClick={() => { clearInterval(clTimerRef.current); stopGpsWatch(); setShowCallLog(false); }} style={{ background: 'none', border: 'none', fontSize: '22px', cursor: 'pointer', color: '#6b7280', lineHeight: 1, padding: '0 4px' }}>×</button>
                </div>
              </div>

              {/* Plan info */}
              {activePlan && callType === 'doctor' && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '8px 12px', marginBottom: '16px', fontSize: '13px', color: '#166534' }}>
                  📋 البلان: شهر {activePlan.month}/{activePlan.year} — {activePlan.entries?.length ?? 0} طبيب
                </div>
              )}

              {/* HTTP warning — GPS blocked on plain HTTP */}
              {isInsecureHttp && (
                <div style={{ background: '#fef2f2', border: '1.5px solid #fca5a5', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', fontSize: '12px', color: '#991b1b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <span>⚠️ GPS لا يعمل على HTTP — استخدم الرابط الآمن للهاتف</span>
                  <a href="https://ordine-sales.up.railway.app" target="_blank" rel="noopener noreferrer"
                    style={{ background: '#059669', color: '#fff', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                    🔗 فتح الرابط الآمن
                  </a>
                </div>
              )}

              {/* ── Call Type Tabs ── */}
              <div style={{ display: 'flex', gap: '6px', marginBottom: '18px' }}>
                <button
                  onClick={() => setCallType('doctor')}
                  style={{ flex: 1, padding: '9px 10px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    border: `2px solid ${callType === 'doctor' ? '#6366f1' : '#e5e7eb'}`,
                    background: callType === 'doctor' ? '#eef2ff' : '#f9fafb',
                    color: callType === 'doctor' ? '#4338ca' : '#6b7280' }}
                >👨‍⚕️ زيارة طبيب</button>
                <button
                  onClick={() => setCallType('pharmacy')}
                  style={{ flex: 1, padding: '9px 10px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    border: `2px solid ${callType === 'pharmacy' ? '#059669' : '#e5e7eb'}`,
                    background: callType === 'pharmacy' ? '#f0fdf4' : '#f9fafb',
                    color: callType === 'pharmacy' ? '#065f46' : '#6b7280' }}
                >🏪 زيارة صيدلية</button>
              </div>

              {/* ── Pharmacy Form ─────────────────────────────── */}
              {callType === 'pharmacy' && (
                <div>
                  {/* Pharmacy Name with autocomplete */}
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
                      🏪 اسم الصيدلية <span style={{ color: '#ef4444' }}>*</span>
                      {clPharmacyIsNew && clPharmacyName.trim() && (
                        <span style={{ marginRight: '8px', fontSize: '11px', background: '#fef3c7', color: '#d97706', borderRadius: '6px', padding: '2px 8px', fontWeight: 700 }}>جديد</span>
                      )}
                      {!clPharmacyIsNew && clPharmacyName.trim() && (
                        <span style={{ marginRight: '8px', fontSize: '11px', background: '#d1fae5', color: '#065f46', borderRadius: '6px', padding: '2px 8px', fontWeight: 700 }}>✓ موجود</span>
                      )}
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="اكتب اسم الصيدلية..."
                        value={clPharmacyName}
                        autoComplete="off"
                        onChange={async e => {
                          const val = e.target.value;
                          setClPharmacyName(val);
                          if (!val.trim()) {
                            setClPharmacyNameSugg([]); setClPharmacyNameShowSugg(false); setClPharmacyIsNew(false);
                            return;
                          }
                          try {
                            const r = await fetch(`/api/pharmacies/suggestions?q=${encodeURIComponent(val.trim())}`, { headers: authH() });
                            const names: string[] = await r.json();
                            setClPharmacyNameSugg(names);
                            setClPharmacyNameShowSugg(names.length > 0);
                            const exactMatch = names.some(n => n.toLowerCase() === val.trim().toLowerCase());
                            setClPharmacyIsNew(!exactMatch);
                          } catch {
                            setClPharmacyNameSugg([]); setClPharmacyIsNew(true);
                          }
                        }}
                        onFocus={() => { if (clPharmacyNameSugg.length > 0) setClPharmacyNameShowSugg(true); }}
                        onBlur={async e => {
                          setTimeout(() => setClPharmacyNameShowSugg(false), 200);
                          const name = e.target.value.trim();
                          if (!name || clPharmacyAreaId || clPharmacyAreaName) return;
                          try {
                            const r = await fetch(`/api/pharmacy-area-lookup?name=${encodeURIComponent(name)}`, { headers: authH() });
                            const data = await r.json();
                            if (data.areaId) { setClPharmacyAreaId(String(data.areaId)); setClPharmacyAreaName(data.areaName); }
                          } catch {}
                        }}
                        style={{ width: '100%', boxSizing: 'border-box' }}
                      />
                      {clPharmacyNameShowSugg && clPharmacyNameSugg.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 400, background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.14)', marginTop: '2px', overflow: 'hidden' }}>
                          {clPharmacyNameSugg.map((name, i) => (
                            <div
                              key={i}
                              onMouseDown={async () => {
                                setClPharmacyName(name);
                                setClPharmacyIsNew(false);
                                setClPharmacyNameShowSugg(false);
                                if (!clPharmacyAreaId && !clPharmacyAreaName) {
                                  try {
                                    const r = await fetch(`/api/pharmacy-area-lookup?name=${encodeURIComponent(name)}`, { headers: authH() });
                                    const data = await r.json();
                                    if (data.areaId) { setClPharmacyAreaId(String(data.areaId)); setClPharmacyAreaName(data.areaName); }
                                  } catch {}
                                }
                              }}
                              style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '13px', color: '#111827', display: 'flex', alignItems: 'center', gap: '6px' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                              onMouseLeave={e => (e.currentTarget.style.background = '')}
                            >
                              <span style={{ fontSize: '11px', color: '#059669' }}>✓</span> {name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Area */}
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>📍 المنطقة</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="اكتب اسم المنطقة..."
                        value={clPharmacyAreaName}
                        autoComplete="off"
                        onChange={e => {
                          const v = e.target.value;
                          setClPharmacyAreaName(v);
                          setClPharmacyAreaId('');
                          if (v.trim()) {
                            const lv = v.toLowerCase();
                            const sugg = clAreas.filter((a: any) => a.name.toLowerCase().includes(lv)).slice(0, 8);
                            setClPharmacyAreaSugg(sugg);
                            setClPharmacyAreaShowSugg(true);
                          } else {
                            setClPharmacyAreaSugg([]);
                            setClPharmacyAreaShowSugg(false);
                          }
                        }}
                        onBlur={() => setTimeout(() => setClPharmacyAreaShowSugg(false), 200)}
                        onFocus={() => { if (clPharmacyAreaSugg.length > 0) setClPharmacyAreaShowSugg(true); }}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px', paddingLeft: clPharmacyAreaId ? '28px' : undefined }}
                      />
                      {clPharmacyAreaId && (
                        <span style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '11px', color: '#059669', fontWeight: 700 }}>✓</span>
                      )}
                      {clPharmacyAreaShowSugg && clPharmacyAreaSugg.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: '2px', overflow: 'hidden' }}>
                          {clPharmacyAreaSugg.map((a: any) => (
                            <div
                              key={a.id}
                              onMouseDown={() => { setClPharmacyAreaName(a.name); setClPharmacyAreaId(String(a.id)); setClPharmacyAreaShowSugg(false); }}
                              style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '13px', color: '#111827' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                              onMouseLeave={e => (e.currentTarget.style.background = '')}
                            >{a.name}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Items list */}
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '8px' }}>📦 الايتمات <span style={{ color: '#ef4444' }}>*</span></label>
                    {clPharmacyItems.map((pit, idx) => (
                      <div key={pit.tempId} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px 12px', marginBottom: '8px', background: '#fafafa', position: 'relative' }}>
                        {/* Item search */}
                        <div style={{ position: 'relative', marginBottom: '6px' }}>
                          <input
                            type="text"
                            className="form-input"
                            placeholder="ابحث باسم الايتم..."
                            value={pit.itemName}
                            autoComplete="off"
                            onChange={e => {
                              const v = e.target.value;
                              setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, itemName: v, itemId: '' } : p));
                              if (!v.trim()) {
                                setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, sugg: [], showSugg: false } : p));
                                return;
                              }
                              const lv = v.toLowerCase();
                              const matches = clAllItems.filter((i: any) => i.name.toLowerCase().includes(lv)).slice(0, 8);
                              setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, sugg: matches, showSugg: true } : p));
                            }}
                            onBlur={() => setTimeout(() => setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, showSugg: false } : p)), 200)}
                            onFocus={() => { if (pit.sugg.length > 0) setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, showSugg: true } : p)); }}
                            style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px', paddingLeft: pit.itemId ? '28px' : undefined }}
                          />
                          {pit.itemId && (
                            <span style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '11px', color: '#059669', fontWeight: 700 }}>✓</span>
                          )}
                          {pit.showSugg && pit.sugg.length > 0 && (
                            <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 300, background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: '2px', overflow: 'hidden' }}>
                              {pit.sugg.map((item: any) => (
                                <div
                                  key={item.id}
                                  onMouseDown={() => setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, itemId: String(item.id), itemName: item.name, sugg: [], showSugg: false } : p))}
                                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '13px', color: '#111827' }}
                                  onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                                >
                                  {item.name}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Per-item notes */}
                        <input
                          type="text"
                          className="form-input"
                          placeholder="ملاحظات هذا الايتم (اختياري)..."
                          value={pit.notes}
                          onChange={e => setClPharmacyItems(prev => prev.map(p => p.tempId === pit.tempId ? { ...p, notes: e.target.value } : p))}
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px' }}
                        />
                        {/* Remove button (only if more than 1 item) */}
                        {clPharmacyItems.length > 1 && (
                          <button
                            onClick={() => setClPharmacyItems(prev => prev.filter(p => p.tempId !== pit.tempId))}
                            style={{ position: 'absolute', top: '6px', left: '8px', background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', color: '#ef4444', lineHeight: 1, padding: 0 }}
                            title="حذف الايتم"
                          >×</button>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        const newId = clPharmacyItemCounter.current++;
                        setClPharmacyItems(prev => [...prev, { tempId: newId, itemId: '', itemName: '', notes: '', showSugg: false, sugg: [] }]);
                      }}
                      style={{ fontSize: '13px', color: '#059669', background: 'none', border: '1px dashed #6ee7b7', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', width: '100%' }}
                    >
                      + إضافة ايتم آخر
                    </button>
                  </div>
                  {/* General notes */}
                  <div style={{ marginBottom: '18px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>📝 ملاحظات عامة</label>
                    <textarea
                      className="form-input"
                      placeholder="ملاحظات الزيارة..."
                      value={clNotes}
                      onChange={e => setClNotes(e.target.value)}
                      rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: '13px' }}
                    />
                  </div>
                </div>
              )}

              {/* ── Doctor Form (shown when callType === 'doctor') ── */}
              {callType === 'doctor' && (
                <div>

              {/* Doctor Name */}
              <div style={{ marginBottom: '16px', position: 'relative' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
                  👨‍⚕️ اسم الطبيب <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="اكتب اسم الطبيب للبحث..."
                  value={clDoctor}
                  onChange={e => handleClDoctorChange(e.target.value)}
                  onBlur={() => { setTimeout(() => { setClShowSugg(false); if (!clSelectedEntry && clDoctor.trim()) detectNotInPlan(); }, 200); }}
                  onFocus={() => { if (clSuggestions.length > 0) setClShowSugg(true); }}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  autoComplete="off"
                />
                {/* Autocomplete dropdown */}
                {clShowSugg && clSuggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 200, background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: '4px', overflow: 'hidden' }}>
                    {clSuggestions.map((entry: any) => (
                      <div
                        key={entry.id}
                        onMouseDown={() => selectClEntry(entry)}
                        style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '14px', color: '#111827' }}>{entry.doctor.name}</div>
                            {entry.doctor.specialty && <div style={{ fontSize: '12px', color: '#6b7280' }}>{entry.doctor.specialty}</div>}
                            {(entry.doctor.pharmacyName || entry.doctor.area?.name) && (
                              <div style={{ fontSize: '11px', color: '#9ca3af' }}>
                                {[entry.doctor.pharmacyName, entry.doctor.area?.name].filter(Boolean).join(' — ')}
                              </div>
                            )}
                          </div>
                          {entry._inPlan
                            ? <span style={{ fontSize: '10px', background: '#d1fae5', color: '#065f46', padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap', flexShrink: 0 }}>✓ في البلان</span>
                            : <span style={{ fontSize: '10px', background: '#fef3c7', color: '#92400e', padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap', flexShrink: 0 }}>خارج البلان</span>
                          }
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Selected doctor badge */}
                {clSelectedEntry && (
                  <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ background: '#d1fae5', color: '#065f46', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', fontWeight: 600 }}>✓ في البلان</span>
                    {clSelectedEntry.doctor.specialty && <span style={{ fontSize: '12px', color: '#6b7280' }}>{clSelectedEntry.doctor.specialty}</span>}
                    {(clSelectedEntry.doctor.pharmacyName || clSelectedEntry.doctor.area?.name) && (
                      <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                        {[clSelectedEntry.doctor.pharmacyName, clSelectedEntry.doctor.area?.name].filter(Boolean).join(' — ')}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Not-in-plan: catalog doctor found — show their details */}
              {clNotInPlan && clOtherDoc && (
                <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#92400e', marginBottom: '16px' }}>
                  <div style={{ fontWeight: 600, marginBottom: '6px' }}>⚠️ الطبيب خارج البلان — سيُضاف تلقائياً عند التسجيل</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', color: '#374151', fontSize: '12px' }}>
                    {clOtherDoc.specialty && (
                      <span style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '5px', padding: '2px 8px' }}>🔬 {clOtherDoc.specialty}</span>
                    )}
                    {clOtherDoc.pharmacyName && (
                      <span style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '5px', padding: '2px 8px' }}>🏪 {clOtherDoc.pharmacyName}</span>
                    )}
                    {clOtherDoc.area?.name && (
                      <span style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '5px', padding: '2px 8px' }}>📍 {clOtherDoc.area.name}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Not-in-plan: catalog suggestions (doctor name typed, not selected from dropdown) */}
              {clNotInPlan && !clOtherDoc && !clManualMode && (
                <div style={{ marginBottom: '16px' }}>
                  {clSuggestions.filter((s: any) => !s._inPlan).length > 0 ? (
                    <>
                      <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
                        ⚠️ "<strong>{clDoctor}</strong>" غير موجود في البلان — اختر من النتائج أدناه أو أضف يدوياً
                      </div>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', marginBottom: '8px' }}>
                        {clSuggestions.filter((s: any) => !s._inPlan).map((entry: any) => (
                          <div
                            key={entry.doctor.id}
                            onMouseDown={() => selectClEntry(entry)}
                            style={{ padding: '8px 14px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: '#fff' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#fefce8')}
                            onMouseLeave={e => (e.currentTarget.style.background = '')}
                          >
                            <div style={{ fontWeight: 600, fontSize: '13px' }}>{entry.doctor.name}</div>
                            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              {entry.doctor.specialty && <span>🔬 {entry.doctor.specialty}</span>}
                              {entry.doctor.pharmacyName && <span>🏪 {entry.doctor.pharmacyName}</span>}
                              {entry.doctor.area?.name && <span>📍 {entry.doctor.area.name}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
                      ⚠️ "<strong>{clDoctor}</strong>" غير موجود في القوائم
                    </div>
                  )}
                  <button
                    onClick={() => setClManualMode(true)}
                    style={{ fontSize: '13px', color: '#1d4ed8', background: 'none', border: '1px solid #93c5fd', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer' }}
                  >
                    ✏️ إدخال بيانات الطبيب يدوياً
                  </button>
                </div>
              )}

              {/* Manual mode: fill in doctor details */}
              {clManualMode && (
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: '#0369a1', marginBottom: '10px' }}>📋 بيانات الطبيب الجديد</div>
                  <div style={{ display: 'grid', gap: '10px' }}>
                    <div>
                      <label style={{ fontSize: '12px', color: '#374151', display: 'block', marginBottom: '4px' }}>🔬 الاختصاص</label>
                      <input
                        type="text" className="form-input"
                        placeholder="اختصاص الطبيب..."
                        value={clManualSpecialty}
                        onChange={e => setClManualSpecialty(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: '#374151', display: 'block', marginBottom: '4px' }}>🏪 اسم الصيدلية</label>
                      <input
                        type="text" className="form-input"
                        placeholder="اسم الصيدلية..."
                        value={clManualPharmacy}
                        onChange={e => setClManualPharmacy(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: '#374151', display: 'block', marginBottom: '4px' }}>📍 المنطقة</label>
                      <select
                        className="form-input"
                        value={clManualAreaId}
                        onChange={e => setClManualAreaId(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px' }}
                      >
                        <option value="">— بدون منطقة —</option>
                        {clAreas.map((a: any) => (
                          <option key={a.id} value={String(a.id)}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Item selector */}
              {clNotInPlan && (
                <div style={{ background: '#fff7ed', border: '1px solid #fdba74', borderRadius: '8px', padding: '8px 14px', marginBottom: '14px', fontSize: '13px', color: '#9a3412', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: 16 }}>⚠️</span>
                  <span><strong>الطبيب خارج الخطة</strong> — تأكد من تفاصيل الزيارة قبل الحفظ</span>
                </div>
              )}

              {/* Item selector */}
              <div style={{ marginBottom: '16px', position: 'relative' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>📦 الايتم</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="ابحث باسم الايتم..."
                  value={clItemName}
                  autoComplete="off"
                  onChange={e => {
                    const v = e.target.value;
                    setClItemName(v);
                    setClItemId('');
                    if (!v.trim()) { setClItemSugg([]); setClItemShowSugg(false); return; }
                    const lv = v.toLowerCase();
                    const matches = clAllItems.filter((i: any) => i.name.toLowerCase().includes(lv)).slice(0, 8);
                    setClItemSugg(matches);
                    setClItemShowSugg(true);
                  }}
                  onBlur={() => setTimeout(() => {
                    setClItemShowSugg(false);
                    // Auto-resolve: if text set but no ID yet, pick the first exact/partial match
                    if (!clItemId && clItemName.trim()) {
                      const lv = clItemName.trim().toLowerCase();
                      const first = clItemSugg[0] ?? clAllItems.find((i: any) => i.name.toLowerCase().includes(lv) || lv.includes(i.name.toLowerCase()));
                      if (first) { setClItemId(String(first.id)); setClItemName(first.name); }
                    }
                  }, 200)}
                  onFocus={() => { if (clItemSugg.length > 0) setClItemShowSugg(true); }}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
                {clItemId && (
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(4px)', fontSize: '11px', color: '#059669', fontWeight: 600 }}>✓</span>
                )}
                {clItemShowSugg && clItemSugg.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 200, background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: '4px', overflow: 'hidden' }}>
                    {clItemSugg.map((item: any) => (
                      <div
                        key={item.id}
                        onMouseDown={() => { setClItemId(String(item.id)); setClItemName(item.name); setClItemSugg([]); setClItemShowSugg(false); }}
                        style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '13px', color: '#111827' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        {item.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Feedback */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '8px' }}>💬 نتيجة الزيارة</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {(['writing', 'stocked', 'interested', 'not_interested', 'unavailable', 'pending'] as const).map(fb => (
                    <button
                      key={fb}
                      onClick={() => setClFeedback(fb)}
                      style={{
                        padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                        cursor: 'pointer', transition: 'all 0.15s',
                        border: `2px solid ${clFeedback === fb ? (feedbackColor[fb] ?? '#374151') : '#e5e7eb'}`,
                        background: clFeedback === fb ? ((feedbackColor[fb] ?? '#374151') + '22') : '#fff',
                        color: clFeedback === fb ? (feedbackColor[fb] ?? '#374151') : '#6b7280',
                      }}
                    >
                      {feedbackLabel(fb)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes — doctor only */}
              {callType === 'doctor' && (
              <div style={{ marginBottom: '20px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>📝 ملاحظات</label>
                <textarea
                  className="form-input"
                  placeholder="أكتب ملاحظات الزيارة..."
                  value={clNotes}
                  onChange={e => setClNotes(e.target.value)}
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: '13px', padding: '6px 10px' }}
                />
              </div>
              )}

              {/* Close doctor form wrapper */}
              {callType === 'doctor' && (
                <div style={{ display: 'none' }}/>
              )}
              </div>
              )}
              {/* ── End of conditional forms ── */}

              {/* GPS Warning — shown when user tries to submit without location */}
              {clGpsWarning && clGpsStatus !== 'got' && (
                <div style={{ background: '#fef3c7', border: '2px solid #f59e0b', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#92400e', marginBottom: '6px' }}>📍 الموقع الجغرافي غير محدد</div>
                  <div style={{ fontSize: '13px', color: '#78350f', marginBottom: '12px' }}>
                    {isInsecureHttp
                      ? 'أنت على رابط HTTP غير آمن — متصفح الهاتف يمنع GPS على هذا الرابط. يجب فتح التطبيق من رابط الشبكة الآمن.'
                      : clGpsStatus === 'getting'
                        ? 'جاري تحديد الموقع... انتظر لحظة أو تابع بدون موقع.'
                        : 'تم رفض إذن الموقع. اضغط «إعادة المحاولة» أو افتح إعدادات المتصفح ← الموقع الجغرافي ← السماح.'}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {isInsecureHttp ? (
                      <a
                        href="https://ordine-sales.up.railway.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ padding: '7px 16px', background: '#059669', border: 'none', borderRadius: '7px', fontSize: '13px', fontWeight: 700, color: '#fff', cursor: 'pointer', textDecoration: 'none' }}
                      >🔗 فتح الرابط الآمن (Railway)</a>
                    ) : (
                      <button
                        onClick={retryGps}
                        style={{ padding: '7px 16px', background: '#f59e0b', border: 'none', borderRadius: '7px', fontSize: '13px', fontWeight: 700, color: '#fff', cursor: 'pointer' }}
                      >{clGpsStatus === 'getting' ? '⏳ جاري التحديد...' : '🔄 إعادة المحاولة'}</button>
                    )}
                    <button
                      onClick={submitCallLog}
                      style={{ padding: '7px 16px', background: '#6b7280', border: 'none', borderRadius: '7px', fontSize: '13px', fontWeight: 600, color: '#fff', cursor: 'pointer' }}
                    >متابعة بدون موقع ←</button>
                  </div>
                </div>
              )}

              {/* Error */}
              {clError && (
                <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', fontSize: '13px', color: '#991b1b' }}>
                  ❌ {clError}
                </div>
              )}

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowCallLog(false)}
                  style={{ padding: '8px 20px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', color: '#374151' }}
                >
                  إلغاء
                </button>
                <button
                  onClick={submitCallLog}
                  disabled={clSaving || (
                    callType === 'doctor'
                      ? (!clSelectedEntry && !clOtherDocId && !(clManualMode && clDoctor.trim()))
                      : (!clPharmacyName.trim() || !clPharmacyItems.some(it => it.itemId || it.itemName.trim()))
                  )}
                  style={{
                    padding: '8px 24px', background: '#059669', border: 'none', borderRadius: '8px',
                    fontSize: '14px', cursor: 'pointer', color: '#fff', fontWeight: 700,
                    opacity: (clSaving || (callType === 'doctor'
                      ? (!clSelectedEntry && !clOtherDocId && !(clManualMode && clDoctor.trim()))
                      : (!clPharmacyName.trim() || !clPharmacyItems.some(it => it.itemId || it.itemName.trim())))) ? 0.5 : 1,
                  }}
                >
                  {clSaving ? '⏳ جاري الحفظ...' : '✅ تسجيل الزيارة'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{t.dashboard.title}</h1>
        <p className="page-subtitle">{t.dashboard.subtitle}</p>
      </div>

      {/* Stat Cards */}
      <div className="stats-grid">
        {statCards.map(card => {
          const isMoney = (card as any).type === 'sales' || (card as any).type === 'returns' || (card as any).type === 'net';
          const isOpen  = isMoney && openDropdown === (card as any).type;
          return (
            <div
              className="stat-card"
              key={card.label}
              style={{ borderTop: `4px solid ${card.color}`, cursor: isMoney || card.onClick ? 'pointer' : 'default', outline: isOpen ? `2px solid ${card.color}` : undefined, position: 'relative' }}
              onClick={isMoney ? (e) => toggleDropdown((card as any).type, e as React.MouseEvent<HTMLDivElement>) : card.onClick}
            >
              <div className="stat-card-icon" style={{ background: card.bg, color: card.color }}>{card.icon}</div>
              <div className="stat-card-body">
                <div className="stat-card-value" style={{ color: card.color }}>{card.value}</div>
                <div className="stat-card-label">
                  {card.label}
                  {isMoney && activeFileIds.length > 0 && (
                    <span style={{ fontSize: '10px', marginRight: '4px', opacity: 0.65 }}>({activeFileIds.length} ملف)</span>
                  )}
                </div>
              </div>
              {(isMoney || card.onClick) && <span style={{ color: card.color, fontSize: '1.1rem' }}>{isMoney ? (isOpen ? '↑' : '↓') : '←'}</span>}
            </div>
          );
        })}
      </div>

      {/* ─── Money Dropdown ─── */}
      {openDropdown && dropdownPos && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            minWidth: dropdownPos.width,
            maxWidth: 360,
            zIndex: 9999,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{ padding: '10px 14px', background: openDropdown === 'sales' ? '#d1fae5' : openDropdown === 'returns' ? '#fee2e2' : '#eef2ff', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '13px', color: openDropdown === 'sales' ? '#065f46' : openDropdown === 'returns' ? '#991b1b' : '#3730a3' }}>
              {openDropdown === 'sales' ? '📦 ' + t.dashboard.totalSales : openDropdown === 'returns' ? '↩ ' + t.dashboard.returns : '🏆 ' + t.dashboard.net}
            </span>
            <span style={{ fontWeight: 800, fontSize: '15px', color: openDropdown === 'sales' ? '#10b981' : openDropdown === 'returns' ? '#ef4444' : '#6366f1' }}>
              {fmtMoney(openDropdown === 'sales' ? activeStats.totalSalesValue : openDropdown === 'returns' ? activeStats.totalReturnsValue : netValue)}
            </span>
          </div>
          {/* Per-file list */}
          <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
            {activeStats.files.length === 0 ? (
              <div style={{ padding: '14px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>لا توجد فايلات مفعلة</div>
            ) : (
              activeStats.files.map(f => {
                const val = openDropdown === 'sales' ? f.salesValue : openDropdown === 'returns' ? f.returnsValue : f.salesValue - f.returnsValue;
                const color = openDropdown === 'sales' ? '#10b981' : openDropdown === 'returns' ? '#ef4444' : '#6366f1';
                return (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid #f1f5f9', gap: '10px' }}>
                    <span style={{ fontSize: '12px', color: '#475569', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {f.name}</span>
                    <span style={{ fontWeight: 700, fontSize: '13px', color, whiteSpace: 'nowrap' }}>{fmtMoney(val)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <h2 className="section-title">{t.dashboard.quickActions}</h2>
      <div className="quick-actions-grid">
        {quickActions.map(action => (
          <button key={action.page} className="quick-action-card" onClick={() => onNavigate(action.page)} style={{ borderColor: action.color }}>
            <div className="quick-action-icon" style={{ background: action.color }}>{action.icon}</div>
            <div className="quick-action-body">
              <div className="quick-action-label">{action.label}</div>
              <div className="quick-action-desc">{action.desc}</div>
            </div>
            <span className="quick-action-arrow" style={{ color: action.color }}>←</span>
          </button>
        ))}
      </div>

      {/* About */}
      <div className="info-banner">
        <span className="info-banner-icon">🤖</span>
        <div>
          <strong>{t.dashboard.aiPowered}</strong>
          <p>{t.dashboard.aiDesc}</p>
        </div>
      </div>

      {/* ─── Daily Calls Section ─── */}
      <div style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            📞 {(t.dashboard as any).dailyCalls}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Date range pickers */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#f8fafc', borderRadius: '10px', padding: '5px 10px', border: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' }}>📅 من:</span>
              <input
                type="date"
                className="form-input"
                style={{ padding: '4px 8px', fontSize: '13px', minWidth: 130, border: 'none', background: 'transparent', outline: 'none' }}
                value={callsDateFrom}
                onChange={e => handleCallsDateFromChange(e.target.value)}
              />
              <span style={{ fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' }}>إلى:</span>
              <input
                type="date"
                className="form-input"
                style={{ padding: '4px 8px', fontSize: '13px', minWidth: 130, border: 'none', background: 'transparent', outline: 'none' }}
                value={callsDateTo}
                min={callsDateFrom}
                onChange={e => handleCallsDateToChange(e.target.value)}
              />
              {callsDateFrom !== callsDateTo && (
                <button
                  onClick={() => { setCallsDateFrom(todayStr); setCallsDateTo(todayStr); loadDailyCalls(todayStr, todayStr, callsRepId); }}
                  title="العودة لليوم الحالي"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#6366f1', fontWeight: 700, padding: '2px 4px', whiteSpace: 'nowrap' }}
                >اليوم</button>
              )}
            </div>
            {/* Rep filter — only for admin/manager */}
            {isManagerOrAdmin && callsData && callsData.reps.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                  👤 {(t.dashboard as any).dailyCallsRep}:
                </label>
                <select
                  className="form-input"
                  style={{ padding: '5px 10px', fontSize: '13px' }}
                  value={callsRepId}
                  onChange={e => handleCallsRepChange(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">{(t.dashboard as any).dailyCallsAllReps}</option>
                  {callsData.reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}
            {/* Map button */}
            {callsData && callsData.visits.length > 0 && (
              <button
                className="btn btn--primary"
                style={{ padding: '6px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
                onClick={() => setShowMap(true)}
              >
                {(t.dashboard as any).dailyCallsMapBtn}
              </button>
            )}
          </div>
        </div>

        {/* Table card */}
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          {callsLoading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
              {(t.dashboard as any).dailyCallsLoading}
            </div>
          ) : !callsData || callsData.visits.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: '14px' }}>
              📭 {(t.dashboard as any).dailyCallsNoData}
            </div>
          ) : (
            <>
              {/* Summary bar */}
              <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: '14px', color: '#374151' }}>
                  📞 {(t.dashboard as any).dailyCallsTotal}: {filteredVisits.length}{filteredVisits.length !== callsData.visits.length && <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: '12px' }}> / {callsData.visits.length}</span>}
                </span>
                {/* Per-rep counts */}
                {callsData.reps.map(rep => {
                  const cnt = callsData.visits.filter(v => v.scientificRep.id === rep.id).length;
                  return (
                    <span key={rep.id} style={{ fontSize: '12px', background: '#eef2ff', color: '#4f46e5', borderRadius: '8px', padding: '2px 10px' }}>
                      👤 {rep.name}: {cnt}
                    </span>
                  );
                })}
              </div>
              {/* Filter bar */}
              <div style={{ padding: '8px 10px', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="🔍 بحث: طبيب، صيدلية، منطقة، ايتم..."
                  value={fSearch}
                  onChange={e => setFSearch(e.target.value)}
                  style={{ flex: 1, minWidth: 150, padding: '5px 10px', fontSize: '12px', borderRadius: '8px', border: '1px solid #d1d5db', outline: 'none', direction: 'rtl', background: '#fff' }}
                />
                <button onClick={() => setFType(fType === 'doctor' ? 'all' : 'doctor')}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fType === 'doctor' ? '#6366f1' : '#d1d5db'}`, background: fType === 'doctor' ? '#eef2ff' : '#fff', color: fType === 'doctor' ? '#4338ca' : '#6b7280', fontWeight: fType === 'doctor' ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  👨‍⚕️ طبيب
                </button>
                <button
                  onClick={() => setFType(fType === 'pharmacy' ? 'all' : 'pharmacy')}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fType === 'pharmacy' ? '#059669' : '#d1d5db'}`, background: fType === 'pharmacy' ? '#f0fdf4' : '#fff', color: fType === 'pharmacy' ? '#065f46' : '#6b7280', fontWeight: fType === 'pharmacy' ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  🏪 صيدلية
                </button>
                <button onClick={() => setFDouble(p => !p)}
                  style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: `1.5px solid ${fDouble ? '#7c3aed' : '#d1d5db'}`, background: fDouble ? '#ede9fe' : '#fff', color: fDouble ? '#6d28d9' : '#6b7280', fontWeight: fDouble ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  👥 مزدوجة
                </button>
                {(fSearch || fType !== 'all' || fDouble) && (
                  <button onClick={() => { setFSearch(''); setFType('all'); setFDouble(false); }}
                    style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1.5px solid #ef4444', background: '#fff', color: '#ef4444', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    ✕ مسح
                  </button>
                )}
              </div>

              {/* Table */}
              <div style={{ overflowX: 'auto', maxHeight: '380px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{(t.dashboard as any).dailyCallsColNum}</th>
                      <th>{(t.dashboard as any).dailyCallsColDoctor}</th>
                      {isManagerOrAdmin && <th>{(t.dashboard as any).dailyCallsColRep}</th>}
                      <th>{isMultiDay ? 'التاريخ والوقت' : (t.dashboard as any).dailyCallsColTime}</th>
                      <th>{(t.dashboard as any).dailyCallsColItem}</th>
                      <th>{(t.dashboard as any).dailyCallsColFeedback}</th>
                      <th>{(t.dashboard as any).dailyCallsColLocation}</th>
                      <th style={{ width: 44 }}>❤️</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVisits.map((v, idx) => (
                      <tr key={v.id} style={(v as any)._outOfPlan ? { background: '#fff7ed' } : undefined}>
                        <td>{idx + 1}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                            <strong>{v.doctor.name}</strong>
                            {(v as any)._outOfPlan && (
                              <span style={{ fontSize: '10px', background: '#fed7aa', color: '#9a3412', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>خارج البلان</span>
                            )}
                          </div>
                          {v.doctor.specialty && (
                            <div style={{ fontSize: '11px', color: '#6b7280' }}>{v.doctor.specialty}</div>
                          )}
                        </td>
                        {isManagerOrAdmin && <td>{v.scientificRep.name}</td>}
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {(() => { const { date, time } = fmtDateAndTime(v.visitDate); return isMultiDay ? <><div style={{ fontWeight: 600, color: '#374151' }}>{date}</div><div style={{ fontSize: '11px', color: '#6b7280' }}>{time}</div></> : <><div>{time}</div><div style={{ fontSize: '11px', color: '#9ca3af' }}>{date}</div></>; })()}
                        </td>
                        <td>{v.item?.name ?? '—'}</td>
                        <td>
                          <span style={{
                            background: (feedbackColor[v.feedback] ?? '#e5e7eb') + '22',
                            color:      feedbackColor[v.feedback] ?? '#374151',
                            border:     `1px solid ${feedbackColor[v.feedback] ?? '#e5e7eb'}55`,
                            borderRadius: '6px',
                            padding:    '2px 8px',
                            fontSize:   '12px',
                            fontWeight: 500,
                          }}>
                            {feedbackLabel(v.feedback)}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {v.latitude != null
                            ? <button onClick={() => setMapSingleVisit(v)} title="عرض الموقع على الخريطة" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '22px', padding: '2px', lineHeight: 1 }}>📍</button>
                            : <span style={{ color: '#d1d5db', fontSize: '12px' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'center', position: 'relative' }}>
                          {(() => {
                            const likes = (v as any).likes ?? [];
                            const likeCount = likes.length;
                            const liked = !!(likes.find((l: any) => l.userId === user?.id));
                            return (
                              <div style={{ position: 'relative', display: 'inline-block' }}>
                                <button
                                  title={isManagerOrAdmin ? 'إعجاب — اضغط مطولاً لعرض المعجبين' : 'اضغط مطولاً لعرض المعجبين'}
                                  disabled={!isManagerOrAdmin || likingVisit === v.id}
                                  onClick={() => isManagerOrAdmin && toggleDashLike(v.id)}
                                  onMouseDown={() => { likeTimer.current = setTimeout(() => setShowLikersId(v.id), 600); }}
                                  onMouseUp={() => clearTimeout(likeTimer.current)}
                                  onMouseLeave={() => clearTimeout(likeTimer.current)}
                                  onTouchStart={() => { likeTimer.current = setTimeout(() => setShowLikersId(v.id), 600); }}
                                  onTouchEnd={() => clearTimeout(likeTimer.current)}
                                  style={{
                                    position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                    width: 28, height: 28, borderRadius: '50%', padding: 0,
                                    border: 'none', background: 'transparent',
                                    cursor: isManagerOrAdmin ? 'pointer' : 'default', lineHeight: 1,
                                    transition: 'opacity 0.15s',
                                  }}>
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill={likeCount > 0 ? '#ef4444' : 'none'} stroke={likeCount > 0 ? '#ef4444' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                  {likeCount > 0 && (
                                    <span style={{
                                      position: 'absolute', top: -5, right: -5,
                                      background: '#ef4444', color: '#fff', borderRadius: '50%',
                                      fontSize: 9, fontWeight: 800, width: 15, height: 15,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      lineHeight: 1, border: '1.5px solid #fff',
                                    }}>{likeCount}</span>
                                  )}
                                </button>
                                {showLikersId === v.id && (
                                  <div style={{
                                    position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)',
                                    background: '#1e293b', color: '#fff', borderRadius: 8, padding: '6px 10px',
                                    fontSize: 11, whiteSpace: 'nowrap', zIndex: 999,
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)', minWidth: 110,
                                  }} onClick={() => setShowLikersId(null)}>
                                    <div style={{ fontWeight: 700, marginBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: 3 }}>❤️ المعجبون</div>
                                    {likeCount === 0
                                      ? <div style={{ color: '#94a3b8' }}>لا أحد بعد</div>
                                      : likes.map((l: any) => <div key={l.id}>👤 {l.user.username}</div>)
                                    }
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── Map Modal ─── */}
      {showMap && callsData && (
        <DailyCallsMap
          visits={callsData.visits}
          repName={
            callsRepId
              ? callsData.reps.find(r => r.id === callsRepId)?.name
              : callsData.reps.length === 1 ? callsData.reps[0].name : undefined
          }
          onClose={() => setShowMap(false)}
        />
      )}
      {mapSingleVisit && (
        <DailyCallsMap visits={[mapSingleVisit]} onClose={() => setMapSingleVisit(null)} />
      )}

      {/* ─── Areas Panel Modal ─── */}
      {showAreas && (
        <div className="modal-overlay" onClick={() => setShowAreas(false)}>
          <div className="modal modal--wide" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">📍 {t.dashboard.areasModal} ({areas.length})</h2>
              <button className="modal-close" onClick={() => setShowAreas(false)}>✕</button>
            </div>

            <div style={{ padding: '16px 24px 8px' }}>
              <input
                className="form-input"
                placeholder={t.dashboard.areasSearch}
                value={areaSearch}
                onChange={e => setAreaSearch(e.target.value)}
              />
            </div>

            <div style={{ padding: '8px 24px 24px', maxHeight: '440px', overflowY: 'auto' }}>
              {areasLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>{t.dashboard.loading}</div>
              ) : areas.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>{t.dashboard.noAreas}</div>
              ) : (() => {
                const filtered = areas.filter(a => a.name.toLowerCase().includes(areaSearch.toLowerCase()));
                if (filtered.length === 0) return <div style={{ textAlign: 'center', padding: '1.5rem', color: '#6b7280' }}>{t.dashboard.noResults}</div>;
                // Group alphabetically
                const groups = filtered.reduce<Record<string, typeof filtered>>((acc, a) => {
                  const key = a.name.charAt(0).toUpperCase();
                  if (!acc[key]) acc[key] = [];
                  acc[key].push(a);
                  return acc;
                }, {});
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'ar')).map(([letter, group]) => (
                      <div key={letter}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#0ea5e9', background: '#e0f2fe', borderRadius: '4px', padding: '2px 10px', display: 'inline-block', marginBottom: '8px' }}>
                          {letter} · {group.length}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {group.map(a => (
                            <span key={a.id} style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '5px 12px', fontSize: '13px', color: '#0369a1', fontWeight: 500 }}>
                              📍 {a.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ─── Files Panel Modal ─── */}
      {showFiles && (
        <div className="modal-overlay" onClick={() => { setShowFiles(false); setAnalyzeFile(null); setAnalysisText(''); }}>
          <div className="modal modal--wide" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">📂 {t.dashboard.filesModal}</h2>
              <button className="modal-close" onClick={() => { setShowFiles(false); setAnalyzeFile(null); setAnalysisText(''); }}>✕</button>
            </div>

            {filesLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>{t.dashboard.loading}</div>
            ) : files.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#6b7280' }}>{t.dashboard.noFiles}</div>
            ) : (
              <div className="table-wrapper" style={{ maxHeight: analyzeFile ? '200px' : '400px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t.dashboard.colNum}</th>
                      <th>{t.dashboard.colName}</th>
                      <th>{t.dashboard.colRows}</th>
                      <th>{t.dashboard.colRecords}</th>
                      <th>{t.dashboard.colDate}</th>
                      <th>{t.dashboard.colAction}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f, i) => (
                      <tr key={f.id} style={{ background: activeFileIds.includes(f.id) ? '#f0fdf4' : analyzeFile?.id === f.id ? '#fefce8' : undefined }}>
                        <td>{i + 1}</td>
                        <td><strong>{f.originalName}</strong>{activeFileIds.includes(f.id) && <span style={{ marginRight: '6px', fontSize: '0.75rem', background: '#dcfce7', color: '#16a34a', borderRadius: '4px', padding: '2px 6px' }}>{t.dashboard.active}</span>}</td>
                        <td>{f.rowCount.toLocaleString('ar-IQ-u-nu-latn')}</td>
                        <td>{f._count?.sales?.toLocaleString('ar-IQ-u-nu-latn') ?? '—'}</td>
                        <td>{fmtDate(f.uploadedAt)}</td>
                        <td style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="btn btn--primary"
                            style={{ padding: '4px 12px', fontSize: '0.8rem', background: activeFileIds.includes(f.id) ? '#16a34a' : undefined }}
                            onClick={() => { onFileActivated(f.id); }}
                          >
                            {activeFileIds.includes(f.id) ? t.dashboard.deactivate : t.dashboard.activate}
                          </button>
                          <button
                            className="btn btn--secondary"
                            style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                            onClick={() => runAnalysis(f)}
                            disabled={analyzeLoading}
                          >
                            {analyzeLoading && analyzeFile?.id === f.id ? '⏳' : t.dashboard.analyze}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Analysis result */}
            {analyzeFile && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#374151' }}>
                  {t.dashboard.analysisLabel} <em>{analyzeFile.originalName}</em>
                </div>
                {analyzeLoading ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: '#6b7280' }}>
                    {t.dashboard.analyzing}
                  </div>
                ) : analysisText ? (
                  <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem' }}>
                    <AnalysisRenderer text={analysisText} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
