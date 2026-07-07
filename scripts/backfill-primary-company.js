/**
 * Backfill يدوي لمرة واحدة: تحديد الشركة الرئيسية (isPrimary) لكل مستخدم لا يملك رئيسية.
 * يعيد استخدام نفس منطق إقلاع الخادم (server/lib/ensurePrimaryCompanies.js).
 * ملاحظة: نفس المنطق يعمل تلقائياً عند كل إقلاع للخادم، فهذا السكربت للتشغيل اليدوي فقط.
 *
 * التشغيل:  node scripts/backfill-primary-company.js
 */
import prisma from '../server/lib/prisma.js';
import { ensurePrimaryCompanies } from '../server/lib/ensurePrimaryCompanies.js';

ensurePrimaryCompanies()
  .then(n => console.log(`✅ backfill تم: ${n} مستخدم عُيّنت لهم شركة رئيسية.`))
  .catch(e => { console.error('❌ فشل الـbackfill:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
