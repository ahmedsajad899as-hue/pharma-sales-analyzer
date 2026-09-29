// إشارات خفيفة "فتح تطبيق"/"زيارة صفحة"/"نبضة وقت استخدام فعلي" — راجع server/modules/engagement.
// fire-and-forget بالكامل: لا تنتظر النتيجة ولا تُفشل أي شيء عند تعذّرها.
type PingType = 'app_open' | 'page_view' | 'heartbeat' | 'search' | 'calculate';

// المستخدمون في العراق (UTC+3) — يجب أن يطابق يوم "فتح التطبيق" يومهم المحلي
// لا يوم UTC، بنفس منطق dayKey في server/modules/engagement/engagement.controller.js.
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
function baghdadDayKey(t: number = Date.now()): string {
  return new Date(t + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

// نبضة "فتح تطبيق" مرة واحدة لكل يوم (بتوقيت بغداد) لكل مستخدم — بدل مرة
// واحدة لكل جلسة تبويب. فلو بقي التبويب مفتوحاً من يوم سابق، أول نشاط اليوم
// يسجّل فتحاً جديداً بدل أن يبقى "عدد مرات الدخول اليوم" صفراً رغم نشاط فعلي
// حديث. المفتاح مرتبط بمعرّف المستخدم (وليس عاماً) لأن جهازاً واحداً قد
// يُستخدم لأكثر من حساب عبر ميزة "تبديل الحساب".
export function pingAppOpenIfNewDay(userId?: number | string) {
  try {
    const storageKey = `engagement_app_open_day:${userId ?? 'anon'}`;
    const today = baghdadDayKey();
    if (localStorage.getItem(storageKey) === today) return;
    localStorage.setItem(storageKey, today);
    sendEngagementPing('app_open');
  } catch {
    // تجاهل أي بيئة لا تدعم storage
  }
}

export function sendEngagementPing(type: PingType, page?: string, seconds?: number) {
  try {
    if (sessionStorage.getItem('_is_impersonating') === '1') return; // لا نسجّل نشاطاً باسم حساب مُراقَب
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    fetch('/api/engagement/ping', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type, page, seconds }),
    })
      .then(r => { if (!r.ok) console.warn('[engagement] ping rejected', type, r.status); })
      .catch(() => {});
  } catch {
    // تجاهل أي بيئة لا تدعم storage/fetch
  }
}

// نبضة "بحث باسم" مؤجَّلة — بعض صناديق البحث (SmartSearch) تُصفّي محلياً بلا
// أي طلب للسيرفر، فنؤخّر النبضة كي لا نُسجّل حركة واحدة لكل ضغطة حرف أثناء الكتابة.
const searchDebounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export function sendSearchPingDebounced(page: string, key: string = page) {
  clearTimeout(searchDebounceTimers[key]);
  searchDebounceTimers[key] = setTimeout(() => sendEngagementPing('search', page), 500);
}
