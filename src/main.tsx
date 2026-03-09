import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import SuperAdminApp from './SuperAdminApp.tsx'
import './index.css'

// ── Impersonation bootstrap: if opened via ?imp=1, read one-time token from localStorage ──
const _impParams = new URLSearchParams(window.location.search);
if (_impParams.get('imp') === '1') {
  try {
    const raw = localStorage.getItem('_imp');
    if (raw) {
      const { token, user } = JSON.parse(raw);
      localStorage.removeItem('_imp');
      sessionStorage.setItem('_imp_token', token);
      sessionStorage.setItem('_imp_user', JSON.stringify(user));
      sessionStorage.setItem('_is_impersonating', '1');
    }
  } catch {}
  window.history.replaceState({}, '', '/');
}

// ── Global fetch interceptor: attach JWT to every /api request ──────────
// Only injects auth_token if no Authorization header is already provided
const _origFetch = window.fetch.bind(window);
window.fetch = function(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = localStorage.getItem('auth_token');
  const url   = typeof input === 'string' ? input : (input instanceof Request ? input.url : input.toString());
  const existingAuth = (init.headers as Record<string,string>)?.['Authorization'];
  if (token && !existingAuth && (url.includes('localhost:8080') || url.startsWith('/api'))) {
    init = {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    };
  }
  return _origFetch(input, init);
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname.startsWith('/super-admin') ? <SuperAdminApp /> : <App />}
  </React.StrictMode>,
)
