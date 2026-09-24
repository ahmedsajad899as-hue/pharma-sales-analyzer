import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle, UI } from './OfficesPage';

interface UserOption { id: number; username: string; displayName?: string; role: string }
interface TelegramLink {
  id: number; chatId: string; chatTitle?: string | null; isActive: boolean; userId: number;
  user?: UserOption;
}

const EMPTY: Partial<TelegramLink> = { chatId: '', chatTitle: '', userId: undefined };

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
        إن لم يكن مربوطاً بعد.
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
                </div>
                <span style={{ background: l.isActive ? '#f0fdf4' : '#fef2f2', color: l.isActive ? '#16a34a' : '#b91c1c', borderRadius: 20, padding: '2px 9px', fontSize: 10.5, fontWeight: 600 }}>
                  {l.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setForm({ ...l })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => toggle(l)} style={btnStyle(l.isActive ? '#d97706' : '#16a34a', true)}>{l.isActive ? 'تعطيل' : 'تفعيل'}</button>
                <button onClick={() => del(l)} style={btnStyle('#dc2626', true)}>حذف</button>
              </div>
            </div>
          ))}
          {links.length === 0 && <div style={{ color: UI.faint, padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد كروبات مربوطة بعد</div>}
        </div>
      )}

      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل الربط' : 'ربط كروب جديد'}>
          <Field label="رقم الكروب (chat_id) *" value={form.chatId || ''} onChange={v => setForm(f => ({ ...f!, chatId: v }))} placeholder="مثال: -1001234567890" />
          <Field label="تسمية (اختياري)" value={form.chatTitle || ''} onChange={v => setForm(f => ({ ...f!, chatTitle: v }))} placeholder="مثال: مبيعات بغداد" />
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
