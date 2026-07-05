// تشخيص سريع لحالة بيانات الايتمات (يتحقق أيضاً أن حقول المخطط الجديدة قابلة للاستعلام).
import prisma from '../server/lib/prisma.js';

const [companies, catalogItems, tempItems, rulesAll, rulesCompany, rulesLegacy, withToItem] = await Promise.all([
  prisma.scientificCompany.count(),
  prisma.item.count({ where: { isTemp: false, scientificCompanyId: { not: null } } }),
  prisma.item.count({ where: { isTemp: true } }),
  prisma.itemMergeRule.count(),
  prisma.itemMergeRule.count({ where: { scientificCompanyId: { not: null } } }),
  prisma.itemMergeRule.count({ where: { scientificCompanyId: null } }),
  prisma.itemMergeRule.count({ where: { toItemId: { not: null } } }),
]);

// كم شركة لديها كتالوج فعلي
const byCompany = await prisma.item.groupBy({
  by: ['scientificCompanyId'],
  where: { isTemp: false, scientificCompanyId: { not: null } },
  _count: { id: true },
});

console.log(JSON.stringify({
  scientificCompanies: companies,
  companiesWithCatalog: byCompany.length,
  catalogItems,
  tempItems,
  aliasRules: { total: rulesAll, companyScoped: rulesCompany, legacyPerUser: rulesLegacy, withToItemId: withToItem },
}, null, 2));

process.exit(0);
