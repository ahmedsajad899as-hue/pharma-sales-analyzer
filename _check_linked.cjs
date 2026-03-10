const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const users = await p.user.findMany({
    where: { username: { in: ['sajad', 'ahmed'] } },
    select: { id: true, username: true, role: true, linkedRepId: true }
  });
  console.log(JSON.stringify(users, null, 2));
  const reps = await p.scientificRepresentative.findMany({ select: { id: true, name: true, userId: true } });
  console.log('ScientificReps:', JSON.stringify(reps, null, 2));
}
main().finally(() => p.$disconnect());
