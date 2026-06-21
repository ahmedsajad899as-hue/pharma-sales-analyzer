/**
 * One-time cleanup: remove commercial reps wrongly auto-assigned to scientific reps.
 *
 * A commercial rep is removed from a scientific rep ONLY when:
 *   - the sci-rep HAS assigned areas, AND
 *   - the commercial rep HAS area records, AND
 *   - NONE of the commercial rep's areas match (normalised) any of the sci-rep's
 *     assigned areas.
 *
 * Conservative by design: sci-reps with no areas, and commercial reps with no
 * area data, are left untouched (can't prove they're wrong).
 *
 * Usage:
 *   node scripts/cleanup-scirep-commercials.mjs            # DRY RUN (prints only)
 *   node scripts/cleanup-scirep-commercials.mjs --apply    # actually deletes
 */
import prisma from '../server/lib/prisma.js';

const APPLY = process.argv.includes('--apply');

// Lenient Arabic normaliser: unify alef/teh-marbuta/alef-maqsura, drop tatweel +
// diacritics, strip «ال» and a leading «حي/محلة/قضاء/ناحية» prefix. Generous on
// purpose so only clearly-unrelated reps are flagged.
const norm = s => String(s || '').trim()
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .replace(/ـ/g, '')
  .replace(/[ً-ٟ]/g, '')
  .replace(/(^|\s)ال/g, '$1')
  .replace(/^(حي |محله |محلة |قضاء |ناحيه |ناحية )/, '')
  .replace(/\s+/g, ' ')
  .trim();

const DEBUG_I = process.argv.indexOf('--debug');
const DEBUG_NAME = DEBUG_I >= 0 ? process.argv[DEBUG_I + 1] : null;

async function debugRep(nameSub) {
  const reps = await prisma.scientificRepresentative.findMany({
    where: { name: { contains: nameSub } },
    select: {
      id: true, name: true,
      areas: { select: { area: { select: { name: true } } } },
      commercialReps: { select: { commercialRep: { select: { name: true, areas: { select: { area: { select: { name: true } } } } } } } },
    },
  });
  for (const r of reps) {
    const assigned = r.areas.map(a => a.area?.name).filter(Boolean);
    const assignedNorms = new Set(assigned.map(norm));
    console.log(`\n=== ${r.name} (id ${r.id}) ===`);
    console.log(`assigned areas: ${assigned.join(' | ')}`);
    console.log(`assigned norms: ${[...assignedNorms].join(' | ')}`);
    for (const link of r.commercialReps) {
      const cr = link.commercialRep; if (!cr) continue;
      const crAreas = cr.areas.map(a => a.area?.name).filter(Boolean);
      const crNorms = crAreas.map(norm);
      const overlap = crNorms.filter(n => assignedNorms.has(n));
      console.log(`  • ${cr.name}: areas=[${crAreas.join(', ')}] | overlap=[${overlap.join(', ')}] ${overlap.length ? '' : '  <-- NO OVERLAP'}`);
    }
  }
}

async function main() {
  if (DEBUG_NAME) { await debugRep(DEBUG_NAME); return; }
  const reps = await prisma.scientificRepresentative.findMany({
    select: {
      id: true, name: true,
      areas:       { select: { area: { select: { name: true } } } },
      commercialReps: {
        select: {
          commercialRepId: true,
          commercialRep: {
            select: { id: true, name: true, areas: { select: { area: { select: { name: true } } } } },
          },
        },
      },
    },
  });

  const toRemove = []; // { scientificRepId, commercialRepId, repName, crName }
  let repsScanned = 0, repsSkippedNoAreas = 0, crKeptNoAreas = 0, crKept = 0;

  for (const r of reps) {
    const assignedNorms = new Set(r.areas.map(a => norm(a.area?.name)).filter(Boolean));
    if (assignedNorms.size === 0) { repsSkippedNoAreas++; continue; }
    repsScanned++;
    for (const link of r.commercialReps) {
      const cr = link.commercialRep;
      if (!cr) continue;
      const crNorms = cr.areas.map(a => norm(a.area?.name)).filter(Boolean);
      if (crNorms.length === 0) { crKeptNoAreas++; continue; } // can't prove wrong → keep
      const overlaps = crNorms.some(n => assignedNorms.has(n));
      if (overlaps) { crKept++; continue; }
      toRemove.push({ scientificRepId: r.id, commercialRepId: cr.id, repName: r.name, crName: cr.name });
    }
  }

  console.log(`\nScientific reps scanned (with areas): ${repsScanned}`);
  console.log(`Skipped (no assigned areas): ${repsSkippedNoAreas}`);
  console.log(`Commercial links kept (overlap): ${crKept} | kept (no area data): ${crKeptNoAreas}`);
  console.log(`Commercial links to REMOVE (no area overlap): ${toRemove.length}\n`);

  // Group printout by sci-rep
  const byRep = new Map();
  for (const x of toRemove) {
    if (!byRep.has(x.repName)) byRep.set(x.repName, []);
    byRep.get(x.repName).push(x.crName);
  }
  for (const [repName, crs] of byRep) {
    console.log(`  ${repName}: ${crs.join(', ')}`);
  }

  if (!APPLY) {
    console.log('\n[DRY RUN] nothing deleted. Re-run with --apply to delete the above.');
    return;
  }

  let deleted = 0;
  for (const x of toRemove) {
    await prisma.scientificRepCommercial.delete({
      where: { scientificRepId_commercialRepId: { scientificRepId: x.scientificRepId, commercialRepId: x.commercialRepId } },
    });
    deleted++;
  }
  console.log(`\n[APPLIED] deleted ${deleted} wrong commercial-rep links.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
