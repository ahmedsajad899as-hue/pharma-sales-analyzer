// ============================================================
// Seed local data to Railway PostgreSQL
// Run: node prisma/seed-local-data.js
// ============================================================
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetSeq(table) {
  try {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  } catch (e) {
    // SQLite doesn't have sequences – ignore
  }
}

async function main() {
  console.log('🌱 Seeding local data to database...\n');

  // ── 1. Scientific Office ───────────────────────────────────
  const office = await prisma.scientificOffice.upsert({
    where: { name: 'مكتب النسق العلمي' },
    update: { phone: '', address: 'المنصور', isActive: true, notes: '' },
    create: { id: 1, name: 'مكتب النسق العلمي', phone: '', address: 'المنصور', isActive: true, notes: '' },
  });
  console.log(`✅ Office: ${office.name} (id=${office.id})`);
  await resetSeq('scientific_offices');

  // ── 2. Users ──────────────────────────────────────────────
  const usersData = [
    { username: 'admin',  passwordHash: '$2b$10$fU9poEfYtntLkwPECAMtPO3TigD8apgCIddC6tLHq4zEqzQ2vK33e', role: 'admin',           isActive: true, officeId: null },
    { username: 'ahmed',  passwordHash: '$2b$12$RZSL3fZMIL6wWSfCdOOM/OjUH..KKPbK2QiZJPqPVdPfKCsz1fATa', role: 'company_manager', isActive: true, officeId: office.id },
    { username: 'sajad',  passwordHash: '$2b$10$tNy0.Lj6kWtyISJ9kOsNGeGur3gl7x4H7vNrLoATlocMjG1iZUXfa', role: 'user',            isActive: true, officeId: null },
  ];

  const userMap = {}; // username → id
  for (const u of usersData) {
    const user = await prisma.user.upsert({
      where: { username: u.username },
      update: { passwordHash: u.passwordHash, role: u.role, isActive: u.isActive, officeId: u.officeId },
      create: { username: u.username, passwordHash: u.passwordHash, role: u.role, isActive: u.isActive, officeId: u.officeId },
    });
    userMap[u.username] = user.id;
    console.log(`✅ User: ${user.username} (id=${user.id}, role=${user.role})`);
  }
  await resetSeq('users');

  const adminId = userMap['admin'];

  // ── 3. Items ──────────────────────────────────────────────
  const itemsData = [
    { name: 'مهتم' },
    { name: 'معلق' },
    { name: 'نزل الايتم' },
  ];

  const itemMap = {}; // name → id
  for (const item of itemsData) {
    const created = await prisma.item.upsert({
      where: { name_userId: { name: item.name, userId: adminId } },
      update: {},
      create: { name: item.name, userId: adminId },
    });
    itemMap[item.name] = created.id;
    console.log(`✅ Item: ${created.name} (id=${created.id})`);
  }
  await resetSeq('items');

  // ── 4. Scientific Representatives ─────────────────────────
  const rep = await prisma.scientificRepresentative.upsert({
    where: { name_userId: { name: 'يحيى', userId: adminId } },
    update: { isActive: true },
    create: { name: 'يحيى', isActive: true, userId: adminId },
  });
  console.log(`✅ Rep: ${rep.name} (id=${rep.id})`);
  await resetSeq('scientific_representatives');

  // ── 5. Doctors ────────────────────────────────────────────
  const doctorsData = [
    { name: 'عبير احمد',   notes: 'زياره سابقه', targetItemName: 'مهتم' },
    { name: 'زينة العبيدي', notes: 'متابعه',       targetItemName: 'معلق' },
    { name: 'علي الساجي',  notes: 'غير مهتم',     targetItemName: 'نزل الايتم' },
  ];

  for (const doc of doctorsData) {
    const targetItemId = itemMap[doc.targetItemName] ?? null;
    const existing = await prisma.doctor.findFirst({ where: { name: doc.name, userId: adminId } });
    let created;
    if (existing) {
      created = await prisma.doctor.update({
        where: { id: existing.id },
        data: { notes: doc.notes, targetItemId, isActive: true },
      });
    } else {
      created = await prisma.doctor.create({
        data: { name: doc.name, notes: doc.notes, targetItemId, isActive: true, userId: adminId },
      });
    }
    console.log(`✅ Doctor: ${created.name} (id=${created.id})`);
  }
  await resetSeq('doctors');

  // ── 6. Scientific Companies ───────────────────────────────
  const companiesData = [
    { name: 'humanis' },
    { name: 'deva' },
  ];

  for (const c of companiesData) {
    const existing = await prisma.scientificCompany.findFirst({ where: { name: c.name, officeId: office.id } });
    if (!existing) {
      const created = await prisma.scientificCompany.create({
        data: { name: c.name, officeId: office.id, isActive: true },
      });
      console.log(`✅ Company: ${created.name} (id=${created.id})`);
    } else {
      console.log(`✅ Company: ${existing.name} (id=${existing.id}) — already exists`);
    }
  }
  await resetSeq('scientific_companies');

  console.log('\n✅ Local data seeded successfully!');
}

main()
  .catch(e => { console.warn('⚠️  seed-local-data warning:', e.message); })
  .finally(() => prisma.$disconnect());
