/**
 * استيراد شامل لكتالوج الشركات والايتمات من ملف إكسل.
 *
 * خطوتان: preview يبني خطة مطابقة بلا أي كتابة، ثم commit يطبّق الخطة بعد
 * تعديل المدير. الفصل مقصود — الملف يخلط شركات موجودة وجديدة وأسماء تختلف
 * قليلاً، فالتطبيق المباشر كان سيُنشئ مكررات يصعب تراجعها.
 *
 * الواجهة تحلّل الإكسل وترسل الصفوف JSON (نفس نمط CompaniesPage)، فلا multer هنا.
 */

import prisma from '../../lib/prisma.js';
import { normalizeItemKey, loadCompanyContext, resolveItemName } from '../../lib/itemResolver.js';
import {
  extractCompanyFromCode, loadCompanyMatchContext, resolveCompanyName,
} from '../../lib/companyResolver.js';
import { mergeItems } from '../sales/sales.repository.js';

/** يقرأ سعراً من خلية قد تحمل "IQD 1,200" أو رقماً أو فراغاً. */
function parsePrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** يبني الايتمات المؤقتة مفهرسة بالمفتاح المطبَّع (قد يتكرر الاسم بين مستخدمين). */
async function loadTempItemIndex() {
  const temps = await prisma.item.findMany({
    where:  { isTemp: true },
    select: { id: true, name: true, userId: true, _count: { select: { sales: true } } },
  });
  const byKey = new Map();
  for (const t of temps) {
    const k = normalizeItemKey(t.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ id: t.id, name: t.name, userId: t.userId, salesCount: t._count?.sales ?? 0 });
  }
  // الأكثر مبيعات أولاً — هو الأجدر بالبقاء عند وجود أكثر من صف بنفس الاسم
  for (const list of byKey.values()) list.sort((a, b) => b.salesCount - a.salesCount);
  return byKey;
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/sa/catalog-import/preview
// body: { officeId, rows: [{ code, name, price }] }
// لا يكتب شيئاً — يُرجع خطة فقط.
// ════════════════════════════════════════════════════════════════════════════
export async function previewCatalogImport(req, res) {
  try {
    const officeId = parseInt(req.body?.officeId);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!Number.isInteger(officeId)) return res.status(400).json({ error: 'officeId مطلوب' });
    if (rows.length === 0) return res.status(400).json({ error: 'لا توجد صفوف في الملف' });

    const [companyCtx, tempIndex] = await Promise.all([
      loadCompanyMatchContext(officeId),
      loadTempItemIndex(),
    ]);

    // ── تجميع صفوف الملف حسب الشركة المستخرجة من العمود A ──────────────────
    const groups = new Map(); // extractedName -> rows[]
    let skippedRows = 0;
    for (const r of rows) {
      const itemName = String(r?.name ?? '').trim();
      const extracted = extractCompanyFromCode(r?.code);
      if (!itemName || !extracted) { skippedRows++; continue; }
      if (!groups.has(extracted)) groups.set(extracted, []);
      groups.get(extracted).push({ name: itemName, price: parsePrice(r?.price) });
    }

    const companies = [];
    for (const [extractedName, groupRows] of groups) {
      const m = resolveCompanyName(extractedName, companyCtx);

      // كتالوج الشركة يُحمَّل مرة واحدة لكل شركة ويُمرَّر لكل ايتم — بدونه
      // يُعيد resolveItemName الاستعلام لكل اسم.
      const itemCtx = m.company ? await loadCompanyContext([m.company.id]) : { catalog: [], catalogById: new Map(), aliasMap: new Map() };
      // loadCompanyContext يختار { id, name } فقط — نجلب الأسعار لعرض «القديم ← الجديد»
      const priceById = new Map();
      if (m.company) {
        const priced = await prisma.item.findMany({
          where:  { scientificCompanyId: m.company.id, isTemp: false },
          select: { id: true, price: true },
        });
        for (const p of priced) priceById.set(p.id, p.price);
      }

      const seenInFile = new Set();
      const items = [];
      for (const row of groupRows) {
        const key = normalizeItemKey(row.name);
        if (!key || seenInFile.has(key)) { skippedRows++; continue; } // تكرار داخل الملف نفسه
        seenInFile.add(key);

        const r = m.company ? await resolveItemName(row.name, itemCtx) : { canonicalItem: null, confidence: 'none', suggestions: [] };
        const temps = tempIndex.get(key) || [];

        // الترتيب مقصود: المطابقات القاطعة أولاً (alias/exact ثم الايتم المؤقت
        // بمفتاح مطابق تماماً)، وأي مطابقة ضبابية بعدها يؤكّده المدير — حتى
        // 'high' (مرشّح واحد) لأنها تخمين لا يقين، وقد ربطت «Win fast» بـ
        // «Potafast 50 mg» قبل تشديد المطابقة.
        let action, targetItemId = null, currentPrice = null, matchedName = null;
        if (r.canonicalItem && ['alias', 'exact'].includes(r.confidence)) {
          action = 'item-link';
          targetItemId = r.canonicalItem.id;
          matchedName = r.canonicalItem.name;
          currentPrice = priceById.get(r.canonicalItem.id) ?? null;
        } else if (temps.length > 0) {
          action = 'item-promote';           // ايتم مؤقت بنفس الاسم — يُرقّى بمبيعاته
          targetItemId = temps[0].id;
        } else if (r.confidence === 'high' || r.confidence === 'medium') {
          action = 'item-confirm';           // ضبابي — يؤكّده المدير قبل الربط
        } else {
          action = 'item-create';
        }

        items.push({
          name: row.name,
          price: row.price,
          action,
          targetItemId,
          matchedName,
          confidence: r.confidence,
          suggestions: (r.suggestions || []).slice(0, 6),
          tempCandidates: temps.slice(0, 3),
          currentPrice,
          priceChanged: action === 'item-link' && row.price != null && currentPrice != null && Number(currentPrice) !== Number(row.price),
        });
      }

      companies.push({
        extractedName,
        matched: m.company,
        confidence: m.confidence,
        suggestions: m.suggestions.slice(0, 6),
        itemCount: items.length,
        items,
      });
    }

    // الشركات المحتاجة قراراً أولاً — أعلى الشاشة
    const rank = c => (['alias', 'exact', 'high'].includes(c.confidence) ? 1 : 0);
    companies.sort((a, b) => rank(a) - rank(b) || a.extractedName.localeCompare(b.extractedName));

    res.json({
      success: true,
      data: {
        officeId,
        companies,
        totals: {
          fileRows: rows.length,
          skippedRows,
          companies: companies.length,
          items: companies.reduce((s, c) => s + c.items.length, 0),
        },
        existingCompanies: companyCtx.companies.map(c => ({ id: c.id, name: c.name })),
      },
    });
  } catch (err) {
    console.error('[catalog-import/preview]', err);
    res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/sa/catalog-import/commit
// body: { officeId, companies: [{ extractedName, action:'use'|'create'|'skip',
//         companyId?, newName?, rememberAlias?, items:[{ name, price, action, targetItemId? }] }] }
// ════════════════════════════════════════════════════════════════════════════
export async function commitCatalogImport(req, res) {
  try {
    const officeId = parseInt(req.body?.officeId);
    const groups = Array.isArray(req.body?.companies) ? req.body.companies : [];
    if (!Number.isInteger(officeId)) return res.status(400).json({ error: 'officeId مطلوب' });

    const summary = {
      companiesCreated: 0, companiesMatched: 0, aliasesSaved: 0,
      itemsCreated: 0, itemsPromoted: 0, itemsLinked: 0, itemsPriceUpdated: 0,
      skipped: 0, errors: [],
    };

    for (const g of groups) {
      const extractedName = String(g?.extractedName ?? '').trim();
      if (g?.action === 'skip') { summary.skipped += (g.items?.length ?? 0); continue; }

      // ── 1) الشركة الوجهة ────────────────────────────────────────────────
      let companyId = null;
      try {
        if (g?.action === 'create') {
          const newName = String(g?.newName ?? extractedName).trim();
          if (!newName) throw new Error('اسم الشركة الجديدة فارغ');
          // createCompany القائم بلا حارس تكرار ويعتمد على @@unique([name, officeId])
          // الذي يرمي P2002 غير معالَج — نحرس هنا بالاسم المطبَّع ونعيد استعمال
          // الموجود بدل الانفجار.
          const existing = await prisma.scientificCompany.findMany({
            where: { officeId }, select: { id: true, name: true },
          });
          const key = normalizeItemKey(newName);
          const dup = existing.find(c => normalizeItemKey(c.name) === key);
          if (dup) { companyId = dup.id; summary.companiesMatched++; }
          else {
            const created = await prisma.scientificCompany.create({
              data: { name: newName, officeId }, select: { id: true },
            });
            companyId = created.id;
            summary.companiesCreated++;
          }
        } else {
          companyId = parseInt(g?.companyId);
          if (!Number.isInteger(companyId)) throw new Error('لم تُحدَّد شركة');
          const exists = await prisma.scientificCompany.findUnique({ where: { id: companyId }, select: { id: true } });
          if (!exists) throw new Error('الشركة غير موجودة');
          summary.companiesMatched++;
        }
      } catch (e) {
        summary.errors.push(`الشركة «${extractedName}»: ${e.message}`);
        summary.skipped += (g.items?.length ?? 0);
        continue;
      }

      // ── 2) تذكّر قرار الربط ─────────────────────────────────────────────
      if (g?.rememberAlias && extractedName) {
        const fromKey = normalizeItemKey(extractedName);
        const target = await prisma.scientificCompany.findUnique({ where: { id: companyId }, select: { name: true } });
        // لا تحفظ ربطاً لاسم يطابق الشركة أصلاً — لا فائدة منه
        if (fromKey && target && normalizeItemKey(target.name) !== fromKey) {
          await prisma.companyAlias.upsert({
            where:  { officeId_fromKey: { officeId, fromKey } },
            update: { companyId, fromName: extractedName },
            create: { officeId, fromKey, fromName: extractedName, companyId },
          });
          summary.aliasesSaved++;
        }
      }

      // ── 3) الايتمات ─────────────────────────────────────────────────────
      for (const it of (g.items ?? [])) {
        const name = String(it?.name ?? '').trim();
        if (!name) { summary.skipped++; continue; }
        const price = it?.price == null ? null : Number(it.price);
        const action = it?.action;

        try {
          if (action === 'skip') { summary.skipped++; continue; }

          if (action === 'item-link' || action === 'item-confirm') {
            const targetId = parseInt(it?.targetItemId);
            if (!Number.isInteger(targetId)) { summary.skipped++; continue; }
            if (price != null) {
              await prisma.item.update({ where: { id: targetId }, data: { price } });
              summary.itemsPriceUpdated++;
            }
            summary.itemsLinked++;
            continue;
          }

          if (action === 'item-promote') {
            const tempId = parseInt(it?.targetItemId);
            if (!Number.isInteger(tempId)) { summary.skipped++; continue; }
            // ترقية نفس السجل — لا create — كي تبقى المبيعات المرتبطة سليمة.
            // نفس آلية action:'add' في طابور المراجعة.
            const key = normalizeItemKey(name);
            const catalog = await prisma.item.findMany({
              where: { scientificCompanyId: companyId, isTemp: false }, select: { id: true, name: true },
            });
            const exact = catalog.find(c => normalizeItemKey(c.name) === key);
            if (exact) {
              // الايتم موجود بالكتالوج مسبقاً → ادمج المؤقت فيه (تنتقل مبيعاته)
              await mergeItems(tempId, exact.id);
              if (price != null) { await prisma.item.update({ where: { id: exact.id }, data: { price } }); summary.itemsPriceUpdated++; }
              summary.itemsLinked++;
            } else {
              await prisma.item.update({
                where: { id: tempId },
                data:  { scientificCompanyId: companyId, isTemp: false, ...(price != null ? { price } : {}) },
              });
              summary.itemsPromoted++;
              if (price != null) summary.itemsPriceUpdated++;
            }
            continue;
          }

          if (action === 'item-create') {
            // @@unique([name, userId]) لا يمنع التكرار هنا لأن userId = null في
            // ايتمات الكتالوج (دلالة NULL في Postgres) — الحماية بالمقارنة المطبَّعة.
            const key = normalizeItemKey(name);
            const catalog = await prisma.item.findMany({
              where: { scientificCompanyId: companyId, isTemp: false }, select: { id: true, name: true },
            });
            const exact = catalog.find(c => normalizeItemKey(c.name) === key);
            if (exact) {
              if (price != null) { await prisma.item.update({ where: { id: exact.id }, data: { price } }); summary.itemsPriceUpdated++; }
              summary.itemsLinked++;
            } else {
              await prisma.item.create({
                data: { name, price, scientificCompanyId: companyId, isTemp: false },
              });
              summary.itemsCreated++;
            }
            continue;
          }

          summary.skipped++;
        } catch (e) {
          summary.errors.push(`«${name}»: ${e.message}`);
        }
      }
    }

    res.json({ success: true, summary });
  } catch (err) {
    console.error('[catalog-import/commit]', err);
    res.status(500).json({ error: err.message });
  }
}
