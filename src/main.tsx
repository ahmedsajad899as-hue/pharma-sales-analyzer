import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// لوحة السوبر-أدمن تُحمَّل عند الحاجة فقط. الاستيراد الثابت كان يسحب معه 9 صفحات
// سوبر-أدمن + مكتبة xlsx إلى حزمة الدخول (index-*.js)، فيصير كل مستخدم عادي
// ينزّل ويحلّل ~1.5MB لا يستعمل منها شيئاً قبل أن تظهر الواجهة.
const SuperAdminApp = lazy(() => import('./SuperAdminApp.tsx'))

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

// ── Register Service Worker for PWA installability ──────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* ignore */});
  });
}

const isSuperAdmin = window.location.pathname.startsWith('/super-admin')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isSuperAdmin
      ? <Suspense fallback={null}><SuperAdminApp /></Suspense>
      : <App />}
  </React.StrictMode>,
)
