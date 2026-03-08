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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>🏢 المكاتب العلمية</h2>
        <button onClick={() => setForm(EMPTY)} style={btnStyle('#0f172a')}>+ إضافة مكتب</button>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
          {offices.map(o => (
            <div key={o.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>{o.name}</div>
                  {o.phone   && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>📞 {o.phone}</div>}
                  {o.address && <div style={{ fontSize: 12, color: '#64748b' }}>📍 {o.address}</div>}
                </div>
                <span style={{ background: o.isActive ? '#dcfce7' : '#fee2e2', color: o.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 600 }}>
                  {o.isActive ? 'نشط' : 'معطل'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#64748b', marginBottom: 14 }}>
                <span>🏭 {o._count?.companies ?? 0} شركة</span>
                <span>👤 {o._count?.users ?? 0} مستخدم</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setForm({ ...o })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                <button onClick={() => toggle(o)} style={btnStyle(o.isActive ? '#f59e0b' : '#10b981', true)}>{o.isActive ? 'تعطيل' : 'تفعيل'}</button>
                <button onClick={() => del(o)} style={btnStyle('#ef4444', true)}>حذف</button>
              </div>
            </div>
          ))}
          {offices.length === 0 && <div style={{ color: '#94a3b8', padding: 32, textAlign: 'center', gridColumn: '1/-1' }}>لا توجد مكاتب بعد</div>}
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
export function Spinner() {
  return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>⏳ جاري التحميل...</div>;
}
export function ErrBox({ msg }: { msg: string }) {
  return <div style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{msg}</div>;
}
export function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', direction: 'rtl' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#64748b' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Field({ label, value, onChange, textarea, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; textarea?: boolean; type?: string }) {
  const style: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', outline: 'none', resize: 'vertical', fontFamily: 'inherit' };
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{label}</label>
      {textarea
        ? <textarea value={value} onChange={e => onChange(e.target.value)} style={{ ...style, minHeight: 80 }} />
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} style={style} />}
    </div>
  );
}
export function btnStyle(bg: string, small = false): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: small ? '6px 14px' : '9px 20px', fontSize: small ? 13 : 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
}
