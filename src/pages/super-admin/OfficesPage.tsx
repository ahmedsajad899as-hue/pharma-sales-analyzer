import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';

interface Office {
  id: number; name: string; phone?: string; address?: string;
  notes?: string; isActive: boolean;
  _count?: { companies: number; users: number };
}

const EMPTY: Partial<Office> = { name: '', phone: '', address: '', notes: '', isActive: true };

export default function OfficesPage() {
  const { token } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [offices, setOffices]   = useState<Office[]>([]);
  const [loading, setLoading]   = useState(true);
  const [form, setForm]         = useState<Partial<Office> | null>(null);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const load = () => {
    setLoading(true);
    fetch('/api/sa/offices', { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setOffices(d.data); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const save = async () => {
    if (!form?.name?.trim()) { setError('اسم المكتب مطلوب'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const res = await fetch(isEdit ? `/api/sa/offices/${form.id}` : '/api/sa/offices', {
      method: isEdit ? 'PUT' : 'POST',
      headers: H(),
      body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
  };

  const toggle = async (o: Office) => {
    await fetch(`/api/sa/offices/${o.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ isActive: !o.isActive }) });
    load();
  };

  const del = async (o: Office) => {
    if (!confirm(`حذف مكتب "${o.name}"؟`)) return;
    await fetch(`/api/sa/offices/${o.id}`, { method: 'DELETE', headers: H() });
    load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: UI.ink }}>المكاتب العلمية</h2>
        <button onClick={() => setForm(EMPTY)} style={btnStyle('#1e293b')}>+ إضافة مكتب</button>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(270px,1fr))', gap: 12 }}>
          {offices.map(o => (
            <div key={o.id} style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: UI.ink }}>{o.name}</div>
                  {o.phone   && <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 2 }}>{o.phone}</div>}
                  {o.address && <div style={{ fontSize: 11.5, color: UI.faint }}>{o.address}</div>}
                </div>
                <span style={{ background: o.isActive ? '#f0fdf4' : '#fef2f2', color: o.isActive ? '#16a34a' : '#b91c1c', borderRadius: 20, padding: '2px 9px', fontSize: 10.5, fontWeight: 600 }}>
                  {o.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 11.5, color: UI.faint, marginBottom: 12 }}>
                <span>{o._count?.companies ?? 0} شركة</span>
                <span>{o._count?.users ?? 0} مستخدم</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setForm({ ...o })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => toggle(o)} style={btnStyle(o.isActive ? '#d97706' : '#16a34a', true)}>{o.isActive ? 'تعطيل' : 'تفعيل'}</button>
                <button onClick={() => del(o)} style={btnStyle('#dc2626', true)}>حذف</button>
              </div>
            </div>
          ))}
          {offices.length === 0 && <div style={{ color: UI.faint, padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد مكاتب بعد</div>}
        </div>
      )}

      {/* Modal */}
      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل المكتب' : 'إضافة مكتب جديد'}>
          <Field label="اسم المكتب *" value={form.name || ''} onChange={v => setForm(f => ({ ...f!, name: v }))} />
          <Field label="الهاتف"       value={form.phone || ''} onChange={v => setForm(f => ({ ...f!, phone: v }))} />
          <Field label="العنوان"      value={form.address || ''} onChange={v => setForm(f => ({ ...f!, address: v }))} />
          <Field label="ملاحظات"     value={form.notes || ''} onChange={v => setForm(f => ({ ...f!, notes: v }))} textarea />
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

// ── Shared helpers ────────────────────────────────────────────────────────
// نظام تصميم موحّد وهادئ: تدرّج رمادي/كحلي محايد + لون تمييز واحد (indigo)،
// وأي لون آخر يُمرَّر لـ btnStyle يتحوّل تلقائياً لـ "شريحة" هادئة بدل تعبئة صارخة.
export const UI = {
  ink:    '#1e293b',
  text:   '#334155',
  muted:  '#64748b',
  faint:  '#94a3b8',
  line:   '#e2e8f0',
  bg:     '#f8fafc',
  accent: '#4f46e5',
};

export function Spinner() {
  return <div style={{ padding: 40, textAlign: 'center', color: UI.faint, fontSize: 13 }}>جاري التحميل...</div>;
}
export function ErrBox({ msg }: { msg: string }) {
  return <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{msg}</div>;
}
export function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 14, padding: 24, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl', boxShadow: '0 12px 32px rgba(15,23,42,.14)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 700, color: UI.ink }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: UI.faint }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Field({ label, value, onChange, textarea, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; textarea?: boolean; type?: string; placeholder?: string }) {
  const style: React.CSSProperties = { width: '100%', padding: '8px 12px', border: `1px solid #d8dee8`, borderRadius: 8, fontSize: 13.5, boxSizing: 'border-box', outline: 'none', resize: 'vertical', fontFamily: 'inherit', color: UI.ink };
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 5 }}>{label}</label>
      {textarea
        ? <textarea value={value} onChange={e => onChange(e.target.value)} style={style} placeholder={placeholder} />
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} style={style} placeholder={placeholder} />}
    </div>
  );
}

// أوزان محايدة (كحلي/رمادي) تبقى أزرار "أساسية" مصمتة ومسطّحة.
// أي لون آخر (أزرق/أخضر/أحمر/برتقالي...) يتحوّل تلقائياً لشريحة هادئة
// (خلفية فاتحة + نص/حدّ بنفس اللون) بدل التعبئة الكاملة الصارخة — هذا وحده
// يُهدّئ كل أزرار "تعديل/تفعيل/حذف" في كل الصفحات دون تعديل كل موضع استخدام.
function relativeBrightness(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
export function btnStyle(bg: string, small = false): React.CSSProperties {
  const base: React.CSSProperties = {
    border: 'none', borderRadius: 7,
    padding: small ? '6px 13px' : '8px 18px',
    fontSize: small ? 12.5 : 13.5, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap',
    transition: 'opacity .15s, filter .15s',
  };
  const isNeutralDark = /^#(?:0f172a|111827|1e293b|334155|374151|1f2937)$/i.test(bg) || relativeBrightness(bg) < 0.3;
  if (isNeutralDark) {
    return { ...base, background: bg, color: '#fff' };
  }
  return {
    ...base,
    background: `color-mix(in srgb, ${bg} 12%, #fff)`,
    color: `color-mix(in srgb, ${bg} 78%, #1e293b)`,
    border: `1px solid color-mix(in srgb, ${bg} 30%, #fff)`,
  };
}
