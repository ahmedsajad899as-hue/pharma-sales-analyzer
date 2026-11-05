// ════════════════════════════════════════════════════════════════════════════
// ProvinceRepSeatsForm — مقاعد مندوب في فريق محافظة: مقعد واحد = مندوب خاص إضافي،
// وأكثر = مندوب مشترك يتبع التيم ليدر ومدراء الشركات المختارة، بايتمات كل مدير.
// الخادم: POST /api/sa/users/province-structure/rep-seats (province-seats.js).
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { btnStyle } from './OfficesPage';
import type { ProvSeat, ProvTeamRep, SeatOptions } from './ProvinceSeatsPanel';

interface Pick { on: boolean; all: boolean; ids: number[] }

interface Props {
  officeId: number;
  provinceId: number;
  seats: ProvSeat[];
  options: SeatOptions;
  /** مندوب قائم للتعديل؛ بدونه يُنشأ حساب جديد. */
  rep: (ProvTeamRep & { name: string }) | null;
  presetManagerId: number | null;
  token: string | null;
  onSaved: (note: string) => void;
  onCancel: () => void;
}

const inputStyle = { padding: '7px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' as const };

/** ايتمات المندوب الحالية على هذا المقعد؛ مقعده بكل الشركة يُعرض «كل الايتمات». */
function initialPick(seat: ProvSeat, rep: Props['rep'], preset: number | null, seatItemIds: number[]): Pick {
  if (!rep) return { on: seat.managerUserId === preset, all: true, ids: seatItemIds };
  const on = rep.seatManagerIds.includes(seat.managerUserId);
  const whole = rep.companies.some(c => c.id === seat.companyId && c.allItems);
  const held = new Set(rep.itemIds ?? []);
  const ids = seatItemIds.filter(id => held.has(id));
  const all = !on || whole || !seatItemIds.length || ids.length >= seatItemIds.length;
  return { on, all, ids: all ? seatItemIds : ids };
}

export default function ProvinceRepSeatsForm({ officeId, provinceId, seats, options, rep, presetManagerId, token, onSaved, onCancel }: Props) {
  const itemsOf = (managerUserId: number) => options.seatItems[managerUserId] ?? [];
  const [name, setName] = useState('');
  const [picks, setPicks] = useState<Record<number, Pick>>(() =>
    Object.fromEntries(seats.map(s => [s.managerUserId, initialPick(s, rep, presetManagerId, itemsOf(s.managerUserId).map(i => i.id))])));
  const [openItems, setOpenItems] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = seats.filter(s => picks[s.managerUserId]?.on);
  const setPick = (id: number, patch: Partial<Pick>) => setPicks(p => ({ ...p, [id]: { ...p[id], ...patch } }));
  const shownItems = useMemo(() => {
    if (openItems == null) return [];
    const q = search.trim().toLowerCase();
    return itemsOf(openItems).filter(i => !q || i.name.toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItems, search, options]);

  const toggleItem = (managerUserId: number, itemId: number) => {
    const p = picks[managerUserId];
    const next = p.ids.includes(itemId) ? p.ids.filter(x => x !== itemId) : [...p.ids, itemId];
    setPick(managerUserId, { ids: next, all: next.length >= itemsOf(managerUserId).length });
  };

  const submit = async () => {
    if (busy) return;
    if (!rep && !name.trim()) { setError('اكتب اسم المندوب'); return; }
    if (!chosen.length) { setError('اختر شركة واحدة على الأقل'); return; }
    const emptySeat = chosen.find(s => !picks[s.managerUserId].all && !picks[s.managerUserId].ids.length);
    if (emptySeat) { setError(`اختر ايتماً واحداً على الأقل من ${emptySeat.companyName}`); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/sa/users/province-structure/rep-seats', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId, provinceId,
          ...(rep ? { repUserId: rep.userId } : { name: name.trim() }),
          seats: chosen.map(s => ({ managerUserId: s.managerUserId, ...(picks[s.managerUserId].all ? {} : { itemIds: picks[s.managerUserId].ids }) })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { setError(j.error || j.message || 'تعذّر الحفظ'); return; }
      onSaved(rep ? `تم حفظ مقاعد «${rep.name}»` : `تم إنشاء «${j.username}» — الرمز ${j.password}`);
    } catch {
      setError('تعذّر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!rep && (
        <input value={name} disabled={busy} autoComplete="off" placeholder="اسم المندوب (يصير اسم الدخول)"
          onChange={e => setName(e.target.value)} style={inputStyle} />
      )}
      {seats.map(s => {
        const p = picks[s.managerUserId];
        const total = itemsOf(s.managerUserId).length;
        const open = openItems === s.managerUserId;
        return (
          <div key={s.managerUserId} style={{ border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                <input type="checkbox" checked={p?.on ?? false} disabled={busy} onChange={e => setPick(s.managerUserId, { on: e.target.checked })} />
                {s.companyName}
              </label>
              <span style={{ fontSize: 11.5, color: '#64748b' }}>مدير الشركة: {s.managerName}</span>
              {p?.on && (
                <button type="button" onClick={() => { setOpenItems(open ? null : s.managerUserId); setSearch(''); }}
                  style={{ marginRight: 'auto', fontSize: 11.5, fontFamily: 'inherit', border: '1px solid #c7d2fe', background: '#eef2ff', color: '#3730a3', borderRadius: 16, padding: '2px 10px', cursor: 'pointer' }}>
                  {p.all ? `كل الايتمات (${total})` : `${p.ids.length} من ${total} ايتم`} ▾
                </button>
              )}
            </div>
            {p?.on && open && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={search} placeholder="بحث عن ايتم" onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, fontSize: 12, padding: '4px 8px' }} />
                  <button type="button" onClick={() => setPick(s.managerUserId, { all: true, ids: itemsOf(s.managerUserId).map(i => i.id) })} style={{ ...btnStyle('#64748b'), whiteSpace: 'nowrap' }}>تحديد الكل</button>
                  <button type="button" onClick={() => setPick(s.managerUserId, { all: false, ids: [] })} style={{ ...btnStyle('#64748b'), whiteSpace: 'nowrap' }}>إلغاء الكل</button>
                </div>
                <div style={{ maxHeight: 170, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {shownItems.map(i => (
                    <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }} className="notranslate" translate="no">
                      <input type="checkbox" checked={p.ids.includes(i.id)} onChange={() => toggleItem(s.managerUserId, i.id)} />
                      {i.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 11.5, color: '#64748b' }}>
        {chosen.length > 1
          ? `مندوب مشترك: يتبع تيم ليدر المحافظة و${chosen.length} مدراء شركات، وكل مدير يرى ايتماته فقط.`
          : 'مندوب خاص بهذه الشركة. اختر شركة ثانية ليصير مشتركاً.'}
      </div>
      {error && <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={submit} disabled={busy} style={{ ...btnStyle('#4338ca', true), opacity: busy ? 0.5 : 1 }}>{busy ? 'جارٍ الحفظ...' : 'حفظ'}</button>
        <button type="button" onClick={onCancel} disabled={busy} style={btnStyle('#64748b')}>إلغاء</button>
      </div>
    </div>
  );
}
