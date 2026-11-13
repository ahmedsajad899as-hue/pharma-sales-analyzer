// «المذاخر والبوت» (ماستر أدمن): لكل مذخر — عبر أي بوت تُرسَل طلبياته حين «إرسال عبر البوت»
// مفعّلة في «طلبيات المذاخر»، ومفتاح الإرسال الآلي له.
//   القناة: cloud = البوت الرسمي (رقم المذخر) | group = رقم الكروبات (كروبه) | manual = بلا بوت
//   المفتاح: groupSendOn (لأي قناة) — مطفأ = لا إرسال آلي من أي مسار، والمندوب يرسل يدوياً.
// ربط الكروب نفسه يبقى في «رقم الكروبات»؛ الرقم في دليل المذاخر بالتطبيق.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, UI } from './OfficesPage';
import { Bar, Empty, Seg, Toggle, TAG, ghost, inputSm, th, td } from './saKit';

type Channel = 'cloud' | 'group' | 'manual';
type BotVia = 'cloud' | 'group' | 'off' | 'manual';
interface Wh {
  id: number; name: string; province: string | null; phone: string; hasPhone: boolean;
  channel: Channel; groupJid: string | null; groupName: string | null; groupSendOn: boolean;
  waLastInboundAt: string | null; botVia: BotVia; owner: string | null;
}

const VIA: Record<BotVia, { label: string; style: CSSProperties; hint: string }> = {
  cloud:  { label: '🤖 البوت الرسمي', style: TAG.info, hint: 'يُرسل لرقم واتساب المذخر من رقم البوت الرسمي' },
  group:  { label: '👥 بوت الكروبات', style: TAG.ok, hint: 'يُرسل في كروب المذخر من «رقم الكروبات»' },
  off:    { label: '⛔ موقوف', style: TAG.bad, hint: 'الإرسال الآلي مطفأ — المندوب يرسل يدوياً' },
  manual: { label: '✋ يدوي', style: TAG.mute, hint: 'لا بوت: بلا رقم/كروب أو مضبوط يدوياً' },
};
const FILTERS: (BotVia | 'all')[] = ['all', 'cloud', 'group', 'off', 'manual'];

export default function WarehousesBotPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const [rows, setRows] = useState<Wh[] | null>(null);
  const [channels, setChannels] = useState<{ cloud: boolean; groups: boolean } | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<BotVia | 'all'>('all');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch('/api/sa/wa-groups/warehouses', { headers: H() }).then(r => r.json()).then(d => {
      if (!d.success) { setError(d.error || 'تعذّر التحميل'); setRows([]); return; }
      setRows(d.warehouses); setChannels(d.channels || null);
    }).catch(() => { setError('تعذّر الاتصال بالسيرفر'); setRows([]); });
  }, [H]);
  useEffect(() => { load(); }, [load]);

  const patch = async (w: Wh, body: { channel?: Channel; sendOn?: boolean }) => {
    setBusyId(w.id); setError('');
    try {
      const res = await fetch(`/api/sa/wa-groups/warehouses/${w.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'تعذّر الحفظ');
      setRows(rs => rs && rs.map(x => x.id === w.id ? { ...x, channel: d.channel, groupSendOn: d.groupSendOn, botVia: d.botVia } : x));
    } catch (e: any) { setError(`${w.name}: ${e.message}`); } finally { setBusyId(null); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows?.length ?? 0 };
    for (const w of rows || []) c[w.botVia] = (c[w.botVia] ?? 0) + 1;
    return c;
  }, [rows]);
  const list = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter(w => (filter === 'all' || w.botVia === filter)
      && terms.every(t => `${w.name} ${w.province || ''} ${w.owner || ''} ${w.groupName || ''}`.toLowerCase().includes(t)));
  }, [rows, q, filter]);

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      <Bar end={<button onClick={load} style={ghost()}>تحديث</button>}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث: مذخر، محافظة، صاحب…" style={{ ...inputSm, width: 220 }} />
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} title={f === 'all' ? '' : VIA[f].hint}
            style={{ ...ghost(filter === f ? '#fff' : UI.text), background: filter === f ? '#1e293b' : '#fff' }}>
            {f === 'all' ? 'الكل' : VIA[f].label} <b>{counts[f] ?? 0}</b>
          </button>
        ))}
        {channels && !channels.cloud && <span style={TAG.warn} title="WhatsApp Cloud API غير مضبوط على السيرفر">البوت الرسمي غير مفعّل</span>}
        {channels && !channels.groups && <span style={TAG.warn} title="خدمة رقم الكروبات غير مضبوطة على السيرفر">رقم الكروبات غير مفعّل</span>}
      </Bar>

      {error && <ErrBox msg={error} />}

      <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, overflowX: 'auto' }}>
        {!rows && <Empty text="جاري التحميل…" />}
        {rows && !list.length && <Empty text={rows.length ? 'لا مذخر بهذا البحث' : 'لا مذاخر بعد'} />}
        {rows && list.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                <th style={th}>المذخر</th>
                <th style={th} title="عبر أي بوت تُرسل طلبياته">القناة</th>
                <th style={th} title="مطفأ = لا إرسال آلي لهذا المذخر من أي مسار">الإرسال الآلي</th>
                <th style={th}>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {list.map(w => {
                const busy = busyId === w.id;
                const opts = [
                  ['cloud', '🤖 رسمي', w.hasPhone ? `رقم المذخر: ${w.phone}` : 'بلا رقم واتساب — أضفه من دليل المذاخر'],
                  ['group', '👥 كروب', w.groupJid ? `الكروب: ${w.groupName || w.groupJid}` : 'بلا كروب — اربطه من «رقم الكروبات»'],
                  ['manual', '✋ يدوي', 'لا إرسال آلي'],
                ] as const;
                return (
                  <tr key={w.id} style={{ opacity: busy ? 0.6 : 1, background: w.botVia === 'off' ? '#fffafa' : undefined }}>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>{w.name}</div>
                      <div style={{ fontSize: 11, color: UI.faint }}>
                        {[w.province, w.owner, w.hasPhone ? w.phone : null, w.groupName ? `كروب: ${w.groupName}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td style={td}>
                      <Seg value={w.channel} options={opts} disabled={busy} onChange={v => patch(w, { channel: v })} />
                    </td>
                    <td style={td}>
                      <Toggle on={w.groupSendOn} disabled={busy || w.channel === 'manual'} label={w.groupSendOn ? 'مفعّل' : 'موقوف'}
                        title={w.channel === 'manual' ? 'القناة يدوية — لا إرسال آلي أصلاً' : 'مطفأ = لا تُرسل طلبياته عبر أي بوت'}
                        onToggle={() => patch(w, { sendOn: !w.groupSendOn })} />
                    </td>
                    <td style={td}><span style={VIA[w.botVia].style} title={VIA[w.botVia].hint}>{VIA[w.botVia].label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
