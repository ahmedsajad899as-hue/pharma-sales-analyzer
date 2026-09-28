import { useState } from 'react';
import type { RatioBucket } from './types';

let nextTempId = 1;

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
    const next = buckets.map((b, i) => (i === idx ? { ...b, ...patch } : b));
    onChange(next);
  };
  const remove = (idx: number) => onChange(buckets.filter((_, i) => i !== idx));
  const add = () => {
    const label = newLabel.trim() || 'فئة جديدة';
    const key = `custom_${nextTempId++}`;
    onChange([...buckets, { key, label, percent: 0, sourceTag: key }]);
    setNewLabel('');
  };

  return (
    <div style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ fontSize: 14, color: 'var(--c-text-primary)' }}>نسب الفئات في البلان</strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-secondary)' }}>
          إجمالي عدد الأطباء المستهدَف
          <input
            type="number" min={1} value={targetDoctorCount}
            onChange={e => onTargetChange(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: 70, padding: '4px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)' }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {buckets.map((b, idx) => (
          <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={b.label}
              onChange={e => update(idx, { label: e.target.value })}
              style={{ flex: 1, minWidth: 120, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 13 }}
            />
            <input
              type="number" min={0} max={100} value={b.percent}
              onChange={e => update(idx, { percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              style={{ width: 64, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 13, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>%</span>
            <button
              onClick={() => remove(idx)}
              title="حذف الفئة"
              style={{ border: 'none', background: 'transparent', color: 'var(--c-danger)', cursor: 'pointer', fontSize: 14 }}
            >✕</button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="اسم فئة جديدة..."
          style={{ flex: 1, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--c-border)', fontSize: 13 }}
        />
        <button
          onClick={add}
          style={{ padding: '6px 14px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--c-accent-light)', color: 'var(--c-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
        >
          + إضافة فئة
        </button>
      </div>

      <div style={{
        marginTop: 12, fontSize: 13, fontWeight: 600,
        color: balanced ? 'var(--c-success)' : 'var(--c-danger)',
      }}>
        المجموع: {total}% {balanced ? '✓' : '— يجب أن يساوي المجموع 100%'}
      </div>
    </div>
  );
}
