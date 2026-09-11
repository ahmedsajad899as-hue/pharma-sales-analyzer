/**
 * Backfill يدوي لمرة واحدة: يستنتج فيدباك زيارات الأطباء العالقة بحالة 'pending'
 * (من استيرادات سابقة لصيغة CRM، راجع doctor-visit-feedback-ai.js) من نص
 * ملاحظاتها بالذكاء الاصطناعي، عبر كامل قاعدة البيانات لكل الحسابات.
 * آمن لإعادة التشغيل: يتجاوز أي زيارة feedbackSource ليس null (مصنَّفة سابقاً
 * آلياً أو مؤكَّدة يدوياً).
 *
 * التشغيل:  node scripts/backfill-visit-feedback.js
 */
import prisma from '../server/lib/prisma.js';
import { backfillPendingVisitFeedback } from '../server/modules/doctors/doctor-visit-feedback-ai.js';

backfillPendingVisitFeedback({
  onProgress: ({ totalSeen, totalUpdated, cursor }) => {
    console.log(`… فُحص حتى الآن: ${totalSeen}، حُسم: ${totalUpdated} (مؤشر id=${cursor})`);
  },
})
  .then(({ totalSeen, totalUpdated }) => {
    console.log(`✅ backfill تم: فُحصت ${totalSeen} زيارة، حُسم فيدباك ${totalUpdated} منها بالذكاء الاصطناعي.`);
  })
  .catch(e => { console.error('❌ فشل الـbackfill:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
