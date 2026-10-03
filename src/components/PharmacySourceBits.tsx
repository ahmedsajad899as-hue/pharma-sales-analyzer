// مكوّنات مشتركة لتمييز مصدر طلبيات الصيدليات (مكتب / ميركاتو) — تُستعمل في نافذتي
// «مبيعات الصيدلية» (خطة الشهر) و«مقارنة بيانات المبيع» (تحليل الكولات).

export type Src = 'office' | 'mercato';

// ألوان المصدر نفسها المستعملة في تبويب التقارير (Office رمادي-أخضر، Mercato أزرق فاتح)
export const SRC_STYLE: Record<Src, { label: string; fg: string; bg: string }> = {
  office:  { label: 'مكتب',    fg: '#475569', bg: '#F1F5F9' },
  mercato: { label: 'ميركاتو', fg: '#1d4ed8', bg: '#EAF2FB' },
};

export interface SourceTotals {
  office:  { orders: number; sales: number; returns: number };
  mercato: { orders: number; sales: number; returns: number };
}

/** شارة صغيرة تُوضع بجانب كل طلبية. لا تظهر إن لم يُعرف المصدر (استجابة قديمة). */
export function SourceChip({ src, small }: { src?: Src; small?: boolean }) {
  if (!src) return null;
  const s = SRC_STYLE[src];
  return (
    <span style={{ fontSize: small ? 9 : 10, fontWeight: 700, color: s.fg, background: s.bg, borderRadius: 4, padding: '0 5px', lineHeight: '16px', whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

/** شريط توزيع هادئ: صافي المبيع لكل مصدر، ويُخفى إن كانت الصيدلية في مصدر واحد فقط. */
export function SourceSplit({ totals }: { totals: SourceTotals }) {
  const parts = (['office', 'mercato'] as Src[])
    .map(k => ({ k, value: totals[k].sales - totals[k].returns, orders: totals[k].orders }))
    .filter(p => p.orders > 0);
  if (parts.length < 2) return null;
  const sum = parts.reduce((a, p) => a + Math.max(p.value, 0), 0);
  return (
    <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--c-bg)', borderRadius: 10, border: '1px solid var(--c-border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-text-secondary)', marginBottom: 6 }}>توزيع المبيع حسب المصدر</div>
      <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--c-border-light)', marginBottom: 8 }}>
        {parts.map(p => (
          <div key={p.k} style={{ width: `${sum > 0 ? (Math.max(p.value, 0) / sum) * 100 : 50}%`, background: SRC_STYLE[p.k].fg, opacity: 0.75 }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        {parts.map(p => (
          <div key={p.k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--c-text-secondary)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: SRC_STYLE[p.k].fg, opacity: 0.75 }} />
            <span style={{ fontWeight: 700, color: SRC_STYLE[p.k].fg }}>{SRC_STYLE[p.k].label}</span>
            <span>{p.value.toLocaleString()} د.ع</span>
            <span style={{ color: 'var(--c-text-muted)' }}>· {p.orders} طلبية</span>
          </div>
        ))}
      </div>
    </div>
  );
}
