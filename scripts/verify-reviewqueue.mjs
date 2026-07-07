// تحقق سريع: يشغّل استعلام طابور المراجعة + المحرّك على شركة لديها كتالوج.
import prisma from '../server/lib/prisma.js';
import { loadCompanyContext, resolveItemName } from '../server/lib/itemResolver.js';

const company = await prisma.scientificCompany.findFirst({
  where: { items: { some: { isTemp: false } } },
  select: { id: true, name: true },
});
if (!company) { console.log('لا توجد شركة بكتالوج'); process.exit(0); }

const userIds = (await prisma.userCompanyAssignment.findMany({ where: { companyId: company.id }, select: { userId: true } })).map(r => r.userId);
const tempsAll = await prisma.item.count({ where: { userId: { in: userIds }, isTemp: true } });
const temps = await prisma.item.findMany({
  where: { userId: { in: userIds }, isTemp: true },
  select: { id: true, name: true, user: { select: { displayName: true, username: true } }, _count: { select: { sales: true } } },
  orderBy: { name: 'asc' }, take: 8,
});

const ctx = await loadCompanyContext([company.id]);
console.log(`الشركة: ${company.name} (#${company.id}) · مستخدمون: ${userIds.length} · مؤقتات: ${tempsAll}`);
console.log('عيّنة من طابور المراجعة (أول 8):');
for (const t of temps) {
  const r = await resolveItemName(t.name, ctx);
  console.log(`  • "${t.name}"  →  ${r.confidence}${r.canonicalItem ? ' ⇒ ' + r.canonicalItem.name : ''}  (اقتراحات: ${r.suggestions.length}, مبيعات: ${t._count.sales})`);
}
process.exit(0);
