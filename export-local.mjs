// Export all local data to JSON
import prisma from './server/lib/prisma.js';
import fs from 'fs';

async function main() {
  const [users, reps, doctors, items, areas, companies, customers, medReps, offices] = await Promise.all([
    prisma.user.findMany(),
    prisma.scientificRepresentative.findMany().catch(() => []),
    prisma.doctor.findMany().catch(() => []),
    prisma.item.findMany().catch(() => []),
    prisma.area.findMany().catch(() => []),
    prisma.company.findMany().catch(() => []),
    prisma.customer.findMany().catch(() => []),
    prisma.medicalRepresentative.findMany().catch(() => []),
    prisma.scientificOffice.findMany().catch(() => []),
  ]);

  const data = { users, reps, doctors, items, areas, companies, customers, medReps, offices };

  fs.writeFileSync('./local-export.json', JSON.stringify(data, null, 2));
  console.log('✅ Exported to local-export.json');
  console.table(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])));

  await prisma.$disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
