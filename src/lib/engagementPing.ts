// إشارات خفيفة "فتح تطبيق"/"زيارة صفحة"/"نبضة وقت استخدام فعلي" — راجع server/modules/engagement.
// fire-and-forget بالكامل: لا تنتظر النتيجة ولا تُفشل أي شيء عند تعذّرها.
type PingType = 'app_open' | 'page_view' | 'heartbeat';

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
    }).catch(() => {});
  } catch {
    // تجاهل أي بيئة لا تدعم storage/fetch
  }
}
