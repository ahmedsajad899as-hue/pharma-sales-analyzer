// claudeAi.js — نقطة النداء الوحيدة للذكاء الاصطناعي (Claude). كل الميزات تمرّ من هنا
// حتى يُسجَّل استهلاكها في نافذة الاستهلاك (ماستر أدمن) ولا يُكتب اسم نموذج في مكان آخر.
//
// المدخلات بنفس شكل أجزاء Gemini القديم حتى لا تتغيّر النداءات:
//   نص خام | { text } | { inlineData: { mimeType, data(base64) } } للصور.
import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from './aiUsage.js';

export const AI_MODEL = 'claude-sonnet-5-5';

const DEFAULT_TIMEOUT_MS = 55_000; // قصير للمساعد؛ النداءات الثقيلة تمرّر أكثر (Nginx يسمح بـ300s)
const MAX_OUTPUT_TOKENS  = 16_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY غير مهيأ');
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function toContent(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  return list.map(p => {
    if (typeof p === 'string') return { type: 'text', text: p };
    if (p?.inlineData) {
      const mt = String(p.inlineData.mimeType || 'image/jpeg').toLowerCase();
      if (!IMAGE_TYPES.has(mt)) throw new Error(`نوع ملف غير مدعوم: ${mt}`);
      return { type: 'image', source: { type: 'base64', media_type: mt, data: p.inlineData.data } };
    }
    return { type: 'text', text: String(p?.text ?? '') };
  });
}

function errorKind(err) {
  if (err instanceof Anthropic.RateLimitError) return '429';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  return 'error';
}

// يُعيد نص الرد. الخيارات:
//   timeoutMs      — مهلة النداء (افتراضي 55s).
//   maxTotalMs     — ميزانية كلية تشمل إعادة المحاولة، حتى ينتهي قبل مهلة Nginx.
//   thinkingBudget — 0 = بلا تفكير (الأسرع، لمهام المطابقة والتصنيف)؛ غير ذلك تفكير تكيّفي بجهد منخفض.
//   feature        — وسم الميزة في سجل الاستهلاك.
export async function callAI(parts, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTotalMs = null,
    thinkingBudget = null,
    feature = 'other',
  } = opts;
  if (maxTotalMs != null && maxTotalMs <= 0) throw new Error(`AI total budget exhausted`);
  const timeout = maxTotalMs != null ? Math.min(timeoutMs, maxTotalMs) : timeoutMs;

  const params = {
    model: AI_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: toContent(parts) }],
    // عند رفض النموذج لأسباب السلامة يُعاد الطلب تلقائياً على نموذج بديل داخل نفس النداء.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(thinkingBudget === 0
      ? { thinking: { type: 'between_tools' } }
      : { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }),
  };

  const started = Date.now();
  try {
    const msg = await getClient().beta.messages.create(params, {
      timeout,
      maxRetries: maxTotalMs != null && maxTotalMs < timeout * 2 ? 0 : 1,
    });
    const u = msg.usage || {};
    const promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    logAiUsage({ feature, model: msg.model || AI_MODEL, ok: true, promptTokens, outputTokens: u.output_tokens || 0, durationMs: Date.now() - started });
    if (msg.stop_reason === 'refusal') throw new Error('رفض النموذج الطلب');
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  } catch (err) {
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError) {
      logAiUsage({ feature, model: AI_MODEL, ok: false, errorKind: errorKind(err), durationMs: Date.now() - started });
      console.error(`[ai] ${AI_MODEL} ${errorKind(err)}:`, String(err?.message || '').slice(0, 200));
    }
    throw err;
  }
}

// رسالة عربية مفهومة للمستخدم من خطأ النداء.
export function friendlyAiError(err) {
  if (err instanceof Anthropic.RateLimitError) return '⚠️ تم تجاوز حدّ طلبات الذكاء الاصطناعي مؤقتاً. حاول بعد دقيقة.';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return '⚠️ تأخّر رد الذكاء الاصطناعي. حاول مجدداً.';
  return `AI Error: ${String(err?.message || 'خطأ غير متوقع').slice(0, 400)}`;
}
