import prisma from '../server/lib/prisma.js';

const norm = s => String(s || '').trim()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/ـ/g, '').replace(/[ً-ٟ]/g, '')
  .replace(/(^|\s)ال/g, '$1').replace(/\s+/g, ' ').trim();

const NAME = process.argv[2] || 'ابراهيم';

async function main() {
  const files = await prisma.uploadedFile.findMany({
    select: { id: true, originalName: true, uploadedAt: true },
    orderBy: { uploadedAt: 'desc' }, take: 8,
  });
  console.log('\n=== recent files ===');
  for (const f of files) console.log(`  #${f.id}  ${f.originalName}  (${f.uploadedAt?.toISOString?.()?.slice(0,10)})`);

  const rep = await prisma.scientificRepresentative.findFirst({
    where: { name: { contains: NAME } },
    select: {
      id: true, name: true,
      areas: { select: { area: { select: { name: true } } } },
      commercialReps: { select: { commercialRep: { select: { id: true, name: true } } } },
    },
  });
  if (!rep) { console.log(`no sci-rep matching "${NAME}"`); return; }

  const assignedNorms = new Set(rep.areas.map(a => norm(a.area?.name)).filter(Boolean));
  console.log(`\n=== ${rep.name} (id ${rep.id}) ===`);
  console.log('assigned area norms:', [...assignedNorms].join(' | '));
  console.log('CURRENT saved commercial reps:', rep.commercialReps.map(l => l.commercialRep?.name).join(', ') || '(none)');

  // norm area name -> ids
  const allAreas = await prisma.area.findMany({ select: { id: true, name: true } });
  const normToAreaIds = new Map();
  for (const a of allAreas) { const k = norm(a.name); if (!k) continue; (normToAreaIds.get(k) || normToAreaIds.set(k, []).get(k)).push(a.id); }
  const repAreaIds = [...assignedNorms].flatMap(n => normToAreaIds.get(n) || []);

  for (const f of files) {
    const pairs = await prisma.sale.findMany({
      where: { uploadedFileId: f.id, areaId: { in: repAreaIds } },
      select: { representative: { select: { name: true } }, recordType: true },
      distinct: ['representativeId'],
    });
    if (pairs.length === 0) continue;
    console.log(`\n  file #${f.id}: reps with sale/return in ${rep.name}'s areas -> ${pairs.map(p => p.representative?.name).join(', ')}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
