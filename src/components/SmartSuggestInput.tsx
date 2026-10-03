import { useEffect, useRef, useState } from 'react';

/**
 * حقل نصي حرّ + اقتراحات ذكية: تظهر القائمة فور التركيز على الخانة (حتى قبل
 * الكتابة)، وتُصفَّى أثناء الكتابة بمطابقة "احتواء" (الأحرف المكتوبة موجودة في
 * أي مكان من الاسم، لا بداية الاسم فقط — مثلاً "قو" يُظهر "الناقوس"). يمكن
 * الاختيار بالماوس أو Enter (على الاقتراح المظلَّل)، أو تجاهل القائمة والخروج
 * من الخانة بقيمة مختلفة تماماً (Tab/النقر خارجها) — القيمة المكتوبة تبقى كما
 * هي دائماً، القائمة اقتراح لا قيد (بعكس القوائم المنسدلة الصارمة في الإكسل).
 */

function normalize(s: string): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '') // تشكيل
    .replace(/\s+/g, ' ');
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  style?: React.CSSProperties;
  maxSuggestions?: number;
}

export default function SmartSuggestInput({ value, onChange, options, placeholder, style, maxSuggestions = 20 }: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = normalize(value);
  const filtered = (q
    ? options.filter(o => normalize(o).includes(q))
    : options
  ).slice(0, maxSuggestions);

  useEffect(() => { setHighlight(-1); }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight(h => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && filtered[highlight] != null) {
        e.preventDefault();
        choose(filtered[highlight]);
      } else {
        setOpen(false); // تأكيد ما كُتب كما هو — لا إجبار على اختيار من القائمة
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} style={{ position: 'relative', width: '100%' }}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', ...style }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50,
          background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: 220, overflowY: 'auto', marginTop: 2,
        }}>
          {filtered.map((opt, i) => (
            <div
              key={opt + i}
              onMouseDown={e => { e.preventDefault(); choose(opt); }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '7px 10px', fontSize: 13, cursor: 'pointer', direction: 'rtl', textAlign: 'right',
                background: i === highlight ? '#eef2ff' : '#fff', color: '#1e293b',
                borderBottom: i < filtered.length - 1 ? '1px solid #f1f5f9' : 'none',
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
