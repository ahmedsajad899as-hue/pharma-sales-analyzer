import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';
import { type AiMode } from './AiModeButtons';
import { Bar, Section, Card, Toggle, AiSeg, Empty, ghost, solid, inputSm, TAG, cardGrid } from './saKit';

interface TgPerson { telegramUserId: string; firstName?: string | null; lastName?: string | null; username?: string | null; status?: string; lastSeenAt?: string; joinedAt?: string | null }
interface MembersInfo { memberCount: number | null; admins: TgPerson[] | null; seen: TgPerson[]; links: Record<string, number>; reps: { id: number; name: string }[] }
const personName = (p: TgPerson) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.username || p.telegramUserId;

interface UserOption { id: number; username: string; displayName?: string; role: string }
interface TelegramLink {
  id: number; chatId: string; chatTitle?: string | null; isActive: boolean; userId: number;
  orderTextMode?: OrderTextMode;
  salesQueryEnabled?: boolean;
  silentMode?: boolean;
  aiMode?: AiMode;
  user?: UserOption;
}

const EMPTY: Partial<TelegramLink> = { chatId: '', chatTitle: '', userId: undefined, orderTextMode: 'trigger', salesQueryEnabled: true, silentMode: false };

// صفحة إدارة كروبات تلكرام المربوطة بحسابات — أي ملف Excel يُرسل بكروب مربوط
// يُستورَد تلقائياً لحساب المستخدم المختار (راجع server/modules/telegram/).
// اكتشاف رقم الكروب: أضف البوت للكروب وأرسل فيه أي ملف — يرد البوت برقمه إن
// كان غير مربوط بعد، الصقه هنا.
export default function TelegramLinksPage() {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [links, setLinks]     = useState<TelegramLink[]>([]);
  const [users, setUsers]     = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm]       = useState<Partial<TelegramLink> | null>(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
    const [membersFor, setMembersFor] = useState<TelegramLink | null>(null);
  const [members, setMembers]       = useState<MembersInfo | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [q, setQ] = useState('');

  const setPersonRep = async (p: TgPerson, userId: string) => {
    if (!membersFor) return;
    await fetch(`/api/sa/telegram-links/${membersFor.id}/members/${p.telegramUserId}/rep`, {
      method: 'PUT', headers: H(),
      body: JSON.stringify({ userId: userId ? Number(userId) : null, firstName: p.firstName, lastName: p.lastName, username: p.username }),
    });
    openMembers(membersFor);
  };

  const RepSelect = ({ p }: { p: TgPerson }) => (
    <select
      value={members?.links?.[p.telegramUserId] ?? ''}
      onChange={e => setPersonRep(p, e.target.value)}
      style={{ ...inputSm, padding: '2px 6px', fontSize: 12 }}
    >
      <option value="">— بلا مندوب —</option>
      {(members?.reps ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );

  const openMembers = (l: TelegramLink) => {
    setMembersFor(l); setMembers(null); setMembersLoading(true);
    fetch(`/api/sa/telegram-links/${l.id}/members`, { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setMembers(d.data); })
      .finally(() => setMembersLoading(false));
  };

  const load = () => {
    setLoading(true);
    fetch('/api/sa/telegram-links', { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setLinks(d.data); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => {
    fetch('/api/sa/users', { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setUsers(d.data); });
  }, []);

  const save = async () => {
    if (!form?.chatId?.trim()) { setError('رقم الكروب (chatId) مطلوب'); return; }
    if (!form?.userId) { setError('اختر الحساب المرتبط'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const res = await fetch(isEdit ? `/api/sa/telegram-links/${form.id}` : '/api/sa/telegram-links', {
      method: isEdit ? 'PUT' : 'POST',
      headers: H(),
      body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
  };

  const toggle = async (l: TelegramLink) => {
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !l.isActive }) });
    load();
  };

  const toggleSalesQuery = async (l: TelegramLink) => {
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ salesQueryEnabled: !(l.salesQueryEnabled ?? true) }) });
    load();
  };

  const toggleSilent = async (l: TelegramLink) => {
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ silentMode: !l.silentMode }) });
    load();
  };

  const setAiMode = async (l: TelegramLink, aiMode: AiMode) => {
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ aiMode }) });
    await load();
  };

  const del = async (l: TelegramLink) => {
    if (!confirm(`حذف ربط الكروب "${l.chatTitle || l.chatId}"؟`)) return;
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'DELETE', headers: H() });
    load();
  };

  const userLabel = (u?: UserOption) => u ? (u.displayName || u.username) : '—';
  const qq = q.trim().toLowerCase();
  const shown = links.filter(l => !qq || `${l.chatTitle || ''} ${l.chatId} ${userLabel(l.user)}`.toLowerCase().includes(qq));
  const active = links.filter(l => l.isActive).length;

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      <Bar end={<button onClick={() => setForm(EMPTY)} style={solid()}>+ ربط كروب</button>}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث بالاسم أو الرقم أو الحساب…" style={{ ...inputSm, width: 240 }} />
        <span style={TAG.ok}>{active} نشط</span>
        {links.length > active && <span style={TAG.mute}>{links.length - active} معطّل</span>}
      </Bar>

      {loading ? <Spinner /> : (
        <Section title="كروبات تلكرام" count={shown.length} accent="#0ea5e9">
          {!shown.length && <Empty text={links.length ? 'لا نتائج' : 'لا توجد كروبات مربوطة'} />}
          <div style={cardGrid}>
            {shown.map(l => {
              const sales = l.salesQueryEnabled ?? true;
              return (
                <Card key={l.id} dim={!l.isActive} title={l.chatTitle || 'بلا تسمية'} meta={<span dir="ltr">{l.chatId}</span>} actions={<>
                  <button onClick={() => setForm({ ...l })} style={ghost()}>تعديل</button>
                  <button onClick={() => openMembers(l)} style={ghost()}>الأعضاء</button>
                  <button onClick={() => del(l)} style={ghost('#dc2626')}>حذف</button>
                </>}>
                  <div style={{ fontSize: 12, color: UI.muted, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span>الحساب: <b style={{ color: UI.text }}>{userLabel(l.user)}</b></span>
                    <span style={TAG.violet}>{ORDER_MODE_SHORT[(l.orderTextMode || 'trigger') as OrderTextMode].replace('طلبيات: ', '')}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <Toggle on={l.isActive} label="نشط" onToggle={() => toggle(l)} />
                    <Toggle on={sales} label="سؤال المبيعات" title="«فلان مبيع شهر 9» ⇒ يرد بمبيعاته" onToggle={() => toggleSalesQuery(l)} />
                    <Toggle on={!l.silentMode} label="الردود" title="مطفأ = يعالج بصمت ولا يرد" onToggle={() => toggleSilent(l)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: UI.muted }}>التحليل</span>
                    <AiSeg value={l.aiMode} onChange={v => setAiMode(l, v)} />
                  </div>
                </Card>
              );
            })}
          </div>
        </Section>
      )}

      {membersFor && (
        <Modal onClose={() => setMembersFor(null)} title={membersFor.chatTitle || membersFor.chatId}>
          {membersLoading ? <Spinner /> : !members ? <div style={{ color: UI.faint }}>تعذّر الجلب</div> : (() => {
            const known = new Set([...(members.admins ?? []), ...members.seen].map(p => p.telegramUserId));
            const unknown = members.memberCount == null ? 0 : Math.max(0, members.memberCount - 1 - known.size); // -1 = البوت نفسه
            const row = (p: TgPerson, sub: string) => (
              <div key={p.telegramUserId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${UI.bg}`, fontSize: 12.5, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: UI.ink }}>{personName(p)}</span>
                {p.username && <span dir="ltr" style={{ color: UI.faint, fontSize: 11.5 }}>@{p.username}</span>}
                <span style={{ color: UI.faint, fontSize: 11 }}>{sub}</span>
                <span style={{ marginInlineStart: 'auto' }}><RepSelect p={p} /></span>
              </div>
            );
            return (
              <div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={TAG.mute}>الأعضاء {members.memberCount ?? '—'}</span>
                  {unknown > 0 && <span style={TAG.warn} title="أسماؤهم تظهر حين يكتبون">{unknown} لم يكتبوا بعد</span>}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: UI.muted, margin: '4px 0' }}>المشرفون</div>
                {members.admins === null && <div style={{ fontSize: 12, color: UI.faint }}>تعذّر الجلب</div>}
                {(members.admins ?? []).map(a => row(a, a.status === 'creator' ? 'المالك' : 'مشرف'))}
                <div style={{ fontSize: 11.5, fontWeight: 700, color: UI.muted, margin: '10px 0 4px' }}>ظهروا بالكروب ({members.seen.length})</div>
                {members.seen.length === 0 && <div style={{ fontSize: 12, color: UI.faint }}>لا أحد بعد</div>}
                {members.seen.map(m => row(m, m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString('ar-IQ') : ''))}
              </div>
            );
          })()}
        </Modal>
      )}

      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل الربط' : 'ربط كروب جديد'}>
          <Field label="رقم الكروب (chat_id) *" value={form.chatId || ''} onChange={v => setForm(f => ({ ...f!, chatId: v }))} placeholder="مثال: -1001234567890" />
          <Field label="تسمية (اختياري)" value={form.chatTitle || ''} onChange={v => setForm(f => ({ ...f!, chatTitle: v }))} placeholder="مثال: مبيعات بغداد" />
          <OrderTextModeField value={form.orderTextMode} onChange={v => setForm(f => ({ ...f!, orderTextMode: v }))} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.salesQueryEnabled ?? true}
              onChange={e => setForm(f => ({ ...f!, salesQueryEnabled: e.target.checked }))}
            />
            سؤال المبيعات («فلان مبيع شهر 9»)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.silentMode ?? false}
              onChange={e => setForm(f => ({ ...f!, silentMode: e.target.checked }))}
            />
            صمت كامل (لا يرد بأي رسالة)
          </label>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 5 }}>الحساب المرتبط *</label>
            <select
              value={form.userId ?? ''}
              onChange={e => setForm(f => ({ ...f!, userId: e.target.value ? Number(e.target.value) : undefined }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', outline: 'none', color: UI.ink }}
            >
              <option value="">-- اختر حساباً --</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{userLabel(u)} ({u.role})</option>
              ))}
            </select>
          </div>
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => { setForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={save} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
