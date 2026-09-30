import { useState } from 'react';
import { smartPlanApi } from './api';
import type { AreaPharmacy, AreaWithDoctors } from './types';

const btn = (tone: 'primary' | 'ghost' | 'danger' = 'ghost'): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
  border: tone === 'primary' ? 'none' : `1px solid ${tone === 'danger' ? 'var(--c-danger-border)' : 'var(--c-border)'}`,
  background: tone === 'primary' ? 'var(--c-accent)' : tone === 'danger' ? 'var(--c-danger-bg)' : 'var(--c-surface)',
  color: tone === 'primary' ? '#fff' : tone === 'danger' ? 'var(--c-danger)' : 'var(--c-text-secondary)',
});

const box: React.CSSProperties = {
  margin: '0 14px 10px', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--c-border)', background: 'var(--c-surface)', fontSize: 12,
  display: 'flex', flexDirection: 'column', gap: 8,
};

const select: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 12, minWidth: 200,
};

/**
 * أدوات صيدليات السيرفي داخل البلان الذكي:
 *  - صيدليات سيرفي متشابهة → اقتراح دمج.
 *  - تعديل اسم صيدلية / دمجها في السيرفي الأصلي.
 *
 * ربط صيدلية «مفتوحة في الملف لكنها غير موجودة في السيرفي» انتقل إلى
 * PharmacyLinkChip: شريحة داخل صف الصيدلية تفتح نافذة بحث ذكي.
 */
export default function PharmacyTools({
  token, planId, area, pharmacy: p, expanded, onDone, onError,
}: {
  token: string; planId: number; area: AreaWithDoctors; pharmacy: AreaPharmacy;
  expanded: boolean; onDone: () => void; onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<null | 'rename' | 'merge'>(null);
  const [newName, setNewName] = useState(p.name ?? '');
  const [other, setOther] = useState('');
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [busy, setBusy] = useState(false);

  if (!p.name) return null;
  const options = area.pharmacies.filter(x => x.name && x.name !== p.name && !x.notInSurvey);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setMode(null); onDone(); }
    catch (e: any) { onError(e.message); }
    finally { setBusy(false); }
  };

  const doRename = () => {
    const name = newName.trim();
    if (!name || name === p.name) return;
    if (!window.confirm(`تعديل اسم الصيدلية «${p.name}» إلى «${name}» في السيرفي الأصلي؟\nيُطبَّق على أطبائها وزياراتها في هذه المنطقة ولكل الحسابات.`)) return;
    run(() => smartPlanApi.renamePharmacy(token, planId, { areaId: area.areaId, oldName: p.name!, newName: name }));
  };

  const doMerge = (otherName: string, keepThis: boolean) => {
    if (!otherName) return;
    const keepName = keepThis ? p.name! : otherName;
    const mergeName = keepThis ? otherName : p.name!;
    if (!window.confirm(`دمج «${mergeName}» داخل «${keepName}» في السيرفي الأصلي؟\nيُنقَل أطباؤها وزياراتها، ويُطبَّق لكل الحسابات ولا يمكن التراجع تلقائياً.`)) return;
    run(() => smartPlanApi.mergePharmacies(token, planId, { areaId: area.areaId, keepName, mergeNames: [mergeName] }));
  };

  const similar = p.similar ?? [];

  return (
    <>
      {!p.notInSurvey && similar.length > 0 && mode !== 'merge' && (
        <div style={{ ...box, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
          <span style={{ color: 'var(--c-text-secondary)' }}>🔁 قد تكون نفس:</span>
          {similar.map(s => (
            <button key={s.name} disabled={busy} style={btn()} onClick={() => { setOther(s.name); setKeep('this'); setMode('merge'); }}>
              {s.name} ({s.doctorCount} طبيب) — دمج؟
            </button>
          ))}
        </div>
      )}

      {(expanded || mode === 'merge' || mode === 'rename') && !p.notInSurvey && (
        <div style={{ ...box, background: 'var(--c-bg)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button title="تعديل الاسم في السيرفي" aria-label="تعديل الاسم في السيرفي" style={{ ...btn(mode === 'rename' ? 'primary' : 'ghost'), padding: '3px 8px', fontSize: 13 }} onClick={() => { setNewName(p.name ?? ''); setMode(mode === 'rename' ? null : 'rename'); }}>✏️</button>
            <button title="دمج مع صيدلية أخرى" aria-label="دمج مع صيدلية أخرى" style={{ ...btn(mode === 'merge' ? 'primary' : 'ghost'), padding: '3px 8px', fontSize: 13 }} onClick={() => setMode(mode === 'merge' ? null : 'merge')}>🔗</button>
          </div>

          {mode === 'rename' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} style={{ ...select, minWidth: 240 }} />
              <button disabled={busy || !newName.trim() || newName.trim() === p.name} style={btn('primary')} onClick={doRename}>حفظ في السيرفي</button>
            </div>
          )}

          {mode === 'merge' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select value={other} onChange={e => setOther(e.target.value)} style={select}>
                <option value="">اختر الصيدلية المراد دمجها...</option>
                {options.map(o => <option key={o.name!} value={o.name!}>{o.name} ({o.doctors.length} طبيب)</option>)}
              </select>
              {other && (
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ cursor: 'pointer' }}><input type="radio" checked={keep === 'this'} onChange={() => setKeep('this')} /> الإبقاء على «{p.name}»</label>
                  <label style={{ cursor: 'pointer' }}><input type="radio" checked={keep === 'other'} onChange={() => setKeep('other')} /> الإبقاء على «{other}»</label>
                  <button disabled={busy} style={btn('primary')} onClick={() => doMerge(other, keep === 'this')}>تنفيذ الدمج</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
