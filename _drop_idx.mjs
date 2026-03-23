import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
await p.$executeRawUnsafe('DROP INDEX IF EXISTS monthly_plans_scientificRepId_month_year_userId_key');
console.log('OK');
await p.$disconnect();
