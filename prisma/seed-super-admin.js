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
  const password = process.env.MASTER_ADMIN_PASSWORD || '1231234a';

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.superAdmin.upsert({
    where:  { username },
    update: { passwordHash, isActive: true },
    create: { username, passwordHash, isMaster: true, displayName: 'Master Admin' },
  });

  console.log(`✅ Master super admin ready: id=${admin.id}, username=${admin.username}`);
}

main()
  .catch(e => { console.error('⚠️  Seed warning (non-fatal):', e.message); })
  .finally(() => prisma.$disconnect());
