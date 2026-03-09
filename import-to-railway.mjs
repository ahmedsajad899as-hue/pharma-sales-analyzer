// ============================================================
// Import local data to Railway PostgreSQL
// Run with: railway run node import-to-railway.mjs
// ============================================================
import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

const data = JSON.parse(fs.readFileSync('./local-export.json', 'utf-8'));

async function resetSequence(table, idCol = 'id') {
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"${table}"', '${idCol}'), COALESCE(MAX("${idCol}"), 1)) FROM "${table}"`
  );
}

async function main() {
  console.log('🚀 Starting import to Railway PostgreSQL...\n');

  // 1. Scientific Offices
  if (data.offices?.length) {
    console.log(`📂 Importing ${data.offices.length} scientific offices...`);
    for (const o of data.offices) {
      await prisma.scientificOffice.upsert({
        where: { id: o.id },
        update: { name: o.name, phone: o.phone, address: o.address, isActive: o.isActive, notes: o.notes },
        create: { id: o.id, name: o.name, phone: o.phone, address: o.address, isActive: o.isActive, notes: o.notes },
      });
    }
    await resetSequence('scientific_offices');
    console.log(`   ✅ Done`);
  }

  // 2. Users (skip officeId first to avoid FK issues, then update)
  if (data.users?.length) {
    console.log(`\n👤 Importing ${data.users.length} users...`);
    // Insert without officeId to avoid FK constraint
    for (const u of data.users) {
      await prisma.user.upsert({
        where: { id: u.id },
        update: {
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role,
          isActive: u.isActive,
          displayName: u.displayName,
          phone: u.phone,
          permissions: u.permissions,
        },
        create: {
          id: u.id,
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role,
          isActive: u.isActive,
          displayName: u.displayName,
          phone: u.phone,
          permissions: u.permissions,
        },
      });
    }
    // Now update officeId links
    for (const u of data.users) {
      if (u.officeId) {
        await prisma.user.update({
          where: { id: u.id },
          data: { officeId: u.officeId },
        });
      }
    }
    await resetSequence('users');
    console.log(`   ✅ Done`);
  }

  // 3. Items
  if (data.items?.length) {
    console.log(`\n💊 Importing ${data.items.length} items...`);
    for (const item of data.items) {
      await prisma.item.upsert({
        where: { id: item.id },
        update: { name: item.name, userId: item.userId, companyId: item.companyId },
        create: { id: item.id, name: item.name, userId: item.userId, companyId: item.companyId },
      });
    }
    await resetSequence('items');
    console.log(`   ✅ Done`);
  }

  // 4. Areas
  if (data.areas?.length) {
    console.log(`\n🗺️  Importing ${data.areas.length} areas...`);
    for (const area of data.areas) {
      await prisma.area.upsert({
        where: { id: area.id },
        update: { name: area.name, userId: area.userId },
        create: { id: area.id, name: area.name, userId: area.userId },
      });
    }
    await resetSequence('areas');
    console.log(`   ✅ Done`);
  }

  // 5. Companies
  if (data.companies?.length) {
    console.log(`\n🏭 Importing ${data.companies.length} companies...`);
    for (const c of data.companies) {
      await prisma.company.upsert({
        where: { id: c.id },
        update: { name: c.name, userId: c.userId },
        create: { id: c.id, name: c.name, userId: c.userId },
      });
    }
    await resetSequence('companies');
    console.log(`   ✅ Done`);
  }

  // 6. Scientific Representatives
  if (data.reps?.length) {
    console.log(`\n🧬 Importing ${data.reps.length} scientific representatives...`);
    for (const rep of data.reps) {
      await prisma.scientificRepresentative.upsert({
        where: { id: rep.id },
        update: {
          name: rep.name, phone: rep.phone, email: rep.email,
          company: rep.company, isActive: rep.isActive,
          notes: rep.notes, userId: rep.userId,
        },
        create: {
          id: rep.id,
          name: rep.name, phone: rep.phone, email: rep.email,
          company: rep.company, isActive: rep.isActive,
          notes: rep.notes, userId: rep.userId,
        },
      });
    }
    await resetSequence('scientific_representatives');
    console.log(`   ✅ Done`);
  }

  // 7. Doctors
  if (data.doctors?.length) {
    console.log(`\n👨‍⚕️ Importing ${data.doctors.length} doctors...`);
    for (const doc of data.doctors) {
      await prisma.doctor.upsert({
        where: { id: doc.id },
        update: {
          name: doc.name, specialty: doc.specialty,
          areaId: doc.areaId, pharmacyName: doc.pharmacyName,
          targetItemId: doc.targetItemId, notes: doc.notes,
          isActive: doc.isActive, userId: doc.userId,
        },
        create: {
          id: doc.id,
          name: doc.name, specialty: doc.specialty,
          areaId: doc.areaId, pharmacyName: doc.pharmacyName,
          targetItemId: doc.targetItemId, notes: doc.notes,
          isActive: doc.isActive, userId: doc.userId,
        },
      });
    }
    await resetSequence('doctors');
    console.log(`   ✅ Done`);
  }

  // 8. Customers
  if (data.customers?.length) {
    console.log(`\n🏪 Importing ${data.customers.length} customers...`);
    for (const c of data.customers) {
      await prisma.customer.upsert({
        where: { id: c.id },
        update: { name: c.name, userId: c.userId },
        create: { id: c.id, name: c.name, userId: c.userId },
      });
    }
    await resetSequence('customers');
    console.log(`   ✅ Done`);
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('✅ Import completed successfully!');
  console.log('='.repeat(50));
  console.table({
    offices: data.offices?.length ?? 0,
    users: data.users?.length ?? 0,
    items: data.items?.length ?? 0,
    areas: data.areas?.length ?? 0,
    companies: data.companies?.length ?? 0,
    reps: data.reps?.length ?? 0,
    doctors: data.doctors?.length ?? 0,
    customers: data.customers?.length ?? 0,
  });

  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('❌ Import failed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
