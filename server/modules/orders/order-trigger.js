// ════════════════════════════════════════════════════════════════════════════
// order-trigger.js — هل هذه الرسالة طلبية أصلاً؟ (نقي: بلا DB وبلا Gemini)
//
// الكروبات المربوطة بالبوت كروبات مبيعات حقيقية فيها دردشة بشرية. تمرير كل رسالة
// على Gemini = تكلفة وضجيج وطلبيات وهمية، ولا يزال احتمالياً. فالقرار هنا حتمي
// وقابل للتدقيق من نص الرسالة وحده: كلمة مفتاحية في أول الرسالة، أو ردّ على رسالة
// البوت، أو كروب طلبيات مخصّص (orderTextMode = 'all').
//
// خط الدفاع الثاني ليس هنا بل في البرومبت («إن لم يكن النص طلبية فأعِد []») وفي
// أن شيئاً لا يُحفظ تلقائياً — أسوأ حالة لمفتاح خاطئ نداء Gemini واحد وصف معلَّق
// يحذفه المستخدم. هذا التفاوت هو ما يجعل الكلمة المفتاحية كافية بلا تصنيف ذكي.
// اختباره: node scripts/test-order-trigger.mjs
// ════════════════════════════════════════════════════════════════════════════

/** أوضاع قراءة النص لكل ربط كروب — عمود orderTextMode على TelegramChatLink/ViberChatLink. */
export const ORDER_TEXT_MODES = ['off', 'trigger', 'all'];

export const DEFAULT_ORDER_TEXT_MODE = 'trigger';

/** حدود الرسالة النصية — أقصر من هذا ليس طلبية، وأطول منه لا يُرسَل لـGemini. */
export const MIN_ORDER_TEXT_LEN = 15;
export const MAX_ORDER_TEXT_LEN = 4000;

// تطبيع عربي خفيف — نفس روح normalizeArabic في lib/itemResolver.js لكن محليّ هنا
// كي تبقى هذه الوحدة نقية بلا استيراد أي شيء يلمس قاعدة البيانات.
export function normalizeAr(s) {
  return String(s ?? '')
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ → ا
    .replace(/ة/g, 'ه')                      // ة → ه
    .replace(/ى/g, 'ي')                      // ى → ي
    .replace(/[ً-ٰٟـ]/g, '')       // تشكيل + تطويل
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // ٠-٩ → 0-9
    .replace(/[^\p{L}\p{N}]+/gu, ' ')                  // أي فاصل → مسافة
    .trim()
    .toLowerCase();
}

// الكلمات المفتاحية بعد التطبيع. «طلبية» و«طلبيه» و«الطلبية» تتوحّد كلها بالتطبيع
// (ة→ه وإسقاط «ال» غير مطبَّق هنا) فنسرد الصيغتين صراحةً.
const TRIGGER_WORDS = new Set([
  'طلبيه', 'الطلبيه', 'طلبيات', 'الطلبيات', 'طلب', 'الطلب',
  'اوردر', 'order', 'orders',
].map(normalizeAr));

/**
 * يزيل لاحقة اسم البوت من أمر تلكرام: «/order@MySalesBot» → «/order».
 * تلكرام يُلحق @BotName تلقائياً بالأوامر في الكروبات.
 */
export function stripBotCommandSuffix(token) {
  return String(token ?? '').replace(/@[\w_]+$/, '');
}

/**
 * يُسقط الكلمة المفتاحية من بداية النص إن وُجدت.
 * لازم لأن سطر الزبون كثيراً ما يُكتب ملتصقاً بها («طلبية صيدلية النور - الكرخ»)
 * فتتسرّب «طلبية» إلى اسم الصيدلية. حتميّ هنا بدل الاعتماد على الموديل.
 */
export function stripTriggerPrefix(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  const [first, ...rest] = s.split(/\s+/);
  return hasTriggerWord(first) ? rest.join(' ').trim() : s;
}

/** هل أول كلمة في النص كلمة مفتاحية؟ (الشرطة المائلة في /order تُسقَط بالتطبيع) */
export function hasTriggerWord(text) {
  const first = stripBotCommandSuffix(String(text ?? '').trim().split(/\s+/)[0] || '');
  const norm = normalizeAr(first);
  return norm.length > 0 && TRIGGER_WORDS.has(norm);
}

// كميات مكتوبة بالحروف — دليل كمية حين لا يوجد رقم. مطبَّعة (ة→ه) لأنها
// تُقارَن بنصّ مرّ على normalizeAr.
const QUANTITY_WORD_RE = /(علبه|علبتين|علب|حبه|حبتين|شريط|شريطين|درزن|قنينه|كرتون|نص دزن)/;

/**
 * القرار النهائي: هل نعالج هذه الرسالة كطلبية؟
 *
 * @param {string}  text          نص الرسالة، أو كابشن الصورة (قد يكون فارغاً لصورة بلا كابشن)
 * @param {string}  mode          orderTextMode من صف الربط
 * @param {object} [opts]
 * @param {boolean} opts.isReplyToBot  الرسالة ردّ على رسالة أرسلها البوت نفسه
 * @param {boolean} opts.hasMedia      معها صورة (فتُقبل بلا حدّ طول نصّي)
 * @returns {boolean}
 */
/**
 * نيّة صريحة = المستخدم قصد الطلبية فعلاً (كلمة مفتاحية أو ردّ على البوت)،
 * مقابل رسالة التقطها وضع «كل الرسائل» وحده. الفرق يحكم هل يردّ البوت حين لا
 * يجد أصنافاً: الردّ على نيّة صريحة مفيد، والردّ على كل رسالة بالكروب إزعاج.
 */
export function isExplicitOrderIntent(text, { isReplyToBot = false } = {}) {
  return Boolean(isReplyToBot) || hasTriggerWord(text);
}

export function isOrderTrigger(text, mode, { isReplyToBot = false, hasMedia = false } = {}) {
  const m = ORDER_TEXT_MODES.includes(mode) ? mode : DEFAULT_ORDER_TEXT_MODE;
  if (m === 'off') return false;

  const raw = String(text ?? '').trim();
  if (raw.length > MAX_ORDER_TEXT_LEN) return false; // لا يُرسَل نصّ ضخم لـGemini

  // الردّ على رسالة البوت نيّة صريحة — يكفي وحده في trigger و all.
  if (isReplyToBot) return true;

  if (hasTriggerWord(raw)) return true;
  if (m === 'trigger') return false;

  // mode === 'all' — مُرشِّح رخيص بلا نداء ذكاء: صورة تُقبل دائماً، والنص يلزمه
  // طول معقول + دليل كمية: رقم، أو كلمة عدّ مكتوبة بالحروف. الاكتفاء بالرقم
  // وحده كان يُسقط طلبيات حقيقية مثل «صيدلية النور بانادول علبتين».
  if (hasMedia) return true;
  if (raw.length < MIN_ORDER_TEXT_LEN) return false;
  const norm = normalizeAr(raw);
  return /\d/.test(norm) || QUANTITY_WORD_RE.test(norm);
}
