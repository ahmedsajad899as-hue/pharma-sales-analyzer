import type { CSSProperties, ReactNode } from 'react';

/**
 * لغة بصرية موحَّدة لصفحة «البلان الشهري الذكي» — ألوان هادئة، حدود رفيعة،
 * وإيقاع مسافات واحد في كل الأقسام (نفس روح صفحة تحليل الكولات).
 */

export const card: CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 14,
  boxShadow: 'var(--shadow-sm)',
};

export const panel: CSSProperties = { ...card, padding: 16 };

export const sectionTitle: CSSProperties = {
  fontSize: 13.5, fontWeight: 700, color: 'var(--c-text-primary)',
  display: 'flex', alignItems: 'center', gap: 7, margin: 0,
};

export const muted: CSSProperties = { fontSize: 12, color: 'var(--c-text-muted)', fontWeight: 500 };

export const inputStyle: CSSProperties = {
  padding: '8px 11px', borderRadius: 9, border: '1px solid var(--c-border)',
  fontSize: 13, color: 'var(--c-text-primary)', background: 'var(--c-surface)',
  outline: 'none', fontFamily: 'inherit',
};

export const btnPrimary: CSSProperties = {
  padding: '9px 16px', borderRadius: 9, border: '1px solid var(--c-accent)', cursor: 'pointer',
  background: 'var(--c-accent)', color: '#fff', fontWeight: 600, fontSize: 13,
  display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
};

export const btnGhost: CSSProperties = {
  padding: '9px 16px', borderRadius: 9, border: '1px solid var(--c-border)', cursor: 'pointer',
  background: 'var(--c-surface)', color: 'var(--c-text-secondary)', fontWeight: 600, fontSize: 13,
  display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
};

export const btnMini: CSSProperties = {
  padding: '5px 10px', borderRadius: 7, border: '1px solid var(--c-border)',
  background: 'var(--c-surface)', color: 'var(--c-text-secondary)',
  fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};

type Tone = 'neutral' | 'accent' | 'success' | 'danger';

const TONES: Record<Tone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: 'var(--c-border-light)', fg: 'var(--c-text-secondary)', border: 'var(--c-border)' },
  accent:  { bg: 'var(--c-accent-light)', fg: 'var(--c-accent)',         border: 'var(--c-purple-border)' },
  success: { bg: 'var(--c-success-bg)',   fg: 'var(--c-success)',        border: 'var(--c-success-border)' },
  danger:  { bg: 'var(--c-danger-bg)',    fg: 'var(--c-danger)',         border: 'var(--c-danger-border)' },
};

/** شارة صغيرة هادئة — تُستعمل للحالات والعدّادات داخل الصفوف. */
export function Tag({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const t = TONES[tone];
  return (
    <span title={title} style={{
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4, lineHeight: 1.6,
    }}>{children}</span>
  );
}

/** بطاقة رقم مختصرة في شريط الملخّص أعلى الأقسام. */
export function Stat({ label, value, tone = 'neutral' }: { label: string; value: ReactNode; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <div style={{
      flex: '1 1 110px', minWidth: 96, background: tone === 'neutral' ? 'var(--c-bg)' : t.bg,
      border: `1px solid ${tone === 'neutral' ? 'var(--c-border)' : t.border}`,
      borderRadius: 11, padding: '9px 12px',
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--c-text-muted)', fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: tone === 'neutral' ? 'var(--c-text-primary)' : t.fg, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

export interface Segment {
  key: string;
  label: string;
  count?: number;
  tone?: Tone;
  title?: string;
}

/**
 * مجموعة أزرار فلترة واحدة (segmented control) بدل شرائح متفرّقة بأحجام مختلفة —
 * الخيار النشط يرتفع بخلفية بيضاء داخل إطار رمادي هادئ.
 */
export function SegmentedFilter({
  segments, value, onChange,
}: {
  segments: Segment[]; value: string; onChange: (key: string) => void;
}) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 3, background: 'var(--c-bg)',
      border: '1px solid var(--c-border)', borderRadius: 11, flexWrap: 'wrap',
    }}>
      {segments.map(s => {
        const active = s.key === value;
        const tone = s.tone ?? 'accent';
        const t = TONES[tone];
        return (
          <button
            key={s.key} onClick={() => onChange(s.key)} title={s.title}
            style={{
              padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
              background: active ? 'var(--c-surface)' : 'transparent',
              color: active ? t.fg : 'var(--c-text-secondary)',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {s.label}
            {s.count !== undefined && (
              <span style={{
                fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 6px', lineHeight: 1.6,
                background: active ? t.bg : 'var(--c-border-light)',
                color: active ? t.fg : 'var(--c-text-muted)',
              }}>{s.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
