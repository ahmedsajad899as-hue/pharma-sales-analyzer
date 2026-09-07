// One-off backfill: re-sync UserCompanyAssignment for every existing
// office_manager/office_hr/office_employee user to ALL companies of their
// office (matches the new auto-assignment behaviour in server/lib/officeScope.js —
// these roles no longer pick companies manually, they always get every
// company belonging to their office).
import { PrismaClient } from '@prisma/client';

const OFFICE_SCOPED_ROLES = ['office_manager', 'office_hr', 'office_employee'];

const p = new PrismaClient();
try {
  const users = await p.user.findMany({
    where: { role: { in: OFFICE_SCOPED_ROLES } },
    select: { id: true, username: true, role: true, officeId: true },
  });
  console.log(`Found ${users.length} office-scoped user(s).`);

  for (const u of users) {
    const companies = u.officeId
      ? await p.scientificCompany.findMany({ where: { officeId: u.officeId }, select: { id: true } })
      : [];
    const ids = companies.map(c => c.id);

    const before = await p.userCompanyAssignment.count({ where: { userId: u.id } });

    await p.$transaction([
      p.userCompanyAssignment.deleteMany({ where: { userId: u.id } }),
      ...(ids.length ? [p.userCompanyAssignment.createMany({
        data: ids.map(companyId => ({ userId: u.id, companyId, isPrimary: true })),
        skipDuplicates: true,
      })] : []),
    ]);

    console.log(`  user #${u.id} ${u.username} (${u.role}, officeId=${u.officeId ?? 'null'}): ${before} -> ${ids.length} company assignment(s)`);
  }

  console.log('Done.');
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await p.$disconnect();
}
