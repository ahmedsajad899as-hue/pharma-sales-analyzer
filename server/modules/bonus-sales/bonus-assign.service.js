/**
 * Bonus Assignment Service
 * Auto-assigns bonus sales rows to reps based on fuzzy area name matching.
 */

import prisma from '../../lib/prisma.js';

// ─── Arabic normalization ─────────────────────────────────────
function normArea(s) {
  if (!s) return '';
  return String(s)
    .trim()
    // Remove diacritics (tashkeel)
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670]/g, '')
    // Normalize alef variants → ا
    .replace(/[أإآٱ]/g, 'ا')
    // Normalize yaa variants
    .replace(/ى/g, 'ي')
    // Normalize taa marbuta
    .replace(/ة/g, 'ه')
    // Remove definite article ال at word start
    .replace(/\bال/g, '')
    .replace(/^ال/, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Returns true if areaA (from row) matches areaB (rep's assigned area)
function areaMatches(rowArea, repArea) {
  const a = normArea(rowArea);
  const b = normArea(repArea);
  if (!a || !b) return false;
  if (a === b) return true;

  // Check if one contains the other (handles "الشعب" vs "شعب")
  if (a.includes(b) || b.includes(a)) return true;

  // Word-overlap: all words of shorter present in longer
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (shorter.length === 0) return false;
  return shorter.every(w => longer.some(l => l.includes(w) || w.includes(l)));
}

// ─── Get all reps with their areas and linked user ids ────────
async function getAllRepsWithAreas(userId) {
  // Medical reps with areas
  const medReps = await prisma.medicalRepresentative.findMany({
    where: { userId, user: { isNot: null } },
    include: {
      areas: { include: { area: { select: { name: true } } } },
      user: { select: { id: true, displayName: true, username: true } },
    },
  });

  // Scientific reps with areas
  const sciReps = await prisma.scientificRepresentative.findMany({
    where: { userId, user: { isNot: null } },
    include: {
      areas: { include: { area: { select: { name: true } } } },
      user: { select: { id: true, displayName: true, username: true } },
    },
  });

  const result = [];

  for (const rep of medReps) {
    if (!rep.user) continue;
    result.push({
      userId: rep.user.id,
      name: rep.name,
      displayName: rep.user.displayName || rep.user.username || rep.name,
      areas: rep.areas.map(a => a.area.name),
      type: 'medical',
    });
  }

  for (const rep of sciReps) {
    if (!rep.user) continue;
    result.push({
      userId: rep.user.id,
      name: rep.name,
      displayName: rep.user.displayName || rep.user.username || rep.name,
      areas: rep.areas.map(a => a.area.name),
      type: 'scientific',
    });
  }

  return result;
}

// ─── Auto-assign an upload's rows to reps by area fuzzy match ─
export async function assignUploadToReps(uploadId, ownerUserId) {
  // Fetch all rows for this upload
  const rows = await prisma.bonusSalesRow.findMany({
    where: { uploadId: Number(uploadId) },
    select: { id: true, areaName: true, repName: true },
  });

  if (!rows.length) return { assigned: 0, unmatched: 0, totalReps: 0 };

  // Get all reps
  const reps = await getAllRepsWithAreas(ownerUserId);

  const assignments = [];
  let unmatched = 0;

  for (const row of rows) {
    const matches = [];

    for (const rep of reps) {
      // Check if row area matches any of rep's areas
      const areaMatch = rep.areas.length === 0
        ? false // No areas assigned = skip (don't assign everything)
        : rep.areas.some(repArea => areaMatches(row.areaName, repArea));

      if (areaMatch) {
        matches.push(rep.userId);
      }
    }

    if (matches.length === 0) {
      unmatched++;
    } else {
      for (const uid of matches) {
        assignments.push({ bonusRowId: row.id, userId: uid });
      }
    }
  }

  // Bulk upsert assignments (skip duplicates)
  if (assignments.length > 0) {
    await prisma.bonusRowAssignment.createMany({
      data: assignments,
      skipDuplicates: true,
    });
  }

  // Mark upload as assigned
  await prisma.bonusSalesUpload.update({
    where: { id: Number(uploadId) },
    data: { isAssigned: true },
  });

  return {
    assigned: assignments.length,
    unmatched,
    totalReps: reps.length,
  };
}

// ─── Assign all rows of a specific area to a specific rep user ─
export async function assignAreaToRep(uploadId, areaName, userId) {
  // Find rows matching this area (case-insensitive contains)
  const rows = await prisma.bonusSalesRow.findMany({
    where: {
      uploadId: Number(uploadId),
      areaName: { contains: areaName, mode: 'insensitive' },
    },
    select: { id: true },
  });

  if (!rows.length) return { assigned: 0 };

  await prisma.bonusRowAssignment.createMany({
    data: rows.map(r => ({ bonusRowId: r.id, userId: Number(userId) })),
    skipDuplicates: true,
  });

  // Mark upload as assigned if not already
  await prisma.bonusSalesUpload.update({
    where: { id: Number(uploadId) },
    data: { isAssigned: true },
  });

  return { assigned: rows.length };
}

// ─── Assign specific row ids to a rep user ────────────────────
export async function assignRowsToRep(rowIds, userId) {
  if (!rowIds.length) return { assigned: 0 };
  await prisma.bonusRowAssignment.createMany({
    data: rowIds.map(rid => ({ bonusRowId: Number(rid), userId: Number(userId) })),
    skipDuplicates: true,
  });
  return { assigned: rowIds.length };
}

// ─── Remove assignment for a single row + user ────────────────
export async function removeRowAssignment(rowId, userId) {
  await prisma.bonusRowAssignment.deleteMany({
    where: { bonusRowId: Number(rowId), userId: Number(userId) },
  });
}

// ─── Get all reps list for frontend (display name + userId) ───
export async function getRepsForAssignment(ownerUserId) {
  const reps = await getAllRepsWithAreas(ownerUserId);
  return reps.map(r => ({ userId: r.userId, name: r.displayName, areas: r.areas, type: r.type }));
}

// ─── Get distinct area names in an upload ─────────────────────
export async function getUploadAreas(uploadId) {
  const rows = await prisma.bonusSalesRow.findMany({
    where: { uploadId: Number(uploadId), areaName: { not: null } },
    select: { areaName: true },
    distinct: ['areaName'],
  });
  return rows.map(r => r.areaName).filter(Boolean).sort();
}
