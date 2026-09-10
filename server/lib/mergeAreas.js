import { normalizeAreaName } from './itemResolver.js';
import { invalidateAreaSnapshot } from './areaResolver.js';

/**
 * Area-merge utilities.
 *
 * Merging two Area rows means: pick one as the "canonical" survivor, reroute
 * EVERY foreign-key reference (sales, doctors, pharmacies, assignments, plans,
 * per-file area overrides) from the duplicate onto the canonical, then delete
 * the duplicate. No sales/visit data is ever lost — it is re-pointed.
 *
 * Used by:
 *  - /api/sa/areas/reset-from-survey   (full survey-driven reset)
 *  - /api/sa/areas/merge-duplicates    (deterministic: same name after Arabic normalisation)
 *  - /api/sa/areas/merge               (manual pair confirmed from a fuzzy suggestion)
 *  - /api/sa/areas/review-queue/:id/link (queue: "بانتظار المراجعة" منطقة رُبطت بموجودة)
 *
 * كل مسار من هذه يُسجّل اسم المنطقة الممتصّة في AreaAlias قبل حذفها (راجع
 * أسفله) — بدون هذا، نفس الاسم المختلف قليلاً (يتكرر غالباً من نفس الملف/
 * المندوب) كان يُنشئ منطقة مكررة جديدة في كل استيراد لاحق فيحتاج دمجاً يدوياً
 * مراراً؛ الآن يُتذكَّر القرار للأبد ويُربط تلقائياً من أول مرة (areaResolver.js).
 */

/**
 * Reroute all FK references from `oldId` to `canonicalId`, then delete the
 * duplicate area. Handles composite-unique tables by skipping rows that would
 * collide on the canonical id.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} oldId       – the duplicate area to absorb (will be deleted)
 * @param {number} canonicalId – the surviving area
 */
export async function mergeAreaInto(prisma, oldId, canonicalId) {
  if (oldId === canonicalId) return;

  // Area كتالوج مشترك الآن (مثل الايتمات/الشركات) — دمج صفين بنفس الاسم لحسابين
  // مختلفين آمن: UserAreaAssignment أدناه يُعيد ربط كل حساب كان معتمداً على
  // النسخة الممتصّة بالمنطقة الباقية، فلا يفقد أحد وصوله.
  const [oldOwner, canonicalOwner] = await Promise.all([
    prisma.area.findUnique({ where: { id: oldId },       select: { name: true, userId: true, provinceId: true } }),
    prisma.area.findUnique({ where: { id: canonicalId }, select: { userId: true, provinceId: true } }),
  ]);
  if (!oldOwner || !canonicalOwner) throw new Error('منطقة غير موجودة');

  // Simple FK tables — bulk reroute
  await prisma.doctor.updateMany({ where: { areaId: oldId }, data: { areaId: canonicalId } });
  await prisma.sale.updateMany({ where: { areaId: oldId }, data: { areaId: canonicalId } });
  await prisma.pharmacyVisit.updateMany({ where: { areaId: oldId }, data: { areaId: canonicalId } });
  await prisma.pharmacy.updateMany({ where: { areaId: oldId }, data: { areaId: canonicalId } });

  // PlanArea: composite unique [planId, areaId] — only move if canonical not already present
  const dupePlanAreas = await prisma.planArea.findMany({ where: { areaId: oldId }, select: { planId: true, id: true } });
  for (const pa of dupePlanAreas) {
    const exists = await prisma.planArea.findFirst({ where: { planId: pa.planId, areaId: canonicalId } });
    if (exists) await prisma.planArea.delete({ where: { id: pa.id } });
    else await prisma.planArea.update({ where: { id: pa.id }, data: { areaId: canonicalId } });
  }

  // ScientificRepArea: composite PK [scientificRepId, areaId]
  const dupeSciRepAreas = await prisma.scientificRepArea.findMany({ where: { areaId: oldId }, select: { scientificRepId: true } });
  for (const ra of dupeSciRepAreas) {
    const exists = await prisma.scientificRepArea.findFirst({ where: { scientificRepId: ra.scientificRepId, areaId: canonicalId } });
    if (!exists) await prisma.scientificRepArea.create({ data: { scientificRepId: ra.scientificRepId, areaId: canonicalId } });
    await prisma.scientificRepArea.delete({ where: { scientificRepId_areaId: { scientificRepId: ra.scientificRepId, areaId: oldId } } });
  }

  // RepresentativeArea: composite PK [representativeId, areaId]
  const dupeRepAreas = await prisma.representativeArea.findMany({ where: { areaId: oldId }, select: { representativeId: true } });
  for (const ra of dupeRepAreas) {
    const exists = await prisma.representativeArea.findFirst({ where: { representativeId: ra.representativeId, areaId: canonicalId } });
    if (!exists) await prisma.representativeArea.create({ data: { representativeId: ra.representativeId, areaId: canonicalId } });
    await prisma.representativeArea.delete({ where: { representativeId_areaId: { representativeId: ra.representativeId, areaId: oldId } } });
  }

  // UserAreaAssignment: composite PK [userId, areaId]
  const dupeUserAreas = await prisma.userAreaAssignment.findMany({ where: { areaId: oldId }, select: { userId: true } });
  for (const ua of dupeUserAreas) {
    const exists = await prisma.userAreaAssignment.findFirst({ where: { userId: ua.userId, areaId: canonicalId } });
    if (!exists) await prisma.userAreaAssignment.create({ data: { userId: ua.userId, areaId: canonicalId } });
    await prisma.userAreaAssignment.delete({ where: { userId_areaId: { userId: ua.userId, areaId: oldId } } });
  }

  // FileUserShare.customAreaIds: JSON array of area ids — rewrite any reference to oldId
  const sharesWithOverride = await prisma.fileUserShare.findMany({
    where: { customAreaIds: { not: null } },
    select: { fileId: true, userId: true, customAreaIds: true },
  });
  for (const share of sharesWithOverride) {
    let overrideIds;
    try { overrideIds = JSON.parse(share.customAreaIds); } catch { continue; }
    if (!Array.isArray(overrideIds) || !overrideIds.includes(oldId)) continue;
    const newIds = [...new Set(overrideIds.map(id => (id === oldId ? canonicalId : id)))];
    await prisma.fileUserShare.update({
      where: { fileId_userId: { fileId: share.fileId, userId: share.userId } },
      data: { customAreaIds: JSON.stringify(newIds) },
    });
  }

  // المحافظة: المنطقة الباقية تحتفظ بمحافظتها. إن كانت بلا محافظة ترث محافظة
  // المُمتصّة — وإلا ضاعت المعلومة بحذف الصف.
  if (canonicalOwner.provinceId == null && oldOwner.provinceId != null) {
    await prisma.area.update({
      where: { id: canonicalId },
      data:  { provinceId: oldOwner.provinceId },
    });
  }

  // تسجيل الذاكرة: اسم المنطقة المُمتصّة يُربط تلقائياً بالباقية من الآن
  // فصاعداً — يمنع نفس الاسم من إعادة إنشاء منطقة مكررة في استيراد لاحق.
  const fromKey = normalizeAreaName(oldOwner.name);
  await prisma.areaAlias.upsert({
    where:  { fromKey },
    update: { fromName: oldOwner.name, areaId: canonicalId, confidence: 'confirmed' },
    create: { fromKey, fromName: oldOwner.name, areaId: canonicalId, confidence: 'confirmed' },
  });
  // أي alias كان يشير سابقاً للمنطقة المُمتصّة (مثلاً من دمج متسلسل) يُعاد
  // توجيهه للباقية بدل أن يُحذف تعاقبياً (onDelete: Cascade) وتضيع ذاكرته.
  await prisma.areaAlias.updateMany({ where: { areaId: oldId }, data: { areaId: canonicalId } });

  // Finally remove the absorbed duplicate
  await prisma.area.delete({ where: { id: oldId } });
  // الدمج يحذف صفّ منطقة — أبطل لقطة المناطق كي لا يُرجع محرّك المطابقة
  // معرّفاً لمنطقة لم تعد موجودة لو تزامن الدمج مع رفع ملف جارٍ.
  invalidateAreaSnapshot();
}

/**
 * Group all areas by their Arabic-normalised name and merge every group that
 * has more than one row. The lowest id in each group is kept as canonical.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {(name: string) => string} normalize – Arabic normaliser (ة→ه, أإآ→ا, …)
 * @returns {Promise<{ mergedCount: number, groups: Array<{ canonicalId: number, name: string, absorbed: number }> }>}
 */
export async function mergeDuplicateAreasByName(prisma, normalize) {
  const allAreas = await prisma.area.findMany({
    select: { id: true, name: true, provinceId: true, userId: true }, orderBy: { id: 'asc' },
  });

  // التجميع بالاسم المطبَّع أولاً، ثم الفصل بالمحافظة داخل كل اسم: «المركز» في
  // بغداد و«المركز» في البصرة مكانان مختلفان ودمجهما يخلط مبيعاتهما بلا رجعة.
  // الحساب المالك لم يعد جزءاً من المفتاح — Area كتالوج مشترك الآن (مثل
  // الايتمات/الشركات)، فـ«ابو دشير» عند حساب أ و«ابو دشير» عند حساب ب نفس
  // المكان الحقيقي ويُدمَجان لصف واحد (راجع mergeAreaInto أعلاه).
  const byName = new Map(); // normalizedName → [{id,name,provinceId}, …] (id asc)
  for (const a of allAreas) {
    const key = normalize(a.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(a);
  }

  let mergedCount = 0;
  const groups = [];

  // يمتص كل الصفوف عدا الأول (الأقدم = الأدنى id) داخل مجموعة واحدة.
  const absorbGroup = async rows => {
    if (rows.length <= 1) return;
    const [canonical, ...dupes] = rows;
    for (const dupe of dupes) {
      await mergeAreaInto(prisma, dupe.id, canonical.id);
      mergedCount++;
    }
    groups.push({ canonicalId: canonical.id, name: canonical.name, absorbed: dupes.length });
  };

  for (const rows of byName.values()) {
    if (rows.length <= 1) continue;

    // صفوف بلا محافظة ليست «مكاناً ثالثاً» — هي نفس المنطقة لكن لم تُسنَد بعد.
    // ضمّ المحافظة للمفتاح كان يعزلها في مجموعة مستقلة فلا تُدمج أبداً مع
    // نظيرتها المُسنَدة، وهو سبب بقاء المكررات ظاهرة تحت «غير محدد» رغم
    // الضغط على «دمج المكررات» مراراً.
    const unassigned  = rows.filter(a => a.provinceId == null);
    const byProvince  = new Map();
    for (const a of rows) {
      if (a.provinceId == null) continue;
      if (!byProvince.has(a.provinceId)) byProvince.set(a.provinceId, []);
      byProvince.get(a.provinceId).push(a);
    }

    if (byProvince.size === 1 && unassigned.length > 0) {
      // محافظة واحدة فقط تحمل هذا الاسم → غير المُسنَدة تتبعها بلا لبس.
      const [assigned] = [...byProvince.values()];
      await absorbGroup([...assigned, ...unassigned].sort((a, b) => a.id - b.id));
      continue;
    }

    // إما بلا محافظة إطلاقاً، أو الاسم موزّع على محافظتين فأكثر (التباس حقيقي:
    // لا نُخمّن لأيّهما تتبع غير المُسنَدة). في الحالتين نكتفي بدمج المتطابقات
    // داخل كل محافظة، وغير المُسنَدة فيما بينها.
    for (const g of byProvince.values()) await absorbGroup(g);
    await absorbGroup(unassigned);
  }

  return { mergedCount, groups };
}
