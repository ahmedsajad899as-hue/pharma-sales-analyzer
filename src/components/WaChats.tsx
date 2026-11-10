// ════════════════════════════════════════════════════════════════════════════
// WaChats — محادثات رقم البوت الرسمي (واتساب): كل رسالة واردة وصادرة + ردّ يدوي
// من رقم البوت خلال نافذة الـ24 ساعة. مشترك بين صفحة «محادثات واتساب» في التطبيق
// (base = /api/warehouse-dispatch) ولوحة الماستر أدمن (base = /api/sa/whatsapp-links).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Send, RefreshCw, Image as ImageIcon } from 'lucide-react';
import '../pages/WarehouseDispatchPage.css';

const API = import.meta.env.VITE_API_URL || '';

const fmtTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

interface ChatRow {
  waId: string; name: string | null; type: 'warehouse' | 'linked' | 'unknown'; account: string | null; contactName: string | null;
  count: number; failed: number; lastAt: string; lastText: string | null; lastDirection: 'in' | 'out' | null;
}
interface ChatMsg { id: number; direction: 'in' | 'out'; kind: string; text: string | null; mediaId: string | null; error: string | null; sentByName: string | null; createdAt: string }
interface ChatWindow { open: boolean; lastInboundAt: string | null; closesAt: string | null }
const CHAT_TYPE: Record<ChatRow['type'], string> = { warehouse: '🏬 مذخر', linked: '👤 مربوط', unknown: '❔ غير مربوط' };

export default function WaChats({ base, token }: { base: string; token: string | null }) {
  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${API}${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.error || d.message || 'خطأ في الاتصال');
    return d;
  }, [base, token]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [imgs, setImgs] = useState<Record<number, string>>({});
  const [win, setWin] = useState<ChatWindow | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api(`/chats?days=${days}`).then(d => { setChats(d.chats || []); setError(''); })
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [api, days]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const loadMsgs = useCallback((waId: string) => {
    api(`/chats/${encodeURIComponent(waId)}`).then(d => { setMsgs(d.messages || []); setWin(d.window || null); }).catch(e => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (!sel) return;
    loadMsgs(sel);
    const t = setInterval(() => loadMsgs(sel), 15_000);
    return () => clearInterval(t);
  }, [sel, loadMsgs]);

  const showImage = async (id: number) => {
    try {
      const res = await fetch(`${API}${base}/chats/media/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'تعذّر جلب الصورة');
      const url = URL.createObjectURL(await res.blob());
      setImgs(m => ({ ...m, [id]: url }));
    } catch (e: any) { setError(e.message); }
  };

  const send = async () => {
    if (!sel || !draft.trim()) return;
    setSending(true);
    try {
      await api(`/chats/${encodeURIComponent(sel)}/send`, { method: 'POST', body: JSON.stringify({ text: draft }) });
      setDraft(''); setError('');
      loadMsgs(sel); load();
    } catch (e: any) { setError(e.message); } finally { setSending(false); }
  };

  const shown = useMemo(() => {
    const t = q.trim();
    return t ? chats.filter(c => [c.name, c.waId, c.account, c.contactName, c.lastText].some(v => v?.includes(t))) : chats;
  }, [chats, q]);
  const cur = chats.find(c => c.waId === sel);

  return (
    <>
      <div className="wd-note">كل رسالة تصل لرقم البوت الرسمي أو يرسلها البوت تُسجَّل هنا — بما فيها ما لا يفهمه البوت (صوت، أسئلة) كي لا يفوتك شيء. تقدر ترد من هنا وتصل الرسالة من رقم البوت. تُحفظ 90 يوماً.</div>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      <div className="wd-toolbar">
        <input className="form-input" placeholder="بحث بالاسم أو الرقم أو النص…" value={q} onChange={e => setQ(e.target.value)} />
        <select className="form-input wd-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map(d => <option key={d} value={d}>آخر {d} يوم</option>)}
        </select>
        <button className="btn btn-secondary" onClick={load}><RefreshCw size={14} /></button>
      </div>
      <div className="wd-chats">
        <div className="wd-chat-list">
          {loading && <div className="wd-empty">جاري التحميل…</div>}
          {!loading && !shown.length && <div className="wd-empty">لا محادثات في هذه المدة</div>}
          {shown.map(c => (
            <button key={c.waId} className={`wd-chat-item ${sel === c.waId ? 'is-active' : ''}`} onClick={() => { setSel(c.waId); setMsgs([]); setWin(null); setDraft(''); }}>
              <div className="wd-chat-head">
                <b>{c.name || c.waId}</b>
                <span className="wd-muted">{fmtTime(c.lastAt)}</span>
              </div>
              <div className="wd-muted">{CHAT_TYPE[c.type]}{c.account && c.account !== c.name ? ` · ${c.account}` : ''} · {c.count} رسالة{c.failed ? <span className="wd-fail"> · {c.failed} فشل</span> : null}</div>
              <div className="wd-chat-last">{c.lastDirection === 'out' ? '🤖 ' : ''}{(c.lastText || '').slice(0, 80)}</div>
            </button>
          ))}
        </div>
        <div className="wd-chat-view">
          {!cur && <div className="wd-empty">اختر محادثة</div>}
          {cur && (
            <>
              <div className="wd-chat-title"><b>{cur.name || cur.waId}</b> <span className="wd-muted" dir="ltr">+{cur.waId}</span></div>
              <div className="wd-msgs">
                {msgs.map(m => (
                  <div key={m.id} className={`wd-msg wd-msg--${m.direction} ${m.sentByName ? 'wd-msg--human' : ''} ${m.error ? 'wd-msg--err' : ''}`}>
                    <div className="wd-msg-meta">{m.direction === 'out' ? (m.sentByName ? `👤 ${m.sentByName}` : '🤖 البوت') : (cur.name || 'المرسل')} · {fmtTime(m.createdAt)}</div>
                    {m.kind === 'image' && (imgs[m.id]
                      ? <img src={imgs[m.id]} className="wd-msg-img" alt="" onClick={() => window.open(imgs[m.id], '_blank')} />
                      : m.mediaId && <button className="btn btn-secondary wd-msg-imgbtn" onClick={() => showImage(m.id)}><ImageIcon size={14} /> عرض الصورة</button>)}
                    {m.text && <div className="wd-msg-text">{m.text}</div>}
                    {m.error && <div className="wd-fail">⚠️ لم تُرسل: {m.error}</div>}
                  </div>
                ))}
              </div>
              <div className="wd-reply">
                {win && !win.open
                  ? <div className="wd-note wd-note--warn">مرّت 24 ساعة على آخر رسالة منه — واتساب لا يسمح بالكتابة له من رقم البوت حتى يراسل الرقم أولاً.</div>
                  : <>
                      {win?.closesAt && <div className="wd-muted wd-reply-hint">يمكنك الرد حتى {fmtTime(win.closesAt)} · ردّك يصل من رقم البوت باسمك هنا، والبوت يسكت عن كلامه العادي 30 دقيقة</div>}
                      <div className="wd-reply-row">
                        <textarea className="form-input" rows={2} placeholder="اكتب رداً…" value={draft} disabled={sending}
                          onChange={e => setDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                        <button className="btn btn-primary" disabled={sending || !draft.trim()} onClick={send}><Send size={14} /> إرسال</button>
                      </div>
                    </>}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
