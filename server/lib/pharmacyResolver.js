// ════════════════════════════════════════════════════════════════════════════
// pharmacyResolver.js — ذاكرة الدمج اليدوي لأسماء الصيدليات + اقتراحات الدمج.
// ────────────────────────────────────────────────────────────────────────────
// المبدأ مأخوذ من areaResolver.js: القرار يُحسم مرة واحدة ويُحفظ، فلا يُعاد
// السؤال. الدمج = «اسم مبيع A هو نفسه اسم مبيع B» ويُخزَّن PharmacyAlias
// (fromKey → toKey). مدى الحفظ: حساب المستخدم الذي يعرض الصفحة (مثل Customer).
//
// - الاقتراحات تُحسب على أسماء المبيعات الحالية بتشابه الكلمات (Jaccard)، ولا
//   يُدمج شيء تلقائياً عدا التطابق التام للمفتاح (pharmacyKey).
// - الدمج لا يُكتب مباشرة في Sale: يُطبَّق عند تجميع المبيعات (scoped-sales)،
//   فيبقى المبيع الخام كما وصل من الملف، ويُفك الدمج بحذف سطر واحد.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { pharmacyKey } from './pharmacyKey.js';

const SUGGEST_MIN_JACCARD = 0.5;

/**
 * خريطة fromKey → { toKey, toName } لحساب المستخدم.
 * إن كان الجدول غير موجود بعد (لم يُنشأ على قاعدة الإنتاج) نُرجع خريطة فارغة،
 * فيعمل تحليل الصيدليات كما كان قبل الدمج بدل أن يتعطّل بالكامل.
 */
export async function loadPharmacyAliasMap(userId) {
  try {
    const rows = await prisma.pharmacyAlias.findMany({
      where: { userId },
      select: { id: true, fromKey: true, fromName: true, toKey: true, toName: true },
    });
    return new Map(rows.map(r => [r.fromKey, r]));
  } catch (e) {
    if (!loadPharmacyAliasMap.warned) {
      loadPharmacyAliasMap.warned = true;
      console.warn('[pharmacy-alias] الجدول غير متاح — يُتجاهل الدمج اليدوي:', e.message);
    }
    return new Map();
  }
}

/**
 * يدمج صيدلية «من» داخل صيدلية «إلى». يتبع السلاسل: إن كانت «إلى» مدمجة أصلاً
 * في غيرها، يُدمج الاسم في الهدف النهائي. ويُعاد توجيه الأسماء التي كانت تشير
 * إلى «من» كي لا تبقى سلسلة مكسورة.
 *
 * @returns {Promise<{merged: boolean, toName?: string, reason?: string}>}
 */
export async function mergePharmacyAlias({ userId, fromName, toName }) {
  const fromKey0 = pharmacyKey(fromName);
  const toKey0   = pharmacyKey(toName);
  if (!fromKey0 || !toKey0) return { merged: false, reason: 'empty' };

  const map = await loadPharmacyAliasMap(userId);
  const hop = map.get(toKey0);
  const toKey  = hop ? hop.toKey : toKey0;
  const finalName = hop ? hop.toName : String(toName).trim();
  if (fromKey0 === toKey) return { merged: false, reason: 'same' };

  await prisma.$transaction([
    prisma.pharmacyAlias.upsert({
      where:  { userId_fromKey: { userId, fromKey: fromKey0 } },
      create: { userId, fromKey: fromKey0, fromName: String(fromName).trim(), toKey, toName: finalName },
      update: { toKey, toName: finalName },
    }),
    prisma.pharmacyAlias.updateMany({
      where: { userId, toKey: fromKey0 },
      data:  { toKey, toName: finalName },
    }),
  ]);
  return { merged: true, toName: finalName };
}

/** فكّ دمج: يحذف سطر الدمج فقط، ولا يمسّ المبيعات الخام. */
export async function removePharmacyAlias({ userId, id }) {
  const { count } = await prisma.pharmacyAlias.deleteMany({ where: { id, userId } });
  return count > 0;
}

/**
 * اقتراحات دمج بين صيدليات مبيعات حالية (groups: [{key, name, orders, value}]).
 * يقارن الكلمات لا الحروف، فيلتقط «الامل» و«الامل الجديدة» و«نور» و«نور الهدى».
 * لا يُرجع إلا الأزواج المتشابهة بعتبة Jaccard ≥ 0.5، مرتّبةً بالأقوى ثم الأكثر طلبيات.
 */
export function suggestPharmacyMerges(groups, limit = 40) {
  const byKey = new Map(groups.map(g => [g.key, g]));
  const tokens = new Map(groups.map(g => [g.key, new Set(g.key.split(' '))]));
  const index = new Map(); // كلمة → مفاتيح تحتويها
  for (const g of groups) {
    for (const t of tokens.get(g.key)) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(g.key);
    }
  }

  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const A = tokens.get(g.key);
    const cand = new Set();
    for (const t of A) for (const k of index.get(t) || []) if (k !== g.key) cand.add(k);
    for (const k of cand) {
      const pairId = g.key < k ? `${g.key}|${k}` : `${k}|${g.key}`;
      if (seen.has(pairId)) continue;
      seen.add(pairId);
      const B = tokens.get(k);
      let inter = 0;
      for (const t of A) if (B.has(t)) inter++;
      const score = inter / (A.size + B.size - inter);
      if (score < SUGGEST_MIN_JACCARD) continue;
      out.push({ score: Math.round(score * 100) / 100, a: g, b: byKey.get(k) });
    }
  }
  out.sort((x, y) => y.score - x.score || (y.a.orders + y.b.orders) - (x.a.orders + x.b.orders));
  return out.slice(0, limit);
}
