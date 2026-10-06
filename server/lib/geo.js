// ════════════════════════════════════════════════════════════════════════════
// geo.js — أدوات المسافة بين إحداثيين (خط عرض/طول بالدرجات).
// تُستعمل لاحقاً لمقارنة موقع زيارة بموقع الطبيب/الصيدلية المسجَّل في السيرفي.
// ════════════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * المسافة بالأمتار بين نقطتين (صيغة هافرسين — دقيقة لمسافات المدينة).
 * @returns {number|null} null إذا كانت إحداثيات أي نقطة غير صالحة
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const points = [lat1, lng1, lat2, lng2].map(Number);
  if (points.some(v => !Number.isFinite(v))) return null;
  const [a1, o1, a2, o2] = points.map(toRad);
  const h = Math.sin((a2 - a1) / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin((o2 - o1) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
