/**
 * merge-duplicate-areas.mjs — تحليل/دمج صفوف Area المكررة التي تمثّل نفس المكان.
 *
 * الخلفية: جدول Area فيه صفوف كثيرة لنفس المكان («حي الجامعه»، «حي جامعه»،
 * «جامعه»...) فتظهر شرائح مكررة في شاشة تعيين مناطق المندوب.
 *
 * ⚠️ قيد أمان جوهري — الدمج داخل نفس الحساب فقط:
 * Area مملوكة لحساب (`@@unique([name, userId])`) و~15 موضعاً يستعلم
 * `area.findMany({ where: { userId } })`. لو دمجنا صف حساب أ مع صف حساب ب في
 * صف واحد مالكه أ، فإن استعلامات ب لن تُرجع المنطقة أبداً — أي «اختفاء
 * مناطق» وهو بالضبط عطل «إخفاء الأطباء بين المدير والمندوب» المعروف سابقاً.
 * لذلك المفتاح = (normalizeAreaName, userId)، والمجموعات العابرة للحسابات
 * تُعرض للعلم فقط ولا تُلمس.
 *
 * قيد ثانٍ: لا نلمس مجموعة فيها محافظتان مختلفتان (provinceId متعارض) —
 * قد تكون أماكن مختلفة فعلاً بنفس الاسم.
 *
 * الاستعمال:
 *   node scripts/merge-duplicate-areas.mjs           # تحليل فقط
 *   node scripts/merge-duplicate-areas.mjs --apply   # تنفيذ الدمج
 */

import prisma from '../server/lib/prisma.js';
import { normalizeAreaName } from '../server/lib/itemResolver.js';

const APPLY = process.argv.includes('--apply');

// جداول تُشير إلى areaId بمفتاح بسيط — تحديث مباشر
const SIMPLE_REFS = [
  ['sale',            'Sale'],
  ['doctor',          'Doctor'],
  ['pharmacy',        'Pharmacy'],
  ['pharmacyVisit',   'PharmacyVisit'],
  ['dailyPlanEntry',  'DailyPlanEntry'],
  ['invoiceSheet',    'InvoiceSheet'],
];

// جداول مفتاحها مركّب يتضمن areaId — الدمج قد يُنتج تصادماً فنحذف الخاسر
const COMPOSITE_REFS = [
  ['representativeArea', 'representativeId', 'RepresentativeArea'],
  ['scientificRepArea',  'scientificRepId',  'ScientificRepArea'],
  ['userAreaAssignment', 'userId',           'UserAreaAssignment'],
  ['planArea',           'planId',           'PlanArea'],
];

async function refCounts(areaId) {
  const simple = await Promise.all(SIMPLE_REFS.map(([m]) => prisma[m].count({ where: { areaId } })));
  const comp   = await Promise.all(COMPOSITE_REFS.map(([m]) => prisma[m].count({ where: { areaId } })));
  const total  = [...simple, ...comp].reduce((a, b) => a + b, 0);
  return { total, sale: simple[0] };
}

async function main() {
  const areas = await prisma.area.findMany({
    select: { id: true, name: true, userId: true, officeId: true, provinceId: true, subProvinceId: true },
    orderBy: { id: 'asc' },
  });

  // المفتاح: الاسم المطبَّع + الحساب المالك
  const groups = new Map();
  for (const a of areas) {
    const k = `${a.userId ?? 'null'}::${normalizeAreaName(a.name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }

  // للعلم فقط: أماكن مكررة عبر حسابات مختلفة (لا تُلمس)
  const byNameOnly = new Map();
  for (const a of areas) {
    const k = normalizeAreaName(a.name);
    if (!byNameOnly.has(k)) byNameOnly.set(k, new Set());
    byNameOnly.get(k).add(a.userId ?? 'null');
  }
  const crossAccount = [...byNameOnly.values()].filter(s => s.size > 1).length;

  const dupGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);

  console.log(`جدول Area: ${areas.length} صف`);
  console.log(`مجموعات مكررة داخل نفس الحساب (قابلة للدمج): ${dupGroups.length}`);
  console.log(`أماكن موزّعة على أكثر من حساب (لن تُلمس — تُخفي مناطق لو دُمجت): ${crossAccount}`);
  console.log(`الوضع: ${APPLY ? '⚠️ تنفيذ فعلي' : 'تحليل فقط (dry-run)'}\n`);

  let merged = 0, deletedRows = 0, skippedProvince = 0;

  for (const [key, rows] of dupGroups) {
    const provinces = [...new Set(rows.map(r => r.provinceId).filter(Boolean))];
    if (provinces.length > 1) {
      console.log(`⏭️  «${key.split('::')[1]}» — محافظات متعارضة (${provinces.join(', ')}) — متروكة للمراجعة اليدوية`);
      skippedProvince++;
      continue;
    }

    // إحصاء المراجع لكل صف لاختيار الصف القانوني
    const withCounts = [];
    for (const r of rows) withCounts.push({ ...r, ...(await refCounts(r.id)) });

    // الأفضلية: الأكثر مراجع ← ثم من له محافظة ← ثم الأقدم (أصغر id)
    withCounts.sort((a, b) =>
      (b.total - a.total) ||
      ((b.provinceId ? 1 : 0) - (a.provinceId ? 1 : 0)) ||
      (a.id - b.id));

    const [canonical, ...losers] = withCounts;
    const desc = withCounts.map(r => `${r.id}:«${r.name}»(${r.total})`).join(' + ');
    console.log(`🔗 ${desc}  →  يبقى ${canonical.id} «${canonical.name}»`);

    if (!APPLY) { merged++; deletedRows += losers.length; continue; }

    for (const L of losers) {
      // 1) الجداول البسيطة: إعادة توجيه مباشرة
      for (const [model] of SIMPLE_REFS) {
        await prisma[model].updateMany({ where: { areaId: L.id }, data: { areaId: canonical.id } });
      }

      // 2) الجداول المركّبة: احذف ما سيتصادم ثم أعد توجيه الباقي
      for (const [model, otherKey] of COMPOSITE_REFS) {
        const lossRows = await prisma[model].findMany({ where: { areaId: L.id }, select: { [otherKey]: true } });
        if (lossRows.length === 0) continue;
        const otherIds = lossRows.map(r => r[otherKey]);
        const existing = await prisma[model].findMany({
          where:  { areaId: canonical.id, [otherKey]: { in: otherIds } },
          select: { [otherKey]: true },
        });
        const clash = new Set(existing.map(r => r[otherKey]));
        if (clash.size) {
          await prisma[model].deleteMany({ where: { areaId: L.id, [otherKey]: { in: [...clash] } } });
        }
        await prisma[model].updateMany({ where: { areaId: L.id }, data: { areaId: canonical.id } });
      }

      // 3) لا نفقد المحافظة/القسم إن كان الخاسر يحملها والقانوني لا
      const patch = {};
      if (!canonical.provinceId && L.provinceId)       patch.provinceId    = L.provinceId;
      if (!canonical.subProvinceId && L.subProvinceId) patch.subProvinceId = L.subProvinceId;
      if (!canonical.officeId && L.officeId)           patch.officeId      = L.officeId;
      if (Object.keys(patch).length) {
        await prisma.area.update({ where: { id: canonical.id }, data: patch });
        Object.assign(canonical, patch);
      }

      await prisma.area.delete({ where: { id: L.id } });
      deletedRows++;
    }
    merged++;
  }

  console.log(`\n── الخلاصة ──`);
  console.log(`مجموعات ${APPLY ? 'دُمجت' : 'ستُدمج'}      : ${merged}`);
  console.log(`صفوف ${APPLY ? 'حُذفت' : 'ستُحذف'}         : ${deletedRows}`);
  console.log(`متروكة (محافظات متعارضة) : ${skippedProvince}`);
  console.log(`متروكة (حسابات مختلفة)   : ${crossAccount} مكان`);
  if (!APPLY) console.log(`\nلم يُكتب شيء. أعد التشغيل مع --apply للتنفيذ.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
