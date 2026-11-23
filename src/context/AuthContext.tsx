import { createContext, useContext, useState, useRef, ReactNode, useEffect } from 'react';
import { ALL_FEATURE_KEYS, isFeatureEnabled } from '../config/featureConfig';
import { getAuthToken, getAuthUserRaw, setActiveSession, updateActiveUser, clearActiveSession } from '../lib/authStorage';

export interface AuthUser {
  id: number;
  username: string;
  role: string; // 'admin' | 'manager' | 'user' | 'company_manager' | 'supervisor' | 'scientific_rep' | ...
  linkedRepId?: number | null;
  displayName?: string | null;
  officeId?: number | null;
  permissions?: string | null;
  /** 'pharmacy' = مسوّق (فارمسي لاين): company_manager هنا = «مدير المسوقين» */
  repKind?: string | null;
}

/** المسوّق بأي مستوى (مسوّق/قائد/مدير): يزور الصيدليات فقط — لا شيء يخص الأطباء يظهر له (طلب 2026-11-04). */
export const isMarketerUser = (u?: AuthUser | null): boolean => u?.repKind === 'pharmacy';
/** صفحات كلها أطباء ولا جزء صيدليات فيها، فتُخفى عن المسوقين بالكامل: البلان الشهري، عينات FMS، ملف أقدر. */
export const MARKETER_HIDDEN_PAGES = new Set<string>(['monthly-plans', 'fms', 'aqdar-export']);

export interface SavedAccount {
  token: string;
  user: AuthUser;
}

const SAVED_ACCOUNTS_KEY = 'saved_accounts';
const warnedMissingFeatureKeys = new Set<string>();

function loadSavedAccounts(): SavedAccount[] {
  try { return JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || '[]'); }
  catch { return []; }
}

function persistSavedAccounts(accounts: SavedAccount[]) {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
}

// كل تعديل على قائمة «تبديل الحساب» يُطبَّق على أحدث نسخة في localStorage، لا على نسخة
// هذا التبويب في الذاكرة: كل تبويب مفتوح كان يكتب قائمته القديمة كاملة فيُرجع لقطات
// بصلاحيات قديمة (صفحة فُعّلت لاحقاً تعود مخفية عند التبديل لذلك الحساب).
function mutateSavedAccounts(fn: (list: SavedAccount[]) => SavedAccount[]): SavedAccount[] {
  const next = fn(loadSavedAccounts());
  try { persistSavedAccounts(next); } catch { /* storage full/blocked — keep in memory */ }
  return next;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAdmin: boolean;
  isManager: boolean;
  isManagerOrAdmin: boolean;
  hasFeature: (key: string) => boolean;
  /** true بعد أن يؤكد /api/auth/me (أو الدخول) صلاحيات الحساب الحالي في هذا التبويب */
  userVerified: boolean;
  requiresGps: () => boolean;
  getDoctorFilterPlanMode: () => string;
  getDefaultReportView: () => 'sales' | 'returns' | 'net';
  savedAccounts: SavedAccount[];
  switchAccount: (account: SavedAccount) => void;
  removeSavedAccount: (userId: number) => void;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const _isImp = () => sessionStorage.getItem('_is_impersonating') === '1';

  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      if (_isImp()) return JSON.parse(sessionStorage.getItem('_imp_user') || 'null');
      return JSON.parse(getAuthUserRaw() || 'null');
    }
    catch { return null; }
  });
  const [token, setToken] = useState<string | null>(
    () => _isImp() ? sessionStorage.getItem('_imp_token') : getAuthToken()
  );
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => {
    // Seed from localStorage: ensure the currently-logged-in account is always in the list
    const existing = loadSavedAccounts();
    const storedToken = getAuthToken();
    const storedUser: AuthUser | null = (() => { try { return JSON.parse(getAuthUserRaw() || 'null'); } catch { return null; } })();
    if (!_isImp() && storedToken && storedUser && !existing.find(a => a.user.id === storedUser.id)) {
      const seeded = [{ token: storedToken, user: storedUser }, ...existing];
      persistSavedAccounts(seeded);
      return seeded;
    }
    return existing;
  });

  const [verifiedUserId, setVerifiedUserId] = useState<number | null>(null);
  const refreshNowRef = useRef<() => void>(() => {});

  // Verify token and refresh user data (esp. permissions) from the server — on
  // load, whenever the tab regains focus/visibility, and periodically. This makes
  // an admin's change to a user's features take effect on the user's side within
  // ~a minute (or instantly when they return to the tab) without a manual reload
  // or re-login. Throttled so rapid focus events don't spam the server.
  useEffect(() => {
    const imp = _isImp();
    let lastRun = 0;
    const currentToken = () => imp ? sessionStorage.getItem('_imp_token') : getAuthToken();
    const refresh = (force?: unknown) => {
      const storedToken = currentToken();
      if (!storedToken) return;
      const now = Date.now();
      if (force !== true && now - lastRun < 15000) return; // at most once / 15s
      lastRun = now;
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${storedToken}` } })
        .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))
        .then(({ status, data }) => {
          // تبدّل الحساب في هذا التبويب أثناء الطلب: الردّ لحساب سابق — لا نخلطه بالحالي.
          if (currentToken() !== storedToken) return;
          // جلسة «الدخول كحساب»: حدّث نسختها فقط — لا تلمس جلسة الأدمن المحفوظة في localStorage
          if (imp) {
            if (data.user) {
              sessionStorage.setItem('_imp_user', JSON.stringify(data.user));
              setUser(data.user);
              setVerifiedUserId(data.user.id);
            }
            return;
          }
          if (data.user) {
            updateActiveUser(storedToken, JSON.stringify(data.user));
            setUser(data.user);
            setVerifiedUserId(data.user.id);
            setSavedAccounts(mutateSavedAccounts(list =>
              list.map(a => a.user.id === data.user.id ? { ...a, user: data.user } : a)));
          } else if (status === 401) {
            // التوكن منتهي فعلاً أو الحساب معطّل — فقط عندها نُخرج. أي خطأ آخر
            // (500 من قاعدة البيانات، إعادة تشغيل السيرفر...) كان يُخرج الجميع.
            clearActiveSession();
            setToken(null);
            setUser(null);
          }
        })
        .catch(() => {/* server offline — keep stored data */});
    };
    refreshNowRef.current = () => refresh(true);
    refresh(); // on load
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    const interval = setInterval(refresh, 60000); // periodic (throttle keeps it cheap)
    // قائمة «تبديل الحساب» حدّثها تبويب آخر — خذ نسخته بدل الاحتفاظ بلقطات قديمة
    const onStorage = (e: StorageEvent) => { if (e.key === SAVED_ACCOUNTS_KEY) setSavedAccounts(loadSavedAccounts()); };
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', onStorage);
      clearInterval(interval);
      refreshNowRef.current = () => {};
    };
  }, []);

  const login = async (username: string, password: string) => {
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تسجيل الدخول');
    setActiveSession(data.token, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    setVerifiedUserId(data.user.id); // ردّ الدخول طازج من قاعدة البيانات
    // Save this account in the saved accounts list
    setSavedAccounts(mutateSavedAccounts(list =>
      [{ token: data.token, user: data.user }, ...list.filter(a => a.user.id !== data.user.id)]));
  };

  const logout = () => {
    if (_isImp()) {
      sessionStorage.clear();
      window.close();
      return;
    }
    clearActiveSession();
    setToken(null);
    setUser(null);
  };

  const switchAccount = (account: SavedAccount) => {
    // اللقطة المحفوظة قد تكون أقدم من آخر تعديل للمميزات — أحدث نسخة في localStorage
    // أولاً، ثم /me فوراً (لا ننتظر الدقيقة الدورية) لتطابق صفحاته قاعدة البيانات.
    const latest = loadSavedAccounts().find(a => a.user.id === account.user.id && a.token === account.token) ?? account;
    setActiveSession(latest.token, JSON.stringify(latest.user));
    setToken(latest.token);
    setUser(latest.user);
    // Move this account to the front
    setSavedAccounts(mutateSavedAccounts(list => [latest, ...list.filter(a => a.user.id !== latest.user.id)]));
    refreshNowRef.current();
  };

  const removeSavedAccount = (userId: number) => {
    setSavedAccounts(mutateSavedAccounts(list => list.filter(a => a.user.id !== userId)));
  };

  // الصلاحيات تأكدت من السيرفر لهذا الحساب في هذا التبويب (لا لقطة مخزّنة قديمة)
  const userVerified = user != null && verifiedUserId === user.id;

  const isAdmin          = user?.role === 'admin';
  const isManager        = user?.role === 'manager';
  const isManagerOrAdmin = user?.role === 'admin' || user?.role === 'manager' ||
    user?.role === 'company_manager' || user?.role === 'supervisor' ||
    user?.role === 'product_manager' || user?.role === 'team_leader' ||
    user?.role === 'office_manager'  || user?.role === 'commercial_supervisor' ||
    user?.role === 'commercial_team_leader' || user?.role === 'office_employee';

  const hasFeature = (key: string): boolean => {
    if (import.meta.env.DEV && !ALL_FEATURE_KEYS.has(key) && !warnedMissingFeatureKeys.has(key)) {
      warnedMissingFeatureKeys.add(key);
      console.warn(`[hasFeature] المفتاح "${key}" غير مسجَّل في src/config/featureConfig.ts — أضِفه إلى PAGE_CHILDREN أو STANDALONE_FEATURES وإلا فلن يظهر تبديله في شاشة المميزات عند الأدمن.`);
    }
    try {
      return isFeatureEnabled(JSON.parse(user?.permissions || '{}'), key);
    } catch { return true; }
  };

  const requiresGps = (): boolean => {
    try {
      const p = JSON.parse(user?.permissions || '{}');
      return p.requireGps !== false; // ON by default unless explicitly disabled
    } catch { return true; }
  };

  const getDoctorFilterPlanMode = (): string => {
    try {
      const p = JSON.parse(user?.permissions || '{}');
      return p.doctorFilterPlanMode || 'plan_and_all';
    } catch { return 'plan_and_all'; }
  };

  // الخانة (مبيعات/ارجاعات/صافي) التي تُفتح تلقائياً عند دخول صفحة التقارير
  // والتحليل — يضبطها السوبر أدمن لكل مستخدم من تعديلات المستخدمين. «net» هو
  // السلوك الافتراضي القديم قبل إضافة هذا الإعداد.
  const getDefaultReportView = (): 'sales' | 'returns' | 'net' => {
    try {
      const p = JSON.parse(user?.permissions || '{}');
      return (['sales', 'returns', 'net'].includes(p.defaultReportView) ? p.defaultReportView : 'net');
    } catch { return 'net'; }
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAdmin, isManager, isManagerOrAdmin, hasFeature, userVerified, requiresGps, getDoctorFilterPlanMode, getDefaultReportView, savedAccounts, switchAccount, removeSavedAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
