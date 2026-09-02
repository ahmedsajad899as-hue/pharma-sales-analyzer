// ════════════════════════════════════════════════════════════════════════════
// itemScope.js — نطاق ايتمات المستخدم (UserItemAssignment) للمبيعات والإرجاع
// ────────────────────────────────────────────────────────────────────────────
// تبويب «الايتمات» في صفحة المستخدم يقول صراحةً: «إذا اخترت ايتمات، يعمل
// المستخدم عليها فقط». لكن UserItemAssignment كان يُقرأ في قوائم الايتمات
// والقوائم المنسدلة فقط — ولا يُفلتر به أي صف Sale. فكان التعيين بلا أثر على
// أرقام المبيع والإرجاع. هذا الملف يوفّر النطاق ليُطبَّق في تقارير المبيعات.
//
// دلالة مقصودة: قائمة فارغة = بلا تقييد (كل الايتمات) — لا «صفر ايتم».
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeItemKey } from './itemResolver.js';
import { ensureLinkedRepId, REP_ROLES } from './areaScope.js';

/**
 * معرّفات الايتمات التي يُسمح للمستخدم برؤيتها في المبيعات/الإرجاع.
 *
 * التوسيع بالاسم ضروري وليس تجميلاً: نفس الدواء موجود كصفوف Item متعددة
 * (ايتم كتالوج، وايتمات مؤقتة تُنشأ عند رفع كل ملف، وصفوف لكل حساب). قياس على
 * بيانات الإنتاج: 50 ايتماً معيّناً تطابق 3451 مبيعة بالمعرّفات المباشرة،
 * و3610 بعد التوسيع بالاسم — أي أن الفلترة الخام كانت ستُسقِط مبيعات حقيقية.
 * التطبيع يحافظ على الجرعة (AIRTIDE 100 لا يساوي AIRTIDE 500).
 *
 * @param {number|null} userId
 * @returns {Promise<number[]|null>} null = بلا تقييد
 */
export async function resolveEffectiveItemIds(userId) {
  if (!userId) return null;

  const assigned = await prisma.userItemAssignment.findMany({
    where:  { userId },
    select: { itemId: true, item: { select: { name: true } } },
  });
  if (assigned.length === 0) return null; // فارغة = كل الايتمات

  const wantedKeys = new Set(
    assigned.map(a => normalizeItemKey(a.item?.name || '')).filter(Boolean),
  );
  const directIds = assigned.map(a => a.itemId);
  if (wantedKeys.size === 0) return [...new Set(directIds)];

  const allItems = await prisma.item.findMany({ select: { id: true, name: true } });
  const matchingIds = allItems
    .filter(i => wantedKeys.has(normalizeItemKey(i.name || '')))
    .map(i => i.id);

  return [...new Set([...directIds, ...matchingIds])];
}

/**
 * شرط Prisma جاهز للدمج في where الخاص بـ Sale.
 * @returns {Promise<object>} {} إن لم يكن هناك تقييد
 */
export async function buildItemScopeFilter(userId) {
  const ids = await resolveEffectiveItemIds(userId);
  if (!ids) return {};
  // مصفوفة فارغة مستحيلة هنا (المعرّفات المباشرة تُضمَّن دائماً)، لكن لو حدثت
  // فالمقصود «لا شيء» لا «الكل».
  return { itemId: { in: ids } };
}

/**
 * كتالوج ايتمات المستخدم المسموح بها (UserItemAssignment) — نفس التوسيع
 * بالاسم القانوني المستعمل في resolveEffectiveItemIds، لكن يُرجع {id,name}[]
 * كاملة بدل معرّفات فقط، لاستعمالها كـ«كتالوج» مطابقة (resolveItemName) عند
 * تصفية/توحيد الايتمات المستخرجة من صور الفواتير على ايتمات المستخدم فقط.
 *
 * فارغة = بلا تقييد (نفس اصطلاح resolveEffectiveItemIds — تعيين فارغ لا يعني
 * صفر ايتمات).
 *
 * @param {number|null} userId
 * @returns {Promise<{id:number,name:string}[]|null>} null = بلا تقييد
 */
/**
 * يُرآة UserItemAssignment داخل ScientificRepItem الخاص بالمندوب المرتبط —
 * نفس فكرة syncUserAreaDerivedLinks (areaScope.js) لكن للايتمات. صفحة
 * «المناديب العلميين» (ScientificRepsPage) تعرض ايتمات المندوب من
 * ScientificRepItem وحده — لا من UserItemAssignment — فبقي التعيين وقت
 * الإنشاء (استيراد إكسل أو setUserItems) بلا أثر على تلك الشاشة حتى يفتحها
 * أحد ويضبط الايتمات يدوياً من جديد. الفلترة الفعلية للمبيعات/التقارير
 * (resolveEffectiveItemIds أعلاه) تقرأ UserItemAssignment مباشرة فتبقى صحيحة
 * دوماً — هذه الدالة تُصلح فقط ما تعرضه الشاشة.
 *
 * @param {number} userId
 */
export async function syncUserItemDerivedLinks(userId) {
  const repId = await ensureLinkedRepId(userId, { onlyRoles: REP_ROLES });
  if (!repId) return { synced: false };

  const itemIds = (await prisma.userItemAssignment.findMany({
    where: { userId }, select: { itemId: true },
  })).map(r => r.itemId);

  await prisma.$transaction([
    prisma.scientificRepItem.deleteMany({ where: { scientificRepId: repId } }),
    ...(itemIds.length ? [prisma.scientificRepItem.createMany({
      data: itemIds.map(itemId => ({ scientificRepId: repId, itemId })),
      skipDuplicates: true,
    })] : []),
  ]);

  return { synced: true, itemCount: itemIds.length };
}

export async function getAssignedItemsCatalog(userId) {
  if (!userId) return null;
  const assigned = await prisma.userItemAssignment.findMany({
    where:  { userId },
    select: { item: { select: { id: true, name: true } } },
  });
  if (assigned.length === 0) return null;

  const directItems = assigned.map(a => a.item).filter(Boolean);
  const wantedKeys = new Set(directItems.map(i => normalizeItemKey(i.name || '')).filter(Boolean));
  const allItems = wantedKeys.size > 0
    ? await prisma.item.findMany({ where: { isTemp: false }, select: { id: true, name: true } })
    : [];

  const seen = new Set();
  const catalog = [];
  for (const it of [...directItems, ...allItems.filter(i => wantedKeys.has(normalizeItemKey(i.name || '')))]) {
    const k = normalizeItemKey(it.name || '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    catalog.push(it);
  }
  return catalog;
}
