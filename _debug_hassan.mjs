import { PrismaClient } from './node_modules/@prisma/client/default.js';
const prisma = new PrismaClient();

const users = await prisma.user.findMany({
  where: { OR: [{ username: { contains: 'hassan' } }, { displayName: { contains: 'حسن' } }, { username: { contains: 'hasan' } }, { displayName: { contains: 'Hassan' } }] },
  select: { id: true, username: true, displayName: true, role: true, linkedRepId: true }
});
console.log('Users found:', JSON.stringify(users, null, 2));

for (const user of users) {
  console.log(`\n--- User: ${user.displayName || user.username} (id=${user.id}, role=${user.role}) ---`);
  const rep = await prisma.scientificRepresentative.findFirst({ where: { userId: user.id }, select: { id: true, name: true } });
  console.log('Rep by userId:', JSON.stringify(rep));
  const repByLinked = user.linkedRepId
    ? await prisma.scientificRepresentative.findUnique({ where: { id: user.linkedRepId }, select: { id: true, name: true } })
    : null;
  console.log('Rep by linkedRepId:', JSON.stringify(repByLinked));

  // Today's visits
  const now = new Date();
  const dayStart = new Date(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T00:00:00+03:00`);
  const dayEnd   = new Date(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T23:59:59+03:00`);

  const visits = await prisma.doctorVisit.findMany({
    where: { visitDate: { gte: dayStart, lte: dayEnd }, userId: user.id },
    select: { id: true, visitDate: true, scientificRepId: true, doctor: { select: { name: true } } }
  });
  console.log('Today visits (by userId):', JSON.stringify(visits, null, 2));

  const allRecent = await prisma.doctorVisit.findMany({
    where: { userId: user.id },
    orderBy: { visitDate: 'desc' },
    take: 3,
    select: { id: true, visitDate: true, scientificRepId: true, doctor: { select: { name: true } } }
  });
  console.log('Last 3 visits:', JSON.stringify(allRecent, null, 2));
}

await prisma.$disconnect();
