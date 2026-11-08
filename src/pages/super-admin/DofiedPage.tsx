import { useCallback, useEffect, useState } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Spinner, btnStyle, UI } from './OfficesPage';

interface UserOption { id: number; username: string; displayName?: string | null; role: string; isActive?: boolean }
interface Config {
  username: string | null; hasPassword: boolean; userId: number | null; enabled: boolean; runHour: number;
  lastSyncedDate: string | null; lastRunAt: string | null; lastStatus: string | null; lastMessage: string | null;
  user: { id: number; username: string; displayName?: string | null; isActive: boolean } | null;
  pending: { fileName: string; createdAt: string } | null;
  nextWindow: { from: string; to: string } | null;
}

const STATUS: Record<string, { label: string; color: string }> = {
  ok:      { label: 'نجح',            color: '#15803d' },
  waiting: { label: 'بانتظار المراجعة', color: '#b45309' },
  error:   { label: 'فشل',            color: '#b91c1c' },
  busy:    { label: 'قيد التنفيذ',     color: UI.muted },
};
const nameOf = (u?: { username: string; displayName?: string | null } | null) => (u ? u.displayName?.trim() || u.username : '—');
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const field = { width: '100%', padding: '8px 10px', border: `1px solid ${UI.line}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const };
const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: UI.text, marginBottom: 6 };

// «ربط دوفايد» — سحب يومي غير رسمي لتقارير زيارات المندوبين من dofied.com بحساب
// المستخدم نفسه، إلى طابور مراجعة الزيارات للحساب المختار (لا حفظ بلا مراجعة).
export default function DofiedPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [form, setForm] = useState({ username: '', password: '', userId: '', enabled: false, runHour: 1 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (c: Config) => {
    setCfg(c);
    setForm({ username: c.username || '', password: '', userId: c.userId ? String(c.userId) : '', enabled: c.enabled, runHour: c.runHour });
  };
  const load = useCallback(() => {
    fetch('/api/sa/dofied', { headers: H() }).then(r => r.json())
      .then(d => (d.success ? apply(d.data) : setError(d.error || 'تعذّر التحميل')))
      .catch(() => setError('تعذّر الاتصال بالسيرفر'));
  }, [H]);
  useEffect(() => {
    load();
    fetch('/api/sa/users', { headers: H() }).then(r => r.json()).then(d => { if (d.success) setUsers(d.data); }).catch(() => {});
  }, [load, H]);

  const call = async (what: string, url: string, init: RequestInit) => {
    setBusy(what); setError(''); setNotice('');
    try {
      const res = await fetch(url, { headers: H(), ...init });
      const d = await res.json().catch(() => ({}));
      if (d.data) apply(d.data);
      if (!res.ok || d.success === false) setError(d.error || d.message || 'فشلت العملية');
      else setNotice(d.message || 'تم');
    } catch {
      setError('تعذّر الاتصال بالسيرفر');
    } finally {
      setBusy('');
    }
  };

  const save = () => call('save', '/api/sa/dofied', {
    method: 'PUT',
    body: JSON.stringify({
      username: form.username, password: form.password || undefined,
      userId: form.userId ? Number(form.userId) : null, enabled: form.enabled, runHour: form.runHour,
    }),
  });

  if (!cfg) return error ? <ErrBox msg={error} /> : <Spinner />;
  const st = cfg.lastStatus ? STATUS[cfg.lastStatus] : null;
  const dirty = form.username !== (cfg.username || '') || !!form.password || form.userId !== (cfg.userId ? String(cfg.userId) : '')
    || form.enabled !== cfg.enabled || form.runHour !== cfg.runHour;

  return (
    <div style={{ direction: 'rtl', maxWidth: 760 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18, color: UI.ink }}>ربط دوفايد</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: UI.muted, lineHeight: 1.7 }}>
        يسحب تقارير زيارات المندوبين من موقع دوفايد مرة يومياً (أيام مكتملة حتى أمس) ويضعها في <b>طابور مراجعة الزيارات</b> للحساب المختار — نفس ما يحدث عند رفع ملف دوفايد يدوياً. لا يُحفظ شيء قبل المراجعة.
      </p>
      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 16, lineHeight: 1.7 }}>
        ⚠️ ربط غير رسمي بحسابك: أي تحديث في موقع دوفايد قد يوقفه، وتظهر الرسالة هنا. الرفع اليدوي يبقى متاحاً دائماً.
      </div>

      {error && <ErrBox msg={error} />}
      {notice && <div style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div>
          <label style={label}>اسم مستخدم دوفايد</label>
          <input style={field} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="off" dir="ltr" />
        </div>
        <div>
          <label style={label}>كلمة السر {cfg.hasPassword && <span style={{ color: UI.faint, fontWeight: 400 }}>(محفوظة — اتركها فارغة لإبقائها)</span>}</label>
          <input style={field} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="new-password" dir="ltr" placeholder={cfg.hasPassword ? '••••••••' : ''} />
        </div>
        <div>
          <label style={label}>الحساب الذي يستلم الملف للمراجعة</label>
          <select style={field} value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}>
            <option value="">— اختر الحساب —</option>
            {users.filter(u => u.isActive !== false || String(u.id) === form.userId).map(u => (
              <option key={u.id} value={u.id}>{nameOf(u)} ({u.username})</option>
            ))}
          </select>
        </div>
        <div>
          <label style={label}>ساعة السحب اليومي (بغداد)</label>
          <select style={field} value={form.runHour} onChange={e => setForm({ ...form, runHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: UI.text, cursor: 'pointer', gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
          السحب اليومي التلقائي مفعّل
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', gridColumn: '1 / -1' }}>
          <button style={btnStyle(UI.accent)} disabled={!!busy || !dirty} onClick={save}>{busy === 'save' ? 'جاري الحفظ…' : 'حفظ'}</button>
          <button style={btnStyle('#0f766e')} disabled={!!busy || dirty || !cfg.hasPassword} onClick={() => call('test', '/api/sa/dofied/test', { method: 'POST' })}
            title={dirty ? 'احفظ أولاً' : ''}>{busy === 'test' ? 'جاري الاختبار…' : 'اختبار الاتصال'}</button>
          <button style={btnStyle('#b45309')} disabled={!!busy || dirty || !cfg.hasPassword || !cfg.userId} onClick={() => call('run', '/api/sa/dofied/run', { method: 'POST' })}
            title={dirty ? 'احفظ أولاً' : ''}>{busy === 'run' ? 'جاري السحب…' : 'سحب الآن'}</button>
        </div>
      </div>

      <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: 16, fontSize: 13, color: UI.text, lineHeight: 2 }}>
        <div><b>آخر تشغيل:</b> {fmt(cfg.lastRunAt)} {st && <span style={{ color: st.color, fontWeight: 600 }}>· {st.label}</span>}</div>
        {cfg.lastMessage && <div style={{ color: st?.color || UI.text }}>{cfg.lastMessage}</div>}
        <div><b>آخر يوم سُحب:</b> {cfg.lastSyncedDate || 'لم يُسحب شيء بعد'}</div>
        <div><b>السحب القادم:</b> {cfg.nextWindow ? `${cfg.nextWindow.from}${cfg.nextWindow.from === cfg.nextWindow.to ? '' : ` ← ${cfg.nextWindow.to}`}` : 'لا يوجد يوم مكتمل جديد'}</div>
        <div><b>الحساب المستلِم:</b> {nameOf(cfg.user)} {cfg.user && !cfg.user.isActive && <span style={{ color: '#b91c1c' }}>(معطّل)</span>}</div>
        {cfg.pending && (
          <div style={{ color: '#b45309' }}>⏳ ملف «{cfg.pending.fileName}» بانتظار المراجعة منذ {fmt(cfg.pending.createdAt)} — لا يُسحب جديد حتى يُراجَع (صفحة زيارات الأطباء).</div>
        )}
      </div>
    </div>
  );
}
