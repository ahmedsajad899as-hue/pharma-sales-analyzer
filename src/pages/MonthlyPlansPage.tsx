import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
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
  area?: NamedItem; targetItem?: NamedItem;
}
interface DoctorVisit { id: number; feedback: string; visitDate: string; notes?: string | null; item?: { id: number; name: string } | null; }
interface PlanEntry {
  id: number; doctorId: number; targetVisits: number;
  doctor: Doctor; visits: DoctorVisit[];
  targetItems?: { id: number; item: NamedItem }[];
}
interface Plan {
  id: number; scientificRepId: number; month: number; year: number;
  targetCalls: number; targetDoctors: number; status: string; notes?: string;
  allowExtraVisits: boolean;
  scientificRep: NamedItem; entries: PlanEntry[];
}
interface SuggestResult {
  keepDoctors: { doctor: Doctor; reason: string }[];
  newDoctors:  Doctor[];
  summary: { keep: number; replace: number; new: number; total: number };
}

const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FEEDBACK_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  writing:      { label: 'يكتب',       color: '#166534', bg: '#dcfce7' },
  stocked:      { label: 'نزل الايتم', color: '#1e40af', bg: '#dbeafe' },
  interested:   { label: 'مهتم',       color: '#7c3aed', bg: '#ede9fe' },
  not_interested:{ label: 'غير مهتم',  color: '#991b1b', bg: '#fee2e2' },
  unavailable:  { label: 'غير متوفر',  color: '#92400e', bg: '#fef3c7' },
  pending:      { label: 'معلق',       color: '#475569', bg: '#f1f5f9' },
};

export default function MonthlyPlansPage() {
  const { token } = useAuth();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [plans, setPlans]         = useState<Plan[]>([]);
  const [reps, setReps]           = useState<ScientificRep[]>([]);
  const [items, setItems]         = useState<NamedItem[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  // Active plan view
  const [activePlan, setActivePlan] = useState<Plan | null>(null);

  // Create plan
  const [showCreate, setShowCreate] = useState(false);
  const [cRepId, setCRepId]     = useState('');
  const [cMonth, setCMonth]     = useState(new Date().getMonth() + 1);
  const [cYear,  setCYear]      = useState(new Date().getFullYear());
  const [creating, setCreating] = useState(false);

  // Smart suggest
  const [suggest, setSuggest]       = useState<SuggestResult | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [selectedDoctors, setSelectedDoctors] = useState<Set<number>>(new Set());

  // Suggest settings
  const [showSuggestSettings, setShowSuggestSettings] = useState(false);
  const [sTargetDoctors, setSTargetDoctors] = useState(75);
  const [sTargetVisits,  setSTargetVisits]  = useState(2);
  const [sKeepFeedback, setSKeepFeedback]   = useState<string[]>(['writing', 'stocked', 'interested']);
  const [sRestrictAreas, setSRestrictAreas] = useState(true);
  const [sSortBy, setSSortBy]               = useState<'oldest' | 'newest' | 'random'>('oldest');

  // Upload visits
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ imported: number; errors: any[] } | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  // Edit visit item inline
  const [editingVisitItem, setEditingVisitItem] = useState<number | null>(null); // visitId
  const [editVisitItemVal, setEditVisitItemVal] = useState<string>('');

  // Manage entry target items (ايتمات البلان لكل طبيب)
  const [entryItemMenuOpen, setEntryItemMenuOpen] = useState<number | null>(null); // entryId
  const [showEntryItems, setShowEntryItems] = useState<Set<number>>(new Set()); // entryIds with items visible
  const [addingEntryItem, setAddingEntryItem]     = useState(false);

  // Add visit form
  const [visitFormEntry, setVisitFormEntry] = useState<number | null>(null); // entryId
  const [vDate,     setVDate]     = useState('');
  const [vItemId,   setVItemId]   = useState('');
  const [vFeedback, setVFeedback] = useState('pending');
  const [vNotes,    setVNotes]    = useState('');
  const [savingVisit, setSavingVisit] = useState(false);

  // Filter
  const [filterRep, setFilterRep] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
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
  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const audioChunksRef      = useRef<Blob[]>([]);
  const silenceTimerRef     = useRef<any>(null);
  const voicePanelRef       = useRef<HTMLDivElement | null>(null);
  const recordingStartRef   = useRef<number>(0); // timestamp when recording started
  // keep legacy refs so voice-result UI still works
  const wantListeningRef = useRef(false);
  const recognitionRef   = useRef<any>(null);

  // Import visits Excel for active plan
  const importFileRef = useRef<HTMLInputElement>(null);
  const [showImportModal, setShowImportModal]   = useState(false);
  const [importing, setImporting]               = useState(false);
  const [importResult, setImportResult]         = useState<{ imported: number; total: number; errors: { row: number; error: string }[]; unmatched: string[] } | null>(null);

  // Feedback doctors popup
  const [fbPopup, setFbPopup] = useState<{ fb: string; label: string; meta: { color: string; bg: string }; doctors: { name: string; entryId: number }[] } | null>(null);

  // Scroll-to-entry highlight
  const entryRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [highlightEntryId, setHighlightEntryId] = useState<number | null>(null);

  // Collapsible entries
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const toggleEntry = (entryId: number) => setExpandedEntries(prev => {
    const s = new Set(prev);
    s.has(entryId) ? s.delete(entryId) : s.add(entryId);
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

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const h = H();
      const [pl, re] = await Promise.all([
        fetch(`${API}/api/monthly-plans`,   { headers: h }),
        fetch(`${API}/api/scientific-reps`, { headers: h }),
      ]);
      const plJson = await pl.json();
      const reJson = await re.json();
      if (!pl.ok) throw new Error(plJson.error ?? `خطأ ${pl.status}`);
      if (!re.ok) throw new Error(reJson.error ?? `خطأ ${re.status}`);
      setPlans(Array.isArray(plJson) ? plJson : (Array.isArray(plJson?.data) ? plJson.data : []));
      setReps(Array.isArray(reJson) ? reJson : (Array.isArray(reJson?.data) ? reJson.data : []));
      // جلب الايتمات بشكل مستقل - لا تأثر على تحميل البلانات إذا فشل
      fetch(`${API}/api/items`, { headers: h })
        .then(r => r.json())
        .then(j => setItems(Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : [])))
        .catch(() => {});
    } catch (e: any) { setError(e.message ?? 'خطأ في التحميل'); }
    finally { setLoading(false); }
  }, [H]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (voiceResults !== null || voiceParsing || voiceError) {
      setTimeout(() => voicePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [voiceResults, voiceParsing, voiceError]);
  useEffect(() => { preloadAudio(voiceStartSrc); preloadAudio(voiceStopSrc); }, []);

  // Reload a single plan
  const reloadPlan = async (id: number) => {
    const r = await fetch(`${API}/api/monthly-plans/${id}`, { headers: H() });
    const j: Plan = await r.json();
    setActivePlan(j);
    setPlans(prev => prev.map(p => p.id === id ? j : p));
  };

  // Create new plan
  const createPlan = async () => {
    if (!cRepId) { alert('اختر المندوب العلمي'); return; }
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/monthly-plans`, {
        method: 'POST', headers: H(),
        body: JSON.stringify({ scientificRepId: cRepId, month: cMonth, year: cYear }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'فشل الإنشاء');
      await load();
      setShowCreate(false);
    } catch (e: any) { alert(e.message); }
    finally { setCreating(false); }
  };

  // Smart suggest
  const loadSuggest = async () => {
    if (!activePlan) return;
    setSuggestLoading(true); setSuggest(null); setShowSuggestSettings(false);
    try {
      const p = new URLSearchParams({
        scientificRepId:  String(activePlan.scientificRepId),
        month:            String(activePlan.month),
        year:             String(activePlan.year),
        targetDoctors:    String(sTargetDoctors),
        keepFeedback:     sKeepFeedback.join(','),
        restrictToAreas:  String(sRestrictAreas),
        sortBy:           sSortBy,
      });
      const r = await fetch(`${API}/api/monthly-plans/suggest?${p}`, { headers: H() });
      const j: SuggestResult = await r.json();
      setSuggest(j);
      setSelectedDoctors(new Set(j.keepDoctors.map(k => k.doctor.id)));
    } catch (e: any) { alert(e.message); }
    finally { setSuggestLoading(false); }
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
          visitDate: vDate || new Date().toISOString().split('T')[0],
          itemId:    resolvedItemId || null,
          feedback:  vFeedback,
          notes:     vNotes,
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
      await load();
    } catch (e: any) { alert(e.message); }
    finally { setUploading(false); }
  };

  const clearUpload = () => {
    setUploadResult(null);
    setUploadedFileName(null);
    if (fileRef.current) fileRef.current.value = '';
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
    let success = 0, skipped = 0;
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

      const visitDate = v.date || new Date().toISOString().split('T')[0];
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
          }),
        });
        if (r.ok) success++;
      } catch {}
    }
    setVoiceSaving(false);
    setVoiceResults(null);
    setVoiceAddToPlan(new Set());
    setVoiceNewEntries(newEntryIds);
    await reloadPlan(activePlan.id);
    const msg = skipped > 0
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
    a.download = `template_${activePlan.scientificRep.name}_${activePlan.month}_${activePlan.year}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Computed stats for active plan ──────────────────────────
  const planStats = activePlan ? (() => {
    const totalVisits  = activePlan.entries.reduce((s, e) => s + e.visits.length, 0);
    const visitedOnce  = activePlan.entries.filter(e => e.visits.length > 0).length;
    const feedbackCount: Record<string, number> = {};
    const feedbackDoctors: Record<string, { name: string; entryId: number }[]> = {};
    activePlan.entries.forEach(e => e.visits.forEach(v => {
      feedbackCount[v.feedback] = (feedbackCount[v.feedback] ?? 0) + 1;
      if (!feedbackDoctors[v.feedback]) feedbackDoctors[v.feedback] = [];
      if (!feedbackDoctors[v.feedback].some(d => d.entryId === e.id))
        feedbackDoctors[v.feedback].push({ name: e.doctor.name, entryId: e.id });
    }));
    return { totalVisits, visitedOnce, feedbackCount, feedbackDoctors };
  })() : null;

  const filteredPlans = filterRep === 'all' ? plans : plans.filter(p => String(p.scientificRepId) === filterRep);

  const filteredEntries = activePlan ? (() => {
    let entries = activePlan.entries;
    if (visitFilter === 'done')        entries = entries.filter(e => e.visits.length >= e.targetVisits);
    if (visitFilter === 'not_done')    entries = entries.filter(e => e.visits.length < e.targetVisits);
    if (visitFilter === 'voice_added') entries = entries.filter(e => voiceNewEntries.has(e.id));
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
  })() : [];

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
      <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap' }}>📅 البلانات الشهرية</h2>

        <select value={filterRep} onChange={e => setFilterRep(e.target.value)}
          style={{ ...inputStyle, width: 'auto', minWidth: 140 }}>
          <option value="all">كل المندوبين</option>
          {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>

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
                {p.scientificRep.name} · {MONTHS_AR[p.month - 1]} {p.year} ({p.entries.length} طبيب | {totalV}/{p.targetCalls} زيارة)
              </option>
            );
          })}
        </select>

        <button onClick={() => setShowCreate(true)} style={btnStyle('#3b82f6', true)}>+ جديد</button>

        {/* Upload visits */}
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && uploadVisits(e.target.files[0])} />
        {!uploadedFileName ? (
          <button onClick={() => fileRef.current?.click()} disabled={uploading} style={btnStyle('#10b981', true)}>
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
                    <div key={p.id} onClick={() => { setActivePlan(p); setSearchQuery(''); setVisitFilter('all'); }}
                      style={{ background: '#fff', border: '2px solid #e2e8f0', borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(59,130,246,0.15)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.boxShadow = 'none'; }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: '#1e293b' }}>
                        {p.scientificRep.name}
                      </p>
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Plan header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <button onClick={() => { setActivePlan(null); setSearchQuery(''); setVisitFilter('all'); }}
                    style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#475569' }}>
                    ← الرجوع
                  </button>
                  <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
                    {activePlan.scientificRep.name} — {MONTHS_AR[activePlan.month - 1]} {activePlan.year}
                  </h1>
                </div>
                <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 14 }}>
                  {activePlan.entries.length} طبيب · الهدف: {activePlan.targetDoctors} طبيب × {activePlan.targetCalls / (activePlan.targetDoctors || 1) | 0} زيارات
                </p>
              </div>
              <div style={{ position: 'relative', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {/* Import visits button */}
                <button onClick={() => { setShowImportModal(true); setImportResult(null); }}
                  style={btnStyle('#10b981')}>
                  📥 استيراد تقارير Excel
                </button>

                {/* Voice input button */}
                <button
                  onClick={() => {
                    if (voiceListening) { stopVoice(); }
                    else { startVoice(); }
                  }}
                  style={{
                    ...btnStyle(voiceListening ? '#ef4444' : '#f97316'),
                    animation: voiceListening ? 'pulse-mic 1.5s infinite' : 'none',
                  }}>
                  {voiceListening ? '⏹ إيقاف التسجيل' : '🎤 إدخال صوتي'}
                </button>

                <button onClick={loadSuggest} disabled={suggestLoading} style={btnStyle('#8b5cf6')}>
                  {suggestLoading ? '⏳ جاري...' : '✨ اقتراح ذكي'}
                </button>
                <button onClick={() => setShowSuggestSettings(v => !v)}
                  title="إعدادات الاقتراح الذكي"
                  style={{ ...btnStyle('#8b5cf6'), padding: '8px 10px', borderRight: '1px solid rgba(255,255,255,0.3)' }}>
                  ⚙️
                </button>

                {/* Allow extra visits toggle */}
                <button
                  onClick={toggleAllowExtraVisits}
                  title="السماح بإدخال كولات أطباء خارج البلان وحساب تقاريرهم"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 14px',
                    background: activePlan.allowExtraVisits ? '#f0fdf4' : '#f8fafc',
                    border: `2px solid ${activePlan.allowExtraVisits ? '#22c55e' : '#e2e8f0'}`,
                    borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                    color: activePlan.allowExtraVisits ? '#166534' : '#64748b',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    width: 36, height: 20, borderRadius: 10, position: 'relative', flexShrink: 0,
                    background: activePlan.allowExtraVisits ? '#22c55e' : '#cbd5e1',
                    transition: 'background 0.2s',
                  }}>
                    <div style={{
                      position: 'absolute', top: 3, width: 14, height: 14, borderRadius: '50%',
                      background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      left: activePlan.allowExtraVisits ? 18 : 3, transition: 'left 0.2s',
                    }} />
                  </div>
                  كولات خارج البلان
                </button>

                {/* Settings dropdown */}
                {showSuggestSettings && (
                  <div style={{
                    position: 'absolute', top: '110%', left: 0, zIndex: 200,
                    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
                    padding: 20, width: 340, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', direction: 'rtl',
                  }}>
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

                    {/* Restrict to rep areas */}
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

                    <button onClick={loadSuggest} disabled={suggestLoading}
                      style={{ ...btnStyle('#8b5cf6'), width: '100%', marginTop: 10 }}>
                      ✨ تطبيق وعرض الاقتراح
                    </button>
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
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {voiceResults.map((v, i) => {
                          const fbMeta = FEEDBACK_LABELS[v.feedback] ?? FEEDBACK_LABELS.pending;
                          const matched = v.entryId !== null;
                          const willAdd = !matched && voiceAddToPlan.has(i);
                          return (
                            <div key={i} style={{
                              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
                              background: matched ? '#f0fdf4' : willAdd ? '#eff6ff' : '#fef2f2',
                              border: `1px solid ${matched ? '#bbf7d0' : willAdd ? '#bfdbfe' : '#fecaca'}`,
                              borderRadius: 10, flexWrap: 'wrap',
                            }}>
                              <button onClick={() => setVoiceResults(prev => prev!.filter((_, idx) => idx !== i))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16, padding: 0, marginTop: 2 }}
                                title="حذف">×</button>
                              <div style={{ flex: 1, minWidth: 120 }}>
                                <p style={{ margin: 0, fontWeight: 700, fontSize: 13, color: '#1e293b' }}>
                                  {matched ? '✅' : willAdd ? '➕' : '⚠️'} {v.doctorName}
                                </p>
                                {v.itemName && (
                                  <p style={{ margin: '2px 0 0', fontSize: 11, color: '#6366f1' }}>💊 {v.itemName}</p>
                                )}
                                {!matched && (
                                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={willAdd}
                                      onChange={e => setVoiceAddToPlan(prev => {
                                        const s = new Set(prev);
                                        e.target.checked ? s.add(i) : s.delete(i);
                                        return s;
                                      })}
                                    />
                                    <span style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700 }}>أضف للبلان وسجّل الكول</span>
                                  </label>
                                )}
                              </div>
                              <select
                                value={v.feedback}
                                onChange={e => setVoiceResults(prev => prev!.map((r, idx) => idx === i ? { ...r, feedback: e.target.value } : r))}
                                style={{
                                  padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                  border: '1px solid #e2e8f0', background: fbMeta.bg, color: fbMeta.color,
                                  cursor: 'pointer',
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
                                  width: 120, direction: 'rtl', background: '#f8fafc',
                                }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
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
                              style={{ border: '2px solid #e2e8f0', borderRadius: 8, padding: 10, background: '#fff', cursor: 'pointer',
                                transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <p style={{ margin: 0, fontWeight: 700, fontSize: 13 }}>{doc.name}</p>
                              <p style={{ margin: 0, fontSize: 11, color: '#64748b' }}>{doc.specialty ?? ''}{doc.area?.name ? ` · ${doc.area.name}` : ''}</p>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: meta.bg, color: meta.color, fontWeight: 600 }}>
                                  {doc._type === 'new' ? '➕ جديد' : meta.label}
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
                            style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dcfce7', border: '2px solid #22c55e',
                              borderRadius: 20, padding: '5px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#166534' }}>
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
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{activePlan.scientificRep.name}</p>
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
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="🔍  ابحث باسم الطبيب، الصيدلية، الاختصاص، الايتم، المنطقة..."
                  style={{
                    flex: 1, padding: '10px 16px 10px 36px', border: '2px solid #e2e8f0',
                    borderRadius: 12, fontSize: 14, direction: 'rtl', boxSizing: 'border-box',
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
                { key: 'voice_added' as const, label: '🎤 خارج البلان',  count: voiceNewEntries.size,                                                                  color: '#3b82f6' },
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
                     visitFilter === 'voice_added' ? 'لم يتم إضافة أي طبيب من خارج البلان صوتياً في هذه الجلسة' :
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
                const lastFb = FEEDBACK_LABELS[lastVisit?.feedback ?? 'pending'];
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
                      onClick={() => toggleEntry(entry.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 0, padding: '10px 16px',
                        cursor: 'pointer', userSelect: 'none',
                        background: isExpanded
                          ? (voiceNewEntries.has(entry.id) ? '#dbeafe' : '#fafbfc')
                          : (voiceNewEntries.has(entry.id) ? '#eff6ff' : '#fff'),
                        borderBottom: isExpanded ? '1px solid #f1f5f9' : 'none',
                        transition: 'background 0.15s',
                      }}>
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
                    <div style={{
                      maxHeight: isExpanded ? '2000px' : '0',
                      overflow: 'hidden',
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
                              {entryItemMenuOpen === entry.id ? (
                                <div style={{ position: 'absolute', bottom: '110%', left: 0, zIndex: 9999, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', minWidth: 220, maxHeight: 220, overflowY: 'auto', direction: 'rtl' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#374151' }}>اختر ايتم</p>
                                    <button onClick={() => setEntryItemMenuOpen(null)} style={{ background: 'none', border: 'none', fontSize: 16, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 }}>×</button>
                                  </div>
                                  {items.filter(it => !targetItemsList.some(ti => ti.item.id === it.id)).length === 0 ? (
                                    <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', padding: '4px 10px', textAlign: 'center' }}>تمت إضافة جميع الايتمات</p>
                                  ) : items.filter(it => !targetItemsList.some(ti => ti.item.id === it.id)).map(it => (
                                    <div key={it.id}
                                      onClick={() => !addingEntryItem && addEntryItem(entry.id, it.id)}
                                      style={{ padding: '7px 10px', borderRadius: 7, cursor: addingEntryItem ? 'wait' : 'pointer', fontSize: 13, color: '#1e293b', transition: 'background 0.1s' }}
                                      onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                      {it.name}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <button onClick={() => setEntryItemMenuOpen(entry.id)}
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
                              const vfb = FEEDBACK_LABELS[v.feedback ?? 'pending'];
                              const isEditingThis = editingVisitItem === v.id;
                              return (
                                <div key={v.id} style={{ background: '#f8fafc', borderRadius: 8, border: '1px solid #f1f5f9', overflow: 'hidden' }}>
                                  <div style={{
                                    display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto',
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
                                  {/* Delete */}
                                  <button onClick={() => deleteVisit(v.id)} title="حذف"
                                    style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>🗑</button>
                                </div>
                                {/* Notes */}
                                {v.notes && (
                                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '3px 10px 6px', borderTop: '1px dashed #f1f5f9' }}>
                                    <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, flexShrink: 0 }}>💬</span>
                                    <span style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', lineHeight: 1.4 }}>{v.notes}</span>
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
                📅 {activePlan.scientificRep.name} — {MONTHS_AR[activePlan.month - 1]} {activePlan.year}
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

              <label style={{ ...labelStyle, marginBottom: 16 }}>
                ملاحظات (اختياري)
                <input type="text" value={vNotes} onChange={e => setVNotes(e.target.value)}
                  placeholder="أي تفاصيل إضافية..."
                  style={inputStyle} />
              </label>

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
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>📅 إنشاء بلان شهري جديد</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <label style={{ ...labelStyle, gridColumn: 'span 3' }}>
                المندوب العلمي *
                <select value={cRepId} onChange={e => setCRepId(e.target.value)} style={inputStyle}>
                  <option value="">-- اختر مندوب --</option>
                  {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
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
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const btnStyle = (bg: string, small = false) => ({
  background: bg, color: '#fff', border: 'none', borderRadius: 8,
  padding: small ? '6px 14px' : '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: small ? 13 : 14,
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
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalStyle: React.CSSProperties   = { background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 480, direction: 'rtl' };
