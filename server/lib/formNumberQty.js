// ════════════════════════════════════════════════════════════════════════════
// formNumberQty.js — «Vomibreak tab 5»: هل الرقم بعد كلمة الشكل كمية أم جرعة؟
// (كربلاء 2026-11-23: الرسالة «Azitro syr 20+20 ⏎ Vomibreak tab 5» ضاع منها Vomibreak.)
//
// الشكل وحده ملتبس: «Azitro tab 500» و«Concor tab 5» جرعة. الحَكَم الكتالوج: إن كان
// للعلامة أصناف فيه ولم يحمل أيٌّ منها هذا الرقم جرعةً (ولا ألف ضعفه: «1g»)، فالرقم
// كمية. علامة غير موجودة في الكتالوج ⇒ لا قرار (الذكاء/المراجعة كما كان).
// الكتالوج هنا عام (كل الأصناف غير المؤقتة) — السؤال عن جرعات علامة لا عن ملكية.
// ════════════════════════════════════════════════════════════════════════════

import prisma from './prisma.js';

// أعداد العبوة («10TAB»، «1VIAL»، «30 caps») ليست جرعة.
const PACK_RE = /\b\d+\s*(?:x\s*\d+\s*)?(?:tabs?|tablets?|caps?|capsules?|amps?|ampoules?|vials?|sachets?|pcs?|strips?|supp|film)\b/gi;

const brandOf = (s) => (String(s ?? '').toLowerCase().match(/[a-z]{3,}/) || [])[0] || '';

/** أرقام الجرعة في اسم كتالوج: «1G» = 1000، «312.5MG» = 312.5، «50.000IU» = 50000. */
export function catalogDoses(name) {
  const s = String(name ?? '').toLowerCase()
    .replace(/\b([1-9]\d{0,2})[.,'](\d{3})(?!\d)/g, '$1$2')
    .replace(PACK_RE, ' ');
  return [...s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]*)/g)]
    .map(m => (/^(?:g|gm|gr|grams?)$/.test(m[2]) ? Number(m[1]) * 1000 : Number(m[1])));
}

/**
 * نقي: يبني الحَكَم من أسماء الكتالوج.
 * @param {string[]} names
 * @returns {(name:string, n:number) => boolean}  true = n كمية
 */
export function makeFormNumberQty(names) {
  const doses = new Map(); // علامة ← Set(جرعات)
  for (const nm of names || []) {
    const b = brandOf(nm);
    if (!b) continue;
    if (!doses.has(b)) doses.set(b, new Set());
    const set = doses.get(b);
    for (const d of catalogDoses(nm)) set.add(d);
  }
  return (name, n) => {
    if (!Number.isFinite(n) || n <= 0 || n > 999) return false;
    const set = doses.get(brandOf(name));
    if (!set) return false; // علامة مجهولة ⇒ لا نحسم
    for (const d of set) {
      if (d === n || d === n * 1000 || (Math.floor(d) === n && d - n < 1)) return false;
    }
    return true;
  };
}

const CACHE_MS = 10 * 60_000;
let cache = null; // { at, fn }
/** الحَكَم من الكتالوج العام، مخزَّن 10 دقائق. فشل التحميل ⇒ لا يحسم شيئاً. */
export async function loadFormNumberQty() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.fn;
  let fn = () => false;
  try {
    const items = await prisma.item.findMany({ where: { isTemp: false }, select: { name: true } });
    fn = makeFormNumberQty(items.map(i => i.name));
  } catch (e) {
    console.error('[orders] تعذّر تحميل جرعات الكتالوج:', e?.message);
  }
  cache = { at: Date.now(), fn };
  return fn;
}
