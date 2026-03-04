import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const badItem = await prisma.item.findFirst({ where: { name: 'تغيرت الكمية' } });
  if (!badItem) { console.log('Item not found'); process.exit(); }
  console.log('Bad item id:', badItem.id);
  
  const sales = await prisma.sale.findMany({
    where: { itemId: badItem.id },
    take: 3,
    select: { id: true, rawData: true }
  });
  
  sales.forEach(s => {
    if (s.rawData) {
      const raw = JSON.parse(s.rawData);
      console.log('\nColumns:', Object.keys(raw));
      console.log('Values:', JSON.stringify(raw, null, 2).substring(0, 1000));
    }
  });
} finally { await prisma.$disconnect(); }
