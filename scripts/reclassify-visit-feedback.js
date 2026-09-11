/**
 * إعادة تصنيف يدوية لمرة واحدة: تعيد تشغيل الذكاء الاصطناعي على كل زيارة سبق
 * تصنيفها آلياً (feedbackSource='import_ai') بعد تصحيح البرومبت — كان يخلط بين
 * الايتم المستهدف بالزيارة وأي مادة أخرى وردت في نص الملاحظة (مثال: طبيب يكتب
 * مادة منافِسة غير الايتم المستهدف كان يُصنَّف خطأً writing بدل unavailable).
 * راجع doctor-visit-feedback-ai.js (reclassifyImportAiFeedback).
 *
 * التشغيل:  node scripts/reclassify-visit-feedback.js
 */
import prisma from '../server/lib/prisma.js';
import { reclassifyImportAiFeedback } from '../server/modules/doctors/doctor-visit-feedback-ai.js';

reclassifyImportAiFeedback({
  onProgress: ({ totalSeen, totalChanged, cursor }) => {
    console.log(`… فُحص حتى الآن: ${totalSeen}، عُدِّل: ${totalChanged} (مؤشر id=${cursor})`);
  },
})
  .then(({ totalSeen, totalChanged }) => {
    console.log(`✅ إعادة التصنيف تمت: فُحصت ${totalSeen} زيارة، عُدِّل تصنيف ${totalChanged} منها.`);
  })
  .catch(e => { console.error('❌ فشلت إعادة التصنيف:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
