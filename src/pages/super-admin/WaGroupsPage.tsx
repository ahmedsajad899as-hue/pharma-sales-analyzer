import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Modal, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';
import { AI_MODES, type AiMode } from './AiModeButtons';

interface Status { status?: string; connected?: boolean; me?: string | null; error?: string | null }
interface Group { jid: string; name: string; size: number }
interface UserOption { id: number; username: string; displayName?: string | null; role: string }
interface ListenLink {
  jid: string; name: string | null; userId: number; isActive: boolean; orderTextMode: OrderTextMode; aiMode?: AiMode; user?: UserOption;
  messageCount: number; orderCount: number; attachedCount: number; failedCount: number; lastMessageAt: string | null; lastOrderAt: string | null;
  skippedCount?: number; allowedSenders?: string[] | null; knownSenders?: Record<string, KnownSender> | null;
}
interface KnownSender { name: string | null; count: number; lastAt: string }
interface LinkForm { jid: string; name: string; userId?: number; orderTextMode: OrderTextMode; isNew: boolean; senders: string[]; known: Record<string, KnownSender> }
interface WarehouseOption { id: number; name: string; province: string | null; phone: string; channel: string; groupJid: string | null; owner: string | null }
interface WhSwitches { send: boolean; read: boolean }
interface WhForm { jid: string; name: string; warehouseId?: number; q: string }
interface PendingAt { userId: number; name: string; count: number }
interface Retrying { count: number; nextAt: number | null; lastError: string | null; queueFull?: boolean }
interface Destination {
  reviewer: { id: number; name: string; role: string; isActive: boolean };
  office: string | null;
  conditionOn: boolean;
  ownItems: number;
  managers: { id: number; name: string; company: string | null; items: number }[];
  conditionFile: { ownerName: string; id: number | null; name: string | null; rows: number };
}

/** «+9647…» أو «رقم مخفي» لمعرّف LID — واتساب لا يكشف الرقم في بعض الكروبات. */
const senderLabel = (key: string) => key.startsWith('lid:') ? `رقم مخفي …${key.slice(-4)}` : `+${key}`;

/** من تُحلَّل رسائله: الكل، أو أشخاص مختارون ممن كتبوا في الكروب / رقم يُكتب يدوياً. */
function SendersField({ value, known, onChange }: { value: string[]; known: Record<string, KnownSender>; onChange: (v: string[]) => void }) {
  const [restrict, setRestrict] = useState(value.length > 0);
  const [manual, setManual] = useState('');
  const rows: [string, KnownSender][] = Object.entries(known).sort((a, b) => b[1].count - a[1].count);
  for (const k of value) if (!known[k]) rows.push([k, { name: null, count: 0, lastAt: '' }]);
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  const addManual = () => {
    let d = manual.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (/^07\d{9}$/.test(d)) d = '964' + d.slice(1);
    if (d.length < 8) return;
    if (!value.includes(d)) onChange([...value, d]);
    setManual('');
  };
  const radio = (on: boolean, label: string, click: () => void) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: UI.text, cursor: 'pointer' }}>
      <input type="radio" checked={on} onChange={click} /> {label}
    </label>
  );
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 6 }}>الأشخاص الذين تُحلَّل طلبياتهم</label>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        {radio(!restrict, 'كل أعضاء الكروب', () => { setRestrict(false); onChange([]); })}
        {radio(restrict, 'أشخاص محدّدون فقط', () => setRestrict(true))}
      </div>
      {restrict && (
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
          {rows.length === 0 && <div style={{ fontSize: 12, color: UI.muted, marginBottom: 8 }}>لا أحد بعد — أضف رقماً يدوياً.</div>}
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rows.map(([k, v]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: UI.text, cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={value.includes(k)} onChange={() => toggle(k)} />
                <span style={{ fontWeight: 600, color: UI.ink }}>{v.name || '—'}</span>
                <span dir="ltr" style={{ color: UI.muted, fontSize: 11.5 }}>{senderLabel(k)}</span>
                {v.count > 0 && <span style={{ color: UI.faint, fontSize: 11, marginInlineStart: 'auto' }}>{v.count} رسالة · {ago(v.lastAt)}</span>}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input dir="ltr" value={manual} onChange={e => setManual(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} placeholder="07XXXXXXXXX"
              style={{ padding: '6px 10px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13, width: 160, fontFamily: 'inherit' }} />
            <button type="button" onClick={addManual} style={btnStyle('#3b82f6', true)}>إضافة رقم</button>
          </div>
          {value.length === 0 && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 6 }}>لم تختر أحداً — سيُحفظ كـ«كل الأعضاء».</div>}
        </div>
      )}
    </div>
  );
}

// ─── عناصر مدمجة للصفحة ──────────────────────────────────────────────────────

const ghost = (color: string = UI.text): CSSProperties => ({
  padding: '4px 10px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  border: `1px solid ${UI.line}`, background: '#fff', color, whiteSpace: 'nowrap', lineHeight: 1.4,
});

const tag = (color: string, bg: string): CSSProperties => ({
  display: 'inline-block', fontSize: 11, fontWeight: 600, color, background: bg, borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap',
});

/** مفتاح تشغيل/إطفاء. */
function Toggle({ on, label, title, onToggle }: { on: boolean; label: string; title: string; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} title={title} aria-pressed={on}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: on ? UI.ink : UI.faint }}>
      <span style={{ position: 'relative', width: 26, height: 14, borderRadius: 7, background: on ? '#16a34a' : '#cbd5e1', flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, insetInlineStart: on ? 14 : 2, width: 10, height: 10, borderRadius: '50%', background: '#fff', transition: 'inset-inline-start .15s' }} />
      </span>
      {label}
    </button>
  );
}

const AI_SHORT: Record<AiMode, { label: string; title: string }> = {
  both:   { label: 'الاثنين', title: 'المحلل أولاً، وما لا يحسمه يذهب للذكاء' },
  parser: { label: 'المحلل',  title: 'بلا ذكاء: الطلبيات الواضحة فقط' },
  ai:     { label: 'الذكاء',  title: 'Gemini لكل رسالة' },
  off:    { label: 'إطفاء',   title: 'لا تحليل لأي رسالة' },
};

/** وضع تحليل طلبيات كروب المندوبين — نسخة مدمجة. */
function AiSeg({ value, onChange }: { value?: string | null; onChange: (v: AiMode) => Promise<unknown> }) {
  const cur: AiMode = (AI_MODES as readonly string[]).includes(value || '') ? (value as AiMode) : 'both';
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${UI.line}`, borderRadius: 7, overflow: 'hidden', opacity: busy ? 0.6 : 1 }}>
      {AI_MODES.map((m, i) => {
        const on = m === cur;
        return (
          <button key={m} type="button" title={AI_SHORT[m].title} disabled={busy}
            onClick={async () => { if (on) return; setBusy(true); try { await onChange(m); } finally { setBusy(false); } }}
            style={{
              padding: '3px 9px', fontSize: 11.5, fontWeight: 600, border: 'none', fontFamily: 'inherit',
              borderInlineStart: i ? `1px solid ${UI.line}` : 'none', cursor: on ? 'default' : 'pointer',
              background: on ? (m === 'off' ? '#dc2626' : '#1e293b') : '#fff', color: on ? '#fff' : UI.muted,
            }}>
            {AI_SHORT[m].label}
          </button>
        );
      })}
    </div>
  );
}

/** قسم بعنوان وعدّاد. */
function Section({ title, count, accent, children }: { title: string; count: number; accent: string; children: ReactNode }) {
  return (
    <section style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, overflow: 'hidden', minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${UI.line}`, borderTop: `3px solid ${accent}` }}>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: UI.ink }}>{title}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: UI.muted, background: UI.bg, borderRadius: 10, padding: '1px 8px' }}>{count}</span>
      </header>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <div style={{ fontSize: 12, color: UI.faint, padding: '10px 4px', textAlign: 'center' }}>{text}</div>;

/** بطاقة كروب: الاسم + الإجراءات في السطر الأول، والتفاصيل تحته. */
function GroupCard({ g, dim, actions, children }: { g: Group; dim?: boolean; actions: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ border: `1px solid ${UI.line}`, borderRadius: 10, padding: '9px 12px', background: dim ? UI.bg : '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: dim ? UI.muted : UI.ink }}>{g.name}</span>
          <span style={{ fontSize: 11, color: UI.faint, marginInlineStart: 6 }}>{g.size} عضو</span>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{actions}</div>
      </div>
      {children && <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>}
    </div>
  );
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
// نوع كل كروب يُحدَّد هنا: كروب مذخر (يرسل ويستقبل) أو كروب مندوبين (قراءة صامتة فقط).
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
  const [whSw, setWhSw] = useState<Record<string, WhSwitches>>({});
  const [users, setUsers]   = useState<UserOption[]>([]);
  const [form, setForm]     = useState<LinkForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [pendingByJid, setPendingByJid] = useState<Record<string, PendingAt[]>>({});
  const [retryByJid, setRetryByJid] = useState<Record<string, Retrying>>({});
  const [dest, setDest] = useState<Destination | null>(null);
  const [destErr, setDestErr] = useState('');
  const [whList, setWhList] = useState<WarehouseOption[] | null>(null);
  const [whForm, setWhForm] = useState<WhForm | null>(null);

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
      setWhSw(d.warehouseSwitches || {});
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
      await putLink({ jid: form.jid, name: form.name, userId: form.userId, orderTextMode: form.orderTextMode, allowedSenders: form.senders, ...(form.isNew ? { isActive: true } : {}) });
      setForm(null); loadLinks();
    } catch (e: any) { setFormError(e.message); } finally { setSaving(false); }
  };
  const toggleLink = async (l: ListenLink) => {
    try { await putLink({ jid: l.jid, isActive: !l.isActive }); loadLinks(); } catch (e: any) { setError(e.message); }
  };
  const setAiMode = async (l: ListenLink, aiMode: AiMode) => {
    try { await putLink({ jid: l.jid, aiMode }); await loadLinks(); } catch (e: any) { setError(e.message); }
  };
  const removeLink = async (l: ListenLink) => {
    if (!window.confirm(`إلغاء القراءة الصامتة لكروب «${l.name || l.jid}»؟ لن تُسجَّل رسائله بعد الآن.`)) return;
    await fetch(`/api/sa/wa-groups/links/${encodeURIComponent(l.jid)}`, { method: 'DELETE', headers: H() });
    loadLinks();
  };

  const openWhForm = (g: Group) => {
    setFormError('');
    setWhForm({ jid: g.jid, name: g.name, q: '' });
    if (!whList) fetch('/api/sa/wa-groups/warehouses', { headers: H() }).then(r => r.json()).then(d => { if (d.success) setWhList(d.warehouses); }).catch(() => setWhList([]));
  };
  const saveWhForm = async () => {
    if (!whForm?.warehouseId) { setFormError('اختر المذخر'); return; }
    setSaving(true); setFormError('');
    try {
      const res = await fetch('/api/sa/wa-groups/warehouse-link', { method: 'PUT', headers: H(), body: JSON.stringify({ jid: whForm.jid, groupName: whForm.name, warehouseId: whForm.warehouseId }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'تعذّر الحفظ');
      setWhForm(null); setWhList(null); loadLinks();
    } catch (e: any) { setFormError(e.message); } finally { setSaving(false); }
  };
  const setWhSwitch = async (g: Group, key: keyof WhSwitches, on: boolean) => {
    const prev = whSw[g.jid];
    setWhSw(m => ({ ...m, [g.jid]: { ...(m[g.jid] || { send: true, read: true }), [key]: on } }));
    const res = await fetch(`/api/sa/wa-groups/warehouse-link/${encodeURIComponent(g.jid)}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ [key]: on }) });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || 'تعذّر الحفظ');
      setWhSw(m => ({ ...m, [g.jid]: prev }));
    }
  };
  const unlinkWarehouse = async (g: Group, names: string[]) => {
    if (!window.confirm(`فصل كروب «${g.name}» عن المذخر «${names.join('، ')}»؟ لن تُرسل له الطلبيات في هذا الكروب بعد الآن.`)) return;
    const res = await fetch(`/api/sa/wa-groups/warehouse-link/${encodeURIComponent(g.jid)}`, { method: 'DELETE', headers: H() });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'تعذّر الفصل');
    setWhList(null); loadLinks();
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

  const all = groups || [];
  const whGroups = all.filter(g => whByJid[g.jid]);
  const repGroups = all.filter(g => !whByJid[g.jid] && links[g.jid]);
  const untyped = all.filter(g => !whByJid[g.jid] && !links[g.jid]);
  const openRepForm = (g: Group, l?: ListenLink) => {
    setFormError('');
    setForm(l
      ? { jid: g.jid, name: g.name, userId: l.userId, orderTextMode: l.orderTextMode, isNew: false, senders: l.allowedSenders || [], known: l.knownSenders || {} }
      : { jid: g.jid, name: g.name, orderTextMode: 'all', isNew: true, senders: [], known: {} });
  };

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      {/* شريط الحالة */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: '10px 14px', marginBottom: 12 }}>
        <span style={{ background: label.bg, color: label.color, borderRadius: 20, padding: '2px 10px', fontSize: 11.5, fontWeight: 700 }}>{label.text}</span>
        {meNumber && <span dir="ltr" style={{ fontSize: 12.5, color: UI.text, fontWeight: 600 }}>+{meNumber}</span>}
        {st?.connected && (
          <div style={{ display: 'flex', gap: 6, marginInlineStart: 'auto' }}>
            <button onClick={() => { setGroups(null); loadLinks(); }} style={ghost()}>تحديث</button>
            <button onClick={logout} style={ghost('#dc2626')}>فصل الرقم</button>
          </div>
        )}
      </div>

      {error && <ErrBox msg={error} />}

      {/* الربط */}
      {st && !st.connected && (
        <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {st.error && <div style={{ fontSize: 12, color: UI.faint }}>{st.error}</div>}
          {st.status && (
            <>
              <div style={{ fontSize: 12.5, color: UI.muted }}>واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07XXXXXXXXX"
                  style={{ padding: '7px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, width: 190, maxWidth: '100%', fontFamily: 'inherit' }} />
                <button onClick={pair} disabled={busy || !phone.trim()} style={{ ...btnStyle('#1e293b', true), opacity: busy || !phone.trim() ? 0.5 : 1 }}>
                  {busy ? '…' : 'كود الربط'}
                </button>
              </div>
              {code && <div dir="ltr" style={{ fontSize: 28, fontWeight: 800, letterSpacing: 5, color: UI.ink, textAlign: 'center', background: UI.bg, borderRadius: 10, padding: 12 }}>{fmtCode}</div>}
            </>
          )}
        </div>
      )}

      {st?.connected && (
        <>
          {groups && groups.length === 0 && <Empty text="الرقم ليس عضواً في أي كروب" />}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 12, alignItems: 'start' }}>
            <Section title="كروبات المذاخر" count={whGroups.length} accent="#2563eb">
              {!groups && <Empty text="جاري التحميل…" />}
              {groups && !whGroups.length && <Empty text="لا يوجد" />}
              {whGroups.map(g => {
                const wh = whByJid[g.jid];
                const sw = whSw[g.jid] || { send: true, read: true };
                const stopped = !sw.send && !sw.read;
                return (
                  <GroupCard key={g.jid} g={g} dim={stopped} actions={<>
                    <button onClick={() => openWhForm(g)} style={ghost()}>تغيير</button>
                    <button onClick={() => unlinkWarehouse(g, wh)} style={ghost('#dc2626')}>فصل</button>
                  </>}>
                    <div style={{ fontSize: 12, color: UI.muted }}>
                      المذخر: <b style={{ color: UI.text }}>{wh.join('، ')}</b>
                      {stopped && <span style={{ ...tag('#b91c1c', '#fef2f2'), marginInlineStart: 6 }}>متوقف</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Toggle on={sw.send} label="إرسال الطلبيات" title="مطفأ = لا تُرسل أي طلبية لهذا الكروب عبر البوت" onToggle={() => setWhSwitch(g, 'send', !sw.send)} />
                      <Toggle on={sw.read} label="تحليل الفواتير" title="مطفأ = لا يُقرأ أي شيء ينزل في الكروب" onToggle={() => setWhSwitch(g, 'read', !sw.read)} />
                    </div>
                  </GroupCard>
                );
              })}
            </Section>

            <Section title="كروبات المندوبين" count={repGroups.length} accent="#16a34a">
              {!groups && <Empty text="جاري التحميل…" />}
              {groups && !repGroups.length && <Empty text="لا يوجد" />}
              {repGroups.map(g => {
                const l = links[g.jid];
                const retry = retryByJid[g.jid];
                const pending = pendingByJid[g.jid] || [];
                const limited = (l.allowedSenders?.length ?? 0) > 0;
                return (
                  <GroupCard key={g.jid} g={g} dim={!l.isActive} actions={<>
                    <button onClick={() => openRepForm(g, l)} style={ghost()}>تعديل</button>
                    <button onClick={() => toggleLink(l)} style={ghost(l.isActive ? '#b45309' : '#16a34a')}>{l.isActive ? 'إيقاف' : 'تفعيل'}</button>
                    <button onClick={() => removeLink(l)} style={ghost('#dc2626')}>إلغاء</button>
                  </>}>
                    <div style={{ fontSize: 12, color: UI.muted, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>الحساب: <b style={{ color: UI.text }}>{userLabel(l.user)}</b></span>
                      {!l.isActive && <span style={tag('#b91c1c', '#fef2f2')}>موقوف</span>}
                      <span style={tag('#6d28d9', '#f5f3ff')}>{(ORDER_MODE_SHORT[l.orderTextMode] || '').replace('طلبيات: ', '')}</span>
                      {limited && <span style={tag(UI.text, UI.bg)}>{l.allowedSenders!.length} أشخاص فقط</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: UI.muted }}>
                      {l.messageCount} رسالة · {l.orderCount} طلبية{l.attachedCount > 0 ? ` · ${l.attachedCount} مثبّتة` : ''}
                      {limited && l.skippedCount ? ` · ${l.skippedCount} متجاهلة` : ''} · آخر رسالة {ago(l.lastMessageAt)}
                    </div>
                    {(l.failedCount > 0 || retry || pending.length > 0) && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {pending.length > 0 && <span style={tag('#b45309', '#fffbeb')} title={pending.map(p => `${p.name} (${p.count})`).join('، ')}>بانتظار المراجعة {pending.reduce((n, p) => n + p.count, 0)}</span>}
                        {retry && <span style={tag('#b91c1c', '#fef2f2')} title={retry.lastError || ''}>{retry.queueFull ? 'الطابور ممتلئ' : 'تُعاد'} {retry.count}{retry.nextAt ? ` · ${untilLabel(retry.nextAt)}` : ''}</span>}
                        {l.failedCount > 0 && <span style={tag('#b91c1c', '#fef2f2')}>فشلت {l.failedCount}</span>}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11.5, color: UI.muted }}>التحليل</span>
                      <AiSeg value={l.aiMode} onChange={v => setAiMode(l, v)} />
                    </div>
                  </GroupCard>
                );
              })}
            </Section>
          </div>

          {untyped.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Section title="كروبات غير مصنّفة" count={untyped.length} accent="#94a3b8">
                {untyped.map(g => (
                  <GroupCard key={g.jid} g={g} actions={<>
                    <button onClick={() => openWhForm(g)} style={ghost('#2563eb')}>كروب مذخر</button>
                    <button onClick={() => openRepForm(g)} style={ghost('#16a34a')}>كروب مندوبين</button>
                  </>} />
                ))}
              </Section>
            </div>
          )}
        </>
      )}

      {form && (
        <Modal onClose={() => setForm(null)} title={`كروب مندوبين · ${form.name}`}>
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
          <SendersField value={form.senders} known={form.known} onChange={v => setForm(f => f && ({ ...f, senders: v }))} />
          {formError && <ErrBox msg={formError} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setForm(null)} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveForm} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}

      {whForm && (() => {
        const q = whForm.q.trim().toLowerCase();
        const list = (whList || []).filter(w => !q || `${w.name} ${w.province || ''} ${w.owner || ''}`.toLowerCase().includes(q));
        return (
          <Modal onClose={() => setWhForm(null)} title={`كروب مذخر · ${whForm.name}`}>
            <input value={whForm.q} onChange={e => setWhForm(f => f && ({ ...f, q: e.target.value }))} placeholder="بحث باسم المذخر أو المحافظة…" autoFocus
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', marginBottom: 8, fontFamily: 'inherit' }} />
            <div style={{ maxHeight: 320, overflowY: 'auto', border: `1px solid ${UI.line}`, borderRadius: 10 }}>
              {!whList && <div style={{ padding: 12, fontSize: 12.5, color: UI.faint }}>جاري التحميل…</div>}
              {whList && !list.length && <div style={{ padding: 12, fontSize: 12.5, color: UI.faint }}>لا يوجد مذخر بهذا الاسم</div>}
              {list.map(w => {
                const other = w.groupJid && w.groupJid !== whForm.jid;
                return (
                  <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: `1px solid ${UI.line}`, cursor: 'pointer', fontSize: 13, background: whForm.warehouseId === w.id ? '#eff6ff' : undefined }}>
                    <input type="radio" checked={whForm.warehouseId === w.id} onChange={() => setWhForm(f => f && ({ ...f, warehouseId: w.id }))} />
                    <span style={{ fontWeight: 600, color: UI.ink }}>{w.name}</span>
                    {w.province && <span style={{ fontSize: 11.5, color: UI.muted }}>{w.province}</span>}
                    <span style={{ fontSize: 11, color: UI.faint, marginInlineStart: 'auto' }}>
                      {other ? 'مربوط بكروب آخر' : w.groupJid === whForm.jid ? 'الحالي' : ''}{w.owner ? ` · ${w.owner}` : ''}
                    </span>
                  </label>
                );
              })}
            </div>
            {formError && <ErrBox msg={formError} />}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setWhForm(null)} style={btnStyle('#6b7280', true)}>إلغاء</button>
              <button onClick={saveWhForm} disabled={saving} style={btnStyle('#1d4ed8', true)}>{saving ? '...' : 'حفظ'}</button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
