import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, Modal, Field, btnStyle } from './OfficesPage';

interface SuperAdminRow { id: number; username: string; isMaster: boolean; isActive: boolean; }

export default function SuperAdminsPage() {
  const { token, admin } = useSuperAdmin();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const [admins,  setAdmins]  = useState<SuperAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form,    setForm]    = useState<Partial<SuperAdminRow> & { password?: string } | null>(null);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  const load = () => {
    setLoading(true);
    fetch('/api/super-admin/admins', { headers: H() })
      .then(r => r.json())
      .then(d => { if (d.success) setAdmins(d.data); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const saveAdmin = async () => {
    if (!form?.username?.trim()) { setError('اسم المستخدم مطلوب'); return; }
    if (!form.id && !form.password?.trim()) { setError('كلمة المرور مطلوبة'); return; }
    setSaving(true); setError('');
    const isEdit = Boolean(form.id);
    const payload: any = { username: form.username };
    if (form.password) payload.password = form.password;
    const res = await fetch(isEdit ? `/api/super-admin/admins/${form.id}` : '/api/super-admin/admins', {
      method: isEdit ? 'PUT' : 'POST', headers: H(), body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'خطأ'); setSaving(false); return; }
    setSaving(false); setForm(null); load();
  };

  const delAdmin = async (a: SuperAdminRow) => {
    if (a.isMaster) return;
    if (!confirm(`حذف "${a.username}"؟`)) return;
    await fetch(`/api/super-admin/admins/${a.id}`, { method: 'DELETE', headers: H() });
    load();
  };

  if (!admin?.isMaster) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#ef4444' }}>🚫 هذه الصفحة للماستر أدمن فقط</div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>🛡️ المشرفون العامون</h2>
        <button onClick={() => setForm({ username: '', password: '' })} style={btnStyle('#0f172a')}>+ إضافة مشرف</button>
      </div>
      {loading ? <Spinner /> : (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                {['المستخدم', 'النوع', 'الحالة', ''].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'right', fontSize: 12, color: '#64748b', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {admins.map((a, i) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600 }}>{a.username}</td>
                  <td style={{ padding: '12px 16px' }}>
                    {a.isMaster
                      ? <span style={{ background: '#fef3c7', color: '#d97706', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>👑 ماستر</span>
                      : <span style={{ background: '#ede9fe', color: '#7c3aed', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>🛡️ مشرف</span>}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ background: a.isActive ? '#dcfce7' : '#fee2e2', color: a.isActive ? '#16a34a' : '#dc2626', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
                      {a.isActive ? 'نشط' : 'معطل'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {!a.isMaster && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => setForm({ ...a, password: '' })} style={btnStyle('#3b82f6', true)}>تعديل</button>
                        <button onClick={() => delAdmin(a)} style={btnStyle('#ef4444', true)}>حذف</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {admins.length === 0 && <tr><td colSpan={4} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>لا توجد نتائج</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <Modal onClose={() => { setForm(null); setError(''); }} title={form.id ? 'تعديل المشرف' : 'إضافة مشرف جديد'}>
          <Field label="اسم المستخدم *" value={form.username || ''} onChange={v => setForm(f => ({ ...f!, username: v }))} />
          <Field label={form.id ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور *'} value={form.password || ''} onChange={v => setForm(f => ({ ...f!, password: v }))} type="password" />
          {error && <ErrBox msg={error} />}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => { setForm(null); setError(''); }} style={btnStyle('#6b7280', true)}>إلغاء</button>
            <button onClick={saveAdmin} disabled={saving} style={btnStyle('#0f172a', true)}>{saving ? '...' : 'حفظ'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
