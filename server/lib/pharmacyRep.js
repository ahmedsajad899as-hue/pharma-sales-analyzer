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

export const BAGHDAD_PROVINCE = 'بغداد';
const isBaghdadProvince = (name) => String(name ?? '').trim() === BAGHDAD_PROVINCE;

/** مدير مسوقي المحافظات: مسنَد إلى محافظات وليس إلى بغداد (غيره يدير مسوقي بغداد). */
export function managesProvinceMarketers(provinceNames = []) {
  return provinceNames.length > 0 && !provinceNames.some(isBaghdadProvince);
}

/**
 * محافظات انتماء المسوق: منطقة واحدة من محافظة لا تجعله من مسوقيها — يتبع أكثرية مناطقه.
 * areaCounts: محافظة ← عدد مناطقه فيها. المحافظة المُسنَدة كاملةً تُعدّ منطقة واحدة، فلا
 * تغلب مناطق بغداد، لكنها تحسم الانتماء بين المحافظات لمن ليس أكثره في بغداد.
 * التعادل مع بغداد لصالح بغداد: يبقى ظاهراً في مسوقي بغداد بدل أن يُنقل خطأً.
 */
export function marketerHomeProvinces(assignedProvinces = [], areaCounts = new Map()) {
  const counts = new Map(areaCounts);
  for (const p of new Set(assignedProvinces)) counts.set(p, (counts.get(p) || 0) + 1);
  if (!counts.size) return [];
  const top = Math.max(...counts.values());
  const tied = [...counts].filter(([, n]) => n === top).map(([p]) => p);
  if (tied.some(isBaghdadProvince)) return [BAGHDAD_PROVINCE];
  const direct = [...new Set(assignedProvinces)].filter(p => !isBaghdadProvince(p));
  return direct.length ? direct : tied;
}

/**
 * ما يديره «مدير المسوقين»: المحافظات والأقسام المسنَدة له صراحةً (قسم من بغداد = بغداد).
 * بلا إسناد صريح تحكم أكثرية مناطقه، فمنطقة شاردة في محافظة لا تفتح له تلك المحافظة.
 * areaCounts: محافظة ← عدد مناطقه فيها.
 * @returns {{baghdad:boolean, provinces:string[]}} provinces بلا بغداد
 */
export function marketersManagerCoverage({ assignedProvinces = [], assignedSideProvinces = [], areaCounts = new Map() } = {}) {
  const direct = [...new Set([...assignedProvinces, ...assignedSideProvinces])];
  const names = direct.length ? direct : marketerHomeProvinces([], areaCounts);
  return { baghdad: names.some(isBaghdadProvince), provinces: names.filter(n => !isBaghdadProvince(n)) };
}

/**
 * تيم ليدر مسوقي كل محافظة (ProvinceTeam.leader قائد العلميين، وليس قائدهم). لكل محافظة:
 * الأكثر مسوقين فيها من قادة الفارمسي، ويُحسب القائد نفسه إن كانت محافظته. قائد بغداد لا يُعرض.
 * marketers: { id, name, isLeader, homes: string[], managerIds: number[] } — managerIds معرّفات مندوب.
 * @returns {Map<string, {id:number, name:string}>} محافظة ← قائدها
 */
export function pickMarketerLeaders(marketers) {
  const byId = new Map(marketers.map(m => [m.id, m]));
  const votes = new Map(); // محافظة ← قائد ← عدد
  const vote = (prov, leaderId) => {
    if (!votes.has(prov)) votes.set(prov, new Map());
    const m = votes.get(prov);
    m.set(leaderId, (m.get(leaderId) || 0) + 1);
  };
  for (const m of marketers) {
    for (const prov of m.homes) {
      if (isBaghdadProvince(prov)) continue;
      if (m.isLeader) vote(prov, m.id);
      for (const id of m.managerIds ?? []) {
        const leader = byId.get(id);
        if (leader?.isLeader && !leader.homes.some(isBaghdadProvince)) vote(prov, id);
      }
    }
  }
  const out = new Map();
  for (const [prov, m] of votes) {
    const [id] = [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    out.set(prov, { id, name: byId.get(id).name });
  }
  return out;
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

/**
 * Sale.customerInfoNorm صف «تجاري» خالص؟ — لزر «بدون التجاري» في تقرير العلميين.
 * «تجار» تغطي تجاري/تجارى؛ قيمة مختلطة «علمي/تجاري» أو فارمسي لا تُعدّ تجارية.
 */
export function looksLikeCommercialInfo(norm) {
  const v = String(norm ?? '').toLowerCase();
  return v.includes('تجار') && !v.includes('علم') && !looksLikePharmacyInfo(v);
}

/** تصنيف الصف لجدول «علمي/تجاري/فارمسي». المختلط «علمي/تجاري» = علمي؛ بلا قيمة (ميركاتو) = other. */
export function customerInfoClassOf(norm) {
  if (looksLikePharmacyInfo(norm)) return 'pharmacy';
  if (looksLikeCommercialInfo(norm)) return 'commercial';
  if (String(norm ?? '').includes('علم')) return 'scientific';
  return 'other';
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
