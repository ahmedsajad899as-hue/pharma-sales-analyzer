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

  // Finally remove the absorbed duplicate
  await prisma.area.delete({ where: { id: oldId } });
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
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });

  const byKey = new Map(); // normalizedName → [{id,name}, …] (id asc)
  for (const a of allAreas) {
    const key = normalize(a.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  let mergedCount = 0;
  const groups = [];
  for (const [, rows] of byKey) {
    if (rows.length <= 1) continue;
    const [canonical, ...dupes] = rows; // lowest id = canonical survivor
    for (const dupe of dupes) {
      await mergeAreaInto(prisma, dupe.id, canonical.id);
      mergedCount++;
    }
    groups.push({ canonicalId: canonical.id, name: canonical.name, absorbed: dupes.length });
  }

  return { mergedCount, groups };
}
