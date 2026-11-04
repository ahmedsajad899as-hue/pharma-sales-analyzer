// ════════════════════════════════════════════════════════════════════════════
// ProvinceMarketersPanel — مسوقو محافظة: مستقلون عن تيم ليدر وعلميي الفريق.
// كل اسم يُكتب يصير حساباً جديداً يتبع مدير المسوقين ويأخذ شركاته وايتماته
// (مسار الخادم: createProvinceMarketers في admin-users/province-seats.js).
// ════════════════════════════════════════════════════════════════════════════
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { btnStyle } from './OfficesPage';

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

const inputStyle = { padding: '7px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', flex: '1 1 180px', minWidth: 0, boxSizing: 'border-box' as const };

export default function ProvinceMarketersPanel<U>({ officeId, province, marketers, managers, userKey, renderUser, onCreated, token }: Props<U>) {
  const nextKey = useRef(1);
  const [rows, setRows] = useState<NameRow[]>([{ key: 0, name: '' }]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
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
    <div style={{ border: '1px solid #bbf7d0', borderRadius: 10, background: '#f7fef9', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 13, color: '#047857' }}>🏪 {province.name}</span>
        <span style={{ fontSize: 11.5, color: '#64748b' }}>{marketers.length ? `${marketers.length} مسوق` : 'لا يوجد مسوق بعد'}</span>
      </div>

      {marketers.map(u => <div key={userKey(u)}>{renderUser(u)}</div>)}

      {!autoManager && managers.length > 0 && (
        <select value={pickedId ?? ''} disabled={busy} onChange={e => setPickedId(e.target.value ? Number(e.target.value) : null)} style={{ ...inputStyle, flex: '0 1 260px' }}>
          <option value="">— اختر مدير المسوقين —</option>
          {managers.map(m => <option key={m.managerUserId} value={m.managerUserId}>{m.managerName}</option>)}
        </select>
      )}
      {managers.length === 0 && (
        <div style={{ fontSize: 12.5, color: '#b45309' }}>لا يوجد مدير مسوقين نشط في هذا المكتب، فلا يمكن إنشاء مسوق.</div>
      )}

      {manager && <>
        {rows.map(r => (
          <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={r.name} disabled={busy} placeholder={`اسم مسوق ${province.name}`} autoComplete="off"
                onChange={e => setName(r.key, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                style={{ ...inputStyle, borderColor: r.error ? '#f87171' : '#cbd5e1' }} />
              {rows.length > 1 && (
                <button type="button" onClick={() => removeRow(r.key)} disabled={busy} aria-label="إزالة الاسم"
                  style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', color: '#64748b', fontFamily: 'inherit' }}>✕</button>
              )}
            </div>
            {r.error && <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>{r.error}</div>}
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={addRow} disabled={busy}
            style={{ border: '1px dashed #6ee7b7', background: '#fff', color: '#047857', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            + اسم آخر
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit}
            style={{ ...btnStyle('#047857', true), opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
            {busy ? 'جارٍ الإنشاء...' : ready ? `إنشاء ${ready} حساب` : 'اكتب اسم المسوق'}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.7 }}>
          اسم الدخول هو الاسم المكتوب، والرمز 123456789 · مديره {manager.managerName} · شركاته وايتماته من {manager.managerName}: {manager.companyCount} شركة، {manager.itemCount ? `${manager.itemCount} ايتم` : 'كل ايتمات شركاته'}
        </div>
      </>}

      {notes.length > 0 && (
        <div style={{ fontSize: 12, color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 8, padding: '6px 10px', lineHeight: 1.8 }}>
          {notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}
    </div>
  );
}
