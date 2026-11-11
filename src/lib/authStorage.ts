// جلسة الدخول لكل تبويب على حدة.
//
// كانت الجلسة مفتاحاً واحداً في localStorage (auth_token/auth_user) تتشاركه كل
// التبويبات، فالدخول بحساب ثانٍ في أي تبويب يستبدل الحساب الأول في كل التبويبات
// المفتوحة فيبدو كأنه «سجّل خروج». الآن: كل تبويب يحمل جلسته في sessionStorage،
// وlocalStorage يبقى فقط «الحساب الافتراضي» الذي يبدأ به تبويب جديد.

const TOKEN = 'auth_token';
const USER  = 'auth_user';

function ss(): Storage | null { try { return window.sessionStorage; } catch { return null; } }
function ls(): Storage | null { try { return window.localStorage; } catch { return null; } }

/** يُستدعى مرة عند فتح التبويب: إن لم تكن له جلسة خاصة يأخذ الافتراضية. */
export function initTabSession() {
  const s = ss(), l = ls();
  if (!s || !l) return;
  if (!s.getItem(TOKEN)) {
    const t = l.getItem(TOKEN), u = l.getItem(USER);
    if (t) { s.setItem(TOKEN, t); if (u) s.setItem(USER, u); }
  }
}

export function getAuthToken(): string | null {
  return ss()?.getItem(TOKEN) ?? ls()?.getItem(TOKEN) ?? null;
}

export function getAuthUserRaw(): string | null {
  return ss()?.getItem(USER) ?? ls()?.getItem(USER) ?? null;
}

/** دخول/تبديل حساب: هذا التبويب + الافتراضي للتبويبات الجديدة. لا يمسّ التبويبات المفتوحة. */
export function setActiveSession(token: string, userJson: string) {
  ss()?.setItem(TOKEN, token); ss()?.setItem(USER, userJson);
  ls()?.setItem(TOKEN, token); ls()?.setItem(USER, userJson);
}

/** تحديث بيانات المستخدم (الصلاحيات) لجلسة هذا التبويب، والافتراضي فقط إن كان نفس الحساب. */
export function updateActiveUser(token: string, userJson: string) {
  ss()?.setItem(USER, userJson);
  if (ls()?.getItem(TOKEN) === token) ls()?.setItem(USER, userJson);
}

/** خروج هذا التبويب. الافتراضي يُمسح فقط إن كان نفس الحساب (لا نُخرج حساباً آخر). */
export function clearActiveSession() {
  const t = ss()?.getItem(TOKEN);
  ss()?.removeItem(TOKEN); ss()?.removeItem(USER);
  if (!t || ls()?.getItem(TOKEN) === t) { ls()?.removeItem(TOKEN); ls()?.removeItem(USER); }
}
