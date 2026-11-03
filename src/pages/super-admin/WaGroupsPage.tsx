import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Modal, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';

interface Status { status?: string; connected?: boolean; me?: string | null; error?: string | null }
interface Group { jid: string; name: string; size: number }
interface UserOption { id: number; username: string; displayName?: string | null; role: string }
interface ListenLink {
  jid: string; name: string | null; userId: number; isActive: boolean; orderTextMode: OrderTextMode; user?: UserOption;
  messageCount: number; orderCount: number; attachedCount: number; failedCount: number; lastMessageAt: string | null; lastOrderAt: string | null;
}
interface LinkForm { jid: string; name: string; userId?: number; orderTextMode: OrderTextMode; isNew: boolean }
interface PendingAt { userId: number; name: string; count: number }
interface Retrying { count: number; nextAt: number | null; lastError: string | null }
interface Destination {
  reviewer: { id: number; name: string; role: string; isActive: boolean };
  office: string | null;
  conditionOn: boolean;
  ownItems: number;
  managers: { id: number; name: string; company: string | null; items: number }[];
  conditionFile: { ownerName: string; id: number | null; name: string | null; rows: number };
}

const userLabel = (u?: UserOption) => u ? (u.displayName || u.username) : '—';

// «قبل 5 د» / «قبل 3 س» / «قبل 2 ي» — تشخيص سريع: هل الكروب يُقرأ فعلاً؟
function ago(iso: string | null): string {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'الآن';
  if (min < 60) return `قبل ${min} د`;
  if (min < 24 * 60) return `قبل ${Math.round(min / 60)} س`;
  return `قبل ${Math.round(min / 1440)} ي`;
}

// «بعد 12 د» — موعد إعادة القراءة القادمة
function untilLabel(ms: number): string {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min <= 1) return 'خلال دقائق';
  if (min < 60) return `بعد ${min} د`;
  return `بعد ${Math.round(min / 60)} س`;
}

/** مسار البيانات للحساب المختار — يُجلب من نفس قواعد السيرفر الفعلية. */
function DestinationBox({ d }: { d: Destination }) {
  const step = (n: number, body: ReactNode) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ flex: '0 0 20px', height: 20, borderRadius: 10, background: '#0f172a', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
      <div style={{ flex: 1 }}>{body}</div>
    </div>
  );
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 14, fontSize: 12.5, color: UI.text, lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 700, color: UI.ink }}>وين راح تروح البيانات؟</div>
      {!d.reviewer.isActive && <div style={{ color: '#b91c1c', fontWeight: 600 }}>⛔ هذا الحساب معطّل — رسائل الكروب لن تُسجَّل.</div>}
      {!d.conditionOn && <div style={{ color: '#b91c1c', fontWeight: 600 }}>⛔ ميزة «فواتير البوت ← اللكوديشن» معطّلة لهذا الحساب — لن يدخل شيء الطابور. فعّلها من «المميزات».</div>}
      {step(1, <>طابور المراجعة عند <b>{d.reviewer.name}</b> ({d.reviewer.role}){d.office ? <> — مكتب {d.office}</> : null}، بصفحة الرفع ← طلبيات البوت.</>)}
      {step(2, d.managers.length ? (
        <>
          كل سطر يتحوّل تلقائياً لمدير الشركة اللي يملك الايتم:
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {d.managers.map(m => (
              <span key={m.id} style={{ background: '#eef2ff', color: '#3730a3', borderRadius: 14, padding: '2px 9px', fontSize: 11.5 }}>
                {m.name}{m.company ? ` · ${m.company}` : ''} <span style={{ opacity: 0.7 }}>({m.items} ايتم)</span>
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 4 }}>
            {d.ownItems ? `ايتمات ${d.reviewer.name} (${d.ownItems}) والايتمات بلا مدير تبقى عنده.` : `الايتمات بلا مدير تبقى عند ${d.reviewer.name}.`}
          </div>
        </>
      ) : (
        <>كل الأسطر تبقى عند {d.reviewer.name} — لا مدراء شركات بايتمات مُسنَدة في مكتبه.</>
      ))}
      {step(3, <>
        بعد الاعتماد تُحفظ في ملف اللكوديشن المشترك
        {d.conditionFile.id
          ? <> <b>#{d.conditionFile.id}</b> «{d.conditionFile.name}» ({d.conditionFile.rows} سطر)</>
          : <> (سيُنشأ أول مرة)</>}
        {' '}— صاحبه {d.conditionFile.ownerName}. كل مدير يشوف بيه أسطر ايتمات فريقه.
      </>)}
    </div>
  );
}

const STATUS_LABEL: Record<string, { text: string; color: string; bg: string }> = {
  connected:     { text: 'متصل ✅',          color: '#16a34a', bg: '#f0fdf4' },
  awaiting_link: { text: 'بانتظار الربط',    color: '#b45309', bg: '#fffbeb' },
  reconnecting:  { text: 'يعيد الاتصال…',    color: '#b45309', bg: '#fffbeb' },
  starting:      { text: 'يبدأ…',            color: UI.muted,  bg: UI.bg },
  logged_out:    { text: 'غير مربوط',         color: '#b91c1c', bg: '#fef2f2' },
};

// «رقم الكروبات» — شريحة مخصّصة تعمل كواتساب ويب (خدمة wa-groups على السيرفر)
// لإرسال الطلبيات لكروبات المذاخر. رقم واحد لكل النظام ⇒ ماستر أدمن فقط.
// ربط كل مذخر بكروبه يتم من صفحة «إرسال للمذاخر» ← المذاخر في التطبيق.
export default function WaGroupsPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [st, setSt]         = useState<Status | null>(null);
  const [phone, setPhone]   = useState('');
  const [code, setCode]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [links, setLinks]   = useState<Record<string, ListenLink>>({});
  const [whByJid, setWhByJid] = useState<Record<string, string[]>>({});
  const [users, setUsers]   = useState<UserOption[]>([]);
  const [form, setForm]     = useState<LinkForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [pendingByJid, setPendingByJid] = useState<Record<string, PendingAt[]>>({});
  const [retryByJid, setRetryByJid] = useState<Record<string, Retrying>>({});
  const [dest, setDest] = useState<Destination | null>(null);
  const [destErr, setDestErr] = useState('');

  const load = useCallback(() => {
    fetch('/api/sa/wa-groups/status', { headers: H() })
      .then(r => r.json()).then(setSt).catch(() => setSt({ error: 'تعذّر الاتصال بالسيرفر' }));
  }, [H]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!st?.connected || groups) return;
    fetch('/api/sa/wa-groups/groups', { headers: H() }).then(r => r.json()).then(d => setGroups(d.groups || [])).catch(() => {});
  }, [st?.connected, groups, H]);
  useEffect(() => { if (st?.connected) setCode(''); }, [st?.connected]);

  const loadLinks = useCallback(() => {
    fetch('/api/sa/wa-groups/links', { headers: H() }).then(r => r.json()).then(d => {
      if (!d.success) return;
      setLinks(Object.fromEntries((d.links as ListenLink[]).map(l => [l.jid, l])));
      setWhByJid(d.warehouses || {});
      setPendingByJid(d.pending || {});
      setRetryByJid(d.retrying || {});
    }).catch(() => {});
  }, [H]);

  // مسار البيانات يتبع الحساب المختار في النافذة
  const formUserId = form?.userId;
  useEffect(() => {
    setDest(null); setDestErr('');
    if (!formUserId) return;
    let alive = true;
    fetch(`/api/sa/wa-groups/destination?userId=${formUserId}`, { headers: H() })
      .then(r => r.json())
      .then(d => { if (alive) d.success ? setDest(d) : setDestErr(d.error || 'تعذّر جلب المسار'); })
      .catch(() => { if (alive) setDestErr('تعذّر جلب المسار'); });
    return () => { alive = false; };
  }, [formUserId, H]);
  useEffect(() => { if (st?.connected) loadLinks(); }, [st?.connected, loadLinks]);
  useEffect(() => {
    fetch('/api/sa/users', { headers: H() }).then(r => r.json()).then(d => { if (d.success) setUsers(d.data); }).catch(() => {});
  }, [H]);

  const putLink = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/sa/wa-groups/links', { method: 'PUT', headers: H(), body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'تعذّر الحفظ');
  };
  const saveForm = async () => {
    if (!form) return;
    if (!form.userId) { setFormError('اختر الحساب الذي تُسجَّل عليه المبيعات'); return; }
    setSaving(true); setFormError('');
    try {
      await putLink({ jid: form.jid, name: form.name, userId: form.userId, orderTextMode: form.orderTextMode, ...(form.isNew ? { isActive: true } : {}) });
      setForm(null); loadLinks();
    } catch (e: any) { setFormError(e.message); } finally { setSaving(false); }
  };
  const toggleLink = async (l: ListenLink) => {
    try { await putLink({ jid: l.jid, isActive: !l.isActive }); loadLinks(); } catch (e: any) { setError(e.message); }
  };
  const removeLink = async (l: ListenLink) => {
    if (!window.confirm(`إلغاء القراءة الصامتة لكروب «${l.name || l.jid}»؟ لن تُسجَّل رسائله بعد الآن.`)) return;
    await fetch(`/api/sa/wa-groups/links/${encodeURIComponent(l.jid)}`, { method: 'DELETE', headers: H() });
    loadLinks();
  };

  const pair = async () => {
    setBusy(true); setError(''); setCode('');
    try {
      const res = await fetch('/api/sa/wa-groups/pair', { method: 'POST', headers: H(), body: JSON.stringify({ phone }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'تعذّر طلب الكود');
      setCode(d.pairingCode || '');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const logout = async () => {
    if (!window.confirm('فصل رقم الكروبات؟ ستتوقف رسائل الكروبات حتى يُربط من جديد.')) return;
    const res = await fetch('/api/sa/wa-groups/logout', { method: 'POST', headers: H() });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'تعذّر الفصل');
    setGroups(null); load();
  };

  const label = STATUS_LABEL[st?.status || ''] || { text: st?.status ? st.status : 'الخدمة غير مشغّلة', color: '#b91c1c', bg: '#fef2f2' };
  const meNumber = st?.me ? String(st.me).split(':')[0].split('@')[0] : '';
  const fmtCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

  return (
    <div style={{ direction: 'rtl', maxWidth: 760 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: UI.ink }}>رقم الكروبات</h2>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 16, lineHeight: 1.7 }}>
        شريحة مخصّصة مربوطة كواتساب ويب، يرسل منها النظام الطلبيات لكروبات المذاخر (نص الطلبية + تصويت تم/جزئي/رفض)
        ويستقبل ردودهم وصور الفواتير. بعد الربط اختر كروب كل مذخر من التطبيق: «إرسال للمذاخر» ← المذاخر ← القناة «كروب».
      </div>

      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12.5, color: '#92400e', lineHeight: 1.7 }}>
        ⚠️ ربط غير رسمي — احتمال حظر الرقم قائم. استعمل شريحة جديدة مخصّصة فقط، لا رقم البوت الرسمي ولا رقماً شخصياً أو رقم المكتب.
      </div>

      {error && <ErrBox msg={error} />}

      <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: UI.text }}>الحالة:</span>
          <span style={{ background: label.bg, color: label.color, borderRadius: 20, padding: '3px 12px', fontSize: 12.5, fontWeight: 700 }}>{label.text}</span>
          {meNumber && <span dir="ltr" style={{ fontSize: 13, color: UI.ink, fontWeight: 600 }}>+{meNumber}</span>}
          {st?.connected && <button onClick={logout} style={{ ...btnStyle('#dc2626', true), marginInlineStart: 'auto' }}>فصل الرقم</button>}
        </div>
        {!st?.connected && st?.error && <div style={{ fontSize: 12, color: UI.faint }}>{st.error}</div>}

        {st && !st.connected && st.status && (
          <>
            <ol style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, color: UI.text, lineHeight: 1.9 }}>
              <li>اكتب رقم الشريحة واضغط «كود الربط».</li>
              <li>على الهاتف: واتساب ← ⋮ ← <b>الأجهزة المرتبطة</b> ← <b>ربط جهاز</b> ← <b>«الربط برقم الهاتف بدلاً من ذلك»</b>.</li>
              <li>أدخل الكود خلال دقيقتين — الحالة تتحوّل هنا إلى «متصل» تلقائياً.</li>
            </ol>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07XXXXXXXXX"
                style={{ padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 14, width: 200, fontFamily: 'inherit' }} />
              <button onClick={pair} disabled={busy || !phone.trim()} style={{ ...btnStyle('#1e293b'), opacity: busy || !phone.trim() ? 0.5 : 1 }}>
                {busy ? 'جاري طلب الكود…' : 'كود الربط'}
              </button>
            </div>
            {code && (
              <div style={{ textAlign: 'center', background: UI.bg, border: `1px dashed ${UI.line}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12.5, color: UI.muted, marginBottom: 6 }}>أدخل هذا الكود في واتساب على الهاتف</div>
                <div dir="ltr" style={{ fontSize: 34, fontWeight: 800, letterSpacing: 6, color: UI.ink }}>{fmtCode}</div>
                <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 6 }}>انتهت صلاحيته؟ اضغط «كود الربط» مجدداً.</div>
              </div>
            )}
          </>
        )}
      </div>

      {st?.connected && (
        <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e9edf3', borderRadius: 12, padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: UI.ink, marginBottom: 10 }}>الكروبات التي فيها الرقم ({groups?.length ?? '…'})</div>
          <div style={{ fontSize: 12, color: UI.faint, lineHeight: 1.8, marginBottom: 10 }}>
            <b>كروب مذخر</b>: يرسل له النظام الطلبيات ويقرأ ردوده — يُربط من التطبيق: «إرسال للمذاخر» ← المذاخر ← القناة «كروب».<br />
            <b>قراءة صامتة</b>: كروب مندوبين — كل طلبية/فاتورة فيه تُقرأ وتدخل طابور المراجعة ثم ملف اللكوديشن للحساب المختار (مثل بوت تلكرام)،
            والرقم <b>لا يرسل فيه أي رسالة</b>. كروب غير مربوط بأيٍّ منهما يُتجاهل كلياً.
          </div>
          {groups && groups.length === 0 && <div style={{ fontSize: 12.5, color: UI.faint }}>الرقم ليس عضواً في أي كروب بعد — اطلب من المذاخر إضافته لكروباتهم.</div>}
          {(groups || []).map(g => {
            const wh = whByJid[g.jid];
            const l = links[g.jid];
            return (
              <div key={g.jid} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 0', borderTop: `1px solid ${UI.line}`, fontSize: 13, color: UI.text }}>
                <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: UI.ink }}>{g.name}</div>
                  <div style={{ fontSize: 11.5, color: UI.faint }}>{g.size} عضو</div>
                  {l && !wh && (
                    <div style={{ fontSize: 11.5, color: UI.muted, marginTop: 3, lineHeight: 1.6 }}>
                      📥 {l.messageCount} رسالة (آخرها {ago(l.lastMessageAt)}) · ✅ {l.orderCount} دخلت المراجعة{l.orderCount ? ` (آخرها ${ago(l.lastOrderAt)})` : ''}
                      {l.attachedCount > 0 && <> · 🧾 {l.attachedCount} ثُبّتت على طلبيات المذاخر</>}
                      {l.failedCount > 0 && <span style={{ color: '#b91c1c' }}> · ❌ {l.failedCount} فشلت نهائياً</span>}
                      {retryByJid[g.jid] && (
                        <div style={{ color: '#b91c1c' }} title={retryByJid[g.jid].lastError || ''}>
                          ⚠️ {retryByJid[g.jid].count} فشلت قراءتها — تُعاد تلقائياً{retryByJid[g.jid].nextAt ? ` (المحاولة القادمة ${untilLabel(retryByJid[g.jid].nextAt!)})` : ''}
                        </div>
                      )}
                      {(pendingByJid[g.jid] || []).length > 0 && (
                        <div style={{ color: '#b45309' }}>
                          ⏳ بانتظار المراجعة: {pendingByJid[g.jid].map(p => `${p.name} (${p.count})`).join('، ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {wh ? (
                  <span style={{ background: '#eff6ff', color: '#1d4ed8', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600 }}>🚚 كروب مذخر: {wh.join('، ')}</span>
                ) : l ? (
                  <>
                    <span style={{ background: l.isActive ? '#f0fdf4' : '#fef2f2', color: l.isActive ? '#16a34a' : '#b91c1c', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600 }}>
                      🔇 قراءة صامتة ← {userLabel(l.user)}{l.isActive ? '' : ' (موقوفة)'}
                    </span>
                    <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>{ORDER_MODE_SHORT[l.orderTextMode] || ''}</span>
                    <button onClick={() => { setFormError(''); setForm({ jid: g.jid, name: g.name, userId: l.userId, orderTextMode: l.orderTextMode, isNew: false }); }} style={btnStyle('#3b82f6', true)}>تعديل</button>
                    <button onClick={() => toggleLink(l)} style={btnStyle(l.isActive ? '#d97706' : '#16a34a', true)}>{l.isActive ? 'إيقاف' : 'تفعيل'}</button>
                    <button onClick={() => removeLink(l)} style={btnStyle('#dc2626', true)}>إلغاء</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 11.5, color: UI.faint }}>غير مستخدم</span>
                    <button onClick={() => { setFormError(''); setForm({ jid: g.jid, name: g.name, orderTextMode: 'all', isNew: true }); }} style={btnStyle('#0f172a', true)}>🔇 قراءة صامتة</button>
                  </>
                )}
              </div>
            );
          })}
          {groups && <button onClick={() => { setGroups(null); loadLinks(); }} style={{ ...btnStyle('#3b82f6', true), marginTop: 10 }}>تحديث القائمة</button>}
        </div>
      )}

      {form && (
        <Modal onClose={() => setForm(null)} title={`قراءة صامتة — ${form.name}`}>
          <div style={{ fontSize: 12.5, color: UI.muted, lineHeight: 1.7, marginBottom: 14 }}>
            طلبيات وفواتير المندوبين في هذا الكروب تُقرأ بالذكاء وتدخل طابور المراجعة لهذا الحساب، وبعد الاعتماد تُضاف لملف اللكوديشن.
            الرقم لا يرد في الكروب، ولا تُرسَل هذه الطلبيات للمذاخر.
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 5 }}>الحساب الذي تُسجَّل عليه المبيعات *</label>
            <select value={form.userId ?? ''} onChange={e => setForm(f => f && ({ ...f, userId: e.target.value ? Number(e.target.value) : undefined }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', outline: 'none', color: UI.ink }}>
              <option value="">-- اختر حساباً --</option>
              {users.map(u => <option key={u.id} value={u.id}>{userLabel(u)} ({u.role})</option>)}
            </select>
          </div>
          {dest && <DestinationBox d={dest} />}
          {destErr && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>{destErr}</div>}
          <OrderTextModeField value={form.orderTextMode} onChange={v => setForm(f => f && ({ ...f, orderTextMode: v }))} />
          {formError && <ErrBox msg={formError} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setForm(null)} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveForm} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
