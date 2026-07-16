import { useEffect, useState } from 'react';

// شبكة أزرار أرقام ثابتة (0, step, 2×step, ...) لاختيار رقم بدل الكتابة اليدوية،
// مع حقل إدخال يدوي للقيم الأكبر من الشبكة (مهم لحقل الكمية اللي حده الأقصى كبير).
// تُستخدم لحقول الكمية ونسب البونص في صفحة «الحساب».
interface NumberWheelPickerProps {
  title: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  gridMax?: number; // أعلى رقم يظهر كزر في الشبكة (باقي القيم عبر الإدخال اليدوي)
  suffix?: string;
  onChange: (v: number) => void;
  onClose: () => void;
}

export default function NumberWheelPicker({
  title, value, min = 0, max = 100000, step = 5, gridMax, suffix = '', onChange, onClose,
}: NumberWheelPickerProps) {
  const [val, setVal] = useState(value);
  const [manualInput, setManualInput] = useState('');

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (v: number) => { const c = clamp(v); setVal(c); onChange(c); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const gridTop = Math.min(max, gridMax ?? Math.min(max, 100));
  const gridValues: number[] = [];
  for (let v = min; v <= gridTop; v += step) gridValues.push(v);

  const applyManual = () => {
    if (manualInput === '') return;
    const n = Number(manualInput);
    if (!Number.isNaN(n)) commit(n);
    setManualInput('');
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 22, padding: '20px 20px 18px', width: 300, boxShadow: '0 24px 60px rgba(0,0,0,0.28)', direction: 'rtl', textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#1e40af', marginBottom: 14 }}>{val}{suffix ? ` ${suffix}` : ''}</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, maxHeight: 220, overflowY: 'auto', padding: 2 }}>
          {gridValues.map(v => {
            const selected = v === val;
            return (
              <button
                key={v}
                onClick={() => { commit(v); onClose(); }}
                style={{
                  padding: '8px 0', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  border: selected ? '1px solid #1e40af' : '1px solid #e2e8f0',
                  background: selected ? '#1e40af' : '#f8fafc',
                  color: selected ? '#fff' : '#334155',
                }}
              >
                {v}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          <input
            type="number"
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyManual(); } }}
            placeholder={`رقم آخر (${min}-${max})`}
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, textAlign: 'center' }}
          />
          <button onClick={applyManual} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#334155', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            تحديد
          </button>
        </div>

        <button onClick={onClose} style={{ marginTop: 14, width: '100%', padding: '9px 0', borderRadius: 10, border: 'none', background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          ✓ تم
        </button>
      </div>
    </div>
  );
}
