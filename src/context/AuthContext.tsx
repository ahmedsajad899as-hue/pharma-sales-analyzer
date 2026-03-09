import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'manager' | 'user';
  linkedRepId?: number | null;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAdmin: boolean;
  isManager: boolean;
  isManagerOrAdmin: boolean;
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

  const isAdmin          = user?.role === 'admin';
  const isManager        = user?.role === 'manager';
  const isManagerOrAdmin = user?.role === 'admin' || user?.role === 'manager';

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAdmin, isManager, isManagerOrAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
