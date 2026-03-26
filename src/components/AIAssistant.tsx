import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import type { PageId } from '../App';

interface Props {
  activePage: PageId;
  navigateTo: (page: PageId) => void;
}

interface VisitRow {
  date: string;
  repName: string;
  doctorName: string;
  specialty: string;
  areaName: string;
  itemName: string;
  feedback: string;
  notes: string;
  isDouble: boolean;
}

interface PharmacyVisitRow {
  date: string;
  pharmacyName: string;
  areaName: string;
  repName: string;
  itemNames: string[];
  notes: string;
  isDouble: boolean;
}

interface GroupRow {
  groupKey: string;
  count: number;
  visits: (VisitRow | PharmacyVisitRow)[];
}

interface DoctorListRow {
  name: string;
  specialty: string;
  areaName: string;
  phone: string;
  pharmacyName?: string;
}

interface QueryResult {
  found: boolean;
  message?: string;
  type?: 'visits_list' | 'grouped_visits' | 'doctor_list' | 'unvisited_doctors'
       | 'invoices_list' | 'invoices_grouped'
       | 'sales_list' | 'sales_grouped'
       | 'returns_list'
       | 'survey_list' | 'survey_grouped'
       | 'stats_summary'
       | 'plan_stats';
  visitType?: 'doctor' | 'pharmacy' | 'all';
  groupBy?: string;
  totalVisits?: number;
  doctorVisits?: number;
  pharmacyVisits?: number;
  totalDoctors?: number;
  allVisited?: boolean;
  groups?: any[];
  visits?: (VisitRow | PharmacyVisitRow)[];
  doctors?: DoctorListRow[];
  // stats
  topAreas?: { key: string; count: number }[];
  topItems?: { key: string; count: number }[];
  topReps?: { key: string; count: number }[];
  feedbackBreakdown?: { key: string; count: number }[];
  breakdown?: { key: string; count: number }[];
  // invoices
  summary?: any;
  invoices?: any[];
  // sales
  items?: any[];
  // returns
  records?: any[];
  // survey
  pharmacies?: any[];
  // plan stats
  month?: number;
  year?: number;
  repName?: string | null;
  visitedDoctors?: number;
  doctorCoveragePct?: number;
  totalTargetVisits?: number;
  totalActualVisits?: number;
  completionPct?: number;
  byArea?: { name: string; targetDoctors: number; visitedDoctors: number; targetVisits: number; actualVisits: number; pct: number }[];
  byItem?: { name: string; targetDoctors: number; visitedDoctors: number; pct: number }[];
  filteredAreaName?: string | null;
  filteredItemName?: string | null;
}

interface AssistantResult {
  action: string;
  navigatePage?: string | null;
  pageAction?: string | null;
  pageActionParam?: any;
  params?: { page?: string };
  responseText: string;
  needsClarification: boolean;
  question?: string;
  queryResult?: QueryResult | null;
}

const API = import.meta.env.VITE_API_URL || '';

const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function fmtDate(d: string) {
  const dt = new Date(d);
  return `${dt.getDate()} ${MONTHS_AR[dt.getMonth()]} ${dt.getFullYear()}`;
}

const FEEDBACK_COLORS: Record<string, string> = {
  'يكتب ✍️':            '#dcfce7',
  'يوجد كومبتتر ⚔️':  '#ede9fe',
  'مهتم 👍':           '#fef9c3',
  'غير مهتم 👎': '#fee2e2',
  'متابعة وتذكير 🔔': '#fff7ed',
  'بانتظار الفيدباك ⏳': '#e0f2fe',
};

interface HistoryEntry {
  text: string;
  result: AssistantResult;
}

export default function AIAssistant({ activePage, navigateTo }: Props) {
  const { token, user } = useAuth();

  const [isOpen,       setIsOpen]       = useState(false);
  const [isRecording,  setIsRecording]  = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript,   setTranscript]   = useState('');
  const [textInput,    setTextInput]    = useState('');
  const [result,       setResult]       = useState<AssistantResult | null>(null);
  const [error,        setError]        = useState('');
  const [clarInput,    setClarInput]    = useState('');
  const [history,      setHistory]      = useState<HistoryEntry[]>([]);
  const [showHistory,  setShowHistory]  = useState(false);
  const [btnPos,       setBtnPos]       = useState({ right: 24, bottom: 88 });

  const mediaRecRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const streamRef    = useRef<MediaStream | null>(null);
  const startTimeRef = useRef<number>(0);
  const panelRef     = useRef<HTMLDivElement>(null);
  const btnRef       = useRef<HTMLButtonElement>(null);
  const dragRef      = useRef<{ sx: number; sy: number; br: number; bb: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (isRecording || isProcessing) return; // don't close while recording or processing
      const target = e.target as Node;
      if (
        panelRef.current && !panelRef.current.contains(target) &&
        btnRef.current   && !btnRef.current.contains(target)
      ) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, isRecording, isProcessing]);

  const reset = () => {
    setResult(null); setError(''); setTranscript(''); setTextInput(''); setClarInput('');
  };

  const sendToBackend = useCallback(async (fd: FormData) => {
    setIsProcessing(true);
    setError('');
    try {
      fd.append('context', JSON.stringify({ currentPage: activePage, userRole: user?.role ?? 'user' }));
      const r = await fetch(`${API}/api/ai-assistant/command`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const json = await r.json();
      if (!json.success) throw new Error(json.error || 'خطأ غير معروف');
      const data: AssistantResult = json.data;
      setResult(data);
      // Save to history — works for both text and voice
      // For voice: transcript is "🎤 رسالة صوتية", upgrade to responseText after we get the reply
      const typedText = (fd.get('text') as string | null)?.trim();
      const historyLabel = typedText || (fd.get('audio') ? `🎤 ${data.responseText}` : '') || transcript.trim();
      if (historyLabel) {
        setHistory(prev => [{ text: historyLabel, result: data }, ...prev].slice(0, 20));
      }
      // Auto-navigate only when no deep results to show
      if (data.navigatePage && !data.needsClarification && !data.queryResult) {
        const page = data.navigatePage as PageId;
        const valid: PageId[] = ['dashboard','upload','representatives','scientific-reps','doctors','monthly-plans','reports','users','rep-analysis'];
        if (valid.includes(page)) { navigateTo(page); setIsOpen(false); }
      }
      // Dispatch page-level actions via CustomEvent
      if (data.pageAction) {
        const pageMap: Record<string, PageId> = {
          'open-suggest-settings': 'monthly-plans',
          'open-new-plan':         'monthly-plans',
          'open-import-visits':    'monthly-plans',
          'open-plan':             'monthly-plans',
          'open-add-doctor':       'doctors',
          'open-import-doctors':   'doctors',
          'open-coverage':         'doctors',
          'open-wish-list':        'doctors',
          'open-wish-list-area':   'doctors',
          'open-doctors-area':     'doctors',
          'open-add-sci-rep':      'scientific-reps',
          'open-add-rep':          'representatives',
          'open-add-user':         'users',
          'open-call-log':         'dashboard',
          'open-voice-call':       'dashboard',
          'fill-visit-form':       'dashboard',
          'fill-pharmacy-visit':   'dashboard',
          'open-map':              'dashboard',
          'open-export-report':    'reports',
        };
        const targetPage = pageMap[data.pageAction];
        const detail = { action: data.pageAction, param: data.pageActionParam ?? null };
        const fire = () => window.dispatchEvent(new CustomEvent('ai-page-action', { detail }));

        if (targetPage && activePage !== targetPage) {
          // Store the pending action so the page can pick it up when it mounts
          (window as any).__aiPendingAction = detail;
          navigateTo(targetPage);
          // Fallback: if the page somehow missed picking it up, fire after 800ms
          setTimeout(() => {
            if ((window as any).__aiPendingAction) {
              (window as any).__aiPendingAction = null;
              fire();
            }
          }, 800);
        } else {
          fire();
        }
        // Close the assistant panel so the user can see the result/page
        setIsOpen(false);
      }
    } catch (e: any) {
      setError(e.message || 'حدث خطأ');
    } finally {
      setIsProcessing(false);
    }
  }, [activePage, token, navigateTo]);

  const startRecording = async () => {
    reset();
    setError('');
    setIsRecording(true); // show overlay immediately on button click

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('الميكروفون غير متاح — يجب فتح التطبيق عبر HTTPS أو من localhost');
      setIsRecording(false);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'لم يُسمح بالوصول للميكروفون'
          : `خطأ في الميكروفون: ${err?.message ?? err}`,
      );
      setIsRecording(false);
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    // Detect best supported MIME safely
    let mime = '';
    const candidateMimes = [
      'audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2','audio/mp4',
    ];
    try { mime = candidateMimes.find(t => MediaRecorder.isTypeSupported(t)) ?? ''; } catch { /* ignore */ }

    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      try { rec = new MediaRecorder(stream); } catch (e2: any) {
        stream.getTracks().forEach(t => t.stop());
        setError(`لا يدعم هذا الجهاز التسجيل: ${e2?.message ?? ''}`);
        setIsRecording(false);
        return;
      }
    }

    mediaRecRef.current = rec;
    startTimeRef.current = Date.now();

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    rec.onerror = (e: any) => {
      setError(`خطأ في التسجيل: ${e?.error?.message ?? 'unknown'}`);
      setIsRecording(false);
      stream.getTracks().forEach(t => t.stop());
    };

    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);

      const finalMime = rec.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: finalMime });
      const dur = (Date.now() - startTimeRef.current) / 1000;

      if (blob.size < 300 || dur < 1.0) {
        setError('التسجيل قصير جداً — حاول مجدداً');
        return;
      }

      const ext = finalMime.split('/')[1]?.split(';')[0]?.replace('mpeg', 'mp3') ?? 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `assistant-voice.${ext}`);
      setTranscript('🎤 رسالة صوتية');
      await sendToBackend(fd);
    };

    rec.start();
  };

  const stopRecording = () => {
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      mediaRecRef.current.stop();
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
  };

  const sendText = async (text: string) => {
    if (!text.trim()) return;
    reset();
    setTranscript(text.trim());
    const fd = new FormData();
    fd.append('text', text.trim());
    await sendToBackend(fd);
  };

  const handleClarification = () => {
    if (clarInput.trim()) sendText(clarInput.trim());
  };

  const onBtnPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, br: btnPos.right, bb: btnPos.bottom, moved: false };
  };

  const onBtnPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
    if (!d.moved) return;
    setBtnPos({
      right:  Math.max(4, Math.min(window.innerWidth  - 56, d.br - dx)),
      bottom: Math.max(4, Math.min(window.innerHeight - 56, d.bb - dy)),
    });
  };

  const onBtnPointerUp = () => {
    const wasDragging = dragRef.current?.moved ?? false;
    dragRef.current = null;
    if (!wasDragging) {
      setIsOpen(o => !o);
      if (!isOpen) { reset(); setShowHistory(false); }
    }
  };

  return (
    <>
      {/* Recording overlay */}
      {isRecording && (
        <div
          dir="rtl"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(15, 10, 40, 0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div style={{
            background: '#fff',
            borderRadius: 24,
            padding: '40px 48px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
            boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
            minWidth: 280,
            textAlign: 'center',
          }}>
            {/* Animated mic */}
            <div style={{ position: 'relative', width: 80, height: 80 }}>
              <div style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: 'rgba(239,68,68,0.18)',
                animation: 'recRipple 1.4s ease-out infinite',
              }} />
              <div style={{
                position: 'absolute', inset: 8, borderRadius: '50%',
                background: 'rgba(239,68,68,0.25)',
                animation: 'recRipple 1.4s ease-out 0.3s infinite',
              }} />
              <div style={{
                position: 'absolute', inset: 16, borderRadius: '50%',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 26,
                boxShadow: '0 4px 16px rgba(239,68,68,0.5)',
              }}>🎤</div>
            </div>

            <div>
              <div style={{ fontWeight: 700, fontSize: 18, color: '#1e293b' }}>جاري التسجيل...</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 6 }}>تكلم الآن، ثم اضغط إنهاء عند الانتهاء</div>
            </div>

            {/* Live dot indicator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: '#ef4444',
                display: 'inline-block',
                animation: 'recPulse 1s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>تسجيل نشط</span>
            </div>

            {/* Stop button */}
            <button
              onClick={stopRecording}
              style={{
                marginTop: 4,
                padding: '12px 36px',
                borderRadius: 12,
                border: 'none',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(239,68,68,0.4)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              ⏹ إنهاء التسجيل
            </button>
          </div>
        </div>
      )}

      {/* Floating button — draggable */}
      <button
        ref={btnRef}
        onPointerDown={onBtnPointerDown}
        onPointerMove={onBtnPointerMove}
        onPointerUp={onBtnPointerUp}
        title="مساعد AI الصوتي — اسحب لتغيير الموضع"
        style={{
          position: 'fixed',
          bottom: btnPos.bottom,
          right: btnPos.right,
          zIndex: 9999,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: isOpen ? '#4f46e5' : 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
          color: '#fff',
          fontSize: 22,
          cursor: 'grab',
          boxShadow: '0 4px 16px rgba(79,70,229,0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.2s ease, box-shadow 0.2s ease',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {isOpen ? '✕' : '🤖'}
      </button>

      {/* Panel */}
      {isOpen && (
        <div
          ref={panelRef}
          dir="rtl"
          style={{
            position: 'fixed',
            bottom: btnPos.bottom + 64,
            right: Math.max(8, btnPos.right - 4),
            zIndex: 9998,
            width: 360,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: '80vh',
            background: '#fff',
            borderRadius: 16,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            border: '1.5px solid #e0e7ff',
            fontFamily: 'inherit',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
            color: '#fff',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{showHistory ? 'السجل' : 'مساعد AI'}</span>
            <span style={{ marginRight: 'auto', fontSize: 11, opacity: 0.8 }}>
              {activePage}
            </span>
            <button
              onClick={() => history.length > 0 && setShowHistory(h => !h)}
              title={history.length > 0 ? 'السجل' : 'لا يوجد سجل بعد'}
              style={{
                background: showHistory ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)',
                border: '1.5px solid rgba(255,255,255,0.45)',
                borderRadius: 8, color: '#fff',
                padding: '3px 9px', cursor: history.length > 0 ? 'pointer' : 'default', fontSize: 12,
                display: 'flex', alignItems: 'center', gap: 4,
                flexShrink: 0, fontWeight: 600,
                opacity: history.length === 0 ? 0.4 : 1,
              }}
            >🕓 {history.length}</button>
          </div>

          {/* Scrollable body */}
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>

            {/* ── History panel ── */}
            {showHistory && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {history.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 12 }}>لا يوجد سجل بعد</div>
                )}
                {history.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => { setResult(h.result); setTranscript(h.text); setError(''); setShowHistory(false); }}
                    style={{
                      background: '#f8faff', border: '1.5px solid #e0e7ff', borderRadius: 10,
                      padding: '9px 12px', cursor: 'pointer', textAlign: 'right',
                      display: 'flex', flexDirection: 'column', gap: 3,
                    }}
                  >
                    <div style={{ fontSize: 13, color: '#1e293b', fontWeight: 600 }}>🔍 {h.text}</div>
                    <div style={{ fontSize: 11, color: '#6366f1' }}>
                      {h.result.action === 'query_visits' ? '📊 نتائج زيارات'
                        : h.result.action === 'query_doctors' ? '🩺 قائمة أطباء'
                        : h.result.action === 'query_unvisited_doctors' ? '⚠️ أطباء لم تتم زيارتهم'
                        : h.result.action === 'query_stats' ? '📈 إحصائيات'
                        : h.result.action === 'query_plan_stats' ? '📋 تقدم البلان'
                        : h.result.action === 'navigate' ? `🔀 انتقال: ${h.result.navigatePage}`
                        : h.result.action === 'page_action' ? `⚡ إجراء: ${h.result.pageAction}`
                        : '💡 رد'}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* ── Main content (hidden when history is shown) ── */}
            {!showHistory && <>

            {/* Voice + Text controls */}
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isProcessing}
              style={{
                width: '100%',
                padding: '9px 0',
                borderRadius: 10,
                border: 'none',
                background: isRecording
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                cursor: isProcessing ? 'not-allowed' : 'pointer',
                opacity: isProcessing ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              {isRecording
                ? <><span style={{ animation: 'pulse 1s infinite', display: 'inline-block' }}>🔴</span>إيقاف التسجيل</>
                : <><span>🎤</span>تحدث الآن</>}
            </button>

            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') sendText(textInput); }}
                placeholder="أو اكتب أمرك هنا..."
                disabled={isProcessing || isRecording}
                style={{
                  flex: 1, border: '1.5px solid #e0e7ff', borderRadius: 8,
                  padding: '7px 10px', fontSize: 13, outline: 'none',
                  direction: 'rtl', background: '#f8faff',
                }}
              />
              <button
                onClick={() => sendText(textInput)}
                disabled={isProcessing || isRecording || !textInput.trim()}
                style={{
                  padding: '7px 12px', borderRadius: 8, border: 'none',
                  background: '#4f46e5', color: '#fff', fontSize: 13, cursor: 'pointer',
                  opacity: (!textInput.trim() || isProcessing) ? 0.5 : 1,
                }}
              >إرسال</button>
            </div>

            {/* Processing */}
            {isProcessing && (
              <div style={{ textAlign: 'center', color: '#6366f1', fontSize: 13, padding: '6px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
                جاري التحليل والبحث في قاعدة البيانات...
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', color: '#dc2626', fontSize: 12 }}>
                {error}
              </div>
            )}

            {/* Transcript */}
            {transcript && !isProcessing && (
              <div style={{ background: '#f0f0ff', borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#4338ca', borderRight: '3px solid #6366f1' }}>
                <span style={{ fontWeight: 600 }}>قلت: </span>{transcript}
              </div>
            )}

            {/* ── RESULT PANEL ── */}
            {result && !isProcessing && (() => {
              const qr = result.queryResult;

              // ── No entity found ──────────────────────────────
              if (qr && !qr.found) return (
                <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 12px', fontSize: 13, color: '#92400e' }}>
                  ⚠️ {qr.message}
                </div>
              );

              // ── visits_list (flat list) ───────────────────────
              if (qr?.type === 'visits_list') {
                const isPharm = qr.visitType === 'pharmacy';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ background: isPharm ? '#ecfdf5' : '#ede9fe', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: isPharm ? '#065f46' : '#4c1d95' }}>
                        {isPharm ? '🏪 زيارات الصيدليات' : '🔍 نتائج البحث'}
                      </div>
                      <div style={{ fontSize: 12, color: isPharm ? '#047857' : '#5b21b6', marginTop: 2 }}>
                        إجمالي الزيارات: <strong>{qr.totalVisits}</strong>
                      </div>
                    </div>
                    {qr.visits?.map((v, i) => {
                      if (isPharm) {
                        const pv = v as PharmacyVisitRow;
                        return (
                          <div key={i} style={{
                            border: '1px solid #a7f3d0', borderRadius: 10, padding: '9px 11px',
                            background: '#f0fdf4', display: 'flex', flexDirection: 'column', gap: 3,
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{fmtDate(pv.date)}</span>
                              {pv.isDouble && <span style={{ fontSize: 10, background: '#d1fae5', color: '#065f46', borderRadius: 20, padding: '1px 7px' }}>👥 مزدوجة</span>}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46' }}>🏪 {pv.pharmacyName}</div>
                            {pv.areaName && pv.areaName !== '—' && <div style={{ fontSize: 11, color: '#6b7280' }}>📍 {pv.areaName}</div>}
                            <div style={{ fontSize: 11, color: '#6b7280' }}>👤 {pv.repName}</div>
                            {pv.itemNames.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                                {pv.itemNames.map((it, ii) => (
                                  <span key={ii} style={{ background: '#d1fae5', color: '#065f46', borderRadius: 20, padding: '1px 8px', fontSize: 10, fontWeight: 600 }}>💊 {it}</span>
                                ))}
                              </div>
                            )}
                            {pv.notes && <div style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }}>📝 {pv.notes}</div>}
                          </div>
                        );
                      }
                      const dv = v as VisitRow;
                      return (
                        <div key={i} style={{
                          border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 11px',
                          background: FEEDBACK_COLORS[dv.feedback] || '#f9fafb',
                          display: 'flex', flexDirection: 'column', gap: 3,
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{fmtDate(dv.date)}</span>
                            <span style={{ fontSize: 11, fontWeight: 700 }}>{dv.feedback}</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#374151' }}>
                            🩺 {dv.doctorName}{dv.specialty ? ` · ${dv.specialty}` : ''}
                            {dv.areaName ? ` · 📍 ${dv.areaName}` : ''}
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280' }}>
                            👤 {dv.repName}{dv.itemName && dv.itemName !== '—' ? ` · 💊 ${dv.itemName}` : ''}
                            {dv.isDouble ? ' · 👥 مزدوجة' : ''}
                          </div>
                          {dv.notes && <div style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }}>📝 {dv.notes}</div>}
                        </div>
                      );
                    })}
                    {(!qr.visits || qr.visits.length === 0) && (
                      <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: 8 }}>لا توجد زيارات مطابقة</div>
                    )}
                  </div>
                );
              }

              // ── grouped_visits ────────────────────────────────
              if (qr?.type === 'grouped_visits') {
                const isPharm = qr.visitType === 'pharmacy';
                const groupLabel = qr.groupBy === 'item' ? 'الإيتم'
                  : qr.groupBy === 'doctor'   ? 'الطبيب'
                  : qr.groupBy === 'rep'      ? 'المندوب'
                  : qr.groupBy === 'feedback' ? 'التفاعل'
                  : qr.groupBy === 'pharmacy' ? 'الصيدلية'
                  : qr.groupBy === 'area'     ? 'المنطقة'
                  : 'التاريخ';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ background: isPharm ? '#d1fae5' : '#dbeafe', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: isPharm ? '#065f46' : '#1e3a8a' }}>
                        {isPharm ? '🏪' : '📊'} نتائج مجمّعة حسب {groupLabel}
                      </div>
                      <div style={{ fontSize: 12, color: isPharm ? '#047857' : '#1d4ed8', marginTop: 2 }}>
                        إجمالي: <strong>{qr.totalVisits}</strong> زيارة في <strong>{qr.groups?.length}</strong> مجموعة
                      </div>
                    </div>
                    {(qr.groups as GroupRow[])?.map((g, gi) => (
                      <div key={gi} style={{ border: `1.5px solid ${isPharm ? '#6ee7b7' : '#bfdbfe'}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ background: isPharm ? '#ecfdf5' : '#eff6ff', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: isPharm ? '#065f46' : '#1e40af' }}>
                            {isPharm ? '🏪 ' : ''}{g.groupKey}
                          </span>
                          <span style={{ background: isPharm ? '#10b981' : '#3b82f6', color: '#fff', borderRadius: 20, padding: '1px 9px', fontSize: 11, fontWeight: 700 }}>{g.count}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                          {g.visits.map((v, vi) => {
                            if (isPharm) {
                              const pv = v as PharmacyVisitRow;
                              return (
                                <div key={vi} style={{
                                  borderTop: vi > 0 ? '1px solid #d1fae5' : undefined,
                                  padding: '7px 12px', background: '#f0fdf4',
                                  display: 'flex', flexDirection: 'column', gap: 2,
                                }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{fmtDate(pv.date)}</span>
                                    {pv.isDouble && <span style={{ fontSize: 10, color: '#047857' }}>👥</span>}
                                  </div>
                                  {pv.areaName && pv.areaName !== '—' && <div style={{ fontSize: 11, color: '#6b7280' }}>📍 {pv.areaName}</div>}
                                  <div style={{ fontSize: 11, color: '#6b7280' }}>👤 {pv.repName}</div>
                                  {pv.itemNames.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                      {pv.itemNames.map((it, ii) => (
                                        <span key={ii} style={{ background: '#d1fae5', color: '#065f46', borderRadius: 20, padding: '1px 7px', fontSize: 10 }}>💊 {it}</span>
                                      ))}
                                    </div>
                                  )}
                                  {pv.notes && <div style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }}>📝 {pv.notes}</div>}
                                </div>
                              );
                            }
                            const dv = v as VisitRow;
                            return (
                              <div key={vi} style={{
                                borderTop: vi > 0 ? '1px solid #e5e7eb' : undefined,
                                padding: '7px 12px',
                                background: FEEDBACK_COLORS[dv.feedback] || '#fafafa',
                                display: 'flex', flexDirection: 'column', gap: 2,
                              }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{fmtDate(dv.date)}</span>
                                  <span style={{ fontSize: 11, fontWeight: 700 }}>{dv.feedback}</span>
                                </div>
                                <div style={{ fontSize: 11, color: '#374151' }}>
                                  🩺 {dv.doctorName}{dv.specialty ? ` · ${dv.specialty}` : ''}
                                  {dv.areaName ? ` · 📍 ${dv.areaName}` : ''}
                                </div>
                                <div style={{ fontSize: 11, color: '#6b7280' }}>
                                  👤 {dv.repName}{dv.itemName && dv.itemName !== '—' ? ` · 💊 ${dv.itemName}` : ''}
                                  {dv.isDouble ? ' · 👥' : ''}
                                </div>
                                {dv.notes && <div style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }}>📝 {dv.notes}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              }

              // ── unvisited_doctors ──────────────────────────────────────
              if (qr?.type === 'unvisited_doctors') {
                if (qr.allVisited || qr.totalDoctors === 0) return (
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#15803d', fontWeight: 600, textAlign: 'center' }}>
                    🎉 جميع الأطباء تمت زيارتهم في هذه الفترة!
                  </div>
                );
                const areaGroups = qr.groups as { areaName: string; doctors: DoctorListRow[] }[] | undefined;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#9a3412' }}>⚠️ أطباء لم تتم زيارتهم</div>
                      <div style={{ fontSize: 12, color: '#c2410c', marginTop: 2 }}>
                        إجمالي: <strong>{qr.totalDoctors}</strong> طبيب • {areaGroups?.length ?? 0} منطقة
                      </div>
                    </div>
                    {areaGroups?.map((grp, gi) => (
                      <div key={gi} style={{ border: '1.5px solid #fed7aa', borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ background: '#fff7ed', padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 700, fontSize: 12, color: '#9a3412' }}>📍 {grp.areaName}</span>
                          <span style={{ background: '#f97316', color: '#fff', borderRadius: 20, padding: '1px 9px', fontSize: 11, fontWeight: 700 }}>{grp.doctors.length}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          {grp.doctors.map((d, di) => (
                            <div key={di} style={{
                              borderTop: di > 0 ? '1px solid #fed7aa' : undefined,
                              padding: '7px 12px', background: '#fffbf5',
                              display: 'flex', flexDirection: 'column', gap: 2,
                            }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>🩺 {d.name}</div>
                              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                {d.specialty && <span style={{ fontSize: 11, color: '#6b7280' }}>🔬 {d.specialty}</span>}
                                {d.phone && <span style={{ fontSize: 11, color: '#6b7280' }}>📞 {d.phone}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              }

              // ── doctor_list ───────────────────────────────────────────
              if (qr?.type === 'doctor_list') {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {result.responseText && (
                      <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6, padding: '6px 0' }}>
                        💡 {result.responseText}
                      </div>
                    )}
                    <div style={{ background: '#ecfdf5', borderRadius: 10, padding: '10px 12px', border: '1px solid #a7f3d0' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#065f46' }}>🩺 قائمة الأطباء</div>
                      <div style={{ fontSize: 12, color: '#047857', marginTop: 2 }}>
                        إجمالي: <strong>{qr.totalDoctors}</strong> طبيب
                      </div>
                    </div>
                    {qr.doctors?.map((d, i) => (
                      <div key={i} style={{
                        border: '1px solid #d1fae5', borderRadius: 10, padding: '8px 11px',
                        background: '#f0fdf4', display: 'flex', flexDirection: 'column', gap: 3,
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>🩺 {d.name}</div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {d.specialty && <span style={{ fontSize: 11, color: '#374151' }}>🔬 {d.specialty}</span>}
                          {d.areaName && <span style={{ fontSize: 11, color: '#6b7280' }}>📍 {d.areaName}</span>}
                          {d.pharmacyName && <span style={{ fontSize: 11, color: '#6b7280' }}>🏥 {d.pharmacyName}</span>}
                          {d.phone && <span style={{ fontSize: 11, color: '#6b7280' }}>📞 {d.phone}</span>}
                        </div>
                      </div>
                    ))}
                    {(!qr.doctors || qr.doctors.length === 0) && (
                      <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: 8 }}>لا يوجد أطباء مطابقون</div>
                    )}
                  </div>
                );
              }

              // ── invoices_list ─────────────────────────────────────────────
              if (qr?.type === 'invoices_list') {
                const invList = qr.invoices ?? [];
                const sm = qr.summary;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
                      📊 {result.responseText}
                    </div>
                    {sm && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[{l:'الفواتير',v:String(sm.totalInvoices),c:'#6366f1'},{l:'الإجمالي',v:sm.totalAmount,c:'#0ea5e9'},{l:'محصّل',v:sm.collected,c:'#10b981'},{l:'متبقي',v:sm.remaining,c:'#ef4444'}].map(s => (
                          <div key={s.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 10px', textAlign: 'center' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: s.c }}>{s.v}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {invList.map((inv: any, i: number) => (
                        <div key={i} style={{ background: '#f8fafc', borderRadius: 10, padding: '8px 12px', fontSize: 12, borderRight: `3px solid ${inv.status?.includes('✅') ? '#10b981' : inv.status?.includes('🔄') ? '#f59e0b' : '#6366f1'}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                            <span>🏥 {inv.pharmacyName}</span>
                            <span style={{ color: '#6366f1' }}>{inv.totalAmount} د.ع</span>
                          </div>
                          <div style={{ color: '#64748b', marginTop: 3 }}>
                            <span>{inv.areaName} · </span><span>{inv.status} · </span>
                            <span style={{ color: '#ef4444' }}>متبقي: {inv.remaining} د.ع</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── invoices_grouped ─────────────────────────────────────────
              if (qr?.type === 'invoices_grouped') {
                const grps = qr.groups ?? [];
                const sm2  = qr.summary;
                const groupColors = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6'];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
                      📊 {result.responseText}
                    </div>
                    {sm2 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[{l:'الفواتير',v:String(sm2.totalInvoices),c:'#6366f1'},{l:'الإجمالي',v:sm2.totalAmount,c:'#0ea5e9'},{l:'محصّل',v:sm2.collected,c:'#10b981'},{l:'متبقي',v:sm2.remaining,c:'#ef4444'}].map(s => (
                          <div key={s.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 10px', textAlign: 'center' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: s.c }}>{s.v}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {grps.map((g: any, idx: number) => (
                        <div key={g.groupKey} style={{ background: '#f8fafc', borderRadius: 12, padding: '10px 12px', borderRight: `3px solid ${groupColors[idx % groupColors.length]}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontWeight: 700, fontSize: 13, color: groupColors[idx % groupColors.length] }}>{g.groupKey}</span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>{g.count} فاتورة</span>
                          </div>
                          <div style={{ display: 'flex', gap: 10, fontSize: 11, flexWrap: 'wrap' }}>
                            <span>💰 إجمالي: <b>{g.totalAmount}</b></span>
                            <span style={{ color: '#10b981' }}>✔ محصّل: <b>{g.collected}</b></span>
                            <span style={{ color: '#ef4444' }}>⏳ متبقي: <b>{g.remaining}</b></span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── sales_list ────────────────────────────────────────────
              if (qr?.type === 'sales_list') {
                const sm = qr.summary;
                const salesItems = qr.items ?? [];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
                      🛒 {result.responseText}
                    </div>
                    {sm && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                        {[
                          { l: 'السطور', v: String(sm.totalLines), c: '#6366f1' },
                          { l: 'الكميات', v: String(sm.totalQty), c: '#0ea5e9' },
                          { l: 'الإجمالي', v: sm.totalValue, c: '#10b981' },
                        ].map(s => (
                          <div key={s.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: s.c }}>{s.v}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {salesItems.map((it: any, i: number) => (
                        <div key={i} style={{ background: '#f0fdf4', borderRadius: 10, padding: '8px 11px', fontSize: 12, borderRight: '3px solid #10b981' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                            <span>💊 {it.brandName}</span>
                            <span style={{ color: '#10b981' }}>{it.totalPrice} د.ع</span>
                          </div>
                          <div style={{ color: '#64748b', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {it.company && it.company !== '—' && <span>🏭 {it.company}</span>}
                            <span>📦 كمية: {it.quantity}{it.bonusQty > 0 ? ` + بونص ${it.bonusQty}` : ''}</span>
                            <span>🏪 {it.pharmacyName}</span>
                            {it.areaName && it.areaName !== '—' && <span>📍 {it.areaName}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── sales_grouped ─────────────────────────────────────────
              if (qr?.type === 'sales_grouped') {
                const sm = qr.summary;
                const grps = qr.groups ?? [];
                const gColors = ['#10b981','#6366f1','#0ea5e9','#f59e0b','#ef4444','#8b5cf6'];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
                      🛒 {result.responseText}
                    </div>
                    {sm && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                        {[
                          { l: 'السطور', v: String(sm.totalLines), c: '#6366f1' },
                          { l: 'الكميات', v: String(sm.totalQty), c: '#0ea5e9' },
                          { l: 'الإجمالي', v: sm.totalValue, c: '#10b981' },
                        ].map(s => (
                          <div key={s.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: s.c }}>{s.v}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {grps.map((g: any, idx: number) => (
                        <div key={g.groupKey} style={{ background: '#f8fafc', borderRadius: 11, padding: '9px 12px', borderRight: `3px solid ${gColors[idx % gColors.length]}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13 }}>
                            <span style={{ color: gColors[idx % gColors.length] }}>💊 {g.groupKey}</span>
                            <span style={{ color: '#64748b', fontSize: 11 }}>{g.totalQty} وحدة</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                            💰 إجمالي: <b style={{ color: '#10b981' }}>{g.totalValue} د.ع</b>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── returns_list ──────────────────────────────────────────
              if (qr?.type === 'returns_list') {
                const sm = qr.summary;
                const recs = qr.records ?? [];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e2e8f0', paddingBottom: 6 }}>
                      🔄 {result.responseText}
                    </div>
                    {sm && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[
                          { l: 'السجلات', v: String(sm.totalRecords), c: '#6366f1' },
                          { l: 'إجمالي الاسترجاع', v: sm.totalReturned, c: '#ef4444' },
                        ].map(s => (
                          <div key={s.l} style={{ background: '#f8fafc', borderRadius: 8, padding: '6px 10px', textAlign: 'center' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: s.c }}>{s.v}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {recs.map((r: any, i: number) => (
                        <div key={i} style={{ background: '#fef2f2', borderRadius: 10, padding: '8px 11px', fontSize: 12, borderRight: '3px solid #ef4444' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                            <span>🏥 {r.pharmacyName}</span>
                            <span style={{ color: '#ef4444' }}>🔄 {r.returnedAmount} د.ع</span>
                          </div>
                          <div style={{ color: '#64748b', marginTop: 3 }}>
                            {r.areaName && r.areaName !== '—' && <span>📍 {r.areaName} · </span>}
                            <span>فاتورة: {r.invoiceNumber}</span>
                          </div>
                          {r.returnedItems?.length > 0 && (
                            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {r.returnedItems.map((it: any, ii: number) => (
                                <span key={ii} style={{ background: '#fee2e2', color: '#9f1239', borderRadius: 20, padding: '1px 8px', fontSize: 10 }}>
                                  {it.name || it.itemName}: {it.returnQty} وحدة
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── survey_list ───────────────────────────────────────────
              if (qr?.type === 'survey_list') {
                const sm = qr.summary;
                const pharms = qr.pharmacies ?? [];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ background: '#ecfdf5', borderRadius: 10, padding: '9px 12px', border: '1px solid #a7f3d0' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#065f46' }}>🗺️ صيدليات السيرفي</div>
                      <div style={{ fontSize: 12, color: '#047857', marginTop: 2 }}>إجمالي: <strong>{sm?.totalPharmacies}</strong> صيدلية</div>
                    </div>
                    <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {pharms.map((p: any, i: number) => (
                        <div key={i} style={{ background: '#f0fdf4', borderRadius: 10, padding: '8px 11px', fontSize: 12, borderRight: '3px solid #34d399' }}>
                          <div style={{ fontWeight: 700, color: '#065f46' }}>🏥 {p.name}</div>
                          <div style={{ color: '#64748b', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {p.areaName && p.areaName !== '—' && <span>📍 {p.areaName}</span>}
                            {p.ownerName && <span>👤 {p.ownerName}</span>}
                            {p.phone && <span>📞 {p.phone}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── survey_grouped ────────────────────────────────────────
              if (qr?.type === 'survey_grouped') {
                const sm = qr.summary;
                const grps = qr.groups ?? [];
                const gColors = ['#10b981','#6366f1','#0ea5e9','#f59e0b','#8b5cf6','#ef4444'];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ background: '#ecfdf5', borderRadius: 10, padding: '9px 12px', border: '1px solid #a7f3d0' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#065f46' }}>🗺️ صيدليات السيرفي حسب المنطقة</div>
                      <div style={{ fontSize: 12, color: '#047857', marginTop: 2 }}>إجمالي: <strong>{sm?.totalPharmacies}</strong> صيدلية</div>
                    </div>
                    <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {grps.map((g: any, idx: number) => (
                        <div key={g.areaName} style={{ background: '#f8fafc', borderRadius: 12, padding: '10px 12px', borderRight: `3px solid ${gColors[idx % gColors.length]}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontWeight: 700, fontSize: 13, color: gColors[idx % gColors.length] }}>📍 {g.areaName}</span>
                            <span style={{ fontSize: 11, background: gColors[idx % gColors.length], color: '#fff', borderRadius: 20, padding: '1px 9px' }}>{g.count}</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {g.pharmacies.slice(0, 5).map((p: any, pi: number) => (
                              <div key={pi} style={{ fontSize: 11, color: '#374151', display: 'flex', gap: 6 }}>
                                <span>🏥 {p.name}</span>
                                {p.phone && <span style={{ color: '#6b7280' }}>📞 {p.phone}</span>}
                              </div>
                            ))}
                            {g.pharmacies.length > 5 && (
                              <div style={{ fontSize: 10, color: '#94a3b8' }}>+ {g.pharmacies.length - 5} صيدليات أخرى</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              // ── stats_summary ─────────────────────────────────────────
              if (qr?.type === 'stats_summary') {
                const statColors = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
                const renderBar = (items: { key: string; count: number }[], color: string) => {
                  if (!items || items.length === 0) return null;
                  const max = Math.max(...items.map(i => i.count), 1);
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {items.map((it, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontSize: 11, color: '#374151', minWidth: 90, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.key}</div>
                          <div style={{ flex: 1, height: 14, background: '#f1f5f9', borderRadius: 7, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${(it.count / max) * 100}%`, background: color, borderRadius: 7, transition: 'width 0.4s ease' }} />
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 700, color, minWidth: 24, textAlign: 'left' }}>{it.count}</div>
                        </div>
                      ))}
                    </div>
                  );
                };

                const hasBreakdown = qr.breakdown && qr.breakdown.length > 0;
                const groupLabel = qr.groupBy === 'area' ? 'المنطقة'
                  : qr.groupBy === 'item' ? 'الإيتم'
                  : qr.groupBy === 'rep' ? 'المندوب'
                  : qr.groupBy === 'feedback' ? 'التفاعل'
                  : qr.groupBy === 'date' ? 'التاريخ' : null;

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Total count card */}
                    <div style={{ background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)', borderRadius: 12, padding: '14px 16px', color: '#fff', textAlign: 'center' }}>
                      <div style={{ fontSize: 32, fontWeight: 800 }}>{qr.totalVisits ?? 0}</div>
                      <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>
                        {qr.visitType === 'pharmacy' ? 'إجمالي زيارات الصيدليات' : 'إجمالي الزيارات'}
                      </div>
                      {qr.doctorVisits !== undefined && qr.pharmacyVisits !== undefined && (
                        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>
                          🩺 أطباء: {qr.doctorVisits} · 🏪 صيدليات: {qr.pharmacyVisits}
                        </div>
                      )}
                    </div>

                    {/* Breakdown if grouped */}
                    {hasBreakdown && groupLabel && (
                      <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #e0e7ff' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', marginBottom: 8 }}>
                          📊 توزيع حسب {groupLabel}
                        </div>
                        {renderBar(qr.breakdown!, statColors[0])}
                      </div>
                    )}

                    {/* Full breakdown for ungrouped stats */}
                    {!hasBreakdown && (
                      <>
                        {qr.topAreas && qr.topAreas.length > 0 && (
                          <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #e0e7ff' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', marginBottom: 8 }}>📍 أكثر المناطق زيارة</div>
                            {renderBar(qr.topAreas, '#6366f1')}
                          </div>
                        )}
                        {qr.topItems && qr.topItems.length > 0 && (
                          <div style={{ background: '#f0fdf4', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #a7f3d0' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 8 }}>💊 أكثر الإيتمات زيارة</div>
                            {renderBar(qr.topItems, '#10b981')}
                          </div>
                        )}
                        {qr.topReps && qr.topReps.length > 0 && (
                          <div style={{ background: '#fffbeb', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #fde68a' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>👤 أكثر المندوبين زيارة</div>
                            {renderBar(qr.topReps, '#f59e0b')}
                          </div>
                        )}
                        {qr.feedbackBreakdown && qr.feedbackBreakdown.length > 0 && (
                          <div style={{ background: '#fdf2f8', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #f9a8d4' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#9d174d', marginBottom: 8 }}>📝 توزيع التفاعل</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {qr.feedbackBreakdown.map((fb, i) => (
                                <div key={i} style={{ background: '#fff', border: '1px solid #f9a8d4', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 600, color: '#9d174d' }}>
                                  {fb.key}: <strong>{fb.count}</strong>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              }

              // ── plan_stats ────────────────────────────────────────────
              if (qr?.type === 'plan_stats') {
                if (!qr.found) {
                  return <div style={{ background: '#fef2f2', color: '#991b1b', borderRadius: 10, padding: '10px 14px', fontSize: 13, border: '1.5px solid #fecaca' }}>❌ {qr.message || 'لا يوجد بلان'}</div>;
                }
                const monthNames = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
                const mName = monthNames[qr.month || 0] || `شهر ${qr.month}`;
                const pctColor = (p: number) => p >= 80 ? '#10b981' : p >= 50 ? '#f59e0b' : '#ef4444';

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Header */}
                    <div style={{ background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)', borderRadius: 12, padding: '14px 16px', color: '#fff', textAlign: 'center' }}>
                      <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 4 }}>📋 تقدم البلان — {mName} {qr.year}</div>
                      <div style={{ fontSize: 36, fontWeight: 800 }}>{qr.completionPct}%</div>
                      <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>نسبة تحقيق الزيارات</div>
                    </div>

                    {/* Summary cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div style={{ background: '#f0f9ff', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #bae6fd', textAlign: 'center' }}>
                        <div style={{ fontSize: 11, color: '#0369a1', marginBottom: 2 }}>🩺 الأطباء</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#0c4a6e' }}>{qr.visitedDoctors}/{qr.totalDoctors}</div>
                        <div style={{ fontSize: 11, color: '#0369a1' }}>تغطية {qr.doctorCoveragePct}%</div>
                      </div>
                      <div style={{ background: '#f0fdf4', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #a7f3d0', textAlign: 'center' }}>
                        <div style={{ fontSize: 11, color: '#065f46', marginBottom: 2 }}>📞 الكولات</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#064e3b' }}>{qr.totalActualVisits}/{qr.totalTargetVisits}</div>
                        <div style={{ fontSize: 11, color: '#065f46' }}>تحقيق {qr.completionPct}%</div>
                      </div>
                    </div>

                    {/* By Area */}
                    {qr.byArea && qr.byArea.length > 0 && (
                      <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #e0e7ff' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', marginBottom: 8 }}>
                          📍 {qr.filteredAreaName ? `منطقة ${qr.filteredAreaName}` : 'حسب المنطقة'}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {qr.byArea.map((a, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ fontSize: 11, color: '#374151', minWidth: 80, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                              <div style={{ flex: 1, height: 16, background: '#e5e7eb', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ height: '100%', width: `${a.pct}%`, background: pctColor(a.pct), borderRadius: 8, transition: 'width 0.4s ease' }} />
                              </div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: pctColor(a.pct), minWidth: 60, textAlign: 'left' }}>
                                {a.actualVisits}/{a.targetVisits} ({a.pct}%)
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* By Item */}
                    {qr.byItem && qr.byItem.length > 0 && (
                      <div style={{ background: '#f0fdf4', borderRadius: 10, padding: '10px 12px', border: '1.5px solid #a7f3d0' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 8 }}>
                          💊 {qr.filteredItemName ? `ايتم ${qr.filteredItemName}` : 'حسب الإيتم'}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {qr.byItem.map((it, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ fontSize: 11, color: '#374151', minWidth: 80, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
                              <div style={{ flex: 1, height: 16, background: '#e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${it.pct}%`, background: pctColor(it.pct), borderRadius: 8, transition: 'width 0.4s ease' }} />
                              </div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: pctColor(it.pct), minWidth: 60, textAlign: 'left' }}>
                                {it.visitedDoctors}/{it.targetDoctors} ({it.pct}%)
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              // ── Navigate / simple response ──────────────────────────────
              return (
                <div style={{
                  background: result.action === 'navigate' ? '#f0fdf4' : '#f8faff',
                  border: `1.5px solid ${result.action === 'navigate' ? '#bbf7d0' : '#e0e7ff'}`,
                  borderRadius: 10, padding: '10px 12px',
                }}>
                  <p style={{ margin: 0, fontSize: 13, color: '#1e293b', lineHeight: 1.6 }}>
                    {result.action === 'navigate' ? '✅ ' : '💡 '}{result.responseText}
                  </p>
                  {result.needsClarification && result.question && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <p style={{ margin: 0, fontSize: 12, color: '#7c3aed', fontWeight: 600 }}>{result.question}</p>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="text" value={clarInput} onChange={e => setClarInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleClarification(); }}
                          placeholder="أجب هنا..." style={{ flex: 1, border: '1.5px solid #d8b4fe', borderRadius: 7, padding: '5px 8px', fontSize: 12, outline: 'none', direction: 'rtl' }} />
                        <button onClick={handleClarification} style={{ padding: '5px 10px', borderRadius: 7, border: 'none', background: '#7c3aed', color: '#fff', fontSize: 12, cursor: 'pointer' }}>إرسال</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Reset */}
            {(result || error) && (
              <button onClick={reset} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer', alignSelf: 'flex-end', padding: '2px 4px' }}>
                مسح ↺
              </button>
            )}
            </> /* end !showHistory */}
          </div>

          <style>{`
            @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:0.4} }
            @keyframes spin     { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
            @keyframes recPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(1.3)} }
            @keyframes recRipple{ 0%{transform:scale(0.8);opacity:0.8} 100%{transform:scale(1.8);opacity:0} }
          `}</style>
        </div>
      )}
    </>
  );
}
