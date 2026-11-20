// رفعات الملف التراكمي مجمّعة حسب شهر طلبياتها: الرفع اليومي/الأسبوعي لا يصير
// سبعة صفوف منفصلة بل بطاقة واحدة لشهره (مثلاً 11/2026) تحوي رفعاته وايتماته،
// مع تأشير الايتمات التي حملتها الرفعة المختارة (الافتراضي: آخر رفعة في الشهر).
import { useMemo, useState, type ReactNode } from 'react';

export type BatchItem = { itemId: number; name: string; qty: number; value: number };
export type GroupBatch = {
  id: number; originalName: string; uploadedAt: string; rowsAdded: number; isActive: boolean;
  monthsLabel: string | null; firstDate: string | null; lastDate: string | null; items?: BatchItem[];
};

/** شهر الرفعة = شهر آخر طلبية فيها، وإلا آخر شهر في monthsLabel، وإلا شهر الرفع. */
function monthKeyOf(b: GroupBatch): string {
  if (b.lastDate) return b.lastDate.slice(0, 7);
  const m = (b.monthsLabel || '').match(/(\d{4})-(\d{2})(?!.*\d{4}-\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const m2 = (b.monthsLabel || '').match(/(\d{1,2})\/(\d{4})(?!.*\d\/\d{4})/);
  if (m2) return `${m2[2]}-${m2[1].padStart(2, '0')}`;
  return b.uploadedAt.slice(0, 7);
}
const monthLabel = (k: string) => { const [y, m] = k.split('-'); return `${Number(m)}/${y}`; };
const num = (n: number) => Math.round(n).toLocaleString('ar-IQ');
const shortDate = (d: string) => { const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; };

type Props<B extends GroupBatch> = {
  batches: B[];
  /** صف الرفعة كما يرسمه UploadPage — idx = موقعها في القائمة الكاملة، itemsBtn يوضع داخل الصف. */
  renderBatch: (b: B, idx: number, itemsBtn: ReactNode) => ReactNode;
};

export default function BatchMonthGroups<B extends GroupBatch>({ batches, renderBatch }: Props<B>) {
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; list: { b: B; idx: number }[] }>();
    batches.forEach((b, idx) => {
      const key = monthKeyOf(b);
      if (!map.has(key)) map.set(key, { key, list: [] });
      map.get(key)!.list.push({ b, idx });
    });
    // الأحدث أولاً؛ داخل الشهر تبقى الرفعات بترتيب الخادم (الأحدث رفعاً أولاً).
    return [...map.values()].sort((a, z) => z.key.localeCompare(a.key));
  }, [batches]);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<string, number>>({});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {groups.map((g, gi) => {
        const isOpen = open[g.key] ?? gi === 0;
        const active = g.list.filter(x => x.b.isActive);
        const added = active.reduce((s, x) => s + Math.max(0, x.b.rowsAdded), 0);
        const firsts = active.map(x => x.b.firstDate).filter(Boolean) as string[];
        const lasts = active.map(x => x.b.lastDate).filter(Boolean) as string[];
        const first = firsts.sort()[0], last = lasts.sort().at(-1);
        const latest = g.list.reduce((a, x) => (new Date(x.b.uploadedAt) > new Date(a.b.uploadedAt) ? x : a), g.list[0]);
        const monthItemCount = new Set(active.flatMap(x => (x.b.items || []).map(i => i.itemId))).size;

        return (
          <div key={g.key} style={{ border: '1px solid #bfdbfe', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
            <button
              onClick={() => setOpen(o => ({ ...o, [g.key]: !isOpen }))}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#eff6ff', border: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: '#334155', textAlign: 'start' }}
            >
              <span style={{ fontWeight: 800, color: '#1d4ed8', fontSize: 13 }}>🗓️ شهر {monthLabel(g.key)}</span>
              <span>{num(g.list.length)} رفعة</span>
              <span style={{ color: '#065f46' }}>+{num(added)} صف</span>
              <span>{num(monthItemCount)} ايتم</span>
              {first && last && <span>🧾 {shortDate(first)} ← {shortDate(last)}</span>}
              <span style={{ color: '#94a3b8' }}>آخر رفعة {shortDate(latest.b.uploadedAt)}</span>
              <span style={{ marginInlineStart: 'auto', color: '#64748b' }}>{isOpen ? '▲' : '▼'}</span>
            </button>

            {isOpen && (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {g.list.map(({ b, idx }) => {
                  const sel = picked[b.id] === 1;
                  const btn = (b.items?.length ?? 0) > 0 ? (
                    <button
                      onClick={() => setPicked(p => ({ ...p, [b.id]: sel ? 0 : 1 }))}
                      title="عرض الايتمات التي رُفع لها مبيع في هذه الرفعة"
                      style={{ border: `1px solid ${sel ? '#34d399' : '#cbd5e1'}`, background: sel ? '#ecfdf5' : '#fff', color: sel ? '#047857' : '#475569', borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', fontWeight: sel ? 700 : 500 }}
                    >
                      {num(b.items!.length)} ايتم {sel ? '▲' : '▼'}
                    </button>
                  ) : null;
                  return (
                    <div key={b.id}>
                      {renderBatch(b, idx, btn)}
                      {sel && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 4px 2px', maxHeight: 150, overflowY: 'auto' }}>
                          {b.items!.map(it => (
                            <span key={it.itemId} style={{ fontSize: 11, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap', background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7', fontWeight: 600 }}>
                              {it.name} · {num(it.qty)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
