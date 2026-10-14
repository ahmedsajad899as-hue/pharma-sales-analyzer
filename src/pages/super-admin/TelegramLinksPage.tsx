import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';

interface TgPerson { telegramUserId: string; firstName?: string | null; lastName?: string | null; username?: string | null; status?: string; lastSeenAt?: string; joinedAt?: string | null }
interface MembersInfo { memberCount: number | null; admins: TgPerson[] | null; seen: TgPerson[] }
const personName = (p: TgPerson) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.username || p.telegramUserId;

interface UserOption { id: number; username: string; displayName?: string; role: string }
interface TelegramLink {
  id: number; chatId: string; chatTitle?: string | null; isActive: boolean; userId: number;
  orderTextMode?: OrderTextMode;
  salesQueryEnabled?: boolean;
  silentMode?: boolean;
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
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [membersFor, setMembersFor] = useState<TelegramLink | null>(null);
  const [members, setMembers]       = useState<MembersInfo | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);

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

  const del = async (l: TelegramLink) => {
    if (!confirm(`حذف ربط الكروب "${l.chatTitle || l.chatId}"؟`)) return;
    await fetch(`/api/sa/telegram-links/${l.id}`, { method: 'DELETE', headers: H() });
    load();
  };

  const userLabel = (u?: UserOption) => u ? (u.displayName || u.username) : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: UI.ink }}>روابط تيليجرام</h2>
        <button onClick={() => setForm(EMPTY)} style={btnStyle('#1e293b')}>+ ربط كروب جديد</button>
      </div>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 18, lineHeight: 1.6 }}>
        أي ملف Excel يُرسَل بكروب مربوط يُستورَد تلقائياً لحساب المستخدم المختار له.
        لمعرفة رقم كروب جديد: أضف البوت له وأرسل أي ملف — يرد البوت برقم الكروب
        إن لم يكن مربوطاً بعد. «سؤال المبيعات» يسمح بكتابة مثل «محمد باقر مبيع
        شهر 9» في الكروب فيردّ البوت بمبيعات ذلك المندوب لذلك الشهر (مكتب + ميركاتو).
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(270px,1fr))', gap: 12 }}>
          {links.map(l => (
            <div key={l.id} style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: UI.ink }}>{l.chatTitle || 'بلا تسمية'}</div>
                  <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 2 }}>chat_id: {l.chatId}</div>
                  <div style={{ fontSize: 11.5, color: UI.faint }}>الحساب: {userLabel(l.user)}</div>
                  <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 3, fontWeight: 600 }}>
                    {ORDER_MODE_SHORT[(l.orderTextMode || 'trigger') as OrderTextMode]}
                  </div>
                  <div style={{ fontSize: 11, color: (l.salesQueryEnabled ?? true) ? '#0891b2' : '#94a3b8', marginTop: 3, fontWeight: 600 }}>
                    {(l.salesQueryEnabled ?? true) ? '📊 سؤال المبيعات: مفعّل' : '📊 سؤال المبيعات: معطّل'}
                  </div>
                  <div style={{ fontSize: 11, color: l.silentMode ? '#be123c' : '#94a3b8', marginTop: 3, fontWeight: 600 }}>
                    {l.silentMode ? '🔇 صامت (لا ردود)' : '🔔 يرد على الرسائل'}
                  </div>
                </div>
                <span style={{ background: l.isActive ? '#f0fdf4' : '#fef2f2', color: l.isActive ? '#16a34a' : '#b91c1c', borderRadius: 20, padding: '2px 9px', fontSize: 10.5, fontWeight: 600 }}>
                  {l.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
                <button onClick={() => setForm({ ...l })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => openMembers(l)} style={btnStyle('#0f766e', true)}>👥 الأعضاء</button>
                <button onClick={() => setMenuFor(menuFor === l.id ? null : l.id)} style={btnStyle('#475569', true)}>⋯ المزيد ▾</button>
                {menuFor === l.id && (
                  <>
                    <div onClick={() => setMenuFor(null)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{ position: 'absolute', top: '100%', insetInlineEnd: 0, marginTop: 4, zIndex: 41, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.12)', minWidth: 190, overflow: 'hidden' }}>
                      {[
                        { label: l.isActive ? '⏸ تعطيل الربط' : '▶ تفعيل الربط', color: l.isActive ? '#d97706' : '#16a34a', run: () => toggle(l) },
                        { label: (l.salesQueryEnabled ?? true) ? '📊 تعطيل سؤال المبيعات' : '📊 تفعيل سؤال المبيعات', color: '#0891b2', run: () => toggleSalesQuery(l) },
                        { label: l.silentMode ? '🔔 إلغاء الصمت' : '🔇 جعله صامتاً', color: l.silentMode ? '#16a34a' : '#be123c', run: () => toggleSilent(l) },
                        { label: '🗑 حذف', color: '#dc2626', run: () => del(l) },
                      ].map(it => (
                        <button key={it.label} onClick={() => { setMenuFor(null); it.run(); }}
                          style={{ display: 'block', width: '100%', textAlign: 'start', padding: '9px 14px', background: 'none', border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: it.color }}>
                          {it.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
          {links.length === 0 && <div style={{ color: UI.faint, padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد كروبات مربوطة بعد</div>}
        </div>
      )}

      {membersFor && (
        <Modal onClose={() => setMembersFor(null)} title={`أعضاء «${membersFor.chatTitle || membersFor.chatId}»`}>
          {membersLoading ? <Spinner /> : !members ? <div style={{ color: UI.faint }}>تعذّر الجلب</div> : (
            <div style={{ fontSize: 13, lineHeight: 1.9, color: UI.ink }}>
              <div style={{ marginBottom: 10, fontWeight: 700 }}>
                العدد الكلي في الكروب: {members.memberCount ?? '—'}
              </div>
              <div style={{ fontWeight: 700, color: '#0f766e' }}>المشرفون {members.admins ? `(${members.admins.length})` : ''}</div>
              {(members.admins ?? []).map(a => (
                <div key={a.telegramUserId}>• {personName(a)}{a.username ? ` @${a.username}` : ''} <span style={{ color: UI.faint }}>({a.status === 'creator' ? 'المالك' : 'مشرف'})</span></div>
              ))}
              {members.admins === null && <div style={{ color: UI.faint }}>تعذّر جلب المشرفين (البوت يحتاج أن يكون مشرفاً أو عضواً بالكروب)</div>}
              <div style={{ fontWeight: 700, color: '#0f766e', marginTop: 12 }}>الذين ظهروا بالكروب ({members.seen.length})</div>
              {members.seen.map(m => (
                <div key={m.telegramUserId}>• {personName(m)}{m.username ? ` @${m.username}` : ''}
                  <span style={{ color: UI.faint }}> — آخر ظهور {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString('ar-IQ') : ''}</span></div>
              ))}
              {(() => {
                if (members.memberCount == null) return null;
                const known = new Set([...(members.admins ?? []), ...members.seen].map(p => p.telegramUserId));
                const unknown = Math.max(0, members.memberCount - 1 - known.size); // -1 = البوت نفسه
                return unknown > 0 ? (
                  <div style={{ marginTop: 8, color: '#b45309', fontWeight: 600 }}>
                    ⚠️ {unknown} عضو لم يكتب بعد — أسماؤهم غير معروفة للبوت حتى يكتبوا رسالة.
                  </div>
                ) : null;
              })()}
              {members.seen.length === 0 && <div style={{ color: UI.faint }}>لا أحد بعد — يُسجَّل كل من يكتب أو ينضم من الآن فصاعداً.</div>}
              <div style={{ marginTop: 12, fontSize: 11.5, color: UI.faint, lineHeight: 1.6 }}>
                تلكرام لا يسمح للبوت بسرد كل الأعضاء. القائمة = المشرفون + كل من كتب رسالة أو انضمّ منذ تفعيل هذه الميزة؛ الصامتون لن يظهروا حتى يكتبوا.
              </div>
            </div>
          )}
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
            تفعيل سؤال المبيعات النصّي («فلان مبيع شهر 9»)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.silentMode ?? false}
              onChange={e => setForm(f => ({ ...f!, silentMode: e.target.checked }))}
            />
            🔇 صمت كامل (البوت يعالج بصمت ولا يرد بأي رسالة في هذا الكروب)
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
