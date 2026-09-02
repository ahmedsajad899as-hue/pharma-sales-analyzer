/**
 * backfill-rep-links.mjs — تعبئة لمرة واحدة لمناطق/ايتمات المناديب الذين
 * أُضيفوا قبل إصلاح ensureLinkedRepId.
 *
 * الخلفية: كان ScientificRepArea/ScientificRepItem لا يُملآن وقت إنشاء
 * المستخدم (استيراد إكسل أو إنشاء يدوي) لأن linkedRepId لم يكن قد أُنشئ بعد،
 * فتظهر تلك السجلات فارغة في صفحة «المناديب العلميين» («كل المناطق» / «كل
 * الايتمات») رغم أن تعيينات المستخدم نفسها كانت محفوظة وصحيحة.
 *
 * الأمان — يملأ الفارغ فقط ولا يدهس تعييناً موجوداً:
 *   • يتخطّى أي مندوب لديه ScientificRepArea/ScientificRepItem أصلاً، لأن
 *     المدير قد يكون ضبطها يدوياً من صفحة المناديب بشكل مقصود مختلف عن
 *     تعيينات المستخدم (الجدولان مستقلان بالتصميم).
 *   • لا يلمس ScientificRepCommercial إطلاقاً — مصدره بيانات الملف المفعَّل
 *     (syncCommercialsByActiveFiles) لا مطابقة أسماء المناطق.
 *
 * الاستعمال:
 *   node scripts/backfill-rep-links.mjs            # عرض فقط (dry-run)
 *   node scripts/backfill-rep-links.mjs --apply    # تنفيذ فعلي
 */

import prisma from '../server/lib/prisma.js';
import { ensureLinkedRepId, resolveEffectiveAreaIds, REP_ROLES } from '../server/lib/areaScope.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const users = await prisma.user.findMany({
    where:  { role: { in: [...REP_ROLES] } },
    select: { id: true, username: true, displayName: true, role: true, linkedRepId: true },
    orderBy: { id: 'asc' },
  });

  console.log(`${users.length} مستخدم بدور مندوب — الوضع: ${APPLY ? 'تنفيذ' : 'عرض فقط (dry-run)'}\n`);

  let areasFilled = 0, itemsFilled = 0, linksCreated = 0, skipped = 0;

  for (const u of users) {
    const label = `#${u.id} ${u.displayName || u.username}`;

    let repId = u.linkedRepId;
    if (!repId) {
      if (!APPLY) {
        // في العرض فقط لا نُنشئ سجلاً — نكتفي بالإشارة إلى أنه سيُنشأ.
        const existing = await prisma.scientificRepresentative.findFirst({ where: { userId: u.id }, select: { id: true } });
        repId = existing?.id ?? null;
        console.log(`${label}: ${existing ? 'ربط سجل قائم' : 'سيُنشأ سجل مندوب جديد'}`);
        if (!repId) { linksCreated++; continue; } // بلا سجل لا يمكن فحص الفارغ
      } else {
        repId = await ensureLinkedRepId(u.id, { onlyRoles: REP_ROLES });
        if (!repId) { skipped++; continue; }
        linksCreated++;
      }
    }

    const [repAreaCount, repItemCount, userAreaIds, userItemRows] = await Promise.all([
      prisma.scientificRepArea.count({ where: { scientificRepId: repId } }),
      prisma.scientificRepItem.count({ where: { scientificRepId: repId } }),
      resolveEffectiveAreaIds(u.id, { includeRepAreas: false }),
      prisma.userItemAssignment.findMany({ where: { userId: u.id }, select: { itemId: true } }),
    ]);
    const userItemIds = userItemRows.map(r => r.itemId);

    // مناطق: نملأ فقط إن كان سجل المندوب فارغاً وللمستخدم مناطق فعلاً
    if (repAreaCount === 0 && userAreaIds.length > 0) {
      console.log(`${label}: مناطق ${repAreaCount} → ${userAreaIds.length}`);
      if (APPLY) {
        await prisma.scientificRepArea.createMany({
          data: userAreaIds.map(areaId => ({ scientificRepId: repId, areaId })),
          skipDuplicates: true,
        });
      }
      areasFilled++;
    }

    // ايتمات: نفس المنطق
    if (repItemCount === 0 && userItemIds.length > 0) {
      console.log(`${label}: ايتمات ${repItemCount} → ${userItemIds.length}`);
      if (APPLY) {
        await prisma.scientificRepItem.createMany({
          data: userItemIds.map(itemId => ({ scientificRepId: repId, itemId })),
          skipDuplicates: true,
        });
      }
      itemsFilled++;
    }

    if (repAreaCount > 0 && repItemCount > 0) skipped++;
  }

  console.log(`\n── الخلاصة ──`);
  console.log(`سجلات مندوب أُنشئت/ستُنشأ : ${linksCreated}`);
  console.log(`مناديب مُلئت مناطقهم      : ${areasFilled}`);
  console.log(`مناديب مُلئت ايتماتهم     : ${itemsFilled}`);
  console.log(`متروكون (مضبوطون أصلاً)   : ${skipped}`);
  if (!APPLY) console.log(`\nلم يُكتب شيء. أعد التشغيل مع --apply للتنفيذ.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
