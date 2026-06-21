import { syncCommercialsByActiveFiles } from '../server/modules/scientific-reps/scientific-reps.service.js';
import prisma from '../server/lib/prisma.js';

const fileIds = process.argv.slice(2).map(Number).filter(Boolean);

async function main() {
  console.log('running sync for fileIds:', fileIds);
  const res = await syncCommercialsByActiveFiles(fileIds);
  console.log('result:', res);

  const rep = await prisma.scientificRepresentative.findFirst({
    where: { name: { contains: 'ابراهيم' } },
    select: { name: true, commercialReps: { select: { commercialRep: { select: { name: true } } } } },
  });
  console.log(`\n${rep?.name} commercial reps now:`, rep?.commercialReps.map(l => l.commercialRep?.name).join(', ') || '(none)');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
