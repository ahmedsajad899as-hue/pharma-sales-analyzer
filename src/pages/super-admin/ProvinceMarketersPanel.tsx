// ════════════════════════════════════════════════════════════════════════════
// ProvinceMarketersPanel — مسوقو محافظة: مستقلون عن تيم ليدر وعلميي الفريق.
// كل اسم يُكتب يصير حساباً جديداً يتبع مدير المسوقين ويأخذ شركاته وايتماته
// (مسار الخادم: createProvinceMarketers في admin-users/province-seats.js).
// ════════════════════════════════════════════════════════════════════════════
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface ProvMarketerManager {
  managerUserId: number; managerName: string; officeId: number;
  companyCount: number; itemCount: number; handlesProvinces: boolean;
}
export interface ProvMarketer { userId: number; officeId: number; provinceIds: number[] }

interface Props<U> {
  officeId: number;
  province: { id: number; name: string };
  marketers: U[];
  managers: ProvMarketerManager[];
  userKey: (u: U) => number;
  renderUser: (u: U) => ReactNode;
  /** إعادة جلب بلا مؤشر تحميل: اللوحة تبقى ظاهرة بما فشل من أسماء. */
  onCreated: () => void;
  token: string | null;
}

interface NameRow { key: number; name: string; error?: string }

export default function ProvinceMarketersPanel<U>({ officeId, province, marketers, managers, userKey, renderUser, onCreated, token }: Props<U>) {
  const nextKey = useRef(1);
  const [rows, setRows] = useState<NameRow[]>([{ key: 0, name: '' }]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // نموذج الإضافة مفتوح حين لا يوجد مسوق؛ وإلا يبقى خلف زر كي لا يزاحم القائمة.
  const [adding, setAdding] = useState(marketers.length === 0);
  const provinceManagers = managers.filter(m => m.handlesProvinces);
  // مدير محافظات واحد يُحسم تلقائياً؛ غير ذلك يختار السوبر أدمن من القائمة.
  const autoManager = provinceManagers.length === 1 ? provinceManagers[0] : null;
  const [pickedId, setPickedId] = useState<number | null>(null);
  const manager = autoManager ?? managers.find(m => m.managerUserId === pickedId) ?? null;

  const ready = rows.filter(r => r.name.trim()).length;
  const canSubmit = !!manager && ready > 0 && !busy;

  const setName = (key: number, name: string) => setRows(rs => rs.map(r => (r.key === key ? { key, name } : r)));
  const addRow = () => setRows(rs => [...rs, { key: nextKey.current++, name: '' }]);
  const removeRow = (key: number) => setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : [{ key: rs[0].key, name: '' }]));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setNotes([]);
    try {
      const res = await fetch('/api/sa/users/province-structure/marketers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId, provinceId: province.id, managerUserId: manager!.managerUserId,
          names: rows.filter(r => r.name.trim()).map(r => ({ key: r.key, name: r.name })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { setNotes([j.error || 'تعذّر إنشاء الحسابات']); return; }
      const results = j.results as { seatKey: number; ok: boolean; error?: string; username?: string }[];
      const createdKeys = new Set(results.filter(r => r.ok).map(r => r.seatKey));
      const errorOf = new Map(results.filter(r => !r.ok).map(r => [r.seatKey, r.error]));
      setNotes(results.filter(r => r.ok).map(r => `تم إنشاء «${r.username}» — الرمز ${j.password}`));
      setRows(rs => {
        const left = rs.filter(r => !createdKeys.has(r.key)).map(r => ({ key: r.key, name: r.name, error: errorOf.get(r.key) }));
        return left.length ? left : [{ key: nextKey.current++, name: '' }];
      });
      if (createdKeys.size) onCreated();
    } catch {
      setNotes(['تعذّر الاتصال بالخادم']);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ud-seats">
      {marketers.length > 0 && (
        <div className="ud-table">
          <div className="ud-section-body">
            {marketers.map(u => <div key={userKey(u)}>{renderUser(u)}</div>)}
          </div>
        </div>
      )}

      {managers.length === 0 && (
        <div className="ud-section-hint" style={{ color: '#b45309' }}>لا يوجد مدير مسوقين نشط في هذا المكتب، فلا يمكن إنشاء مسوق.</div>
      )}

      {managers.length > 0 && !adding && (
        <div><button type="button" className="ud-btn is-sm" onClick={() => setAdding(true)}>+ إضافة مسوق</button></div>
      )}

      {managers.length > 0 && adding && (
        <div className="ud-table">
          <div className="ud-section-head"><span>مسوق جديد في {province.name}</span></div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!autoManager && (
              <select className="ud-input" aria-label="مدير المسوقين" value={pickedId ?? ''} disabled={busy} onChange={e => setPickedId(e.target.value ? Number(e.target.value) : null)} style={{ maxWidth: 280 }}>
                <option value="">— اختر مدير المسوقين —</option>
                {managers.map(m => <option key={m.managerUserId} value={m.managerUserId}>{m.managerName}</option>)}
              </select>
            )}
            {manager && <>
              {rows.map(r => (
                <div key={r.key}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input className={`ud-input${r.error ? ' is-bad' : ''}`} value={r.name} disabled={busy} placeholder={`اسم مسوق ${province.name}`} autoComplete="off"
                      onChange={e => setName(r.key, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
                    {rows.length > 1 && (
                      <button type="button" className="ud-icon-btn is-border" onClick={() => removeRow(r.key)} disabled={busy} aria-label="إزالة الاسم">✕</button>
                    )}
                  </div>
                  {r.error && <div className="ud-err">{r.error}</div>}
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="ud-btn is-primary is-sm" onClick={submit} disabled={!canSubmit}>
                  {busy ? 'جارٍ الإنشاء...' : ready ? `إنشاء ${ready} حساب` : 'اكتب اسم المسوق'}
                </button>
                <button type="button" className="ud-btn is-sm" onClick={addRow} disabled={busy}>+ اسم آخر</button>
              </div>
              <div className="ud-submit" style={{ lineHeight: 1.7 }}>
                اسم الدخول هو الاسم المكتوب، والرمز 123456789 · مديره {manager.managerName} · شركاته وايتماته من {manager.managerName}: {manager.companyCount} شركة، {manager.itemCount ? `${manager.itemCount} ايتم` : 'كل ايتمات شركاته'}
              </div>
            </>}
          </div>
        </div>
      )}

      {notes.length > 0 && <div className="ud-notes">{notes.map((n, i) => <div key={i}>{n}</div>)}</div>}
    </div>
  );
}
