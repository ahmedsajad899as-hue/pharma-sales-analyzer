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
 * أدوات الصيدلية داخل البلان الذكي:
 *  - صيدلية مفتوحة في الملف لكنها غير معروفة في السيرفي → "هل هي نفس صيدلية كذا؟"
 *    والجواب يُحفَظ كتعريف عالمي لكل الحسابات فلا يتكرر السؤال.
 *  - صيدليات سيرفي متشابهة → اقتراح دمج.
 *  - تعديل اسم صيدلية / دمجها في السيرفي الأصلي.
 */
export default function PharmacyTools({
  token, planId, area, pharmacy: p, expanded, onDone, onError,
}: {
  token: string; planId: number; area: AreaWithDoctors; pharmacy: AreaPharmacy;
  expanded: boolean; onDone: () => void; onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<null | 'rename' | 'merge' | 'link'>(null);
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

  const link = (toName: string | null) => run(() => smartPlanApi.savePharmacyLink(token, planId, {
    fromName: p.fileEntry?.name ?? p.name!, areaName: p.fileEntry?.areaName ?? area.areaName, toName,
  }));

  const unlink = () => run(() => smartPlanApi.removePharmacyLink(token, planId, {
    fromName: p.fileEntry?.name ?? p.name!, areaName: p.fileEntry?.areaName ?? area.areaName,
  }));

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

  const askLink = p.notInSurvey && !p.separate;
  const similar = p.similar ?? [];

  return (
    <>
      {askLink && (
        <div style={{ ...box, borderColor: 'var(--c-danger-border)', background: 'var(--c-danger-bg)' }} onClick={e => e.stopPropagation()}>
          <div style={{ color: 'var(--c-text-primary)' }}>
            ❓ «<strong>{p.name}</strong>» مفتوحة في الملف لكنها غير موجودة في السيرفي بهذا الاسم. هل هي نفس إحدى صيدليات السيرفي؟
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {similar.map(s => (
              <button key={s.name} disabled={busy} style={btn('primary')} onClick={() => link(s.name)}>
                ✓ نعم، هي «{s.name}» ({s.doctorCount} طبيب)
              </button>
            ))}
            <button disabled={busy} style={btn()} onClick={() => setMode(mode === 'link' ? null : 'link')}>🔎 اختيار صيدلية أخرى</button>
            <button disabled={busy} style={btn('danger')} onClick={() => link(null)}>✗ صيدلية مستقلة (لا تسأل مجدداً)</button>
          </div>
          {mode === 'link' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select value={other} onChange={e => setOther(e.target.value)} style={select}>
                <option value="">اختر صيدلية السيرفي في {area.areaName}...</option>
                {options.map(o => <option key={o.name!} value={o.name!}>{o.name} ({o.doctors.length} طبيب)</option>)}
              </select>
              <button disabled={busy || !other} style={btn('primary')} onClick={() => link(other)}>تأكيد التعريف</button>
            </div>
          )}
          <div style={{ color: 'var(--c-text-muted)', fontSize: 11 }}>التعريف يُحفَظ ويُطبَّق على كل الحسابات — لن يُسأل عنها أحد مرة أخرى.</div>
        </div>
      )}

      {p.separate && (
        <div style={{ ...box, flexDirection: 'row', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
          <span style={{ color: 'var(--c-text-muted)' }}>مؤكَّدة كصيدلية مستقلة غير موجودة في السيرفي.</span>
          <button disabled={busy} style={btn()} onClick={unlink}>إعادة السؤال</button>
        </div>
      )}

      {p.linkedFrom && (
        <div style={{ ...box, flexDirection: 'row', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
          <span style={{ color: 'var(--c-text-secondary)' }}>🔗 مربوطة بالاسم «{p.linkedFrom}» من ملف المفتوحة (تعريف محفوظ لكل الحسابات).</span>
          <button disabled={busy} style={btn('danger')} onClick={unlink}>فك الربط</button>
        </div>
      )}

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
            <button style={btn(mode === 'rename' ? 'primary' : 'ghost')} onClick={() => { setNewName(p.name ?? ''); setMode(mode === 'rename' ? null : 'rename'); }}>✏️ تعديل الاسم في السيرفي</button>
            <button style={btn(mode === 'merge' ? 'primary' : 'ghost')} onClick={() => setMode(mode === 'merge' ? null : 'merge')}>🔗 دمج مع صيدلية أخرى</button>
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
