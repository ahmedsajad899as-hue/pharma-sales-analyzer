// إشارات خفيفة "فتح تطبيق"/"زيارة صفحة"/"نبضة وقت استخدام فعلي" — راجع server/modules/engagement.
// fire-and-forget بالكامل: لا تنتظر النتيجة ولا تُفشل أي شيء عند تعذّرها.
type PingType = 'app_open' | 'page_view' | 'heartbeat' | 'search' | 'calculate';

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
