/**
 * seed-super-admin.js
 * Run once to create the master super admin account.
 * Usage: node prisma/seed-super-admin.js
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const username = process.env.MASTER_ADMIN_USERNAME || 'master';
  const password = process.env.MASTER_ADMIN_PASSWORD || 'Master@2026!';

  const existing = await prisma.superAdmin.findUnique({ where: { username } });
  if (existing) {
    console.log(`✓ Master admin "${username}" already exists (id=${existing.id})`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.superAdmin.create({
    data: {
      username,
      passwordHash,
      isMaster: true,
      displayName: 'Master Admin',
    },
  });

  console.log(`✅ Master super admin created:`);
  console.log(`   Username : ${username}`);
  console.log(`   Password : ${password}`);
  console.log(`   ID       : ${admin.id}`);
  console.log(`\n⚠️  Change the password after first login!`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
