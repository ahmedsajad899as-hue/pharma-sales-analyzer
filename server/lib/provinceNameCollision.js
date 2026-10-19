// ════════════════════════════════════════════════════════════════════════════
// provinceNameCollision.js — منطقة تحمل اسم محافظة وتتطابق مع حيّ في محافظة أخرى.
// ────────────────────────────────────────────────────────────────────────────
// المثال الحقيقي: محافظة «القادسية» (الديوانية) وحيّ «القادسية» في بغداد/الكرخ.
// ملفات المحافظات تكتب أحياناً اسم المحافظة نفسه في عمود المنطقة، فيُنشأ صفّ Area
// باسم «القادسية» تحت محافظة القادسية — وتطبيعه («قادسيه») مطابق حرفياً لحيّ
// الكرخ. وكل ربط بالاسم في النظام (السيرفي، أرشيف الأطباء، الصيدليات، الخطط —
// راجع buildAreaNameIndex) يعتمد المفتاح المطبَّع، فمندوب المحافظة يرى أطباء
// وصيدليات حيّ الكرخ والعكس.
//
// القاعدة: الاسم الواحد = منطقة واحدة. الحيّ يحتفظ بالاسم المجرّد، وصفّ المحافظة
// يُدمج في «منطقة المركز» (أول اسم بديل للمحافظة: الديوانية) لأن اسم المحافظة
// في عمود المنطقة يعني فعلياً مركزها لا حيّاً بعينه.
// ════════════════════════════════════════════════════════════════════════════

import { normalizeAreaName } from './itemResolver.js';
import { buildProvinceLookup, extractRawColumnValue, matchProvinceName, PROVINCE_COLUMN_ALIASES } from './provinces.js';

function provinceAliases(p) {
  try { return JSON.parse(p.aliases || '[]'); } catch { return []; }
}

/** مفاتيح «اسم المحافظة نفسه» — الاسم الرسمي وكل بدائله، مطبَّعة. */
export function provinceNameKeys(p) {
  return new Set([p.name, ...provinceAliases(p)].map(normalizeAreaName).filter(Boolean));
}

/**
 * منطقة المركز داخل المحافظة: صف Area في المحافظة نفسها اسمه أحد بدائلها (الديوانية)
 * ولا يشاركه أي صف في محافظة أخرى. يُنشأ عند الحاجة باسم أول بديل غير متصادم.
 * null إن لم يكن للمحافظة اسم بديل صالح (بغداد/كركوك/كربلاء…) — لا مركز نخترعه.
 */
export async function findOrCreateProvinceCenter(prisma, province, allAreas) {
  const keysElsewhere = new Set(
    allAreas.filter(a => a.provinceId !== province.id).map(a => normalizeAreaName(a.name)),
  );
  const officialKey = normalizeAreaName(province.name);
  const candidates = provinceAliases(province)
    .map(n => ({ name: n, key: normalizeAreaName(n) }))
    .filter(c => c.key && c.key !== officialKey && !keysElsewhere.has(c.key));
  if (candidates.length === 0) return null;

  const wanted = new Set(candidates.map(c => c.key));
  const existing = allAreas.find(a => a.provinceId === province.id && wanted.has(normalizeAreaName(a.name)));
  if (existing) return existing;

  // لا يوجد بعد — صفّ بالاسم البديل بلا محافظة (من ملف قديم) يُتبنّى بدل التكرار
  const orphan = allAreas.find(a => a.provinceId == null && wanted.has(normalizeAreaName(a.name)));
  if (orphan) {
    return prisma.area.update({
      where: { id: orphan.id }, data: { provinceId: province.id },
      select: { id: true, name: true, provinceId: true, needsReview: true },
    });
  }
  return prisma.area.create({
    data: { name: candidates[0].name, provinceId: province.id, userId: null, needsReview: false },
    select: { id: true, name: true, provinceId: true, needsReview: true },
  });
}

/**
 * إصلاح البيانات القائمة — idempotent، يُستدعى عند الإقلاع.
 * لكل صفّ Area باسم محافظته نفسها يشاركه في الاسم المطبَّع صفٌّ بمحافظة أخرى:
 *   1) صفوف المبيعات التي يُثبت عمود المحافظة الخام فيها انتماءها للمحافظة الأخرى
 *      تُعاد لحيّها الصحيح هناك (نفس أسلوب split-conflict).
 *   2) الباقي كله يُدمج في منطقة المركز (الديوانية) — بلا alias، لأن alias بمفتاح
 *      «قادسيه» يعيد ربط أطباء الحيّ البغدادي بمندوب المحافظة.
 */
export async function fixProvinceNamedAreaCollisions(prisma, mergeAreaInto) {
  const provinces = await prisma.province.findMany();
  const lookup = buildProvinceLookup(provinces);
  const result = [];

  for (const p of provinces) {
    const allAreas = await prisma.area.findMany({ select: { id: true, name: true, provinceId: true, needsReview: true } });
    const ownKeys = provinceNameKeys(p);
    const collided = allAreas.filter(a => {
      if (a.provinceId !== p.id) return false;
      const k = normalizeAreaName(a.name);
      return ownKeys.has(k) && allAreas.some(o => o.id !== a.id && o.provinceId !== p.id && normalizeAreaName(o.name) === k);
    });
    if (collided.length === 0) continue;

    const center = await findOrCreateProvinceCenter(prisma, p, allAreas);
    if (!center) continue;

    for (const a of collided) {
      const key = normalizeAreaName(a.name);
      const twinByProvince = new Map(
        allAreas.filter(o => o.provinceId && o.provinceId !== p.id && normalizeAreaName(o.name) === key)
          .map(o => [o.provinceId, o.id]),
      );
      const sales = await prisma.sale.findMany({ where: { areaId: a.id, rawData: { not: null } }, select: { id: true, rawData: true } });
      const backToTwin = new Map(); // areaId -> saleIds
      for (const s of sales) {
        let raw; try { raw = JSON.parse(s.rawData); } catch { continue; }
        if (!raw || typeof raw !== 'object') continue;
        const prov = matchProvinceName(extractRawColumnValue(raw, PROVINCE_COLUMN_ALIASES), lookup);
        const twinId = prov ? twinByProvince.get(prov.id) : null;
        if (!twinId) continue;
        if (!backToTwin.has(twinId)) backToTwin.set(twinId, []);
        backToTwin.get(twinId).push(s.id);
      }
      let returned = 0;
      for (const [twinId, ids] of backToTwin) {
        await prisma.sale.updateMany({ where: { id: { in: ids } }, data: { areaId: twinId } });
        returned += ids.length;
      }
      await mergeAreaInto(prisma, a.id, center.id, { skipAlias: true });
      // alias قديم بمفتاح الاسم المتصادم يشير للمحافظة — يُسقط ليعود الاسم لحيّه
      await prisma.areaAlias.deleteMany({ where: { fromKey: key, areaId: center.id } });
      result.push({ from: a.name, into: center.name, province: p.name, returnedSales: returned });
    }
  }
  return result;
}
