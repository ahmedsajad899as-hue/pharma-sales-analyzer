import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle, UI } from './OfficesPage';
import { OrderTextModeField, ORDER_MODE_SHORT, type OrderTextMode } from './OrderTextModeField';
import { Bar, Section, Card, Toggle, Empty, ghost, solid, inputSm, TAG, cardGrid } from './saKit';

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
  const [q, setQ]             = useState('');

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
  const qq = q.trim().toLowerCase();
  const shown = links.filter(l => !qq || `${l.chatTitle || ''} ${l.waId} ${userLabel(l.user)}`.toLowerCase().includes(qq));
  const active = links.filter(l => l.isActive).length;

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      <Bar end={<button onClick={() => setForm(EMPTY)} style={solid()}>+ ربط رقم</button>}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث بالاسم أو الرقم أو الحساب…" style={{ ...inputSm, width: 240 }} />
        <span style={TAG.ok}>{active} نشط</span>
        {links.length > active && <span style={TAG.mute}>{links.length - active} معطّل</span>}
      </Bar>

      <OrderFormBox token={token} />

      {loading ? <Spinner /> : (
        <Section title="أرقام المندوبين" count={shown.length} accent="#16a34a">
          {!shown.length && <Empty text={links.length ? 'لا نتائج' : 'لا توجد أرقام مربوطة'} />}
          <div style={cardGrid}>
            {shown.map(l => (
              <Card key={l.id} dim={!l.isActive} title={l.chatTitle || 'بلا تسمية'} meta={<span dir="ltr">+{l.waId}</span>} actions={<>
                <button onClick={() => setForm({ ...l })} style={ghost()}>تعديل</button>
                <button onClick={() => del(l)} style={ghost('#dc2626')}>حذف</button>
              </>}>
                <div style={{ fontSize: 12, color: UI.muted, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>الحساب: <b style={{ color: UI.text }}>{userLabel(l.user)}</b></span>
                  <span style={TAG.violet}>{ORDER_MODE_SHORT[(l.orderTextMode || 'trigger') as OrderTextMode].replace('طلبيات: ', '')}</span>
                </div>
                <Toggle on={l.isActive} label="نشط" onToggle={() => toggle(l)} />
              </Card>
            ))}
          </div>
        </Section>
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

// ─── نموذج الطلبية داخل واتساب (WhatsApp Flows) ───────────────────────────────
// إعداد لمرة واحدة: نسخ JSON → WhatsApp Manager → Flows → إنشاء نموذج → لصق → نشر →
// لصق معرّف النموذج هنا. بعدها يفعّل السوبر أدمن الميزة لكل مندوب من «المميزات».
function OrderFormBox({ token }: { token: string | null }) {
  const [flowId, setFlowId] = useState('');
  const [draft, setDraft] = useState(false);
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  useEffect(() => {
    fetch('/api/sa/whatsapp-links/order-form', { headers: H() }).then(r => r.json()).then(d => {
      setFlowId(d.config?.orderFlowId || '');
      setDraft(Boolean(d.config?.orderFlowDraft));
      setJson(JSON.stringify(d.flowJson, null, 2));
      if (!d.config?.orderFlowId) setOpen(true);
    }).catch(() => {});
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setMsg('');
    const r = await fetch('/api/sa/whatsapp-links/order-form', { method: 'PUT', headers: H(), body: JSON.stringify({ orderFlowId: flowId, orderFlowDraft: draft }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error || 'تعذّر الحفظ'); return; }
    setFlowId(d.config?.orderFlowId || '');
    setMsg(d.config?.orderFlowId ? 'حُفظ' : 'حُفظ — متوقف (بلا معرّف)');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(json); setMsg('نُسخ'); } catch { setMsg('انسخه يدوياً'); }
  };

  return (
    <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: '8px 12px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: UI.ink }}>نموذج الطلبية داخل واتساب</span>
        {flowId ? <span style={TAG.ok}>مفعّل{draft ? ' · تجربة' : ''}</span> : <span style={TAG.warn}>غير مُعدّ</span>}
        <button onClick={() => setOpen(o => !o)} style={{ ...ghost(), marginInlineStart: 'auto' }}>{open ? 'إخفاء' : 'الإعداد'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: UI.text }}>
          <div style={{ color: UI.muted, fontSize: 12 }} dir="rtl">
            انسخ JSON ← WhatsApp Manager ← Flows ← Create flow ← الصق واحفظ ← Publish ← الصق Flow ID هنا
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={copy} style={ghost()}>نسخ JSON</button>
            <input value={flowId} onChange={e => setFlowId(e.target.value)} placeholder="Flow ID" dir="ltr" style={{ ...inputSm, width: 220 }} />
            <Toggle on={draft} label="تجربة" title="نموذج غير منشور" onToggle={() => setDraft(d => !d)} />
            <button onClick={save} style={solid('#16a34a')}>حفظ</button>
            {msg && <span style={{ fontSize: 12, color: UI.muted }}>{msg}</span>}
          </div>
          <textarea readOnly value={json} dir="ltr" style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 11, boxSizing: 'border-box', border: `1px solid ${UI.line}`, borderRadius: 7, padding: 6, color: UI.text }} />
        </div>
      )}
    </div>
  );
}
