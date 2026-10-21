// ════════════════════════════════════════════════════════════════════════════
// ComboCell — خانة جدول بنصّ متمدّد وقائمة اقتراحات ذكية. مشتركة بين شبكة مراجعة
// طلبيات البوت (ManualSalesModal) وتعديل ملف الكوديشن (ConditionFileModal).
// ════════════════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect, useLayoutEffect } from 'react';

export const gCell: React.CSSProperties = { width: '100%', padding: '6px 7px', border: '1px solid transparent', borderRadius: 7, fontSize: 12.5, lineHeight: 1.45, direction: 'rtl', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: 'transparent', color: '#1e293b', display: 'block', minHeight: 32 };

/**
 * خانة نصّ تتمدّد عمودياً مع محتواها — الاسم الطويل (مادة، صيدلية، مندوب) يُعرض
 * كاملاً بأسطر متعدّدة بدل أن يُقصّ أو يحتاج الجدول تمريراً أفقياً. Enter لا
 * يُدخل سطراً جديداً: القيم أسماء من سطر واحد، والالتفاف بصري فقط.
 */
export function AutoText({ value, onChange, style, inputRef, ...rest }: {
  value: string; onChange: (v: string) => void; style?: React.CSSProperties;
  inputRef?: React.Ref<HTMLTextAreaElement>;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'style'>) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => { const el = local.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  useLayoutEffect(fit, [value]);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, []);
  return (
    <textarea
      {...rest}
      ref={el => {
        local.current = el;
        if (typeof inputRef === 'function') inputRef(el);
        else if (inputRef) (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }}
      rows={1}
      value={value}
      onChange={e => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={e => { if (e.key === 'Enter' && !e.defaultPrevented) e.preventDefault(); rest.onKeyDown?.(e); }}
      style={{ ...gCell, resize: 'none', overflow: 'hidden', ...style }}
    />
  );
}

export type ComboOpt = { value: string; hint?: string; star?: boolean };
export const normQ = (s: string) => String(s ?? '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, '');

/**
 * قائمة اقتراحات ذكية فوق خانة نصّ — بديل datalist الذي لا يلتفّ ولا يميّز
 * المرشّحين. المرشّحون (⭐) أولاً، ثم التصفية بالكتابة، والأسهم + Enter للاختيار.
 * القائمة position:fixed كي لا يقصّها حاوي الجدول.
 */
export function ComboCell({ value, onChange, onPick, onCommit, options, placeholder, title, style }: {
  value: string; onChange: (v: string) => void; onPick?: (v: string) => void;
  /** يُستدعى عند اختيار اقتراح أو الخروج من الخانة **بعد تغيير قيمتها** — لا عند كل حرف. */
  onCommit?: (v: string) => void;
  options: ComboOpt[]; placeholder?: string; title?: string; style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const focusValRef = useRef<string | null>(null); // القيمة لحظة الدخول للخانة
  const [hi, setHi] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const q = normQ(value);
  const exact = options.some(o => normQ(o.value) === q);
  const shown = (!q || exact ? options : options.filter(o => normQ(o.value).includes(q) || normQ(o.hint || '').includes(q))).slice(0, 40);

  const place = () => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 3, width: Math.max(r.width, 220) });
  };
  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = (e: Event) => { if (listRef.current && listRef.current.contains(e.target as Node)) return; setOpen(false); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { setHi(0); }, [value, open]);

  const pick = (v: string) => {
    onChange(v); onPick?.(v); setOpen(false);
    if (onCommit && v.trim() !== String(focusValRef.current ?? '').trim()) { focusValRef.current = v; onCommit(v); }
  };

  return (
    <>
      <AutoText
        inputRef={ref}
        value={value}
        onChange={v => { onChange(v); setOpen(true); }}
        onFocus={() => { setOpen(true); focusValRef.current = value; }}
        onBlur={() => {
          setOpen(false);
          if (onCommit && focusValRef.current != null && value.trim() !== focusValRef.current.trim()) onCommit(value);
          focusValRef.current = null;
        }}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); e.preventDefault(); return; }
          if (!open || !shown.length) return;
          if (e.key === 'ArrowDown') { setHi(h => Math.min(shown.length - 1, h + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setHi(h => Math.max(0, h - 1)); e.preventDefault(); }
          else if (e.key === 'Enter') { pick(shown[hi]?.value ?? value); e.preventDefault(); }
          else if (e.key === 'Escape') { setOpen(false); }
        }}
        placeholder={placeholder}
        title={title}
        style={style}
      />
      {open && rect && shown.length > 0 && (
        <div ref={listRef} dir="rtl"
          style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, maxHeight: 260, overflowY: 'auto', zIndex: 10060,
            background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,0.12)', padding: 4 }}>
          {shown.map((o, k) => (
            <div key={o.value + k}
              onMouseDown={e => { e.preventDefault(); pick(o.value); }}
              onMouseEnter={() => setHi(k)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, lineHeight: 1.4,
                background: k === hi ? '#f1f5f9' : 'transparent', color: '#0f172a', fontWeight: o.star ? 700 : 500 }}>
              {o.star && <span title="مرشّح من المنطقة والشركة" style={{ color: '#64748b' }}>★</span>}
              <span style={{ flex: 1 }}>{o.value}</span>
              {o.hint && <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

