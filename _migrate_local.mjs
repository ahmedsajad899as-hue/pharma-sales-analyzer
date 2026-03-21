// Apply isExtraVisit column to local SQLite DB
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  await prisma.$executeRawUnsafe(`ALTER TABLE "plan_entries" ADD COLUMN "isExtraVisit" BOOLEAN NOT NULL DEFAULT 0`);
  console.log('✅ Column isExtraVisit added to plan_entries');
} catch (e) {
  if (e.message?.includes('duplicate column')) {
    console.log('ℹ️  Column already exists');
  } else {
    console.error('Error:', e.message);
  }
}
await prisma.$disconnect();
