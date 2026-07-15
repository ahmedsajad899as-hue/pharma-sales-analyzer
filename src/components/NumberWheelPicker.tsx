import { useEffect, useRef, useState } from 'react';

// عجلة دوّارة (دائرية) لاختيار رقم بدل الكتابة اليدوية — الأرقام مثبّتة حول
// محيط العجلة وتدويرها (سحب دائري) يقرّب الرقم المطلوب من المؤشر العلوي.
// تُستخدم لحقول الكمية ونسب البونص في صفحة «الحساب».
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

const TICKS = 12;                 // عدد الأرقام المثبّتة حول محيط العجلة
const DEG_PER_TICK = 360 / TICKS; // 30° بين كل رقم والذي يليه
const RADIUS = 92;
const DIAL_SIZE = RADIUS * 2 + 44;

export default function NumberWheelPicker({
  title, value, min = 0, max = 100000, step = 5, bigStep = 25, suffix = '', onChange, onClose,
}: NumberWheelPickerProps) {
  const [val, setVal] = useState(value);
  const dialRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ cx: number; cy: number; startAngle: number; startVal: number; dragging: boolean } | null>(null);

  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const commit = (v: number) => { const c = clamp(v); setVal(c); onChange(c); };

  const angleOf = (x: number, y: number, cx: number, cy: number) => Math.atan2(y - cy, x - cx) * 180 / Math.PI;

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = dialRef.current!.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { cx, cy, startAngle: angleOf(e.clientX, e.clientY, cx, cy), startVal: val, dragging: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const curAngle = angleOf(e.clientX, e.clientY, d.cx, d.cy);
    let delta = curAngle - d.startAngle;
    while (delta > 180)  delta -= 360;
    while (delta < -180) delta += 360;
    if (Math.abs(delta) > 3) d.dragging = true;
    const steps = Math.round(delta / DEG_PER_TICK);
    const next = clamp(d.startVal + steps * step);
    setVal(v => (v !== next ? next : v));
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
      if (e.key === 'ArrowUp'   || e.key === 'ArrowRight') commit(val + step);
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')  commit(val - step);
      if (e.key === 'Enter' || e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  // 12 موضعاً ثابتاً حول الدائرة؛ الموضع العلوي (k=0) هو المؤشَّر عليه دوماً،
  // والباقي يعرض القيم الأقرب صعوداً/نزولاً بالدوران حوله.
  const ticks = Array.from({ length: TICKS }, (_, k) => ({
    k, offset: k <= TICKS / 2 ? k : k - TICKS, angleDeg: k * DEG_PER_TICK,
  }));

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 22, padding: '20px 20px 18px', width: 270, boxShadow: '0 24px 60px rgba(0,0,0,0.28)', direction: 'rtl', textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#1e40af', marginBottom: 12 }}>{val}{suffix ? ` ${suffix}` : ''}</div>

        <div
          ref={dialRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheelEvt}
          style={{
            position: 'relative', width: DIAL_SIZE, height: DIAL_SIZE, margin: '0 auto',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 50% 38%, #f0f7ff, #dbeafe 65%, #bfdbfe 100%)',
            boxShadow: 'inset 0 3px 12px rgba(30,64,175,.18), 0 8px 20px rgba(30,64,175,.14)',
            cursor: 'grab', touchAction: 'none', userSelect: 'none',
          }}
        >
          {/* مؤشر ثابت أعلى العجلة */}
          <div style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '10px solid #1e40af', zIndex: 2 }} />
          {/* مركز العجلة */}
          <div style={{ position: 'absolute', top: '50%', left: '50%', width: 14, height: 14, borderRadius: '50%', background: '#1e40af', transform: 'translate(-50%,-50%)', boxShadow: '0 0 0 4px #fff' }} />

          {ticks.map(t => {
            const raw = val + t.offset * step;
            const inRange = raw >= min && raw <= max;
            const rad = (t.angleDeg - 90) * Math.PI / 180; // -90 لتبدأ من الأعلى
            const cx = DIAL_SIZE / 2 + RADIUS * Math.cos(rad);
            const cy = DIAL_SIZE / 2 + RADIUS * Math.sin(rad);
            const isTop = t.k === 0;
            if (!inRange) return null;
            return (
              <div
                key={t.k}
                onClick={e => { e.stopPropagation(); commit(raw); onClose(); }}
                style={{
                  position: 'absolute', left: cx, top: cy, transform: 'translate(-50%,-50%)',
                  fontSize: isTop ? 16 : 12.5, fontWeight: isTop ? 800 : 600,
                  color: isTop ? '#1e40af' : '#64748b',
                  background: isTop ? '#fff' : 'transparent',
                  borderRadius: isTop ? 8 : 6,
                  padding: isTop ? '2px 7px' : '3px 6px',
                  boxShadow: isTop ? '0 2px 8px rgba(30,64,175,.2)' : 'none',
                  cursor: 'pointer', transition: 'color .1s ease, background .1s ease',
                }}
                onMouseEnter={e => { if (!isTop) e.currentTarget.style.background = 'rgba(30,64,175,.12)'; }}
                onMouseLeave={e => { if (!isTop) e.currentTarget.style.background = 'transparent'; }}
              >
                {raw}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 16 }}>
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

const smallBtn: React.CSSProperties = {
  flex: 1, padding: '7px 0', borderRadius: 8, border: '1px solid #e2e8f0',
  background: '#f8fafc', color: '#334155', fontWeight: 700, fontSize: 12, cursor: 'pointer',
};
