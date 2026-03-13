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
}

interface QueryResult {
  found: boolean;
  message?: string;
  type?: 'visits_list' | 'grouped_visits' | 'doctor_list' | 'unvisited_doctors';
  visitType?: 'doctor' | 'pharmacy';
  groupBy?: string;
  totalVisits?: number;
  totalDoctors?: number;
  allVisited?: boolean;
  groups?: (GroupRow | { areaName: string; doctors: DoctorListRow[] })[];
  visits?: (VisitRow | PharmacyVisitRow)[];
  doctors?: DoctorListRow[];
}

interface AssistantResult {
  action: string;
  navigatePage?: string | null;
  pageAction?: string | null;
  pageActionParam?: string | null;
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
  'كاتب ✍️':     '#dcfce7',
  'نزّل 📦':      '#dbeafe',
  'مهتم 👍':      '#fef9c3',
  'غير مهتم 👎': '#fee2e2',
  'غير متوفر ❌': '#f3f4f6',
  'معلق ⏳':      '#ede9fe',
};

interface HistoryEntry {
  text: string;
  result: AssistantResult;
}

export default function AIAssistant({ activePage, navigateTo }: Props) {
  const { token } = useAuth();

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

  const mediaRecRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const streamRef    = useRef<MediaStream | null>(null);
  const startTimeRef = useRef<number>(0);
  const panelRef     = useRef<HTMLDivElement>(null);
  const btnRef       = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current && !panelRef.current.contains(target) &&
        btnRef.current   && !btnRef.current.contains(target)
      ) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const reset = () => {
    setResult(null); setError(''); setTranscript(''); setTextInput(''); setClarInput('');
  };

  const sendToBackend = useCallback(async (fd: FormData) => {
    setIsProcessing(true);
    setError('');
    try {
      fd.append('context', JSON.stringify({ currentPage: activePage, userRole: 'user' }));
      const r = await fetch(`${API}/api/ai-assistant/command`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const json = await r.json();
      if (!json.success) throw new Error(json.error || 'خطأ غير معروف');
      const data: AssistantResult = json.data;
      setResult(data);
      // Save to history (keep last 20 entries)
      const inputText = fd.get('text') as string | null;
      if (inputText?.trim()) {
        setHistory(prev => [{ text: inputText.trim(), result: data }, ...prev].slice(0, 20));
      }
      // Auto-navigate only when no deep results to show
      if (data.navigatePage && !data.needsClarification && !data.queryResult) {
        const page = data.navigatePage as PageId;
        const valid: PageId[] = ['dashboard','upload','representatives','scientific-reps','doctors','monthly-plans','reports','users','rep-analysis'];
        if (valid.includes(page)) navigateTo(page);
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
          'open-add-sci-rep':      'scientific-reps',
          'open-add-rep':          'representatives',
          'open-add-user':         'users',
          'open-call-log':         'dashboard',
          'open-voice-call':       'dashboard',
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

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('الميكروفون غير متاح — يجب فتح التطبيق عبر HTTPS أو من localhost');
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
      await sendToBackend(fd);
    };

    rec.start();
    setIsRecording(true);
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

  return (
    <>
      {/* Floating button */}
      <button
        ref={btnRef}
        onClick={() => { setIsOpen(o => !o); if (!isOpen) { reset(); setShowHistory(false); } }}
        title="مساعد AI الصوتي"
        style={{
          position: 'fixed',
          bottom: 24,
          left: 24,
          zIndex: 9999,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: isOpen ? '#4f46e5' : 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
          color: '#fff',
          fontSize: 22,
          cursor: 'pointer',
          boxShadow: '0 4px 16px rgba(79,70,229,0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease',
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
            bottom: 88,
            left: 16,
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

              // ── Navigate / simple response ───────────────────
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
            @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
            @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
          `}</style>
        </div>
      )}
    </>
  );
}
