import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import SuperAdminApp from './SuperAdminApp.tsx'
import './index.css'

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
