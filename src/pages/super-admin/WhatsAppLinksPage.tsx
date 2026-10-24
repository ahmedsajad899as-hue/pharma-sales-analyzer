import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';

interface UserOption { id: number; username: string; displayName?: string; role: string }
interface WhatsAppLink {
  id: number; waId: string; chatTitle?: string | null; isActive: boolean; userId: number;
  orderTextMode?: OrderTextMode;
  lastMessageId?: string | null;
  user?: UserOption;
}

const EMPTY: Partial<WhatsAppLink> = { waId: '', chatTitle: '', userId: undefined, orderTextMode: 'all' };

// صفحة إدارة أرقام واتساب المربوطة بحسابات. مرآة لصفحة روابط فايبر: محادثات
// فردية مع رقم البوت (WhatsApp Cloud API)، والبوت **خامد** حتى يُضبط WHATSAPP_TOKEN
// و WHATSAPP_PHONE_NUMBER_ID — قبل ذلك تُخزَّن الروابط ولا رسالة تصل.
export default function WhatsAppLinksPage() {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [links, setLinks]     = useState<WhatsAppLink[]>([]);
  const [users, setUsers]     = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm]       = useState<Partial<WhatsAppLink> | null>(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  const load = () => {
    setLoading(true);
    fetch('/api/sa/whatsapp-links', { headers: H() })
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
    if (!form?.waId?.trim()) { setError('رقم الواتساب مطلوب'); return; }
    if (!form?.userId) { setError('اختر الحساب المرتبط'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const res = await fetch(isEdit ? `/api/sa/whatsapp-links/${form.id}` : '/api/sa/whatsapp-links', {
      method: isEdit ? 'PUT' : 'POST',
      headers: H(),
      body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
  };

  const toggle = async (l: WhatsAppLink) => {
    await fetch(`/api/sa/whatsapp-links/${l.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !l.isActive }) });
    load();
  };

  const del = async (l: WhatsAppLink) => {
    if (!confirm(`حذف ربط المحادثة "${l.chatTitle || l.waId}"؟`)) return;
    await fetch(`/api/sa/whatsapp-links/${l.id}`, { method: 'DELETE', headers: H() });
    load();
  };

  const userLabel = (u?: UserOption) => u ? (u.displayName || u.username) : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: UI.ink }}>روابط واتساب</h2>
        <button onClick={() => setForm(EMPTY)} style={btnStyle('#1e293b')}>+ ربط رقم جديد</button>
      </div>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 18, lineHeight: 1.6 }}>
        الطلبيات والفواتير التي يرسلها المندوب لرقم البوت على واتساب (كلاماً أو صورة)
        تُقرأ بالذكاء الاصطناعي وتنتظر مراجعة المستخدم في التطبيق. اربط رقم المندوب
        بالحساب هنا (يُقبل 0770… أو ‎+964…). رقم غير مربوط يردّ عليه البوت برقمه.
      </div>

      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 12.5, color: '#92400e', lineHeight: 1.7 }}>
        ⚠️ يعمل البوت فقط بعد ضبط <code>WHATSAPP_TOKEN</code> و<code>WHATSAPP_PHONE_NUMBER_ID</code>
        و<code>WHATSAPP_APP_SECRET</code> و<code>WHATSAPP_VERIFY_TOKEN</code> في بيئة السيرفر،
        وتسجيل الويب-هوك في لوحة Meta على <code>/api/whatsapp/webhook</code> (حقل messages).
        محادثات فردية فقط — لا كروبات.
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(270px,1fr))', gap: 12 }}>
          {links.map(l => (
            <div key={l.id} style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: UI.ink }}>{l.chatTitle || 'بلا تسمية'}</div>
                  <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 2 }}>رقم: {l.waId}</div>
                  <div style={{ fontSize: 11.5, color: UI.faint }}>الحساب: {userLabel(l.user)}</div>
                  <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 3, fontWeight: 600 }}>
                    {ORDER_MODE_SHORT[(l.orderTextMode || 'trigger') as OrderTextMode]}
                  </div>
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
          {links.length === 0 && <div style={{ color: UI.faint, padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد محادثات مربوطة بعد</div>}
        </div>
      )}

      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل الربط' : 'ربط رقم جديد'}>
          <Field label="رقم واتساب المندوب *" value={form.waId || ''} onChange={v => setForm(f => ({ ...f!, waId: v }))} placeholder="مثال: 07701234567" />
          <Field label="تسمية (اختياري)" value={form.chatTitle || ''} onChange={v => setForm(f => ({ ...f!, chatTitle: v }))} placeholder="مثال: أحمد — مندوب الكرخ" />
          <OrderTextModeField value={form.orderTextMode} onChange={v => setForm(f => ({ ...f!, orderTextMode: v }))} />
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
