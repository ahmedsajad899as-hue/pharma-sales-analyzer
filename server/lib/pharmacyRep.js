// ════════════════════════════════════════════════════════════════════════════
// pharmacyRep.js — «مندوب الفارمسي لاين» (طلب 2026-10-22).
// ────────────────────────────────────────────────────────────────────────────
// مندوب يدخل الصيدليات فقط (بلا أطباء) ويعمل طلبيات عبر المذاخر أو المكتب.
// هو سجل ScientificRepresentative عادي بحساب scientific_rep/team_leader — فكل
// الصفحات والبوت وملف الكوديشن تعمل له كما هي — مع repKind='pharmacy'.
// الفرق كله في نسب المبيعات (resolveSciRepSales):
//   • ميركاتو: الصفوف التي تحمل اسمه — كالعلمي تماماً.
//   • ملف المكتب: «معلومات الزبون» = إحدى تسمياته (فارمسي لاين / فارماسي…)
//     ∩ مناطقه ∩ ايتماته — بلا شرط المندوب التجاري.
//   • تيم ليدر فارمسي = مجموع مندوبيه (كل مندوب بتسمياته ومناطقه وايتماته).
// صفوف الفارماسي تبقى محسوبة للعلميين كما هي (قرار المستخدم)، وصف يطابق
// مندوبَي فارمسي يُحسب للاثنين.
// ════════════════════════════════════════════════════════════════════════════

import { normalizeArabic } from './itemResolver.js';

export const PHARMACY_KIND = 'pharmacy';

// بلا تسميات محدّدة: كل قيمة «معلومات زبون» تحوي فارم/فرماس/pharm أو «لاين».
// أخطاء الكتابة الفعلية في ملف المكتب (2026-10-23): فرامسي لاين، فارسمي لاين،
// فارمسي لابين — بدونها سقطت صفوف فارمسي حقيقية من المندوب.
const DEFAULT_LABEL_FRAGMENTS = ['فارم', 'فرماس', 'فرمس', 'فرام', 'فارسم', 'لاين', 'لابين', 'pharm'];

export function isPharmacyRep(rep) {
  return rep?.repKind === PHARMACY_KIND;
}

/**
 * قسم المندوب (الكرخ/الرصافة — SubProvince): قسم مُسنَد لحسابه كاملاً أولاً، وإلا
 * الأكثر بين مناطقه المعيّنة (Area.subProvince). null = بلا قسم.
 */
export function repSideOf(assignedNames = [], areaSideNames = []) {
  const assigned = [...new Set(assignedNames.filter(Boolean))];
  if (assigned.length === 1) return assigned[0];
  const counts = new Map();
  for (const n of areaSideNames) if (n && (!assigned.length || assigned.includes(n))) counts.set(n, (counts.get(n) || 0) + 1);
  let best = null, bestN = 0;
  for (const [n, c] of counts) if (c > bestN) { best = n; bestN = c; }
  return best ?? assigned[0] ?? null;
}

/** نص التسمية بنفس تطبيع Sale.customerInfoNorm (normalizeArabic عند الرفع). */
export function normalizeCustomerInfoLabel(s) {
  const v = String(s ?? '').trim();
  return v ? normalizeArabic(v) : '';
}

/** Sale.customerInfoNorm قيمة تبدو فارماسي؟ لاقتراح التسميات في الواجهة. */
export function looksLikePharmacyInfo(norm) {
  const v = String(norm ?? '').toLowerCase();
  return DEFAULT_LABEL_FRAGMENTS.some(f => v.includes(f));
}

/** JSON المخزَّن ← مصفوفة تسميات مطبَّعة فريدة. */
export function parseCustomerInfoLabels(json) {
  if (!json) return [];
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(normalizeCustomerInfoLabel).filter(Boolean))];
}

/** مصفوفة من الواجهة ← JSON للتخزين (null = الافتراضي). */
export function serializeCustomerInfoLabels(arr) {
  const clean = [...new Set((Array.isArray(arr) ? arr : []).map(normalizeCustomerInfoLabel).filter(Boolean))];
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * شرط Prisma على Sale.customerInfoNorm. التسميات تُطابَق كقيمة كاملة (لا
 * «يحتوي»)، كي لا تبتلع «فارماسي» صفوف «فارماسي لاين» لمندوب آخر.
 */
export function customerInfoLabelsWhere(labels) {
  const list = Array.isArray(labels) ? labels.filter(Boolean) : [];
  if (list.length) {
    return { OR: list.map(l => ({ customerInfoNorm: { equals: l, mode: 'insensitive' } })) };
  }
  return { OR: DEFAULT_LABEL_FRAGMENTS.map(f => ({ customerInfoNorm: { contains: f, mode: 'insensitive' } })) };
}
