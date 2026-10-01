// ════════════════════════════════════════════════════════════════════════════
// مطابقة اسم المندوب: نص حرّ من ملف خارجي ← حساب مندوب عندنا
// ────────────────────────────────────────────────────────────────────────────
// منطق نقيّ بلا قاعدة بيانات (اختباره: node scripts/test-rep-name-match.mjs).
// يغذّي كل ميزات «مطابقة اسم المندوب»: استيراد الزيارات، ملفات ميركاتو، وأي
// مصدر لاحق — فالسؤال واحد: "هل هذا النص يقصد المندوب فلان؟".
//
// الخطر هنا صامت لا صاخب: اسم لا يُطابَق لا يُسقط الاستيراد، بل تُهمَل كل صفوفه
// وتظهر أعداد الزيارات أقل من الملف بلا سبب ظاهر — لذلك الاختبار يغطي صيغ
// التسمية الفعلية المستعملة في الحسابات («الاسم/ المنطقة ph»).
// ════════════════════════════════════════════════════════════════════════════

/**
 * تطبيع اسم شخص للمطابقة: توحيد الألف والتاء المربوطة، حذف التطويل والتشكيل،
 * وطيّ المسافات. مصدر واحد للحقيقة يستعمله كل من مطابقة الأسماء المخزَّنة
 * (SciRepNameLink.fromKey) ومطابقة صفوف المبيعات، فلا ينفرط المفتاحان.
 */
export const normalizeRepName = s => String(s ?? '').trim()
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ـ/g, '')
  .replace(/[ً-ٟ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * «نواة» الاسم: ما قبل أول فاصل «/ - –» — أي الاسم بلا لاحقة المنطقة الملصقة به
 * في تسمية الحسابات عندنا («عبدالله عمر/ كرخ غربي ph» → «عبدالله عمر»).
 *
 * بدونها لا يتطابق أي اسم قادم من ملف خارجي (يحمل الاسم مجرَّداً) مع حساباتنا:
 * التطابق التام يفشل، ودرجة الكلمات المشتركة تسقط أيضاً (كلمات المنطقة الزائدة
 * تُنزل النسبة، والسلاش يلتصق بالكلمة فيكسر تطابقها) — فيُصنَّف المندوب «خارج
 * النطاق» بلا سؤال وتُهمَل كل صفوفه صامتةً.
 */
export const repCoreName = s => {
  const v = String(s ?? '').trim();
  const m = v.match(/^(.+?)\s*[/\-–]\s*\S.*$/);
  return m ? m[1].trim() : v;
};

export const repCoreKey = s => normalizeRepName(repCoreName(s));

/** نواة بلا أي مسافات — «عبد الله عمر» ↔ «عبدالله عمر» (تهجئة شائعة في ملفات CRM). */
export const repTightKey = s => repCoreKey(s).replace(/\s+/g, '');

/**
 * درجة تشابه اسمَي شخص (0..1) على أساس الكلمات المشتركة لا الحروف:
 * «محمد باقر» ⊂ «محمد باقر مرتضى» → احتواء تام. نشترط كلمتين مشتركتين على
 * الأقل، وإلا لطابق كل «محمد» كل «محمد» آخر.
 * @returns {number} 0 = لا تشابه يُعتد به
 */
export function repNameScore(a, b) {
  const na = normalizeRepName(a), nb = normalizeRepName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const setB = new Set(tb);
  const shared = ta.filter(t => setB.has(t)).length;
  if (shared < 2) return 0; // كلمة واحدة مشتركة (اسم أول شائع) ليست دليلاً
  const containment = shared / Math.min(ta.length, tb.length); // 1 = الأقصر داخل الأطول
  const overall     = shared / Math.max(ta.length, tb.length);
  return containment * 0.7 + overall * 0.3;
}

/**
 * فهارس المطابقة لقائمة مندوبين. تُبنى مرة واحدة ثم تُستعمل لكل اسم.
 * كل فهرس يحتفظ بالقائمة الكاملة لا بأول مرشّح: نفس الشخص قد يملك حساباً لكل
 * شركة في المكتب بنفس الاسم تماماً، وانتقاء أحدهم عشوائياً يَنسب زياراته لحساب
 * شركة أخرى — الالتباس الحقيقي يُسأل عنه ولا يُخمَّن.
 * @param {{id:number,name:string,company?:string|null}[]} reps
 */
export function buildRepIndex(reps) {
  const byFull = new Map(), byCore = new Map(), byTight = new Map();
  const push = (map, key, rep) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).some(r => r.id === rep.id)) map.get(key).push(rep);
  };
  for (const r of (reps || [])) {
    if (!Number.isInteger(r?.id) || !r?.name) continue;
    push(byFull,  normalizeRepName(r.name), r);
    push(byCore,  repCoreKey(r.name),       r);
    push(byTight, repTightKey(r.name),      r);
  }
  return { reps: (reps || []).filter(r => Number.isInteger(r?.id) && r?.name), byFull, byCore, byTight };
}

/**
 * يطابق نصاً حرّاً بقائمة المندوبين.
 *
 * الترتيب: الاسم الكامل → النواة (بلا لاحقة المنطقة) → النواة بلا مسافات →
 * تشابه الكلمات. مرشّح واحد في أي مرتبة = حسم بلا سؤال؛ أكثر من مرشّح = سؤال
 * بمرشّحيه جاهزين (لا تخمين، ولا إسقاط صامت).
 *
 * @returns {{status:'exact'|'ask'|'none', rep:object|null, suggestions:object[]}}
 */
export function matchRepName(raw, index) {
  const sug = (list, score) => list.slice(0, 5).map(r => ({ id: r.id, name: r.name, company: r.company ?? null, score }));

  for (const [key, map] of [
    [normalizeRepName(raw), index.byFull],
    [repCoreKey(raw),       index.byCore],
    [repTightKey(raw),      index.byTight],
  ]) {
    if (!key) continue;
    const hits = map.get(key) ?? [];
    if (hits.length === 1) return { status: 'exact', rep: hits[0], suggestions: [] };
    if (hits.length > 1)   return { status: 'ask', rep: null, suggestions: sug(hits, 1) };
  }

  // التشابه يُقاس على النواة أيضاً — «عبدالله عمر حسن» في الملف مقابل حساب
  // «عبدالله عمر/ كرخ غربي ph» كان يُعطي صفراً بسبب كلمات المنطقة الزائدة.
  const core = repCoreKey(raw);
  const suggestions = index.reps
    .map(r => ({
      id: r.id, name: r.name, company: r.company ?? null,
      score: Math.max(repNameScore(raw, r.name), repNameScore(core, repCoreKey(r.name))),
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { status: suggestions.length > 0 ? 'ask' : 'none', rep: null, suggestions };
}
