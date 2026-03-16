import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export interface AuthUser {
  id: number;
  username: string;
  role: string; // 'admin' | 'manager' | 'user' | 'company_manager' | 'supervisor' | 'scientific_rep' | ...
  linkedRepId?: number | null;
  displayName?: string | null;
  officeId?: number | null;
  permissions?: string | null;
}

export interface SavedAccount {
  token: string;
  user: AuthUser;
}

const SAVED_ACCOUNTS_KEY = 'saved_accounts';

function loadSavedAccounts(): SavedAccount[] {
  try { return JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || '[]'); }
  catch { return []; }
}

function persistSavedAccounts(accounts: SavedAccount[]) {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
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
  requiresGps: () => boolean;
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
      return JSON.parse(localStorage.getItem('auth_user') || 'null');
    }
    catch { return null; }
  });
  const [token, setToken] = useState<string | null>(
    () => _isImp() ? sessionStorage.getItem('_imp_token') : localStorage.getItem('auth_token')
  );
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => {
    // Seed from localStorage: ensure the currently-logged-in account is always in the list
    const existing = loadSavedAccounts();
    const storedToken = localStorage.getItem('auth_token');
    const storedUser: AuthUser | null = (() => { try { return JSON.parse(localStorage.getItem('auth_user') || 'null'); } catch { return null; } })();
    if (!_isImp() && storedToken && storedUser && !existing.find(a => a.user.id === storedUser.id)) {
      const seeded = [{ token: storedToken, user: storedUser }, ...existing];
      persistSavedAccounts(seeded);
      return seeded;
    }
    return existing;
  });

  // On load: verify token and refresh user data from server
  useEffect(() => {
    if (_isImp()) return; // skip verification for impersonation sessions
    const storedToken = localStorage.getItem('auth_token');
    if (!storedToken) return;
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          localStorage.setItem('auth_user', JSON.stringify(data.user));
          setUser(data.user);
          // Keep saved account entry in sync with latest user data
          setSavedAccounts(prev => {
            const updated = prev.map(a => a.user.id === data.user.id ? { ...a, user: data.user } : a);
            persistSavedAccounts(updated);
            return updated;
          });
        } else {
          // Token invalid — clear session
          localStorage.removeItem('auth_token');
          localStorage.removeItem('auth_user');
          setToken(null);
          setUser(null);
        }
      })
      .catch(() => {/* server offline — keep stored data */});
  }, []);

  const login = async (username: string, password: string) => {
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تسجيل الدخول');
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('auth_user',  JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    // Save this account in the saved accounts list
    setSavedAccounts(prev => {
      const filtered = prev.filter(a => a.user.id !== data.user.id);
      const updated = [{ token: data.token, user: data.user }, ...filtered];
      persistSavedAccounts(updated);
      return updated;
    });
  };

  const logout = () => {
    if (_isImp()) {
      sessionStorage.clear();
      window.close();
      return;
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    setToken(null);
    setUser(null);
  };

  const switchAccount = (account: SavedAccount) => {
    localStorage.setItem('auth_token', account.token);
    localStorage.setItem('auth_user',  JSON.stringify(account.user));
    setToken(account.token);
    setUser(account.user);
    // Move this account to the front
    setSavedAccounts(prev => {
      const filtered = prev.filter(a => a.user.id !== account.user.id);
      const updated = [account, ...filtered];
      persistSavedAccounts(updated);
      return updated;
    });
  };

  const removeSavedAccount = (userId: number) => {
    setSavedAccounts(prev => {
      const updated = prev.filter(a => a.user.id !== userId);
      persistSavedAccounts(updated);
      return updated;
    });
  };

  const isAdmin          = user?.role === 'admin';
  const isManager        = user?.role === 'manager';
  const isManagerOrAdmin = user?.role === 'admin' || user?.role === 'manager' ||
    user?.role === 'company_manager' || user?.role === 'supervisor' ||
    user?.role === 'product_manager' || user?.role === 'team_leader' ||
    user?.role === 'office_manager'  || user?.role === 'commercial_supervisor' ||
    user?.role === 'commercial_team_leader';

  const hasFeature = (key: string): boolean => {
    try {
      const p = JSON.parse(user?.permissions || '{}');
      return !(p.disabledFeatures ?? []).includes(key);
    } catch { return true; }
  };

  const requiresGps = (): boolean => {
    try {
      const p = JSON.parse(user?.permissions || '{}');
      return p.requireGps !== false; // ON by default unless explicitly disabled
    } catch { return true; }
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAdmin, isManager, isManagerOrAdmin, hasFeature, requiresGps, savedAccounts, switchAccount, removeSavedAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
