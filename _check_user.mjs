import prisma from './server/lib/prisma.js';
const users = await prisma.user.findMany({ 
  where: { username: { contains: 'ارشد' } },
  select: { id: true, username: true, role: true, isActive: true, linkedRepId: true, displayName: true }
});
console.log('found:', users.length);
console.log(JSON.stringify(users, null, 2));
if (users.length === 0) {
  // show all users
  const all = await prisma.user.findMany({ select: { id: true, username: true, role: true, isActive: true } });
  console.log('ALL USERS:', JSON.stringify(all, null, 2));
}
await prisma.$disconnect();
