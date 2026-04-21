import prisma from './server/lib/prisma.js';

// Get all files ordered by id desc
const files = await prisma.uploadedFile.findMany({ orderBy: { id: 'desc' }, take: 5, select: { id: true, filename: true } });
console.log('Recent files:', JSON.stringify(files, null, 2));

for (const f of files) {
  const count = await prisma.sale.count({ where: { uploadedFileId: f.id, recordType: 'sale' } });
  const total = await prisma.sale.aggregate({ where: { uploadedFileId: f.id, recordType: 'sale' }, _sum: { quantity: true } });
  console.log(`File ${f.id} (${f.filename}): ${count} rows, qty=${total._sum.quantity}`);
}

// Also check for null uploadedFileId
const nullCount = await prisma.sale.count({ where: { uploadedFileId: null, recordType: 'sale' } });
const nullTotal = await prisma.sale.aggregate({ where: { uploadedFileId: null, recordType: 'sale' }, _sum: { quantity: true } });
console.log(`File NULL: ${nullCount} rows, qty=${nullTotal._sum.quantity}`);

await prisma.$disconnect();
