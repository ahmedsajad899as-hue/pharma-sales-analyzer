// ════════════════════════════════════════════════════════════════════════════
// repLocation.js — أين يعمل المندوب: محافظته، وقسمه داخل بغداد (الكرخ/الرصافة).
//
// الترتيب: فريق المحافظة ← أكثرية تعييناته ومناطقه (marketerHomeProvinces) ← اسم الحساب
// كملاذ أخير («… / ليدر الكرخ»، «… - مسوقين - الديوانية»). منطقة واحدة خارج محافظته لا تنقله.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { BAGHDAD_PROVINCE, marketerHomeProvinces, repSideOf } from './pharmacyRep.js';
import { buildProvinceLookup, provinceFromText } from './provinces.js';

const GROUP_BY_SIDE = [[/كرخ/, 'karkh'], [/رصاف/, 'rusafa']];
const sideGroup = (side) => GROUP_BY_SIDE.find(([re]) => re.test(side ?? ''))?.[1] ?? null;

/**
 * قرار الموقع من البيانات المحمَّلة.
 * @param {object} r
 * @param {string[]} r.teamProvinces     محافظات فرقه (عضو أو قائد)
 * @param {string[]} r.assignedProvinces محافظات مسنَدة كاملةً
 * @param {{name:string, province:string, areaCount:number}[]} r.assignedSides أقسام مسنَدة كاملةً
 * @param {{province:string, side:string|null}[]} r.areas مناطقه المعيّنة بلا تكرار
 * @param {string} r.name اسم الحساب
 * @param {(text:string)=>string|null} r.provinceInText
 * @returns {{province:string|null, side:string|null, group:'karkh'|'rusafa'|'provinces'|'other'}}
 */
export function repLocationFrom({ teamProvinces = [], assignedProvinces = [], assignedSides = [], areas = [], name = '', provinceInText = () => null }) {
  let homes = [...new Set(teamProvinces)];
  if (!homes.length) {
    const counts = new Map();
    for (const a of areas) counts.set(a.province, (counts.get(a.province) || 0) + 1);
    // قسم مُسنَد كاملاً يساوي كل مناطقه، ولا يعدّ المحافظة كلها منطقة واحدة
    for (const s of assignedSides) counts.set(s.province, (counts.get(s.province) || 0) + Math.max(1, s.areaCount));
    homes = marketerHomeProvinces(assignedProvinces, counts);
  }

  const sideInName = GROUP_BY_SIDE.some(([re]) => re.test(name));
  if (!homes.length) {
    const named = sideInName ? BAGHDAD_PROVINCE : provinceInText(name);
    if (named) homes = [named];
  }
  if (!homes.length) return { province: null, side: null, group: 'other' };

  if (homes.includes(BAGHDAD_PROVINCE)) {
    let side = repSideOf(
      assignedSides.filter(s => s.province === BAGHDAD_PROVINCE).map(s => s.name),
      areas.filter(a => a.province === BAGHDAD_PROVINCE).map(a => a.side),
    );
    if (!side && sideInName) side = /كرخ/.test(name) ? 'الكرخ' : 'الرصافة';
    return { province: BAGHDAD_PROVINCE, side, group: sideGroup(side) ?? 'other' };
  }
  return { province: homes.slice(0, 2).join('، '), side: null, group: 'provinces' };
}

/**
 * المحافظة والقسم (الكرخ/الرصافة) لكل اسم منطقة مطبَّع — من أي صف Area بنفس
 * الاسم يحملهما (صفوف الحسابات الموازية كثيراً ما تكون بلا provinceId، والصف
 * القانوني يحملها). القسم يُفضَّل من أول صف يحمله حتى لو سبقه صف بمحافظة فقط.
 */
export async function provinceByAreaName() {
  const rows = await prisma.area.findMany({
    where:  { provinceId: { not: null } },
    select: {
      name: true,
      province:    { select: { name: true } },
      subProvince: { select: { name: true, sortOrder: true } },
    },
    orderBy: { id: 'asc' },
  });
  const map = new Map();
  for (const r of rows) {
    if (!r.province?.name) continue;
    const k = normalizeAreaName(r.name);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, {
        province: r.province.name,
        subProvince: r.subProvince?.name ?? null,
        subProvinceOrder: r.subProvince?.sortOrder ?? null,
      });
    } else if (!cur.subProvince && r.subProvince && r.province.name === cur.province) {
      cur.subProvince = r.subProvince.name;
      cur.subProvinceOrder = r.subProvince.sortOrder;
    }
  }
  return map;
}

/** مواقع عدة حسابات باستعلامات مجمَّعة. @returns {Promise<Map<number, ReturnType<typeof repLocationFrom>>>} */
export async function loadRepLocations(userIds) {
  const ids = [...new Set(userIds)];
  const out = new Map();
  if (!ids.length) return out;

  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, username: true, linkedRepId: true } });
  const repIds = users.map(u => u.linkedRepId).filter(Boolean);
  const areaSelect = { area: { select: { name: true } } };
  const [memberRows, leaderRows, provinceRows, sideRows, userAreas, repAreas, areaIndex, provinces] = await Promise.all([
    prisma.provinceRepAssignment.findMany({ where: { repUserId: { in: ids }, isActive: true, team: { isActive: true } }, select: { repUserId: true, team: { select: { province: { select: { name: true } } } } } }),
    prisma.provinceTeam.findMany({ where: { leaderUserId: { in: ids }, isActive: true }, select: { leaderUserId: true, province: { select: { name: true } } } }),
    prisma.userProvinceAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, province: { select: { name: true } } } }),
    prisma.userSubProvinceAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, subProvince: { select: { name: true, province: { select: { name: true } } } } } }),
    prisma.userAreaAssignment.findMany({ where: { userId: { in: ids } }, select: { userId: true, ...areaSelect } }),
    repIds.length ? prisma.scientificRepArea.findMany({ where: { scientificRepId: { in: repIds } }, select: { scientificRepId: true, ...areaSelect } }) : [],
    provinceByAreaName(),
    prisma.province.findMany({ select: { id: true, name: true, aliases: true } }),
  ]);

  const lookup = buildProvinceLookup(provinces);
  const provinceInText = (text) => provinceFromText(text, lookup)?.name ?? null;
  const areasPerSide = new Map();
  for (const v of areaIndex.values()) {
    if (!v.subProvince) continue;
    const k = `${v.province}|${v.subProvince}`;
    areasPerSide.set(k, (areasPerSide.get(k) || 0) + 1);
  }
  const groupBy = (rows, keyOf, valueOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(valueOf(r));
    }
    return m;
  };
  const teams = groupBy(memberRows, r => r.repUserId, r => r.team.province.name);
  for (const r of leaderRows) teams.set(r.leaderUserId, [...(teams.get(r.leaderUserId) ?? []), r.province.name]);
  const assignedProvinces = groupBy(provinceRows, r => r.userId, r => r.province.name);
  const assignedSides = groupBy(sideRows, r => r.userId, (r) => {
    const province = r.subProvince.province.name;
    return { name: r.subProvince.name, province, areaCount: areasPerSide.get(`${province}|${r.subProvince.name}`) || 0 };
  });
  const areaNames = groupBy(userAreas, r => r.userId, r => r.area.name);
  const repAreaNames = groupBy(repAreas, r => r.scientificRepId, r => r.area.name);

  for (const u of users) {
    const names = [...(areaNames.get(u.id) ?? []), ...(repAreaNames.get(u.linkedRepId) ?? [])];
    const areas = new Map();
    for (const n of names) {
      const k = normalizeAreaName(n);
      const hit = areaIndex.get(k);
      if (hit) areas.set(k, { province: hit.province, side: hit.subProvince });
    }
    out.set(u.id, repLocationFrom({
      teamProvinces: teams.get(u.id),
      assignedProvinces: assignedProvinces.get(u.id),
      assignedSides: assignedSides.get(u.id),
      areas: [...areas.values()],
      name: u.displayName || u.username,
      provinceInText,
    }));
  }
  return out;
}
