const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const plans = await p.monthlyPlan.findMany({
    select: { id: true, month: true, year: true, scientificRepId: true, assignedUserId: true, status: true },
    orderBy: { id: 'desc' },
    take: 5
  });
  console.log('Plans:', JSON.stringify(plans, null, 2));
}
main().finally(() => p.$disconnect());
