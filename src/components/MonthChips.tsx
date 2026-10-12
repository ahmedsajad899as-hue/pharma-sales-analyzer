// ════════════════════════════════════════════════════════════════════════════
// MonthChips — شرائح اختيار الشهر فوق شاشات التحليل (شامل / علمي / تجاري).
//
// بعد أن صارت كل الأشهر داخل ملف تراكمي واحد، لم يعد «الملف المفعّل» يحدّد
// الفترة المعروضة. هذه الشرائح هي البديل: الشهر الأحدث هو المختار افتراضياً
// (آخر ما وصل من بيانات هو ما يُسأل عنه عادةً)، و«الكل» يعرض التراكم كاملاً.
//
// شريحة «بلا تاريخ» تظهر فقط حين توجد صفوف بلا عمود تاريخ في الإكسل. عزلُها
// شريحةً مستقلة مقصود: ضمّها لأي شهر كان سيجعل مجموع الأشهر أكبر من «الكل»،
// وإخفاؤها كان سيُضيّع صفوفاً بصمت — وهو ما حصل فعلاً قبلها (راجع ذاكرة
// project_pharma_overall_undated_rows).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SalesMonth {
  ym: string;
  label: string;
  short: string;
  count: number;
}

export interface SalesMonthsState {
  months: SalesMonth[];
  undatedCount: number;
  latest: string | null;
  loading: boolean;
}

/** '' يعني «لم يُختَر بعد» — الواجهة تضبطه على أحدث شهر فور وصول القائمة. */
export const MONTH_ALL = 'all';
export const MONTH_UNDATED = 'none';

/**
 * يجلب أشهر الملفات المفعّلة ويختار الأحدث تلقائياً.
 *
 * ⚠️ الاختيار التلقائي يُعاد مرة واحدة لكل مجموعة ملفات (fileIds): إعادته عند
 * كل تحميل كانت ستُلغي اختيار المستخدم للشهر في كل مرة تُعاد فيها القائمة.
 *
 * @param fileIds الملفات المفعّلة
 * @param token   توكن المصادقة
 */
export function useSalesMonths(fileIds: number[], token: string | null): SalesMonthsState & {
  month: string;
  setMonth: (m: string) => void;
  /** يُلحق `month` بالاستعلام — '' (الكل) لا يُرسل شيئاً فيبقى سلوك الخادم كما كان. */
  applyTo: (params: URLSearchParams) => URLSearchParams;
} {
  const key = fileIds.join(',');
  const [state, setState] = useState<SalesMonthsState>({ months: [], undatedCount: 0, latest: null, loading: false });
  const [month, setMonth] = useState<string>(MONTH_ALL);
  const autoPickedFor = useRef<string>('');

  useEffect(() => {
    if (!key || !token) {
      setState({ months: [], undatedCount: 0, latest: null, loading: false });
      return;
    }
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    fetch(`/api/sales/months?fileIds=${key}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        const data = j?.data ?? {};
        const months: SalesMonth[] = Array.isArray(data.months) ? data.months : [];
        setState({ months, undatedCount: data.undatedCount ?? 0, latest: data.latest ?? null, loading: false });
        // الافتراضي المطلوب: «آخر شهر موجودة بياناته في الملف».
        if (autoPickedFor.current !== key) {
          autoPickedFor.current = key;
          setMonth(data.latest ?? MONTH_ALL);
        }
      })
      .catch(() => { if (!cancelled) setState(s => ({ ...s, loading: false })); });
    return () => { cancelled = true; };
  }, [key, token]);

  const applyTo = useCallback((params: URLSearchParams) => {
    if (month && month !== MONTH_ALL) params.set('month', month);
    return params;
  }, [month]);

  return { ...state, month, setMonth, applyTo };
}

interface Props {
  months: SalesMonth[];
  undatedCount: number;
  value: string;
  onChange: (month: string) => void;
  loading?: boolean;
  /** يُخفي الشريط كلياً حين لا توجد بيانات مؤرَّخة إطلاقاً. */
  hideWhenEmpty?: boolean;
}

export default function MonthChips({ months, undatedCount, value, onChange, loading, hideWhenEmpty = true }: Props) {
  if (hideWhenEmpty && months.length === 0 && undatedCount === 0) return null;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 11px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all .15s',
    border: `1px solid ${active ? 'var(--c-accent, #2563eb)' : '#d1d5db'}`,
    background: active ? 'var(--c-accent, #2563eb)' : '#fff',
    color: active ? '#fff' : '#374151',
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span aria-hidden>🗓️</span> الشهر
      </span>

      <button type="button" style={chip(value === MONTH_ALL)} onClick={() => onChange(MONTH_ALL)} title="كل الأشهر داخل الملف">
        الكل
      </button>

      {months.map(m => (
        <button
          key={m.ym}
          type="button"
          style={chip(value === m.ym)}
          onClick={() => onChange(m.ym)}
          title={`${m.label} — ${m.count.toLocaleString()} صف`}
        >
          {m.short}
        </button>
      ))}

      {undatedCount > 0 && (
        <button
          type="button"
          style={{ ...chip(value === MONTH_UNDATED), borderStyle: 'dashed' }}
          onClick={() => onChange(MONTH_UNDATED)}
          title={`${undatedCount.toLocaleString()} صف بلا عمود تاريخ في الإكسل — لا تُنسب لأي شهر`}
        >
          بلا تاريخ
        </button>
      )}

      {loading && <span style={{ fontSize: 11, color: '#9ca3af' }}>…</span>}
    </div>
  );
}
