/**
 * stock-ledger-name-cleanup.mjs
 * دمج تكرارات "رصيد المذاخر" القديمة التي سبّبها الخلل قبل إصلاح مطابقة الأسماء
 * (مذخر/ايتم/شركة) — راجع WarehouseNameLink + تصحيح itemKey/itemName +
 * StockCompanyNameLink في server/modules/stock-ledger/stock-ledger.service.js.
 *
 * غير هدّام وقابل لإعادة التشغيل (idempotent) — يعالج فقط الحالات المؤكَّدة،
 * لا شيء ملتبس يُخمَّن هنا:
 *   - المذاخر: يدمج فقط الأزواج (اسم+منطقة) التي يتطابق مفتاحها تماماً بعد
 *     التنظيف الجديد (warehouseLinkKey) — لا فرق بينها سوى تهجئة/بادئة معروفة
 *     («مذخر اوزون» ≡ «اوزون»). الالتباس الحقيقي (مذاخر مختلفة الاسم فعلاً) لا
 *     يُلمَس، وسيُحلّ لاحقاً عبر نافذة التأكيد عند أول رفع جديد يلامسه.
 *     المذخر المُبقى = صاحب أكبر عدد حركات (الأرسخ تاريخياً)؛ حركات البقية
 *     تُنقل إليه ثم تُحذف السجلات المكرَّرة.
 *   - الايتمات: يصحّح itemKey/itemName فقط لحركات مربوطة أصلاً بـ Item.id (قرار
 *     تطابق محسوم سلفاً — فقط تصحيح المفتاح ليطابق الاسم القانوني الحالي).
 *   - الشركات: يوحّد companyName فقط عند تطابق تام (بعد normalizeItemKey) مع
 *     شركة Company موجودة لنفس المستخدم.
 * كل الخطوات تنتهي بـ recomputeBalances() لكل مستخدم تأثّر — الأرصدة مُشتقة
 * بالكامل فلا داعٍ لأي حساب يدوي.
 *
 * التشغيل على الخادم بعد نشر الإصلاح وdb push:
 *   node scripts/stock-ledger-name-cleanup.mjs            # تشغيل فعلي
 *   node scripts/stock-ledger-name-cleanup.mjs --dry-run  # عرض فقط بلا كتابة
 */

import prisma from '../server/lib/prisma.js';
import { normalizeItemKey } from '../server/lib/itemResolver.js';
import { warehouseLinkKey, recomputeBalances } from '../server/modules/stock-ledger/stock-ledger.service.js';

const DRY = process.argv.includes('--dry-run');

async function mergeWarehouses(affectedUsers) {
  const warehouses = await prisma.stockWarehouse.findMany({
    select: { id: true, userId: true, name: true, region: true },
  });
  const byUser = new Map();
  for (const w of warehouses) {
    if (!byUser.has(w.userId)) byUser.set(w.userId, []);
    byUser.get(w.userId).push(w);
  }

  let mergedGroups = 0, mergedWarehouses = 0, movedMovements = 0;

  for (const [userId, list] of byUser) {
    const groups = new Map();
    for (const w of list) {
      const key = warehouseLinkKey(w.name, w.region);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }

    for (const [key, dupes] of groups) {
      if (dupes.length < 2) continue;

      const counts = await Promise.all(dupes.map(w => prisma.stockMovement.count({ where: { warehouseId: w.id } })));
      let canonicalIdx = 0;
      for (let i = 1; i < dupes.length; i++) {
        if (counts[i] > counts[canonicalIdx] || (counts[i] === counts[canonicalIdx] && dupes[i].id < dupes[canonicalIdx].id)) canonicalIdx = i;
      }
      const canonical = dupes[canonicalIdx];
      const rest = dupes.filter((_, i) => i !== canonicalIdx);

      console.log(`  [user ${userId}] "${canonical.name}" (${canonical.region}) ← دمج ${rest.map(w => `#${w.id} "${w.name}"`).join('، ')}  [key=${key}]`);
      mergedGroups++;
      mergedWarehouses += rest.length;

      if (!DRY) {
        for (const w of rest) {
          const upd = await prisma.stockMovement.updateMany({ where: { warehouseId: w.id }, data: { warehouseId: canonical.id } });
          movedMovements += upd.count;
          await prisma.stockWarehouse.delete({ where: { id: w.id } }).catch(() => {});
        }
        affectedUsers.add(userId);
      }
    }
  }
  console.log(`المذاخر: ${mergedGroups} مجموعة مكرَّرة · ${mergedWarehouses} سجل دُمج · ${movedMovements} حركة نُقلت`);
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
  console.log(`الشركات: ${fixed} حركة وُحِّد اسم شركتها إلى الاسم القانوني`);
}

async function main() {
  console.log(`stock-ledger-name-cleanup  ${DRY ? '(DRY-RUN — بلا كتابة)' : ''}`);
  const affectedUsers = new Set();

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
