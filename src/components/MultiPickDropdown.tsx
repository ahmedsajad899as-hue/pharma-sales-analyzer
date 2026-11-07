import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * قائمة منسدلة باختيار متعدد (بحث + مربعات اختيار). value فارغة = «الكل».
 */
export interface MultiPickOption { value: string; label: string }

export default function MultiPickDropdown({ label, options, value, onChange, allLabel = 'الكل', minWidth = 220, ltrOptions = false }: {
  label: string;
  options: MultiPickOption[];
  value: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
  minWidth?: number;
  ltrOptions?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const selected = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter(o => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);

  const toggle = (v: string) => onChange(selected.has(v) ? value.filter(x => x !== v) : [...value, v]);
  const summary = value.length === 0
    ? allLabel
    : value.length === 1
      ? (options.find(o => o.value === value[0])?.label ?? '1')
      : `${value.length} محدد`;

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{label}</span>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ minWidth, maxWidth: 280, padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12.5, fontWeight: 600, color: '#111827', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span style={{ fontSize: 10, color: '#64748b' }}>▼</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 50, width: Math.max(minWidth + 60, 260), background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,.15)', padding: 8 }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="بحث..."
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12.5, marginBottom: 6 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11.5 }}>
            <button type="button" onClick={() => onChange(Array.from(new Set([...value, ...shown.map(o => o.value)])))}
              style={{ border: 'none', background: 'none', color: '#1d4ed8', cursor: 'pointer', fontWeight: 700, padding: 0 }}>تحديد الظاهر</button>
            <button type="button" onClick={() => onChange([])}
              style={{ border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', fontWeight: 700, padding: 0 }}>{allLabel} (مسح)</button>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {shown.length === 0 && <div style={{ padding: 10, fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>لا نتائج</div>}
            {shown.map(o => (
              <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 4, cursor: 'pointer', fontSize: 12.5, background: selected.has(o.value) ? '#f1f5f9' : undefined }}>
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
                <span style={{ direction: ltrOptions ? 'ltr' : undefined, textAlign: ltrOptions ? 'left' : undefined, flex: 1 }}>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
