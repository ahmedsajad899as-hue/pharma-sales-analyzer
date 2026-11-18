/**
 * تقسيم أشخاص صفحة التارگت إلى مجموعات تُعرض كل واحدة وحدها:
 *  - شركة لكل مدير شركة (عمود المدير معرّفه سالب): مندوبوه — مباشرةً أو عبر قائد
 *    فريق تحته — وإلا من شركته الرئيسية نفس شركة المدير. صفوفها = ايتمات المدير
 *    («الشركة» = ايتمات المدير، لا كل ايتمات الشركة).
 *  - «مسوقين بغداد» / «مسوقين المحافظات»: المسوّق لا ينتمي لشركة (كل شركات المكتب
 *    رئيسية له للعمل فقط)، فيُفصل قبل أي تجميع بالشركة — ومعه مدير المسوقين.
 *  - من لم يُطابق مديراً: مجموعة باسم شركته (بلا مدير).
 * المندوب المشترك (يتبع مديرَين) يظهر في الشركتين.
 */

export interface MatrixRep {
  id: number;
  name: string;
  company?: string | null;
  role?: string;
  userId?: number;
  managerIds?: number[];
  repKind?: string;
  marketerScope?: 'baghdad' | 'province';
  isProvinceMember?: boolean;
  /** محافظات مندوب/مسوق المحافظة — تُكتب تحت اسمه */
  provinceNames?: string[];
}

export type GroupKind = 'company' | 'other' | 'marketers';

export interface TargetGroup {
  key: string;
  name: string;
  kind: GroupKind;
  /** أعمدة المدراء (معرّف سالب) — تُعرض أولاً ولا تدخل المجموع */
  managers: MatrixRep[];
  reps: MatrixRep[];
}

export interface ColumnBlock { label: string; span: number }

const LEADER_ROLES = new Set(['team_leader', 'commercial_team_leader']);
const isMarketer = (r: MatrixRep) => r.repKind === 'pharmacy';
const byName = (a: MatrixRep, b: MatrixRep) => a.name.localeCompare(b.name, 'ar');
export const isLeader = (r: MatrixRep) => LEADER_ROLES.has(r.role ?? '');
export const isManagerCol = (id: number) => id < 0;

export function buildTargetGroups(people: MatrixRep[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  const ensure = (key: string, name: string, kind: GroupKind) => {
    let g = groups.get(key);
    if (!g) { g = { key, name, kind, managers: [], reps: [] }; groups.set(key, g); }
    return g;
  };
  const marketersGroup = (r: MatrixRep) => (r.marketerScope === 'province'
    ? ensure('mk:province', 'مسوقين المحافظات', 'marketers')
    : ensure('mk:baghdad', 'مسوقين بغداد', 'marketers'));

  const companyMgrs: MatrixRep[] = [];
  for (const m of people.filter(p => isManagerCol(p.id))) {
    if (isMarketer(m)) { marketersGroup(m).managers.push(m); continue; }
    companyMgrs.push(m);
    ensure(`m:${m.id}`, m.company || m.name, 'company').managers.push(m);
  }

  const reps = people.filter(p => !isManagerCol(p.id));
  const repByUser = new Map(reps.filter(r => r.userId != null).map(r => [r.userId!, r]));
  const mgrByUser = new Map(companyMgrs.map(m => [m.userId ?? -m.id, m]));

  // مدير الشركة فوق المندوب: مباشرةً أو عبر قائد فريقه (مستويان يكفيان)
  const managersAbove = (r: MatrixRep) => {
    const out = new Set<MatrixRep>();
    const seen = new Set<number>();
    const walk = (ids: number[] | undefined, depth: number) => {
      for (const id of ids ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const m = mgrByUser.get(id);
        if (m) out.add(m);
        else if (depth < 2) walk(repByUser.get(id)?.managerIds, depth + 1);
      }
    };
    walk(r.managerIds, 0);
    return [...out];
  };

  for (const r of reps) {
    if (isMarketer(r)) { marketersGroup(r).reps.push(r); continue; }
    let ms = managersAbove(r);
    if (!ms.length && r.company) ms = companyMgrs.filter(m => m.company === r.company).slice(0, 1);
    if (ms.length) { ms.forEach(m => groups.get(`m:${m.id}`)!.reps.push(r)); continue; }
    const name = r.company || 'بدون شركة';
    ensure(`c:${name}`, name, 'other').reps.push(r);
  }

  const rank: Record<GroupKind, number> = { company: 0, other: 1, marketers: 2 };
  const list = [...groups.values()].sort((a, b) =>
    rank[a.kind] - rank[b.kind]
    || (a.kind === 'marketers' ? a.key.localeCompare(b.key) : a.name.localeCompare(b.name, 'ar')));
  // بلا أي معلومة شركة (المندوبون التجاريون مثلاً) — مجموعة واحدة بلا تبويبات
  if (list.length === 1 && list[0].kind === 'other' && list[0].name === 'بدون شركة') list[0].name = 'كل المندوبين';
  return list;
}

/**
 * ترتيب أعمدة المجموعة: المدير، ثم كل قائد فريق يتبعه مندوبوه، ثم الباقون.
 * blocks = عناوين الصف العلوي في رأس الجدول (فريق فلان…).
 */
export function orderGroupColumns(g: TargetGroup): { cols: MatrixRep[]; blocks: ColumnBlock[] } {
  const cols: MatrixRep[] = [];
  const blocks: ColumnBlock[] = [];
  const push = (label: string, list: MatrixRep[]) => {
    if (!list.length) return;
    cols.push(...list);
    blocks.push({ label, span: list.length });
  };
  push(g.kind === 'marketers' ? 'مدير المسوقين' : 'المدير', [...g.managers].sort(byName));

  const leaders = g.reps.filter(isLeader).sort(byName);
  const claimed = new Set<number>(leaders.map(l => l.id));
  for (const leader of leaders) {
    const members = leader.userId == null ? [] : g.reps
      .filter(r => !claimed.has(r.id) && (r.managerIds ?? []).includes(leader.userId!))
      .sort(byName);
    members.forEach(m => claimed.add(m.id));
    push(`فريق ${leader.name}`, [leader, ...members]);
  }
  const rest = g.reps.filter(r => !claimed.has(r.id)).sort(byName);
  push(blocks.length ? 'بلا قائد فريق' : '', rest);
  return { cols, blocks };
}
