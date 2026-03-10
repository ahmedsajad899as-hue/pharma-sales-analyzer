const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const cols = ['scientificName TEXT', 'dosage TEXT', 'form TEXT', 'price REAL', 'scientificMessage TEXT', 'scientificCompanyId INTEGER'];
  for (const col of cols) {
    try {
      await p.$executeRawUnsafe(`ALTER TABLE items ADD COLUMN ${col}`);
      console.log('ADDED: ' + col);
    } catch (e) {
      if (e.message.includes('duplicate column')) {
        console.log('EXISTS: ' + col);
      } else {
        console.log('ERR: ' + col + ' -> ' + e.message);
      }
    }
  }
}

main().then(() => p.$disconnect());
