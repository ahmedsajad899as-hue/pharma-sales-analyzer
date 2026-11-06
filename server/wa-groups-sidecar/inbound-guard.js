// ════════════════════════════════════════════════════════════════════════════
// inbound-guard.js — قرارات استقبال رسائل الكروبات (نقي: بلا Baileys وبلا شبكة).
// اختباره: npm run test:wa-groups
//
// لماذا: Baileys يوسم كل رسالة وصلت أثناء انقطاعنا بـ'append' لا 'notify'
// (messages-recv.js: `node.attrs.offline ? 'append' : 'notify'`). تجاهل append كان
// يُسقط طلبيات الكروب كلها في نافذة الانقطاع بصمت. لكن append يشمل أيضاً رسائل قديمة،
// فلا تُقبل إلا الحديثة، ويمنع سجلّ «المعالَج» تكرار قراءتها (والتوكنز) عند إعادة تسليمها.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

// بعمر مهلة إعادة القراءة في التطبيق (RETRY_MAX_AGE_MS): أقدم من هذا لم يعد طلبية يُنتظر تسجيلها.
export const MAX_OFFLINE_AGE_MS = 48 * 60 * 60 * 1000;
// أطول من عمر الرسالة المقبولة، كي لا تُنسى رسالة ما زالت قابلة لإعادة التسليم.
export const SEEN_TTL_MS = 72 * 60 * 60 * 1000;
// مجموعها نحو 4 دقائق — يغطّي إعادة تشغيل التطبيق عند كل نشر.
export const FORWARD_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 120_000];

/** وقت الرسالة بالميلي ثانية، أو null. الطابع قد يكون رقماً أو Long حسب نوع الرسالة. */
export function messageTimeMs(msg) {
  const t = msg?.messageTimestamp;
  if (t === null || t === undefined) return null;
  const sec = typeof t === 'object'
    ? (typeof t.toNumber === 'function' ? t.toNumber() : Number(t.low))
    : Number(t);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

/** هل نعالج هذه الرسالة؟ المباشرة دائماً؛ رسالة الانقطاع فقط إن ثبت أنها حديثة. */
export function shouldHandleUpsert(type, msg, now = Date.now()) {
  if (type === 'notify') return true;
  if (type !== 'append') return false;
  const at = messageTimeMs(msg);
  return at !== null && now - at <= MAX_OFFLINE_AGE_MS;
}

/** سجلّ على القرص بمعرّفات الرسائل التي مُرّرت للتطبيق — يبقى بعد إعادة تشغيل الخدمة. */
export function createSeenStore(file, { ttlMs = SEEN_TTL_MS, now = () => Date.now() } = {}) {
  let ids = {};
  try { ids = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { ids = {}; }
  const save = () => {
    const t = now();
    for (const [id, at] of Object.entries(ids)) if (t - at > ttlMs) delete ids[id];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(ids));
    } catch (e) { console.error('[wa-groups] حفظ سجلّ الرسائل:', e.message); }
  };
  return {
    has: (id) => Object.hasOwn(ids, id) && now() - ids[id] <= ttlMs,
    add: (id) => { ids[id] = now(); save(); },
    delete: (id) => { if (Object.hasOwn(ids, id)) { delete ids[id]; save(); } },
    clear: () => { ids = {}; },
  };
}

/**
 * يرسل مع إعادة عند انقطاع التطبيق أو 5xx. رفض صريح (4xx) لا يزول بالإعادة.
 * @param {() => Promise<{ok:boolean,status:number}>} send
 * @returns {Promise<boolean>} true إن أقرّ التطبيق بالاستلام
 */
export async function forwardWithRetry(send, {
  delays = FORWARD_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  onError = () => {},
} = {}) {
  for (let attempt = 0; ; attempt++) {
    let why;
    try {
      const res = await send();
      if (res.ok) return true;
      if (res.status < 500) { onError(`HTTP ${res.status}`, null); return false; }
      why = `HTTP ${res.status}`;
    } catch (e) {
      why = e?.message || String(e);
    }
    const delay = delays[attempt];
    onError(why, delay ?? null);
    if (delay === undefined) return false;
    await sleep(delay);
  }
}
