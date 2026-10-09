// ════════════════════════════════════════════════════════════════════════════
// followup-query-trigger.js — هل هذه رسالة سؤال عن متابعة/تقييم مندوب؟
// («متابعة محمد باقر» أو «تقييم محمد باقر شهر 9» → اسم + شهر).
// منطق نقيّ بلا قاعدة بيانات (نفس روح sales-query-trigger.js المجاور).
// اختباره: npm run test:followup-query
//
// الشرط: كلمة من كلمات المتابعة (متابعة/تقييم/مستوى/سكور). الشهر اختياري
// (الافتراضي: الشهر الحالي) بعكس سؤال المبيعات الذي يُلزم «شهر N» — لأن المتابعة
// سؤال عن «الآن» بطبعه.
//
// لا يتعارض مع المسارين الآخرين:
// • الطلبيات: لا تحوي كلمات المتابعة، وهذا الفحص يجري **قبل** مسار الطلبيات كي
//   لا يُقرأ «متابعة أحمد شهر 9» كطلبية في كروب مضبوط على orderTextMode='all'.
// • المبيعات: لو حوت الرسالة «مبيع»+«شهر N» فهي سؤال مبيعات ويُفحَص أولاً —
//   نُرجِع null هنا لئلا يُجاب على نفس الرسالة مرتين.
// ════════════════════════════════════════════════════════════════════════════

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

// صيغ «عن نفسي»: متابعتي/تقييمي/مستواي/سكوري — لا تحتاج اسماً.
// بلا \b عمداً: الحروف العربية ليست \w في JS، فـ\b بعد «ي» لا يتحقّق أبداً أمام
// مسافة ويصير النمط ميتاً. نهاية الكلمة تُفحَص بنظرة أمامية صريحة.
const SELF_RE = /(متابعت|تقييم|مستوا|سكور)(ي|نا)(?=$|[\s,،.?؟!])/u;
// كلمات المتابعة العامة. «متابعة» تشمل «المتابعة»، و«تقييم» تشمل «التقييم».
const KEYWORD_RE = /(متابعة|متابعه|تقييم|مستوى|سكور)/u;

const stripLeadingConnectors = (s) =>
  String(s ?? '').replace(/^\s*(لـ|ل|عن|في|خلال|مندوب|المندوب|حساب)\s+/u, '').trim();

const stripTrailingConnectors = (s) =>
  String(s ?? '').replace(/\s+(ل|لـ|في|خلال|عن)\s*$/u, '').trim();

const trimPunct = (s) => stripTrailingConnectors(String(s ?? '').replace(/^[-–,،?؟\s]+|[-–,،?؟\s]+$/g, '').trim());

/**
 * @param {string} rawText
 * @returns {{repNameRaw:string|null, month:number|null, year:number, qualifier:string|null, self:boolean}|null}
 *   repNameRaw=null مع self=true ⇒ «أعطني تقييمي أنا».
 *   month=null ⇒ الشهر الحالي (يُحسم عند المعالجة لا هنا، فالمحلّل بلا زمن).
 */
export function parseFollowupQuery(rawText) {
  const text = toLatinDigits(String(rawText ?? '').trim());
  if (!text) return null;
  if (text.length > 300) return null; // سؤال فعلي قصير دوماً

  // «متابعتي» لا تحوي «متابعة» (تاء مفتوحة لا هاء)، و«مستواي» لا تحوي «مستوى» —
  // فصيغة «عن نفسي» تُفحَص أولاً وإلا سقطت على بوابة الكلمات العامة.
  const self = SELF_RE.test(text);
  if (!self && !KEYWORD_RE.test(text)) return null;

  // سؤال مبيعات صريح ⇒ ليس سؤال متابعة (يُجاب عليه في مساره).
  if (/مبيع(ات)?/.test(text) && /شهر\s*([0-9]{1,2})\b/.test(text)) return null;

  // الشهر والسنة اختياريان.
  let month = null;
  let year = new Date().getFullYear();
  let monthStart = -1, monthEnd = -1;
  const monthMatch = text.match(/شهر\s*([0-9]{1,2})\b/);
  if (monthMatch) {
    const m = Number(monthMatch[1]);
    if (m >= 1 && m <= 12) {
      month = m;
      monthStart = monthMatch.index;
      monthEnd = monthMatch.index + monthMatch[0].length;
      const after = text.slice(monthEnd);
      const yearMatch = after.match(/^[\s,،\-]*(?:سنة|لسنة|عام)?\s*(20[0-9]{2})/);
      if (yearMatch) { year = Number(yearMatch[1]); monthEnd += yearMatch[0].length; }
    }
  }

  if (self) return { repNameRaw: null, month, year, qualifier: null, self: true };

  const kw = text.match(KEYWORD_RE);
  const kwStart = kw.index;
  const kwEnd = kwStart + kw[0].length;

  // الكلمة المفتاحية في أول الرسالة ⇒ الاسم بعدها («متابعة محمد باقر»).
  // وإلا ⇒ الاسم قبلها («محمد باقر متابعة»).
  let name;
  if (kwStart <= 2) {
    const upto = monthStart > kwEnd ? monthStart : text.length;
    name = stripLeadingConnectors(text.slice(kwEnd, upto));
  } else {
    name = text.slice(0, kwStart);
  }
  const repNameRaw = trimPunct(name);

  // بلا اسم ولا صيغة «عن نفسي»: «متابعة» وحدها ⇒ تقييم السائل نفسه. أقرب نية
  // معقولة، وأفضل من صمت لا يفهمه المستخدم.
  if (!repNameRaw) return { repNameRaw: null, month, year, qualifier: null, self: true };

  // ما بعد عبارة الشهر = مؤهِّل (شركة/مكتب) لفكّ الالتباس عند تشابه الأسماء.
  const qualifier = monthEnd > 0 ? (trimPunct(text.slice(monthEnd)) || null) : null;

  return { repNameRaw, month, year, qualifier, self: false };
}
