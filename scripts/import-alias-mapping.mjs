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

import 'dotenv/config';
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
  const companiesById = new Map();
  for (const c of companies) {
    const k = normalizeItemKey(c.name);
    if (!companyByKey.has(k)) companyByKey.set(k, []);
    companyByKey.get(k).push(c);
    companiesById.set(c.id, c);
  }

  // aliases شركة محفوظة مسبقاً — يُستخدَم كبديل لو اسم العمود الكانوني ما
  // طابق اسم شركة بالضبط (بدل ما نعتبره "غير موجود" رغم وجود alias يحلّه).
  const companyAliasByKey = new Map(); // normKey -> company
  for (const a of await prisma.companyAlias.findMany({ where: OFFICE_ID ? { officeId: OFFICE_ID } : {} })) {
    const c = companiesById.get(a.companyId);
    if (c && !companyAliasByKey.has(a.fromKey)) companyAliasByKey.set(a.fromKey, c);
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

  // فهرس عام لكل الكتالوج (كل الشركات) — تشخيصي فقط: لما ايتم كانوني ما يوجد
  // ضمن الشركة المحدَّدة بالصف، نتحقق هل هو موجود فعلاً بشركة أخرى بالتطبيق
  // (خطأ بعمود الشركة بالملف، أو الايتم مصنَّف بشركة مختلفة بالتطبيق حالياً).
  const allCompaniesById = new Map((await prisma.scientificCompany.findMany({ select: { id: true, name: true } })).map(c => [c.id, c.name]));
  const globalItemsByKey = new Map();
  for (const it of await prisma.item.findMany({ where: { isTemp: false }, select: { id: true, name: true, scientificCompanyId: true } })) {
    const k = normalizeItemKey(it.name);
    if (!globalItemsByKey.has(k)) globalItemsByKey.set(k, []);
    globalItemsByKey.get(k).push(it);
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
  const problems = { companyNotFound: new Map(), companyAmbiguous: new Map(), itemNotFound: new Map(), companyAliasConflict: new Map(), itemAliasConflict: new Map() };
  const CAP = 50;
  const bumpProblem = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const row of dataRows) {
    const [rawCompanyRaw, rawItemRaw, canonCompanyRaw, canonItemRaw] = row;
    const rawCompany = String(rawCompanyRaw ?? '').trim();
    const rawItem = String(rawItemRaw ?? '').trim();
    const canonCompany = String(canonCompanyRaw ?? '').trim();
    const canonItem = String(canonItemRaw ?? '').trim();

    if (!canonCompany) { summary.skippedEmptyRow++; continue; }
    summary.rowsProcessed++;

    const canonCompanyKey = normalizeItemKey(canonCompany);
    const hits = companyByKey.get(canonCompanyKey) || [];
    let company;
    if (hits.length === 1) {
      company = hits[0];
    } else if (hits.length === 0) {
      const aliased = companyAliasByKey.get(canonCompanyKey);
      if (!aliased) { summary.companyNotFound++; bumpProblem(problems.companyNotFound, canonCompany); continue; }
      company = aliased; // alias محفوظ يحل الاسم رغم عدم تطابقه لاسم شركة مباشرة
    } else {
      summary.companyAmbiguous++; bumpProblem(problems.companyAmbiguous, `${canonCompany} (${hits.length} شركات بنفس الاسم)`); continue;
    }

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
          bumpProblem(problems.companyAliasConflict, `"${rawCompany}" موجود مسبقاً → شركة أخرى (id=${existing.companyId})، المطلوب هنا: ${company.name} (id=${company.id})`);
        }
      }
    }

    // ── alias الايتم (عمود B → D) ──
    if (!rawItem) { summary.skippedEmptyItem++; continue; }
    const catalog = await getCatalog(company.id);
    const target = catalog.get(normalizeItemKey(canonItem));
    if (!target) {
      summary.itemNotFound++;
      const elsewhere = globalItemsByKey.get(normalizeItemKey(canonItem)) || [];
      const elsewhereOtherCompanies = elsewhere.filter(e => e.scientificCompanyId !== company.id);
      const msg = elsewhereOtherCompanies.length > 0
        ? `"${canonItem}" (شركة بالملف: ${company.name}) — موجود فعلاً لكن تحت شركة أخرى بالتطبيق: ${[...new Set(elsewhereOtherCompanies.map(e => allCompaniesById.get(e.scientificCompanyId) || e.scientificCompanyId))].join('، ')}`
        : `"${canonItem}" (شركة: ${company.name}) — غير موجود بالكتالوج إطلاقاً بأي شركة`;
      bumpProblem(problems.itemNotFound, msg);
      continue;
    }

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
    } else {
      // toItemId قابل لـ null (alias قديم بالاسم فقط) — نتحقق بالاسم أيضاً قبل
      // اعتباره تعارضاً، وإلا كل alias قديم بلا toItemId يُصنَّف تعارضاً خطأً.
      const sameTarget = existingRule.toItemId === target.id ||
        (existingRule.toItemId == null && normalizeItemKey(existingRule.toName || '') === normalizeItemKey(target.name));
      if (sameTarget) {
        summary.itemAliasUnchanged++;
      } else {
        summary.itemAliasConflict++;
        const existingLabel = existingRule.toItemId ? `"${existingRule.toName}" (id=${existingRule.toItemId})` : `"${existingRule.toName}" (بلا id، اسم فقط)`;
        bumpProblem(problems.itemAliasConflict, `"${rawItem}" (شركة: ${company.name}) موجود مسبقاً → ${existingLabel}، المطلوب هنا: ${target.name} (id=${target.id})`);
      }
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
    const entries = [...problems[key].entries()].sort((a, b) => b[1] - a[1]); // الأكثر تكراراً أولاً
    if (entries.length > 0) {
      console.log(`\n--- ${label} (${entries.length} قيمة فريدة${summary[key] > entries.length ? ` · ${summary[key]} صف` : ''}) ---`);
      for (const [msg, count] of entries.slice(0, CAP)) console.log(`  - ${msg}${count > 1 ? `  (×${count})` : ''}`);
      if (entries.length > CAP) console.log(`  ... و${entries.length - CAP} أخرى`);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
