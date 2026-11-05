// ════════════════════════════════════════════════════════════════════════════
// ProvinceSeatsPanel — مقاعد فريق محافظة: تيم ليدر + مقعد مندوب لكل مدير شركة.
// المقعد الشاغر يُملأ بكتابة اسم، وكل اسم يصير حساباً جديداً (مسار الخادم:
// server/modules/admin-users/province-seats.js).
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './OfficesPage';
import type { RowOpts } from './usersCommon';
import ProvinceRepSeatsForm from './ProvinceRepSeatsForm';
import ProvinceSplitEditor from './ProvinceSplitEditor';

export interface ProvSeat {
  managerUserId: number; managerName: string; officeId: number;
  companyId: number; companyName: string; itemCount: number;
}
export interface ProvTeamRep {
  userId: number;
  companies: { id: number; name: string; allItems: boolean; itemCount: number }[];
  seatManagerIds: number[];
  /** ايتمات تعييناته الصريحة، لتعبئة نموذج المقاعد. */
  itemIds?: number[];
}
export interface ProvSplit { managerUserId: number; mode: string; scopes: unknown }
export interface SeatOptions {
  seatItems: Record<number, { id: number; name: string }[]>;
  areas: string[];
  customers: string[];
}

interface Props<U> {
  officeId: number;
  province: { id: number; name: string };
  leaderUserId: number | null;
  reps: ProvTeamRep[];
  seats: ProvSeat[];
  splits: ProvSplit[];
  leaderChoices: { id: number; label: string }[];
  saving: boolean;
  userById: Map<number, U>;
  renderUser: (u: U, opts?: RowOpts) => ReactNode;
  userLabel: (u: U) => string;
  onSetLeader: (leaderUserId: number | null) => void;
  /** إعادة جلب بلا مؤشر تحميل: اللوحة تبقى ظاهرة بما فشل من أسماء. */
  onCreated: () => void;
  token: string | null;
}

const LEADER_KEY = 'leader';
const repKey = (managerUserId: number) => `m${managerUserId}`;

function SeatRow({ title, sub, filled, error, tool, children }: { title: string; sub: ReactNode; filled: boolean; error?: string; tool?: ReactNode; children: ReactNode }) {
  return (
    <div className="ud-seat">
      <div>
        <div className="ud-seat-title">
          <i className={filled ? undefined : 'is-vacant'} title={filled ? 'ممتلئ' : 'شاغر'} />
          <span>{title}</span>
          {!filled && <em>شاغر</em>}
        </div>
        <div className="ud-seat-sub">{sub}</div>
        {tool && <div className="ud-seat-tool">{tool}</div>}
      </div>
      <div className="ud-seat-body">
        {children}
        {error && <div className="ud-err">{error}</div>}
      </div>
    </div>
  );
}

export default function ProvinceSeatsPanel<U>({ officeId, province, leaderUserId, reps, seats, splits, leaderChoices, saving, userById, renderUser, userLabel, onSetLeader, onCreated, token }: Props<U>) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // نموذج المقاعد: مندوب جديد (repUserId=null) بشركة محددة مسبقاً، أو مندوب قائم.
  const [form, setForm] = useState<{ repUserId: number | null; presetManagerId: number | null } | null>(null);
  const [options, setOptions] = useState<SeatOptions | null>(null);
  const hasMultiRepSeat = seats.some(s => reps.filter(r => r.seatManagerIds.includes(s.managerUserId)).length > 1);

  // الايتمات والمناطق والزبائن تُجلب حين يلزم نموذج أو تقسيم، لا لكل محافظة تُفتح.
  useEffect(() => {
    if (options || (!form && !hasMultiRepSeat)) return;
    let dead = false;
    fetch(`/api/sa/users/province-structure/seat-options?officeId=${officeId}&provinceId=${province.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => { if (!dead && j.success) setOptions({ seatItems: j.seatItems, areas: j.areas, customers: j.customers }); })
      .catch(() => {});
    return () => { dead = true; };
  }, [form, hasMultiRepSeat, options, officeId, province.id, token]);

  const nameOfRep = (userId: number) => { const u = userById.get(userId); return u ? userLabel(u) : `#${userId}`; };
  const sharedReps = reps.filter(r => r.seatManagerIds.length > 1);
  const seatNames = (r: ProvTeamRep) => seats.filter(s => r.seatManagerIds.includes(s.managerUserId)).map(s => s.companyName).join(' + ');
  const formRep = form?.repUserId != null ? reps.find(r => r.userId === form.repUserId) ?? null : null;

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
      className={`ud-input${errors[key] ? ' is-bad' : ''}`} />
  );

  // زر «المقاعد والايتمات» صار داخل قائمة صف المندوب.
  const seatsMenu = (r: ProvTeamRep): RowOpts['extra'] => [{ label: 'المقاعد والايتمات', onClick: () => setForm({ repUserId: r.userId, presetManagerId: null }) }];

  const leaderSelect = (
    <select value={leaderUserId ?? ''} disabled={saving || busy} aria-label="اختيار تيم ليدر المحافظة"
      onChange={e => {
        const id = e.target.value ? Number(e.target.value) : null;
        const label = leaderChoices.find(x => x.id === id)?.label;
        const message = id
          ? `«${label}» سيصبح تيم ليدر ${province.name} ومديراً لكل مندوبيها (${reps.length}). متابعة؟`
          : `إزالة تيم ليدر ${province.name} وفك ارتباطه بمندوبيها (${reps.length})؟`;
        if (window.confirm(message)) onSetLeader(id);
      }}>
      <option value="">{leaderUserId == null ? '— أو اختر حساباً موجوداً —' : '— بلا تيم ليدر —'}</option>
      {leaderChoices.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
    </select>
  );

  return (
    <div className="ud-seats">
      <div className="ud-table">
        <SeatRow title="تيم ليدر المحافظة" sub="كل الشركات والايتمات لكل مدراء الشركات، بلا شركة رئيسية" filled={leaderUserId != null} error={errors[LEADER_KEY]} tool={leaderSelect}>
          {leaderUserId == null && nameInput(LEADER_KEY, 'اسم تيم ليدر جديد')}
          {leader && renderUser(leader)}
        </SeatRow>

        {seats.map(s => {
          const occupants = occupantsOf(s);
          const key = repKey(s.managerUserId);
          return (
            <SeatRow key={s.managerUserId} title={s.companyName}
              sub={`مدير الشركة: ${s.managerName} · ${s.itemCount ? `${s.itemCount} ايتم` : 'كل ايتمات الشركة'}`}
              filled={occupants.length > 0} error={errors[key]}
              tool={<button type="button" className="ud-seat-link" onClick={() => setForm({ repUserId: null, presetManagerId: s.managerUserId })}>+ مندوب آخر لهذه الشركة</button>}>
              {occupants.length === 0 && nameInput(key, `اسم مندوب ${s.companyName}`)}
              {occupants.map(r => {
                const u = userById.get(r.userId);
                if (!u) return null;
                return (
                  <div key={r.userId}>
                    {renderUser(u, { extra: seatsMenu(r), tag: r.seatManagerIds.length > 1 ? 'مشترك' : undefined })}
                  </div>
                );
              })}
              {occupants.length > 1 && (
                <ProvinceSplitEditor key={`${s.managerUserId}-${occupants.length}`} officeId={officeId} provinceId={province.id} managerUserId={s.managerUserId}
                  reps={occupants.map(r => ({ userId: r.userId, name: nameOfRep(r.userId) }))}
                  split={splits.find(x => x.managerUserId === s.managerUserId)} options={options} token={token} onSaved={onCreated} />
              )}
            </SeatRow>
          );
        })}

        {seats.length === 0 && (
          <div className="ud-empty">لا يوجد مدراء شركات نشطون في هذا المكتب، فلا توجد مقاعد للمندوبين.</div>
        )}
      </div>

      {fillable.size > 0 && (
        <div className="ud-submit">
          <button type="button" className="ud-btn is-primary is-sm" onClick={submit} disabled={!namesReady || busy}>
            {busy ? 'جارٍ الإنشاء...' : namesReady ? `إنشاء ${namesReady} حساب` : 'اكتب اسماً في مقعد شاغر'}
          </button>
          <span>اسم الدخول هو الاسم المكتوب، والرمز 123456789 · مدراء المندوب: تيم ليدر المحافظة ومدير الشركة</span>
        </div>
      )}

      {notes.length > 0 && <div className="ud-notes">{notes.map((n, i) => <div key={i}>{n}</div>)}</div>}

      <div className="ud-table">
        <div className="ud-section-head">
          <span>مندوبون مشتركون بين الشركات ({sharedReps.length})</span>
          <button type="button" className="ud-link" onClick={() => setForm({ repUserId: null, presetManagerId: null })}>+ مندوب مشترك</button>
        </div>
        <div className="ud-section-body">
          {sharedReps.length === 0 && <div className="ud-section-hint">مندوب واحد لأكثر من شركة: كل مدير شركة يرى نصيبه منه، والتيم ليدر يراه كاملاً.</div>}
          {sharedReps.map(r => {
            const u = userById.get(r.userId);
            if (!u) return null;
            return <div key={r.userId}>{renderUser(u, { extra: seatsMenu(r), tag: `مشترك: ${seatNames(r)}` })}</div>;
          })}
        </div>
      </div>

      {outsideSeats.length > 0 && (
        <div className="ud-table">
          <div className="ud-section-head"><span>مندوبون آخرون في الفريق ({outsideSeats.length}) — ايتماتهم لا تتبع مقعد مدير</span></div>
          <div className="ud-section-body">
            {outsideSeats.map(r => {
              const u = userById.get(r.userId);
              if (!u) return null;
              const note = r.companies.map(c => `${c.name}: ${c.allItems ? 'كل الايتمات' : `${c.itemCount} ايتم`}`).join('، ');
              return <div key={r.userId}>{renderUser(u, { note })}</div>;
            })}
          </div>
        </div>
      )}

      {form && createPortal(
        <Modal title={formRep ? `مقاعد «${nameOfRep(formRep.userId)}»` : 'مندوب جديد في المحافظة'} maxWidth={620} footer={<span />} onClose={() => setForm(null)}>
          {options
            ? <ProvinceRepSeatsForm key={`${form.repUserId ?? 'new'}-${form.presetManagerId ?? ''}`}
                officeId={officeId} provinceId={province.id} seats={seats} options={options}
                rep={formRep ? { ...formRep, name: nameOfRep(formRep.userId) } : null}
                presetManagerId={form.presetManagerId} token={token}
                onSaved={(note) => { setNotes([note]); setForm(null); onCreated(); }}
                onCancel={() => setForm(null)} />
            : <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 12 }}>جارٍ تحميل الايتمات…</div>}
        </Modal>,
        document.body,
      )}
    </div>
  );
}
