/**
 * _fix_survey_imports.mjs
 * One-time fix: doctors/pharmacies imported from survey by field reps
 * were saved under the rep's own userId instead of the manager's userId.
 * This script re-assigns them to the correct manager account.
 *
 * Usage: node _fix_survey_imports.mjs
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const FIELD_ROLES = new Set(['user', 'scientific_rep', 'supervisor', 'team_leader', 'commercial_rep']);

async function main() {
  // Get all field rep users who have a manager assignment
  const repUsers = await prisma.user.findMany({
    where: { role: { in: [...FIELD_ROLES] } },
    select: { id: true, username: true, displayName: true, role: true },
  });

  let totalFixed = 0;

  for (const rep of repUsers) {
    // Find this rep's manager
    const mgr = await prisma.userManagerAssignment.findFirst({
      where: { userId: rep.id },
      select: { managerId: true },
    });
    if (!mgr) continue;

    const managerId = mgr.managerId;

    // Find doctors saved under rep's own userId
    const repDoctors = await prisma.doctor.findMany({
      where: { userId: rep.id },
      select: { id: true, name: true, areaId: true },
    });
    if (repDoctors.length === 0) continue;

    console.log(`\n👤 ${rep.username} (${rep.role}) → manager ${managerId}: ${repDoctors.length} doctors to fix`);

    for (const doc of repDoctors) {
      // Check if same doctor already exists in manager's account
      const exists = await prisma.doctor.findFirst({
        where: { name: doc.name, userId: managerId },
      });
      if (exists) {
        // Delete the duplicate under rep's account
        await prisma.doctor.delete({ where: { id: doc.id } });
        console.log(`  🗑 Deleted duplicate: ${doc.name}`);
      } else {
        // Resolve area in manager's account (find matching area name-wise)
        let newAreaId = null;
        if (doc.areaId) {
          const oldArea = await prisma.area.findUnique({ where: { id: doc.areaId }, select: { name: true } });
          if (oldArea) {
            const norm = s => String(s || '').trim()
              .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
              .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ')
              .replace(/^(حي |محله |قضاء |ناحيه |ناحية )/, '')
              .toLowerCase().trim();
            const managerAreas = await prisma.area.findMany({
              where: { userId: managerId },
              select: { id: true, name: true },
            });
            const match = managerAreas.find(a => {
              const aN = norm(a.name); const bN = norm(oldArea.name);
              return aN === bN || aN.includes(bN) || bN.includes(aN);
            });
            if (match) {
              newAreaId = match.id;
            } else {
              // Create area in manager's account
              const created = await prisma.area.create({ data: { name: oldArea.name, userId: managerId } });
              newAreaId = created.id;
            }
          }
        }
        // Move doctor to manager's account
        await prisma.doctor.update({
          where: { id: doc.id },
          data: { userId: managerId, areaId: newAreaId },
        });
        console.log(`  ✅ Moved: ${doc.name} → manager ${managerId}, areaId: ${newAreaId}`);
        totalFixed++;
      }
    }
  }

  console.log(`\n✅ Done. Fixed ${totalFixed} doctors total.`);
}

main()
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
