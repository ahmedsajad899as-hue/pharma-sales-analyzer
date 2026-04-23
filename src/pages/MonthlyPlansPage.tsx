import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { useAuth } from '../context/AuthContext';
import { cachedFetch, invalidateCache, getCached } from '../utils/apiCache';
import * as XLSX from 'xlsx';
import voiceStartSrc from '../assets/voice-start.mp3';
import voiceStopSrc  from '../assets/voice-stop.mp3';

// --- Voice beep: fetch audio buffer once, play via AudioContext (works on iOS/Android) ---
let _audioCtx: AudioContext | null = null;
const _buffers: Record<string, AudioBuffer> = {};

const getAudioCtx = () => {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return _audioCtx;
};

const preloadAudio = async (src: string) => {
  if (_buffers[src]) return;
  try {
    const ctx = getAudioCtx();
    const res = await fetch(src);
    const arr = await res.arrayBuffer();
    _buffers[src] = await ctx.decodeAudioData(arr);
  } catch {}
};

const playAudio = (src: string) => {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (_buffers[src]) {
      const source = ctx.createBufferSource();
      source.buffer = _buffers[src];
      source.connect(ctx.destination);
      source.start(0);
    } else {
      // fallback: preload then play
      preloadAudio(src).then(() => playAudio(src));
    }
  } catch {}
};

// Synthesized beep — guaranteed to work on all devices, no file needed
const playBeep = (freq = 880, duration = 0.18, volume = 0.4) => {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {}
};

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface ScientificRep { id: number; name: string; }
interface Doctor {
  id: number; name: string; specialty?: string; pharmacyName?: string;
  area?: NamedItem; targetItem?: NamedItem; fromWishList?: boolean;
}
interface VisitLike { id: number; userId: number; user: { id: number; username: string }; }
interface VisitComment { id: number; visitId: number; userId: number; content: string; createdAt: string; user: { id: number; username: string }; }
interface DoctorVisit { id: number; feedback: string; visitDate: string; notes?: string | null; item?: { id: number; name: string } | null; latitude?: number | null; longitude?: number | null; likes?: VisitLike[]; comments?: VisitComment[]; }
interface PharmVisitItem { id: number; pharmacyVisitId: number; itemId?: number | null; itemName?: string | null; notes?: string | null; item?: { id: number; name: string } | null; }
interface PharmVisit { id: number; pharmacyName: string; areaId?: number | null; areaName?: string | null; area?: { id: number; name: string } | null; scientificRepId: number; visitDate: string; notes?: string | null; isDoubleVisit: boolean; latitude?: number | null; longitude?: number | null; items: PharmVisitItem[]; likes: VisitLike[]; }
interface PlanEntry {
  id: number; doctorId: number; targetVisits: number;
  isExtraVisit?: boolean;
  doctor: Doctor; visits: DoctorVisit[];
  targetItems?: { id: number; item: NamedItem }[];
}
interface Plan {
  id: number; scientificRepId: number | null; month: number; year: number;
  targetCalls: number; targetDoctors: number; status: string; notes?: string;
  allowExtraVisits: boolean;
  userId?: number | null;
  user?: { id: number; username: string } | null;
  assignedUserId?: number | null;
  assignedUser?: { id: number; username: string } | null;
  scientificRep: NamedItem | null; entries: PlanEntry[];
  planAreas?: { id: number; area: NamedItem }[];
}
interface SuggestResult {
  keepDoctors: { doctor: Doctor; reason: string }[];
  newDoctors:  Doctor[];
  summary: { keep: number; replace: number; new: number; total: number };
  aiNote?: { raw: string; parsed?: { summary?: string; includeDoctorNames?: string[]; excludeDoctorNames?: string[]; includeAreaNames?: string[]; excludeAreaNames?: string[]; specialties?: string[] } } | null;
}

const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FEEDBACK_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  writing:        { label: 'يكتب',             color: '#166534', bg: '#dcfce7' },
  stocked:        { label: 'نزل الايتم',        color: '#1e40af', bg: '#dbeafe' },
  interested:     { label: 'مهتم',              color: '#7c3aed', bg: '#ede9fe' },
  not_interested: { label: 'غير مهتم',          color: '#991b1b', bg: '#fee2e2' },
  unavailable:    { label: 'غير متوفر',         color: '#92400e', bg: '#fef3c7' },
  pending:        { label: 'معلق',              color: '#475569', bg: '#f1f5f9' },
  positive_notes: { label: '📝 ملاحظات إيجابية', color: '#0369a1', bg: '#e0f2fe' },
};

// Capture GPS location — returns null + errorCode on failure
const getLocation = (): Promise<{ lat: number; lng: number } | null> =>
  new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => resolve(null),
      { timeout: 12000, maximumAge: 0, enableHighAccuracy: false },
    );
  });

export default function MonthlyPlansPage() {
  const { token, isManagerOrAdmin, user: authUser } = useAuth();
  const isFieldRep = ['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep'].includes(authUser?.role ?? '');
  const isCompanyManager = authUser?.role === 'company_manager';
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [plans, setPlans]         = useState<Plan[]>([]);
  const [reps, setReps]           = useState<ScientificRep[]>([]);
  const [items, setItems]         = useState<NamedItem[]>([]);
  // Start with loading=false if we already have cached data so no spinner flashes
  const [loading, setLoading]     = useState(() => !getCached('/api/monthly-plans') || !getCached('/api/scientific-reps'));
  const [error, setError]         = useState('');

  // Active plan view
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [pharmVisits, setPharmVisits]         = useState<PharmVisit[]>([]);
  const [pharmVisitsLoading, setPharmVisitsLoading] = useState(false);

  // Create plan
  const [showCreate, setShowCreate] = useState(false);
  const [cRepId, setCRepId]     = useState(() => String(authUser?.linkedRepId ?? ''));
  const [cMonth, setCMonth]     = useState(new Date().getMonth() + 1);
  const [cYear,  setCYear]      = useState(new Date().getFullYear());
  const [creating, setCreating] = useState(false);
  const [cAreaIds, setCAreaIds] = useState<number[]>([]);
  const [allAreas, setAllAreas] = useState<NamedItem[]>([]);
  const [areaDropdownPlanId, setAreaDropdownPlanId] = useState<number | null>(null);
  const [editingPlanAreas, setEditingPlanAreas] = useState(false);
  const [editAreaIds, setEditAreaIds] = useState<number[]>([]);
  const [savingAreas, setSavingAreas] = useState(false);

  // Smart suggest
  const [suggest, setSuggest]       = useState<SuggestResult | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [selectedDoctors, setSelectedDoctors] = useState<Set<number>>(new Set());

  // Suggest settings — persisted to localStorage
  const _ss = (() => { try { return JSON.parse(localStorage.getItem('suggestSettings') || '{}'); } catch { return {}; } })();
  const [showSuggestSettings, setShowSuggestSettings] = useState(false);
  const [sTargetDoctors, setSTargetDoctors] = useState<number>(_ss.targetDoctors ?? 75);
  const [sTargetVisits,  setSTargetVisits]  = useState<number>(_ss.targetVisits  ?? 2);
  const [sKeepFeedback, setSKeepFeedback]   = useState<string[]>(_ss.keepFeedback ?? ['writing', 'stocked', 'interested']);
  const [sRestrictAreas, setSRestrictAreas] = useState<boolean>(_ss.restrictAreas ?? true);
  const [sSortBy, setSSortBy]               = useState<'oldest' | 'newest' | 'random'>(_ss.sortBy ?? 'oldest');
  const [sUseNoteAnalysis, setSUseNoteAnalysis] = useState<boolean>(_ss.useNoteAnalysis ?? true);
  const [sUserNote, setSUserNote]           = useState<string>(_ss.userNote ?? '');
  const [sLookbackList, setSLookbackList]   = useState<string[]>(_ss.lookbackList ?? []);
  const [sNewRatio, setSNewRatio]           = useState<number>(_ss.newRatio ?? 0);
  const [sFocusItemIds, setSFocusItemIds]     = useState<{id: string; name: string}[]>(_ss.focusItemIds ?? []);
  const [sFocusItemText, setSFocusItemText]   = useState('');
  const [sFocusItemDD, setSFocusItemDD]       = useState(false);
  const [sFocusSpecialties, setSFocusSpecialties] = useState<string[]>(_ss.focusSpecialties ?? []);
  const [sFocusSpecText, setSFocusSpecText]   = useState('');
  const [sFocusSpecDD, setSFocusSpecDD]       = useState(false);
  const [sFocusAreaIds, setSFocusAreaIds]     = useState<{id: string; name: string}[]>(_ss.focusAreaIds ?? []);
  const [sFocusAreaText, setSFocusAreaText]   = useState('');
  const [sFocusAreaDD, setSFocusAreaDD]       = useState(false);
  const [sUseWishList, setSUseWishList]       = useState<boolean>(_ss.useWishList ?? false);

  // Area quota distribution
  const [sAreaQuotasEnabled, setSAreaQuotasEnabled] = useState<boolean>(false);
  const [sRepAreas, setSRepAreas]                   = useState<{id: number; name: string}[]>([]);
  const [sAreaQuotas, setSAreaQuotas]               = useState<Record<string, number>>({});

  // Save suggest settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('suggestSettings', JSON.stringify({
      targetDoctors: sTargetDoctors, targetVisits: sTargetVisits,
      keepFeedback: sKeepFeedback, restrictAreas: sRestrictAreas,
      sortBy: sSortBy, useNoteAnalysis: sUseNoteAnalysis,
      userNote: sUserNote, lookbackList: sLookbackList, newRatio: sNewRatio,
      focusItemIds: sFocusItemIds, focusSpecialties: sFocusSpecialties,
      focusAreaIds: sFocusAreaIds, useWishList: sUseWishList,
    }));
  }, [sTargetDoctors, sTargetVisits, sKeepFeedback, sRestrictAreas, sSortBy,
      sUseNoteAnalysis, sUserNote, sLookbackList, sNewRatio,
      sFocusItemIds, sFocusSpecialties, sFocusAreaIds, sUseWishList]);

  const [sWishDropdownOpen, setSWishDropdownOpen] = useState(false);
  const [sWishExcluded, setSWishExcluded]     = useState<Set<number>>(new Set());
  const [showToolsMenu, setShowToolsMenu]   = useState(false);

  // Populate distribution areas from planAreas (editAreaIds) or rep areas
  useEffect(() => {
    const planAreas = activePlan?.planAreas;
    // If plan has planAreas → derive from editAreaIds (live selection)
    if (planAreas && planAreas.length > 0) {
      const selected = allAreas.filter(a => editAreaIds.includes(a.id));
      setSRepAreas(selected);
      setSAreaQuotas(prev => {
        const q: Record<string, number> = {};
        const ids = selected.map(a => String(a.id));
        // keep existing quotas for still-selected areas
        ids.forEach(id => { q[id] = prev[id] ?? 0; });
        // if all zero or first init → equal distribution
        const total = Object.values(q).reduce((s, v) => s + v, 0);
        if (total === 0 && selected.length > 0) {
          const base = Math.floor(sTargetDoctors / selected.length);
          const rem  = sTargetDoctors % selected.length;
          selected.forEach((a, i) => { q[String(a.id)] = base + (i < rem ? 1 : 0); });
        }
        return q;
      });
      return;
    }
    // Else if rep → fetch rep areas
    const repId = activePlan?.scientificRepId;
    if (!repId) { setSRepAreas([]); setSAreaQuotas({}); return; }
    fetch(`${API}/api/monthly-plans/suggest-areas?scientificRepId=${repId}`, { headers: H() })
      .then(r => r.json())
      .then((areas: {id: number; name: string}[]) => {
        if (!Array.isArray(areas)) return;
        setSRepAreas(areas);
        if (areas.length > 0) {
          const base = Math.floor(sTargetDoctors / areas.length);
          const rem  = sTargetDoctors % areas.length;
          const q: Record<string, number> = {};
          areas.forEach((a, i) => { q[String(a.id)] = base + (i < rem ? 1 : 0); });
          setSAreaQuotas(q);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlan?.scientificRepId, activePlan?.planAreas, editAreaIds, allAreas]);

  // Upload visits
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ imported: number; errors: any[] } | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  // Edit visit item inline
  const [editingVisitItem, setEditingVisitItem] = useState<number | null>(null); // visitId
  const [editVisitItemVal, setEditVisitItemVal] = useState<string>('');

  // Company manager: rep area restriction modal
  const [repAreasModal, setRepAreasModal]         = useState<{ repId: number; repName: string } | null>(null);
  const [repAllAreas, setRepAllAreas]             = useState<{ id: number; name: string }[]>([]);
  const [repSelectedAreaIds, setRepSelectedAreaIds] = useState<Set<number>>(new Set());
  const [repAreasLoading, setRepAreasLoading]     = useState(false);
  const [repAreasSaving, setRepAreasSaving]       = useState(false);

  // Like & Comment on visits
  const [likingVisit, setLikingVisit]           = useState<number | null>(null); // visitId being liked
  const [showLikers, setShowLikers]             = useState<number | null>(null); // visitId whose likers panel is open
  const [commentingVisit, setCommentingVisit]   = useState<number | null>(null); // visitId comment box open
  const [newCommentText, setNewCommentText]      = useState('');
  const [savingComment, setSavingComment]        = useState(false);
  const longPressTimer                           = useRef<any>(null);
  const [entryItemMenuOpen, setEntryItemMenuOpen] = useState<number | null>(null); // entryId
  const [itemMenuPos, setItemMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showEntryItems, setShowEntryItems] = useState<Set<number>>(new Set()); // entryIds with items visible
  const [addingEntryItem, setAddingEntryItem]     = useState(false);
  const [newItemName, setNewItemName]             = useState(''); // name for creating a new item inline

  // Add visit form
  const [visitFormEntry, setVisitFormEntry] = useState<number | null>(null); // entryId
  const [vDate,     setVDate]     = useState('');
  const [vItemId,   setVItemId]   = useState('');
  const [vFeedback, setVFeedback] = useState('pending');
  const [vNotes,    setVNotes]    = useState('');
  const [savingVisit, setSavingVisit] = useState(false);
  const [visitLocation, setVisitLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [visitLocStatus, setVisitLocStatus] = useState<'idle' | 'getting' | 'ok' | 'denied'>('idle');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [showManualLoc, setShowManualLoc] = useState(false);

  // Filter
  const [filterRep, setFilterRep] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchSuggestOpen, setSearchSuggestOpen] = useState(false);
  const [visitFilter, setVisitFilter] = useState<'all' | 'done' | 'not_done' | 'voice_added'>('all');

  // Voice input
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceReminderVisible, setVoiceReminderVisible] = useState(false);
  const [voiceCountingDown, setVoiceCountingDown] = useState(false);
  const [voiceParsing, setVoiceParsing] = useState(false);
  const [voiceError,   setVoiceError]   = useState<string | null>(null);
  const [voiceResults, setVoiceResults] = useState<{ entryId: number | null; doctorName: string; itemId: number | null; itemName: string; feedback: string; notes: string; date: string }[] | null>(null);
  const [voiceAddToPlan, setVoiceAddToPlan] = useState<Set<number>>(new Set()); // indices of unmatched visits to add to plan
  const [voiceNewEntries, setVoiceNewEntries] = useState<Set<number>>(new Set()); // entryIds added during this session
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [editingVoiceName, setEditingVoiceName] = useState<number | null>(null); // index of row being edited
  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const audioChunksRef      = useRef<Blob[]>([]);
  const silenceTimerRef     = useRef<any>(null);
  const voicePanelRef       = useRef<HTMLDivElement | null>(null);
  const recordingStartRef   = useRef<number>(0); // timestamp when recording started
  const activePlanRef       = useRef<typeof activePlan>(null); // for popstate closure
  const plansRef            = useRef<Plan[]>([]);  // for AI action handler closure
  // keep legacy refs so voice-result UI still works
  const wantListeningRef = useRef(false);
  const recognitionRef   = useRef<any>(null);

  // Import visits Excel for active plan
  const importFileRef = useRef<HTMLInputElement>(null);
  const [showImportModal, setShowImportModal]   = useState(false);
  const [importing, setImporting]               = useState(false);
  const [importResult, setImportResult]         = useState<{ imported: number; total: number; errors: { row: number; error: string }[]; unmatched: string[] } | null>(null);

  // Import plan entries (doctors) from Excel
  const planImportFileRef = useRef<HTMLInputElement>(null);
  const [showPlanImportModal, setShowPlanImportModal] = useState(false);
  const [planImporting, setPlanImporting]             = useState(false);
  const [planImportResult, setPlanImportResult]       = useState<{ imported: number; total: number; unmatched: string[] } | null>(null);

  // Excel dropdown in plan header
  const [showExcelMenu, setShowExcelMenu] = useState(false);

  // Item calls breakdown dropdown
  const [openItemKey, setOpenItemKey] = useState<string | null>(null);

  // Feedback doctors popup
  const [fbPopup, setFbPopup] = useState<{ fb: string; label: string; meta: { color: string; bg: string }; doctors: { name: string; entryId: number }[] } | null>(null);

  // Transfer plan modal
  interface RepUser { id: number; username: string; linkedRepId: number | null; }
  const [transferPlan, setTransferPlan]   = useState<Plan | null>(null);
  const [repUsers, setRepUsers]           = useState<RepUser[]>([]);
  const [transferTarget, setTransferTarget] = useState<number | ''>('');
  const [transferring, setTransferring]   = useState(false);
  const [transferError, setTransferError] = useState('');
  const [refreshing, setRefreshing]       = useState(false);

  // Scroll-to-entry highlight
  const entryRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [highlightEntryId, setHighlightEntryId] = useState<number | null>(null);

  // Selection mode for bulk actions
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<Set<number>>(new Set());
  const toggleSelect = (entryId: number) => setSelectedEntries(prev => {
    const s = new Set(prev);
    s.has(entryId) ? s.delete(entryId) : s.add(entryId);
    return s;
  });

  // Collapsible entries
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [expandAnimDone, setExpandAnimDone] = useState<Set<number>>(new Set());
  const toggleEntry = (entryId: number) => setExpandedEntries(prev => {
    const s = new Set(prev);
    if (s.has(entryId)) {
      s.delete(entryId);
      setExpandAnimDone(p => { const n = new Set(p); n.delete(entryId); return n; });
    } else {
      s.add(entryId);
    }
    return s;
  });

  const scrollToEntry = (entryId: number) => {
    setFbPopup(null);
    setVisitFilter('all');
    setSearchQuery('');
    setExpandedEntries(prev => new Set(prev).add(entryId));
    setTimeout(() => {
      const el = entryRefs.current[entryId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightEntryId(entryId);
        setTimeout(() => setHighlightEntryId(null), 2000);
      }
    }, 50);
  };

  const applyPlanData = useCallback((plJson: any, reJson: any, itJson: any) => {
    if (plJson && !plJson.error) setPlans(Array.isArray(plJson) ? plJson : (Array.isArray(plJson?.data) ? plJson.data : []));
    if (reJson && !reJson.error) setReps(Array.isArray(reJson) ? reJson : (Array.isArray(reJson?.data) ? reJson.data : []));
    if (itJson) setItems(Array.isArray(itJson) ? itJson : (Array.isArray(itJson?.data) ? itJson.data : []));
  }, []);

  // Back button: close open modals/panels in priority order
  useBackHandler([
    [showCreate,                    () => setShowCreate(false)],
    [showImportModal,               () => setShowImportModal(false)],
    [showPlanImportModal,           () => setShowPlanImportModal(false)],
    [fbPopup !== null,              () => setFbPopup(null)],
    [transferPlan !== null,         () => setTransferPlan(null)],
    [showLikers !== null,           () => setShowLikers(null)],
    [voiceResults !== null,         () => setVoiceResults(null)],
    [showSuggestSettings,           () => setShowSuggestSettings(false)],
    [showToolsMenu,                 () => setShowToolsMenu(false)],
    [showExcelMenu,                 () => setShowExcelMenu(false)],
    [areaDropdownPlanId !== null,   () => setAreaDropdownPlanId(null)],
    [openItemKey !== null,          () => setOpenItemKey(null)],
    [searchSuggestOpen,             () => setSearchSuggestOpen(false)],
    [expandedEntries.size > 0,      () => setExpandedEntries(new Set())],
  ]);

  const load = useCallback(async (silent = false) => {
    setError('');
    const h = H();
    try {
      // stale-while-revalidate: serve cache immediately, refresh in background
      const [plJson, reJson, itJson] = await Promise.all([
        cachedFetch(`${API}/api/monthly-plans`,   { headers: h }, d => setPlans(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []))),
        cachedFetch(`${API}/api/scientific-reps`, { headers: h }, d => setReps(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []))),
        cachedFetch(`${API}/api/items`,           { headers: h }, d => setItems(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []))),
      ]);
      applyPlanData(plJson, reJson, itJson);
      // Load areas for create modal
      try {
        const arRes = await fetch(`${API}/api/areas`, { headers: h });
        const arJson = await arRes.json();
        const arList = Array.isArray(arJson) ? arJson : (Array.isArray(arJson?.data) ? arJson.data : []);
        setAllAreas(arList);
      } catch {}
      // Restore last open plan
      const savedPlanId = localStorage.getItem('lastPlanId');
      if (savedPlanId) {
        const id = parseInt(savedPlanId);
        if (!isNaN(id)) {
          try {
            const planData = await cachedFetch(`${API}/api/monthly-plans/${id}`, { headers: h }, d => setActivePlan(d));
            setActivePlan(planData);
          } catch { localStorage.removeItem('lastPlanId'); }
        }
      }
    } catch (e: any) { if (!silent) setError(e.message ?? 'خطأ في التحميل'); }
    finally { if (!silent) setLoading(false); }
  }, [H, applyPlanData]);

  useEffect(() => { load(); }, [load]);
  // After cache-based load resolves, always clear spinner
  useEffect(() => { setLoading(false); }, [plans]);

  // Listen for AI assistant page actions
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { action, param } = detail || {};
      switch (action) {
        case 'open-suggest-settings': setEditAreaIds(activePlan?.planAreas?.map(pa => pa.area.id) ?? []); setShowSuggestSettings(true); break;
        case 'open-new-plan':         setShowCreate(true); break;
        case 'open-import-visits':    setShowImportModal(true); break;
        case 'open-plan': {
          if (param) {
            const q = String(param).trim().toLowerCase().replace(/\s+/g, ' ');
            const found = plansRef.current.find(p => {
              const n = (p.scientificRep?.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
              return n === q || n.includes(q) || q.includes(n);
            });
            if (found) setActivePlan(found);
          }
          break;
        }
      }
    };
    window.addEventListener('ai-page-action', handler);
    // Pick up any action stored before this page mounted
    const pending = (window as any).__aiPendingAction;
    if (pending) { (window as any).__aiPendingAction = null; handler(new CustomEvent('ai-page-action', { detail: pending })); }
    return () => window.removeEventListener('ai-page-action', handler);
  }, []);

  // Keep plansRef in sync for AI handler closure
  useEffect(() => { plansRef.current = plans; }, [plans]);

  // Keep ref in sync for popstate handler
  useEffect(() => { activePlanRef.current = activePlan; }, [activePlan]);

  // Persist last open plan to localStorage
  useEffect(() => {
    if (activePlan) {
      localStorage.setItem('lastPlanId', String(activePlan.id));
    } else {
      localStorage.removeItem('lastPlanId');
    }
  }, [activePlan?.id]);

  // Fetch pharmacy visits for the active plan's rep + month
  useEffect(() => {
    if (!activePlan) { setPharmVisits([]); return; }
    let cancelled = false;
    setPharmVisitsLoading(true);
    fetch(`${API}/api/monthly-plans/${activePlan.id}/pharmacy-visits`, { headers: H() })
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setPharmVisits(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setPharmVisits([]); })
      .finally(() => { if (!cancelled) setPharmVisitsLoading(false); });
    return () => { cancelled = true; };
  }, [activePlan?.id, H]);

  // Mobile back button: inside a plan → go back to plan list
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (activePlanRef.current && !e.state?.planId) {
        setActivePlan(null);
        setSearchQuery('');
        setVisitFilter('all');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Auto-refresh when app regains focus or comes to foreground (mobile <-> desktop sync)
  useEffect(() => {
    const refresh = () => load(true);
    const handleVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);

  useEffect(() => {
    if (voiceResults !== null || voiceParsing || voiceError) {
      setTimeout(() => voicePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [voiceResults, voiceParsing, voiceError]);
  useEffect(() => { preloadAudio(voiceStartSrc); preloadAudio(voiceStopSrc); }, []);

  // Auto-capture GPS when visit form opens
  useEffect(() => {
    if (visitFormEntry !== null) {
      setVisitLocation(null);
      setVisitLocStatus('getting');
      setShowManualLoc(false);
      setManualLat('');
      setManualLng('');
      getLocation().then(loc => {
        if (loc) { setVisitLocation(loc); setVisitLocStatus('ok'); }
        else       { setVisitLocStatus('denied'); }
      });
    } else {
      setVisitLocation(null);
      setVisitLocStatus('idle');
      setShowManualLoc(false);
    }
  }, [visitFormEntry]);

  // Restore voiceNewEntries from localStorage when plan changes
  useEffect(() => {
    if (activePlan) {
      const saved = localStorage.getItem(`voiceNew_${activePlan.id}`);
      if (saved) {
        try { setVoiceNewEntries(new Set(JSON.parse(saved))); } catch { setVoiceNewEntries(new Set()); }
      } else {
        setVoiceNewEntries(new Set());
      }
    } else {
      setVoiceNewEntries(new Set());
    }
  }, [activePlan?.id]);

  // Reload a single plan
  const reloadPlan = async (id: number) => {
    const r = await fetch(`${API}/api/monthly-plans/${id}`, { headers: H() });
    const j: Plan = await r.json();
    setActivePlan(j);
    setPlans(prev => prev.map(p => p.id === id ? j : p));
  };

  // Company manager: open rep area restriction modal
  const openRepAreasModal = async (repId: number, repName: string) => {
    setRepAreasModal({ repId, repName });
    setRepSelectedAreaIds(new Set());
    setRepAreasLoading(true);
    try {
      const r = await fetch(`/api/company-members/by-rep/${repId}/areas`, { headers: H() });
      const j = await r.json();
      if (r.ok) {
        setRepAllAreas(j.allAreas ?? []);
        setRepSelectedAreaIds(new Set(j.assignedAreaIds ?? []));
      }
    } catch { /* ignore */ }
    finally { setRepAreasLoading(false); }
  };

  const saveRepAreas = async () => {
    if (!repAreasModal) return;
    setRepAreasSaving(true);
    try {
      const r = await fetch(`/api/company-members/by-rep/${repAreasModal.repId}/areas`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({ areaIds: [...repSelectedAreaIds] }),
      });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? 'فشل الحفظ'); }
      setRepAreasModal(null);
    } catch (e: any) { alert(e.message); }
    finally { setRepAreasSaving(false); }
  };

  // Create new plan
  const createPlan = async () => {
    if (!isManagerOrAdmin && !authUser?.linkedRepId) {
      alert('حسابك غير مرتبط بمندوب علمي. تواصل مع المدير.');
      return;
    }
    // Managers: if no rep selected, must have areas
    if (isManagerOrAdmin && !cRepId && cAreaIds.length === 0) {
      alert('يجب تحديد المناطق عند إنشاء بلان بدون مندوب.');
      return;
    }
    setCreating(true);
    try {
      const body: any = { month: cMonth, year: cYear };
      if (isManagerOrAdmin && cRepId) body.scientificRepId = cRepId;
      else if (!isManagerOrAdmin) body.scientificRepId = authUser?.linkedRepId;
      if (cAreaIds.length > 0) body.areaIds = cAreaIds;
      const r = await fetch(`${API}/api/monthly-plans`, {
        method: 'POST', headers: H(),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? j.message ?? 'فشل الإنشاء');
      invalidateCache('/api/monthly-plans');
      await load();
      setCAreaIds([]);
      setShowCreate(false);
    } catch (e: any) {
      alert(e.message);
      invalidateCache('/api/monthly-plans');
      await load();
    }
    finally { setCreating(false); }
  };

  // Smart suggest
  const loadSuggest = async () => {
    if (!activePlan) return;
    const hasRep = !!activePlan.scientificRepId;
    const hasPlanAreas = activePlan.planAreas && activePlan.planAreas.length > 0;
    if (!hasRep && !hasPlanAreas) { alert('يجب تحديد مناطق أو ربط مندوب أولاً لاستخدام الاقتراح الذكي.'); return; }
    setSuggestLoading(true); setSuggest(null); setShowSuggestSettings(false);
    try {
      // Read wished doctors from localStorage if feature is enabled
      let wishedDoctorIds = '';
      if (sUseWishList) {
        try {
          const stored = localStorage.getItem(`wishedDoctors_${authUser?.id ?? 'guest'}`);
          const ids: number[] = stored ? JSON.parse(stored) : [];
          wishedDoctorIds = ids.filter(id => !sWishExcluded.has(id)).join(',');
        } catch { /* ignore */ }
      }
      const p = new URLSearchParams({
        month:            String(activePlan.month),
        year:             String(activePlan.year),
        planId:           String(activePlan.id),
        targetDoctors:    String(sTargetDoctors),
        keepFeedback:     sKeepFeedback.join(','),
        restrictToAreas:  String(sRestrictAreas),
        sortBy:           sSortBy,
        useNoteAnalysis:  String(sUseNoteAnalysis),
        lookbackList:     sLookbackList.length > 0 ? sLookbackList.join(',') : '',
        newRatio:         String(sNewRatio),
        ...(hasRep && { scientificRepId: String(activePlan.scientificRepId) }),
        ...(!hasRep && { planId: String(activePlan.id) }),
        ...(sFocusItemIds.length > 0     && { focusItemId:     sFocusItemIds.map(x => x.id).join(',') }),
        ...(sFocusSpecialties.length > 0 && { focusSpecialty:  sFocusSpecialties.join(',') }),
        ...(sFocusAreaIds.length > 0     && { focusAreaId:     sFocusAreaIds.map(x => x.id).join(',') }),
        ...(sUserNote.trim() && { userNote:        sUserNote.trim() }),
        ...(wishedDoctorIds  && { wishedDoctorIds }),
        ...(sAreaQuotasEnabled && sRepAreas.length > 0 && { areaQuotas: JSON.stringify(sAreaQuotas) }),
      });
      const r = await fetch(`${API}/api/monthly-plans/suggest?${p}`, { headers: H() });
      const j: SuggestResult = await r.json();
      setSuggest(j);
      setSelectedDoctors(new Set(j.keepDoctors.map(k => k.doctor.id)));
    } catch (e: any) { alert(e.message); }
    finally { setSuggestLoading(false); }
  };

  // Save edited plan areas
  const savePlanAreas = async () => {
    if (!activePlan) return;
    setSavingAreas(true);
    try {
      const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/areas`, {
        method: 'PUT', headers: H(),
        body: JSON.stringify({ areaIds: editAreaIds }),
      });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? j.message ?? 'فشل التحديث'); }
      setEditingPlanAreas(false);
      invalidateCache('/api/monthly-plans');
      await reloadPlan(activePlan.id);
    } catch (e: any) { alert(e.message); }
    finally { setSavingAreas(false); }
  };

  const applySuggestion = async () => {
    if (!activePlan || !suggest) return;
    const allSuggested = [...suggest.keepDoctors.map(k => k.doctor), ...suggest.newDoctors];
    const chosen = allSuggested.filter(d => selectedDoctors.has(d.id));
    for (const doc of chosen) {
      const existing = activePlan.entries.find(e => e.doctorId === doc.id);
      if (existing) continue;
      const entryRes = await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ doctorId: doc.id, targetVisits: sTargetVisits }),
      });
      // Auto-add doctor's targetItem to the new entry
      if (entryRes.ok && doc.targetItem) {
        const entry = await entryRes.json();
        await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entry.id}/items`, {
          method: 'POST', headers: H(),
          body: JSON.stringify({ itemId: doc.targetItem.id }),
        });
      }
    }
    setSuggest(null);
    await reloadPlan(activePlan.id);
  };

  // Remove entry
  const removeEntry = async (entryId: number) => {
    if (!activePlan) return;
    if (!confirm('إزالة هذا الطبيب من البلان؟')) return;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}`, { method: 'DELETE', headers: H() });
    await reloadPlan(activePlan.id);
  };

  // Bulk remove entries
  const bulkRemoveEntries = async (ids?: number[]) => {
    if (!activePlan) return;
    const toDelete = ids ?? [...selectedEntries];
    if (toDelete.length === 0) return;
    const msg = toDelete.length === activePlan.entries.length
      ? `حذف جميع الأطباء (${toDelete.length}) من البلان؟`
      : `حذف ${toDelete.length} طبيب من البلان؟`;
    if (!confirm(msg)) return;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/bulk-delete`, {
      method: 'POST', headers: H(),
      body: JSON.stringify({ entryIds: toDelete }),
    });
    setSelectedEntries(new Set());
    setSelectMode(false);
    await reloadPlan(activePlan.id);
  };

  // Edit plan fields inline (targetDoctors / targetCalls)
  const [editingPlanField, setEditingPlanField] = useState<'targetDoctors'|'targetCalls'|null>(null);
  const [editPlanVal, setEditPlanVal] = useState(0);

  const savePlanField = async (field: 'targetDoctors'|'targetCalls') => {
    if (!activePlan) return;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}`, {
      method: 'PUT', headers: H(),
      body: JSON.stringify({ [field]: editPlanVal }),
    });
    setEditingPlanField(null);
    await reloadPlan(activePlan.id);
  };

  // Add manual visit
  const submitVisit = async () => {
    if (!activePlan || !visitFormEntry) return;
    setSavingVisit(true);
    try {
      const entry = activePlan.entries.find(e => e.id === visitFormEntry);
      const entryTargetItems = entry?.targetItems ?? [];

      // الحالة 1: لم يُحدد ايتم للزيارة + الطبيب عنده ايتم مستهدف → اختره تلقائياً
      let resolvedItemId = vItemId;
      if (!resolvedItemId && entryTargetItems.length > 0) {
        resolvedItemId = String(entryTargetItems[0].item.id);
      }

      const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${visitFormEntry}/visits`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({
          visitDate: (() => { if (!vDate) return new Date().toISOString(); const [y,m,d] = vDate.split('-').map(Number); const n = new Date(); return new Date(y, m-1, d, n.getHours(), n.getMinutes(), n.getSeconds()).toISOString(); })(),
          itemId:    resolvedItemId || null,
          feedback:  vFeedback,
          notes:     vNotes,
          latitude:  visitLocation?.lat ?? null,
          longitude: visitLocation?.lng ?? null,
        }),
      });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error); }

      // الحالة 2: تم تحديد ايتم للزيارة + الطبيب ليس عنده أي ايتم مستهدف → اضفه تلقائياً
      if (resolvedItemId && entryTargetItems.length === 0) {
        await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${visitFormEntry}/items`, {
          method: 'POST', headers: H(),
          body: JSON.stringify({ itemId: Number(resolvedItemId) }),
        });
      }

      setVisitFormEntry(null);
      setVDate(''); setVItemId(''); setVFeedback('pending'); setVNotes('');
      await reloadPlan(activePlan.id);
    } catch (e: any) { alert(e.message); }
    finally { setSavingVisit(false); }
  };

  // Delete visit
  const deleteVisit = async (visitId: number) => {
    if (!activePlan) return;
    if (!confirm('حذف هذه الزيارة؟')) return;
    await fetch(`${API}/api/monthly-plans/visits/${visitId}`, { method: 'DELETE', headers: H() });
    await reloadPlan(activePlan.id);
  };

  // Toggle like on a visit
  const toggleLike = async (visitId: number) => {
    if (likingVisit === visitId) return;
    setLikingVisit(visitId);
    const res = await fetch(`${API}/api/monthly-plans/visits/${visitId}/like`, { method: 'POST', headers: H() });
    if (res.ok) {
      const { likes } = await res.json();
      setActivePlan(prev => prev ? {
        ...prev,
        entries: prev.entries.map(e => ({
          ...e,
          visits: e.visits.map(v => v.id === visitId ? { ...v, likes } : v),
        })),
      } : prev);
    }
    setLikingVisit(null);
  };

  // Add comment on a visit
  const submitComment = async (visitId: number) => {
    if (!newCommentText.trim() || savingComment) return;
    setSavingComment(true);
    const res = await fetch(`${API}/api/monthly-plans/visits/${visitId}/comments`, {
      method: 'POST', headers: H(),
      body: JSON.stringify({ content: newCommentText.trim() }),
    });
    if (res.ok) {
      const comment: VisitComment = await res.json();
      setActivePlan(prev => prev ? {
        ...prev,
        entries: prev.entries.map(e => ({
          ...e,
          visits: e.visits.map(v => v.id === visitId ? { ...v, comments: [...(v.comments || []), comment] } : v),
        })),
      } : prev);
      setNewCommentText('');
      setCommentingVisit(null);
    }
    setSavingComment(false);
  };

  // Delete comment
  const deleteComment = async (visitId: number, commentId: number) => {
    const res = await fetch(`${API}/api/monthly-plans/visits/${visitId}/comments/${commentId}`, { method: 'DELETE', headers: H() });
    if (res.ok) {
      setActivePlan(prev => prev ? {
        ...prev,
        entries: prev.entries.map(e => ({
          ...e,
          visits: e.visits.map(v => v.id === visitId ? { ...v, comments: (v.comments || []).filter(c => c.id !== commentId) } : v),
        })),
      } : prev);
    }
  };

  // Save visit item
  const saveVisitItem = async (visitId: number) => {
    if (!activePlan) return;
    await fetch(`${API}/api/monthly-plans/visits/${visitId}/item`, {
      method: 'PATCH', headers: H(),
      body: JSON.stringify({ itemId: editVisitItemVal === '' ? null : Number(editVisitItemVal) }),
    });
    setEditingVisitItem(null);
    await reloadPlan(activePlan.id);
  };

  // Add item to entry
  const addEntryItem = async (entryId: number, itemId: number) => {
    if (!activePlan) return;
    setAddingEntryItem(true);
    await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}/items`, {
      method: 'POST', headers: H(),
      body: JSON.stringify({ itemId }),
    });
    setAddingEntryItem(false);
    setEntryItemMenuOpen(null);
    await reloadPlan(activePlan.id);
  };

  // Create a new item by name then add it to the entry
  const createAndAddItem = async (entryId: number) => {
    const name = newItemName.trim();
    if (!name || !activePlan) return;
    setAddingEntryItem(true);
    try {
      // 1. create (or fetch existing) item
      const r = await fetch(`${API}/api/items`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      const item = j?.data ?? j;
      if (!item?.id) throw new Error('فشل إنشاء الايتم');
      // 2. add to entry
      await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}/items`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ itemId: item.id }),
      });
      setNewItemName('');
      setEntryItemMenuOpen(null);
      // 3. refresh items list + plan
      const [itR] = await Promise.all([
        fetch(`${API}/api/items`, { headers: H() }),
        reloadPlan(activePlan.id),
      ]);
      const itJ = await itR.json();
      setItems(Array.isArray(itJ) ? itJ : (Array.isArray(itJ?.data) ? itJ.data : []));
    } catch (e: any) { alert(e.message ?? 'خطأ'); }
    finally { setAddingEntryItem(false); }
  };

  // Remove item from entry
  const removeEntryItem = async (entryId: number, itemId: number) => {
    if (!activePlan) return;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}/items/${itemId}`, {
      method: 'DELETE', headers: H(),
    });
    await reloadPlan(activePlan.id);
  };

  // Edit target visits inline
  const [editingEntry, setEditingEntry] = useState<number | null>(null);
  const [editVisitsVal, setEditVisitsVal] = useState(2);

  const saveEntryVisits = async (entryId: number) => {
    if (!activePlan) return;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}`, {
      method: 'PATCH', headers: H(),
      body: JSON.stringify({ targetVisits: editVisitsVal }),
    });
    setEditingEntry(null);
    await reloadPlan(activePlan.id);
  };

  // Upload visits Excel
  const uploadVisits = async (file: File) => {
    setUploading(true); setUploadResult(null);
    const fd = new FormData();
    fd.append('file', file);
    const tok = token;
    try {
      const r = await fetch(`${API}/api/monthly-plans/visits/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
        body: fd,
      });
      const j = await r.json();
      setUploadResult(j);
      setUploadedFileName(file.name);
      invalidateCache('/api/monthly-plans');
      await load();
    } catch (e: any) { alert(e.message); }
    finally { setUploading(false); }
  };

  const clearUpload = () => {
    setUploadResult(null);
    setUploadedFileName(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Export plan entries to Excel
  const exportPlanExcel = () => {
    if (!activePlan) return;
    const rows = activePlan.entries.map(e => ({
      'الطبيب':               e.doctor.name,
      'التخصص':               e.doctor.specialty ?? '',
      'المنطقة':              e.doctor.area?.name ?? '',
      'الايتمات':             (e.targetItems ?? []).map(ti => ti.item.name).join(', '),
      'الزيارات المستهدفة':   e.targetVisits,
      'الزيارات الفعلية':     e.visits.length,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'البلان');
    XLSX.writeFile(wb, `plan_${activePlan.scientificRep?.name ?? 'unassigned'}_${MONTHS_AR[activePlan.month - 1]}_${activePlan.year}.xlsx`);
  };

  // Import plan entries (doctors list) from Excel
  const importPlanEntries = async (file: File) => {
    if (!activePlan) return;
    setPlanImporting(true); setPlanImportResult(null);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(ab), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (rows.length === 0) { setPlanImportResult({ imported: 0, total: 0, unmatched: [] }); return; }
      const headers = Object.keys(rows[0]);
      const norm = (s: string) => String(s).toLowerCase().replace(/[\u064B-\u065F]/g, '').replace(/[\s_\-.]+/g, '').trim();
      const docCol = headers.find(h => ['اسمالطبيب','الطبيب','طبيب','اسم','doctor','doctorname','name'].some(a => a === norm(h) || norm(h).includes(a)));
      const visCol = headers.find(h => ['زيارات','عددزيارات','targetvisits','visits'].some(a => a === norm(h) || norm(h).includes(a)));
      if (!docCol) { alert('لم يتم العثور على عمود اسم الطبيب في الملف'); return; }
      const entries = rows
        .map(r => ({ name: String(r[docCol] ?? '').trim(), targetVisits: visCol ? (parseInt(r[visCol]) || 2) : 2 }))
        .filter(r => r.name);
      const resp = await fetch(`${API}/api/monthly-plans/${activePlan.id}/import-entries`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ entries }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? 'فشل الاستيراد');
      setPlanImportResult(j);
      await reloadPlan(activePlan.id);
    } catch (e: any) { alert(e.message); }
    finally { setPlanImporting(false); if (planImportFileRef.current) planImportFileRef.current.value = ''; }
  };

  // Import visits Excel for the active plan
  const importPlanVisits = async (file: File) => {
    if (!activePlan) return;
    setImporting(true); setImportResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/import-visits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'فشل الاستيراد');
      setImportResult(j);
      await reloadPlan(activePlan.id);
    } catch (e: any) { alert(e.message); }
    finally { setImporting(false); if (importFileRef.current) importFileRef.current.value = ''; }
  };

  // Toggle allowExtraVisits for the active plan
  // ── Voice input functions ──────────────────────────────────
  const startVoice = async () => {
    if (!activePlan) return;

    // Play start beeps immediately on user gesture (two ascending tones)
    playBeep(660, 0.12, 0.45);
    setTimeout(() => playBeep(880, 0.18, 0.45), 130);
    playAudio(voiceStartSrc); // also try mp3 as backup

    // Show overlay immediately (no countdown)
    setVoiceReminderVisible(true);
    setVoiceCountingDown(false);
    setVoiceResults(null);
    setVoiceError(null);
    setVoiceAddToPlan(new Set());
    setVoiceNewEntries(new Set());

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceReminderVisible(false);
      alert('لم يتم السماح بالوصول للميكروفون');
      return;
    }

    audioChunksRef.current = [];

    // Pick best supported format
    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ].find(t => MediaRecorder.isTypeSupported(t)) ?? '';

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;
    wantListeningRef.current = true;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        // Stop beep: two descending tones
        playBeep(880, 0.12, 0.4);
        setTimeout(() => playBeep(550, 0.18, 0.4), 130);
        playAudio(voiceStopSrc); // also try mp3 as backup
        setVoiceListening(false);
        setVoiceReminderVisible(false);
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const durationSec = (Date.now() - recordingStartRef.current) / 1000;
        if (blob.size > 500 && durationSec >= 2) {
          await parseVoiceAudio(blob, recorder.mimeType || 'audio/webm');
        } else {
          setVoiceError('التسجيل قصير جداً — تحدث لمدة ثانيتين على الأقل ثم أوقف التسجيل');
        }
      };

      recorder.start();
      recordingStartRef.current = Date.now();
      setVoiceListening(true);

      // 60s max recording auto-stop
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 60000);
  };

  const stopVoice = () => {
    wantListeningRef.current = false;
    setVoiceCountingDown(false);
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      setVoiceReminderVisible(false);
      setVoiceListening(false);
    }
  };

  const parseVoiceAudio = async (blob: Blob, mimeType: string) => {
    if (!activePlan) return;
    setVoiceParsing(true);
    try {
      const fd = new FormData();
      fd.append('audio', blob, `voice.${mimeType.split('/')[1]?.split(';')[0] ?? 'webm'}`);
      const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/voice-record`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!r.ok) { const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); throw new Error(j.error); }
      const data = await r.json();
      setVoiceResults(data.visits ?? []);
    } catch (e: any) { setVoiceError('خطأ: ' + (e.message ?? String(e))); }
    finally { setVoiceParsing(false); }
  };

  // keep parseVoiceText for any legacy usage
  const parseVoiceText = async (inputText: string) => {
    if (!activePlan) return;
    if (!inputText.trim()) return;
    setVoiceParsing(true);
    try {
      const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/voice-parse`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ text: inputText }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); throw new Error(j.error); }
      const data = await r.json();
      setVoiceResults(data.visits ?? []);
    } catch (e: any) { setVoiceError('خطأ نصي: ' + (e.message ?? String(e))); }
    finally { setVoiceParsing(false); }
  };

  const submitVoiceVisits = async () => {
    if (!activePlan || !voiceResults?.length) return;
    setVoiceSaving(true);
    // Capture GPS once before iterating
    const voiceLoc = await getLocation();
    let success = 0, skipped = 0, failed = 0;
    const newEntryIds = new Set<number>();
    for (let i = 0; i < voiceResults.length; i++) {
      const v = voiceResults[i];
      let entryId = v.entryId;

      // If unmatched but user selected to add to plan
      if (!entryId && voiceAddToPlan.has(i)) {
        // Normalize Arabic text for better matching
        const normalizeAr = (s: string) => s
          .trim().replace(/\s+/g, ' ').toLowerCase()
          .replace(/أ|إ|آ/g, 'ا')
          .replace(/ة/g, 'ه')
          .replace(/ى/g, 'ي')
          .replace(/[ًٌٍَُِّْ]/g, ''); // remove tashkeel

        const allDoctors = await fetch(`${API}/api/doctors`, { headers: H() }).then(r => r.json()).catch(() => []);
        const doctorList: any[] = Array.isArray(allDoctors) ? allDoctors : (allDoctors.data ?? []);

        const voiceName = normalizeAr(v.doctorName);
        let matched = doctorList.find((d: any) => {
          const dbName = normalizeAr(d.name);
          return dbName === voiceName || dbName.includes(voiceName) || voiceName.includes(dbName);
        });

        let doctorId: number | null = matched?.id ?? null;

        // If still not found → create the doctor automatically
        if (!doctorId && v.doctorName.trim()) {
          const createRes = await fetch(`${API}/api/doctors`, {
            method: 'POST', headers: H(),
            body: JSON.stringify({ name: v.doctorName.trim() }),
          });
          if (createRes.ok) {
            const newDoc = await createRes.json();
            doctorId = newDoc.id;
          }
        }

        if (doctorId) {
          const entryRes = await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries`, {
            method: 'POST', headers: H(),
            body: JSON.stringify({ doctorId, targetVisits: 1 }),
          });
          if (entryRes.ok) {
            const entry = await entryRes.json();
            entryId = entry.id;
            newEntryIds.add(entry.id);
          }
        }
      }

      if (!entryId) continue;

      const visitDate = (() => { if (!v.date) return new Date().toISOString(); const [y,m,d] = v.date.split('-').map(Number); const n = new Date(); return new Date(y, m-1, d, n.getHours(), n.getMinutes(), n.getSeconds()).toISOString(); })();
      const entry = activePlan.entries.find(e => e.id === entryId);
      if (entry) {
        const dup = entry.visits.some((ev: any) =>
          new Date(ev.visitDate).toISOString().split('T')[0] === visitDate &&
          (ev.item?.id ?? null) === (v.itemId ?? null)
        );
        if (dup) { skipped++; continue; }
      }
      try {
        const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/entries/${entryId}/visits`, {
          method: 'POST', headers: H(),
          body: JSON.stringify({
            visitDate,
            itemId: v.itemId || null,
            feedback: v.feedback || 'pending',
            notes: v.notes || '',
            latitude:  voiceLoc?.lat ?? null,
            longitude: voiceLoc?.lng ?? null,
          }),
        });
        if (r.ok) success++;
        else { failed++; console.error('Visit POST failed:', r.status, await r.text()); }
      } catch (e) { failed++; console.error('Visit fetch error:', e); }
    }
    setVoiceSaving(false);
    setVoiceResults(null);
    setVoiceAddToPlan(new Set());
    // Always read from localStorage directly (source of truth) — avoids stale closure bug
    const lsKey = `voiceNew_${activePlan.id}`;
    let alreadySaved: number[] = [];
    try { const raw = localStorage.getItem(lsKey); if (raw) alreadySaved = JSON.parse(raw); } catch {}
    const mergedNew = new Set([...alreadySaved, ...newEntryIds]);
    setVoiceNewEntries(mergedNew);
    localStorage.setItem(lsKey, JSON.stringify([...mergedNew]));
    await reloadPlan(activePlan.id);
    const msg = failed > 0
      ? `⚠️ تم تسجيل ${success} زيارة، فشل ${failed} (${skipped} مكررة)`
      : skipped > 0
        ? `✅ تم تسجيل ${success} زيارة بنجاح (${skipped} مكررة تم تخطيها)`
        : `✅ تم تسجيل ${success} زيارة بنجاح`;
    alert(msg);
  };

  const toggleAllowExtraVisits = async () => {
    if (!activePlan) return;
    const newVal = !activePlan.allowExtraVisits;
    await fetch(`${API}/api/monthly-plans/${activePlan.id}`, {
      method: 'PUT', headers: H(),
      body: JSON.stringify({ allowExtraVisits: newVal }),
    });
    await reloadPlan(activePlan.id);
  };

  // Download Excel template for the active plan
  const downloadTemplate = () => {
    if (!activePlan) return;
    const rows = activePlan.entries.map(e => ({
      'اسم الطبيب':    e.doctor.name,
      'تاريخ الزيارة': new Date().toISOString().split('T')[0],
      'الايتم':        (e.targetItems ?? [])[0]?.item.name ?? '',
      'الفيدباك':      'معلق',
      'ملاحظات':       '',
    }));
    // Build CSV (simple, no xlsx dependency needed client-side)
    const header = ['اسم الطبيب', 'تاريخ الزيارة', 'الايتم', 'الفيدباك', 'ملاحظات'];
    const csv = [header, ...rows.map(r => header.map(h => r[h as keyof typeof r] ?? ''))].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `template_${activePlan.scientificRep?.name ?? 'plan'}_${activePlan.month}_${activePlan.year}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Transfer plan to rep user ─────────────────────────────────
  const openTransferModal = async (e: React.MouseEvent, plan: Plan) => {
    e.stopPropagation();
    setTransferError('');
    setTransferTarget('');
    setTransferPlan(plan);
    try {
      const r = await fetch(`${API}/api/monthly-plans/${plan.id}/transfer-targets`, { headers: H() });
      const j = await r.json();
      setRepUsers(Array.isArray(j.data) ? j.data : []);
    } catch { setRepUsers([]); }
  };

  const doTransfer = async () => {
    if (!transferPlan || !transferTarget) return;
    setTransferring(true); setTransferError('');
    try {
      const r = await fetch(`${API}/api/monthly-plans/${transferPlan.id}/transfer`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ targetUserId: transferTarget }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل التحويل');
      setTransferPlan(null);
      await load();
    } catch (err: any) { setTransferError(err.message); }
    finally { setTransferring(false); }
  };

  const revokeTransfer = async (e: React.MouseEvent, planId: number) => {
    e.stopPropagation();
    if (!confirm('هل تريد إلغاء تحويل البلان؟')) return;
    try {
      await fetch(`${API}/api/monthly-plans/${planId}/transfer`, { method: 'DELETE', headers: H() });
      await load();
    } catch {}
  };

  const deletePlan = async (e: React.MouseEvent, planId: number) => {
    e.stopPropagation();
    if (!confirm('هل أنت متأكد من حذف هذا البلان بالكامل؟ لا يمكن التراجع عن هذا الإجراء.')) return;
    try {
      const res = await fetch(`${API}/api/monthly-plans/${planId}`, { method: 'DELETE', headers: H() });
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'فشل الحذف'); return; }
      await load();
    } catch { alert('حدث خطأ أثناء الحذف'); }
  };

  // ── Computed stats for active plan ──────────────────────────
  const planStats = useMemo(() => activePlan ? (() => {
    const doctorVisitCount = activePlan.entries.reduce((s, e) => s + e.visits.length, 0);
    const totalVisits  = doctorVisitCount;
    const visitedOnce  = activePlan.entries.filter(e => e.visits.length > 0).length;
    const feedbackCount: Record<string, number> = {};
    const feedbackDoctors: Record<string, { name: string; entryId: number }[]> = {};
    const itemCallMap: Record<string, { name: string; count: number; doctors: { name: string; entryId: number }[] }> = {};
    activePlan.entries.forEach(e => e.visits.forEach(v => {
      feedbackCount[v.feedback] = (feedbackCount[v.feedback] ?? 0) + 1;
      if (!feedbackDoctors[v.feedback]) feedbackDoctors[v.feedback] = [];
      if (!feedbackDoctors[v.feedback].some(d => d.entryId === e.id))
        feedbackDoctors[v.feedback].push({ name: e.doctor.name, entryId: e.id });
      const itemKey = v.item?.name ?? '(بدون ايتم)';
      if (!itemCallMap[itemKey]) itemCallMap[itemKey] = { name: itemKey, count: 0, doctors: [] };
      itemCallMap[itemKey].count++;
      if (!itemCallMap[itemKey].doctors.some(d => d.entryId === e.id))
        itemCallMap[itemKey].doctors.push({ name: e.doctor.name, entryId: e.id });
    }));
    const itemCallStats = Object.values(itemCallMap).sort((a, b) => b.count - a.count);
    return { totalVisits, doctorVisitCount, visitedOnce, feedbackCount, feedbackDoctors, itemCallStats };
  })() : null, [activePlan, pharmVisits]);

  const filteredPlans = useMemo(
    () => filterRep === 'all' ? plans : plans.filter(p => String(p.scientificRepId) === filterRep),
    [plans, filterRep]
  );

  const filteredEntries = useMemo(() => activePlan ? (() => {
    let entries = activePlan.entries;
    if (visitFilter === 'done')        entries = entries.filter(e => e.visits.length >= e.targetVisits);
    if (visitFilter === 'not_done')    entries = entries.filter(e => e.visits.length < e.targetVisits);
    if (visitFilter === 'voice_added') entries = entries.filter(e => e.isExtraVisit);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(entry => {
      const doc = entry.doctor;
      if (doc.name?.toLowerCase().includes(q)) return true;
      if ((doc as any).pharmacyName?.toLowerCase().includes(q)) return true;
      if (doc.specialty?.toLowerCase().includes(q)) return true;
      if (doc.area?.name?.toLowerCase().includes(q)) return true;
      if ((entry.targetItems ?? []).some(ti => ti.item.name.toLowerCase().includes(q))) return true;
      if (entry.visits.some(v => v.item?.name?.toLowerCase().includes(q))) return true;
      return false;
    });
  })() : [], [activePlan, visitFilter, voiceNewEntries, searchQuery]);

  return (
    <div className="mp-shell" style={{ flexDirection: 'column', height: '100%' }}>

      {/* ── Voice reminder overlay ── */}
      {voiceReminderVisible && (
        <div
          onClick={stopVoice}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: 'fadeIn 0.25s ease',
            cursor: 'pointer',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 20, padding: '24px 20px',
              maxWidth: 360, width: '92%', textAlign: 'center', direction: 'rtl',
              boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
              overflow: 'hidden',
            }}
          >
            {/* Countdown progress bar */}
            {voiceCountingDown && (
              <div style={{ margin: '-24px -20px 18px', height: 5, background: '#e2e8f0', borderRadius: '20px 20px 0 0', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: 'linear-gradient(90deg, #f97316, #ef4444)',
                  borderRadius: 'inherit',
                  animation: 'countdown-bar 2s linear forwards',
                }} />
              </div>
            )}

            <div style={{ fontSize: 34, marginBottom: 6 }}>
              {voiceCountingDown ? '⏳' : '🎙️'}
            </div>
            <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#1e293b' }}>
              {voiceCountingDown ? 'استعد للتسجيل...' : 'جاري التسجيل الآن'}
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: voiceCountingDown ? '#f97316' : '#64748b', fontWeight: voiceCountingDown ? 700 : 400 }}>
              {voiceCountingDown ? '🔴 سيبدأ التسجيل خلال ثانيتين' : 'تأكد من ذكر هذه المعلومات:'}
            </p>

            {/* Info items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {[
                { icon: '🩺', label: 'اسم الطبيب' },
                { icon: '💊', label: 'الآيتم' },
                { icon: '📝', label: 'الملاحظات' },
              ].map(({ icon, label }) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: '#f8fafc', borderRadius: 9, padding: '8px 12px',
                  border: '1px solid #e2e8f0',
                }}>
                  <span style={{ fontSize: 18 }}>{icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>{label}</span>
                </div>
              ))}
            </div>

            {/* Feedback badges */}
            <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#374151' }}>💬 أنواع الفيدباك:</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 18 }}>
              {Object.entries(FEEDBACK_LABELS).map(([key, { label, color, bg }]) => (
                <span key={key} style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 10px',
                  borderRadius: 20, color, background: bg,
                  border: `1px solid ${color}30`,
                  whiteSpace: 'nowrap',
                }}>{label}</span>
              ))}
            </div>

            {/* Tap to stop */}
            <div
              onClick={stopVoice}
              style={{
                background: voiceCountingDown ? '#fef3c7' : '#fee2e2',
                border: `1.5px solid ${voiceCountingDown ? '#fbbf24' : '#fca5a5'}`,
                borderRadius: 10, padding: '10px 14px', cursor: 'pointer',
              }}
            >
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: voiceCountingDown ? '#92400e' : '#dc2626' }}>
                {voiceCountingDown ? '✋ اضغط هنا للإلغاء' : '👆 اضغط هنا أو في أي مكان لإنهاء التسجيل'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar: plan selector ── */}
      {/* Field reps: hide top bar entirely once a plan is open */}
      <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 24px', display: activePlan ? 'none' : 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap' }}>📅 البلانات الشهرية</h2>

        {/* Rep filter: managers only */}
        {!isFieldRep && (
          <select value={filterRep} onChange={e => setFilterRep(e.target.value)}
            style={{ ...inputStyle, width: 'auto', minWidth: 140 }}>
            <option value="all">كل المندوبين</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}

        {/* Area restriction button: company_manager only, when a specific rep is selected */}
        {isCompanyManager && filterRep !== 'all' && (() => {
          const selectedRep = reps.find(r => String(r.id) === String(filterRep));
          return selectedRep ? (
            <button
              onClick={() => openRepAreasModal(selectedRep.id, selectedRep.name)}
              style={{ fontSize: 12, padding: '6px 12px', background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', borderRadius: 8, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
            >
              📍 مناطق {selectedRep.name}
            </button>
          ) : null;
        })()}

        <select
          value={activePlan?.id ?? ''}
          onChange={e => {
            const p = filteredPlans.find(pp => pp.id === Number(e.target.value));
            setActivePlan(p ?? null);
            setSearchQuery(''); setVisitFilter('all');
          }}
          style={{ ...inputStyle, width: 'auto', minWidth: 200, fontWeight: 600 }}>
          <option value="">— اختر بلان —</option>
          {filteredPlans.map(p => {
            const totalV = p.entries.reduce((s, e) => s + e.visits.length, 0);
            return (
              <option key={p.id} value={p.id}>
                {p.scientificRep?.name ?? 'بدون مندوب'} · {MONTHS_AR[p.month - 1]} {p.year} ({p.entries.length} طبيب | {totalV}/{p.targetCalls} زيارة)
              </option>
            );
          })}
        </select>

        <button onClick={() => setShowCreate(true)} style={btnStyle('#3b82f6', true)}>+ جديد</button>
        <button
          onClick={async () => { setRefreshing(true); invalidateCache('/api/monthly-plans'); await load(); setRefreshing(false); }}
          disabled={refreshing}
          title="تحديث البيانات من الخادم"
          style={{ ...btnStyle('#64748b', true), padding: '6px 10px', minWidth: 36 }}>
          {refreshing ? '⏳' : '🔄'}
        </button>

        {/* Upload visits */}
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && uploadVisits(e.target.files[0])} />
        {!uploadedFileName ? (
          <button onClick={() => fileRef.current?.click()} disabled={uploading} style={btnStyle('#059669', true)}>
            {uploading ? '⏳ جاري الرفع...' : '📤 رفع زيارات Excel'}
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#374151', background: '#fff', padding: '4px 8px', borderRadius: 6, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: '1px solid #e2e8f0' }}
              title={uploadedFileName}>📄 {uploadedFileName}</span>
            <button onClick={clearUpload} style={{ ...btnStyle('#ef4444', true), padding: '4px 8px', fontSize: 11 }}>🗑</button>
          </div>
        )}
        {uploadResult && (
          <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
            ✅ {uploadResult.imported} زيارة
            {uploadResult.errors.length > 0 && ` | ${uploadResult.errors.length} أخطاء`}
          </span>
        )}
        {error && <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>⚠️ {error}</span>}
      </div>

      {/* ── Main content ── */}
      <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
        {loading ? <p style={{ textAlign: 'center', color: '#94a3b8', padding: 40 }}>تحميل...</p> : !activePlan ? (
          <div>
            {filteredPlans.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, color: '#94a3b8' }}>
                <p style={{ fontSize: 48 }}>📅</p>
                <p style={{ fontSize: 18 }}>لا توجد بلانات — أنشئ بلان جديد</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
                {filteredPlans.map(p => {
                  const totalV = p.entries.reduce((s, e) => s + e.visits.length, 0);
                  const pct    = Math.min(100, Math.round((totalV / (p.targetCalls || 150)) * 100));
                  return (
                    <div key={p.id} onClick={() => {
                      history.pushState({ page: 'monthly-plans', planId: p.id }, '');
                      setActivePlan(p); setSearchQuery(''); setVisitFilter('all'); setSelectMode(false); setSelectedEntries(new Set());
                    }}
                      style={{ background: '#fff', border: '2px solid #e2e8f0', borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(59,130,246,0.15)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.boxShadow = 'none'; }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
                          <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: p.scientificRep ? '#1e293b' : '#94a3b8' }}>
                            {p.scientificRep?.name ?? 'بدون مندوب'}
                          </p>
                          {/* Area dropdown arrow */}
                          {(p.planAreas?.length ?? 0) > 0 && (
                            <span
                              onClick={e => { e.stopPropagation(); setAreaDropdownPlanId(areaDropdownPlanId === p.id ? null : p.id); }}
                              style={{ cursor: 'pointer', fontSize: 10, color: '#6366f1', userSelect: 'none', padding: '2px 4px', borderRadius: 4, background: areaDropdownPlanId === p.id ? '#eef2ff' : 'transparent' }}
                              title="عرض المناطق">
                              {areaDropdownPlanId === p.id ? '▲' : '▼'}
                            </span>
                          )}
                          {/* Area dropdown popup */}
                          {areaDropdownPlanId === p.id && (p.planAreas?.length ?? 0) > 0 && (
                            <div onClick={e => e.stopPropagation()} style={{
                              position: 'absolute', top: '100%', right: 0, zIndex: 50,
                              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                              boxShadow: '0 4px 12px rgba(0,0,0,0.1)', padding: '8px 12px',
                              minWidth: 140, marginTop: 4,
                            }}>
                              <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: '#64748b' }}>📍 مناطق البلان:</p>
                              {p.planAreas!.map(pa => (
                                <div key={pa.id} style={{ fontSize: 12, color: '#374151', padding: '2px 0' }}>• {pa.area.name}</div>
                              ))}
                            </div>
                          )}
                        </div>
                        {p.user && (
                          <span style={{ fontSize: 11, color: '#7c3aed', background: '#ede9fe', borderRadius: 6, padding: '2px 7px', fontWeight: 600, whiteSpace: 'nowrap', marginRight: 4 }}>
                            👤 {p.user.username}
                          </span>
                        )}
                      </div>
                      {/* Assign rep button for plans without a rep */}
                      {isManagerOrAdmin && !p.scientificRepId && (
                        <div style={{ marginBottom: 6 }} onClick={e => e.stopPropagation()}>
                          <select
                            defaultValue=""
                            onChange={async e => {
                              const repId = e.target.value;
                              if (!repId) return;
                              try {
                                const r = await fetch(`${API}/api/monthly-plans/${p.id}`, {
                                  method: 'PUT', headers: H(),
                                  body: JSON.stringify({ scientificRepId: parseInt(repId) }),
                                });
                                if (r.ok) { invalidateCache('/api/monthly-plans'); await load(); }
                              } catch {}
                            }}
                            style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca', cursor: 'pointer', fontWeight: 600 }}>
                            <option value="">🔗 ربط بمندوب...</option>
                            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                        </div>
                      )}
                      <p style={{ margin: '2px 0 8px', fontSize: 13, color: '#64748b' }}>
                        {MONTHS_AR[p.month - 1]} {p.year}
                      </p>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569', marginBottom: 6 }}>
                        <span>👨‍⚕️ {p.entries.length}/{p.targetDoctors} طبيب</span>
                        <span>📞 {totalV}/{p.targetCalls} زيارة</span>
                      </div>
                      <div style={{ background: '#e2e8f0', borderRadius: 4, height: 6 }}>
                        <div style={{ background: pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#3b82f6', width: `${pct}%`, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8', textAlign: 'left' }}>{pct}%</p>
                      {(isManagerOrAdmin || (isFieldRep && p.scientificRepId === authUser?.linkedRepId)) && (
                        <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
                          {isManagerOrAdmin && (p.assignedUserId ? (
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 11, color: '#0369a1', background: '#e0f2fe', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>
                                🔗 {p.assignedUser?.username ?? 'مُحوَّل'}
                              </span>
                              <button
                                style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 700 }}
                                onClick={e => revokeTransfer(e, p.id)}>
                                ✕ إلغاء
                              </button>
                            </div>
                          ) : (
                            <button
                              style={{ fontSize: 11, color: '#0369a1', background: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', width: '100%', fontWeight: 600 }}
                              onClick={e => openTransferModal(e, p)}>
                              📤 تحويل للمندوب
                            </button>
                          ))}
                          <button
                            style={{ fontSize: 11, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', width: '100%', fontWeight: 600, marginTop: 6 }}
                            onClick={e => deletePlan(e, p.id)}>
                            🗑️ مسح البلان
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Plan header */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 6 }}>
              <div style={{ position: 'relative', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>

                {/* Back button */}
                <button onClick={() => { setActivePlan(null); setSearchQuery(''); setVisitFilter('all'); setSelectMode(false); setSelectedEntries(new Set()); }}
                  title="الرجوع للقائمة"
                  style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#475569' }}>
                  ← {isFieldRep ? '' : 'الرجوع'}
                </button>

                {/* ── Excel: export + import plan ── */}
                <div style={{ position: 'relative' }}>
                  <button onClick={() => setShowExcelMenu(v => !v)}
                    style={{ ...btnStyle('#059669'), display: 'flex', alignItems: 'center', gap: 5 }}>
                    📊 Excel
                  </button>
                  {showExcelMenu && (
                    <div style={{
                      position: 'absolute', top: '110%', right: 0, zIndex: 300,
                      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
                      padding: 6, minWidth: 210, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      direction: 'rtl',
                    }} onClick={() => setShowExcelMenu(false)}>
                      <button onClick={exportPlanExcel} style={menuItemStyle}>
                        📤 تصدير البلان إلى Excel
                      </button>
                      <hr style={{ margin: '4px 6px', border: 'none', borderTop: '1px solid #f1f5f9' }} />
                      <button onClick={() => { setShowPlanImportModal(true); setPlanImportResult(null); }} style={menuItemStyle}>
                        📥 استيراد البلان من Excel
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Suggest + settings (combined group) ── */}
                <div style={{ display: 'flex', gap: 0 }}>
                  <button onClick={loadSuggest} disabled={suggestLoading}
                    style={{ ...btnStyle('#7c3aed'), borderRadius: '9px 0 0 9px', borderLeft: '1px solid rgba(255,255,255,0.25)', paddingRight: 10 }}>
                    {suggestLoading ? '⏳' : '✨'} اقتراح ذكي
                  </button>
                  <button onClick={() => { if (!showSuggestSettings) setEditAreaIds(activePlan?.planAreas?.map(pa => pa.area.id) ?? []); setShowSuggestSettings(v => !v); }}
                    title="إعدادات الاقتراح"
                    style={{ ...btnStyle('#7c3aed'), borderRadius: '0 9px 9px 0', padding: '8px 9px', fontSize: 14 }}>
                    ⚙️
                  </button>
                </div>

                {/* ── Voice: icon-only button ── */}
                <button
                  onClick={() => { if (voiceListening) { stopVoice(); } else { startVoice(); } }}
                  title={voiceListening ? 'إيقاف التسجيل' : 'إدخال صوتي'}
                  style={{
                    ...btnStyle(voiceListening ? '#ef4444' : '#0284c7'),
                    padding: '8px 11px', fontSize: 16,
                    animation: voiceListening ? 'pulse-mic 1.5s infinite' : 'none',
                  }}>
                  {voiceListening ? '⏹' : '🎤'}
                </button>

                {/* ── Tools overflow menu: managers only ── */}
                {!isFieldRep && (
                  <div style={{ position: 'relative', marginRight: 'auto' }}>
                    <button
                      onClick={() => setShowToolsMenu(v => !v)}
                      style={{ ...btnStyle('#64748b'), padding: '6px 10px', minWidth: 36 }}
                      title="أدوات">
                      ⋯
                    </button>
                    {showToolsMenu && (
                      <div style={{
                        position: 'absolute', top: '110%', right: 0, zIndex: 300,
                        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
                        padding: 6, minWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                        direction: 'rtl',
                      }} onClick={() => setShowToolsMenu(false)}>
                        {/* Edit plan areas */}
                        <button
                          onClick={() => {
                            setEditAreaIds(activePlan.planAreas?.map(pa => pa.area.id) ?? []);
                            setEditingPlanAreas(true);
                          }}
                          style={menuItemStyle}>
                          📍 تعديل المناطق
                        </button>
                        <hr style={{ margin: '4px 6px', border: 'none', borderTop: '1px solid #f1f5f9' }} />
                        {/* Import */}
                        <button
                          onClick={() => { setShowImportModal(true); setImportResult(null); }}
                          style={menuItemStyle}>
                          📥 استيراد تقارير Excel
                        </button>
                        <hr style={{ margin: '4px 6px', border: 'none', borderTop: '1px solid #f1f5f9' }} />
                        {/* Extra visits toggle */}
                        <button
                          onClick={toggleAllowExtraVisits}
                          style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
                          <span>كولات خارج البلان</span>
                          <div style={{
                            width: 34, height: 19, borderRadius: 10, position: 'relative', flexShrink: 0,
                            background: activePlan.allowExtraVisits ? '#22c55e' : '#cbd5e1',
                            transition: 'background 0.2s',
                          }}>
                            <div style={{
                              position: 'absolute', top: 2.5, width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                              left: activePlan.allowExtraVisits ? 17 : 3, transition: 'left 0.2s',
                            }} />
                          </div>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Edit plan areas modal */}
                {editingPlanAreas && (
                  <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => setEditingPlanAreas(false)}>
                    <div style={{ background: '#fff', borderRadius: 14, padding: 20, width: '92%', maxWidth: 420, maxHeight: '80vh', overflowY: 'auto', direction: 'rtl' }}
                      onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: '#1e293b' }}>📍 تعديل مناطق البلان</p>
                        <button onClick={() => setEditingPlanAreas(false)}
                          style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>×</button>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                        <button onClick={() => setEditAreaIds(allAreas.map(a => a.id))} type="button"
                          style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          ✓ الكل
                        </button>
                        <button onClick={() => setEditAreaIds([])} type="button"
                          style={{ background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          ✕ إلغاء
                        </button>
                      </div>
                      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8 }}>
                        {allAreas.length === 0 && <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', margin: 8 }}>لا توجد مناطق</p>}
                        {allAreas.map(a => (
                          <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '4px 6px', borderRadius: 6, background: editAreaIds.includes(a.id) ? '#eff6ff' : 'transparent' }}>
                            <input type="checkbox" checked={editAreaIds.includes(a.id)}
                              onChange={e => {
                                if (e.target.checked) setEditAreaIds(prev => [...prev, a.id]);
                                else setEditAreaIds(prev => prev.filter(id => id !== a.id));
                              }} />
                            {a.name}
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                        <button onClick={savePlanAreas} disabled={savingAreas}
                          style={{ flex: 1, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                          {savingAreas ? 'جاري الحفظ...' : '💾 حفظ المناطق'}
                        </button>
                        <button onClick={() => setEditingPlanAreas(false)}
                          style={{ flex: 0.5, background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: 8, padding: '8px 0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                          إلغاء
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Settings modal — fixed overlay for mobile compatibility */}
                {showSuggestSettings && (
                  <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 500, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
                    onClick={() => setShowSuggestSettings(false)}
                  >
                  <div style={{
                    background: '#fff', borderRadius: '16px 16px 0 0',
                    padding: 20, width: '100%', maxWidth: 460,
                    maxHeight: '92vh', overflowY: 'auto',
                    boxShadow: '0 -4px 24px rgba(0,0,0,0.18)', direction: 'rtl',
                  }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: '#1e293b' }}>⚙️ إعدادات الاقتراح الذكي</p>
                      <button onClick={() => setShowSuggestSettings(false)}
                        style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8' }}>×</button>
                    </div>

                    {/* Target doctors */}
                    <label style={settingLabelStyle}>
                      👨‍⚕️ عدد الأطباء المستهدف
                      <input type="number" min={1} max={200} value={sTargetDoctors}
                        onChange={e => setSTargetDoctors(+e.target.value)}
                        style={{ ...settingInputStyle, width: 80, textAlign: 'center' }} />
                    </label>

                    {/* Target visits per doctor */}
                    <label style={settingLabelStyle}>
                      📞 عدد الزيارات لكل طبيب
                      <input type="number" min={1} max={20} value={sTargetVisits}
                        onChange={e => setSTargetVisits(+e.target.value)}
                        style={{ ...settingInputStyle, width: 80, textAlign: 'center' }} />
                    </label>

                    {/* Keep feedback */}
                    <div style={{ marginBottom: 14 }}>
                      <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#374151' }}>✅ فيدباك يُبقى عليه (من الشهر السابق)</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {([
                          { k: 'writing',      label: 'يكتب',        color: '#166534', bg: '#dcfce7' },
                          { k: 'stocked',      label: 'نزل الايتم',  color: '#1e40af', bg: '#dbeafe' },
                          { k: 'interested',   label: 'مهتم',        color: '#7c3aed', bg: '#ede9fe' },
                          { k: 'not_interested',label:'غير مهتم',   color: '#991b1b', bg: '#fee2e2' },
                          { k: 'unavailable',  label: 'غير متوفر',   color: '#92400e', bg: '#fef3c7' },
                          { k: 'pending',      label: 'معلق',        color: '#475569', bg: '#f1f5f9' },
                        ] as const).map(f => {
                          const on = sKeepFeedback.includes(f.k);
                          return (
                            <span key={f.k} onClick={() => setSKeepFeedback(prev =>
                              on ? prev.filter(x => x !== f.k) : [...prev, f.k]
                            )} style={{
                              padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                              cursor: 'pointer', userSelect: 'none',
                              background: on ? f.bg : '#f8fafc',
                              color: on ? f.color : '#94a3b8',
                              border: `2px solid ${on ? f.color : '#e2e8f0'}`,
                            }}>{f.label}</span>
                          );
                        })}
                      </div>
                    </div>

                    {/* Restrict to rep areas — OR — plan areas editable checklist */}
                    {activePlan.planAreas && activePlan.planAreas.length > 0 ? (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#374151' }}>📍 مناطق البلان</p>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => setEditAreaIds(allAreas.map(a => a.id))} type="button"
                              style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                              ✓ الكل
                            </button>
                            <button onClick={() => setEditAreaIds([])} type="button"
                              style={{ background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                              ✕ إلغاء
                            </button>
                          </div>
                        </div>
                        <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 6 }}>
                          {allAreas.map(a => (
                            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', padding: '3px 6px', borderRadius: 6, background: editAreaIds.includes(a.id) ? '#eff6ff' : 'transparent' }}>
                              <input type="checkbox" checked={editAreaIds.includes(a.id)}
                                onChange={e => {
                                  if (e.target.checked) setEditAreaIds(prev => [...prev, a.id]);
                                  else setEditAreaIds(prev => prev.filter(id => id !== a.id));
                                }} />
                              {a.name}
                            </label>
                          ))}
                        </div>
                        <button onClick={async () => {
                          setSavingAreas(true);
                          try {
                            const r = await fetch(`${API}/api/monthly-plans/${activePlan.id}/areas`, {
                              method: 'PUT', headers: H(),
                              body: JSON.stringify({ areaIds: editAreaIds }),
                            });
                            if (!r.ok) { const j = await r.json(); throw new Error(j.error ?? j.message ?? 'فشل'); }
                            invalidateCache('/api/monthly-plans');
                            await reloadPlan(activePlan.id);
                          } catch (e: any) { alert(e.message); }
                          finally { setSavingAreas(false); }
                        }} disabled={savingAreas}
                          style={{ marginTop: 8, width: '100%', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                          {savingAreas ? 'جاري الحفظ...' : '💾 حفظ المناطق'}
                        </button>
                      </div>
                    ) : (
                    <label style={{ ...settingLabelStyle, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>📍 تقييد بمناطق المندوب فقط</span>
                      <div onClick={() => setSRestrictAreas(v => !v)}
                        style={{
                          width: 44, height: 24, borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s',
                          background: sRestrictAreas ? '#8b5cf6' : '#e2e8f0', position: 'relative',
                        }}>
                        <div style={{
                          position: 'absolute', top: 3, transition: 'left 0.2s',
                          left: sRestrictAreas ? 23 : 3,
                          width: 18, height: 18, borderRadius: '50%', background: '#fff',
                          boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                        }} />
                      </div>
                    </label>
                    )}

                    {/* Sort by */}
                    <label style={settingLabelStyle}>
                      🔀 ترتيب الأطباء الجدد
                      <select value={sSortBy} onChange={e => setSSortBy(e.target.value as any)}
                        style={settingInputStyle}>
                        <option value="oldest">الأقدم إدخالاً</option>
                        <option value="newest">الأحدث إدخالاً</option>
                        <option value="random">عشوائي</option>
                      </select>
                    </label>

                    {/* Note analysis toggle */}
                    <label style={{ ...settingLabelStyle, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: '0 0 3px', fontSize: 13, fontWeight: 700, color: '#374151' }}>📝 تحليل ملاحظات الزيارات</p>
                        <p style={{ margin: 0, fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
                          يسحب الأطباء الذين ملاحظات زياراتهم تشير إلى متابعة، طلب عينات، سؤال، زيارة قادمة، إحضار مدير، متابعة صيدلية... حتى لو الفيدباك الأخير سلبي
                        </p>
                      </div>
                      <div onClick={() => setSUseNoteAnalysis(v => !v)}
                        style={{
                          width: 44, height: 24, borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0, marginTop: 2,
                          background: sUseNoteAnalysis ? '#8b5cf6' : '#e2e8f0', position: 'relative',
                        }}>
                        <div style={{
                          position: 'absolute', top: 3, transition: 'left 0.2s',
                          left: sUseNoteAnalysis ? 23 : 3,
                          width: 18, height: 18, borderRadius: '50%', background: '#fff',
                          boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                        }} />
                      </div>
                    </label>

                    {/* ── Lookback months ── */}
                    {(() => {
                      // Build list of last 6 months before this plan's month
                      const opts: { label: string; val: string }[] = [];
                      for (let i = 1; i <= 6; i++) {
                        let mo = activePlan.month - i; let yr = activePlan.year;
                        if (mo <= 0) { mo += 12; yr -= 1; }
                        const val = `${yr}-${String(mo).padStart(2,'0')}`;
                        opts.push({ label: `${MONTHS_AR[mo-1]} ${yr}`, val });
                      }
                      return (
                        <div style={{ marginBottom: 14 }}>
                          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#374151' }}>📅 الأشهر السابقة للبحث</p>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {opts.map(o => {
                              const on = sLookbackList.includes(o.val);
                              return (
                                <span key={o.val} onClick={() => setSLookbackList(prev =>
                                  on ? prev.filter(v => v !== o.val) : [...prev, o.val]
                                )} style={{
                                  padding: '4px 12px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                                  cursor: 'pointer', userSelect: 'none',
                                  background: on ? '#dbeafe' : '#f8fafc',
                                  color:      on ? '#1e40af' : '#94a3b8',
                                  border: `2px solid ${on ? '#1e40af' : '#e2e8f0'}`,
                                }}>{o.label}</span>
                              );
                            })}
                          </div>
                          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8' }}>
                            {sLookbackList.length === 0 ? 'الشهر السابق فقط (افتراضي)' : `${sLookbackList.length} شهر محدد`}
                          </p>
                        </div>
                      );
                    })()}

                    {/* ── New doctors ratio ── */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#374151' }}>🆕 نسبة الأطباء الجدد</p>
                        <span style={{ fontSize: 13, fontWeight: 800, color: '#8b5cf6' }}>
                          {sNewRatio === 0 ? 'تلقائي' : `${sNewRatio}%`}
                        </span>
                      </div>
                      <input type="range" min={0} max={100} step={5} value={sNewRatio}
                        onChange={e => setSNewRatio(+e.target.value)}
                        style={{ width: '100%', accentColor: '#8b5cf6' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                        <span>تلقائي</span><span>50%</span><span>100% جدد</span>
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8' }}>
                        أطباء موجودون في السرفي لكن لم يُزاروا أو لم تنزل لهم طلبية
                      </p>
                    </div>

                    {/* ── Focus filters ── */}
                    {(() => {
                      const repAreas: { id: number; name: string }[] = (activePlan as any).scientificRep?.areas ?? [];
                      const extraAreas = plans.flatMap(p => p.entries.map(e => e.doctor.area).filter(Boolean)) as { id: number; name: string }[];
                      const allAreaMap = new Map<number, string>();
                      [...repAreas, ...extraAreas].forEach(a => allAreaMap.set(a.id, a.name));
                      const allAreas = [...allAreaMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
                      const filteredItems = items.filter(it =>
                        !sFocusItemIds.find(x => x.id === String(it.id)) &&
                        (!sFocusItemText || it.name.toLowerCase().includes(sFocusItemText.toLowerCase()))
                      );
                      const filteredAreas = allAreas.filter(a =>
                        !sFocusAreaIds.find(x => x.id === String(a.id)) &&
                        (!sFocusAreaText || a.name.toLowerCase().includes(sFocusAreaText.toLowerCase()))
                      );
                      const allSpecialties = [...new Set(
                        plans.flatMap(p => p.entries.map(e => e.doctor.specialty)).filter((s): s is string => Boolean(s))
                      )].sort();
                      const filteredSpecs = allSpecialties.filter(s =>
                        !sFocusSpecialties.includes(s) &&
                        (!sFocusSpecText || s.toLowerCase().includes(sFocusSpecText.toLowerCase()))
                      );
                      const ddBase: React.CSSProperties = {
                        position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 600,
                        background: '#fff', border: '1.5px solid #c4b5fd', borderRadius: 8,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 150, overflowY: 'auto',
                      };
                      const ddItem: React.CSSProperties = { padding: '7px 12px', fontSize: 12, cursor: 'pointer', color: '#374151' };
                      const chipStyle = (color: string, bg: string): React.CSSProperties => ({
                        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20,
                        fontSize: 11, fontWeight: 600, background: bg, color, border: `1px solid ${color}20`,
                        cursor: 'pointer', flexShrink: 0,
                      });
                      const inputStyle: React.CSSProperties = {
                        ...settingInputStyle, borderRadius: 7, marginTop: 4,
                      };
                      return (
                        <div style={{ marginBottom: 14 }}>
                          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#374151' }}>🎯 تركيز على</p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {/* Focus items */}
                            <div>
                              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#374151' }}>💊 ايتمات معينة</p>
                              {sFocusItemIds.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                                  {sFocusItemIds.map(x => (
                                    <span key={x.id} style={chipStyle('#7c3aed', '#ede9fe')}
                                      onClick={() => setSFocusItemIds(prev => prev.filter(p => p.id !== x.id))}>
                                      {x.name} ×
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{ position: 'relative' }}>
                                <input type="text" value={sFocusItemText} autoComplete="off"
                                  onChange={e => { setSFocusItemText(e.target.value); setSFocusItemDD(true); }}
                                  onFocus={() => setSFocusItemDD(true)}
                                  onBlur={() => setTimeout(() => setSFocusItemDD(false), 150)}
                                  placeholder={sFocusItemIds.length === 0 ? 'ابحث وأضف ايتم...' : 'أضف ايتم آخر...'}
                                  style={inputStyle} />
                                {sFocusItemDD && filteredItems.length > 0 && (
                                  <div style={ddBase}>
                                    {filteredItems.slice(0, 40).map(it => (
                                      <div key={it.id}
                                        onMouseDown={() => { setSFocusItemIds(prev => [...prev, { id: String(it.id), name: it.name }]); setSFocusItemText(''); setSFocusItemDD(false); }}
                                        style={ddItem}>{it.name}</div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Focus areas */}
                            <div>
                              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#374151' }}>📍 مناطق معينة</p>
                              {sFocusAreaIds.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                                  {sFocusAreaIds.map(x => (
                                    <span key={x.id} style={chipStyle('#1e40af', '#dbeafe')}
                                      onClick={() => setSFocusAreaIds(prev => prev.filter(p => p.id !== x.id))}>
                                      {x.name} ×
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{ position: 'relative' }}>
                                <input type="text" value={sFocusAreaText} autoComplete="off"
                                  onChange={e => { setSFocusAreaText(e.target.value); setSFocusAreaDD(true); }}
                                  onFocus={() => setSFocusAreaDD(true)}
                                  onBlur={() => setTimeout(() => setSFocusAreaDD(false), 150)}
                                  placeholder={sFocusAreaIds.length === 0 ? 'ابحث وأضف منطقة...' : 'أضف منطقة أخرى...'}
                                  style={inputStyle} />
                                {sFocusAreaDD && filteredAreas.length > 0 && (
                                  <div style={ddBase}>
                                    {filteredAreas.slice(0, 40).map(a => (
                                      <div key={a.id}
                                        onMouseDown={() => { setSFocusAreaIds(prev => [...prev, { id: String(a.id), name: a.name }]); setSFocusAreaText(''); setSFocusAreaDD(false); }}
                                        style={ddItem}>{a.name}</div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Focus specialties */}
                            <div>
                              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#374151' }}>🔬 اختصاصات معينة</p>
                              {sFocusSpecialties.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                                  {sFocusSpecialties.map(s => (
                                    <span key={s} style={chipStyle('#166534', '#dcfce7')}
                                      onClick={() => setSFocusSpecialties(prev => prev.filter(p => p !== s))}>
                                      {s} ×
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{ position: 'relative' }}>
                                <input type="text" value={sFocusSpecText} autoComplete="off"
                                  onChange={e => { setSFocusSpecText(e.target.value); setSFocusSpecDD(true); }}
                                  onFocus={() => setSFocusSpecDD(true)}
                                  onBlur={() => setTimeout(() => setSFocusSpecDD(false), 150)}
                                  placeholder={sFocusSpecialties.length === 0 ? 'ابحث وأضف اختصاص...' : 'أضف اختصاص آخر...'}
                                  style={inputStyle} />
                                {sFocusSpecDD && (filteredSpecs.length > 0 || sFocusSpecText.trim()) && (
                                  <div style={ddBase}>
                                    {sFocusSpecText.trim() && !filteredSpecs.includes(sFocusSpecText.trim()) && !sFocusSpecialties.includes(sFocusSpecText.trim()) && (
                                      <div onMouseDown={() => { setSFocusSpecialties(prev => [...prev, sFocusSpecText.trim()]); setSFocusSpecText(''); setSFocusSpecDD(false); }}
                                        style={{ ...ddItem, color: '#166534', fontWeight: 600 }}>➕ "{sFocusSpecText.trim()}"</div>
                                    )}
                                    {filteredSpecs.slice(0, 40).map(s => (
                                      <div key={s}
                                        onMouseDown={() => { setSFocusSpecialties(prev => [...prev, s]); setSFocusSpecText(''); setSFocusSpecDD(false); }}
                                        style={ddItem}>{s}</div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* User custom note */}
                    <div style={{ marginBottom: 6 }}>
                      <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: '#374151' }}>
                        💬 تعليمات مخصصة <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 11 }}>(اختياري)</span>
                      </p>
                      <textarea
                        value={sUserNote}
                        onChange={e => setSUserNote(e.target.value)}
                        rows={3}
                        placeholder={'مثال: أضف دكتور أحمد من الكرادة، استبعد أطباء منطقة الدورة، ركز على تخصص باطنية...'}
                        style={{
                          width: '100%', boxSizing: 'border-box', resize: 'vertical',
                          border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '8px 10px',
                          fontSize: 12, lineHeight: 1.6, color: '#374151', outline: 'none',
                          background: '#f8fafc', direction: 'rtl', fontFamily: 'inherit',
                          transition: 'border-color 0.15s',
                        }}
                        onFocus={e => (e.target.style.borderColor = '#8b5cf6')}
                        onBlur={e  => (e.target.style.borderColor = '#e2e8f0')}
                      />
                      <p style={{ margin: '4px 0 0', fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>
                        سيتم تحليل ملاحظاتك بالذكاء الاصطناعي وتطبيقها على الاقتراح
                      </p>
                    </div>

                    {/* Wish list (قائمة الطلبات) */}
                    {(() => {
                      let wishIds: number[] = [];
                      const wishItems: Record<number, string> = {};
                      const wishNames: Record<number, string> = {};
                      try {
                        const stored = localStorage.getItem(`wishedDoctors_${authUser?.id ?? 'guest'}`);
                        wishIds = stored ? JSON.parse(stored) : [];
                        const wi = localStorage.getItem(`wishedItems_${authUser?.id ?? 'guest'}`);
                        if (wi) Object.assign(wishItems, JSON.parse(wi));
                        const wn = localStorage.getItem(`wishedDoctorNames_${authUser?.id ?? 'guest'}`);
                        if (wn) Object.assign(wishNames, JSON.parse(wn));
                      } catch { /* ignore */ }
                      // Fallback: look up names from plans data for any IDs missing a name
                      if (wishIds.some(id => !wishNames[id])) {
                        plans.forEach(p => p.entries.forEach(e => {
                          if (!wishNames[e.doctorId] && e.doctor?.name) wishNames[e.doctorId] = e.doctor.name;
                        }));
                      }
                      const wishCount = wishIds.length;
                      const activeWishCount = wishIds.filter(id => !sWishExcluded.has(id)).length;
                      return (
                        <div style={{ marginBottom: 14, border: '1.5px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                          {/* Header row */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: sUseWishList && wishCount > 0 ? '#fffbeb' : '#f8fafc' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 16 }}>⭐</span>
                              <div style={{ flex: 1 }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>قائمة الطلبات</span>
                                {wishCount > 0 && (
                                  <button
                                    onClick={() => setSWishDropdownOpen(v => !v)}
                                    style={{ marginRight: 8, padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                                      background: sUseWishList ? '#fef9c3' : '#f1f5f9',
                                      color: sUseWishList ? '#854d0e' : '#64748b',
                                      border: `1px solid ${sUseWishList ? '#fde047' : '#e2e8f0'}`,
                                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                    {activeWishCount} طبيب
                                    <span style={{ fontSize: 10, display: 'inline-block', transform: sWishDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                                  </button>
                                )}
                              </div>
                            </div>
                            {/* Toggle */}
                            <div onClick={() => wishCount > 0 && setSUseWishList(v => !v)}
                              style={{
                                width: 44, height: 24, borderRadius: 12, transition: 'background 0.2s', flexShrink: 0,
                                background: sUseWishList && wishCount > 0 ? '#f59e0b' : '#e2e8f0',
                                position: 'relative', cursor: wishCount > 0 ? 'pointer' : 'not-allowed', opacity: wishCount === 0 ? 0.5 : 1,
                              }}>
                              <div style={{
                                position: 'absolute', top: 3, transition: 'left 0.2s',
                                left: sUseWishList && wishCount > 0 ? 23 : 3,
                                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                                boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                              }} />
                            </div>
                          </div>
                          {/* Subtitle */}
                          <div style={{ padding: '0 12px 8px', background: sUseWishList && wishCount > 0 ? '#fffbeb' : '#f8fafc' }}>
                            <p style={{ margin: 0, fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
                              {wishCount === 0
                                ? 'لا يوجد أطباء في قائمة الطلبات حالياً — أضفهم من صفحة السرفي'
                                : 'يضمن تضمين الأطباء الذين اخترتهم في السرفي بغض النظر عن المنطقة'}
                            </p>
                          </div>
                          {/* Expandable doctor list */}
                          {sWishDropdownOpen && wishCount > 0 && (
                            <div style={{ borderTop: '1px solid #e2e8f0', padding: 10, background: '#fff' }}>
                              {/* Select all / deselect all */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                <span style={{ fontSize: 11, color: '#64748b' }}>اختر من تريد تضمينه</span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button onMouseDown={() => setSWishExcluded(new Set())}
                                    style={{ padding: '2px 8px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: '1px solid #22c55e', background: '#dcfce7', color: '#166534', cursor: 'pointer' }}>
                                    ✅ الكل
                                  </button>
                                  <button onMouseDown={() => setSWishExcluded(new Set(wishIds))}
                                    style={{ padding: '2px 8px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: '1px solid #fca5a5', background: '#fee2e2', color: '#991b1b', cursor: 'pointer' }}>
                                    ✗ لا شيء
                                  </button>
                                </div>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                                {wishIds.map(id => {
                                  const excluded = sWishExcluded.has(id);
                                  const itemName = wishItems[id];
                                  return (
                                    <div key={id}
                                      onClick={() => setSWishExcluded(prev => {
                                        const s = new Set(prev);
                                        excluded ? s.delete(id) : s.add(id);
                                        return s;
                                      })}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7,
                                        background: excluded ? '#f8fafc' : '#fffbeb',
                                        border: `1px solid ${excluded ? '#e2e8f0' : '#fde047'}`,
                                        cursor: 'pointer', opacity: excluded ? 0.55 : 1,
                                      }}>
                                      <span style={{ fontSize: 14, color: excluded ? '#94a3b8' : '#f59e0b', flexShrink: 0 }}>{excluded ? '☆' : '⭐'}</span>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: excluded ? '#94a3b8' : '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {wishNames[id] ?? `طبيب #${id}`}
                                        </p>
                                        {wishItems[id] && (
                                          <p style={{ margin: 0, fontSize: 10, color: '#64748b' }}>💊 {wishItems[id]}</p>
                                        )}
                                      </div>
                                      <span style={{ fontSize: 11, color: excluded ? '#94a3b8' : '#166534', fontWeight: 600 }}>{excluded ? 'غير مرشح' : 'مرشح'}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* ── Area quota distribution ── */}
                    {sRepAreas.length > 0 && (
                      <div style={{ marginBottom: 14, border: '1.5px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                        {/* Header row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: sAreaQuotasEnabled ? '#f0f9ff' : '#f8fafc' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 16 }}>📊</span>
                            <div>
                              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#374151' }}>توزيع الأطباء على المناطق</p>
                              {sAreaQuotasEnabled && (() => {
                                const quotaTotal = Object.values(sAreaQuotas).reduce((s, v) => s + (v || 0), 0);
                                const isEqual = quotaTotal === sTargetDoctors;
                                return (
                                  <p style={{ margin: 0, fontSize: 11, color: isEqual ? '#0369a1' : '#92400e' }}>
                                    المجموع: {quotaTotal} طبيب
                                    {!isEqual && quotaTotal > 0 && (
                                      <span style={{ marginRight: 4 }}>
                                        → سيُوزَّع {sTargetDoctors} طبيب بنفس النسب
                                      </span>
                                    )}
                                  </p>
                                );
                              })()}
                            </div>
                          </div>
                          <div onClick={() => {
                              const next = !sAreaQuotasEnabled;
                              setSAreaQuotasEnabled(next);
                              if (next && sRepAreas.length > 0) {
                                const base = Math.floor(sTargetDoctors / sRepAreas.length);
                                const rem  = sTargetDoctors % sRepAreas.length;
                                const q: Record<string, number> = {};
                                sRepAreas.forEach((a, i) => { q[String(a.id)] = base + (i < rem ? 1 : 0); });
                                setSAreaQuotas(q);
                              }
                            }}
                            style={{
                              width: 44, height: 24, borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
                              background: sAreaQuotasEnabled ? '#0ea5e9' : '#e2e8f0', position: 'relative',
                            }}>
                            <div style={{
                              position: 'absolute', top: 3, transition: 'left 0.2s',
                              left: sAreaQuotasEnabled ? 23 : 3,
                              width: 18, height: 18, borderRadius: '50%', background: '#fff',
                              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                            }} />
                          </div>
                        </div>
                        {/* Area inputs */}
                        {sAreaQuotasEnabled && (
                          <div style={{ padding: '8px 12px 10px', background: '#fff' }}>
                            <p style={{ margin: '0 0 8px', fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
                              حدد عدد الأطباء المطلوب من كل منطقة — الإجمالي يحل محل &quot;عدد الأطباء المستهدف&quot;
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {sRepAreas.map((area, i) => (
                                <div key={area.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{
                                    flex: 1, fontSize: 13, fontWeight: 600, color: '#1e293b',
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                  }}>
                                    {area.name}
                                  </span>
                                  <input
                                    type="number" min={0} max={500}
                                    value={sAreaQuotas[String(area.id)] ?? 0}
                                    onChange={e => {
                                      const val = Math.max(0, parseInt(e.target.value) || 0);
                                      setSAreaQuotas(prev => ({ ...prev, [String(area.id)]: val }));
                                    }}
                                    style={{
                                      width: 64, textAlign: 'center', padding: '4px 6px', borderRadius: 7,
                                      border: '1.5px solid #cbd5e1', fontSize: 13, fontWeight: 700,
                                      color: '#0369a1', background: '#f0f9ff', outline: 'none',
                                    }}
                                    onFocus={e => (e.target.style.borderColor = '#0ea5e9')}
                                    onBlur={e  => (e.target.style.borderColor = '#cbd5e1')}
                                  />
                                  <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>طبيب</span>
                                </div>
                              ))}
                            </div>
                            {/* Reset to equal button */}
                            <button
                              onClick={() => {
                                const base = Math.floor(sTargetDoctors / sRepAreas.length);
                                const rem  = sTargetDoctors % sRepAreas.length;
                                const q: Record<string, number> = {};
                                sRepAreas.forEach((a, i) => { q[String(a.id)] = base + (i < rem ? 1 : 0); });
                                setSAreaQuotas(q);
                              }}
                              style={{
                                marginTop: 10, padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                                background: '#f0f9ff', color: '#0369a1', border: '1.5px solid #bae6fd',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                              }}>
                              ↺ توزيع متساوي ({Math.floor(sTargetDoctors / sRepAreas.length)}-{Math.ceil(sTargetDoctors / sRepAreas.length)} لكل منطقة)
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <button onClick={loadSuggest} disabled={suggestLoading}
                      style={{ ...btnStyle('#7c3aed'), width: '100%', marginTop: 10 }}>
                      ✨ تطبيق وعرض الاقتراح
                    </button>
                  </div>
                  </div>
                )}
              </div>
            </div>

            {/* Voice input panel */}
            {(voiceListening || voiceParsing || voiceResults || voiceError) && (
              <div ref={voicePanelRef} style={{
                background: voiceListening ? 'linear-gradient(135deg, #fff7ed 0%, #fef3c7 100%)' : '#fff',
                border: `2px solid ${voiceListening ? '#f97316' : '#e2e8f0'}`,
                borderRadius: 14, padding: 16, marginBottom: 20,
                animation: voiceListening ? 'pulse-border 2s infinite' : 'none',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 20 }}>{voiceListening ? '🔴' : voiceParsing ? '⏳' : '🎤'}</span>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
                      {voiceListening ? 'جاري التسجيل... تحدث الآن'
                        : voiceParsing ? '⏳ جاري تحليل الكلام بالذكاء الاصطناعي...'
                        : 'نتائج التحليل'}
                    </h3>
                    {voiceListening && (
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', animation: 'blink 1s infinite' }} />
                    )}
                  </div>
                  {!voiceParsing && (
                    <button onClick={() => { stopVoice(); setVoiceResults(null); setVoiceError(null); }}
                      style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>×</button>
                  )}
                </div>

                {/* Listening indicator */}
                {voiceListening && (
                  <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
                    <div style={{ fontSize: 48, animation: 'pulse-mic 1.5s infinite' }}>🎙️</div>
                    <p style={{ margin: '8px 0 0', color: '#92400e', fontSize: 13, fontWeight: 600 }}>
                      تحدث... الاستماع مستمر حتى تضغط إيقاف
                    </p>
                  </div>
                )}

                {/* Parsing spinner */}
                {voiceParsing && !voiceListening && (
                  <div style={{ textAlign: 'center', padding: '20px 0' }}>
                    <div style={{ fontSize: 40, animation: 'pulse-mic 1s infinite' }}>🤖</div>
                    <p style={{ margin: '10px 0 0', color: '#6366f1', fontSize: 13, fontWeight: 600 }}>
                      جاري تحليل الكلام...
                    </p>
                  </div>
                )}

                {/* Error state */}
                {voiceError && !voiceParsing && (
                  <div style={{ textAlign: 'center', padding: '16px 0' }}>
                    <div style={{ fontSize: 36 }}>⚠️</div>
                    <p style={{ margin: '8px 0 12px', color: '#dc2626', fontSize: 13, fontWeight: 600 }}>{voiceError}</p>
                    <button onClick={() => setVoiceError(null)}
                      style={btnStyle('#94a3b8', true)}>إغلاق</button>
                  </div>
                )}

                {/* Editable parsed results */}
                {voiceResults && !voiceParsing && (
                  <div>
                    {voiceResults.length === 0 ? (
                      <p style={{ textAlign: 'center', color: '#94a3b8', padding: 12 }}>لم يتم التعرف على أي زيارات في الكلام</p>
                    ) : (() => {
                      const matchedList   = voiceResults.map((v, i) => ({ v, i })).filter(({ v }) => v.entryId !== null);
                      const unmatchedList = voiceResults.map((v, i) => ({ v, i })).filter(({ v }) => v.entryId === null);

                      const renderRow = ({ v, i }: { v: typeof voiceResults[0]; i: number }, isMatched: boolean) => {
                        const fbMeta = FEEDBACK_LABELS[v.feedback] ?? FEEDBACK_LABELS.pending;
                        const willAdd = !isMatched && voiceAddToPlan.has(i);
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
                            background: isMatched ? '#f0fdf4' : willAdd ? '#eff6ff' : '#fff7ed',
                            border: `1.5px solid ${isMatched ? '#86efac' : willAdd ? '#93c5fd' : '#fed7aa'}`,
                            borderRadius: 10, flexWrap: 'wrap',
                          }}>
                            <button onClick={() => setVoiceResults(prev => prev!.filter((_, idx) => idx !== i))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18, padding: 0, lineHeight: 1 }}
                              title="حذف">×</button>
                            <div style={{ flex: 1, minWidth: 140 }}>
                              {/* Doctor name — editable on click */}
                              {editingVoiceName === i ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <input
                                    autoFocus
                                    value={v.doctorName}
                                    onChange={e => setVoiceResults(prev => prev!.map((r, idx) => idx === i ? { ...r, doctorName: e.target.value } : r))}
                                    onKeyDown={e => { if (e.key === 'Escape') setEditingVoiceName(null); }}
                                    placeholder="اسم الطبيب"
                                    style={{
                                      fontWeight: 700, fontSize: 13, color: '#1e293b',
                                      border: '2px solid #6366f1',
                                      borderRadius: 6, padding: '3px 8px', background: '#fff',
                                      width: '100%', direction: 'rtl', outline: 'none',
                                    }}
                                  />
                                  {/* Dropdown: pick from plan doctors or leave unmatched */}
                                  <select
                                    value={v.entryId ?? ''}
                                    onChange={e => {
                                      const picked = e.target.value ? Number(e.target.value) : null;
                                      if (picked && activePlan) {
                                        const pe = activePlan.entries.find(en => en.id === picked);
                                        if (pe) {
                                          setVoiceResults(prev => prev!.map((r, idx) => idx === i
                                            ? { ...r, entryId: picked, doctorName: pe.doctor.name } : r));
                                        }
                                      } else {
                                        setVoiceResults(prev => prev!.map((r, idx) => idx === i ? { ...r, entryId: null } : r));
                                      }
                                      setEditingVoiceName(null);
                                    }}
                                    style={{
                                      padding: '3px 6px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca',
                                      cursor: 'pointer', direction: 'rtl',
                                    }}>
                                    <option value="">⚠️ غير موجود في البلان (طبيب جديد)</option>
                                    {activePlan?.entries.map(pe => (
                                      <option key={pe.id} value={pe.id}>✅ {pe.doctor.name}</option>
                                    ))}
                                  </select>
                                  <button onClick={() => setEditingVoiceName(null)}
                                    style={{ alignSelf: 'flex-end', fontSize: 11, padding: '2px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#64748b', cursor: 'pointer', fontWeight: 600 }}>
                                    ✓ تم
                                  </button>
                                </div>
                              ) : (
                                <p
                                  onClick={() => setEditingVoiceName(i)}
                                  title="اضغط لتعديل الاسم أو ربطه بطبيب في البلان"
                                  style={{ margin: 0, fontWeight: 700, fontSize: 13, color: isMatched ? '#166534' : '#92400e', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {isMatched ? '✅' : willAdd ? '➕' : '⚠️'} {v.doctorName}
                                  <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>✏️</span>
                                </p>
                              )}
                              {v.itemName && (
                                <p style={{ margin: '2px 0 0', fontSize: 11, color: '#6366f1' }}>💊 {v.itemName}</p>
                              )}
                            </div>
                            <select
                              value={v.feedback}
                              onChange={e => setVoiceResults(prev => prev!.map((r, idx) => idx === i ? { ...r, feedback: e.target.value } : r))}
                              style={{
                                padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                border: '1px solid #e2e8f0', background: fbMeta.bg, color: fbMeta.color, cursor: 'pointer',
                              }}>
                              {Object.entries(FEEDBACK_LABELS).map(([key, val]) => (
                                <option key={key} value={key}>{(val as any).label}</option>
                              ))}
                            </select>
                            <input
                              value={v.notes}
                              onChange={e => setVoiceResults(prev => prev!.map((r, idx) => idx === i ? { ...r, notes: e.target.value } : r))}
                              placeholder="ملاحظات"
                              style={{
                                padding: '4px 8px', borderRadius: 8, fontSize: 11, border: '1px solid #e2e8f0',
                                width: 110, direction: 'rtl', background: '#f8fafc',
                              }}
                            />
                          </div>
                        );
                      };

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                          {/* ── Matched doctors (in plan) ── */}
                          {matchedList.length > 0 && (
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 13, fontWeight: 800, color: '#166534' }}>✅ موجودين في البلان ({matchedList.length})</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {matchedList.map(item => renderRow(item, true))}
                              </div>
                            </div>
                          )}

                          {/* ── Unmatched doctors (NOT in plan) ── */}
                          {unmatchedList.length > 0 && (
                            <div style={{
                              background: '#fff7ed', border: '2px dashed #fb923c',
                              borderRadius: 12, padding: '10px 12px',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                                <span style={{ fontSize: 13, fontWeight: 800, color: '#c2410c' }}>
                                  ⚠️ غير موجودين في البلان ({unmatchedList.length})
                                </span>
                                <button
                                  onClick={() => setVoiceAddToPlan(prev => {
                                    const s = new Set(prev);
                                    unmatchedList.forEach(({ i }) => s.add(i));
                                    return s;
                                  })}
                                  style={{
                                    fontSize: 11, fontWeight: 800, padding: '4px 12px', borderRadius: 20,
                                    background: '#ea580c', color: '#fff', border: 'none', cursor: 'pointer',
                                  }}>
                                  ➕ اضافة الكل للبلان
                                </button>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {unmatchedList.map(item => {
                                  const willAdd = voiceAddToPlan.has(item.i);
                                  return (
                                    <div key={item.i}>
                                      {renderRow(item, false)}
                                      <div style={{
                                        display: 'flex', alignItems: 'center', gap: 8,
                                        padding: '6px 14px 8px',
                                        background: willAdd ? '#dbeafe' : '#fee2e2',
                                        borderRadius: '0 0 10px 10px',
                                        borderTop: `1px dashed ${willAdd ? '#93c5fd' : '#fca5a5'}`,
                                        marginTop: -2,
                                      }}>
                                        <input
                                          type="checkbox"
                                          id={`add-${item.i}`}
                                          checked={willAdd}
                                          onChange={e => setVoiceAddToPlan(prev => {
                                            const s = new Set(prev);
                                            e.target.checked ? s.add(item.i) : s.delete(item.i);
                                            return s;
                                          })}
                                          style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#2563eb' }}
                                        />
                                        <label htmlFor={`add-${item.i}`} style={{
                                          fontSize: 12, fontWeight: 800, cursor: 'pointer',
                                          color: willAdd ? '#1d4ed8' : '#b91c1c',
                                        }}>
                                          {willAdd ? '✅ سيتم إضافته للبلان وتسجيل الكول' : '❌ لن يُضاف — اضغط لإضافته للبلان'}
                                        </label>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()
                    }
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button onClick={() => { setVoiceResults(null); }}
                        style={btnStyle('#94a3b8', true)}>إلغاء</button>
                      <button onClick={submitVoiceVisits}
                        disabled={voiceSaving || (!voiceResults.some(v => v.entryId) && voiceAddToPlan.size === 0)}
                        style={{
                          ...btnStyle('#22c55e', true),
                          opacity: voiceSaving || (!voiceResults.some(v => v.entryId) && voiceAddToPlan.size === 0) ? 0.5 : 1,
                        }}>
                        {voiceSaving ? '⏳ جاري الحفظ...' : `✅ تأكيد وحفظ ${voiceResults.filter(v => v.entryId).length + voiceAddToPlan.size} زيارة`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Stats row */}
            {planStats && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
                {[
                  { label: 'إجمالي الزيارات', val: planStats.totalVisits, target: activePlan.targetCalls, color: '#3b82f6' },
                  { label: 'أطباء تمت زيارتهم', val: planStats.visitedOnce, target: activePlan.targetDoctors, color: '#10b981' },
                ].map(s => {
                  const pct = Math.min(100, Math.round((s.val / (s.target || 1)) * 100));
                  return (
                    <div key={s.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 }}>
                      <p style={{ margin: '0 0 4px', fontSize: 12, color: '#64748b' }}>{s.label}</p>
                      <p style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#1e293b' }}>{s.val}<span style={{ fontSize: 13, color: '#94a3b8' }}>/{s.target}</span></p>
                      <div style={{ background: '#f1f5f9', borderRadius: 4, height: 6 }}>
                        <div style={{ background: s.color, width: `${pct}%`, height: '100%', borderRadius: 4 }} />
                      </div>
                    </div>
                  );
                })}
                {/* Feedback breakdown */}
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, gridColumn: 'span 2' }}>
                  <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#64748b' }}>توزيع الفيدباك</p>

                {/* Item calls breakdown */}
                {planStats.itemCallStats.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, gridColumn: '1 / -1' }}>
                    <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: '#64748b' }}>📦 الكولات حسب الايتم</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {planStats.itemCallStats.map(item => (
                        <div key={item.name}>
                          <div
                            onClick={() => setOpenItemKey(k => k === item.name ? null : item.name)}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              background: '#f8fafc', borderRadius: 8, padding: '8px 12px',
                              cursor: 'pointer', border: '1px solid #e2e8f0',
                              userSelect: 'none',
                            }}
                          >
                            <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{item.name}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{
                                background: '#dbeafe', color: '#1e40af', fontWeight: 700, fontSize: 13,
                                padding: '2px 10px', borderRadius: 20,
                              }}>{item.count} كول</span>
                              <span style={{ fontSize: 11, color: '#94a3b8' }}>{openItemKey === item.name ? '▲' : '▼'}</span>
                            </div>
                          </div>
                          {openItemKey === item.name && (
                            <div style={{
                              background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '0 0 8px 8px',
                              padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6,
                            }}>
                              {item.doctors.map(d => (
                                <span
                                  key={d.entryId}
                                  onClick={() => scrollToEntry(d.entryId)}
                                  style={{
                                    fontSize: 12, padding: '3px 10px', borderRadius: 12,
                                    background: '#fff', border: '1px solid #7dd3fc',
                                    color: '#0369a1', cursor: 'pointer', fontWeight: 600,
                                  }}
                                >
                                  🩺 {d.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Object.entries(planStats.feedbackCount).map(([fb, cnt]) => {
                      const meta = FEEDBACK_LABELS[fb] ?? FEEDBACK_LABELS.pending;
                      return (
                        <span key={fb}
                          onClick={() => setFbPopup({ fb, label: meta.label, meta, doctors: planStats.feedbackDoctors[fb] ?? [] })}
                          style={{
                            padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                            background: meta.bg, color: meta.color,
                            cursor: 'pointer', userSelect: 'none',
                            border: '2px solid transparent',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = meta.color; (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent'; (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
                        >
                          {meta.label}: {cnt}
                        </span>
                      );
                    })}
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: 10, color: '#cbd5e1' }}>انقر على أي حالة لعرض أسماء الأطباء</p>
                </div>
              </div>
            )}

            {/* Smart suggestion panel */}
            {suggest && (() => {
              const allDocs = [
                ...suggest.keepDoctors.map(k => ({ ...k.doctor, _reason: k.reason, _type: 'keep' as const })),
                ...suggest.newDoctors .map(d => ({ ...d,         _reason: 'new',     _type: 'new'  as const })),
              ];
              const pending  = allDocs.filter(d => !selectedDoctors.has(d.id));
              const chosen   = allDocs.filter(d =>  selectedDoctors.has(d.id));
              return (
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 16, marginBottom: 20 }}>
                  <h3 style={{ margin: '0 0 10px', fontSize: 16, color: '#166534' }}>
                    ✨ الاقتراح الذكي — {suggest.summary.total} طبيب
                  </h3>

                  {/* AI Note summary */}
                  {suggest.aiNote && (
                    <div style={{
                      background: '#faf5ff', border: '1px solid #c4b5fd', borderRadius: 8,
                      padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#5b21b6',
                    }}>
                      <p style={{ margin: '0 0 3px', fontWeight: 700, fontSize: 12 }}>🤖 تعليماتك المطبّقة:</p>
                      <p style={{ margin: 0, color: '#6d28d9', lineHeight: 1.6 }}>
                        {suggest.aiNote.parsed?.summary ?? suggest.aiNote.raw}
                      </p>
                      {suggest.aiNote.parsed && (() => {
                        const p = suggest.aiNote.parsed!;
                        const chips: { label: string; color: string; bg: string }[] = [];
                        (p.includeDoctorNames ?? []).forEach(n => chips.push({ label: `+ ${n}`, color: '#166534', bg: '#dcfce7' }));
                        (p.excludeDoctorNames ?? []).forEach(n => chips.push({ label: `− ${n}`, color: '#991b1b', bg: '#fee2e2' }));
                        (p.includeAreaNames   ?? []).forEach(n => chips.push({ label: `📍 ${n}`, color: '#1e40af', bg: '#dbeafe' }));
                        (p.specialties        ?? []).forEach(n => chips.push({ label: `🔬 ${n}`, color: '#7c3aed', bg: '#ede9fe' }));
                        return chips.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            {chips.map((c, i) => (
                              <span key={i} style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.color }}>{c.label}</span>
                            ))}
                          </div>
                        ) : null;
                      })()}
                    </div>
                  )}

                  <p style={{ margin: '0 0 12px', fontSize: 13, color: '#15803d' }}>
                    انقر على الطبيب لاختياره، انقر مرة ثانية لإلغاء الاختيار
                  </p>

                  {/* Pending (not selected) */}
                  {pending.length > 0 && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#64748b' }}>
                          📋 المقترحون ({pending.length})
                        </p>
                        <button onClick={() => setSelectedDoctors(prev => {
                            const s = new Set(prev);
                            pending.forEach(d => s.add(d.id));
                            return s;
                          })}
                          style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
                            padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          ✅ اختيار الكل
                        </button>
                      </div>
                      <div className="mp-suggest-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, maxHeight: 240, overflowY: 'auto', marginBottom: 12 }}>
                        {pending.map(doc => {
                          const meta = FEEDBACK_LABELS[doc._reason] ?? FEEDBACK_LABELS.pending;
                          return (
                            <div key={doc.id} onClick={() => setSelectedDoctors(prev => { const s = new Set(prev); s.add(doc.id); return s; })}
                              style={{ border: `2px solid ${doc.fromWishList ? '#fde047' : '#e2e8f0'}`, borderRadius: 8, padding: 10, background: doc.fromWishList ? '#fffbeb' : '#fff', cursor: 'pointer',
                                transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <p style={{ margin: 0, fontWeight: 700, fontSize: 13 }}>{doc.name}</p>
                              <p style={{ margin: 0, fontSize: 11, color: '#64748b' }}>{doc.specialty ?? ''}{doc.area?.name ? ` · ${doc.area.name}` : ''}</p>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: meta.bg, color: meta.color, fontWeight: 600 }}>
                                  {doc.fromWishList ? '⭐ مطلوب' : doc._type === 'new' ? '➕ جديد' : meta.label}
                                </span>
                                <span style={{ fontSize: 11, color: '#94a3b8' }}>اضغط للاختيار</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* Chosen (selected) */}
                  {chosen.length > 0 && (
                    <>
                      <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: '#166534' }}>
                        ✅ المختارون ({chosen.length})
                      </p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                        {chosen.map(doc => (
                          <div key={doc.id} onClick={() => setSelectedDoctors(prev => { const s = new Set(prev); s.delete(doc.id); return s; })}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, background: doc.fromWishList ? '#fffbeb' : '#dcfce7', border: `2px solid ${doc.fromWishList ? '#fde047' : '#22c55e'}`,
                              borderRadius: 20, padding: '5px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: doc.fromWishList ? '#92400e' : '#166534' }}>
                            {doc.fromWishList && <span style={{ fontSize: 12 }}>⭐</span>}
                            {doc.name}
                            <span style={{ fontSize: 15, lineHeight: 1, color: '#dc2626', fontWeight: 700 }}>×</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 4, justifyContent: 'flex-end' }}>
                    <button onClick={() => setSuggest(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
                    <button onClick={applySuggestion} disabled={selectedDoctors.size === 0} style={{ ...btnStyle('#22c55e'), opacity: selectedDoctors.size === 0 ? 0.5 : 1 }}>
                      ✅ إضافة {selectedDoctors.size} طبيب للبلان
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Analytics summary card */}
            <div style={{ background: 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)', borderRadius: 14, padding: '16px 20px', marginBottom: 20, color: '#fff', display: 'flex', flexWrap: 'wrap', gap: 0 }}>
              <div style={{ flex: 1, minWidth: 140, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 16, marginLeft: 16 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, opacity: 0.8 }}>👤 المندوب العلمي</p>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{activePlan.scientificRep?.name ?? 'بدون مندوب'}</p>
              </div>
              <div style={{ flex: 1, minWidth: 120, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 16, marginLeft: 16 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, opacity: 0.8 }}>📅 الشهر</p>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{MONTHS_AR[activePlan.month - 1]} {activePlan.year}</p>
              </div>
              <div style={{ flex: 1, minWidth: 110, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 16, marginLeft: 16 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, opacity: 0.8 }}>👨‍⚕️ عدد الأطباء</p>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {activePlan.entries.length}/
                  {editingPlanField === 'targetDoctors' ? (
                    <>
                      <input
                        type="number" min={1} value={editPlanVal} autoFocus
                        onChange={e => setEditPlanVal(Number(e.target.value))}
                        onKeyDown={e => { if (e.key==='Enter') savePlanField('targetDoctors'); if (e.key==='Escape') setEditingPlanField(null); }}
                        style={{ width: 60, padding: '2px 5px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 14, textAlign: 'center' }}
                      />
                      <button onClick={() => savePlanField('targetDoctors')} style={{ background: 'rgba(255,255,255,0.25)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}>✓</button>
                      <button onClick={() => setEditingPlanField(null)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}>✕</button>
                    </>
                  ) : (
                    <span
                      title="انقر للتعديل"
                      onClick={() => { setEditingPlanField('targetDoctors'); setEditPlanVal(activePlan.targetDoctors); }}
                      style={{ cursor: 'pointer', borderBottom: '1px dashed rgba(255,255,255,0.5)', fontSize: 15 }}
                    >{activePlan.targetDoctors}</span>
                  )}
                </p>
              </div>
              <div style={{ flex: 1, minWidth: 110, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 16, marginLeft: 16 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, opacity: 0.8 }}>📞 إجمالي الكولات المستهدفة</p>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {activePlan.entries.reduce((s, e) => s + e.targetVisits, 0)}/
                  {editingPlanField === 'targetCalls' ? (
                    <>
                      <input
                        type="number" min={1} value={editPlanVal} autoFocus
                        onChange={e => setEditPlanVal(Number(e.target.value))}
                        onKeyDown={e => { if (e.key==='Enter') savePlanField('targetCalls'); if (e.key==='Escape') setEditingPlanField(null); }}
                        style={{ width: 60, padding: '2px 5px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 14, textAlign: 'center' }}
                      />
                      <button onClick={() => savePlanField('targetCalls')} style={{ background: 'rgba(255,255,255,0.25)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}>✓</button>
                      <button onClick={() => setEditingPlanField(null)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}>✕</button>
                    </>
                  ) : (
                    <span
                      title="انقر للتعديل"
                      onClick={() => { setEditingPlanField('targetCalls'); setEditPlanVal(activePlan.targetCalls); }}
                      style={{ cursor: 'pointer', borderBottom: '1px dashed rgba(255,255,255,0.5)', fontSize: 15 }}
                    >{activePlan.targetCalls}</span>
                  )}
                </p>
              </div>
              <div style={{ flex: 1, minWidth: 110, paddingLeft: 0 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, opacity: 0.8 }}>✅ كولات منجزة</p>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>
                  {planStats?.totalVisits ?? 0}
                  <span style={{ fontSize: 12, opacity: 0.7 }}> من {activePlan.entries.reduce((s,e)=>s+e.targetVisits,0)}</span>
                </p>
              </div>
            </div>

            {/* Search bar */}
            <div style={{ marginBottom: 12 }}>
              {(() => {
                const q = searchQuery.trim().toLowerCase();
                const suggestions = q.length >= 1
                  ? activePlan.entries
                      .map(e => e.doctor.name)
                      .filter(n => n.toLowerCase().includes(q) && n.toLowerCase() !== q)
                      .slice(0, 8)
                  : [];
                return (
                  <div style={{ position: 'relative' }}>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={e => { setSearchQuery(e.target.value); setSearchSuggestOpen(true); }}
                        onFocus={() => setSearchSuggestOpen(true)}
                        onBlur={() => setTimeout(() => setSearchSuggestOpen(false), 150)}
                        placeholder="🔍  ابحث باسم الطبيب، الصيدلية، الاختصاص، الايتم، المنطقة..."
                        style={{
                          flex: 1, padding: '10px 16px 10px 36px', border: '2px solid #e2e8f0',
                          borderRadius: searchSuggestOpen && suggestions.length > 0 ? '12px 12px 0 0' : 12,
                          fontSize: 14, direction: 'rtl', boxSizing: 'border-box',
                          outline: 'none', background: '#fff', color: '#1e293b',
                          transition: 'border-color 0.15s',
                        }}
                        onFocus={e => (e.target.style.borderColor = '#6366f1')}
                        onBlur={e => (e.target.style.borderColor = '#e2e8f0')}
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery('')}
                          style={{
                            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                            background: 'none', border: 'none', fontSize: 18, color: '#94a3b8',
                            cursor: 'pointer', lineHeight: 1, padding: 0,
                          }}>×</button>
                      )}
                    </div>
                    {/* Autocomplete dropdown */}
                    {searchSuggestOpen && suggestions.length > 0 && (
                      <div style={{
                        position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 400,
                        background: '#fff', border: '2px solid #6366f1', borderTop: 'none',
                        borderRadius: '0 0 12px 12px',
                        boxShadow: '0 6px 20px rgba(99,102,241,0.12)', overflow: 'hidden',
                      }}>
                        {suggestions.map(name => (
                          <div
                            key={name}
                            onMouseDown={() => { setSearchQuery(name); setSearchSuggestOpen(false); }}
                            style={{
                              padding: '9px 16px', fontSize: 13, fontWeight: 600,
                              color: '#1e293b', cursor: 'pointer', direction: 'rtl',
                              borderBottom: '1px solid #f1f5f9',
                              display: 'flex', alignItems: 'center', gap: 8,
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#eef2ff')}
                            onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                            <span style={{ color: '#6366f1', fontSize: 14 }}>👨‍⚕️</span>
                            {name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              {searchQuery && (
                <p style={{ margin: '5px 4px 0', fontSize: 12, color: '#6366f1', fontWeight: 700 }}>
                  {filteredEntries.length} نتيجة من أصل {activePlan.entries.length}
                </p>
              )}
            </div>

            {/* Visit status filter tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {([
                { key: 'all'         as const, label: '📋 الكل',         count: activePlan.entries.length,                                                              color: '#6366f1' },
                { key: 'done'        as const, label: '✅ تمت',           count: activePlan.entries.filter(e => e.visits.length >= e.targetVisits).length,            color: '#22c55e' },
                { key: 'not_done'    as const, label: '⏳ لم تتم',        count: activePlan.entries.filter(e => e.visits.length < e.targetVisits).length,             color: '#f59e0b' },
                { key: 'voice_added' as const, label: '🎤 خارج البلان',  count: activePlan.entries.filter(e => e.isExtraVisit).length,                               color: '#3b82f6' },
              ]).map(f => {
                const active = visitFilter === f.key;
                return (
                  <button key={f.key} onClick={() => setVisitFilter(f.key)} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 700,
                    cursor: 'pointer', border: `2px solid ${active ? f.color : '#e2e8f0'}`,
                    background: active ? f.color : '#fff',
                    color: active ? '#fff' : '#64748b',
                    transition: 'all 0.15s',
                  }}>
                    {f.label}
                    <span style={{
                      background: active ? 'rgba(255,255,255,0.25)' : '#f1f5f9',
                      color: active ? '#fff' : f.color,
                      borderRadius: 10, padding: '1px 8px', fontSize: 12, fontWeight: 800,
                    }}>{f.count}</span>
                  </button>
                );
              })}
            </div>

            {/* Selection toolbar */}
            {activePlan.entries.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap',
                direction: 'rtl',
              }}>
                <button
                  onClick={() => { setSelectMode(!selectMode); setSelectedEntries(new Set()); }}
                  style={{
                    padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    cursor: 'pointer',
                    border: selectMode ? '2px solid #ef4444' : '2px solid #e2e8f0',
                    background: selectMode ? '#fef2f2' : '#fff',
                    color: selectMode ? '#ef4444' : '#64748b',
                  }}>
                  {selectMode ? '✕ إلغاء التحديد' : '☑ وضع التحديد'}
                </button>
                {selectMode && (
                  <>
                    <button
                      onClick={() => {
                        if (selectedEntries.size === filteredEntries.length)
                          setSelectedEntries(new Set());
                        else
                          setSelectedEntries(new Set(filteredEntries.map(e => e.id)));
                      }}
                      style={{
                        padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                        cursor: 'pointer', border: '2px solid #6366f1', background: '#eff6ff', color: '#4338ca',
                      }}>
                      {selectedEntries.size === filteredEntries.length ? 'إلغاء تحديد الكل' : 'تحديد الكل'}
                    </button>
                    {selectedEntries.size > 0 && (
                      <button
                        onClick={() => bulkRemoveEntries()}
                        style={{
                          padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                          cursor: 'pointer', border: '2px solid #ef4444', background: '#ef4444', color: '#fff',
                        }}>
                        🗑 حذف المحدد ({selectedEntries.size})
                      </button>
                    )}
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                      {selectedEntries.size} / {filteredEntries.length} محدد
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Entries — card layout */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activePlan.entries.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8', background: '#fff', borderRadius: 12, border: '2px dashed #e2e8f0' }}>
                  <p style={{ fontSize: 32, margin: '0 0 8px' }}>👨‍⚕️</p>
                  <p style={{ margin: 0, fontSize: 15 }}>لا يوجد أطباء في هذا البلان</p>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#cbd5e1' }}>استخدم الاقتراح الذكي أعلاه أو أضف يدوياً</p>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8', background: '#fff', borderRadius: 12, border: '2px dashed #e2e8f0' }}>
                  <p style={{ fontSize: 32, margin: '0 0 8px' }}>
                    {visitFilter === 'done' ? '✅' : visitFilter === 'not_done' ? '⏳' : visitFilter === 'voice_added' ? '🎤' : '🔍'}
                  </p>
                  <p style={{ margin: 0, fontSize: 15 }}>
                    {visitFilter === 'done' ? 'لا توجد كولات مكتملة حتى الآن' :
                     visitFilter === 'not_done' ? 'جميع الكولات اكتملت! 🎉' :
                     visitFilter === 'voice_added' ? 'لا توجد زيارات خارج البلان' :
                     `لا توجد نتائج لـ "${searchQuery}"`}
                  </p>
                  {(visitFilter !== 'all' || searchQuery) && (
                    <button onClick={() => { setVisitFilter('all'); setSearchQuery(''); }}
                      style={{ ...btnStyle('#6366f1'), marginTop: 12 }}>عرض الكل</button>
                  )}
                </div>
              ) : filteredEntries.map((entry, idx) => {
                const visitCount = entry.visits.length;
                const pct = Math.min(100, Math.round((visitCount / (entry.targetVisits || 1)) * 100));
                const progressColor = pct >= 100 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#6366f1';
                const lastVisit = entry.visits[entry.visits.length - 1];
                const lastFb = FEEDBACK_LABELS[(lastVisit?.feedback ?? 'pending').split(',')[0]] ?? FEEDBACK_LABELS.pending;
                const isExpanded = expandedEntries.has(entry.id);
                const targetItemsList = entry.targetItems ?? [];

                return (
                  <div
                    key={entry.id}
                    id={`entry-${entry.id}`}
                    ref={el => { entryRefs.current[entry.id] = el; }}
                    style={{
                      background: voiceNewEntries.has(entry.id) ? '#eff6ff' : '#fff',
                      border: highlightEntryId === entry.id
                        ? '2px solid #6366f1'
                        : voiceNewEntries.has(entry.id)
                          ? '2px solid #3b82f6'
                          : '1px solid #e8edf2',
                      borderRadius: 14,
                      overflow: 'hidden',
                      boxShadow: highlightEntryId === entry.id
                        ? '0 0 0 4px #e0e7ff'
                        : voiceNewEntries.has(entry.id)
                          ? '0 0 0 3px #bfdbfe'
                          : '0 1px 4px rgba(0,0,0,0.04)',
                      transition: 'box-shadow 0.3s, border-color 0.3s',
                    }}>
                    {/* Compact Header — always visible */}
                    <div
                      className="mp-entry-header"
                      onClick={() => selectMode ? toggleSelect(entry.id) : toggleEntry(entry.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 0, padding: '10px 16px',
                        cursor: 'pointer', userSelect: 'none',
                        background: selectMode && selectedEntries.has(entry.id)
                          ? '#fef2f2'
                          : isExpanded
                            ? (voiceNewEntries.has(entry.id) ? '#dbeafe' : '#fafbfc')
                            : (voiceNewEntries.has(entry.id) ? '#eff6ff' : '#fff'),
                        borderBottom: isExpanded ? '1px solid #f1f5f9' : 'none',
                        transition: 'background 0.15s',
                      }}>
                      {/* Selection checkbox */}
                      {selectMode && (
                        <span style={{
                          width: 22, height: 22, borderRadius: 6, flexShrink: 0, marginLeft: 8,
                          border: selectedEntries.has(entry.id) ? '2px solid #ef4444' : '2px solid #cbd5e1',
                          background: selectedEntries.has(entry.id) ? '#ef4444' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#fff', fontSize: 13, fontWeight: 700, transition: 'all 0.15s',
                        }}>
                          {selectedEntries.has(entry.id) && '✓'}
                        </span>
                      )}
                      {/* Expand chevron */}
                      <span style={{
                        fontSize: 12, color: '#94a3b8', marginLeft: 8, flexShrink: 0,
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s', display: 'inline-block',
                      }}>▶</span>

                      {/* Index badge */}
                      <span style={{
                        minWidth: 26, height: 26, borderRadius: '50%',
                        background: '#e0e7ff', color: '#4338ca', fontSize: 11, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: 10, flexShrink: 0,
                      }}>{idx + 1}</span>

                      {/* Doctor name + specialty */}
                      <div className="mp-entry-name" style={{ flex: 1, minWidth: 0, marginLeft: 4 }}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: '#1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {entry.doctor.name}
                          {voiceNewEntries.has(entry.id) && (
                            <span style={{
                              marginRight: 6, fontSize: 10, fontWeight: 800,
                              background: '#2563eb', color: '#fff',
                              padding: '2px 8px', borderRadius: 20,
                              verticalAlign: 'middle',
                              boxShadow: '0 1px 4px rgba(37,99,235,0.4)',
                            }}>🎤 مضاف صوتياً</span>
                          )}
                          {entry.isExtraVisit && (
                            <span style={{
                              marginRight: 6, fontSize: 10, fontWeight: 800,
                              background: '#f59e0b', color: '#fff',
                              padding: '2px 8px', borderRadius: 20,
                              verticalAlign: 'middle',
                              boxShadow: '0 1px 4px rgba(245,158,11,0.4)',
                            }}>خارج البلان</span>
                          )}
                        </p>
                        <p style={{ margin: 0, fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                          {[entry.doctor.specialty, (entry.doctor as any).pharmacyName, entry.doctor.area?.name].filter(Boolean).join(' · ') || '—'}
                        </p>
                      </div>

                      {/* Compact indicators */}
                      <div className="mp-entry-indicators" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 8 }}>
                        {/* Target items indicator */}
                        {targetItemsList.length > 0 && (
                          <span
                            title={`الايتمات: ${targetItemsList.map(ti => ti.item.name).join('، ')}`}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 3,
                              padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                              background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe',
                              whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                            🎯 {targetItemsList.length === 1 ? targetItemsList[0].item.name : `${targetItemsList.length} ايتمات`}
                          </span>
                        )}

                        {/* Visit progress mini */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 56 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                            <span style={{ fontWeight: 800, fontSize: 15, color: progressColor }}>{visitCount}</span>
                            <span style={{ color: '#cbd5e1', fontSize: 12 }}>/{entry.targetVisits}</span>
                          </div>
                          <div style={{ width: 56, height: 3, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: progressColor, borderRadius: 2, transition: 'width 0.3s' }} />
                          </div>
                        </div>

                        {/* Last feedback badge */}
                        {lastVisit && (
                          <span style={{
                            padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                            background: lastFb.bg, color: lastFb.color, whiteSpace: 'nowrap', flexShrink: 0,
                          }}>
                            {lastFb.label}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Expandable Body */}
                    <div
                      onTransitionEnd={(e) => { if (e.propertyName === 'max-height' && isExpanded) setExpandAnimDone(prev => new Set(prev).add(entry.id)); }}
                      style={{
                        maxHeight: isExpanded ? '2000px' : '0',
                        overflow: (isExpanded && expandAnimDone.has(entry.id)) ? 'visible' : 'hidden',
                        transition: 'max-height 0.35s ease-in-out',
                      }}>
                      {/* Actions bar */}
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 16px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9',
                      }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          {/* Edit target visits */}
                          {editingEntry === entry.id ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ fontSize: 12, color: '#64748b' }}>هدف الزيارات:</span>
                              <input
                                type="number" min={1} max={50} value={editVisitsVal} autoFocus
                                onChange={e => setEditVisitsVal(+e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') saveEntryVisits(entry.id); if (e.key === 'Escape') setEditingEntry(null); }}
                                style={{ width: 50, padding: '2px 5px', border: `2px solid ${progressColor}`, borderRadius: 6, fontSize: 13, fontWeight: 700, textAlign: 'center' }}
                              />
                              <button onClick={() => saveEntryVisits(entry.id)} style={{ background: '#22c55e', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}>✓</button>
                              <button onClick={() => setEditingEntry(null)} style={{ background: '#e2e8f0', color: '#64748b', border: 'none', borderRadius: 4, padding: '2px 5px', fontSize: 11, cursor: 'pointer' }}>✕</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingEntry(entry.id); setEditVisitsVal(entry.targetVisits); }}
                              style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, padding: '3px 10px', fontSize: 11, color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                              ✏️ هدف: {entry.targetVisits} زيارات
                            </button>
                          )}
                          {/* Add visit button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setVisitFormEntry(entry.id);
                              setVDate(new Date().toISOString().split('T')[0]);
                              const targets = entry.targetItems ?? [];
                              setVItemId(targets.length === 1 ? String(targets[0].item.id) : '');
                            }}
                            style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                            + زيارة
                          </button>
                        </div>
                        {/* Remove button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}
                          title="إزالة من البلان"
                          style={{ background: 'none', border: '1px solid #fecaca', color: '#ef4444', cursor: 'pointer', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 600, flexShrink: 0 }}
                        >🗑 إزالة</button>
                      </div>

                      <div className="mp-entry-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, overflow: 'visible' }}>
                        {/* Left col: target items */}
                        <div style={{ padding: '10px 16px', borderLeft: '1px solid #f1f5f9', overflow: 'visible', position: 'relative' }}>
                          <div
                            onClick={() => setShowEntryItems(prev => {
                              const s = new Set(prev);
                              s.has(entry.id) ? s.delete(entry.id) : s.add(entry.id);
                              return s;
                            })}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none',
                              margin: '0 0 6px',
                            }}>
                            <span style={{
                              fontSize: 10, color: '#94a3b8',
                              transform: showEntryItems.has(entry.id) ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 0.2s', display: 'inline-block',
                            }}>▶</span>
                            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                              🎯 الايتمات المستهدفة
                              {targetItemsList.length > 0 && (
                                <span style={{ marginRight: 6, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 800, background: '#eff6ff', color: '#2563eb' }}>{targetItemsList.length}</span>
                              )}
                            </p>
                          </div>
                          <div style={{
                            maxHeight: showEntryItems.has(entry.id) ? '500px' : '0',
                            overflow: showEntryItems.has(entry.id) ? 'visible' : 'hidden',
                            transition: showEntryItems.has(entry.id) ? 'max-height 0.25s ease-in-out' : 'max-height 0.25s ease-in-out, overflow 0s 0.25s',
                          }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                            {targetItemsList.length === 0 && (
                              <span style={{ fontSize: 11, color: '#cbd5e1', fontStyle: 'italic' }}>لا يوجد</span>
                            )}
                            {targetItemsList.map(ti => (
                              <span key={ti.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' }}>
                                {ti.item.name}
                                <button
                                  onClick={() => removeEntryItem(entry.id, ti.item.id)}
                                  style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, fontWeight: 700, marginRight: -2 }}>×</button>
                              </span>
                            ))}
                            {/* Add item dropdown */}
                            <div style={{ position: 'relative' }}>
                              {entryItemMenuOpen === entry.id && itemMenuPos ? (
                                <>
                                <div onClick={() => { setEntryItemMenuOpen(null); setNewItemName(''); }} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
                                <div style={{ position: 'fixed', top: itemMenuPos.top, left: itemMenuPos.left, zIndex: 9999, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', minWidth: 240, maxHeight: 300, overflowY: 'auto', direction: 'rtl' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#374151' }}>اختر ايتم</p>
                                    <button onClick={() => { setEntryItemMenuOpen(null); setNewItemName(''); }} style={{ background: 'none', border: 'none', fontSize: 16, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 }}>×</button>
                                  </div>
                                  {/* Existing items list */}
                                  {items.filter(it => !targetItemsList.some(ti => ti.item.id === it.id)).length === 0 && items.length > 0 && (
                                    <p style={{ margin: '0 0 8px', fontSize: 12, color: '#94a3b8', padding: '4px 10px', textAlign: 'center' }}>تمت إضافة جميع الايتمات</p>
                                  )}
                                  {items.filter(it => !targetItemsList.some(ti => ti.item.id === it.id)).map(it => (
                                    <div key={it.id}
                                      onClick={() => !addingEntryItem && addEntryItem(entry.id, it.id)}
                                      style={{ padding: '7px 10px', borderRadius: 7, cursor: addingEntryItem ? 'wait' : 'pointer', fontSize: 13, color: '#1e293b', transition: 'background 0.1s' }}
                                      onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                      {it.name}
                                    </div>
                                  ))}
                                  {/* ── Create new item ── */}
                                  <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 6, paddingTop: 6 }}>
                                    <p style={{ margin: '0 0 5px', fontSize: 11, color: '#64748b', fontWeight: 600 }}>+ إنشاء ايتم جديد</p>
                                    <div style={{ display: 'flex', gap: 4 }}>
                                      <input
                                        value={newItemName}
                                        onChange={e => setNewItemName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') createAndAddItem(entry.id); }}
                                        placeholder="اسم الايتم..."
                                        disabled={addingEntryItem}
                                        style={{
                                          flex: 1, padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: 6,
                                          fontSize: 12, direction: 'rtl', outline: 'none',
                                          background: '#fafafa',
                                        }}
                                      />
                                      <button
                                        onClick={() => createAndAddItem(entry.id)}
                                        disabled={!newItemName.trim() || addingEntryItem}
                                        style={{
                                          background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6,
                                          padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                          opacity: !newItemName.trim() || addingEntryItem ? 0.5 : 1,
                                        }}>
                                        {addingEntryItem ? '...' : '✓'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                                </>
                              ) : (
                                <button onClick={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const spaceAbove = rect.top;
                                  const spaceBelow = window.innerHeight - rect.bottom;
                                  const menuH = Math.min(300, window.innerHeight * 0.4);
                                  if (spaceAbove > menuH || spaceAbove > spaceBelow) {
                                    setItemMenuPos({ top: rect.top - menuH - 4, left: rect.left });
                                  } else {
                                    setItemMenuPos({ top: rect.bottom + 4, left: rect.left });
                                  }
                                  setEntryItemMenuOpen(entry.id); setNewItemName('');
                                }}
                                  style={{ background: 'none', color: '#2563eb', border: '1px dashed #93c5fd', borderRadius: 20, padding: '3px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                                  + إضافة
                                </button>
                              )}
                            </div>
                            </div>
                          </div>
                        </div>

                        {/* Right col: actual visits */}
                        <div style={{ padding: '10px 16px' }}>
                          <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            📋 الزيارات الفعلية
                          </p>

                          {entry.visits.length === 0 && (
                            <p style={{ margin: 0, fontSize: 11, color: '#cbd5e1', fontStyle: 'italic' }}>لا توجد زيارات مسجلة</p>
                          )}

                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {entry.visits.map((v, vi) => {
                              const vfb = FEEDBACK_LABELS[(v.feedback ?? 'pending').split(',')[0]] ?? FEEDBACK_LABELS.pending;
                              const isEditingThis = editingVisitItem === v.id;
                              return (
                                <div key={v.id} style={{ background: '#f8fafc', borderRadius: 8, border: '1px solid #f1f5f9', overflow: 'hidden' }}>
                                  <div style={{
                                    display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto auto auto',
                                    alignItems: 'center', gap: 6,
                                    padding: '5px 10px',
                                  }}>
                                  {/* # */}
                                  <span style={{ fontSize: 10, fontWeight: 800, color: '#c7d2fe', background: '#eef2ff', borderRadius: 4, padding: '1px 5px' }}>#{vi + 1}</span>
                                  {/* Date */}
                                  <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
                                    {v.visitDate ? new Date(v.visitDate).toLocaleDateString('ar-IQ') : '—'}
                                  </span>
                                  {/* Item */}
                                  {isEditingThis ? (
                                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                      <select autoFocus value={editVisitItemVal} onChange={e => setEditVisitItemVal(e.target.value)}
                                        onKeyDown={e => { if (e.key==='Enter') saveVisitItem(v.id); if (e.key==='Escape') setEditingVisitItem(null); }}
                                        style={{ padding: '2px 6px', border: '2px solid #6366f1', borderRadius: 7, fontSize: 11, direction: 'rtl', flex: 1, minWidth: 0 }}>
                                        <option value="">— بدون</option>
                                        {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                                      </select>
                                      <button onClick={() => saveVisitItem(v.id)} style={{ background: '#22c55e', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}>✓</button>
                                      <button onClick={() => setEditingVisitItem(null)} style={{ background: '#e2e8f0', color: '#64748b', border: 'none', borderRadius: 4, padding: '2px 5px', fontSize: 11, cursor: 'pointer' }}>✕</button>
                                    </div>
                                  ) : (
                                    <span
                                      onClick={() => { setEditingVisitItem(v.id); setEditVisitItemVal(v.item ? String(v.item.id) : ''); }}
                                      title="اضغط لتعديل الايتم"
                                      style={{
                                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                        background: v.item ? '#eff6ff' : 'transparent',
                                        color: v.item ? '#2563eb' : '#cbd5e1',
                                        border: v.item ? '1px solid #bfdbfe' : '1px dashed #e2e8f0',
                                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130,
                                      }}>
                                      {v.item ? v.item.name : '+ ايتم'}
                                    </span>
                                  )}
                                  {/* Feedback */}
                                  <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: vfb.bg, color: vfb.color, whiteSpace: 'nowrap' }}>
                                    {vfb.label}
                                  </span>
                                  {/* Location */}
                                  {v.latitude && v.longitude ? (
                                    <a
                                      href={`https://www.google.com/maps?q=${v.latitude},${v.longitude}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title={`فتح الموقع على الخارطة\nخط: ${v.latitude.toFixed(5)}\nطول: ${v.longitude.toFixed(5)}`}
                                      style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        width: 22, height: 22, borderRadius: '50%',
                                        background: '#dcfce7', color: '#16a34a',
                                        fontSize: 13, textDecoration: 'none', flexShrink: 0,
                                        border: '1px solid #bbf7d0',
                                        transition: 'all 0.15s',
                                      }}
                                      onMouseEnter={e => { e.currentTarget.style.background = '#16a34a'; e.currentTarget.style.color = '#fff'; }}
                                      onMouseLeave={e => { e.currentTarget.style.background = '#dcfce7'; e.currentTarget.style.color = '#16a34a'; }}
                                    >📍</a>
                                  ) : (
                                    <span title="لا يوجد موقع مسجل" style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#e2e8f0', flexShrink: 0 }}>📍</span>
                                  )}
                                  {/* Like button — visible to all, clickable by managers only */}
                                  {(() => {
                                    const likeCount = (v.likes || []).length;
                                    const liked = !!(v.likes || []).find(l => l.userId === authUser?.id);
                                    return (
                                      <div style={{ position: 'relative', flexShrink: 0 }}>
                                        <button
                                          title={isManagerOrAdmin ? 'إعجاب — اضغط مطولاً لعرض المعجبين' : 'اضغط مطولاً لعرض المعجبين'}
                                          disabled={!isManagerOrAdmin || likingVisit === v.id}
                                          onClick={() => isManagerOrAdmin && toggleLike(v.id)}
                                          onMouseDown={() => { longPressTimer.current = setTimeout(() => setShowLikers(v.id), 600); }}
                                          onMouseUp={() => clearTimeout(longPressTimer.current)}
                                          onMouseLeave={() => clearTimeout(longPressTimer.current)}
                                          onTouchStart={() => { longPressTimer.current = setTimeout(() => setShowLikers(v.id), 600); }}
                                          onTouchEnd={() => clearTimeout(longPressTimer.current)}
                                          style={{
                                            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            width: 22, height: 22, borderRadius: '50%', padding: 0,
                                            background: 'transparent', border: 'none',
                                            cursor: isManagerOrAdmin ? 'pointer' : 'default', lineHeight: 1,
                                            transition: 'opacity 0.15s',
                                          }}>
                                          <svg viewBox="0 0 24 24" width="14" height="14" fill={likeCount > 0 ? '#ef4444' : 'none'} stroke={likeCount > 0 ? '#ef4444' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                          {likeCount > 0 && (
                                            <span style={{
                                              position: 'absolute', top: -5, right: -5,
                                              background: '#ef4444', color: '#fff',
                                              borderRadius: '50%', fontSize: 8, fontWeight: 800,
                                              width: 13, height: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                              lineHeight: 1, border: '1px solid #fff',
                                            }}>{likeCount}</span>
                                          )}
                                        </button>
                                        {/* Likers popup on long-press */}
                                        {showLikers === v.id && (
                                          <div
                                            style={{
                                              position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)',
                                              background: '#1e293b', color: '#fff', borderRadius: 8, padding: '6px 10px',
                                              fontSize: 11, whiteSpace: 'nowrap', zIndex: 99,
                                              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                                              minWidth: 100,
                                            }}
                                            onClick={e => { e.stopPropagation(); setShowLikers(null); }}
                                          >
                                            <div style={{ fontWeight: 700, marginBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: 3 }}>❤️ المعجبون</div>
                                            {(v.likes || []).length === 0
                                              ? <div style={{ color: '#94a3b8' }}>لا أحد بعد</div>
                                              : (v.likes || []).map(l => <div key={l.id}>👤 {l.user.username}</div>)
                                            }
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })()}
                                  {/* Delete */}
                                  <button onClick={() => deleteVisit(v.id)} title="حذف"
                                    style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>🗑</button>
                                </div>
                                {/* Notes + Manager Comments */}
                                {(v.notes || (v.comments && v.comments.length > 0) || isManagerOrAdmin) && (
                                  <div style={{ borderTop: '1px dashed #f1f5f9' }}>
                                    {/* Rep note */}
                                    {v.notes && (
                                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '4px 10px 3px' }}>
                                        <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, flexShrink: 0 }}>💬</span>
                                        <span style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', lineHeight: 1.4 }}>{v.notes}</span>
                                      </div>
                                    )}
                                    {/* Manager comments */}
                                    {(v.comments || []).map(c => (
                                      <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '3px 10px', background: '#fffbeb', borderTop: '1px dotted #fef3c7' }}>
                                        <span style={{ fontSize: 10, color: '#d97706', marginTop: 2, flexShrink: 0 }}>🔔</span>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e' }}>{c.user.username}: </span>
                                          <span style={{ fontSize: 11, color: '#78350f', lineHeight: 1.4 }}>{c.content}</span>
                                        </div>
                                        {c.userId === authUser?.id && (
                                          <button onClick={() => deleteComment(v.id, c.id)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 11, padding: 0, flexShrink: 0 }}>✕</button>
                                        )}
                                      </div>
                                    ))}
                                    {/* Add comment box for managers */}
                                    {isManagerOrAdmin && commentingVisit === v.id ? (
                                      <div style={{ display: 'flex', gap: 4, padding: '4px 10px 6px', alignItems: 'center' }}>
                                        <input
                                          autoFocus
                                          value={newCommentText}
                                          onChange={e => setNewCommentText(e.target.value)}
                                          onKeyDown={e => { if (e.key === 'Enter') submitComment(v.id); if (e.key === 'Escape') { setCommentingVisit(null); setNewCommentText(''); } }}
                                          placeholder="اكتب ملاحظتك..."
                                          style={{ flex: 1, border: '1px solid #fcd34d', borderRadius: 6, padding: '3px 8px', fontSize: 11, outline: 'none', direction: 'rtl' }}
                                        />
                                        <button onClick={() => submitComment(v.id)} disabled={savingComment || !newCommentText.trim()}
                                          style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', opacity: !newCommentText.trim() ? 0.5 : 1 }}>
                                          {savingComment ? '...' : '✓'}
                                        </button>
                                        <button onClick={() => { setCommentingVisit(null); setNewCommentText(''); }}
                                          style={{ background: '#e2e8f0', color: '#64748b', border: 'none', borderRadius: 6, padding: '3px 6px', fontSize: 11, cursor: 'pointer' }}>✕</button>
                                      </div>
                                    ) : isManagerOrAdmin ? (
                                      <button onClick={() => { setCommentingVisit(v.id); setNewCommentText(''); }}
                                        style={{ background: 'none', border: 'none', color: '#d97706', cursor: 'pointer', fontSize: 10, padding: '2px 10px 5px', fontWeight: 600 }}>
                                        + إضافة ملاحظة مدير
                                      </button>
                                    ) : null}
                                  </div>
                                )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Pharmacy Visits Section removed ── */}
          </>
        )}
      </div>

      {/* ── Import Plan Visits Modal ── */}
      {showImportModal && activePlan && (
        <div style={overlayStyle} onClick={() => !importing && setShowImportModal(false)}>
          <div style={{ ...modalStyle, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1e293b' }}>📥 استيراد تقارير من Excel</h2>
              <button onClick={() => !importing && setShowImportModal(false)}
                style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>

            {/* Plan info */}
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: '#166534', fontWeight: 700 }}>
                📅 {activePlan.scientificRep?.name ?? 'بدون مندوب'} — {MONTHS_AR[activePlan.month - 1]} {activePlan.year}
              </p>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#15803d' }}>
                {activePlan.entries.length} طبيب في البلان — الزيارات ستُطابق تلقائياً حسب اسم الطبيب
              </p>
            </div>

            {/* Format guide */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#374151' }}>📋 الحقول المعترف بها (يُقبل أي اسم مشابه):</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[
                  { name: 'اسم الطبيب *', hint: 'doctor / الطبيب / اسم …', required: true },
                  { name: 'تاريخ الزيارة', hint: 'date / تاريخ …', required: false },
                  { name: 'الايتم', hint: 'item / دواء / منتج …', required: false },
                  { name: 'الفيدباك', hint: 'feedback / نتيجة / حالة …', required: false },
                  { name: 'ملاحظات', hint: 'notes / تعليق …', required: false },
                ].map(col => (
                  <span key={col.name} title={col.hint} style={{
                    padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: col.required ? '#fef3c7' : '#f1f5f9',
                    color: col.required ? '#92400e' : '#475569',
                    border: `1px solid ${col.required ? '#fde68a' : '#e2e8f0'}`,
                    cursor: 'help',
                  }}>
                    {col.name}
                  </span>
                ))}
              </div>
              <p style={{ margin: '8px 0 0', fontSize: 11, color: '#94a3b8' }}>
                ترتيب الأعمدة غير مهم · التسمية بالعربي أو الإنجليزي مقبولة · التاريخ بأي تنسيق
              </p>
            </div>

            {/* Actions */}
            {!importResult ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => e.target.files?.[0] && importPlanVisits(e.target.files[0])} />
                <button onClick={downloadTemplate}
                  style={{ ...btnStyle('#6366f1'), flex: 1 }}>
                  ⬇️ تحميل قالب Excel
                </button>
                <button onClick={() => importFileRef.current?.click()} disabled={importing}
                  style={{ ...btnStyle('#10b981'), flex: 1 }}>
                  {importing ? '⏳ جاري الاستيراد...' : '📤 رفع ملف Excel'}
                </button>
              </div>
            ) : (
              <div>
                {/* Success summary */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                    <p style={{ margin: '0 0 4px', fontSize: 11, color: '#166534' }}>✅ تم استيراده</p>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#16a34a' }}>{importResult.imported}</p>
                  </div>
                  <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                    <p style={{ margin: '0 0 4px', fontSize: 11, color: '#92400e' }}>⚠️ أخطاء</p>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#ea580c' }}>{importResult.errors.length}</p>
                  </div>
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                    <p style={{ margin: '0 0 4px', fontSize: 11, color: '#64748b' }}>📊 إجمالي الصفوف</p>
                    <p style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#374151' }}>{importResult.total}</p>
                  </div>
                </div>

                {/* Unmatched doctors */}
                {importResult.unmatched.length > 0 && (
                  <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#92400e' }}>
                      ⚠️ أطباء غير موجودين في البلان ({importResult.unmatched.length}):
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {importResult.unmatched.map((name, i) => (
                        <span key={i} style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 8, padding: '3px 10px', fontSize: 12 }}>
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Errors detail */}
                {importResult.errors.length > 0 && (
                  <div style={{ maxHeight: 140, overflowY: 'auto', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 10, padding: 10, marginBottom: 12 }}>
                    <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: '#9f1239' }}>تفاصيل الأخطاء:</p>
                    {importResult.errors.map((e, i) => (
                      <p key={i} style={{ margin: '2px 0', fontSize: 11, color: '#be123c' }}>
                        صف {e.row}: {e.error}
                      </p>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setImportResult(null); }} style={btnStyle('#6366f1')}>
                    📤 رفع ملف آخر
                  </button>
                  <button onClick={() => setShowImportModal(false)} style={btnStyle('#10b981')}>
                    ✓ تم
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Import plan entries (doctors) from Excel modal ── */}
      {showPlanImportModal && activePlan && (
        <div style={overlayStyle} onClick={() => !planImporting && setShowPlanImportModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 480, width: '94%', direction: 'rtl', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1e293b' }}>📥 استيراد البلان من Excel</h2>
              <button onClick={() => !planImporting && setShowPlanImportModal(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>×</button>
            </div>

            {/* Format guide */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#374151' }}>📋 أعمدة الملف (يُقبل أي اسم مشابه):</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[
                  { name: 'اسم الطبيب *', hint: 'doctor / الطبيب / اسم', required: true },
                  { name: 'عدد الزيارات', hint: 'visits / زيارات (افتراضي: 2)', required: false },
                ].map(col => (
                  <span key={col.name} title={col.hint} style={{
                    padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: col.required ? '#fef3c7' : '#f1f5f9',
                    color: col.required ? '#92400e' : '#475569',
                    border: `1px solid ${col.required ? '#fde68a' : '#e2e8f0'}`,
                    cursor: 'help',
                  }}>
                    {col.name}
                  </span>
                ))}
              </div>
            </div>

            {!planImportResult ? (
              <div>
                <input ref={planImportFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) importPlanEntries(f); }} />
                <button onClick={() => planImportFileRef.current?.click()} disabled={planImporting}
                  style={{ ...btnStyle('#16a34a', true), width: '100%', justifyContent: 'center', gap: 8, opacity: planImporting ? 0.6 : 1 }}>
                  {planImporting ? '⏳ جاري الاستيراد...' : '📂 اختيار ملف Excel'}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: 14, marginBottom: 12 }}>
                  <p style={{ margin: '0 0 4px', fontWeight: 700, color: '#166534' }}>
                    ✅ تم استيراد {planImportResult.imported} من أصل {planImportResult.total} طبيب
                  </p>
                </div>
                {planImportResult.unmatched.length > 0 && (
                  <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: 14, marginBottom: 12 }}>
                    <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#9a3412', fontSize: 13 }}>
                      ⚠️ لم يُعثر على {planImportResult.unmatched.length} طبيب:
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {planImportResult.unmatched.map((n, i) => (
                        <span key={i} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontWeight: 600 }}>{n}</span>
                      ))}
                    </div>
                  </div>
                )}
                <button onClick={() => { setPlanImportResult(null); setShowPlanImportModal(false); }}
                  style={{ ...btnStyle('#475569', true), width: '100%', justifyContent: 'center' }}>
                  إغلاق
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Visit modal ── */}
      {visitFormEntry !== null && (() => {
        const entry = activePlan?.entries.find(e => e.id === visitFormEntry);
        return (
          <div style={overlayStyle} onClick={() => setVisitFormEntry(null)}>
            <div style={{ ...modalStyle, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
                  📋 تسجيل زيارة
                </h2>
                {entry && <p style={{ margin: 0, fontSize: 13, color: '#6366f1', fontWeight: 600 }}>{entry.doctor.name}</p>}
                <button onClick={() => setVisitFormEntry(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <label style={labelStyle}>
                  التاريخ
                  <input type="date" value={vDate} onChange={e => setVDate(e.target.value)}
                    style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  الايتم
                  <select value={vItemId} onChange={e => setVItemId(e.target.value)}
                    style={inputStyle}>
                    <option value="">— بدون ايتم</option>
                    {entry && (entry.targetItems ?? []).length > 0 && (
                      <optgroup label="ايتمات البلان">
                        {(entry.targetItems ?? []).map(ti => <option key={ti.item.id} value={ti.item.id}>{ti.item.name}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="كل الايتمات">
                      {items.filter(it => !entry || !(entry.targetItems ?? []).some(ti => ti.item.id === it.id))
                        .map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </optgroup>
                  </select>
                </label>
              </div>

              <label style={{ ...labelStyle, marginBottom: 12 }}>
                نتيجة الزيارة (فيدباك)
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {Object.entries(FEEDBACK_LABELS).map(([k, meta]) => (
                    <span key={k} onClick={() => setVFeedback(k)}
                      style={{
                        padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                        cursor: 'pointer', userSelect: 'none',
                        background: vFeedback === k ? meta.bg : '#f8fafc',
                        color: vFeedback === k ? meta.color : '#94a3b8',
                        border: `2px solid ${vFeedback === k ? meta.color : '#e2e8f0'}`,
                        transition: 'all 0.1s',
                      }}>{meta.label}</span>
                  ))}
                </div>
              </label>

              <label style={{ ...labelStyle, marginBottom: 12 }}>
                ملاحظات (اختياري)
                <input type="text" value={vNotes} onChange={e => setVNotes(e.target.value)}
                  placeholder="أي تفاصيل إضافية..."
                  style={inputStyle} />
              </label>

              {/* Location status */}
              <div style={{ marginBottom: 14 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                  borderRadius: 8,
                  background: visitLocStatus === 'ok' ? '#f0fdf4' : visitLocStatus === 'denied' ? '#fff7ed' : '#f8fafc',
                  border: `1px solid ${visitLocStatus === 'ok' ? '#86efac' : visitLocStatus === 'denied' ? '#fed7aa' : '#e2e8f0'}`,
                  fontSize: 12, color: visitLocStatus === 'ok' ? '#166534' : visitLocStatus === 'denied' ? '#92400e' : '#64748b',
                }}>
                  <span style={{ fontSize: 16 }}>
                    {visitLocStatus === 'getting' ? '⏳' : visitLocStatus === 'ok' ? '📍' : visitLocStatus === 'denied' ? '⚠️' : '📍'}
                  </span>
                  <span style={{ fontWeight: 600, flex: 1 }}>
                    {visitLocStatus === 'getting' ? 'جاري تحديد الموقع...' :
                     visitLocStatus === 'ok'      ? `✓ تم تحديد الموقع (${visitLocation!.lat.toFixed(5)}, ${visitLocation!.lng.toFixed(5)})` :
                     visitLocStatus === 'denied'  ? 'تعذّر تحديد الموقع تلقائياً' :
                     'جاري تحديد الموقع...'}
                  </span>
                  {visitLocStatus === 'denied' && (
                    <>
                      <button onClick={() => {
                        setVisitLocStatus('getting');
                        setShowManualLoc(false);
                        getLocation().then(loc => { if (loc) { setVisitLocation(loc); setVisitLocStatus('ok'); setShowManualLoc(false); } else { setVisitLocStatus('denied'); } });
                      }} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #fed7aa', background: '#fff7ed', color: '#92400e', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        🔄 إعادة
                      </button>
                      <button onClick={() => setShowManualLoc(p => !p)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        ✏️ إدخال يدوي
                      </button>
                    </>
                  )}
                  {visitLocStatus === 'ok' && (
                    <button onClick={() => { setVisitLocation(null); setVisitLocStatus('denied'); setShowManualLoc(false); }} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534', cursor: 'pointer' }}>
                      ✕
                    </button>
                  )}
                </div>

                {/* Manual coordinate entry */}
                {visitLocStatus === 'denied' && showManualLoc && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: '#eff6ff', borderRadius: 8, border: '1px solid #bfdbfe' }}>
                    <div style={{ fontSize: 11, color: '#1e40af', marginBottom: 6, fontWeight: 600 }}>
                      📌 أدخل الإحداثيات يدوياً (من خرائط Google أو GPS الهاتف)
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="number" step="any"
                        placeholder="خط العرض (Lat) مثال: 33.3152"
                        value={manualLat}
                        onChange={e => setManualLat(e.target.value)}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 12 }}
                      />
                      <input
                        type="number" step="any"
                        placeholder="خط الطول (Lng) مثال: 44.3661"
                        value={manualLng}
                        onChange={e => setManualLng(e.target.value)}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 12 }}
                      />
                      <button
                        onClick={() => {
                          const lat = parseFloat(manualLat);
                          const lng = parseFloat(manualLng);
                          if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                            alert('أدخل إحداثيات صحيحة');
                            return;
                          }
                          setVisitLocation({ lat, lng });
                          setVisitLocStatus('ok');
                          setShowManualLoc(false);
                        }}
                        style={{ padding: '5px 12px', borderRadius: 6, background: '#1d4ed8', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
                      >
                        ✓ تأكيد
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 5 }}>
                      💡 افتح Google Maps → اضغط على موقعك → ستظهر الإحداثيات في الأسفل
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setVisitFormEntry(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
                <button onClick={submitVisit} disabled={savingVisit} style={btnStyle('#3b82f6')}>
                  {savingVisit ? 'جاري الحفظ...' : '✓ حفظ الزيارة'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Create plan modal ── */}
      {showCreate && (
        <div style={overlayStyle} onClick={() => setShowCreate(false)}>
          <div style={modalStyle} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>📅 إنشاء بلان شهري جديد</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {isManagerOrAdmin ? (
                <label style={{ ...labelStyle, gridColumn: 'span 3' }}>
                  المندوب العلمي <span style={{ fontSize: 11, color: '#94a3b8' }}>(اختياري)</span>
                  <select value={cRepId} onChange={e => setCRepId(e.target.value)} style={inputStyle}>
                    <option value="">-- بدون مندوب --</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
              ) : (
                <label style={{ ...labelStyle, gridColumn: 'span 3' }}>
                  المندوب العلمي
                  <div style={{ ...inputStyle, background: '#f1f5f9', color: '#374151', display: 'flex', alignItems: 'center', cursor: 'default' }}>
                    {reps.find(r => r.id === authUser?.linkedRepId)?.name ?? `مندوب #${authUser?.linkedRepId}`}
                  </div>
                </label>
              )}
              {/* Area selection */}
              {isManagerOrAdmin && (
                <div style={{ gridColumn: 'span 3' }}>
                  <label style={labelStyle}>
                    المناطق {!cRepId && <span style={{ color: '#ef4444', fontSize: 12 }}>*</span>}
                  </label>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <button onClick={() => setCAreaIds(allAreas.map(a => a.id))} type="button"
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', cursor: 'pointer', fontWeight: 600 }}>
                      ✓ الكل
                    </button>
                    <button onClick={() => setCAreaIds([])} type="button"
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#64748b', cursor: 'pointer', fontWeight: 600 }}>
                      ✗ إلغاء
                    </button>
                  </div>
                  <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid #e2e8f0', borderRadius: 8, padding: 8 }}>
                    {allAreas.map(a => (
                      <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '4px 6px', borderRadius: 6, background: cAreaIds.includes(a.id) ? '#eff6ff' : 'transparent' }}>
                        <input type="checkbox" checked={cAreaIds.includes(a.id)}
                          onChange={e => setCAreaIds(e.target.checked ? [...cAreaIds, a.id] : cAreaIds.filter(x => x !== a.id))} />
                        {a.name}
                      </label>
                    ))}
                    {allAreas.length === 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>لا توجد مناطق</span>}
                  </div>
                </div>
              )}
              <label style={labelStyle}>
                الشهر
                <select value={cMonth} onChange={e => setCMonth(+e.target.value)} style={inputStyle}>
                  {MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </label>
              <label style={labelStyle}>
                السنة
                <input type="number" value={cYear} onChange={e => setCYear(+e.target.value)} style={inputStyle} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowCreate(false)} style={btnStyle('#94a3b8')}>إلغاء</button>
              <button onClick={createPlan} disabled={creating} style={btnStyle('#3b82f6')}>
                {creating ? 'جاري الإنشاء...' : 'إنشاء البلان'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Feedback doctors popup ── */}
      {fbPopup && (
        <div style={overlayStyle} onClick={() => setFbPopup(null)}>
          <div style={{ ...modalStyle, maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  padding: '4px 14px', borderRadius: 12, fontSize: 14, fontWeight: 700,
                  background: fbPopup.meta.bg, color: fbPopup.meta.color,
                }}>
                  {fbPopup.label}
                </span>
                <span style={{ fontSize: 14, color: '#64748b', fontWeight: 600 }}>
                  {fbPopup.doctors.length} طبيب
                </span>
              </div>
              <button onClick={() => setFbPopup(null)}
                style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>

              {fbPopup.doctors.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#94a3b8', padding: '20px 0' }}>لا يوجد أطباء</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}>
                {fbPopup.doctors.map((doc, i) => (
                  <div key={i}
                    onClick={() => scrollToEntry(doc.entryId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', borderRadius: 8,
                      background: fbPopup.meta.bg + '55',
                      border: `1px solid ${fbPopup.meta.bg}`,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = fbPopup.meta.bg; (e.currentTarget as HTMLElement).style.transform = 'translateX(-3px)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = fbPopup.meta.bg + '55'; (e.currentTarget as HTMLElement).style.transform = 'translateX(0)'; }}
                  >
                    <span style={{
                      minWidth: 24, height: 24, borderRadius: '50%',
                      background: fbPopup.meta.bg, color: fbPopup.meta.color,
                      fontSize: 11, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>{i + 1}</span>
                    <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', flex: 1 }}>{doc.name}</span>
                    <span style={{ fontSize: 11, color: fbPopup.meta.color, opacity: 0.7 }}>انتقل ←</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setFbPopup(null)} style={btnStyle('#64748b')}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transfer Plan Modal ── */}
      {transferPlan && (
        <div style={overlayStyle} onClick={() => setTransferPlan(null)}>
          <div style={{ ...modalStyle, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>📤 تحويل البلان إلى مندوب</h2>
              <button onClick={() => setTransferPlan(null)}
                style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 14, color: '#475569' }}>
              البلان: <strong>{transferPlan.scientificRep?.name ?? 'بدون مندوب'}</strong> — {MONTHS_AR[transferPlan.month - 1]} {transferPlan.year}
            </p>
            {repUsers.length === 0 ? (
              <p style={{ color: '#ef4444', fontSize: 13, background: '#fee2e2', borderRadius: 8, padding: '10px 14px' }}>
                ⚠️ لا يوجد حساب مندوب مرتبط بهذا المندوب العلمي. قم بربط حساب مستخدم بالمندوب أولاً من صفحة المستخدمين.
              </p>
            ) : (
              <label style={labelStyle}>
                اختر حساب المندوب
                <select style={inputStyle} value={transferTarget}
                  onChange={e => setTransferTarget(e.target.value === '' ? '' : parseInt(e.target.value))}>
                  <option value="">— اختر —</option>
                  {repUsers.map(u => <option key={u.id} value={u.id}>👤 {u.username}</option>)}
                </select>
              </label>
            )}
            {transferError && (
              <p style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{transferError}</p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setTransferPlan(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
              {repUsers.length > 0 && (
                <button onClick={doTransfer} disabled={transferring || !transferTarget} style={btnStyle('#0369a1')}>
                  {transferring ? '⏳...' : '📤 تحويل'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Rep Areas Modal (company_manager) ── */}
      {repAreasModal && (
        <div style={overlayStyle} onClick={() => setRepAreasModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '90%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', direction: 'rtl' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>📍 مناطق {repAreasModal.repName}</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14, marginTop: 0 }}>
              حدد المناطق المسموح بها لاقتراح البلان. إذا لم تختر أي منطقة يشمل جميع المناطق.
            </p>
            {repAreasLoading ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8' }}>⏳ جاري التحميل...</div>
            ) : repAllAreas.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8' }}>لا توجد مناطق متاحة</div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {repAllAreas.map(area => (
                  <label key={area.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                    borderRadius: 8, cursor: 'pointer',
                    background: repSelectedAreaIds.has(area.id) ? '#eef2ff' : '#f8fafc',
                    border: `1px solid ${repSelectedAreaIds.has(area.id) ? '#c7d2fe' : '#e2e8f0'}`,
                  }}>
                    <input type="checkbox" checked={repSelectedAreaIds.has(area.id)}
                      onChange={e => {
                        setRepSelectedAreaIds(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(area.id); else next.delete(area.id);
                          return next;
                        });
                      }}
                      style={{ width: 16, height: 16, accentColor: '#6366f1' }}
                    />
                    <span style={{ fontSize: 14 }}>📍 {area.name}</span>
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setRepAreasModal(null)} style={btnStyle('#94a3b8')}>إلغاء</button>
              <button onClick={saveRepAreas} disabled={repAreasSaving} style={btnStyle('#6366f1')}>
                {repAreasSaving ? '⏳...' : '💾 حفظ المناطق'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const btnStyle = (bg: string, small = false) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 9,
  padding: small ? '6px 14px' : '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: small ? 13 : 14,
  boxShadow: '0 1px 4px rgba(0,0,0,0.16)', transition: 'opacity 0.15s',
});
const btnSmall = (bg: string) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12,
});
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box', direction: 'rtl',
};
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: '#374151' };
const settingLabelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 };
const settingInputStyle: React.CSSProperties = { padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, direction: 'rtl', width: '100%', boxSizing: 'border-box' as const };
const alertStyle: React.CSSProperties = { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 12 };
const menuItemStyle: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 12px', border: 'none', background: 'none', borderRadius: 7,
  fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151',
  textAlign: 'right' as const, direction: 'rtl',
  transition: 'background 0.12s',
};
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalStyle: React.CSSProperties   = { background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 480, direction: 'rtl' };
