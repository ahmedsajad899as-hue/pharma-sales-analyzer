import { useEffect, useState } from 'react';

// نفس حدّ قواعد الهاتف في App.css (@media max-width: 767px). يُستعمل حين يحتاج الهاتف
// تخطيطاً مختلفاً لا يكفيه CSS (بطاقات بدل جدول) — الشاشات الأعرض لا تتغيّر أبداً.
const QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}
