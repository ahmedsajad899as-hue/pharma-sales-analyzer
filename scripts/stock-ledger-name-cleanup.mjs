/**
 * stock-ledger-name-cleanup.mjs
 * دمج تكرارات "رصيد المذاخر" القديمة التي سبّبها الخلل قبل إصلاح مطابقة الأسماء
 * (مذخر/ايتم/شركة) — راجع WarehouseNameLink + تصحيح itemKey/itemName +
 * StockCompanyNameLink في server/modules/stock-ledger/stock-ledger.service.js.
 *
 * غير هدّام وقابل لإعادة التشغيل (idempotent):
 *   - **الشركات (كتالوج Company نفسه)**: يدمج الشركات التي يتطابق اسمها تماماً
 *     بعد normalizeItemKey (فرق حالة أحرف فقط — DEVA/deva/Deva) في شركة واحدة.
 *     الشركة المُبقاة = صاحبة أكبر عدد ايتمات مربوطة بها؛ يُعاد ربط Item.companyId
 *     وScientificRepCompany وStockCompanyNameLink بها قبل حذف المكرَّرة (لا حذف
 *     كاسكيدي أعمى — كل مرجع يُنقَل صراحةً أولاً؛ ScientificRepCompany مفتاحه
 *     مركّب فيُحذف الرابط المكرِّر بدل نقله إن كان الهدف موجوداً أصلاً).
 *   - **المذاخر**: يدمج كل الأسماء التي تتطابق مفتاحها بعد التنظيف الجديد
 *     (cleanWarehouseName) **بصرف النظر عن المنطقة** — خلل ملفات ميركاتو
 *     القديم كان يكتب منطقة الصيدلية كأنها منطقة المذخر، فنفس المذخر الحقيقي
 *     تكرّر بعدة "مناطق" مختلفة كلها خاطئة؛ المنطقة نفسها إذن غير موثوقة لهذه
 *     الحالات ولا تصلح شرطاً للتفريق. المذخر المُبقى = صاحب أكبر عدد حركات؛
 *     منطقته النهائية = منطقة أي عضو من المجموعة له حركة "ستوك افتتاحي" حقيقية
 *     (الأكثر موثوقية)، وإلا تبقى منطقته الحالية كما هي (لا تخمين).
 *   - **الايتمات**: يصحّح itemKey/itemName فقط لحركات مربوطة أصلاً بـ Item.id.
 *   - **إعادة تسمية الحركات**: بعد دمج الشركات، تُوحَّد companyName في الحركات
 *     القديمة إلى الاسم القانوني الجديد.
 * كل الخطوات تنتهي بـ recomputeBalances() لكل مستخدم تأثّر.
 *
 * التشغيل على الخادم بعد نشر الإصلاح وdb push:
 *   node scripts/stock-ledger-name-cleanup.mjs            # تشغيل فعلي
 *   node scripts/stock-ledger-name-cleanup.mjs --dry-run  # عرض فقط بلا كتابة
 */

import prisma from '../server/lib/prisma.js';
import { normalizeItemKey, normalizeAreaName } from '../server/lib/itemResolver.js';
import { cleanWarehouseName, recomputeBalances } from '../server/modules/stock-ledger/stock-ledger.service.js';

const DRY = process.argv.includes('--dry-run');
const whKey = (s) => cleanWarehouseName(s).toLowerCase();
const regKey = (s) => normalizeAreaName(String(s ?? '')) || '';

async function mergeDuplicateCompanies(affectedUsers) {
  const companies = await prisma.company.findMany({
    where: { userId: { not: null } },
    select: { id: true, userId: true, name: true },
  });
  const byUser = new Map();
  for (const c of companies) {
    if (!byUser.has(c.userId)) byUser.set(c.userId, []);
    byUser.get(c.userId).push(c);
  }

  let mergedGroups = 0, mergedCompanies = 0;

  for (const [userId, list] of byUser) {
    const groups = new Map();
    for (const c of list) {
      const key = normalizeItemKey(c.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    for (const [key, dupes] of groups) {
      if (dupes.length < 2) continue;

      const itemCounts = await Promise.all(dupes.map(c => prisma.item.count({ where: { companyId: c.id } })));
      let canonicalIdx = 0;
      for (let i = 1; i < dupes.length; i++) {
        if (itemCounts[i] > itemCounts[canonicalIdx] || (itemCounts[i] === itemCounts[canonicalIdx] && dupes[i].id < dupes[canonicalIdx].id)) canonicalIdx = i;
      }
      const canonical = dupes[canonicalIdx];
      const rest = dupes.filter((_, i) => i !== canonicalIdx);

      console.log(`  [user ${userId}] شركة "${canonical.name}" ← دمج ${rest.map(c => `#${c.id} "${c.name}"`).join('، ')}  [key=${key}]`);
      mergedGroups++;
      mergedCompanies += rest.length;

      if (!DRY) {
        for (const c of rest) {
          await prisma.item.updateMany({ where: { companyId: c.id }, data: { companyId: canonical.id } });

          // ScientificRepCompany مفتاحه مركّب (scientificRepId+companyId) — قد يتصادم
          // لو كان نفس المندوب مربوطاً أصلاً بكلا الشركتين، فيُحذف المكرِّر بدل نقله.
          const links = await prisma.scientificRepCompany.findMany({ where: { companyId: c.id } });
          for (const link of links) {
            const exists = await prisma.scientificRepCompany.findUnique({
              where: { scientificRepId_companyId: { scientificRepId: link.scientificRepId, companyId: canonical.id } },
            });
            if (exists) {
              await prisma.scientificRepCompany.delete({
                where: { scientificRepId_companyId: { scientificRepId: link.scientificRepId, companyId: c.id } },
              }).catch(() => {});
            } else {
              await prisma.scientificRepCompany.update({
                where: { scientificRepId_companyId: { scientificRepId: link.scientificRepId, companyId: c.id } },
                data: { companyId: canonical.id },
              }).catch(() => {});
            }
          }

          await prisma.stockCompanyNameLink.updateMany({ where: { companyId: c.id }, data: { companyId: canonical.id } }).catch(() => {});
          await prisma.company.delete({ where: { id: c.id } }).catch(() => {});
        }
        affectedUsers.add(userId);
      }
    }
  }
  console.log(`الشركات المكرَّرة: ${mergedGroups} مجموعة · ${mergedCompanies} سجل دُمج`);
}

async function mergeWarehouses(affectedUsers) {
  const warehouses = await prisma.stockWarehouse.findMany({
    select: { id: true, userId: true, name: true, region: true },
  });
  const byUser = new Map();
  for (const w of warehouses) {
    if (!byUser.has(w.userId)) byUser.set(w.userId, []);
    byUser.get(w.userId).push(w);
  }

  let mergedGroups = 0, mergedWarehouses = 0, movedMovements = 0, regionsFixed = 0;

  for (const [userId, list] of byUser) {
    const groups = new Map();
    for (const w of list) {
      const key = whKey(w.name); // بصرف النظر عن المنطقة — راجع الشرح أعلى الملف
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }

    for (const [key, dupes] of groups) {
      if (dupes.length < 2) continue;

      const counts = await Promise.all(dupes.map(w => prisma.stockMovement.count({ where: { warehouseId: w.id } })));
      const baselineCounts = await Promise.all(dupes.map(w => prisma.stockMovement.count({ where: { warehouseId: w.id, direction: 'baseline' } })));
      let canonicalIdx = 0;
      for (let i = 1; i < dupes.length; i++) {
        if (counts[i] > counts[canonicalIdx] || (counts[i] === counts[canonicalIdx] && dupes[i].id < dupes[canonicalIdx].id)) canonicalIdx = i;
      }
      const canonical = dupes[canonicalIdx];
      const rest = dupes.filter((_, i) => i !== canonicalIdx);
      const trustedIdx = baselineCounts.findIndex(c => c > 0);
      const trustedRegion = trustedIdx !== -1 ? dupes[trustedIdx].region : null;

      console.log(`  [user ${userId}] "${canonical.name}" ← دمج ${rest.map(w => `#${w.id} "${w.name}" (${w.region})`).join('، ')}  [key=${key}]${trustedRegion && trustedRegion !== canonical.region ? ` — منطقته النهائية: "${trustedRegion}"` : ''}`);
      mergedGroups++;
      mergedWarehouses += rest.length;

      if (!DRY) {
        for (const w of rest) {
          const upd = await prisma.stockMovement.updateMany({ where: { warehouseId: w.id }, data: { warehouseId: canonical.id } });
          movedMovements += upd.count;
          await prisma.stockWarehouse.delete({ where: { id: w.id } }).catch(() => {});
        }
        if (trustedRegion && trustedRegion !== canonical.region) {
          await prisma.stockWarehouse.update({
            where: { id: canonical.id },
            data: { region: trustedRegion, regionKey: regKey(trustedRegion) },
          }).catch(() => {});
          regionsFixed++;
        }
        affectedUsers.add(userId);
      }
    }
  }
  console.log(`المذاخر: ${mergedGroups} مجموعة مكرَّرة · ${mergedWarehouses} سجل دُمج · ${movedMovements} حركة نُقلت · ${regionsFixed} منطقة صُحِّحت من مصدر موثوق`);
}

async function fixItemKeys(affectedUsers) {
  const movements = await prisma.stockMovement.findMany({
    where: { itemId: { not: null } },
    select: { id: true, userId: true, itemId: true, itemKey: true, itemName: true },
  });
  if (!movements.length) { console.log('الايتمات: لا حركات مربوطة بكتالوج'); return; }

  const itemIds = [...new Set(movements.map(m => m.itemId))];
  const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } });
  const itemById = new Map(items.map(i => [i.id, i]));

  let fixed = 0;
  for (const m of movements) {
    const item = itemById.get(m.itemId);
    if (!item) continue; // ايتم حُذف بعد ربط الحركة به — نادر، يُتجاهل
    const canonicalKey = normalizeItemKey(item.name);
    if (canonicalKey === m.itemKey && item.name === m.itemName) continue; // مطابق أصلاً
    fixed++;
    if (!DRY) {
      await prisma.stockMovement.update({ where: { id: m.id }, data: { itemKey: canonicalKey, itemName: item.name } });
      affectedUsers.add(m.userId);
    }
  }
  console.log(`الايتمات: ${fixed} حركة صُحِّح مفتاحها/اسمها إلى الاسم القانوني الحالي`);
}

async function relabelCompanies(affectedUsers) {
  const userRows = await prisma.stockMovement.findMany({
    where: { companyName: { not: null } },
    select: { userId: true },
    distinct: ['userId'],
  });

  let fixed = 0;
  for (const { userId } of userRows) {
    const companies = await prisma.company.findMany({ where: { userId }, select: { id: true, name: true } });
    if (!companies.length) continue;
    const byKey = new Map();
    for (const c of companies) { const k = normalizeItemKey(c.name); if (!byKey.has(k)) byKey.set(k, c); }

    const movements = await prisma.stockMovement.findMany({
      where: { userId, companyName: { not: null } },
      select: { id: true, companyName: true },
    });
    for (const m of movements) {
      const canonical = byKey.get(normalizeItemKey(m.companyName));
      if (!canonical || canonical.name === m.companyName) continue;
      fixed++;
      if (!DRY) {
        await prisma.stockMovement.update({ where: { id: m.id }, data: { companyName: canonical.name } });
        affectedUsers.add(userId);
      }
    }
  }
  console.log(`الشركات (تسمية الحركات): ${fixed} حركة وُحِّد اسم شركتها إلى الاسم القانوني`);
}

async function main() {
  console.log(`stock-ledger-name-cleanup  ${DRY ? '(DRY-RUN — بلا كتابة)' : ''}`);
  const affectedUsers = new Set();

  await mergeDuplicateCompanies(affectedUsers);
  await mergeWarehouses(affectedUsers);
  await fixItemKeys(affectedUsers);
  await relabelCompanies(affectedUsers);

  if (!DRY && affectedUsers.size) {
    console.log(`\nإعادة حساب الأرصدة لـ ${affectedUsers.size} مستخدم متأثر…`);
    for (const userId of affectedUsers) await recomputeBalances(userId);
  }
  console.log('تم.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
