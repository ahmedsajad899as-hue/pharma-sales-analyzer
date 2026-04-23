import { useState, FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

export default function LoginPage() {
  const { login }        = useAuth();
  const { t, toggleLang, lang } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd,  setShowPwd]  = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError(t.login.errorEmpty);
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || t.login.errorFailed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page" dir="rtl">
      <div className="login-card">
        {/* Language toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button
            onClick={toggleLang}
            style={{
              background: 'rgba(26,86,219,0.08)', border: '1px solid rgba(26,86,219,0.18)', borderRadius: 8,
              padding: '5px 14px', fontSize: 13, fontWeight: 700, color: '#1a56db',
              cursor: 'pointer',
            }}
          >
            🌐 {lang === 'ar' ? 'English' : 'عربي'}
          </button>
        </div>

        <div className="login-logo">
          <div style={{
            width: 72, height: 72,
            background: 'linear-gradient(145deg, #0f1e35 0%, #1a3a6b 100%)',
            borderRadius: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 12px',
            boxShadow: '0 8px 24px rgba(15,30,53,0.30)',
          }}>
            <span style={{ fontSize: 38 }}>💊</span>
          </div>
          <h1 className="login-title">{t.login.title}</h1>
          <p className="login-subtitle">{t.login.subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {error && (
            <div className="alert alert--error" onClick={() => setError('')}>
              {error} ✕
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t.login.username}</label>
            <input
              className="form-input"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t.login.usernamePlaceholder}
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t.login.password}</label>
            <div style={{ position: 'relative' }}>
              <input
                className="form-input"
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t.login.passwordPlaceholder}
                autoComplete="current-password"
                style={{ paddingLeft: 44 }}
              />
              <button type="button" onClick={() => setShowPwd(v => !v)}
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#94a3b8', padding: 0 }}>
                {showPwd ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn--primary"
            style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
            disabled={loading}
          >
            {loading ? t.login.loading : t.login.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
