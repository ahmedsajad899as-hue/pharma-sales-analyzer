/**
 * import-alias-mapping.mjs
 * استيراد دفعة أسماء بديلة (شركة + ايتم) من ملف Excel، وربطها بأسماء موجودة
 * فعلاً بالكتالوج — لا يُنشئ أي شركة أو ايتم جديد، فقط يربط بالموجود.
 *
 * صيغة الملف المتوقّعة (4 أعمدة بالترتيب، بغض النظر عن نص الترويسة):
 *   A: اسم الشركة الخام (كما يرد بملف مرفوع)
 *   B: اسم الايتم الخام (كما يرد بملف مرفوع) — قد يكون فارغاً (يُتخطّى بصمت)
 *   C: اسم الشركة الصحيح (موجود فعلاً بالتطبيق)
 *   D: اسم الايتم الصحيح (موجود فعلاً بكتالوج تلك الشركة)
 * نقرأ بالموضع لا بعنوان الترويسة، لأن العمودين A وC غالباً يحملان نفس عنوان
 * "الشركة" — القراءة الافتراضية بـ xlsx (keyed by header) تفقد أحدهما.
 *
 * لا مطابقة ذكية (fuzzy) إطلاقاً على الأعمدة C/D — بيانات منسّقة يدوياً من
 * المستخدم، فتطابق تام بعد normalizeItemKey فقط، وإلا يُبلَّغ الصف كمشكلة.
 *
 * إضافي وغير هدّام بالكامل (idempotent):
 *   - لا upsert أبداً — findUnique ثم create فقط لو غائب.
 *   - قاعدة موجودة تشير لهدف آخر → تُترك كما هي، تُسجَّل كـ"تعارض" بالتقرير.
 *   - لا يحذف ولا يعدّل أي قاعدة موجودة مسبقاً مهما كانت.
 *
 * التشغيل:
 *   node scripts/import-alias-mapping.mjs <path.xlsx>                 # تشغيل فعلي
 *   node scripts/import-alias-mapping.mjs <path.xlsx> --dry-run       # عرض فقط بلا كتابة
 *   node scripts/import-alias-mapping.mjs <path.xlsx> --office=3      # يحصر مطابقة الشركة بمكتب معيّن
 *   node scripts/import-alias-mapping.mjs <path.xlsx> --no-company-aliases  # يعطّل aliases الشركة (عمود A→C)، يبقي أليسات الايتم فقط
 */

import prisma from '../server/lib/prisma.js';
import { normalizeItemKey } from '../server/lib/itemResolver.js';
import XLSX from 'xlsx';

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const INCLUDE_COMPANY_ALIASES = !args.includes('--no-company-aliases');
const officeArg = args.find(a => a.startsWith('--office='));
const OFFICE_ID = officeArg ? parseInt(officeArg.split('=')[1]) : null;

if (!filePath) {
  console.error('الاستخدام: node scripts/import-alias-mapping.mjs <path.xlsx> [--dry-run] [--office=N] [--no-company-aliases]');
  process.exit(1);
}

function printSample(rows) {
  console.log('عيّنة أول 3 صفوف (بعد تخطي الترويسة):');
  for (const r of rows.slice(0, 3)) console.log('  ', JSON.stringify(r));
}

async function main() {
  console.log(`import-alias-mapping  ${DRY ? '(DRY-RUN)' : ''}${OFFICE_ID ? ` (office=${OFFICE_ID})` : ''}${INCLUDE_COMPANY_ALIASES ? '' : ' (بدون company-aliases)'}`);
  console.log(`الملف: ${filePath}`);

  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const dataRows = allRows.slice(1); // الصف 0 = ترويسة
  console.log(`صفوف البيانات: ${dataRows.length}`);
  printSample(dataRows);

  const companies = await prisma.scientificCompany.findMany({
    where: OFFICE_ID ? { officeId: OFFICE_ID } : {},
    select: { id: true, name: true, officeId: true },
  });
  const companyByKey = new Map(); // normKey -> company[]
  for (const c of companies) {
    const k = normalizeItemKey(c.name);
    if (!companyByKey.has(k)) companyByKey.set(k, []);
    companyByKey.get(k).push(c);
  }

  const catalogCache = new Map(); // companyId -> Map(normKey -> item)
  async function getCatalog(companyId) {
    if (catalogCache.has(companyId)) return catalogCache.get(companyId);
    const items = await prisma.item.findMany({
      where: { scientificCompanyId: companyId, isTemp: false },
      select: { id: true, name: true },
    });
    const byKey = new Map();
    for (const it of items) {
      const k = normalizeItemKey(it.name);
      if (!byKey.has(k)) byKey.set(k, it); // أول تطابق يفوز عند تكرار المفتاح بنفس الكتالوج
    }
    catalogCache.set(companyId, byKey);
    return byKey;
  }

  const summary = {
    rowsProcessed: 0,
    skippedEmptyRow: 0,
    skippedEmptyItem: 0,
    companyNotFound: 0,
    companyAmbiguous: 0,
    companyAliasCreated: 0,
    companyAliasUnchanged: 0,
    companyAliasConflict: 0,
    itemNotFound: 0,
    itemAliasCreated: 0,
    itemAliasUnchanged: 0,
    itemAliasConflict: 0,
  };
  const problems = { companyNotFound: [], companyAmbiguous: [], itemNotFound: [], companyAliasConflict: [], itemAliasConflict: [] };
  const CAP = 50;
  const pushProblem = (list, row) => { if (list.length < CAP) list.push(row); };

  for (const row of dataRows) {
    const [rawCompanyRaw, rawItemRaw, canonCompanyRaw, canonItemRaw] = row;
    const rawCompany = String(rawCompanyRaw ?? '').trim();
    const rawItem = String(rawItemRaw ?? '').trim();
    const canonCompany = String(canonCompanyRaw ?? '').trim();
    const canonItem = String(canonItemRaw ?? '').trim();

    if (!canonCompany) { summary.skippedEmptyRow++; continue; }
    summary.rowsProcessed++;

    const hits = companyByKey.get(normalizeItemKey(canonCompany)) || [];
    if (hits.length === 0) { summary.companyNotFound++; pushProblem(problems.companyNotFound, canonCompany); continue; }
    if (hits.length > 1) { summary.companyAmbiguous++; pushProblem(problems.companyAmbiguous, `${canonCompany} (${hits.length} شركات بنفس الاسم)`); continue; }
    const company = hits[0];

    // ── alias الشركة (عمود A → C) ──
    if (INCLUDE_COMPANY_ALIASES && rawCompany) {
      const fromKey = normalizeItemKey(rawCompany);
      if (fromKey && fromKey !== normalizeItemKey(company.name)) {
        const existing = await prisma.companyAlias.findUnique({
          where: { officeId_fromKey: { officeId: company.officeId, fromKey } },
        });
        if (!existing) {
          if (!DRY) {
            await prisma.companyAlias.create({
              data: { officeId: company.officeId, fromKey, fromName: rawCompany, companyId: company.id },
            });
          }
          summary.companyAliasCreated++;
        } else if (existing.companyId === company.id) {
          summary.companyAliasUnchanged++;
        } else {
          summary.companyAliasConflict++;
          pushProblem(problems.companyAliasConflict, `"${rawCompany}" موجود مسبقاً → شركة أخرى (id=${existing.companyId})، المطلوب هنا: ${company.name} (id=${company.id})`);
        }
      }
    }

    // ── alias الايتم (عمود B → D) ──
    if (!rawItem) { summary.skippedEmptyItem++; continue; }
    const catalog = await getCatalog(company.id);
    const target = catalog.get(normalizeItemKey(canonItem));
    if (!target) { summary.itemNotFound++; pushProblem(problems.itemNotFound, `"${canonItem}" (شركة: ${company.name})`); continue; }

    const itemFromKey = normalizeItemKey(rawItem);
    if (!itemFromKey || itemFromKey === normalizeItemKey(target.name)) continue; // مطابق أصلاً، لا حاجة alias

    const existingRule = await prisma.itemMergeRule.findUnique({
      where: { scientificCompanyId_fromKey: { scientificCompanyId: company.id, fromKey: itemFromKey } },
    });
    if (!existingRule) {
      if (!DRY) {
        await prisma.itemMergeRule.create({
          data: { scientificCompanyId: company.id, fromKey: itemFromKey, fromName: rawItem, toName: target.name, toItemId: target.id },
        });
      }
      summary.itemAliasCreated++;
    } else if (existingRule.toItemId === target.id) {
      summary.itemAliasUnchanged++;
    } else {
      summary.itemAliasConflict++;
      pushProblem(problems.itemAliasConflict, `"${rawItem}" (شركة: ${company.name}) موجود مسبقاً → ايتم آخر (id=${existingRule.toItemId})، المطلوب هنا: ${target.name} (id=${target.id})`);
    }
  }

  console.log(`\n=== ملخص الاستيراد ${DRY ? '(DRY-RUN — لم يُكتب شيء)' : ''} ===`);
  console.log(`صفوف معالجة: ${summary.rowsProcessed}  ·  تخطّي (بلا شركة كانونية): ${summary.skippedEmptyRow}  ·  تخطّي (اسم ايتم خام فارغ): ${summary.skippedEmptyItem}`);
  console.log(`شركة:  أُنشئت ${summary.companyAliasCreated} · بلا تغيير ${summary.companyAliasUnchanged} · تعارض (تُرك كما هو) ${summary.companyAliasConflict} · غير موجودة ${summary.companyNotFound} · غامضة ${summary.companyAmbiguous}`);
  console.log(`ايتم:  أُنشئت ${summary.itemAliasCreated} · بلا تغيير ${summary.itemAliasUnchanged} · تعارض (تُرك كما هو) ${summary.itemAliasConflict} · الايتم الكانوني غير موجود بالكتالوج ${summary.itemNotFound}`);

  for (const [key, label] of [
    ['companyNotFound', 'شركات كانونية غير موجودة'],
    ['companyAmbiguous', 'شركات كانونية غامضة (أكثر من شركة بنفس الاسم)'],
    ['itemNotFound', 'ايتمات كانونية غير موجودة بالكتالوج'],
    ['companyAliasConflict', 'تعارضات alias الشركة'],
    ['itemAliasConflict', 'تعارضات alias الايتم'],
  ]) {
    if (problems[key].length > 0) {
      console.log(`\n--- ${label} (أول ${problems[key].length}${summary[key] > problems[key].length ? ` من ${summary[key]}` : ''}) ---`);
      for (const p of problems[key]) console.log('  -', p);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
