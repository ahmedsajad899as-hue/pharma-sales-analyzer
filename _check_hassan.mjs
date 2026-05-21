import prisma from './server/lib/prisma.js';

const users = await prisma.user.findMany({ 
  where: { OR: [{ displayName: { contains: 'حسن' } }, { username: { contains: 'hassan' } }, { username: { contains: 'hasan' } }] },
  select: { id: true, username: true, displayName: true, role: true, linkedRepId: true, isActive: true }
});
console.log('Users:', JSON.stringify(users, null, 2));

for (const u of users) {
  const repByLinked = u.linkedRepId
    ? await prisma.scientificRepresentative.findUnique({ where: { id: u.linkedRepId }, select: { id: true, name: true, userId: true } })
    : null;
  const repByUserId = await prisma.scientificRepresentative.findFirst({ where: { userId: u.id }, select: { id: true, name: true, userId: true } });
  console.log(`\n--- ${u.displayName || u.username} (id=${u.id}, role=${u.role}) ---`);
  console.log('Rep by linkedRepId:', repByLinked);
  console.log('Rep by userId:', repByUserId);

  const today = new Date();
  const dayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const dayStart = new Date(dayStr + 'T00:00:00+03:00');
  const dayEnd   = new Date(dayStr + 'T23:59:59+03:00');

  const visits = await prisma.doctorVisit.findMany({
    where: { visitDate: { gte: dayStart, lte: dayEnd } },
    where: { userId: u.id },
    orderBy: { visitDate: 'desc' },
    take: 5,
    select: { id: true, visitDate: true, userId: true, scientificRepId: true, doctor: { select: { name: true } } }
  });
  console.log('Recent visits by userId:', JSON.stringify(visits, null, 2));
}

await prisma.$disconnect();
