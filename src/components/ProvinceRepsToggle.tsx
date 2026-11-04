/**
 * فصل مندوبي المحافظات عن مندوبي بغداد في قوائم اختيار المندوبين.
 *
 * الخادم يعلّم كل مندوب/قائد فريق محافظة فعّال بـ `isProvinceMember`
 * (server/lib/provinceScope.js::provinceMemberUserIds). الافتراضي في كل صفحة:
 * مندوبو بغداد فقط؛ زر «مندوبي المحافظات» يقلب القائمة لتعرضهم وحدهم.
 * الاختيار يُحفظ لكل صفحة على حدة (localStorage) — تفضيل عرض لا أكثر.
 */
import { useState } from 'react';

type MaybeProvince = { isProvinceMember?: boolean };
// الأنواع المستدعية لا تعلن الحقل غالباً — يُقرأ ديناميكياً (object لا MaybeProvince
// لأن نوعاً حقوله كلها اختيارية يرفضه TS كـ«weak type» مع أنواع لا تشاركه حقلاً).
const isProv = (r: object) => !!(r as MaybeProvince).isProvinceMember;

const storeKey = (pageKey: string) => `provinceReps:${pageKey}`;

export function useProvinceRepScope(pageKey: string): [boolean, (v: boolean) => void] {
  const [onlyProvince, setState] = useState<boolean>(() => {
    try { return localStorage.getItem(storeKey(pageKey)) === '1'; } catch { return false; }
  });
  const set = (v: boolean) => {
    setState(v);
    try { localStorage.setItem(storeKey(pageKey), v ? '1' : '0'); } catch { /* تفضيل اختياري */ }
  };
  return [onlyProvince, set];
}

/** بغداد (الافتراضي) ← غير أعضاء المحافظات؛ «المحافظات» ← أعضاؤها فقط. */
export function filterByProvinceScope<T extends object>(reps: T[], onlyProvince: boolean): T[] {
  return reps.filter(r => isProv(r) === onlyProvince);
}

export function hasProvinceReps(reps: object[]): boolean {
  return reps.some(isProv);
}

export interface RepProvince { id: number; name: string; sortOrder?: number }
type ProvinceRep = { name: string; provinces?: RepProvince[]; isLeader?: boolean };

const byRepOrder = (a: ProvinceRep, b: ProvinceRep) =>
  Number(!!b.isLeader) - Number(!!a.isLeader) || a.name.localeCompare(b.name, 'ar');
const provinceRank = (r: ProvinceRep) => r.provinces?.[0]?.sortOrder ?? Number.MAX_SAFE_INTEGER;

/** ترتيب ثابت لمندوبي المحافظات: المحافظة، ثم القائد أولاً، ثم الاسم. */
export function sortRepsByProvince<T extends ProvinceRep>(reps: T[]): T[] {
  return [...reps].sort((a, b) => provinceRank(a) - provinceRank(b) || byRepOrder(a, b));
}

export interface ProvinceRepGroup<T> { id: number | null; name: string; reps: T[] }

/**
 * صف لكل محافظة بترتيبها في النظام. مندوب بمحافظتين يظهر تحت الاثنتين؛ من لا محافظة
 * له في آخر القائمة تحت «غير محدد» بدل أن يختفي.
 */
export function groupRepsByProvince<T extends ProvinceRep>(reps: T[]): ProvinceRepGroup<T>[] {
  const groups = new Map<number, ProvinceRepGroup<T> & { order: number }>();
  const unassigned: T[] = [];
  for (const rep of reps) {
    if (!rep.provinces?.length) { unassigned.push(rep); continue; }
    for (const p of rep.provinces) {
      if (!groups.has(p.id)) groups.set(p.id, { id: p.id, name: p.name, order: p.sortOrder ?? Number.MAX_SAFE_INTEGER, reps: [] });
      groups.get(p.id)!.reps.push(rep);
    }
  }
  const out: ProvinceRepGroup<T>[] = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ id, name, reps: list }) => ({ id, name, reps: [...list].sort(byRepOrder) }));
  if (unassigned.length) out.push({ id: null, name: 'غير محدد', reps: [...unassigned].sort(byRepOrder) });
  return out;
}

export type ProvinceViewMode = 'company' | 'province';

/** طريقة عرض مندوبي المحافظات: حسب الشركة (الافتراضي) أو حسب المحافظة. تفضيل لكل صفحة. */
export function useProvinceViewMode(pageKey: string): [ProvinceViewMode, (v: ProvinceViewMode) => void] {
  const key = `provinceRepsView:${pageKey}`;
  const [mode, setState] = useState<ProvinceViewMode>(() => {
    try { return localStorage.getItem(key) === 'province' ? 'province' : 'company'; } catch { return 'company'; }
  });
  const set = (v: ProvinceViewMode) => {
    setState(v);
    try { localStorage.setItem(key, v); } catch { /* تفضيل اختياري */ }
  };
  return [mode, set];
}

/** الزر — يختفي تلقائياً حين لا يوجد أي مندوب محافظة في القائمة (ولم يكن مُفعّلاً). */
export default function ProvinceRepsToggle({ reps, value, onChange, compact = false }: {
  reps: object[];
  value: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
}) {
  if (!value && !hasProvinceReps(reps)) return null;
  const count = reps.filter(isProv).length;
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      title={value ? 'العودة لمندوبي بغداد' : 'عرض مندوبي المحافظات فقط (خارج بغداد)'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
        padding: compact ? '4px 10px' : '6px 12px', borderRadius: 999, cursor: 'pointer',
        fontSize: compact ? 11.5 : 12.5, fontWeight: 700, fontFamily: 'inherit',
        border: `1.5px solid ${value ? '#0d9488' : '#cbd5e1'}`,
        background: value ? '#ccfbf1' : '#fff',
        color: value ? '#0f766e' : '#475569',
      }}
    >
      <span aria-hidden>🗺️</span>
      {value ? 'مندوبو المحافظات' : 'مندوبي المحافظات'}
      <span style={{ fontSize: 10.5, fontWeight: 800, background: value ? '#0d9488' : '#e2e8f0', color: value ? '#fff' : '#475569', borderRadius: 999, padding: '0 6px' }}>{count}</span>
      {value && <span aria-hidden style={{ fontSize: 11, opacity: .7 }}>✕</span>}
    </button>
  );
}
