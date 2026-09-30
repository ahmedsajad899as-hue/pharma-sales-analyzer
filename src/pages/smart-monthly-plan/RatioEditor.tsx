import { useState } from 'react';
import { Icon } from '../../config/icons';
import { btnMini, inputStyle, panel, sectionTitle } from './ui';
import type { RatioBucket } from './types';

let nextTempId = 1;

// ألوان هادئة رسمية للفئات — تُستعمل في شريط النسب وفي نقطة كل صف
const BUCKET_COLORS = ['#1a56db', '#0d9f6e', '#5a6a8a', '#7c93c3', '#0e7490', '#9333ea'];

/** محرّر نسب الفئات — شريط نسب بصري + حصّة كل فئة بالأرقام لا بالنسبة فقط. */
export default function RatioEditor({
  buckets, onChange, targetDoctorCount, onTargetChange,
}: {
  buckets: RatioBucket[];
  onChange: (buckets: RatioBucket[]) => void;
  targetDoctorCount: number;
  onTargetChange: (n: number) => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  const total = buckets.reduce((s, b) => s + (Number(b.percent) || 0), 0);
  const balanced = Math.round(total) === 100;

  const update = (idx: number, patch: Partial<RatioBucket>) => {
    onChange(buckets.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };
  const remove = (idx: number) => onChange(buckets.filter((_, i) => i !== idx));
  const add = () => {
    const label = newLabel.trim() || 'فئة جديدة';
    const key = `custom_${nextTempId++}`;
    onChange([...buckets, { key, label, percent: 0, sourceTag: key }]);
    setNewLabel('');
  };
  /** توزيع المتبقّي بالتساوي حتى يصبح المجموع 100% — اختصار للحالة الشائعة. */
  const balance = () => {
    if (!buckets.length) return;
    const even = Math.floor(100 / buckets.length);
    const rest = 100 - even * buckets.length;
    onChange(buckets.map((b, i) => ({ ...b, percent: even + (i === 0 ? rest : 0) })));
  };

  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={sectionTitle}>
          <Icon name="category" size={15} style={{ color: 'var(--c-accent)' }} />
          نسب الفئات في البلان
        </h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--c-text-secondary)', fontWeight: 600 }}>
          عدد الأطباء المستهدَف
          <input
            type="number" min={1} value={targetDoctorCount}
            onChange={e => onTargetChange(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ ...inputStyle, width: 74, padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}
          />
        </label>
      </div>

      {/* شريط النسب */}
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--c-border-light)', marginBottom: 12 }}>
        {buckets.map((b, i) => (
          <div
            key={b.key}
            title={`${b.label} — ${b.percent}%`}
            style={{ width: `${Math.max(0, Math.min(100, b.percent))}%`, background: BUCKET_COLORS[i % BUCKET_COLORS.length], transition: 'width 0.2s' }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {buckets.map((b, idx) => {
          const quota = Math.round((Number(b.percent) || 0) / 100 * targetDoctorCount);
          return (
            <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: BUCKET_COLORS[idx % BUCKET_COLORS.length] }} />
              <input
                value={b.label}
                onChange={e => update(idx, { label: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 110, padding: '6px 9px', fontSize: 12.5 }}
              />
              <input
                type="number" min={0} max={100} value={b.percent}
                onChange={e => update(idx, { percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                style={{ ...inputStyle, width: 62, padding: '6px 8px', fontSize: 12.5, textAlign: 'center' }}
              />
              <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>%</span>
              <span style={{ fontSize: 11.5, color: 'var(--c-text-secondary)', minWidth: 58, fontWeight: 600 }}>≈ {quota} طبيب</span>
              <button
                onClick={() => remove(idx)}
                title="حذف الفئة"
                style={{ border: 'none', background: 'transparent', color: 'var(--c-text-muted)', cursor: 'pointer', display: 'flex', padding: 3 }}
              ><Icon name="close" size={14} /></button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="اسم فئة جديدة…"
          style={{ ...inputStyle, flex: 1, minWidth: 140, padding: '6px 9px', fontSize: 12.5 }}
        />
        <button onClick={add} style={{ ...btnMini, padding: '7px 12px', fontSize: 12 }}>
          <Icon name="add" size={12} /> إضافة فئة
        </button>
        {!balanced && (
          <button onClick={balance} style={{ ...btnMini, padding: '7px 12px', fontSize: 12 }}>
            توزيع متساوٍ
          </button>
        )}
        <span style={{
          marginInlineStart: 'auto', fontSize: 12, fontWeight: 700,
          color: balanced ? 'var(--c-success)' : 'var(--c-danger)',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <Icon name={balanced ? 'checkCircle' : 'warning'} size={13} />
          المجموع {total}%{balanced ? '' : ' — يجب أن يساوي 100%'}
        </span>
      </div>
    </div>
  );
}
