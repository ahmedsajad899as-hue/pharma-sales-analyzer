import { useMemo } from 'react';

/**
 * خيارات قائمة اختيار المندوبين، مرتّبة كما في الهيكلية بدل قائمة مسطّحة:
 * مجموعة `<optgroup>` لكل شركة (فصل شكلي خفيف يرسمه المتصفح نفسه)، وداخلها
 * قائد الفريق ثم مندوبوه بإزاحة بسيطة، ثم من ليس تحت أي قائد.
 *
 * مشتركة بين «التقارير» و«التارگت» — أي صفحة تعرض نفس القائمة تستعملها كما هي.
 * لو لم تصل معلومات الأدوار/الشركات (المندوبون التجاريون من /api/representatives،
 * أو سجلات المندوبين المستقلة لحسابات manager/admin) تعود القائمة مسطّحة كما كانت.
 */

export interface GroupableRep {
  id: number;
  name: string;
  // تصل فقط من فرع «company-scoped» في /api/scientific-reps (مدير مكتب/شركة…):
  // role = دور حساب المستخدم، userId/managerIds بمعرّفات users (لا معرّف المندوب)،
  // company = اسم الشركة الرئيسية.
  role?: string;
  company?: string | null;
  userId?: number;
  managerIds?: number[];
}

const TEAM_LEADER_ROLES = new Set(['team_leader', 'commercial_team_leader']);
const NO_COMPANY = 'بدون شركة';

export interface RepOptionRow { rep: GroupableRep; isLeader: boolean; isMember: boolean }
export interface RepOptionGroup { company: string; rows: RepOptionRow[] }

export function groupRepsByTeam(reps: GroupableRep[]): RepOptionGroup[] {
  const hasMeta = reps.some(r => r.role || r.company);
  if (!hasMeta) return [{ company: '', rows: reps.map(rep => ({ rep, isLeader: false, isMember: false })) }];

  const byName = (a: GroupableRep, b: GroupableRep) => a.name.localeCompare(b.name, 'ar');
  const leaders = reps.filter(r => TEAM_LEADER_ROLES.has(r.role ?? ''));
  const leaderUserIds = new Set(leaders.map(l => l.userId).filter((v): v is number => v != null));

  // مرؤوسو كل قائد: أول مدير في قائمة مدرائه يكون قائد فريق ضمن نفس القائمة.
  // القادة أنفسهم لا يُدرجون كمرؤوسين حتى لا يتكرر الاسم في مجموعتين.
  const membersOf = new Map<number, GroupableRep[]>();
  const claimed = new Set<number>();
  for (const rep of reps) {
    if (TEAM_LEADER_ROLES.has(rep.role ?? '')) continue;
    const leaderId = (rep.managerIds ?? []).find(id => leaderUserIds.has(id));
    if (leaderId == null) continue;
    if (!membersOf.has(leaderId)) membersOf.set(leaderId, []);
    membersOf.get(leaderId)!.push(rep);
    claimed.add(rep.id);
  }

  const companies = [...new Set(reps.map(r => r.company || NO_COMPANY))]
    .sort((a, b) => (a === NO_COMPANY ? 1 : b === NO_COMPANY ? -1 : a.localeCompare(b, 'ar')));

  const groups: RepOptionGroup[] = [];
  for (const company of companies) {
    const rows: RepOptionRow[] = [];
    // القادة أولاً، وكل قائد يتبعه مندوبوه مباشرة — حتى لو كان مندوبه مُسجَّلاً
    // على شركة أخرى، يبقى تحت قائده (الفريق أهم من مطابقة الشركة).
    for (const leader of leaders.filter(l => (l.company || NO_COMPANY) === company).sort(byName)) {
      rows.push({ rep: leader, isLeader: true, isMember: false });
      for (const m of (membersOf.get(leader.userId!) ?? []).sort(byName)) {
        rows.push({ rep: m, isLeader: false, isMember: true });
      }
    }
    // الباقون: مندوبو هذه الشركة بلا قائد فريق
    for (const rep of reps
      .filter(r => (r.company || NO_COMPANY) === company && !claimed.has(r.id) && !TEAM_LEADER_ROLES.has(r.role ?? ''))
      .sort(byName)) {
      rows.push({ rep, isLeader: false, isMember: false });
    }
    if (rows.length > 0) groups.push({ company, rows });
  }
  return groups;
}

// إزاحة المندوب تحت قائده: مسافات غير قابلة للطي (المتصفح يطوي المسافة العادية)
const NBSP_INDENT = '\u00A0\u00A0\u00A0';
export const repOptionLabel = (row: RepOptionRow) =>
  row.isLeader ? `\u{1F465} ${row.rep.name}` : row.isMember ? `${NBSP_INDENT}${row.rep.name}` : row.rep.name;

/** خيارات جاهزة للوضع داخل `<select>` — بعد خيار «اختر مندوباً» مباشرةً. */
export default function RepSelectOptions({ reps }: { reps: GroupableRep[] }) {
  const groups = useMemo(() => groupRepsByTeam(reps), [reps]);
  return (
    <>
      {groups.map(g => g.company
        ? (
          <optgroup key={g.company} label={g.company}>
            {g.rows.map(row => <option key={row.rep.id} value={row.rep.id}>{repOptionLabel(row)}</option>)}
          </optgroup>
        )
        : g.rows.map(row => <option key={row.rep.id} value={row.rep.id}>{repOptionLabel(row)}</option>))}
    </>
  );
}
