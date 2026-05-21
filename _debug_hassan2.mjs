import prisma from './server/lib/prisma.js';

// 1. Find Hassan's user record
const users = await prisma.user.findMany({
  where: { OR: [
    { displayName: { contains: 'حسن', mode: 'insensitive' } },
    { username: { contains: 'hassan', mode: 'insensitive' } },
    { username: { contains: 'hasan', mode: 'insensitive' } },
  ]},
  select: { id: true, username: true, displayName: true, role: true, linkedRepId: true, isActive: true }
});
console.log('\n=== Hassan Users ===');
console.log(JSON.stringify(users, null, 2));

// 2. Find scientificRepresentative records for Hassan
for (const u of users) {
  const repByLinked = u.linkedRepId
    ? await prisma.scientificRepresentative.findUnique({ where: { id: u.linkedRepId }, select: { id: true, name: true, userId: true } })
    : null;
  const repByUserId = await prisma.scientificRepresentative.findFirst({ where: { userId: u.id }, select: { id: true, name: true, userId: true } });
  console.log(`\n--- ${u.displayName || u.username} (userId=${u.id}) ---`);
  console.log('ScientificRep by linkedRepId:', repByLinked);
  console.log('ScientificRep by userId:', repByUserId);

  // 3. Find all doctor visits by userId
  const visitsByUser = await prisma.doctorVisit.findMany({
    where: { userId: u.id },
    select: { id: true, visitDate: true, userId: true, scientificRepId: true, itemId: true, doctor: { select: { name: true } } },
    orderBy: { visitDate: 'desc' }, take: 10,
  });
  console.log(`\nVisits by userId=${u.id} (${visitsByUser.length} total):`);
  console.log(JSON.stringify(visitsByUser, null, 2));

  // 4. Find visits by scientificRepId
  const repId = u.linkedRepId || repByUserId?.id;
  if (repId) {
    const visitsByRep = await prisma.doctorVisit.findMany({
      where: { scientificRepId: repId },
      select: { id: true, visitDate: true, userId: true, scientificRepId: true, itemId: true, doctor: { select: { name: true } } },
      orderBy: { visitDate: 'desc' }, take: 10,
    });
    console.log(`\nVisits by scientificRepId=${repId} (${visitsByRep.length} total):`);
    console.log(JSON.stringify(visitsByRep, null, 2));
  }
}

// 5. Find the item "Pantactive 40"
const items = await prisma.item.findMany({
  where: { name: { contains: 'pantactive', mode: 'insensitive' } },
  select: { id: true, name: true, scientificName: true }
});
console.log('\n=== Pantactive Items ===');
console.log(JSON.stringify(items, null, 2));

// 6. Find all visits for the item, regardless of who created them
for (const item of items) {
  const visitsForItem = await prisma.doctorVisit.findMany({
    where: { itemId: item.id },
    select: { id: true, visitDate: true, userId: true, scientificRepId: true, itemId: true, doctor: { select: { name: true } } },
    orderBy: { visitDate: 'desc' }, take: 20,
  });
  console.log(`\n=== Visits for ${item.name} (itemId=${item.id}): ${visitsForItem.length} ===`);
  console.log(JSON.stringify(visitsForItem, null, 2));
}

await prisma.$disconnect();
