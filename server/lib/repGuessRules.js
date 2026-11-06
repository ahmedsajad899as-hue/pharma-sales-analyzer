// ════════════════════════════════════════════════════════════════════════════
// repGuessRules.js — من يحقّ له أن يكون «المندوب العلمي» المقترَح لصف طلبية.
// قواعد نقية بلا قاعدة بيانات (npm run test:rep-guess) يستعملها
// attachScientificRepGuess في orders.service.js.
// ════════════════════════════════════════════════════════════════════════════

import { REP_ROLES } from './areaScope.js';

/**
 * سجلّ ScientificRepresentative لا يمثّل مندوباً: ensureLinkedRepId يُنشئ سجلاً لأي
 * حساب تُعيَّن له مناطق، ومنهم مدراء الشركات. مناطق ذلك السجلّ كانت تجعل المدير
 * مرشّحاً، ولو كان وحده في المنطقة حُسم مندوباً للطلبية.
 *
 * @param {string[]} linkedRoles أدوار الحسابات المرتبطة بالسجلّ
 * @param {string} nameKey repCoreKey لاسم السجلّ
 * @param {Set<string>} nonRepNameKeys أسماء الحسابات غير المندوبين في المكتب
 */
export function isManagementRepRecord(linkedRoles, nameKey, nonRepNameKeys) {
  if (linkedRoles.some(r => REP_ROLES.has(r))) return false;
  return linkedRoles.length > 0 || nonRepNameKeys.has(nameKey);
}

/**
 * فهرس أسماء المحافظات (وأسمائها البديلة) ← معرّفها.
 * @param {{id:number,name:string,aliases?:string|null}[]} provinces
 * @param {(s:string)=>string} normalize normalizeAreaName
 */
export function provinceIdByNameKey(provinces, normalize) {
  const map = new Map();
  for (const p of provinces || []) {
    let aliases = [];
    try { aliases = JSON.parse(p.aliases || '[]'); } catch { aliases = []; }
    for (const n of [p.name, ...(Array.isArray(aliases) ? aliases : [])]) {
      const k = normalize(String(n ?? ''));
      if (k && !map.has(k)) map.set(k, p.id);
    }
  }
  return map;
}

/**
 * النطاق الجغرافي لصف طلبية. طلبيات المحافظات كثيراً ما تكتب اسم المحافظة («النجف») لا
 * منطقة داخلها، فلا يطابق صفّ Area ويسقط فلتر المنطقة فيُقترح مندوبو بغداد. المنطقة
 * المطابقة تبقى الأولى: «القادسية» منطقة في الكرخ ومحافظة معاً.
 */
export function rowCoverage({ areaIds, areaKey, provinceByKey, areaIdsByProvince }) {
  if (areaIds.size > 0) return { areaIds, provinceId: null };
  const provinceId = areaKey ? (provinceByKey.get(areaKey) ?? null) : null;
  if (provinceId == null) return { areaIds, provinceId: null };
  return { areaIds: new Set(areaIdsByProvince.get(provinceId) || []), provinceId };
}

/** هل يغطّي المرشّح نطاق الصف؟ بمنطقة منه، أو بتعيين/فريق على المحافظة نفسها. */
export function candidateCoversRow(c, { areaIds, provinceId }) {
  if (provinceId != null && c.provinces?.has(provinceId)) return true;
  for (const id of areaIds) if (c.areas.has(id)) return true;
  return false;
}

/**
 * هل يمكن أن يكون هذا المرشّح صاحب الصنف؟ تعيين صريح لا يضمّ الصنف ينفي الملكية،
 * وغياب أي تعيين يعني «الكل». العلامة التجارية تكفي لأن الجرعة قد تكون صفّاً آخر.
 * صنف غير مربوط بالكتالوج لا يُنفى باسمه: القراءة قد تكون بتهجئة مختلفة.
 */
export function candidateOwnsItem(c, { itemId = null, itemKey = '', brand = '', sciId = null }) {
  if (sciId != null && c.allItemCompanies?.has(sciId)) return true;
  if (itemId != null && c.explicitItems.size > 0) {
    return c.explicitItems.has(itemId)
      || (itemKey && c.itemKeys.has(itemKey))
      || (brand && c.brands.has(brand))
      || false;
  }
  if (sciId != null && c.explicitItems.size === 0) {
    const assigned = c.companies.size + c.ownedCompanies.size;
    return assigned === 0 || c.companies.has(sciId) || c.ownedCompanies.has(sciId);
  }
  return true;
}
