/**
 * seed-super-admin.js
 * Run once to create the master super admin account.
 * Usage: node prisma/seed-super-admin.js
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ── Master admin ───────────────────────────────────────────
  const username = process.env.MASTER_ADMIN_USERNAME || 'master';
  const password = process.env.MASTER_ADMIN_PASSWORD || '1231234a';

  const passwordHash = await bcrypt.hash(password, 12);

  const master = await prisma.superAdmin.upsert({
    where:  { username },
    update: { passwordHash, isActive: true },
    create: { username, passwordHash, isMaster: true, displayName: 'Master Admin' },
  });

  console.log(`✅ Master super admin ready: id=${master.id}, username=${master.username}`);

  // ── Sub admins ─────────────────────────────────────────────
  const subAdmins = [
    { username: 'Ahmed',     password: process.env.AHMED_PASSWORD     || '1231234a', displayName: 'Ahmed' },
    { username: 'محمد حسن', password: process.env.MOHAMAD_PASSWORD    || '1231234a', displayName: 'محمد حسن' },
  ];

  for (const sa of subAdmins) {
    const hash = await bcrypt.hash(sa.password, 12);
    const record = await prisma.superAdmin.upsert({
      where:  { username: sa.username },
      update: { isActive: true },          // don't override password if already exists
      create: { username: sa.username, passwordHash: hash, isMaster: false, displayName: sa.displayName, createdById: master.id },
    });
    console.log(`✅ Sub admin ready: id=${record.id}, username=${record.username}`);
  }
}

main()
  .catch(e => { console.error('⚠️  Seed warning (non-fatal):', e.message); })
  .finally(() => prisma.$disconnect());
