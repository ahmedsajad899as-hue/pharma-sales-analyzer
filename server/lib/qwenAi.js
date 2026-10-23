// qwenAi.js — نداء Qwen-VL (Alibaba DashScope، واجهة متوافقة مع OpenAI) لقراءة صور الفواتير.
// نفس شكل الأجزاء في callAI: نص خام | { text } | { inlineData: { mimeType, data(base64) } }.
// يُسجَّل في نافذة الاستهلاك مثل Claude (اسم النموذج يفرّقهما).
import { logAiUsage } from './aiUsage.js';

export const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-vl-plus';
const BASE_URL = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 55_000;

export const qwenConfigured = () => Boolean(process.env.DASHSCOPE_API_KEY);

function toContent(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  // الصور قبل النص — توصية Qwen-VL
  const images = [], texts = [];
  for (const p of list) {
    if (p?.inlineData) {
      const mt = String(p.inlineData.mimeType || 'image/jpeg').toLowerCase();
      images.push({ type: 'image_url', image_url: { url: `data:${mt};base64,${p.inlineData.data}` } });
    } else {
      texts.push({ type: 'text', text: typeof p === 'string' ? p : String(p?.text ?? '') });
    }
  }
  return [...images, ...texts];
}

class QwenError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

async function once(body, timeout) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new QwenError(`Qwen ${err?.name === 'TimeoutError' ? 'timeout' : 'connection'}: ${err?.message}`,
      err?.name === 'TimeoutError' ? 'timeout' : 'error');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new QwenError(`Qwen HTTP ${res.status}: ${String(json?.error?.message || '').slice(0, 200)}`,
      res.status === 429 ? '429' : 'error');
  }
  return json;
}

// يُعيد نص الرد. الخيارات: timeoutMs, maxTotalMs, feature (كما في callAI).
export async function callQwen(parts, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxTotalMs = null, feature = 'other' } = opts;
  if (!qwenConfigured()) throw new Error('DASHSCOPE_API_KEY غير مهيأ');
  if (maxTotalMs != null && maxTotalMs <= 0) throw new Error('AI total budget exhausted');
  const timeout = maxTotalMs != null ? Math.min(timeoutMs, maxTotalMs) : timeoutMs;
  const canRetry = maxTotalMs == null || maxTotalMs >= timeout * 2;
  const body = { model: QWEN_MODEL, messages: [{ role: 'user', content: toContent(parts) }] };

  const started = Date.now();
  try {
    let json;
    try { json = await once(body, timeout); }
    catch (err) {
      if (!canRetry || !(err instanceof QwenError) || (err.kind !== '429' && !/HTTP 5\d\d/.test(err.message))) throw err;
      json = await once(body, timeout);
    }
    const u = json.usage || {};
    logAiUsage({ feature, model: json.model || QWEN_MODEL, ok: true, promptTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, durationMs: Date.now() - started });
    return String(json.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    logAiUsage({ feature, model: QWEN_MODEL, ok: false, errorKind: err?.kind || 'error', durationMs: Date.now() - started });
    console.error(`[ai] ${QWEN_MODEL} ${err?.kind || 'error'}:`, String(err?.message || '').slice(0, 200));
    throw err;
  }
}
