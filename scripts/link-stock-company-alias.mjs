/**
 * link-stock-company-alias.mjs
 * يوحّد اسمي شركة مختلفَي التهجئة عبر ملفات الستوك (اسم نص حر بلا FK) — لكل حساب
 * لديه أحد الاسمين في بياناته، عبر ثلاثة مصادر: StockMovement.companyName،
 * StockBalance.companyName، وSalesDataFile.rows (عمود الشركة المُكتشَف بـ detectCompanyCol).
 *
 * لكل حساب مُتأثِّر:
 *   - يجد/ينشئ Company باسم --to (كتالوج الستوك البسيط الخاص بالمستخدم، مستقل عن
 *     ScientificCompany — راجع stock-ledger.service.js/getAllCompanies).
 *   - يحفظ/يحدّث StockCompanyNameLink(userId, fromKey) → companyId (نفس آلية
 *     saveStockCompanyNameLinks — يُطبَّق فوراً على قراءة صفحة Stock عبر
 *     loadCompanyLabelResolver، ووقت الاستيعاب القادم لرصيد المذاخر).
 *   - يُعيد تسمية StockMovement/StockBalance.companyName الموجودة فعلياً (--to بدل
 *     --from) — الرابط وحده لا يُصحِّح صفوف مُستوعَبة سابقاً بالاسم الخام.
 *   - SalesDataFile.rows لا يُعدَّل (الملف المرفوع الأصلي يبقى كما هو — التوحيد عند
 *     القراءة فقط عبر applyCompanyLabelsToFiles).
 *
 * غير هدّام وقابل لإعادة التشغيل (idempotent).
 *
 * الاستعمال على الخادم:
 *   node scripts/link-stock-company-alias.mjs --from "REMASEEygptN/A" --to "Marcyrl"
 *   node scripts/link-stock-company-alias.mjs --from "..." --to "..." --dry-run
 */

import prisma from '../server/lib/prisma.js';
import { normalizeItemKey } from '../server/lib/itemResolver.js';
import { asArray, detectCompanyCol } from '../server/lib/stockMatrix.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const getArg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const FROM = getArg('--from');
const TO = getArg('--to');

if (!FROM || !TO) {
  console.error('الاستعمال: node scripts/link-stock-company-alias.mjs --from "الاسم القديم" --to "الاسم الموحَّد" [--dry-run]');
  process.exit(1);
}

const fromKey = normalizeItemKey(FROM);
const toKey = normalizeItemKey(TO);

async function findAffectedUserIds() {
  const ids = new Set();

  const movements = await prisma.stockMovement.findMany({
    where: { companyName: FROM }, select: { userId: true }, distinct: ['userId'],
  });
  movements.forEach(m => ids.add(m.userId));

  const balances = await prisma.stockBalance.findMany({
    where: { companyName: FROM }, select: { userId: true }, distinct: ['userId'],
  });
  balances.forEach(b => ids.add(b.userId));

  // SalesDataFile.rows نص/JSON حر — لا فهرس على قيم الأعمدة، فنفحص كل الملفات.
  const files = await prisma.salesDataFile.findMany({ select: { userId: true, fixedCols: true, rows: true } });
  for (const f of files) {
    const fixedCols = asArray(f.fixedCols);
    const companyCol = detectCompanyCol(fixedCols);
    if (!companyCol) continue;
    const rows = asArray(f.rows);
    if (rows.some(r => String(r?.[companyCol] ?? '').trim() === FROM)) ids.add(f.userId);
  }

  return [...ids];
}

async function main() {
  console.log(`link-stock-company-alias: "${FROM}" → "${TO}"  ${DRY ? '(DRY-RUN)' : ''}`);

  const userIds = await findAffectedUserIds();
  console.log(`حسابات متأثرة: ${userIds.length}`);
  if (userIds.length === 0) return;

  let companiesCreated = 0, linksUpserted = 0, movementsRenamed = 0, balancesRenamed = 0;

  for (const userId of userIds) {
    const existingCompanies = await prisma.company.findMany({ where: { userId }, select: { id: true, name: true } });
    let company = existingCompanies.find(c => normalizeItemKey(c.name) === toKey) ?? null;

    if (!company) {
      console.log(`  [user ${userId}] إنشاء Company "${TO}"`);
      if (!DRY) company = await prisma.company.create({ data: { userId, name: TO } });
      companiesCreated++;
    } else {
      console.log(`  [user ${userId}] Company "${TO}" موجودة فعلاً (#${company.id})`);
    }

    const companyId = company?.id ?? null;
    console.log(`  [user ${userId}] StockCompanyNameLink "${FROM}" → companyId=${companyId}`);
    if (!DRY) {
      await prisma.stockCompanyNameLink.upsert({
        where: { userId_fromKey: { userId, fromKey } },
        update: { fromName: FROM, companyId },
        create: { userId, fromKey, fromName: FROM, companyId },
      });
    }
    linksUpserted++;

    if (DRY) {
      const [mc, bc] = await Promise.all([
        prisma.stockMovement.count({ where: { userId, companyName: FROM } }),
        prisma.stockBalance.count({ where: { userId, companyName: FROM } }),
      ]);
      if (mc || bc) console.log(`  [user ${userId}] سيُعاد تسمية ${mc} حركة و${bc} رصيد`);
      movementsRenamed += mc;
      balancesRenamed += bc;
    } else {
      const rm = await prisma.stockMovement.updateMany({ where: { userId, companyName: FROM }, data: { companyName: TO } });
      const rb = await prisma.stockBalance.updateMany({ where: { userId, companyName: FROM }, data: { companyName: TO } });
      movementsRenamed += rm.count;
      balancesRenamed += rb.count;
    }
  }

  console.log(`\nخلاصة: حسابات ${userIds.length} · شركات أُنشئت ${companiesCreated} · روابط ${linksUpserted} · حركات أُعيدت تسميتها ${movementsRenamed} · أرصدة أُعيدت تسميتها ${balancesRenamed}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
