// geminiAi.js — نقطة النداء الوحيدة للذكاء الاصطناعي (Gemini). كل الميزات تمرّ من هنا
// حتى يُسجَّل استهلاكها في نافذة الاستهلاك (ماستر أدمن) ولا يُكتب اسم نموذج في مكان آخر.
//
// المدخلات: نص خام | { text } | { inlineData: { mimeType, data(base64) } } للصور.
//
// REST مباشر بلا SDK، والمفتاح في الترويسة لا في الرابط حتى لا يظهر في أي سجل
// (فاتورة 2026-10-22 كانت من مفتاح Gemini استُخدم خارج الموقع — ارجع للذاكرة).
import { AsyncLocalStorage } from 'node:async_hooks';
import { logAiUsage } from './aiUsage.js';
import { modelForMode } from './aiModelSettings.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
// موديل مختلف لميزة بعينها. لا تنقل ميزة هنا بلا مقارنة على بيانات حقيقية: في اختبار
// 2026-11-06 جاء 3.5-flash-lite مطابقاً تقريباً في طلبيات النص (29/30) وبنصف الكلفة،
// لكنه أخطأ في أسماء الصيدليات والتواريخ على صور الفواتير فبقيت الصور على الافتراضي.
const FEATURE_MODELS = {
  'bot-order-text': 'gemini-3.5-flash-lite',
};
export const modelForFeature = (feature) => FEATURE_MODELS[feature] || DEFAULT_MODEL;
const apiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const DEFAULT_TIMEOUT_MS = 55_000; // قصير للمساعد؛ النداءات الثقيلة تمرّر أكثر (Nginx يسمح بـ300s)
const MAX_OUTPUT_TOKENS  = 16_000;
const RETRY_DELAY_MS     = 1_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// مجمّع نداءات اختياري: من يلفّ عمله بـ aiCallScope.run([], fn) يجد في المصفوفة كل نداء
// جرى داخله (حتى المتوازية والمتداخلة) — هكذا يُحسب ما كلّفته صورة فاتورة واحدة كاملةً
// (InvoiceReadLog) بلا تمرير معامل عبر كل الدوال.
export const aiCallScope = new AsyncLocalStorage();
const noteCall = (entry) => { try { aiCallScope.getStore()?.push(entry); } catch { /* لا يُفشل النداء */ } };

class GeminiError extends Error {
  constructor(message, kind, status) { super(message); this.kind = kind; this.status = status; }
}

function toParts(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  return list.map(p => {
    if (typeof p === 'string') return { text: p };
    if (p?.inlineData) {
      const mimeType = String(p.inlineData.mimeType || 'image/jpeg').toLowerCase();
      if (!IMAGE_TYPES.has(mimeType)) throw new Error(`نوع ملف غير مدعوم: ${mimeType}`);
      return { inlineData: { mimeType, data: p.inlineData.data } };
    }
    return { text: String(p?.text ?? '') };
  });
}

async function once(model, body, timeout) {
  let res;
  try {
    res = await fetch(apiUrl(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError';
    throw new GeminiError(`Gemini ${isTimeout ? 'timeout' : 'connection'}: ${err?.message}`, isTimeout ? 'timeout' : 'connection');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GeminiError(`Gemini HTTP ${res.status}: ${String(json?.error?.message || '').slice(0, 300)}`,
      res.status === 429 ? '429' : 'error', res.status);
  }
  return json;
}

// نفس ما يُعاد عادةً: ضغط مؤقت (429/5xx/408) أو انقطاع. خطأ الطلب نفسه (400/401/403/404) لا يزول بالإعادة.
const isRetryable = (err) => err instanceof GeminiError
  && (err.kind === '429' || err.kind === 'timeout' || err.kind === 'connection' || err.status === 408 || err.status >= 500);

// يُعيد نص الرد. الخيارات:
//   timeoutMs      — مهلة النداء (افتراضي 55s).
//   maxTotalMs     — ميزانية كلية تشمل إعادة المحاولة، حتى ينتهي قبل مهلة Nginx.
//   thinkingBudget — مقبول من النداءات القائمة، لكن 3.8-flash لا يملك إطفاء التفكير:
//                    أدنى مستوى عنده LOW فتعمل به كل النداءات (الافتراضي MEDIUM أبطأ وأغلى).
//   feature        — وسم الميزة في سجل الاستهلاك.
export async function callAI(parts, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTotalMs = null,
    feature = 'other',
    mediaResolution = null, // 'MEDIA_RESOLUTION_LOW' ≈ 280 token/صورة بدل ~1100 — لما لا يحتاج قراءة حروف صغيرة
    model: forcedModel = null, // نموذج صريح (مسار auto في الفواتير يعيد بالأقوى)
  } = opts;
  // الترتيب: نموذج صريح ← اختيار الماستر للميزة (aiModelSettings) ← FEATURE_MODELS ← الافتراضي.
  const model = forcedModel || (await modelForMode(feature)) || modelForFeature(feature);
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY غير مهيأ');
  if (maxTotalMs != null && maxTotalMs <= 0) throw new Error('AI total budget exhausted');
  const timeout = maxTotalMs != null ? Math.min(timeoutMs, maxTotalMs) : timeoutMs;
  const canRetry = maxTotalMs == null || maxTotalMs >= timeout * 2 + RETRY_DELAY_MS;

  const body = {
    contents: [{ role: 'user', parts: toParts(parts) }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: 'LOW' },
      ...(mediaResolution ? { mediaResolution } : {}),
    },
  };

  const started = Date.now();
  let promptTokens = 0, outputTokens = 0;
  try {
    let json;
    try { json = await once(model, body, timeout); }
    catch (err) {
      if (!canRetry || !isRetryable(err)) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      json = await once(model, body, timeout);
    }

    const u = json.usageMetadata || {};
    promptTokens = u.promptTokenCount || 0;
    outputTokens = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); // التفكير يُحاسَب كإخراج

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!text) {
      throw new GeminiError(`رد فارغ من النموذج (${json.promptFeedback?.blockReason || candidate?.finishReason || 'بلا سبب'})`, 'error');
    }
    if (candidate.finishReason === 'MAX_TOKENS') console.warn(`[ai] ${model} (${feature}): الرد مقطوع عند حد التوكنز`);

    logAiUsage({ feature, model: json.modelVersion || model, ok: true, promptTokens, outputTokens, durationMs: Date.now() - started });
    noteCall({ feature, model, ok: true, promptTokens, outputTokens });
    return text;
  } catch (err) {
    const kind = err?.kind === 'connection' ? 'error' : (err?.kind || 'error');
    logAiUsage({ feature, model, ok: false, errorKind: kind, promptTokens, outputTokens, durationMs: Date.now() - started });
    noteCall({ feature, model, ok: false, promptTokens, outputTokens });
    console.error(`[ai] ${model} ${kind}:`, String(err?.message || '').slice(0, 300));
    throw err;
  }
}

// رسالة عربية مفهومة للمستخدم من خطأ النداء.
export function friendlyAiError(err) {
  if (err?.kind === '429') return '⚠️ تم تجاوز حدّ طلبات الذكاء الاصطناعي مؤقتاً. حاول بعد دقيقة.';
  if (err?.kind === 'timeout') return '⚠️ تأخّر رد الذكاء الاصطناعي. حاول مجدداً.';
  return `AI Error: ${String(err?.message || 'خطأ غير متوقع').slice(0, 400)}`;
}
