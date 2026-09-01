// One-off cleanup: remove bogus "Company" rows created from placeholder text
// (e.g. literal "null"/"N-A" cells in uploaded Excel files) that got treated
// as a real company name. Items pointing to them are unlinked (companyId =
// null) — their Sale rows are NOT touched, only the company classification.
import { PrismaClient } from '@prisma/client';

const PLACEHOLDER = new Set([
  'null', 'nul', 'n/a', 'n\\a', 'na', 'undefined', 'nan', 'none',
  '-', '--', '?', '؟', 'unknown', 'not available', 'not applicable',
  'غير محدد', 'غير معروف', 'بدون', 'لا يوجد',
]);
const isPlaceholder = (name) => PLACEHOLDER.has(String(name ?? '').trim().toLowerCase());

const p = new PrismaClient();
try {
  const companies = await p.company.findMany({ select: { id: true, name: true, userId: true } });
  const bogus = companies.filter(c => isPlaceholder(c.name));
  console.log(`Found ${companies.length} company rows total, ${bogus.length} bogus (placeholder-name):`, bogus);

  for (const c of bogus) {
    const items = await p.item.findMany({ where: { companyId: c.id }, select: { id: true, name: true } });
    console.log(`  company id=${c.id} name="${c.name}" userId=${c.userId} -> ${items.length} item(s) linked`);
    if (items.length > 0) {
      const upd = await p.item.updateMany({ where: { companyId: c.id }, data: { companyId: null } });
      console.log(`    unlinked ${upd.count} item(s)`);
    }
    await p.company.delete({ where: { id: c.id } });
    console.log(`    deleted company id=${c.id}`);
  }

  // Also check ScientificCompany (separate catalog-company model, used as the
  // fallback source for the "الشركة" breakdown when Item.companyId is unset).
  const sciCompanies = await p.scientificCompany.findMany({ select: { id: true, name: true, officeId: true } });
  const bogusSci = sciCompanies.filter(c => isPlaceholder(c.name));
  console.log(`Found ${sciCompanies.length} scientificCompany rows total, ${bogusSci.length} bogus:`, bogusSci);
  for (const c of bogusSci) {
    const items = await p.item.findMany({ where: { scientificCompanyId: c.id }, select: { id: true } });
    console.log(`  scientificCompany id=${c.id} name="${c.name}" -> ${items.length} item(s) linked (left as-is; not deleting scientificCompany automatically)`);
  }

  console.log('Done.');
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await p.$disconnect();
}
