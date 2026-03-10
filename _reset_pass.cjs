const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const p = new PrismaClient();

async function main() {
  const newPass = 'admin1234';
  const hash = await bcrypt.hash(newPass, 10);
  await p.user.update({ where: { username: 'admin' }, data: { passwordHash: hash } });
  console.log('Password reset. Login with: admin / admin1234');
}

main().then(() => p.$disconnect()).catch(e => { console.error(e); p.$disconnect(); });
