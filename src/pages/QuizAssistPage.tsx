import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { shrinkImage } from '../lib/shrinkImage';

const API = import.meta.env.VITE_API_URL || '';

interface QuizItem {
  question: string;
  options: string[];
  answerIndex: number;
  answer: string;
  confidence: number;
  explanation: string;
}

const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];

export default function QuizAssistPage() {
  const { token } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState<QuizItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: File[]) => {
    const imgs = list.filter(f => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    setFiles(prev => [...prev, ...imgs].slice(0, 5));
  }, []);

  // لصق لقطة شاشة مباشرة (Ctrl+V) على الصفحة
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.files ?? []);
      if (imgs.length) addFiles(imgs);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  useEffect(() => {
    const urls = files.map(f => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach(u => URL.revokeObjectURL(u));
  }, [files]);

  async function analyze() {
    setError(''); setItems([]); setBusy(true);
    try {
      const fd = new FormData();
      for (const f of await Promise.all(files.map(shrinkImage))) fd.append('images', f);
      if (text.trim()) fd.append('text', text.trim());
      const res = await fetch(`${API}/api/quiz-assist/answer`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || j.error || 'فشل التحليل');
      setItems(j.data?.items ?? []);
    } catch (e: any) {
      setError(e?.message || 'فشل التحليل');
    } finally {
      setBusy(false);
    }
  }

  const canRun = !busy && (files.length > 0 || text.trim().length > 0);

  return (
    <div style={{ padding: 16, maxWidth: 760, margin: '0 auto' }} className="notranslate" translate="no">
      <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 12 }}>
        نسخة تجريبية: ارفع لقطة شاشة للسؤال وخياراته (أو الصقها بـ Ctrl+V، أو اكتب النص) وسيقترح الذكاء الاصطناعي الجواب مع تعليل.
        الاقتراح قد يخطئ — راجعه قبل الاعتماد عليه.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" onClick={() => inputRef.current?.click()} style={btn}>📷 اختر صورة / كاميرا</button>
        {files.length > 0 && <button type="button" onClick={() => setFiles([])} style={btn}>مسح الصور</button>}
        <input ref={inputRef} type="file" accept="image/*" multiple hidden
          onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      </div>

      {previews.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {previews.map((u, i) => (
            <img key={u} src={u} alt={`صورة ${i + 1}`} style={{ height: 120, borderRadius: 8, border: '1px solid #8884' }} />
          ))}
        </div>
      )}

      <textarea
        value={text} onChange={e => setText(e.target.value)} rows={4}
        placeholder="أو الصق نص السؤال وخياراته هنا…"
        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #8886', marginBottom: 10, font: 'inherit' }}
      />

      <button type="button" onClick={analyze} disabled={!canRun}
        style={{ ...btn, background: canRun ? '#2563eb' : '#8886', color: '#fff', border: 'none', padding: '10px 22px' }}>
        {busy ? 'جاري التحليل…' : '✨ اقترح الجواب'}
      </button>

      {error && <div style={{ marginTop: 12, color: '#dc2626' }}>{error}</div>}

      <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        {items.map((q, qi) => (
          <div key={qi} style={{ border: '1px solid #8884', borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{qi + 1}. {q.question}</div>
            {q.options.map((o, oi) => {
              const hit = oi === q.answerIndex;
              return (
                <div key={oi} style={{
                  padding: '6px 10px', borderRadius: 6, marginBottom: 4,
                  background: hit ? '#16a34a22' : 'transparent',
                  border: hit ? '1px solid #16a34a' : '1px solid transparent',
                  fontWeight: hit ? 600 : 400,
                }}>
                  {LETTERS[oi] ?? oi + 1}) {o} {hit && '✅'}
                </div>
              );
            })}
            {q.options.length === 0 && q.answer && <div style={{ fontWeight: 600 }}>الجواب: {q.answer}</div>}
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
              {q.explanation} <span style={{ opacity: 0.7 }}>(الثقة: {Math.round(q.confidence * 100)}%)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1px solid #8886', background: 'transparent',
  cursor: 'pointer', font: 'inherit',
};
