// ════════════════════════════════════════════════════════════════════════════
// ProvinceSeatsPanel — مقاعد فريق محافظة: تيم ليدر + مقعد مندوب لكل مدير شركة.
// المقعد الشاغر يُملأ بكتابة اسم، وكل اسم يصير حساباً جديداً (مسار الخادم:
// server/modules/admin-users/province-seats.js).
// ════════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import type { ReactNode } from 'react';
import { btnStyle } from './OfficesPage';

export interface ProvSeat {
  managerUserId: number; managerName: string; officeId: number;
  companyId: number; companyName: string; itemCount: number;
}
export interface ProvTeamRep {
  userId: number;
  companies: { id: number; name: string; allItems: boolean; itemCount: number }[];
  seatManagerIds: number[];
}

interface Props<U> {
  officeId: number;
  province: { id: number; name: string };
  leaderUserId: number | null;
  reps: ProvTeamRep[];
  seats: ProvSeat[];
  leaderChoices: { id: number; label: string }[];
  saving: boolean;
  userById: Map<number, U>;
  renderUser: (u: U, indent?: boolean) => ReactNode;
  onSetLeader: (leaderUserId: number | null) => void;
  /** إعادة جلب بلا مؤشر تحميل: اللوحة تبقى ظاهرة بما فشل من أسماء. */
  onCreated: () => void;
  token: string | null;
}

const LEADER_KEY = 'leader';
const repKey = (managerUserId: number) => `m${managerUserId}`;

const inputStyle = { padding: '7px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', flex: '1 1 180px', minWidth: 0, boxSizing: 'border-box' as const };

function StatusChip({ filled }: { filled: boolean }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '1px 9px', whiteSpace: 'nowrap', background: filled ? '#dcfce7' : '#fef3c7', color: filled ? '#15803d' : '#b45309' }}>
      {filled ? 'ممتلئ' : 'شاغر'}
    </span>
  );
}

function SeatRow({ title, sub, filled, error, children }: { title: string; sub: string; filled: boolean; error?: string; children: ReactNode }) {
  return (
    <div style={{ border: filled ? '1px solid #bbf7d0' : '1px dashed #fcd34d', background: filled ? '#fff' : '#fffdf5', borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StatusChip filled={filled} />
        <span style={{ fontWeight: 800, fontSize: 13, color: '#0f172a' }}>{title}</span>
        <span style={{ fontSize: 11.5, color: '#64748b' }}>{sub}</span>
      </div>
      {children}
      {error && <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
    </div>
  );
}

export default function ProvinceSeatsPanel<U>({ officeId, province, leaderUserId, reps, seats, leaderChoices, saving, userById, renderUser, onSetLeader, onCreated, token }: Props<U>) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const leader = leaderUserId != null ? userById.get(leaderUserId) : undefined;
  const occupantsOf = (s: ProvSeat) => reps.filter(r => r.seatManagerIds.includes(s.managerUserId));
  const outsideSeats = reps.filter(r => !seats.some(s => r.seatManagerIds.includes(s.managerUserId)));
  const vacant = seats.filter(s => occupantsOf(s).length === 0).length + (leaderUserId == null ? 1 : 0);
  const total = seats.length + 1;

  // المقعد الذي امتلأ لتوّه يخرج من الحساب حتى لو بقي له نص قديم.
  const fillable = new Set<string>([...(leaderUserId == null ? [LEADER_KEY] : []), ...seats.filter(s => occupantsOf(s).length === 0).map(s => repKey(s.managerUserId))]);
  const namesReady = Object.entries(drafts).filter(([k, v]) => fillable.has(k) && v.trim()).length;

  const setDraft = (key: string, value: string) => {
    setDrafts(d => ({ ...d, [key]: value }));
    setErrors(e => { if (!e[key]) return e; const n = { ...e }; delete n[key]; return n; });
  };

  const submit = async () => {
    if (!namesReady || busy) return;
    setBusy(true); setNotes([]);
    try {
      const res = await fetch('/api/sa/users/province-structure/seats', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId, provinceId: province.id,
          leaderName: fillable.has(LEADER_KEY) ? (drafts[LEADER_KEY] ?? '') : '',
          reps: seats.filter(s => fillable.has(repKey(s.managerUserId))).map(s => ({ managerUserId: s.managerUserId, name: drafts[repKey(s.managerUserId)] ?? '' })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { setNotes([j.error || 'تعذّر إنشاء الحسابات']); return; }
      const nextErrors: Record<string, string> = {};
      const nextNotes: string[] = [];
      const created: string[] = [];
      for (const r of j.results as { seatKey: string; ok: boolean; error?: string; username?: string; warnings?: string[] }[]) {
        if (r.ok) {
          created.push(r.seatKey);
          nextNotes.push(`تم إنشاء «${r.username}» — الرمز ${j.password}`, ...(r.warnings ?? []).map(w => `${r.username}: ${w}`));
        } else if (r.error) {
          nextErrors[r.seatKey] = r.error;
        }
      }
      setErrors(nextErrors);
      setNotes(nextNotes);
      setDrafts(d => { const n = { ...d }; for (const k of created) delete n[k]; return n; });
      if (created.length) onCreated();
    } catch {
      setNotes(['تعذّر الاتصال بالخادم']);
    } finally {
      setBusy(false);
    }
  };

  const nameInput = (key: string, placeholder: string) => (
    <input value={drafts[key] ?? ''} disabled={busy} placeholder={placeholder}
      onChange={e => setDraft(key, e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') submit(); }}
      autoComplete="off"
      style={{ ...inputStyle, borderColor: errors[key] ? '#f87171' : '#cbd5e1' }} />
  );

  return (
    <div style={{ border: '1px solid #cffafe', borderRadius: 10, background: '#f8feff', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 13, color: '#0e7490' }}>🗺️ {province.name}</span>
        <span style={{ fontSize: 11.5, color: '#64748b' }}>{vacant} شاغر · {total - vacant} ممتلئ من {total} مقعد</span>
      </div>

      <SeatRow title="تيم ليدر المحافظة" sub="كل الشركات والايتمات لكل مدراء الشركات، بلا شركة رئيسية" filled={leaderUserId != null} error={errors[LEADER_KEY]}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {leaderUserId == null && nameInput(LEADER_KEY, 'اسم تيم ليدر جديد')}
          <select value={leaderUserId ?? ''} disabled={saving || busy}
            onChange={e => onSetLeader(e.target.value ? Number(e.target.value) : null)}
            style={{ ...inputStyle, flex: '0 1 220px' }}>
            <option value="">{leaderUserId == null ? '— أو اختر حساباً موجوداً —' : '— بلا تيم ليدر —'}</option>
            {leaderChoices.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
        {leader && renderUser(leader)}
      </SeatRow>

      {seats.map(s => {
        const occupants = occupantsOf(s);
        const key = repKey(s.managerUserId);
        return (
          <SeatRow key={s.managerUserId} title={s.companyName}
            sub={`مدير الشركة: ${s.managerName} · ${s.itemCount ? `${s.itemCount} ايتم` : 'كل ايتمات الشركة'}`}
            filled={occupants.length > 0} error={errors[key]}>
            {occupants.length === 0 && <div style={{ display: 'flex' }}>{nameInput(key, `اسم مندوب ${s.companyName}`)}</div>}
            {occupants.map(r => {
              const u = userById.get(r.userId);
              return u ? <div key={r.userId}>{renderUser(u, true)}</div> : null;
            })}
          </SeatRow>
        );
      })}

      {seats.length === 0 && (
        <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '4px 2px' }}>لا يوجد مدراء شركات نشطون في هذا المكتب، فلا توجد مقاعد للمندوبين.</div>
      )}

      {outsideSeats.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 700 }}>مندوبون آخرون في الفريق ({outsideSeats.length}) — ايتماتهم لا تتبع مقعد مدير</div>
          {outsideSeats.map(r => {
            const u = userById.get(r.userId);
            if (!u) return null;
            return (
              <div key={r.userId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {renderUser(u, true)}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginRight: 40 }}>
                  {r.companies.map(c => (
                    <span key={c.id} style={{ fontSize: 11, background: '#ede9fe', color: '#5b21b6', borderRadius: 20, padding: '1px 9px', fontWeight: 600 }}>
                      🏭 {c.name} · {c.allItems ? 'كل الايتمات' : `${c.itemCount} ايتم`}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {notes.length > 0 && (
        <div style={{ fontSize: 12, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '6px 10px', lineHeight: 1.8 }}>
          {notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}

      {fillable.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={submit} disabled={!namesReady || busy}
            style={{ ...btnStyle('#0e7490', true), opacity: !namesReady || busy ? 0.5 : 1, cursor: !namesReady || busy ? 'not-allowed' : 'pointer' }}>
            {busy ? 'جارٍ الإنشاء...' : namesReady ? `إنشاء ${namesReady} حساب` : 'اكتب اسماً في مقعد شاغر'}
          </button>
          <span style={{ fontSize: 11.5, color: '#64748b' }}>اسم الدخول هو الاسم المكتوب، والرمز 123456789</span>
        </div>
      )}
    </div>
  );
}
