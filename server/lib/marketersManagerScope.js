// ════════════════════════════════════════════════════════════════════════════
// marketersManagerScope.js — ما يراه «مدير المسوقين» في تقارير المندوبين (طلب 2026-11-04):
// مسوقوه فقط، وفي المحافظات المسنَدة له فقط. مدير مسوقي بغداد لا يرى تفاصيل المحافظات.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName } from './itemResolver.js';
import { userHasAllAreas } from './areaScope.js';
import { PHARMACY_KIND, marketersManagerCoverage } from './pharmacyRep.js';

/**
 * @param {number|null} userId
 * @returns {Promise<{baghdad:boolean, provinces:string[]}|null>} null = ليس مدير مسوقين، فلا تقييد.
 */
export async function loadMarketersManagerScope(userId) {
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true, linkedRepId: true,
      linkedRep: { select: { repKind: true } },
      provinceAssignments: { select: { province: { select: { name: true } } } },
      subProvinceAssignments: { select: { subProvince: { select: { province: { select: { name: true } } } } } },
    },
  });
  if (user?.role !== 'company_manager' || user.linkedRep?.repKind !== PHARMACY_KIND) return null;

  // راية «كل المناطق» تتجاهل التعيينات المحفوظة، كبقية نطاقات المناطق (areaScope.js).
  if (await userHasAllAreas(userId)) {
    const all = await prisma.province.findMany({ select: { name: true } });
    return marketersManagerCoverage({ assignedProvinces: all.map(p => p.name) });
  }

  const assignedProvinces = user.provinceAssignments.map(a => a.province.name);
  const assignedSideProvinces = user.subProvinceAssignments.map(a => a.subProvince.province.name);
  if (assignedProvinces.length || assignedSideProvinces.length) {
    return marketersManagerCoverage({ assignedProvinces, assignedSideProvinces });
  }

  // صفوف Area لكل حساب كثيراً ما تكون بلا محافظة، فالمطابقة بالاسم المطبَّع (كما في repLocation).
  const areaSelect = { area: { select: { name: true } } };
  const [userAreas, repAreas] = await Promise.all([
    prisma.userAreaAssignment.findMany({ where: { userId }, select: areaSelect }),
    user.linkedRepId
      ? prisma.scientificRepArea.findMany({ where: { scientificRepId: user.linkedRepId }, select: areaSelect })
      : [],
  ]);
  const names = new Set([...userAreas, ...repAreas].map(r => normalizeAreaName(r.area.name)));
  const areaCounts = new Map();
  if (names.size) {
    // استيراد متأخر: repLocation ← surveyDoctors ← scientific-reps.service ← هذا الملف (حلقة).
    const { provinceByAreaName } = await import('./repLocation.js');
    const index = await provinceByAreaName();
    for (const n of names) {
      const province = index.get(n)?.province;
      if (province) areaCounts.set(province, (areaCounts.get(province) || 0) + 1);
    }
  }
  return marketersManagerCoverage({ areaCounts });
}
