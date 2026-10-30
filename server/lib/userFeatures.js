// ════════════════════════════════════════════════════════════════════════════
// userFeatures.js — «هل الميزة مفعّلة لهذا الحساب؟» على السيرفر، بنفس قاعدة
// isFeatureEnabled في src/config/featureConfig.ts:
//  • ميزة عادية: مفعّلة ما لم تكن في permissions.disabledFeatures.
//  • ميزة اشتراك (optIn): مفعّلة فقط إن وُجدت في permissions.enabledFeatures ولم تُعطَّل.
// ════════════════════════════════════════════════════════════════════════════

function parsePerms(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/** user = صفّ User (أو أي كائن فيه permissions). */
export function userFeatureOn(user, key, { optIn = false } = {}) {
  const p = parsePerms(user?.permissions);
  if ((p.disabledFeatures ?? []).includes(key)) return false;
  return !optIn || (p.enabledFeatures ?? []).includes(key);
}
