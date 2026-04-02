import prisma from '../../lib/prisma.js';

const select = {
  id: true, name: true, phone: true, email: true, company: true,
  isActive: true, notes: true, createdAt: true, updatedAt: true, userId: true,
};

export async function createScientificRep(data) {
  return prisma.scientificRepresentative.create({ data, select });
}

export async function findById(id) {
  return prisma.scientificRepresentative.findUnique({
    where: { id },
    select: {
      ...select,
      areas:          { select: { area:         { select: { id: true, name: true } } } },
      items:          { select: { item:         { select: { id: true, name: true } } } },
      companies:      { select: { company:      { select: { id: true, name: true } } } },
      commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
    },
  });
}

export async function listAll(filters = {}) {
  return prisma.scientificRepresentative.findMany({
    where: filters,
    select: {
      ...select,
      areas:          { select: { area:          { select: { id: true, name: true } } } },
      items:          { select: { item:          { select: { id: true, name: true } } } },
      companies:      { select: { company:       { select: { id: true, name: true } } } },
      commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
      _count: { select: { areas: true, items: true, companies: true, commercialReps: true } },
    },
    orderBy: { name: 'asc' },
  });
}

export async function updateScientificRep(id, data) {
  return prisma.scientificRepresentative.update({ where: { id }, data, select });
}

export async function deleteScientificRep(id) {
  // Delete related records without cascade first
  await prisma.doctorVisit.deleteMany({ where: { scientificRepId: id } });
  await prisma.monthlyPlan.deleteMany({ where: { scientificRepId: id } });
  return prisma.scientificRepresentative.delete({ where: { id } });
}

// ─── Assignments ─────────────────────────────────────────────

export async function setAreas(scientificRepId, areaIds) {
  return prisma.$transaction([
    prisma.scientificRepArea.deleteMany({ where: { scientificRepId } }),
    ...(areaIds.length ? [prisma.scientificRepArea.createMany({
      data: areaIds.map(areaId => ({ scientificRepId, areaId })),
    })] : []),
  ]);
}

export async function setItems(scientificRepId, itemIds) {
  return prisma.$transaction([
    prisma.scientificRepItem.deleteMany({ where: { scientificRepId } }),
    ...(itemIds.length ? [prisma.scientificRepItem.createMany({
      data: itemIds.map(itemId => ({ scientificRepId, itemId })),
    })] : []),
  ]);
}

export async function setCompanies(scientificRepId, companyIds) {
  return prisma.$transaction([
    prisma.scientificRepCompany.deleteMany({ where: { scientificRepId } }),
    ...(companyIds.length ? [prisma.scientificRepCompany.createMany({
      data: companyIds.map(companyId => ({ scientificRepId, companyId })),
    })] : []),
  ]);
}

export async function setCommercialReps(scientificRepId, commercialRepIds) {
  return prisma.$transaction([
    prisma.scientificRepCommercial.deleteMany({ where: { scientificRepId } }),
    ...(commercialRepIds.length ? [prisma.scientificRepCommercial.createMany({
      data: commercialRepIds.map(commercialRepId => ({ scientificRepId, commercialRepId })),
    })] : []),
  ]);
}
