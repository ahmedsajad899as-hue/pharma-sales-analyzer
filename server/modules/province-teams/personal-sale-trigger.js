// ════════════════════════════════════════════════════════════════════════════
// personal-sale-trigger.js — هل رسالة البوت «جهد شخصي» لا طلبية؟ (نقي)
//
// المندوب يبدأ رسالته بـ«مبيعي» (أو «جهدي»/«بيعي»/«مبيعاتي») ثم يكتب الصيدلية
// والأصناف كما يكتب الطلبية تماماً. الاستخراج نفسه (Gemini + مطابقة الكتالوج)
// يُعاد استعماله من مسار الطلبيات؛ الفرق الوحيد أين تُحفظ الصفوف.
//
// يُفحص **قبل** مسار الطلبيات وقبل سؤال المبيعات: «مبيعي» تحوي «مبيع» التي
// يلتقطها سؤال المبيعات لو جاء معها «شهر N».
// اختباره: npm run test:province-teams
// ════════════════════════════════════════════════════════════════════════════

import { normalizeAr, stripBotCommandSuffix } from '../orders/order-trigger.js';

const WORDS = new Set(['مبيعي', 'مبيعاتي', 'جهدي', 'بيعي', 'جهد'].map(normalizeAr));

/** هل أول كلمة في النص كلمة «جهد شخصي»؟ */
export function hasPersonalSaleTrigger(text) {
  const first = stripBotCommandSuffix(String(text ?? '').trim().split(/\s+/)[0] || '');
  const norm = normalizeAr(first);
  return norm.length > 0 && WORDS.has(norm);
}

/** يُسقط الكلمة المفتاحية من البداية كي لا تتسرّب لاسم الصيدلية. */
export function stripPersonalSaleTrigger(text) {
  const s = String(text ?? '').trim();
  if (!hasPersonalSaleTrigger(s)) return s;
  // إسقاط أول كلمة فقط مع إبقاء فواصل الأسطر — الاستخراج يعتمد على «سطر للصيدلية
  // ثم سطر لكل صنف».
  return s.replace(/^\S+[^\S\n]*\n?/, '').trim();
}
