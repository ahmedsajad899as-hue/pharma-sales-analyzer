import { useEffect, useRef } from 'react';
import { sendEngagementPing } from '../lib/engagementPing';

// أي تفاعل فعلي (حركة ماوس/ضغط مفتاح/سكرول/لمس) يُحتسب دقيقة كاملة فوراً —
// لا ننتظر مرور 60 ثانية متواصلة من الاستخدام لنبدأ الاحتساب. الدقيقة نفسها
// تبقى "مفتوحة" لمدة 60 ثانية من لحظة احتسابها فلا تُحتسب دقيقة جديدة أثناءها
// حتى لو تكرر التفاعل؛ وبعد انتهائها، أول تفاعل جديد يفتح دقيقة أخرى فوراً —
// حتى لو كانت المدة الفعلية للاستخدام في تلك اللحظة ثوانٍ معدودة فقط.
const MINUTE_MS = 60_000;

export function useEngagementHeartbeat(activePage: string, enabled: boolean) {
  const lastCreditRef = useRef<number | null>(null);
  const pageRef = useRef(activePage);
  pageRef.current = activePage;

  useEffect(() => {
    if (!enabled) return;

    const onInteraction = () => {
      const isVisible = document.visibilityState === 'visible' && document.hasFocus();
      if (!isVisible) return;

      const now = Date.now();
      if (lastCreditRef.current !== null && now - lastCreditRef.current < MINUTE_MS) return;

      lastCreditRef.current = now;
      sendEngagementPing('heartbeat', pageRef.current, 60);
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, onInteraction, { passive: true }));

    return () => {
      events.forEach(e => window.removeEventListener(e, onInteraction));
    };
  }, [enabled]);
}
