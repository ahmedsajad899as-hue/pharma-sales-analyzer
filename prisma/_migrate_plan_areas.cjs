import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Step 1: Create plan_areas table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "plan_areas" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "planId" INTEGER NOT NULL,
      "areaId" INTEGER NOT NULL,
      CONSTRAINT "plan_areas_planId_fkey" FOREIGN KEY ("planId") REFERENCES "monthly_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "plan_areas_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "plan_areas_planId_areaId_key" ON "plan_areas"("planId", "areaId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "plan_areas_planId_idx" ON "plan_areas"("planId")`);
  console.log('plan_areas table created');

  // Step 2: Recreate monthly_plans with optional scientificRepId
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = OFF`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE "new_monthly_plans" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "scientificRepId" INTEGER,
      "month" INTEGER NOT NULL,
      "year" INTEGER NOT NULL,
      "targetCalls" INTEGER NOT NULL DEFAULT 150,
      "targetDoctors" INTEGER NOT NULL DEFAULT 75,
      "notes" TEXT,
      "status" TEXT NOT NULL DEFAULT 'draft',
      "allowExtraVisits" BOOLEAN NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "userId" INTEGER,
      "assignedUserId" INTEGER,
      CONSTRAINT "monthly_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "monthly_plans_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "monthly_plans_scientificRepId_fkey" FOREIGN KEY ("scientificRepId") REFERENCES "scientific_representatives" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`INSERT INTO "new_monthly_plans" SELECT * FROM "monthly_plans"`);
  await prisma.$executeRawUnsafe(`DROP TABLE "monthly_plans"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "new_monthly_plans" RENAME TO "monthly_plans"`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "monthly_plans_scientificRepId_month_year_userId_key" ON "monthly_plans"("scientificRepId", "month", "year", "userId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "monthly_plans_userId_idx" ON "monthly_plans"("userId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "monthly_plans_assignedUserId_idx" ON "monthly_plans"("assignedUserId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX "monthly_plans_scientificRepId_idx" ON "monthly_plans"("scientificRepId")`);
  console.log('monthly_plans recreated with optional scientificRepId');

  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
  await prisma.$disconnect();
  console.log('Migration done!');
}
main().catch(e => { console.error(e); process.exit(1); });
