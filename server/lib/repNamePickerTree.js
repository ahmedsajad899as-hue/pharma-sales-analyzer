// ════════════════════════════════════════════════════════════════════════════
// repNamePickerTree.js — ترتيب قائمة «نسب اسم ميركاتو لحساب» بهيكلية المكتب الفعلية
// (طلب المستخدم 2026-11-18). دالة نقية بلا قاعدة بيانات — الاختبار:
// scripts/test-rep-name-picker-tree.mjs
//
// الأقسام بالترتيب، وكل حساب يظهر مرة واحدة في أول قسم يخصّه:
//   1. الشركات      — لكل شركة (الرئيسية): المدير ← تيم ليدر الكرخ ومندوبوه ← تيم ليدر
//                      الرصافة ومندوبوه ← بقية التيم ليدرية ← مندوبون بلا تيم ليدر.
//   2. المحافظات    — تيم ليدر المحافظة لا يُحسب على شركة: لكل محافظة قائدها ثم مندوبوها.
//   3. مسوقو بغداد  — المدير ← تيم ليدر كل قسم ومسوقوه ← بلا تيم ليدر.
//   4. مسوقو المحافظات — مديرهم ثم مسوقو كل محافظة.
//   5. إدارة المكتب — مدير المكتب، موظفوه، HR، مدير المنتج.
// ════════════════════════════════════════════════════════════════════════════

export const SECTION = {
  companies:   'الشركات',
  provinces:   'المحافظات',
  marketersBg: 'مسوقو بغداد',
  marketersPv: 'مسوقو المحافظات',
  office:      'إدارة المكتب',
  other:       'حسابات أخرى',
};

const OFFICE_LEVEL = new Set(['office_manager', 'office_employee', 'office_hr', 'product_manager']);
const MANAGER_LEVEL = new Set(['company_manager', 'supervisor', 'commercial_supervisor']);
const LEADER_LEVEL = new Set(['team_leader', 'commercial_team_leader']);

export const ROLE_LABEL_AR = {
  scientific_rep: 'مندوب', team_leader: 'تيم ليدر', company_manager: 'مدير', supervisor: 'مشرف',
  product_manager: 'مدير منتج', office_manager: 'مدير مكتب', office_employee: 'موظف مكتب', office_hr: 'HR',
  commercial_supervisor: 'مشرف تجاري', commercial_team_leader: 'تيم ليدر تجاري', commercial_rep: 'مندوب تجاري',
};

const sideRank = (s) => (/كرخ/.test(s ?? '') ? 0 : /رصاف/.test(s ?? '') ? 1 : s ? 2 : 3);
const byName = (a, b) => a.name.localeCompare(b.name, 'ar');
/** قسم التيم ليدر: الكرخ/الرصافة من اسمه أولاً («نور الدين / ليدر الرصافة») ثم من مناطقه. */
export function leaderSide(u) {
  if (/كرخ/.test(u.name)) return 'الكرخ';
  if (/رصاف/.test(u.name)) return 'الرصافة';
  if (/كرخ/.test(u.side ?? '')) return 'الكرخ';
  if (/رصاف/.test(u.side ?? '')) return 'الرصافة';
  return u.side ?? null;
}

/**
 * @param {object} p
 * @param {{id:number, role:string, name:string, repId:number, company:string|null,
 *          isMarketer:boolean, managerIds:number[], side?:string|null}[]} p.users
 * @param {{provinceName:string, leaderUserId:number|null, repUserIds:number[]}[]} p.provinceTeams
 * @param {Map<number,string[]>} p.provinceMarketers   userId → أسماء محافظاته
 * @param {Set<number>} p.provinceMarketerManagers     userIds
 * @returns {{userId:number, section:string, group:string, depth:number, roleLabel:string}[]} بالترتيب
 */
export function buildRepNamePickerTree({ users, provinceTeams = [], provinceMarketers = new Map(), provinceMarketerManagers = new Set() }) {
  const out = [];
  const placed = new Set();
  const byId = new Map(users.map(u => [u.id, u]));
  const put = (u, section, group, depth, roleLabel) => {
    if (!u || placed.has(u.id)) return;
    placed.add(u.id);
    out.push({ userId: u.id, section, group, depth, roleLabel: roleLabel ?? ROLE_LABEL_AR[u.role] ?? u.role });
  };

  // من يُعزل عن الشركات: أعضاء فرق المحافظات، المسوقون، الإدارة المكتبية
  const provinceMemberIds = new Set(provinceTeams.flatMap(t => [t.leaderUserId, ...t.repUserIds]).filter(x => x != null));
  const isOffice = (u) => OFFICE_LEVEL.has(u.role);

  /** قائد ثم تابعوه، مرتّبون بالقسم (الكرخ ثم الرصافة) ثم بالاسم. */
  const leaderBlocks = (section, group, leaders, members) => {
    const leaderIds = new Set(leaders.map(l => l.id));
    const sorted = [...leaders].sort((a, b) => sideRank(leaderSide(a)) - sideRank(leaderSide(b)) || byName(a, b));
    for (const l of sorted) {
      const side = leaderSide(l);
      put(l, section, group, 0, side ? `${ROLE_LABEL_AR[l.role] ?? 'تيم ليدر'} · ${side}` : undefined);
      for (const m of members.filter(x => x.managerIds.includes(l.id)).sort(byName)) put(m, section, group, 1);
    }
    return members.filter(m => !m.managerIds.some(id => leaderIds.has(id)));
  };

  // ── 1. الشركات ──
  const companyPeople = users.filter(u => !u.isMarketer && !isOffice(u) && !provinceMemberIds.has(u.id));
  const companies = [...new Set(companyPeople.map(u => u.company ?? ''))]
    .sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b, 'ar')));
  for (const co of companies) {
    const group = co || 'بلا شركة';
    const people = companyPeople.filter(u => (u.company ?? '') === co);
    for (const m of people.filter(u => MANAGER_LEVEL.has(u.role)).sort((a, b) => (a.role === 'company_manager' ? 0 : 1) - (b.role === 'company_manager' ? 0 : 1) || byName(a, b))) {
      put(m, SECTION.companies, group, 0);
    }
    const leaders = people.filter(u => LEADER_LEVEL.has(u.role));
    const reps = people.filter(u => !MANAGER_LEVEL.has(u.role) && !LEADER_LEVEL.has(u.role));
    const loose = leaderBlocks(SECTION.companies, group, leaders, reps);
    for (const r of loose.sort(byName)) put(r, SECTION.companies, group, 0);
  }

  // ── 2. المحافظات ──
  for (const t of [...provinceTeams].sort((a, b) => a.provinceName.localeCompare(b.provinceName, 'ar'))) {
    const leader = t.leaderUserId != null ? byId.get(t.leaderUserId) : null;
    if (leader) put(leader, SECTION.provinces, t.provinceName, 0, `تيم ليدر ${t.provinceName}`);
    const reps = t.repUserIds.map(id => byId.get(id)).filter(Boolean).sort(byName);
    for (const r of reps) put(r, SECTION.provinces, t.provinceName, leader ? 1 : 0);
  }

  // ── 3. مسوقو بغداد ──
  const marketers = users.filter(u => u.isMarketer && !provinceMarketers.has(u.id) && !provinceMarketerManagers.has(u.id));
  for (const m of marketers.filter(u => MANAGER_LEVEL.has(u.role) || OFFICE_LEVEL.has(u.role)).sort(byName)) put(m, SECTION.marketersBg, 'المدير', 0, 'مدير المسوقين');
  {
    const leaders = marketers.filter(u => LEADER_LEVEL.has(u.role));
    const reps = marketers.filter(u => !LEADER_LEVEL.has(u.role) && !MANAGER_LEVEL.has(u.role) && !OFFICE_LEVEL.has(u.role));
    // تُجمَّع بالقسم: الكرخ ثم الرصافة — المسوق بلا قائد تحت قسمه
    const sideOf = (u) => leaderSide(u) ?? 'بلا قسم';
    const sides = [...new Set([...leaders, ...reps].map(sideOf))].sort((a, b) => sideRank(a === 'بلا قسم' ? null : a) - sideRank(b === 'بلا قسم' ? null : b));
    const leaderIds = new Set(leaders.map(l => l.id));
    for (const side of sides) {
      const sideLeaders = leaders.filter(l => sideOf(l) === side);
      const underSide = reps.filter(r => r.managerIds.some(id => sideLeaders.some(l => l.id === id)));
      leaderBlocks(SECTION.marketersBg, side, sideLeaders, underSide);
      const loose = reps.filter(r => sideOf(r) === side && !r.managerIds.some(id => leaderIds.has(id)));
      for (const r of loose.sort(byName)) put(r, SECTION.marketersBg, side, 0, 'مسوق');
    }
    // من بقي (قائده في قسم آخر)
    for (const r of reps.sort(byName)) put(r, SECTION.marketersBg, 'أخرى', 0, 'مسوق');
  }

  // ── 4. مسوقو المحافظات ──
  for (const id of provinceMarketerManagers) put(byId.get(id), SECTION.marketersPv, 'المدير', 0, 'مدير مسوقي المحافظات');
  const pvNames = [...new Set([...provinceMarketers.values()].flat())].sort((a, b) => a.localeCompare(b, 'ar'));
  for (const pv of pvNames) {
    const list = [...provinceMarketers.entries()].filter(([, names]) => names[0] === pv).map(([id]) => byId.get(id)).filter(Boolean).sort(byName);
    for (const m of list) put(m, SECTION.marketersPv, pv, 0, 'مسوق');
  }
  for (const id of provinceMarketers.keys()) put(byId.get(id), SECTION.marketersPv, 'أخرى', 0, 'مسوق');

  // ── 5. إدارة المكتب ──
  const officeOrder = ['office_manager', 'product_manager', 'office_hr', 'office_employee'];
  for (const u of users.filter(isOffice).sort((a, b) => officeOrder.indexOf(a.role) - officeOrder.indexOf(b.role) || byName(a, b))) {
    put(u, SECTION.office, 'إدارة المكتب', 0);
  }

  for (const u of users) put(u, SECTION.other, 'أخرى', 0);
  return out;
}
