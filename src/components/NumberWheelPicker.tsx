import { useEffect, useRef, useState } from 'react';

// عجلة اختيار رقم مودرن (سحب/سكرول) بدل الكتابة اليدوية — تُستخدم لحقول
// الكمية ونسب البونص في صفحة «الحساب».
interface NumberWheelPickerProps {
  title: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  bigStep?: number;
  suffix?: string;
  onChange: (v: number) => void;
  onClose: () => void;
}

const PX_PER_STEP = 26;

export default function NumberWheelPicker({
  title, value, min = 0, max = 100000, step = 1, bigStep = 10, suffix = '', onChange, onClose,
}: NumberWheelPickerProps) {
  const [val, setVal] = useState(value);
  const dragRef = useRef<{ startY: number; startVal: number; dragging: boolean } | null>(null);

  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const commit = (v: number) => { const c = clamp(v); setVal(c); onChange(c); };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startVal: val, dragging: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY; // سحب لأعلى = زيادة
    if (Math.abs(dy) > 3) dragRef.current.dragging = true;
    const steps = Math.round(dy / PX_PER_STEP);
    const next = clamp(dragRef.current.startVal + steps * step);
    if (next !== val) setVal(next);
  };
  const onPointerUp = () => {
    if (dragRef.current?.dragging) onChange(val);
    dragRef.current = null;
  };

  const onWheelEvt = (e: React.WheelEvent) => {
    e.preventDefault();
    commit(val + (e.deltaY < 0 ? step : -step));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp')   commit(val + step);
      if (e.key === 'ArrowDown') commit(val - step);
      if (e.key === 'Enter' || e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  const rows = [-2, -1, 0, 1, 2];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, padding: '20px 26px 18px', width: 240, boxShadow: '0 24px 60px rgba(0,0,0,0.28)', direction: 'rtl', textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 10 }}>{title}</div>

        <button onClick={() => commit(val + step)} style={wheelBtn}>▲</button>

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheelEvt}
          style={{ cursor: 'ns-resize', userSelect: 'none', touchAction: 'none', padding: '2px 0', position: 'relative' }}
        >
          {rows.map(offset => {
            const v = val + offset * step;
            const isCenter = offset === 0;
            const dim = Math.abs(offset);
            const inRange = v >= min && v <= max;
            return (
              <div key={offset} style={{
                fontSize: isCenter ? 32 : 17 - dim * 2,
                fontWeight: isCenter ? 800 : 500,
                color: isCenter ? '#1e40af' : '#cbd5e1',
                opacity: !inRange ? 0 : (isCenter ? 1 : 1 - dim * 0.3),
                lineHeight: isCenter ? '38px' : '24px',
                transition: 'color .12s ease, font-size .12s ease',
              }}>
                {inRange ? `${v}${isCenter && suffix ? ' ' + suffix : ''}` : '·'}
              </div>
            );
          })}
          <div style={{ position: 'absolute', top: '50%', right: -26, left: -26, transform: 'translateY(-19px)', height: 38, borderTop: '1.5px solid #dbeafe', borderBottom: '1.5px solid #dbeafe', background: 'rgba(59,130,246,0.06)', pointerEvents: 'none' }} />
        </div>

        <button onClick={() => commit(val - step)} style={wheelBtn}>▼</button>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 14 }}>
          <button onClick={() => commit(val - bigStep)} style={smallBtn}>-{bigStep}</button>
          <button onClick={() => commit(min)} style={smallBtn}>↺ {min}</button>
          <button onClick={() => commit(val + bigStep)} style={smallBtn}>+{bigStep}</button>
        </div>

        <button onClick={onClose} style={{ marginTop: 14, width: '100%', padding: '9px 0', borderRadius: 10, border: 'none', background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          ✓ تم
        </button>
      </div>
    </div>
  );
}

const wheelBtn: React.CSSProperties = {
  display: 'block', margin: '0 auto', width: 36, height: 24, border: 'none',
  background: '#f1f5f9', borderRadius: 8, color: '#64748b', fontSize: 12, cursor: 'pointer',
};
const smallBtn: React.CSSProperties = {
  flex: 1, padding: '7px 0', borderRadius: 8, border: '1px solid #e2e8f0',
  background: '#f8fafc', color: '#334155', fontWeight: 700, fontSize: 12, cursor: 'pointer',
};
