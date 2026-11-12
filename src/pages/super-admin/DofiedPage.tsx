import { useCallback, useEffect, useState } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Spinner, UI } from './OfficesPage';
import { Bar, Section, Toggle, Kv, Notice, ghost, solid, tag, TAG, twoCols } from './saKit';

interface UserOption { id: number; username: string; displayName?: string | null; role: string; isActive?: boolean }
interface Config {
  username: string | null; hasPassword: boolean; userId: number | null; enabled: boolean; runHour: number;
  lastSyncedDate: string | null; lastRunAt: string | null; notifyChatId: string | null; lastStatus: string | null; lastMessage: string | null;
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

const field = { width: '100%', padding: '6px 10px', border: `1px solid ${UI.line}`, borderRadius: 7, fontSize: 12.5, boxSizing: 'border-box' as const, fontFamily: 'inherit', color: UI.ink };
const label = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 11.5, fontWeight: 600, color: UI.muted };

// «ربط دوفايد» — سحب يومي غير رسمي لتقارير زيارات المندوبين من dofied.com بحساب
// المستخدم نفسه، إلى طابور مراجعة الزيارات للحساب المختار (لا حفظ بلا مراجعة).
export default function DofiedPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [form, setForm] = useState({ username: '', password: '', userId: '', enabled: false, runHour: 1, notifyChatId: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (c: Config) => {
    setCfg(c);
    setForm({ username: c.username || '', password: '', userId: c.userId ? String(c.userId) : '', enabled: c.enabled, runHour: c.runHour, notifyChatId: c.notifyChatId || '' });
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
      userId: form.userId ? Number(form.userId) : null, enabled: form.enabled, runHour: form.runHour, notifyChatId: form.notifyChatId,
    }),
  });

  if (!cfg) return error ? <ErrBox msg={error} /> : <Spinner />;
  const st = cfg.lastStatus ? STATUS[cfg.lastStatus] : null;
  const dirty = form.username !== (cfg.username || '') || !!form.password || form.userId !== (cfg.userId ? String(cfg.userId) : '')
    || form.enabled !== cfg.enabled || form.runHour !== cfg.runHour || form.notifyChatId !== (cfg.notifyChatId || '');

  const nextLabel = cfg.nextWindow ? `${cfg.nextWindow.from}${cfg.nextWindow.from === cfg.nextWindow.to ? '' : ` ← ${cfg.nextWindow.to}`}` : '—';
  const needSave = dirty ? 'احفظ أولاً' : undefined;

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      <Bar end={<>
        <button style={ghost('#0f766e')} disabled={!!busy || dirty || !cfg.hasPassword} title={needSave} onClick={() => call('test', '/api/sa/dofied/test', { method: 'POST' })}>{busy === 'test' ? '…' : 'اختبار الاتصال'}</button>
        <button style={ghost('#b45309')} disabled={!!busy || dirty || !cfg.hasPassword || !cfg.userId} title={needSave} onClick={() => call('run', '/api/sa/dofied/run', { method: 'POST' })}>{busy === 'run' ? '…' : 'سحب الآن'}</button>
        <button style={ghost()} disabled={!!busy || dirty || !cfg.notifyChatId} title={needSave} onClick={() => call('alert', '/api/sa/dofied/test-alert', { method: 'POST' })}>{busy === 'alert' ? '…' : 'تنبيه تجريبي'}</button>
      </>}>
        <span style={cfg.enabled ? TAG.ok : TAG.mute}>{cfg.enabled ? 'السحب اليومي مفعّل' : 'السحب اليومي متوقف'}</span>
        {st && <span style={tag(st.color, '#f8fafc')}>آخر تشغيل: {st.label}</span>}
        {cfg.pending && <span style={TAG.warn} title={cfg.pending.fileName}>ملف بانتظار المراجعة</span>}
      </Bar>

      {error && <ErrBox msg={error} />}
      {notice && <Notice>{notice}</Notice>}

      <div style={twoCols}>
        <Section title="الإعدادات" end={<button style={dirty ? solid(UI.accent) : ghost(UI.faint)} disabled={!!busy || !dirty} onClick={save}>{busy === 'save' ? '…' : 'حفظ'}</button>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <label style={label}>اسم المستخدم
              <input style={field} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="off" dir="ltr" />
            </label>
            <label style={label}>كلمة السر
              <input style={field} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="new-password" dir="ltr" placeholder={cfg.hasPassword ? '•••••••• محفوظة' : ''} />
            </label>
            <label style={label}>الحساب المستلِم
              <select style={field} value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}>
                <option value="">— اختر —</option>
                {users.filter(u => u.isActive !== false || String(u.id) === form.userId).map(u => (
                  <option key={u.id} value={u.id}>{nameOf(u)} ({u.username})</option>
                ))}
              </select>
            </label>
            <label style={label}>ساعة السحب (بغداد)
              <select style={field} value={form.runHour} onChange={e => setForm({ ...form, runHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <label style={label} title="أرسل أي رسالة لبوت التطبيق بمحادثة خاصة فيردّ برقم المحادثة">محادثة تلكرام للتنبيهات
              <input style={field} value={form.notifyChatId} onChange={e => setForm({ ...form, notifyChatId: e.target.value })} dir="ltr" placeholder="123456789" />
            </label>
          </div>
          <Toggle on={form.enabled} label="السحب اليومي التلقائي" onToggle={() => setForm({ ...form, enabled: !form.enabled })} />
        </Section>

        <Section title="الحالة">
          <div>
            <Kv k="آخر تشغيل">{fmt(cfg.lastRunAt)} {st && <span style={{ color: st.color, fontWeight: 600 }}>· {st.label}</span>}</Kv>
            {cfg.lastMessage && <Kv k="الرسالة"><span style={{ color: st?.color || UI.text }}>{cfg.lastMessage}</span></Kv>}
            <Kv k="آخر يوم سُحب">{cfg.lastSyncedDate || '—'}</Kv>
            <Kv k="السحب القادم">{nextLabel}</Kv>
            <Kv k="الحساب المستلِم">{nameOf(cfg.user)} {cfg.user && !cfg.user.isActive && <span style={TAG.bad}>معطّل</span>}</Kv>
            {cfg.pending && <Kv k="بانتظار المراجعة"><span style={{ color: '#b45309' }}>«{cfg.pending.fileName}» منذ {fmt(cfg.pending.createdAt)}</span></Kv>}
          </div>
        </Section>
      </div>
    </div>
  );
}
