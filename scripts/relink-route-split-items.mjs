/**
 * إعادة ربط لمرة واحدة: صفوف مبيع/ارجاع ربطها محرّك التوحيد بايتم كتالوج بطريقة
 * إعطاء خاطئة — «Daytrix 1g IV» رُبط بـ«Daytrix 1g IM» لأن الاسمين يختلفان بحرف
 * واحد فتجاوزا عتبة ليفنشتاين قبل إضافة حارس hasDifferentRoutes (fuzzyMatch.js).
 * فتُجمع مبيعات IV تحت IM في تحليل المبيعات.
 *
 * لكل ايتم كتالوج يحمل اسمه طريقة إعطاء، نقرأ اسم الايتم الخام من Sale.rawData؛
 * إن كان يُحلّ (alias/exact/high) إلى ايتم كتالوج آخر من نفس الشركة بطريقة
 * إعطاء مختلفة → نعيد ربط الصف به. البصمة (dedupKey v2) مبنية على النص الخام لا
 * itemId فلا تتأثّر.
 *
 * التشغيل:  node scripts/relink-route-split-items.mjs           (تجربة — لا يكتب شيئاً)
 *           node scripts/relink-route-split-items.mjs --apply
 */
import prisma from '../server/lib/prisma.js';
import { hasDifferentRoutes, routesOf } from '../server/lib/fuzzyMatch.js';
import { loadCompanyContext, resolveItemNameSync } from '../server/lib/itemResolver.js';

const APPLY = process.argv.includes('--apply');
const PAGE = 2000;
const hasRoute = (s) => routesOf(String(s).toLowerCase()).size > 0;

const routed = (await prisma.item.findMany({
  where: { isTemp: false, scientificCompanyId: { not: null } },
  select: { id: true, name: true, scientificCompanyId: true },
})).filter(it => hasRoute(it.name));

const byCompany = new Map();
for (const it of routed) {
  if (!byCompany.has(it.scientificCompanyId)) byCompany.set(it.scientificCompanyId, []);
  byCompany.get(it.scientificCompanyId).push(it);
}

let total = 0;
for (const [companyId, items] of byCompany) {
  const ctx = await loadCompanyContext([companyId]);
  for (const from of items) {
    const moves = new Map();   // toItemId → saleIds[]
    let cursor = 0;
    for (;;) {
      const rows = await prisma.sale.findMany({
        where: { itemId: from.id, id: { gt: cursor } },
        select: { id: true, rawData: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        let raw; try { raw = JSON.parse(row.rawData || '{}'); } catch { continue; }
        for (const v of Object.values(raw || {})) {
          if (typeof v !== 'string' || !hasRoute(v)) continue;
          const r = resolveItemNameSync(v, ctx);
          const to = r.canonicalItem;
          if (!to || to.id === from.id || !['alias', 'exact', 'high'].includes(r.confidence)) continue;
          if (!hasDifferentRoutes(from.name.toLowerCase(), to.name.toLowerCase())) continue;
          if (!moves.has(to.id)) moves.set(to.id, { name: to.name, ids: [] });
          moves.get(to.id).ids.push(row.id);
          break;
        }
      }
    }
    for (const [toId, { name, ids }] of moves) {
      console.log(`[company ${companyId}] «${from.name}» (#${from.id}) → «${name}» (#${toId}): ${ids.length} صف`);
      total += ids.length;
      if (APPLY) {
        for (let i = 0; i < ids.length; i += PAGE) {
          await prisma.sale.updateMany({ where: { id: { in: ids.slice(i, i + PAGE) } }, data: { itemId: toId } });
        }
      }
    }
  }
}
console.log(APPLY ? `✅ أُعيد ربط ${total} صف.` : `تجربة فقط: ${total} صف سيُعاد ربطه — أعد التشغيل مع --apply.`);
await prisma.$disconnect();
