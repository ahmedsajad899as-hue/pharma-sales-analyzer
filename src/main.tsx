import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// ── Global fetch interceptor: attach JWT to every localhost:8080 request ──
const _origFetch = window.fetch.bind(window);
window.fetch = function(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = localStorage.getItem('auth_token');
  const url   = typeof input === 'string' ? input : (input instanceof Request ? input.url : input.toString());
  if (token && (url.includes('localhost:8080') || url.startsWith('/api'))) {
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
    <App />
  </React.StrictMode>,
)
