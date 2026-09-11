/**
 * إعادة ربط يدوية لمرة واحدة: زيارات أطباء/صيدليات استُوردت وايتمها محفوظ نصاً
 * خاماً (itemName بتهجئة الملف) رغم وجوده في كتالوج شركة المستخدم — تُطابَق الآن
 * بمحرّك itemResolver وتُربط بالايتم القانوني (itemId) فتظهر باسم موحّد في كل
 * الشاشات (الكولات، فلتر الايتم، تحليل الايتم). راجع relinkVisitItemsToCatalog.
 *
 * التشغيل:  node scripts/relink-visit-items.js
 */
import prisma from '../server/lib/prisma.js';
import { relinkVisitItemsToCatalog } from '../server/modules/doctors/doctor-visits-import.js';

relinkVisitItemsToCatalog({
  onProgress: ({ docLinked, pharmLinked }) => {
    if ((docLinked + pharmLinked) % 50 === 0) console.log(`… رُبط حتى الآن: أطباء ${docLinked}، صيدليات ${pharmLinked}`);
  },
})
  .then(({ docSeen, docLinked, pharmSeen, pharmLinked }) => {
    console.log(`✅ تم: زيارات أطباء ${docLinked}/${docSeen} رُبطت بايتم قانوني، زيارات صيدليات ${pharmLinked}/${pharmSeen}.`);
  })
  .catch(e => { console.error('❌ فشل:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
