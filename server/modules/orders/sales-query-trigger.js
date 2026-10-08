// ════════════════════════════════════════════════════════════════════════════
// sales-query-trigger.js — هل هذه رسالة سؤال عن مبيعات مندوب؟ («محمد باقر مبيع
// شهر 9» → اسم: محمد باقر، شهر: 9). منطق نقيّ بلا قاعدة بيانات (نفس روح
// order-trigger.js المجاور) — اختباره: node scripts/test-sales-query-trigger.mjs
//
// الشرط: كلمة تحتوي «مبيع» (مبيع/مبيعات/المبيعات…) + «شهر» متبوعة برقم 1-12 في
// نفس الرسالة. الاسم يُستخرج من الجزء المتبقي؛ أي نص بعد عبارة الشهر/السنة
// يُعامل كـ«مؤهِّل» (اسم شركة/مكتب) يُستعمل لاحقاً لفكّ الالتباس عند تعدّد
// المرشّحين بنفس الاسم (راجع sales-query.js::answerSalesQuery).
//
// لا يتعارض مع مسار الطلبيات: كلمة «طلبية» غير مشروطة هنا، وجملة طلبية حقيقية
// («طلبية صيدلية النور بانادول 5 علبة») لا تحوي «شهر» فلا تُطابَق أبداً.
// ════════════════════════════════════════════════════════════════════════════

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

const stripLeadingConnectors = (s) =>
  String(s ?? '').replace(/^\s*(لشهر|لـ|ل|في|خلال|عن|مندوب|المندوب)\s+/u, '').trim();

// «محمد باقر لشهر 9» — الاسم ينتهي بـ«ل» ملتصقة بـ«شهر» (شهر المطابَقة لا تشمل
// الـ«ل» التي تسبقها)، فتبقى عالقة في طرف الاسم المستخرَج إن لم تُزَل هنا.
const stripTrailingConnectors = (s) =>
  String(s ?? '').replace(/\s+(ل|لـ|في|خلال|عن)\s*$/u, '').trim();

const trimPunct = (s) => stripTrailingConnectors(String(s ?? '').replace(/^[-–,\s]+|[-–,\s]+$/g, '').trim());

/**
 * @param {string} rawText
 * @returns {{repNameRaw:string, month:number, year:number, qualifier:string|null}|null}
 */
export function parseSalesQuery(rawText) {
  const text = toLatinDigits(String(rawText ?? '').trim());
  if (!text) return null;
  if (text.length > 300) return null; // سؤال فعلي قصير دوماً — نص طويل ليس سؤالاً

  const kwMatch = text.match(/مبيع(ات)?/);
  if (!kwMatch) return null;

  const monthMatch = text.match(/شهر\s*([0-9]{1,2})\b/);
  if (!monthMatch) return null;
  const month = Number(monthMatch[1]);
  if (!(month >= 1 && month <= 12)) return null;

  let phraseEnd = monthMatch.index + monthMatch[0].length;
  const afterMonth = text.slice(phraseEnd);
  const yearMatch = afterMonth.match(/^[\s,،\-]*(?:سنة|لسنة|عام)?\s*(20[0-9]{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  if (yearMatch) phraseEnd += yearMatch[0].length;

  const kwStart = kwMatch.index;
  const kwEnd = kwStart + kwMatch[0].length;

  // الكلمة المفتاحية عند بداية النص (تقريباً) ⇒ الاسم بعدها، قبل عبارة الشهر.
  // وإلا ⇒ الاسم قبل الكلمة المفتاحية بالكامل («محمد باقر مبيع شهر 9»).
  const name = kwStart <= 2
    ? stripLeadingConnectors(text.slice(kwEnd, monthMatch.index))
    : trimPunct(text.slice(0, kwStart));

  const repNameRaw = trimPunct(name);
  if (!repNameRaw) return null;

  const qualifier = trimPunct(text.slice(phraseEnd)) || null;

  return { repNameRaw, month, year, qualifier };
}
