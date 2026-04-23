import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const r = await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('filter_presets', 'uploaded_files')`);
  console.log('Tables found:', JSON.stringify(r));
  
  // Check if fileType column exists on uploaded_files
  const cols = await p.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'uploaded_files' AND column_name = 'fileType'`);
  console.log('fileType column:', JSON.stringify(cols));
} catch(e) {
  console.log('ERR:', e.message);
} finally {
  await p.$disconnect();
}
