// ════════════════════════════════════════════════════════════════════════════
// pharmacyMatch.ts — مطابقة أسماء الصيدليات في الواجهة (اقتراح ذكي + بحث حيّ)
// ────────────────────────────────────────────────────────────────────────────
// نسخة واجهة من منطق pharmacyTokens/pharmacyNamesClose في server/lib/smartPlanMatching.js،
// لكن بفارق جوهري: الخادم يُجيب بـ "نعم/لا" بعتبة صارمة عمداً (لئلا يُربط اسمان
// متشابهان تلقائياً)، أما هنا فالمطلوب **ترتيب** كل الأسماء بدرجة قرب حتى الضعيفة
// منها — لأن المستخدم هو من يقرّر، فإخفاء اقتراح متوسط القوة يضرّه ولا يحميه.
//
// يُستعمل في ربط صيدلية «مفتوحة في الملف / غير موجودة في السيرفي» باسمها الصحيح.
// ════════════════════════════════════════════════════════════════════════════

// كلمات لا تميّز صيدلية عن أخرى — إبقاؤها يجعل كل الأسماء "متشابهة".
const NOISE_WORDS = new Set([
  'صيدليه', 'الصيدليه', 'صيدليات', 'الصيدليات', 'ص', 'مذخر', 'المذخر',
  'pharmacy', 'ph', 'dr', 'د',
]);

/** تطبيع عربي: تشكيل/تطويل/همزات/ة-ه/ى-ي + إسقاط الرموز وتوحيد المسافات. */
export function normalizePharmacyName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** كلمات الاسم بعد التطبيع، بلا كلمات الحشو ومع إسقاط «ال» التعريف من الكلمات الطويلة. */
export function pharmacyTokens(raw: string | null | undefined): string[] {
  return normalizePharmacyName(raw)
    .split(' ')
    .filter(Boolean)
    .filter(w => !NOISE_WORDS.has(w))
    .map(w => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w));
}

const bare = (t: string) => t.replace(/ال/g, '');
const flatten = (tokens: string[]) => bare(tokens.join(''));

/**
 * «هيكل» الاسم: الحروف اللينة في آخر كل كلمة (ا/ه/ي) تُسقَط لأنها أشهر اختلاف
 * إملائي بين كتابتين لنفس الاسم («الميرا» = «الميرة» = «الميره»)، وهي في الوقت
 * نفسه فارق حرف واحد يهبط بالتشابه الإملائي في الأسماء القصيرة هبوطاً حاداً.
 */
const skeleton = (tokens: string[]) => bare(tokens.map(t => t.replace(/[اهي]$/, '')).join(''));

/** ترتيب حروف الاسم — يساوي بين كتابتين تختلفان في ترتيب الكلمات ووصلها معاً. */
const charSig = (flat: string) => [...flat].sort().join('');

/** مفتاح متساهل: يتجاهل المسافات وأداة التعريف وترتيب الحروف الأصلي. */
export function pharmacyKey(raw: string | null | undefined): string {
  return flatten(pharmacyTokens(raw));
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** نسبة تشابه إملائي في [0,1]. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** هل حروف a موجودة كلها بالترتيب (لا بالتتابع) داخل b؟ */
function isSubsequence(a: string, b: string): boolean {
  let i = 0;
  for (const ch of b) { if (ch === a[i]) i++; if (i === a.length) return true; }
  return i === a.length;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export interface MatchResult { score: number; reason: string }

/**
 * قرب اسمين من بعضهما (متماثل الاتجاه) — لاقتراح «هل هي نفس هذه الصيدلية؟».
 * تُجرَّب كل القواعد وتُؤخذ أقواها، فلا يحجب تطابق كلمة واحدة تشابهاً إملائياً أعلى.
 */
export function matchScore(a: string, b: string): MatchResult {
  const ta = pharmacyTokens(a), tb = pharmacyTokens(b);
  if (!ta.length || !tb.length) return { score: 0, reason: '' };

  const fa = flatten(ta), fb = flatten(tb);
  if (fa === fb) return { score: 1, reason: 'تطابق تام' };
  if ([...ta].sort().join(' ') === [...tb].sort().join(' ')) {
    return { score: 0.97, reason: 'نفس الكلمات بترتيب مختلف' };
  }

  let best: MatchResult = { score: 0, reason: '' };
  const bump = (score: number, reason: string) => { if (score > best.score) best = { score, reason }; };

  const ska = skeleton(ta), skb = skeleton(tb);
  if (ska && ska === skb) bump(0.93, 'نفس الاسم بإملاء مختلف');
  if (fa.length >= 5 && charSig(fa) === charSig(fb)) bump(0.93, 'نفس الحروف بترتيب مختلف');

  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long.map(bare));
  const shared = short.filter(t => longSet.has(bare(t))).length;
  if (shared === short.length && short.length < long.length) {
    bump(0.88 + 0.07 * (short.length / long.length), 'اسم مختصر من نفس الصيدلية');
  } else if (shared > 0) {
    bump(0.46 + 0.34 * (shared / Math.max(ta.length, tb.length)), `${shared} كلمة مشتركة`);
  }

  if (fa.includes(fb) || fb.includes(fa)) {
    const ratio = Math.min(fa.length, fb.length) / Math.max(fa.length, fb.length);
    bump(0.70 + 0.22 * ratio, 'اسم يحتوي الآخر');
  }

  // الأسماء القصيرة يُكلّفها الحرف الواحد نسبةً أكبر، فتُرفع عتبتها بدل استبعادها:
  // «النيم»/«النعيم» فارقهما حرف واحد ولا يجوز أن يسقطا من الاقتراحات.
  const minLen = Math.min(fa.length, fb.length);
  if (minLen >= 3) {
    const sim = similarity(fa, fb);
    if (sim >= (minLen < 5 ? 0.7 : 0.6)) bump(sim * 0.95, `تشابه إملائي ${Math.round(sim * 100)}%`);
  }

  const pre = commonPrefix(fa, fb);
  if (pre >= 3) bump(0.42 + 0.3 * (pre / Math.max(fa.length, fb.length)), `${pre} أحرف أولى متطابقة`);

  return best;
}

/**
 * ترتيب نتائج البحث أثناء الكتابة (غير متماثل: الاستعلام قصير والاسم كامل).
 * البداية أقوى من الاحتواء، والاحتواء أقوى من التشابه الإملائي — كترتيب أي
 * صندوق بحث معتاد، مع دعم عدة كلمات بأي ترتيب.
 */
export function searchScore(query: string, name: string): MatchResult {
  const qt = pharmacyTokens(query), nt = pharmacyTokens(name);
  const fq = flatten(qt), fn = flatten(nt);
  if (!fq || !fn) return { score: 0, reason: '' };

  if (fn === fq) return { score: 1, reason: 'تطابق تام' };

  let best: MatchResult = { score: 0, reason: '' };
  const bump = (score: number, reason: string) => { if (score > best.score) best = { score, reason }; };

  if (fn.startsWith(fq)) bump(0.94, 'يبدأ بما كتبت');
  if (nt.some(t => bare(t).startsWith(fq))) bump(0.86, 'كلمة تبدأ بما كتبت');
  if (qt.length > 1 && qt.every(t => fn.includes(bare(t)))) bump(0.82, 'كل الكلمات موجودة');
  if (fn.includes(fq)) bump(0.78, 'يحتوي ما كتبت');
  if (skeleton(qt) && skeleton(qt) === skeleton(nt)) bump(0.9, 'نفس الاسم بإملاء مختلف');
  // حروف ما كُتب موجودة بالترتيب داخل الاسم — يغطّي الاختصار وإسقاط حرف أثناء الكتابة
  if (fq.length >= 3 && isSubsequence(fq, fn)) bump(0.68, 'حروفه موجودة بالترتيب');
  if (Math.min(fq.length, fn.length) >= 3) {
    const sim = similarity(fq, fn);
    if (sim >= 0.5) bump(sim * 0.8, 'قريب إملائياً');
  }
  return best;
}

export interface RankedMatch<T> { item: T; score: number; reason: string }

/**
 * ترتيب قائمة صيدليات: بالبحث المكتوب إن وُجد، وإلا بقرب الاسم من sourceName.
 * التعادل يُحسم بعدد الأطباء (الصيدلية الأنشط أرجح أن تكون المقصودة).
 */
export function rankPharmacies<T extends { name: string; doctorCount?: number }>(opts: {
  pool: T[];
  sourceName: string;
  query?: string;
  limit?: number;
  minScore?: number;
}): RankedMatch<T>[] {
  const { pool, sourceName, query = '', limit = 8 } = opts;
  const q = query.trim();
  const minScore = opts.minScore ?? (q ? 0.3 : 0.34);

  const out: RankedMatch<T>[] = [];
  for (const item of pool) {
    const { score, reason } = q ? searchScore(q, item.name) : matchScore(sourceName, item.name);
    if (score >= minScore) out.push({ item, score, reason });
  }
  out.sort((a, b) => b.score - a.score || (b.item.doctorCount ?? 0) - (a.item.doctorCount ?? 0)
    || a.item.name.localeCompare(b.item.name, 'ar'));
  return out.slice(0, limit);
}
