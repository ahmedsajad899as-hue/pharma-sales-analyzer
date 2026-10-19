// ════════════════════════════════════════════════════════════════════════════
// ثيم الوقت — ألوان خلفية التطبيق تتبع ساعة المستخدم (فجر · نهار · غروب · ليل).
//
// ميزة لكل حساب، **معطّلة افتراضياً**: لا تعمل إلا إذا فعّلها السوبر أدمن لحساب
// بعينه (permissions.timeTheme === true — شاشة المستخدمين ← «ثيم الوقت»).
// • App.tsx يضع data-tod على .app-shell → خلفية ناعمة لكل الصفحات (App.css).
// • HomePage يستعمله لسماء واجهة «اللوحة»؛ بدون الميزة تبقى سماء النهار الأصلية.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

export type TimeOfDay = 'dawn' | 'day' | 'sunset' | 'night';

export const timeOfDay = (h: number): TimeOfDay =>
  h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'sunset' : 'night';

/** هل فعّل السوبر أدمن ثيم الوقت لهذا الحساب؟ */
export function useTimeThemeEnabled(): boolean {
  const { user } = useAuth();
  try { return JSON.parse(user?.permissions || '{}').timeTheme === true; } catch { return false; }
}

/** وقت اليوم الحالي (يتحدّث كل 5 دقائق) — أو null حين الميزة معطّلة للحساب. */
export function useTimeOfDay(): TimeOfDay | null {
  const enabled = useTimeThemeEnabled();
  const [tod, setTod] = useState<TimeOfDay>(() => timeOfDay(new Date().getHours()));
  useEffect(() => {
    if (!enabled) return;
    setTod(timeOfDay(new Date().getHours()));
    const id = window.setInterval(() => setTod(timeOfDay(new Date().getHours())), 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return enabled ? tod : null;
}
