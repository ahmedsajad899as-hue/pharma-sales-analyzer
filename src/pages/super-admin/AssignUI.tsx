// مكوّنات واجهة موحّدة لتبويبات التعيين في صفحة المستخدم (الشركات، اللاينات،
// الايتمات، نطاق الستوك، المدراء، الموظفون) — على نمط نافذة «مناطق عمل المندوب»:
// بطاقات مجموعات قابلة للطيّ بمربع ثلاثي الحالة + شبكة خانات مدمجة + عدّاد «المحدد».
// ⚠️ معرَّفة على مستوى الوحدة (لا داخل render الصفحة) كي لا يُعاد تركيبها مع كل
// ضغطة فيقفز التمرير أو تضيع حالة الطيّ.
import { useState, type ReactNode, type CSSProperties } from 'react';

export const ACCENT = '#4f46e5';
const ACCENT_SOFT = '#eef2ff';
const BORDER = '#e2e8f0';

// ── شريط التبويبات ───────────────────────────────────────────────────────────
export function TabPill({ active, icon, label, count, dirty, onClick }: {
  active: boolean; icon: string; label: string; count?: number; dirty?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
      fontSize: 13, fontWeight: 700, transition: 'all .15s',
      border: `1px solid ${active ? ACCENT : BORDER}`,
      background: active ? ACCENT : '#fff', color: active ? '#fff' : '#334155',
      boxShadow: active ? '0 4px 12px rgba(79,70,229,.25)' : '0 1px 2px rgba(15,23,42,.04)',
    }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      {label}
      {count != null && (
        <span style={{
          minWidth: 22, padding: '1px 7px', borderRadius: 20, fontSize: 11.5, fontWeight: 800, textAlign: 'center',
          background: active ? 'rgba(255,255,255,.22)' : count > 0 ? ACCENT_SOFT : '#f1f5f9',
          color: active ? '#fff' : count > 0 ? ACCENT : '#94a3b8',
        }}>{count}</span>
      )}
      {dirty && <span title="تغييرات غير محفوظة" style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b' }} />}
    </button>
  );
}

// ── رأس القسم ────────────────────────────────────────────────────────────────
export function SectionHead({ icon, title, hint }: { icon: string; title: string; hint?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: ACCENT_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 3, lineHeight: 1.7 }}>{hint}</div>}
      </div>
    </div>
  );
}

// ── ملاحظة ملوّنة ────────────────────────────────────────────────────────────
const NOTE_TONES = {
  info: { bg: '#f0f9ff', border: '#bae6fd', color: '#075985' },
  warn: { bg: '#fff7ed', border: '#fed7aa', color: '#9a3412' },
  ok:   { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534' },
};
export function Note({ tone = 'info', children, style }: { tone?: keyof typeof NOTE_TONES; children: ReactNode; style?: CSSProperties }) {
  const t = NOTE_TONES[tone];
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.8, color: t.color, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: '9px 13px', marginBottom: 12, ...style }}>
      {children}
    </div>
  );
}

// ── شريط: العدّاد + تحديد/إلغاء الكل + البحث ────────────────────────────────
export function PickerBar({ selected, total, onAll, onNone, noneLabel = 'إلغاء الكل', search, onSearch, placeholder = 'بحث...', extra }: {
  selected: number; total: number; onAll?: () => void; onNone?: () => void; noneLabel?: string;
  search?: string; onSearch?: (v: string) => void; placeholder?: string; extra?: ReactNode;
}) {
  const link: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, padding: '2px 4px' };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: onSearch ? 8 : 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: ACCENT, fontWeight: 800 }}>المحدد: {selected} من {total}</span>
        {extra}
        <span style={{ flex: 1 }} />
        {onAll && <button onClick={onAll} style={{ ...link, color: ACCENT }}>✓ تحديد الكل</button>}
        {onAll && onNone && <span style={{ color: '#cbd5e1' }}>|</span>}
        {onNone && <button onClick={onNone} style={{ ...link, color: '#64748b' }}>✕ {noneLabel}</button>}
      </div>
      {onSearch && (
        <input
          value={search ?? ''}
          onChange={e => onSearch(e.target.value)}
          placeholder={`🔍 ${placeholder}`}
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 13.5, direction: 'rtl', outline: 'none', background: '#fff' }}
        />
      )}
    </div>
  );
}

// ── مربع ثلاثي الحالة ────────────────────────────────────────────────────────
export function TriCheck({ sel, total, onChange, color = ACCENT, title, disabled }: {
  sel: number; total: number; onChange: (on: boolean) => void; color?: string; title?: string; disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      checked={total > 0 && sel === total}
      ref={el => { if (el) el.indeterminate = sel > 0 && sel < total; }}
      onChange={e => onChange(e.target.checked)}
      disabled={disabled || total === 0}
      title={title}
      style={{ width: 16, height: 16, accentColor: color, cursor: 'pointer', flexShrink: 0 }}
    />
  );
}

// ── بطاقة مجموعة قابلة للطيّ ─────────────────────────────────────────────────
export function GroupCard({ icon, title, sel, total, onToggleAll, forceOpen, defaultOpen = true, badge, children }: {
  icon?: string; title: ReactNode; sel: number; total: number; onToggleAll?: (on: boolean) => void;
  forceOpen?: boolean; defaultOpen?: boolean; badge?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <div style={{ border: `1px solid ${sel ? '#c7d2fe' : BORDER}`, borderRadius: 12, overflow: 'hidden', flexShrink: 0, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', background: sel ? ACCENT_SOFT : '#f8fafc' }}>
        {onToggleAll && <TriCheck sel={sel} total={total} onChange={onToggleAll} title="تحديد / إلغاء كل المجموعة" />}
        <button
          onClick={() => setOpen(o => !o)}
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13.5, fontWeight: 800, color: '#1e293b', textAlign: 'right' }}
        >
          {icon && <span>{icon}</span>}
          <span>{title}</span>
          {badge}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: sel ? ACCENT : '#94a3b8', fontWeight: 800 }}>
            {sel}/{total} {isOpen ? '▴' : '▾'}
          </span>
        </button>
      </div>
      {isOpen && <div style={{ borderTop: `1px solid ${BORDER}` }}>{children}</div>}
    </div>
  );
}

// ── شبكة الخانات + الخانة ────────────────────────────────────────────────────
export function ChipGrid({ children, min = 170, style }: { children: ReactNode; min?: number; style?: CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 5, padding: 8, ...style }}>
      {children}
    </div>
  );
}

export function Chip({ checked, onChange, label, sub, trailing, highlight, disabled, title }: {
  checked: boolean; onChange: (on: boolean) => void; label: ReactNode; sub?: ReactNode;
  trailing?: ReactNode; highlight?: string; disabled?: boolean; title?: string;
}) {
  const bg = highlight ?? (checked ? ACCENT_SOFT : 'transparent');
  return (
    <div title={title} style={{
      display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8, background: bg,
      border: `1px solid ${checked ? '#c7d2fe' : 'transparent'}`, transition: 'background .12s',
    }}>
      <label style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.7 : 1 }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          style={{ width: 15, height: 15, accentColor: ACCENT, flexShrink: 0 }}
        />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13.5, color: '#1e293b', fontWeight: checked ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          {sub && <span style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
        </span>
      </label>
      {trailing && <div style={{ paddingInlineEnd: 6, flexShrink: 0 }}>{trailing}</div>}
    </div>
  );
}

// ── حاوية القائمة القابلة للتمرير ───────────────────────────────────────────
export function ScrollList({ children, maxHeight = 440 }: { children: ReactNode; maxHeight?: number }) {
  return (
    <div style={{ maxHeight, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingInlineEnd: 2 }}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: '#94a3b8', fontSize: 13, padding: 24, textAlign: 'center', background: '#f8fafc', border: `1px dashed ${BORDER}`, borderRadius: 12 }}>
      {children}
    </div>
  );
}

// ── شريط الحفظ السفلي ───────────────────────────────────────────────────────
export function SaveBar({ status, tone = 'muted', onSave, saving, disabled, label = '💾 حفظ التغييرات' }: {
  status?: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'error'; onSave?: () => void; saving?: boolean; disabled?: boolean; label?: string;
}) {
  const color = tone === 'ok' ? '#16a34a' : tone === 'warn' ? '#d97706' : tone === 'error' ? '#dc2626' : '#64748b';
  return (
    <div style={{
      marginTop: 16, paddingTop: 14, borderTop: `1px solid ${BORDER}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>{status}</span>
      {onSave && (
        <button
          onClick={onSave}
          disabled={saving || disabled}
          style={{
            border: 'none', borderRadius: 10, padding: '9px 22px', fontSize: 13.5, fontWeight: 700, cursor: saving || disabled ? 'not-allowed' : 'pointer',
            background: ACCENT, color: '#fff', opacity: saving || disabled ? 0.6 : 1, boxShadow: '0 4px 12px rgba(79,70,229,.25)',
          }}
        >{saving ? '⏳ جاري الحفظ...' : label}</button>
      )}
    </div>
  );
}

// زر أدوات هادئ (خلفية فاتحة بلون الزر) — بديل الأزرار المصمتة في أشرطة الأدوات
export const softBtn = (color: string): CSSProperties => ({
  border: `1px solid ${color}33`, background: `${color}12`, color, borderRadius: 9,
  padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});

// زر أيقونة صغير داخل الخانات (تعديل/حذف/محافظة)
export const iconBtn = (color: string): CSSProperties => ({
  border: 'none', background: 'transparent', color, borderRadius: 6, padding: '3px 5px',
  fontSize: 12, cursor: 'pointer', lineHeight: 1, flexShrink: 0,
});

// أداة مساعدة: إضافة/إزالة مجموعة معرّفات من قائمة
export const setMany = (prev: number[], ids: number[], on: boolean) =>
  on ? [...new Set([...prev, ...ids])] : prev.filter(x => !ids.includes(x));
