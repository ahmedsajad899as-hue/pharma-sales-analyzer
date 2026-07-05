/**
 * backfill-company-aliases.mjs
 * ترحيل قواعد التوحيد القديمة (per-user: ItemMergeRule بـ userId فقط) إلى نطاق الشركة
 * (scientificCompanyId + toItemId) — قرار المستخدم: "التوحيد لكل شركة — مشترك".
 *
 * غير هدّام وقابل لإعادة التشغيل (idempotent):
 *   - يعالج فقط القواعد التي scientificCompanyId=null (غير المُرحّلة).
 *   - لكل قاعدة: يجد شركات صاحبها (UserCompanyAssignment)، ويطابق toName بكتالوج كل شركة،
 *     وينشئ قاعدة شركة (scientificCompanyId, fromKey) بـ toItemId إن وُجد الهدف في الكتالوج.
 *   - يعيد حساب fromKey بـ normalizeItemKey (عربي+لاتيني) ليتطابق مع بحث المحرّك.
 *   - يُبقي القواعد القديمة كما هي (لتظل نقاط النهاية القديمة تعمل حتى تحويل المرحلة 2)،
 *     إلا مع الخيار --purge-legacy فيحذف القواعد القديمة التي رُحّلت بنجاح.
 *
 * التشغيل على الخادم بعد db push:
 *   node scripts/backfill-company-aliases.mjs            # تشغيل فعلي
 *   node scripts/backfill-company-aliases.mjs --dry-run  # عرض فقط بلا كتابة
 *   node scripts/backfill-company-aliases.mjs --purge-legacy
 */

import prisma from '../server/lib/prisma.js';
import { normalizeItemKey } from '../server/lib/itemResolver.js';

const DRY = process.argv.includes('--dry-run');
const PURGE = process.argv.includes('--purge-legacy');

async function main() {
  console.log(`backfill-company-aliases  ${DRY ? '(DRY-RUN)' : ''}${PURGE ? ' (PURGE-LEGACY)' : ''}`);

  const legacy = await prisma.itemMergeRule.findMany({
    where: { scientificCompanyId: null },
    select: { id: true, userId: true, fromName: true, toName: true },
  });
  console.log(`قواعد قديمة غير مُرحّلة: ${legacy.length}`);
  if (legacy.length === 0) return;

  // كتالوج كل شركة (cache) — { companyId → Map(normKey → item) }
  const catalogCache = new Map();
  async function getCatalog(companyId) {
    if (catalogCache.has(companyId)) return catalogCache.get(companyId);
    const items = await prisma.item.findMany({
      where: { scientificCompanyId: companyId, isTemp: false },
      select: { id: true, name: true },
    });
    const byKey = new Map();
    for (const it of items) { const k = normalizeItemKey(it.name); if (!byKey.has(k)) byKey.set(k, it); }
    catalogCache.set(companyId, byKey);
    return byKey;
  }

  // شركات كل مستخدم (cache)
  const userCompaniesCache = new Map();
  async function getUserCompanies(userId) {
    if (!userId) return [];
    if (userCompaniesCache.has(userId)) return userCompaniesCache.get(userId);
    const rows = await prisma.userCompanyAssignment.findMany({ where: { userId }, select: { companyId: true } });
    const ids = rows.map(r => r.companyId);
    userCompaniesCache.set(userId, ids);
    return ids;
  }

  let created = 0, skipped = 0, unresolved = 0, purged = 0;
  const migratedLegacyIds = [];

  for (const rule of legacy) {
    const companyIds = await getUserCompanies(rule.userId);
    if (companyIds.length === 0) { unresolved++; continue; }

    const fromKey = normalizeItemKey(rule.fromName);
    const toKey = normalizeItemKey(rule.toName);
    if (!fromKey || fromKey === toKey) { unresolved++; continue; }

    let resolvedInAny = false;
    for (const companyId of companyIds) {
      const catalog = await getCatalog(companyId);
      const target = catalog.get(toKey);
      if (!target) continue;               // toName غير موجود في كتالوج هذه الشركة
      resolvedInAny = true;

      const existing = await prisma.itemMergeRule.findUnique({
        where: { scientificCompanyId_fromKey: { scientificCompanyId: companyId, fromKey } },
        select: { id: true },
      });
      if (existing) { skipped++; continue; }

      if (DRY) {
        console.log(`  + [company ${companyId}] "${rule.fromName}" → "${target.name}" (item ${target.id})`);
      } else {
        await prisma.itemMergeRule.create({
          data: {
            fromKey, fromName: rule.fromName, toName: target.name,
            scientificCompanyId: companyId, toItemId: target.id,
            // قواعد الشركة بـ userId=null (القيد userId_fromKey للقواعد القديمة فقط)
          },
        });
      }
      created++;
    }

    if (resolvedInAny) migratedLegacyIds.push(rule.id);
    else unresolved++;
  }

  if (PURGE && !DRY && migratedLegacyIds.length > 0) {
    const del = await prisma.itemMergeRule.deleteMany({ where: { id: { in: migratedLegacyIds } } });
    purged = del.count;
  }

  console.log(`\nخلاصة: أنشئت ${created} · تخطّي ${skipped} · تعذّر ${unresolved} · حُذفت قديمة ${purged}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
