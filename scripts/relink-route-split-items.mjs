/**
 * إعادة ربط لمرة واحدة: صفوف مبيع/ارجاع رُبطت بايتم بطريقة إعطاء خاطئة —
 * «Daytrix 1g IV» مربوط بـ«Daytrix 1g IM» فتُجمع مبيعات IV تحت IM في تحليل
 * المبيعات. سببان (أُصلحا في fuzzyMatch.js / itemResolver.js):
 *   - الاسمان يختلفان بحرف واحد فتجاوزا عتبة ليفنشتاين (قبل حارس hasDifferentRoutes).
 *   - قاعدة توحيد قديمة IV → IM (من دمج سابق) كانت تسبق التطابق التام.
 *
 * 1) يحذف قواعد التوحيد التي تربط اسماً بهدف بطريقة إعطاء مختلفة.
 * 2) لكل ايتم يحمل اسمه طريقة إعطاء: يقرأ اسم الايتم الخام من Sale.rawData، فإن
 *    كانت طريقة إعطائه تخالف الايتم المربوط → يبحث في نفس النطاق (نفس الشركة
 *    العلمية، أو نفس المستخدم لايتم بلا شركة) عن ايتم مطابق تماماً بالمفتاح، وإلا
 *    عن مرشّح ضبابي وحيد بنفس طريقة الإعطاء → يعيد ربط الصف به.
 * البصمة (dedupKey v2) مبنية على النص الخام لا itemId فلا تتأثّر.
 *
 * التشغيل:  node scripts/relink-route-split-items.mjs           (تجربة — لا يكتب شيئاً)
 *           node scripts/relink-route-split-items.mjs --apply
 */
import prisma from '../server/lib/prisma.js';
import { hasDifferentRoutes, routesOf, areSimilar, normalizeStr } from '../server/lib/fuzzyMatch.js';
import { normalizeItemKey } from '../server/lib/itemResolver.js';

const APPLY = process.argv.includes('--apply');
const PAGE = 2000;
const low = (s) => normalizeStr(String(s ?? ''));
const hasRoute = (s) => routesOf(low(s)).size > 0;

// ── 1) قواعد توحيد متعارضة الطريقة ──────────────────────────────────────────────
const rules = await prisma.itemMergeRule.findMany({
  select: { id: true, fromName: true, fromKey: true, toName: true, scientificCompanyId: true, userId: true },
});
const badRules = rules.filter(r => hasDifferentRoutes(low(r.fromName || r.fromKey), low(r.toName)));
for (const r of badRules) console.log(`قاعدة متعارضة #${r.id} [company ${r.scientificCompanyId ?? '-'} user ${r.userId ?? '-'}]: «${r.fromName || r.fromKey}» → «${r.toName}»`);
if (APPLY && badRules.length) await prisma.itemMergeRule.deleteMany({ where: { id: { in: badRules.map(r => r.id) } } });

// ── 2) إعادة ربط الصفوف ─────────────────────────────────────────────────────────
const allItems = await prisma.item.findMany({
  where: { isTemp: false },
  select: { id: true, name: true, scientificCompanyId: true, userId: true },
});
const scopeOf = (it) => it.scientificCompanyId ? `c${it.scientificCompanyId}` : `u${it.userId}`;
const byScope = new Map();
for (const it of allItems) {
  const s = scopeOf(it);
  if (!byScope.has(s)) byScope.set(s, []);
  byScope.get(s).push(it);
}

function findTarget(rawName, from) {
  const peers = (byScope.get(scopeOf(from)) || []).filter(p => p.id !== from.id);
  const key = normalizeItemKey(rawName);
  const exact = peers.find(p => normalizeItemKey(p.name) === key);
  if (exact) return exact;
  const v = low(rawName);
  const fuzzy = peers.filter(p => {
    const pn = low(p.name);
    return hasRoute(pn) && !hasDifferentRoutes(v, pn) && areSimilar(v, pn);
  });
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

let total = 0;
for (const from of allItems.filter(it => hasRoute(it.name))) {
  const fromLow = low(from.name);
  const moves = new Map();   // toItemId → { name, ids[] }
  const unresolved = new Map(); // rawName → count
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
      // قيمة خام تحمل طريقة إعطاء مخالفة وتشبه اسم الايتم المربوط (بلا طريقة الإعطاء)
      const v = Object.values(raw || {}).find(x =>
        typeof x === 'string' && hasRoute(x) && hasDifferentRoutes(low(x), fromLow));
      if (!v) continue;
      const to = findTarget(v, from);
      if (!to) { unresolved.set(v, (unresolved.get(v) || 0) + 1); continue; }
      if (!moves.has(to.id)) moves.set(to.id, { name: to.name, ids: [] });
      moves.get(to.id).ids.push(row.id);
    }
  }
  for (const [toId, { name, ids }] of moves) {
    console.log(`[${scopeOf(from)}] «${from.name}» (#${from.id}) → «${name}» (#${toId}): ${ids.length} صف`);
    total += ids.length;
    if (APPLY) {
      for (let i = 0; i < ids.length; i += PAGE) {
        await prisma.sale.updateMany({ where: { id: { in: ids.slice(i, i + PAGE) } }, data: { itemId: toId } });
      }
    }
  }
  for (const [v, n] of unresolved) console.log(`  ⚠️ [${scopeOf(from)}] «${from.name}»: ${n} صف خامه «${v}» بلا ايتم مقابل في النطاق`);
}
console.log(APPLY
  ? `✅ حُذفت ${badRules.length} قاعدة متعارضة، وأُعيد ربط ${total} صف.`
  : `تجربة فقط: ${badRules.length} قاعدة متعارضة، ${total} صف سيُعاد ربطه — أعد التشغيل مع --apply.`);
await prisma.$disconnect();
