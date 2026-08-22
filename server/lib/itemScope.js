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
