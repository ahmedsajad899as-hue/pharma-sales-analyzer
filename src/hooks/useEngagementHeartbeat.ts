import { useEffect, useRef } from 'react';
import { sendEngagementPing } from '../lib/engagementPing';

// كل كم ثانية نرسل نبضة "وقت استخدام فعلي" — راجع server/modules/engagement.
const TICK_MS = 60_000;
// إن مرّت هذه المدة بلا أي تفاعل (فأرة/لوحة مفاتيح/لمس) نعتبر المستخدم متروكاً
// أمام الشاشة لا "يستخدم" التطبيق فعلاً، فلا نحتسب الوقت.
const IDLE_THRESHOLD_MS = 3 * 60_000;
// سقف لكل نبضة يحمي من قفزة ضخمة بعد نوم الجهاز/الجهاز معلّق (الوقت الفعلي
// المنقضي قد يكون ساعات رغم أن المؤقّت جدولته بعد 60 ثانية فقط).
const MAX_TICK_SECONDS = 90;

/**
 * يحسب "الوقت المستغرق داخل التطبيق" فعلياً (لا مجرد بقاء التبويب مفتوحاً):
 * التبويب ظاهر + النافذة تملك التركيز + تفاعل حقيقي خلال آخر IDLE_THRESHOLD_MS.
 */
export function useEngagementHeartbeat(activePage: string, enabled: boolean) {
  const lastInteractionRef = useRef(Date.now());
  const lastTickRef = useRef(Date.now());
  const pageRef = useRef(activePage);
  pageRef.current = activePage;

  useEffect(() => {
    if (!enabled) return;

    const markInteraction = () => { lastInteractionRef.current = Date.now(); };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, markInteraction, { passive: true }));

    const timer = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.min((now - lastTickRef.current) / 1000, MAX_TICK_SECONDS);
      lastTickRef.current = now;

      const isVisible = document.visibilityState === 'visible' && document.hasFocus();
      const isIdle = now - lastInteractionRef.current > IDLE_THRESHOLD_MS;
      if (!isVisible || isIdle) return;

      sendEngagementPing('heartbeat', pageRef.current, Math.round(elapsedSec));
    }, TICK_MS);

    // لا نحتسب فترة الغياب عن التبويب عند العودة إليه — إعادة ضبط نقطة البداية فقط
    const onVisible = () => { if (document.visibilityState === 'visible') lastTickRef.current = Date.now(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      events.forEach(e => window.removeEventListener(e, markInteraction));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}
