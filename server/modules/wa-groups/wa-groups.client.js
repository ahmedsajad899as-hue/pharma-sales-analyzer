// ════════════════════════════════════════════════════════════════════════════
// wa-groups.client.js — عميل خدمة «رقم الكروبات» (server/wa-groups-sidecar).
//
// الخدمة عملية PM2 مستقلة (wa-groups) تشغّل واتساب ويب غير رسمي (Baileys) على
// شريحة مخصّصة، لأن الـCloud API الرسمي لا يرسل لكروبات واتساب العادية. تسمع على
// 127.0.0.1 فقط ويحرسها سرّ مشترك WA_GROUPS_SECRET. إن لم تكن مشغّلة فكل نداء
// يُعيد { error } — والتطبيق الرئيسي يعمل كالمعتاد.
// ════════════════════════════════════════════════════════════════════════════

const baseUrl = () => process.env.WA_GROUPS_URL || 'http://127.0.0.1:8091';
export const groupsSecret = () => process.env.WA_GROUPS_SECRET || '';
export const groupsConfigured = () => Boolean(groupsSecret());

/** لا يرمي أبداً: { data } أو { error }. */
export async function sidecar(path, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  if (!groupsConfigured()) return { error: 'رقم الكروبات غير مفعّل (WA_GROUPS_SECRET غير مضبوط)' };
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'x-wa-groups-secret': groupsSecret(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    return { data };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'خدمة رقم الكروبات لا تستجيب' : 'خدمة رقم الكروبات غير مشغّلة' };
  }
}

/** نصّ لكروب، اختيارياً ردّاً على رسالة سابقة. يُعيد { id } أو { error }. */
export async function sendGroupText(jid, text, { quotedId } = {}) {
  const r = await sidecar('/send', { method: 'POST', body: { jid, text, quotedId } });
  return r.data?.id ? { id: r.data.id } : { error: r.error || 'تعذّر الإرسال للكروب' };
}
