// ════════════════════════════════════════════════════════════════════════════
// invoiceCustomerMatch.js — مطابقة «الصيدلية/المنطقة» المستخرَجة من صورة فاتورة
// أو نصّ طلبية مع بيانات الماستر أدمن (جدول Area + AreaAlias + صيدليات السيرفي).
// ────────────────────────────────────────────────────────────────────────────
// الموديل يقرأ ما هو مكتوب حرفياً: «منصور» بدل «المنصور»، «فوزي منصور» بلا فاصل،
// أو «بغداد - منصور» من خانة العنوان. هنا نحوّل القراءة إلى الاسم القانوني:
//   • المنطقة: تطابق تام (normalizeAreaName يُسقط «ال») → ذاكرة AreaAlias →
//     ضبابي صارم (نفس عتبات areaResolver) — مع تجربة أجزاء الاسم المركَّب.
//   • الصيدلية: أقرب صيدلية سيرفي (اسم/اسم الصيدلية/المالك) مرجَّحة بالمنطقة.
//   • صيدلية بلا فاصل («فوزي منصور»): إن كان ذيلها منطقة معروفة بتطابق تام فُصِل.
//
// **قراءة فقط** — لا تُنشئ منطقة ولا alias ولا صيدلية (بخلاف resolveAreaByName
// الذي يُنشئ منطقة needsReview). الحسم لا يقع إلا بثقة عالية؛ ما دونها يُترك كما
// قُرئ مع مرشّحين في `_pharmacyCandidates`/`_areaCandidates` ليختار المراجِع.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';
import { normalizeAreaName, normalizeArabic } from './itemResolver.js';
import { areSimilar, similarity } from './fuzzyMatch.js';

// نفس عتبات areaResolver (راجع تعليقه): «المنصور» ≠ «المنصورية»، والكلمة الإضافية
// في «عامرية الفلوجة» تُميّز مكاناً آخر فلا يُتجاهل فرق الكلمات.
const AREA_FUZZY_OPTS = { lev: 0.92, prefixRatio: 0.85, wordOverlap: 1.01 };

const PHARMACY_AUTO = 0.86;   // حسم تلقائي للصيدلية
const PHARMACY_MARGIN = 0.06; // والفارق عن المرشّح الثاني
const PHARMACY_SUGGEST = 0.6; // أدنى درجة تُعرض كاقتراح

// بادئات عناوين الحقول التي قد تتسرّب إلى قيمة المنطقة من الفاتورة.
// العنوان لا يُسقَط إلا متبوعاً بفاصل أو مسافة — وإلا «ص» تقصّ أول «صيدلية فوزي»
// و«مكان» تقصّ أول «مكانة».
const LABEL_TAIL = String.raw`(?:\s*[:：\-/.]\s*|\s+)`;
const AREA_LABEL_RE = new RegExp(String.raw`^\s*(?:المنطقه|المنطقة|منطقه|منطقة|الزون|زون|zone|الموقع|موقع|المكان|مكان|العنوان|عنوان|المحله|المحلة|محلة)${LABEL_TAIL}`, 'i');
const PHARMACY_LABEL_RE = new RegExp(String.raw`^\s*(?:السيد|السادة|الساده|حضرة|اسم الزبون|اسم العميل|ص|صيدلية|الصيدلية|صيدليه|الصيدليه|زبون|الزبون|عميل|العميل|اسم|الاسم|المشتري)${LABEL_TAIL}`, 'i');

const CACHE_MS = 5 * 60_000;
let cache = null; // { at, areas, aliasByKey, pharmacies }

async function loadMaster() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [areas, aliases, pharmacies] = await Promise.all([
    prisma.area.findMany({ select: { id: true, name: true, needsReview: true } }),
    prisma.areaAlias.findMany({ select: { fromKey: true, areaId: true } }),
    prisma.masterSurveyPharmacy.findMany({
      where: { isActive: true, survey: { isActive: true } },
      select: { id: true, name: true, pharmacyName: true, ownerName: true, areaName: true },
    }),
  ]);
  cache = { at: Date.now(), ...buildMasterIndex(areas, aliases, pharmacies) };
  return cache;
}

/** فهرس المطابقة من صفوف خام — نقيّ، يُستعمل في الاختبار أيضاً. */
export function buildMasterIndex(areas, aliases, pharmacies) {
  // المنطقة لكل حساب لا عالمية — نفس الاسم عدة صفوف. يكفينا اسم قانوني واحد لكل
  // مفتاح، ونفضّل المؤكَّد (غير needsReview).
  const areaByKey = new Map();
  for (const a of areas) {
    const k = normalizeAreaName(a.name);
    if (!k) continue;
    const cur = areaByKey.get(k);
    if (!cur || (cur.needsReview && !a.needsReview)) areaByKey.set(k, a);
  }
  const areaById = new Map(areas.map(a => [a.id, a]));
  const aliasByKey = new Map();
  for (const al of aliases) {
    const a = areaById.get(al.areaId);
    if (a) aliasByKey.set(al.fromKey, a);
  }
  const confirmed = [...areaByKey.values()].filter(a => !a.needsReview);

  const pharmacyIndex = pharmacies.map(p => ({
    ...p,
    areaKey: p.areaName ? normalizeAreaName(p.areaName) : '',
    keys: [p.name, p.pharmacyName, p.ownerName].map(pharmKey).filter(Boolean),
  }));

  return { areaByKey, aliasByKey, confirmed, pharmacies: pharmacyIndex };
}

/**
 * كم تؤكّد بيانات الماستر قراءةَ زبون: 2 صيدلية سيرفي محسومة، 1 منطقة معروفة فقط،
 * 0 لا شيء. يُستعمل لاختيار أفضل قراءتين لسطر الزبون من الصورة نفسها.
 */
export async function customerKnownScore(pharmacy, area) {
  if (!String(pharmacy ?? '').trim() && !String(area ?? '').trim()) return 0;
  let m;
  try { m = await loadMaster(); } catch { return 0; }
  const r = resolveOne(String(pharmacy ?? '').trim(), String(area ?? '').trim(), m);
  if (r.matched) return 2;
  return r.area ? 1 : 0;
}

/** يُلغى بعد أي تعديل يعرف أنه يمسّ المناطق/الصيدليات (اختياري — التقادم 5 دقائق). */
export function invalidateInvoiceMatchCache() { cache = null; }

/** مفتاح مقارنة اسم صيدلية: بلا بادئة، بلا «ال»، ة=ه، ى=ي. */
export function pharmKey(name) {
  let s = String(name ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(PHARMACY_LABEL_RE, '').trim();
    if (s === before) break;
  }
  return normalizeArabic(s).toLowerCase();
}

function stripAreaLabel(s) {
  let out = String(s ?? '').trim();
  for (let i = 0; i < 2; i++) out = out.replace(AREA_LABEL_RE, '').trim();
  return out;
}

/** يطابق نصّاً واحداً بمنطقة: exact → alias → (اختياري) ضبابي. */
function matchAreaOne(raw, m, { fuzzy = true } = {}) {
  const t = stripAreaLabel(raw);
  const k = normalizeAreaName(t);
  if (!k) return null;
  const exact = m.areaByKey.get(k);
  if (exact) return { name: exact.name, how: 'exact' };
  const alias = m.aliasByKey.get(k);
  if (alias) return { name: alias.name, how: 'alias' };
  if (!fuzzy || k.length < 3) return null;
  let best = null, bestScore = -1;
  for (const a of m.confirmed) {
    if (!areSimilar(t, a.name, AREA_FUZZY_OPTS)) continue;
    const sc = similarity(k, normalizeAreaName(a.name));
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best ? { name: best.name, how: 'fuzzy' } : null;
}

/**
 * يطابق قيمة منطقة قد تكون مركَّبة («بغداد - منصور»، «المنصور / شارع 14»).
 * يجرّب القيمة كاملة ثم أجزاءها من الأخير للأول (الحيّ يأتي عادةً بعد المحافظة).
 */
export function matchArea(raw, m) {
  const full = String(raw ?? '').trim();
  if (!full) return null;
  const whole = matchAreaOne(full, m);
  if (whole) return whole;
  const parts = full.split(/\s*[-\/،,:|–]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const p of [...parts].reverse()) {
      const hit = matchAreaOne(p, m);
      if (hit) return hit;
    }
  }
  return null;
}

function scorePharmacy(cand, key, areaKey) {
  let best = 0;
  for (const ck of cand.keys) {
    if (!ck) continue;
    let s;
    if (ck === key) s = 1;
    else {
      const shorter = ck.length <= key.length ? ck : key;
      const longer = ck.length <= key.length ? key : ck;
      s = (longer.startsWith(shorter) && shorter.length / longer.length >= 0.75) ? 0.9 : similarity(ck, key);
    }
    if (s > best) best = s;
  }
  // المنطقة مرجِّح قوي: فرعا سلسلة في منطقتين صيدليتان مختلفتان.
  if (areaKey && cand.areaKey) best += cand.areaKey === areaKey ? 0.1 : -0.12;
  return Math.max(0, Math.min(1, best));
}

/**
 * يطابق صيدلية بقائمة السيرفي. يُعيد { match, candidates } — match فقط عند ثقة
 * عالية بفارق واضح عن الثاني.
 */
export function matchPharmacy(rawName, areaName, m) {
  const key = pharmKey(rawName);
  if (!key || key.length < 2) return { match: null, candidates: [] };
  const areaKey = areaName ? normalizeAreaName(areaName) : '';
  const scored = [];
  for (const c of m.pharmacies) {
    const s = scorePharmacy(c, key, areaKey);
    if (s >= PHARMACY_SUGGEST) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0];
  const second = scored[1];
  // صفّان مكرّران لنفس الصيدلية (نفس الاسم ونفس المنطقة) لا يُعدّان لبساً؛ أما
  // نفس الاسم في منطقتين فصيدليتان مختلفتان — لا حسم بلا منطقة.
  const sameEntity = (a, b) => pharmKey(a.name) === pharmKey(b.name) && a.areaKey === b.areaKey;
  const decisive = top && top.s >= PHARMACY_AUTO
    && (!second || top.s - second.s >= PHARMACY_MARGIN || sameEntity(top.c, second.c));
  const seen = new Set();
  const candidates = [];
  for (const { c, s } of scored) {
    const label = c.areaName ? `${c.name} — ${c.areaName}` : c.name;
    if (seen.has(label)) continue;
    seen.add(label);
    candidates.push({ name: c.name, area: c.areaName || null, score: Math.round(s * 100) / 100 });
    if (candidates.length >= 6) break;
  }
  return { match: decisive ? top.c : null, candidates };
}

/**
 * «فوزي منصور» بلا فاصل: إن كان ذيل الاسم (كلمة أو كلمتان) منطقةً معروفة
 * **بتطابق تام أو alias** (لا ضبابي — الأسماء الشخصية تشبه أسماء الأحياء
 * كثيراً) والرأس غير فارغ، فالرأس صيدلية والذيل منطقة.
 */
function splitTrailingArea(pharmacy, m) {
  const words = String(pharmacy ?? '').trim().split(/\s+/);
  for (const n of [2, 1]) {
    if (words.length <= n) continue;
    const tail = words.slice(-n).join(' ');
    const hit = matchAreaOne(tail, m, { fuzzy: false });
    if (hit) return { pharmacy: words.slice(0, -n).join(' '), area: hit.name };
  }
  return null;
}

/**
 * يحسّن pharmacy/area لكل صف في مكانه. لا يرمي — فشل التحميل يترك الصفوف كما هي.
 * يُضيف للصف: `_pharmacyCandidates` و`_areaRaw` (القراءة الأصلية حين تغيّرت).
 */
export async function matchInvoiceCustomers(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let m;
  try { m = await loadMaster(); } catch (e) {
    console.error('[invoice-match] تعذّر تحميل بيانات الماستر:', e?.message);
    return rows;
  }

  // الصفوف من نفس الفاتورة تتشارك (صيدلية، منطقة) — نحسب مرة لكل زوج.
  const memo = new Map();
  for (const row of rows) {
    const rawPh = String(row.pharmacy ?? '').trim();
    const rawAr = String(row.area ?? '').trim();
    if (!rawPh && !rawAr) continue;
    const memoKey = `${rawPh}|${rawAr}`;
    let res = memo.get(memoKey);
    if (!res) {
      res = resolveOne(rawPh, rawAr, m);
      memo.set(memoKey, res);
    }
    if (res.pharmacy != null) row.pharmacy = res.pharmacy;
    if (res.area != null) row.area = res.area;
    if (res.areaRaw && res.areaRaw !== row.area) row._areaRaw = res.areaRaw;
    if (res.candidates.length) row._pharmacyCandidates = res.candidates;
    row._pharmacyMatched = !!res.matched;
  }
  return rows;
}

export function resolveOne(rawPh, rawAr, m) {
  let ph = rawPh;
  let area = null;

  if (rawAr) {
    const a = matchArea(rawAr, m);
    if (a) area = a.name;
  }

  // صيدلية مطابقة كما هي أولاً — اسم صيدلية حقيقي قد ينتهي باسم حيّ («نور الكرادة»).
  let pm = ph ? matchPharmacy(ph, area || rawAr, m) : { match: null, candidates: [] };

  if (ph && !pm.match) {
    const split = splitTrailingArea(ph, m);
    if (split && (!area || normalizeAreaName(split.area) === normalizeAreaName(area))) {
      const pm2 = matchPharmacy(split.pharmacy, split.area, m);
      // الفصل يُقبَل حين لا تقدّم المطابقة الكاملة مرشّحاً أقوى منه.
      const bestFull = pm.candidates[0]?.score ?? 0;
      const bestSplit = pm2.match ? 1 : (pm2.candidates[0]?.score ?? 0);
      if (bestSplit >= bestFull || !rawAr) {
        ph = split.pharmacy;
        area = area || split.area;
        pm = pm2;
      }
    }
  }

  if (pm.match) {
    ph = pm.match.name;
    // منطقة الصيدلية من السيرفي حين لم تُقرأ منطقة (أو لم تُطابَق).
    if (!area && pm.match.areaName) {
      const a = matchArea(pm.match.areaName, m);
      area = a ? a.name : pm.match.areaName;
    }
  }

  return {
    pharmacy: ph || null,
    area,
    areaRaw: area && rawAr && area !== rawAr ? rawAr : null,
    candidates: pm.match ? [] : pm.candidates,
    matched: !!pm.match,
  };
}
