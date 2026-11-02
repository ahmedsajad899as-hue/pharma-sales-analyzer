import { useCallback, useEffect, useState } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, btnStyle, UI } from './OfficesPage';

interface Status { status?: string; connected?: boolean; me?: string | null; error?: string | null }
interface Group { jid: string; name: string; size: number }

const STATUS_LABEL: Record<string, { text: string; color: string; bg: string }> = {
  connected:     { text: 'متصل ✅',          color: '#16a34a', bg: '#f0fdf4' },
  awaiting_link: { text: 'بانتظار الربط',    color: '#b45309', bg: '#fffbeb' },
  reconnecting:  { text: 'يعيد الاتصال…',    color: '#b45309', bg: '#fffbeb' },
  starting:      { text: 'يبدأ…',            color: UI.muted,  bg: UI.bg },
  logged_out:    { text: 'غير مربوط',         color: '#b91c1c', bg: '#fef2f2' },
};

// «رقم الكروبات» — شريحة مخصّصة تعمل كواتساب ويب (خدمة wa-groups على السيرفر)
// لإرسال الطلبيات لكروبات المذاخر. رقم واحد لكل النظام ⇒ ماستر أدمن فقط.
// ربط كل مذخر بكروبه يتم من صفحة «إرسال للمذاخر» ← المذاخر في التطبيق.
export default function WaGroupsPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [st, setSt]         = useState<Status | null>(null);
  const [phone, setPhone]   = useState('');
  const [code, setCode]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [groups, setGroups] = useState<Group[] | null>(null);

  const load = useCallback(() => {
    fetch('/api/sa/wa-groups/status', { headers: H() })
      .then(r => r.json()).then(setSt).catch(() => setSt({ error: 'تعذّر الاتصال بالسيرفر' }));
  }, [H]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!st?.connected || groups) return;
    fetch('/api/sa/wa-groups/groups', { headers: H() }).then(r => r.json()).then(d => setGroups(d.groups || [])).catch(() => {});
  }, [st?.connected, groups, H]);
  useEffect(() => { if (st?.connected) setCode(''); }, [st?.connected]);

  const pair = async () => {
    setBusy(true); setError(''); setCode('');
    try {
      const res = await fetch('/api/sa/wa-groups/pair', { method: 'POST', headers: H(), body: JSON.stringify({ phone }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'تعذّر طلب الكود');
      setCode(d.pairingCode || '');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const logout = async () => {
    if (!window.confirm('فصل رقم الكروبات؟ ستتوقف رسائل الكروبات حتى يُربط من جديد.')) return;
    const res = await fetch('/api/sa/wa-groups/logout', { method: 'POST', headers: H() });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'تعذّر الفصل');
    setGroups(null); load();
  };

  const label = STATUS_LABEL[st?.status || ''] || { text: st?.status ? st.status : 'الخدمة غير مشغّلة', color: '#b91c1c', bg: '#fef2f2' };
  const meNumber = st?.me ? String(st.me).split(':')[0].split('@')[0] : '';
  const fmtCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

  return (
    <div style={{ direction: 'rtl', maxWidth: 760 }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: UI.ink }}>رقم الكروبات</h2>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 16, lineHeight: 1.7 }}>
        شريحة مخصّصة مربوطة كواتساب ويب، يرسل منها النظام الطلبيات لكروبات المذاخر (نص الطلبية + تصويت تم/جزئي/رفض)
        ويستقبل ردودهم وصور الفواتير. بعد الربط اختر كروب كل مذخر من التطبيق: «إرسال للمذاخر» ← المذاخر ← القناة «كروب».
      </div>

      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12.5, color: '#92400e', lineHeight: 1.7 }}>
        ⚠️ ربط غير رسمي — احتمال حظر الرقم قائم. استعمل شريحة جديدة مخصّصة فقط، لا رقم البوت الرسمي ولا رقماً شخصياً أو رقم المكتب.
      </div>

      {error && <ErrBox msg={error} />}

      <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: UI.text }}>الحالة:</span>
          <span style={{ background: label.bg, color: label.color, borderRadius: 20, padding: '3px 12px', fontSize: 12.5, fontWeight: 700 }}>{label.text}</span>
          {meNumber && <span dir="ltr" style={{ fontSize: 13, color: UI.ink, fontWeight: 600 }}>+{meNumber}</span>}
          {st?.connected && <button onClick={logout} style={{ ...btnStyle('#dc2626', true), marginInlineStart: 'auto' }}>فصل الرقم</button>}
        </div>
        {!st?.connected && st?.error && <div style={{ fontSize: 12, color: UI.faint }}>{st.error}</div>}

        {st && !st.connected && st.status && (
          <>
            <ol style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, color: UI.text, lineHeight: 1.9 }}>
              <li>اكتب رقم الشريحة واضغط «كود الربط».</li>
              <li>على الهاتف: واتساب ← ⋮ ← <b>الأجهزة المرتبطة</b> ← <b>ربط جهاز</b> ← <b>«الربط برقم الهاتف بدلاً من ذلك»</b>.</li>
              <li>أدخل الكود خلال دقيقتين — الحالة تتحوّل هنا إلى «متصل» تلقائياً.</li>
            </ol>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input dir="ltr" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07XXXXXXXXX"
                style={{ padding: '8px 12px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 14, width: 200, fontFamily: 'inherit' }} />
              <button onClick={pair} disabled={busy || !phone.trim()} style={{ ...btnStyle('#1e293b'), opacity: busy || !phone.trim() ? 0.5 : 1 }}>
                {busy ? 'جاري طلب الكود…' : 'كود الربط'}
              </button>
            </div>
            {code && (
              <div style={{ textAlign: 'center', background: UI.bg, border: `1px dashed ${UI.line}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12.5, color: UI.muted, marginBottom: 6 }}>أدخل هذا الكود في واتساب على الهاتف</div>
                <div dir="ltr" style={{ fontSize: 34, fontWeight: 800, letterSpacing: 6, color: UI.ink }}>{fmtCode}</div>
                <div style={{ fontSize: 11.5, color: UI.faint, marginTop: 6 }}>انتهت صلاحيته؟ اضغط «كود الربط» مجدداً.</div>
              </div>
            )}
          </>
        )}
      </div>

      {st?.connected && (
        <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e9edf3', borderRadius: 12, padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: UI.ink, marginBottom: 10 }}>الكروبات التي فيها الرقم ({groups?.length ?? '…'})</div>
          {groups && groups.length === 0 && <div style={{ fontSize: 12.5, color: UI.faint }}>الرقم ليس عضواً في أي كروب بعد — اطلب من المذاخر إضافته لكروباتهم.</div>}
          {(groups || []).map(g => (
            <div key={g.jid} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderTop: `1px solid ${UI.line}`, fontSize: 13, color: UI.text }}>
              <span>{g.name}</span><span style={{ color: UI.faint }}>{g.size} عضو</span>
            </div>
          ))}
          {groups && <button onClick={() => setGroups(null)} style={{ ...btnStyle('#3b82f6', true), marginTop: 10 }}>تحديث القائمة</button>}
        </div>
      )}
    </div>
  );
}
