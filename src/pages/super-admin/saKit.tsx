// عناصر واجهة مدمجة مشتركة لصفحات لوحة السوبر أدمن (رقم الكروبات، الروابط، دوفايد،
// استهلاك الذكاء…) — شكل واحد: شريط علوي، أقسام بعنوان وعدّاد، بطاقات مختصرة،
// أزرار خفيفة، مفاتيح تشغيل، ومقاطع اختيار.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { UI } from './OfficesPage';
import { AI_MODES, type AiMode } from './AiModeButtons';

export const ghost = (color: string = UI.text): CSSProperties => ({
  padding: '4px 10px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  border: `1px solid ${UI.line}`, background: '#fff', color, whiteSpace: 'nowrap', lineHeight: 1.4,
});

export const solid = (bg: string = '#1e293b'): CSSProperties => ({
  padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  border: `1px solid ${bg}`, background: bg, color: '#fff', whiteSpace: 'nowrap', lineHeight: 1.4,
});

export const tag = (color: string, bg: string): CSSProperties => ({
  display: 'inline-block', fontSize: 11, fontWeight: 600, color, background: bg, borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap',
});
export const TAG = {
  ok:    tag('#15803d', '#f0fdf4'),
  bad:   tag('#b91c1c', '#fef2f2'),
  warn:  tag('#b45309', '#fffbeb'),
  info:  tag('#1d4ed8', '#eff6ff'),
  mute:  tag(UI.muted, UI.bg),
  violet: tag('#6d28d9', '#f5f3ff'),
};

export const inputSm: CSSProperties = {
  padding: '5px 10px', border: `1px solid ${UI.line}`, borderRadius: 7, fontSize: 12.5, fontFamily: 'inherit',
  color: UI.ink, background: '#fff', outline: 'none', boxSizing: 'border-box', maxWidth: '100%',
};

/** مفتاح تشغيل/إطفاء. */
export function Toggle({ on, label, title, onToggle, disabled }: { on: boolean; label: ReactNode; title?: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onToggle} title={title} aria-pressed={on} disabled={disabled}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: on ? UI.ink : UI.faint, opacity: disabled ? 0.6 : 1 }}>
      <span style={{ position: 'relative', width: 26, height: 14, borderRadius: 7, background: on ? '#16a34a' : '#cbd5e1', flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, insetInlineStart: on ? 14 : 2, width: 10, height: 10, borderRadius: '50%', background: '#fff', transition: 'inset-inline-start .15s' }} />
      </span>
      {label}
    </button>
  );
}

/** مقطع اختيار واحد من عدة. */
export function Seg<T extends string | number>({ value, options, onChange, disabled, danger }: {
  value: T; options: readonly (readonly [T, string, string?])[]; onChange: (v: T) => void; disabled?: boolean; danger?: T;
}) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${UI.line}`, borderRadius: 7, overflow: 'hidden', opacity: disabled ? 0.6 : 1, flexShrink: 0 }}>
      {options.map(([v, label, title], i) => {
        const on = v === value;
        return (
          <button key={String(v)} type="button" title={title} disabled={disabled}
            onClick={() => { if (!on) onChange(v); }}
            style={{
              padding: '3px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', fontFamily: 'inherit', whiteSpace: 'nowrap',
              borderInlineStart: i ? `1px solid ${UI.line}` : 'none', cursor: on ? 'default' : 'pointer',
              background: on ? (v === danger ? '#dc2626' : '#1e293b') : '#fff', color: on ? '#fff' : UI.muted,
            }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

const AI_OPTS = [
  ['both', 'الاثنين', 'المحلل أولاً، وما لا يحسمه يذهب للذكاء'],
  ['parser', 'المحلل', 'بلا ذكاء: الطلبيات الواضحة فقط'],
  ['ai', 'الذكاء', 'Gemini لكل رسالة'],
  ['off', 'إطفاء', 'لا تحليل لأي رسالة'],
] as const;

/** وضع تحليل الطلبيات لكروب (تلكرام/واتساب). */
export function AiSeg({ value, onChange }: { value?: string | null; onChange: (v: AiMode) => Promise<unknown> }) {
  const cur: AiMode = (AI_MODES as readonly string[]).includes(value || '') ? (value as AiMode) : 'both';
  const [busy, setBusy] = useState(false);
  return (
    <Seg value={cur} options={AI_OPTS} danger="off" disabled={busy}
      onChange={async v => { setBusy(true); try { await onChange(v); } finally { setBusy(false); } }} />
  );
}

/** شريط علوي: حالة + أدوات على الطرف. */
export function Bar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, padding: '8px 12px', marginBottom: 12 }}>
      {children}
      {end && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginInlineStart: 'auto' }}>{end}</div>}
    </div>
  );
}

/** قسم بعنوان وعدّاد اختياري وأدوات على الطرف. */
export function Section({ title, count, accent = UI.line, end, children, flush }: {
  title: ReactNode; count?: number; accent?: string; end?: ReactNode; children: ReactNode; flush?: boolean;
}) {
  return (
    <section style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 12, overflow: 'hidden', minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderBottom: `1px solid ${UI.line}`, borderTop: `3px solid ${accent}` }}>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: UI.ink }}>{title}</span>
        {count != null && <span style={{ fontSize: 11.5, fontWeight: 700, color: UI.muted, background: UI.bg, borderRadius: 10, padding: '1px 8px' }}>{count}</span>}
        {end && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginInlineStart: 'auto' }}>{end}</div>}
      </header>
      {flush ? children : <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>}
    </section>
  );
}

export const Empty = ({ text }: { text: string }) => <div style={{ fontSize: 12, color: UI.faint, padding: '12px 4px', textAlign: 'center' }}>{text}</div>;

/** بطاقة مختصرة: العنوان + الإجراءات في السطر الأول، والتفاصيل تحته. */
export function Card({ title, meta, dim, actions, children }: { title: ReactNode; meta?: ReactNode; dim?: boolean; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ border: `1px solid ${UI.line}`, borderRadius: 10, padding: '9px 12px', background: dim ? UI.bg : '#fff', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: dim ? UI.muted : UI.ink }}>{title}</span>
          {meta && <span style={{ fontSize: 11, color: UI.faint, marginInlineStart: 6 }}>{meta}</span>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children && <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>}
    </div>
  );
}

/** رقم مختصر. */
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${UI.line}`, borderRadius: 10, padding: '8px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: UI.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tone || UI.ink, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: UI.faint }}>{sub}</div>}
    </div>
  );
}

export const statGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 12 };
export const twoCols: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 12, alignItems: 'start' };
export const cardGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 8 };

/** صف «مفتاح: قيمة». */
export const Kv = ({ k, children }: { k: string; children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '5px 0', borderBottom: `1px solid ${UI.bg}` }}>
    <span style={{ color: UI.muted, flex: '0 0 110px' }}>{k}</span>
    <span style={{ color: UI.ink, minWidth: 0 }}>{children}</span>
  </div>
);

export const th: CSSProperties = { textAlign: 'start', padding: '7px 10px', fontSize: 11.5, color: UI.muted, borderBottom: `1px solid ${UI.line}`, fontWeight: 700, background: UI.bg, whiteSpace: 'nowrap' };
export const td: CSSProperties = { padding: '7px 10px', fontSize: 12.5, color: UI.ink, borderBottom: '1px solid #f1f5f9', fontVariantNumeric: 'tabular-nums' };

/** شريط رسالة قصير (نجاح/تنبيه). */
export function Notice({ tone = 'ok', children }: { tone?: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const c = tone === 'ok' ? ['#166534', '#f0fdf4', '#bbf7d0'] : tone === 'warn' ? ['#92400e', '#fffbeb', '#fde68a'] : ['#991b1b', '#fef2f2', '#fecaca'];
  return <div style={{ color: c[0], background: c[1], border: `1px solid ${c[2]}`, borderRadius: 8, padding: '6px 12px', fontSize: 12.5, marginBottom: 10 }}>{children}</div>;
}
