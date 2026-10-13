// تنسيق الأرقام والعملة في «فرق المحافظات».
// قيم التغطية تصل من الخادم بالدولار (مُطبَّعة كباقي التقارير متعددة الملفات)،
// وتُعرض بعملة ملفات المكتب افتراضياً مع مفتاح تبديل.

export type DisplayCurrency = 'IQD' | 'USD';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined) => nf0.format(Math.round(Number(n) || 0));

function compactIQD(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${nf1.format(v / 1e9)} مليار`;
  if (a >= 1e6) return `${nf1.format(v / 1e6)} مليون`;
  if (a >= 1e3) return `${nf1.format(v / 1e3)} ألف`;
  return nf0.format(v);
}

export interface Money {
  /** قيمة بالدولار ← نص مختصر بعملة العرض */
  usd: (v: number | null | undefined) => string;
  /** نفس القيمة بالأرقام الكاملة — لتلميح title */
  usdFull: (v: number | null | undefined) => string;
  /** قيمة بعملتها الأصلية (الجهد الشخصي) ← عملة العرض */
  native: (v: number | null | undefined, currency: 'IQD' | 'USD') => string;
  toDisplay: (usdValue: number) => number;
  label: string;
}

export function makeMoney(display: DisplayCurrency, rate: number): Money {
  const r = rate || 1470;
  const toDisplay = (usdValue: number) => (display === 'IQD' ? usdValue * r : usdValue);
  const fmt = (v: number) => (display === 'IQD' ? `${compactIQD(v)} د.ع` : `$${nf0.format(v)}`);
  const full = (v: number) => (display === 'IQD' ? `${nf0.format(v)} د.ع` : `$${nf0.format(v)}`);
  return {
    usd: (v) => fmt(toDisplay(Number(v) || 0)),
    usdFull: (v) => full(toDisplay(Number(v) || 0)),
    native: (v, currency) => {
      const n = Number(v) || 0;
      const usd = currency === 'USD' ? n : n / r;
      return fmt(toDisplay(usd));
    },
    toDisplay,
    label: display === 'IQD' ? 'د.ع' : '$',
  };
}

export const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

export const initials = (name: string | null | undefined) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
};

export const MODE_LABEL: Record<string, string> = {
  office: 'إدارة المكتب',
  leader: 'تيم ليدر محافظة',
  company: 'مدير شركة',
  rep: 'مندوب علمي',
};
