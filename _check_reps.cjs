const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // All scientific reps
  const reps = await p.scientificRepresentative.findMany({
    include: { linkedUsers: { select: { id: true, username: true, role: true, companyAssignments: { select: { companyId: true } } } } },
  });
  console.log('=== Scientific Reps ===');
  console.log(JSON.stringify(reps, null, 2));

  // Ahmed user + his company assignments
  const ahmed = await p.user.findFirst({
    where: { username: 'ahmed' },
    include: { companyAssignments: { select: { companyId: true } } },
  });
  console.log('\n=== Ahmed User ===');
  console.log(JSON.stringify(ahmed, null, 2));

  // Sajad user
  const sajad = await p.user.findFirst({
    where: { username: 'sajad' },
    include: { companyAssignments: { select: { companyId: true } } },
  });
  console.log('\n=== Sajad User ===');
  console.log(JSON.stringify(sajad, null, 2));
}

main().then(() => p.$disconnect()).catch(e => { console.error(e); p.$disconnect(); });
