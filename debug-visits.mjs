import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const docs = await p.doctor.findMany({
  where: { id: { in: [4,5,6,7,8] } },
  select: { id:true, name:true, userId:true, area: { select:{ id:true, name:true } } }
});
console.log('DOCTORS:', JSON.stringify(docs, null, 2));

await p.$disconnect();
