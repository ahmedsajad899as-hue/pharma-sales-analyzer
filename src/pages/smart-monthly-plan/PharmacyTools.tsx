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

const chipBtn: React.CSSProperties = {
  padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--c-border)',
};

const roundBtn: React.CSSProperties = {
  width: 30, height: 30, borderRadius: '50%', fontSize: 14, cursor: 'pointer', lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid var(--c-border)', background: 'var(--c-surface)', color: 'var(--c-text-secondary)',
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
        <div
          onClick={e => e.stopPropagation()}
          style={{
            margin: '0 14px 10px', padding: '8px 10px', borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(90deg, var(--c-warning-bg), var(--c-surface))',
            border: '1px solid var(--c-border)', borderInlineStart: '3px solid var(--c-warning)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span title="غير موجودة في السيرفي — هل هي نفس صيدلية موجودة؟" style={{ fontSize: 16, lineHeight: 1 }}>🔗❓</span>
            {similar.map(s => (
              <button key={s.name} disabled={busy} onClick={() => link(s.name)}
                title={`نعم، هي «${s.name}»`}
                style={{ ...chipBtn, background: 'var(--c-accent-light)', color: 'var(--c-accent)', borderColor: 'var(--c-accent)' }}>
                ✓ {s.name} <span style={{ opacity: 0.7 }}>· 👨‍⚕️{s.doctorCount}</span>
              </button>
            ))}
            <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
              <button disabled={busy} title="اختيار صيدلية أخرى من السيرفي" aria-label="اختيار صيدلية أخرى"
                onClick={() => setMode(mode === 'link' ? null : 'link')}
                style={{ ...roundBtn, ...(mode === 'link' ? { background: 'var(--c-accent)', color: '#fff', borderColor: 'var(--c-accent)' } : null) }}>🔎</button>
              <button disabled={busy} title="صيدلية مستقلة — لا تسأل مجدداً (يُطبَّق على كل الحسابات)" aria-label="صيدلية مستقلة"
                onClick={() => link(null)}
                style={{ ...roundBtn, color: 'var(--c-danger)', borderColor: 'var(--c-danger-border)', background: 'var(--c-danger-bg)' }}>🚫</button>
            </span>
          </div>
          {mode === 'link' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={other} onChange={e => setOther(e.target.value)} style={{ ...select, flex: 1 }}>
                <option value="">📍 {area.areaName}</option>
                {options.map(o => <option key={o.name!} value={o.name!}>{o.name} · 👨‍⚕️{o.doctors.length}</option>)}
              </select>
              <button disabled={busy || !other} title="تأكيد" aria-label="تأكيد" onClick={() => link(other)}
                style={{ ...roundBtn, background: 'var(--c-accent)', color: '#fff', borderColor: 'var(--c-accent)', opacity: !other ? 0.5 : 1 }}>✓</button>
            </div>
          )}
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
