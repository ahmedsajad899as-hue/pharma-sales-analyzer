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

// محادثة = رقم × جهة: رقم واحد قد يكون مذخراً وزبون حملة وحساباً — كلٌّ في محادثته
interface ChatRow {
  key: string; waId: string; party: string; name: string | null; type: 'warehouse' | 'linked' | 'campaign' | 'unknown';
  account: string | null; contactName: string | null; sameNumber: number;
  count: number; failed: number; lastAt: string; lastText: string | null; lastDirection: 'in' | 'out' | null;
}
interface ChatMsg { id: number; direction: 'in' | 'out'; kind: string; text: string | null; mediaId: string | null; error: string | null; sentByName: string | null; createdAt: string }
interface ChatWindow { open: boolean; lastInboundAt: string | null; closesAt: string | null }
const CHAT_TYPE: Record<ChatRow['type'], string> = { warehouse: 'مذخر', linked: 'مربوط', campaign: 'زبون حملة', unknown: 'غير مربوط' };
const splitKey = (key: string) => { const i = key.indexOf('|'); return { waId: key.slice(0, i), party: key.slice(i + 1) }; };

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

  const loadMsgs = useCallback((key: string) => {
    const { waId, party } = splitKey(key);
    api(`/chats/${encodeURIComponent(waId)}?party=${encodeURIComponent(party)}`).then(d => { setMsgs(d.messages || []); setWin(d.window || null); }).catch(e => setError(e.message));
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
      const { waId, party } = splitKey(sel);
      await api(`/chats/${encodeURIComponent(waId)}/send`, { method: 'POST', body: JSON.stringify({ text: draft, party }) });
      setDraft(''); setError('');
      loadMsgs(sel); load();
    } catch (e: any) { setError(e.message); } finally { setSending(false); }
  };

  const shown = useMemo(() => {
    const t = q.trim();
    return t ? chats.filter(c => [c.name, c.waId, c.account, c.contactName, c.lastText].some(v => v?.includes(t))) : chats;
  }, [chats, q]);
  const cur = chats.find(c => c.key === sel);

  return (
    <>
      {error && <div className="wd-note wd-note--warn">{error}</div>}
      <div className="wd-toolbar">
        <input className="form-input" placeholder="بحث بالاسم أو الرقم أو النص…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="wd-seg">
          {[1, 7, 30, 90].map(d => <button key={d} className={`wd-seg__btn ${days === d ? 'is-active' : ''}`} onClick={() => setDays(d)}>{d === 1 ? 'يوم' : `${d} يوم`}</button>)}
        </div>
        <span className="wd-muted wd-small">{shown.length} محادثة</span>
        <button className="btn btn-secondary wd-icon-btn" onClick={load} title="تحديث"><RefreshCw size={14} /></button>
      </div>
      <div className="wd-chats">
        <div className="wd-chat-list">
          {loading && <div className="wd-empty">جاري التحميل…</div>}
          {!loading && !shown.length && <div className="wd-empty">لا محادثات في هذه المدة</div>}
          {shown.map(c => (
            <button key={c.key} className={`wd-chat-item ${sel === c.key ? 'is-active' : ''}`} onClick={() => { setSel(c.key); setMsgs([]); setWin(null); setDraft(''); }}>
              <div className="wd-chat-head">
                <b>{c.name || c.waId}</b>
                <span className="wd-muted">{fmtTime(c.lastAt)}</span>
              </div>
              <div className="wd-chat-meta">
                <span className={`wd-chat-type wd-chat-type--${c.type}`}>{CHAT_TYPE[c.type]}</span>
                {c.account && c.account !== c.name && <span className="wd-muted">{c.account}</span>}
                <span className="wd-muted">{c.count} رسالة</span>
                {c.failed > 0 && <span className="wd-fail">{c.failed} فشل</span>}
                {c.sameNumber > 0 && <span className="wd-muted" title="نفس الرقم له محادثات أخرى">+{c.sameNumber}</span>}
              </div>
              <div className="wd-chat-last">{c.lastDirection === 'out' ? 'البوت: ' : ''}{(c.lastText || '').slice(0, 80)}</div>
            </button>
          ))}
        </div>
        <div className="wd-chat-view">
          {!cur && <div className="wd-empty">اختر محادثة</div>}
          {cur && (
            <>
              <div className="wd-chat-title">
                <b>{cur.name || cur.waId}</b>
                <span className={`wd-chat-type wd-chat-type--${cur.type}`}>{CHAT_TYPE[cur.type]}</span>
                <span className="wd-muted" dir="ltr">+{cur.waId}</span>
                {cur.sameNumber > 0 && <span className="wd-muted wd-small" title="هنا رسائل هذه الجهة فقط، وردّك يصل لنفس الهاتف">· له {cur.sameNumber} محادثة أخرى</span>}
              </div>
              <div className="wd-msgs">
                {msgs.map(m => (
                  <div key={m.id} className={`wd-msg wd-msg--${m.direction} ${m.sentByName ? 'wd-msg--human' : ''} ${m.error ? 'wd-msg--err' : ''}`}>
                    <div className="wd-msg-meta">{m.direction === 'out' ? (m.sentByName || 'البوت') : (cur.name || 'المرسل')} · {fmtTime(m.createdAt)}</div>
                    {m.kind === 'image' && (imgs[m.id]
                      ? <img src={imgs[m.id]} className="wd-msg-img" alt="" onClick={() => window.open(imgs[m.id], '_blank')} />
                      : m.mediaId && <button className="btn btn-secondary wd-msg-imgbtn" onClick={() => showImage(m.id)}><ImageIcon size={14} /> عرض الصورة</button>)}
                    {m.text && <div className="wd-msg-text">{m.text}</div>}
                    {m.error && <div className="wd-fail">لم تُرسل: {m.error}</div>}
                  </div>
                ))}
              </div>
              <div className="wd-reply">
                {win && !win.open
                  ? <div className="wd-muted wd-small">انتهت نافذة الـ24 ساعة — لا يمكن الرد حتى يراسل الرقم أولاً</div>
                  : <>
                      {win?.closesAt && <div className="wd-muted wd-reply-hint" title="ردّك يصل من رقم البوت، والبوت يسكت 30 دقيقة">الرد متاح حتى {fmtTime(win.closesAt)}</div>}
                      <div className="wd-reply-row">
                        <textarea className="form-input" rows={2} placeholder="اكتب رداً…" value={draft} disabled={sending}
                          onChange={e => setDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                        <button className="btn btn-primary wd-icon-btn" disabled={sending || !draft.trim()} onClick={send} title="إرسال"><Send size={15} /></button>
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
