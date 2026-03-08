import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export interface SuperAdminUser {
  id: number;
  username: string;
  displayName?: string;
  isMaster: boolean;
}

interface SuperAdminContextType {
  admin: SuperAdminUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const SuperAdminContext = createContext<SuperAdminContextType>(null!);

export function SuperAdminProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<SuperAdminUser | null>(() => {
    try { return JSON.parse(localStorage.getItem('sa_user') || 'null'); }
    catch { return null; }
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('sa_token'));

  useEffect(() => {
    const storedToken = localStorage.getItem('sa_token');
    if (!storedToken) return;
    fetch('/api/super-admin/me', {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          localStorage.setItem('sa_user', JSON.stringify(data.data));
          setAdmin(data.data);
        } else {
          localStorage.removeItem('sa_token');
          localStorage.removeItem('sa_user');
          setToken(null);
          setAdmin(null);
        }
      })
      .catch(() => {});
  }, []);

  const login = async (username: string, password: string) => {
    const res = await fetch('/api/super-admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تسجيل الدخول');
    localStorage.setItem('sa_token', data.token);
    localStorage.setItem('sa_user', JSON.stringify(data.admin));
    setToken(data.token);
    setAdmin(data.admin);
  };

  const logout = () => {
    localStorage.removeItem('sa_token');
    localStorage.removeItem('sa_user');
    setToken(null);
    setAdmin(null);
  };

  return (
    <SuperAdminContext.Provider value={{ admin, token, login, logout }}>
      {children}
    </SuperAdminContext.Provider>
  );
}

export const useSuperAdmin = () => useContext(SuperAdminContext);
