// Fix/create user on Railway PostgreSQL
// Run with: railway run node _fix_railway_user.mjs
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const USERNAME = 'ارشد';
const PASSWORD = '1231234a';
const ROLE     = 'commercial_rep';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const existing = await prisma.user.findUnique({ where: { username: USERNAME } });

  if (existing) {
    await prisma.user.update({
      where: { username: USERNAME },
      data: { passwordHash: hash, isActive: true, role: ROLE },
    });
    console.log(`✅ Updated user "${USERNAME}" — password reset, isActive=true`);
  } else {
    const user = await prisma.user.create({
      data: {
        username: USERNAME,
        passwordHash: hash,
        role: ROLE,
        isActive: true,
        displayName: 'ارشد',
      },
    });
    console.log(`✅ Created user "${USERNAME}" with id=${user.id}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
