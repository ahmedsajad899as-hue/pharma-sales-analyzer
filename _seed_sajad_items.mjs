import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const items = [
  'AIRTIDE 100 mcg/50 mcg',
  'AIRTIDE 250 mcg/50 mcg',
  'AIRTIDE 500 mcg/50 mcg',
  'spiract',
  'Diclactive %1 Jel 50 g',
  'Mantazol 15g Cream',
  'PRELICA 75 mg',
  'PRELICA 150 mg',
  'Nospactive 40mg',
  'Pantactive 20 mg',
  'Pantactive 40 mg',
  'POTAFAST',
  'seffur im/iv',
  'teicoject im/iv',
  'difenject iv',
  'ibucold',
  'ziver',
  'Sanadcare 10',
  'Sanadcare 5',
  'Savimale 20/5',
  'savoxia 120',
  'savoxia 60',
  'savoxia 90',
  'lorius',
  'gastractive',
  'dextrocin',
  'Conviban tab',
  'Sycoetam 500mg tab',
  'Sycoetam Syr 120ml',
  'Uricodrop 120mg tab',
  'Uricodrop 40mg tab',
  'Uricodrop 80mg tab',
  'Tigecycline 50mg Vial',
];

async function main() {
  const sajad = await prisma.user.findUnique({ where: { username: 'sajad' } });
  if (!sajad) { console.error('❌ User sajad not found'); process.exit(1); }

  let created = 0, skipped = 0;
  for (const name of items) {
    const exists = await prisma.item.findFirst({ where: { name, userId: sajad.id } });
    if (exists) { skipped++; continue; }
    await prisma.item.create({ data: { name, userId: sajad.id } });
    created++;
  }
  console.log(`✅ Done — created: ${created}, skipped (existing): ${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
