// ════════════════════════════════════════════════════════════════════════════
// drugSkeleton.js — اسم دواء بالعربي ≡ اسمه اللاتيني في الكتالوج (2026-11-21).
//
// كروب ميسان يكتب الأصناف بالعربي («ديتركس iv»، «سيكوسيتام شراب») والكتالوج
// لاتيني («DAYTRIX (CEFTRIAXONE) 1G IV»، «SYCOCETAM SYRUP»). نقارن **هيكل الحروف
// الساكنة** بفئات صوتية: الحروف الصائتة (ا و ي ع ء / a e i o u y w) تُسقط والمكرّر
// يُطوى. «ديتركس» = DTRKS = «daytrix» (x = كس).
//
// غير نفس هيكل أسماء الأشخاص (group-context.js) عمداً: «ال» في أول اسم دواء جزء منه
// («الداكتون» = Aldactone)، وx = KS، وc/g تتبعان الحرف بعدهما (cetam = سيتام، gero = جيرو).
// الحروف الملتبسة في اللاتيني تُولّد أكثر من هيكل (g قبل e/i = ج أو ك، s بين صائتين أو
// آخر الكلمة = س أو ز «روزوفاستاتين»/«تينتيز»، ch = ك أو ش)، ويكفي أن يطابق العربيُّ أحدها.
// نقي — اختباره في scripts/test-order-text-parse.mjs.
// ════════════════════════════════════════════════════════════════════════════

const AR_CLASS = {
  'ب': 'B', 'پ': 'B', 'ت': 'T', 'ط': 'T', 'ث': 'T',
  'د': 'D', 'ض': 'D', 'ذ': 'Z', 'ز': 'Z', 'ظ': 'Z',
  'س': 'S', 'ص': 'S', 'ش': 'S',
  'ك': 'K', 'ق': 'K', 'گ': 'K', 'خ': 'K', 'غ': 'K',
  'ج': 'J', 'چ': 'J', 'ح': 'H', 'ه': 'H', 'ة': 'H',
  'ف': 'F', 'ڤ': 'F', 'ل': 'L', 'م': 'M', 'ن': 'N', 'ر': 'R',
};
const LAT_CLASS = {
  b: 'B', p: 'B', t: 'T', d: 'D', z: 'Z', k: 'K', q: 'K', j: 'J', h: 'H',
  f: 'F', v: 'F', l: 'L', m: 'M', n: 'N', r: 'R',
};
const VOWEL = /[aeiouyw]/;
const SOFT = /[eiy]/;
const MAX_VARIANTS = 32;

// المكرّر يُطوى، والهاء الختامية تُسقط («ة/ه» آخر الاسم، «-ah»).
const finish = (s) => s.replace(/(.)\1+/g, '$1').replace(/H$/, '');

/** هيكل كلمة عربية واحدة. */
export function arabicSkeleton(word) {
  const w = String(word ?? '').replace(/[ً-ٟـ]/g, '');
  return finish([...w].map(ch => AR_CLASS[ch] ?? '').join(''));
}

/** هياكل كلمة لاتينية واحدة (Set) — أكثر من هيكل حين يلتبس النطق. */
export function latinSkeletons(word) {
  const w = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '');
  let out = [''];
  const add = (...opts) => {
    const next = [];
    for (const o of out) for (const p of opts) next.push(o + p);
    out = next.length > MAX_VARIANTS ? next.slice(0, MAX_VARIANTS) : next;
  };
  for (let i = 0; i < w.length; i++) {
    const ch = w[i], nx = w[i + 1] || '', two = ch + nx;
    if (two === 'ph') { add('F'); i++; continue; }
    if (two === 'th') { add('T'); i++; continue; }
    if (two === 'sh') { add('S'); i++; continue; }
    if (two === 'ch') { add('K', 'S'); i++; continue; }
    if (two === 'kh' || two === 'gh' || two === 'ck') { add('K'); i++; continue; }
    if (two === 'rh') { add('R'); i++; continue; }
    if (i === 0 && (two === 'ps' || two === 'pn')) continue; // «Psyco» = سايكو
    if (ch === 'x') { add(i === 0 ? 'Z' : 'KS'); continue; }
    if (ch === 'c') { add(SOFT.test(nx) ? 'S' : 'K'); continue; }
    if (ch === 'g') { if (SOFT.test(nx)) add('J', 'K'); else add('K'); continue; }
    if (ch === 's') {
      // بين صائتين («Rosuva» = روزوفا) أو آخر الكلمة بعد صائت («Tinnitus» = تينتيز).
      const between = i > 0 && VOWEL.test(w[i - 1]) && (VOWEL.test(nx) || nx === '');
      if (between) add('S', 'Z'); else add('S');
      continue;
    }
    if (VOWEL.test(ch)) continue;
    const c = LAT_CLASS[ch];
    if (c) add(c);
  }
  return new Set(out.map(finish));
}

// كلمات شكل/وحدة لا تكون اسم العلامة («شراب سيكوسيتام» ⇒ العلامة «سيكوسيتام»).
const AR_NOT_BRAND = new Set([
  'شراب', 'معلق', 'حبوب', 'حب', 'حبه', 'كبسول', 'كبسوله', 'امبول', 'ابره', 'ابر', 'قطره', 'نقط',
  'جل', 'كريم', 'مرهم', 'تحاميل', 'تحميله', 'بخاخ', 'فوار', 'اكياس', 'كيس', 'علبه', 'علب',
  'شريط', 'قطعه', 'عدد', 'ملغ', 'مغ', 'غرام', 'مل', 'دواء',
]);

/** أول كلمة عربية في اسم الصنف تصلح علامةً تجارية، أو '' إن كان الاسم لاتينياً. */
export function arabicBrandWord(name) {
  const words = String(name ?? '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ً-ٟـ]/g, '')
    .split(/[^؀-ۿa-z]+/i).filter(Boolean);
  for (const w of words) {
    if (/[a-z]/i.test(w)) return ''; // أول كلمة ذات معنى لاتينية ⇒ ليس مسار العربي
    if (w.length >= 3 && !AR_NOT_BRAND.has(w)) return w;
  }
  return '';
}

/** أقصر هيكل عربي يُعتمد — هيكل من 3 حروف يصطدم بعلامات كثيرة. */
export const MIN_CROSS_SKELETON = 4;

/** فرق حرف واحد بالضبط (إبدال/إضافة/حذف) بين هيكلين. */
export function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) === 1;
}

const latinCache = new Map();
function cachedLatin(brand) {
  let s = latinCache.get(brand);
  if (!s) {
    if (latinCache.size > 5000) latinCache.clear();
    s = latinSkeletons(brand);
    latinCache.set(brand, s);
  }
  return s;
}

/**
 * عائلة علامة الاسم العربي في كتالوج لاتيني.
 * @param {string} arBrand  كلمة العلامة العربية (arabicBrandWord)
 * @param {{id:number,name:string}[]} catalog
 * @param {(name:string)=>string} brandOf  علامة اسم الكتالوج (أول كلمة لاتينية)
 * @returns {{ exact: object[], brands: Set<string>, near: object[] }}
 *   exact = هيكل مطابق تماماً · brands = العلامات اللاتينية المختلفة بينها ·
 *   near = فرق حرف واحد (اقتراح فقط، لا ربط).
 */
export function crossScriptFamily(arBrand, catalog, brandOf) {
  const sk = arabicSkeleton(arBrand);
  const exact = [], near = [], brands = new Set();
  if (sk.length < MIN_CROSS_SKELETON || !Array.isArray(catalog)) return { exact, brands, near };
  for (const c of catalog) {
    const b = brandOf(c.name);
    if (!b || !/^[a-z]+$/.test(b)) continue;
    const vs = cachedLatin(b);
    if (vs.has(sk)) { exact.push(c); brands.add(b); }
    else if (sk.length >= 5 && [...vs].some(v => oneEditApart(v, sk))) near.push(c);
  }
  return { exact, brands, near };
}
