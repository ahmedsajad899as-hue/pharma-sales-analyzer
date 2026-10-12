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
/** المستخدم حدّد مدى تواريخ يدوياً — لا شريحة مختارة ولا `month` يُرسَل للسيرفر. */
export const MONTH_CUSTOM = 'custom';

const pad = (n: number) => String(n).padStart(2, '0');
/** '2026-10' → { from: '2026-10-01', to: '2026-10-31' } (تواريخ محلية، بلا انزياح UTC). */
export function monthDateRange(ym: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  const last = new Date(y, mo, 0).getDate();
  return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(last)}` };
}

/**
 * يجلب أشهر الملفات المفعّلة ويختار الأحدث تلقائياً.
 *
 * ⚠️ الاختيار التلقائي يُعاد مرة واحدة لكل مجموعة ملفات (fileIds): إعادته عند
 * كل تحميل كانت ستُلغي اختيار المستخدم للشهر في كل مرة تُعاد فيها القائمة.
 *
 * @param fileIds الملفات المفعّلة
 * @param token   توكن المصادقة
 */
export function useSalesMonths(
  fileIds: number[],
  token: string | null,
  /** يُستدعى عند كل تغيّر في الشهر (اختيار المستخدم أو الافتراضي التلقائي) — لمزامنة حقول التاريخ. */
  onPick?: (month: string) => void,
): SalesMonthsState & {
  month: string;
  setMonth: (m: string) => void;
  /** false حتى تصل قائمة الأشهر ويُحسَم الشهر الافتراضي — التحميل التلقائي ينتظرها. */
  ready: boolean;
  /** يُلحق `month` بالاستعلام — '' (الكل) لا يُرسل شيئاً فيبقى سلوك الخادم كما كان. */
  applyTo: (params: URLSearchParams) => URLSearchParams;
} {
  const key = fileIds.join(',');
  const [state, setState] = useState<SalesMonthsState>({ months: [], undatedCount: 0, latest: null, loading: false });
  const [month, setMonthRaw] = useState<string>(MONTH_ALL);
  const [readyKey, setReadyKey] = useState<string>('__init__');
  const autoPickedFor = useRef<string>('');
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const setMonth = useCallback((m: string) => { setMonthRaw(m); onPickRef.current?.(m); }, []);

  useEffect(() => {
    if (!key || !token) {
      setState({ months: [], undatedCount: 0, latest: null, loading: false });
      setReadyKey(key);
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
        setReadyKey(key);
      })
      .catch(() => { if (!cancelled) { setState(s => ({ ...s, loading: false })); setReadyKey(key); } });
    return () => { cancelled = true; };
  }, [key, token]);

  const applyTo = useCallback((params: URLSearchParams) => {
    if (month && month !== MONTH_ALL && month !== MONTH_CUSTOM) params.set('month', month);
    return params;
  }, [month]);

  return { ...state, month, setMonth, ready: readyKey === key, applyTo };
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

  // الملف التراكمي يكبر شهراً بعد شهر: نُظهر آخر 4 أشهر كشرائح، والأقدم في قائمة
  // منسدلة صغيرة — وإن كان المختار شهراً قديماً يظهر هو في القائمة مُضاءً.
  const VISIBLE = 4;
  const shown = months.slice(-VISIBLE);
  const older = months.slice(0, -VISIBLE);
  const olderActive = older.some(m => m.ym === value);

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all .15s',
    border: 'none',
    background: active ? 'var(--c-accent, #2563eb)' : 'transparent',
    color: active ? '#fff' : '#475569',
  });

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: '#f1f5f9', borderRadius: 999, padding: 3, flexWrap: 'wrap' }}>
      <button type="button" style={chip(value === MONTH_ALL)} onClick={() => onChange(MONTH_ALL)} title="كل الأشهر داخل الملف">
        الكل
      </button>

      {older.length > 0 && (
        <select
          value={olderActive ? value : ''}
          onChange={e => e.target.value && onChange(e.target.value)}
          title="أشهر أقدم"
          style={{ ...chip(olderActive), appearance: 'none', paddingInline: 8, outline: 'none' }}
        >
          <option value="" style={{ color: '#475569' }}>أقدم…</option>
          {older.slice().reverse().map(m => (
            <option key={m.ym} value={m.ym} style={{ color: '#111' }}>{m.short}</option>
          ))}
        </select>
      )}

      {shown.map(m => (
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
          style={chip(value === MONTH_UNDATED)}
          onClick={() => onChange(MONTH_UNDATED)}
          title={`${undatedCount.toLocaleString()} صف بلا عمود تاريخ في الإكسل — لا تُنسب لأي شهر`}
        >
          بلا تاريخ
        </button>
      )}

      {loading && <span style={{ fontSize: 11, color: '#9ca3af', paddingInline: 4 }}>…</span>}
    </div>
  );
}
