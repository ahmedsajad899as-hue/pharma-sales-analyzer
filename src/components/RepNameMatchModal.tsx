import { useState, useEffect, useCallback } from 'react';

/**
 * مطابقة أسماء المندوبين في ملفات ميركاتو مع سجلات المندوبين العلميين.
 *
 * في ملف ميركاتو «اسم المندوب» هو المندوب العلمي نفسه، لكنه يُكتب أحياناً
 * مختصراً («محمد باقر») عن الاسم المسجَّل («محمد باقر مرتضى») — والمطابقة
 * الحرفية وحدها تُسقط مبيعاته كلها. هذه النافذة تعرض كل اسم غير قاطع ليؤكّده
 * المستخدم مرة واحدة، ثم يُحفظ القرار فلا يُسأل عنه ثانيةً.
 */

const API = import.meta.env.VITE_API_URL || '';

interface Suggestion { id: number; name: string; score: number }
interface Entry {
  raw: string;
  key: string;
  status: 'linked' | 'exact' | 'ask' | 'none';
  rep: { id: number; name: string } | null;
  suggestions: Suggestion[];
}
interface RepOpt { id: number; name: string }

export default function RepNameMatchModal({ token, fileIds, onClose, onSaved }: {
  token: string;
  fileIds: number[];
  onClose: () => void;
  onSaved?: (msg: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [reps, setReps]       = useState<RepOpt[]>([]);
  // اختيار المستخدم لكل اسم: معرّف المندوب، أو 'none' = ليس أحد مندوبينا
  const [choice, setChoice]   = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true); setError('');
    fetch(`${API}/api/scientific-reps/rep-names/check?fileIds=${fileIds.join(',')}`, { headers: authH })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر فحص الأسماء');
        setEntries(j.data?.entries ?? []);
        setReps(j.data?.reps ?? []);
        setChoice({});
      })
      .catch(e => setError(e instanceof Error ? e.message : 'خطأ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fileIds.join(',')]);
  useEffect(load, [load]);

  const pending  = entries.filter(e => e.status === 'ask' || e.status === 'none');
  const resolved = entries.filter(e => e.status === 'linked' || e.status === 'exact');
  const answered = pending.filter(e => choice[e.key]).length;

  const save = async () => {
    const links = pending
      .filter(e => choice[e.key])
      .map(e => ({
        fromName: e.raw,
        scientificRepId: choice[e.key] === 'none' ? null : Number(choice[e.key]),
      }));
    if (links.length === 0) { onClose(); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch(`${API}/api/scientific-reps/rep-names`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ links }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'فشل الحفظ');
      const linked = links.filter(l => l.scientificRepId !== null).length;
      onSaved?.(`تم حفظ ${links.length} قرار مطابقة${linked > 0 ? ` — ${linked} اسم مرتبط بمندوب` : ''}.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل الحفظ');
      setSaving(false);
    }
  };

  /** إلغاء ربط محفوظ — يعود الاسم لقائمة الأسئلة. */
  const unlink = async (key: string) => {
    try {
      await fetch(`${API}/api/scientific-reps/rep-names/${encodeURIComponent(key)}`, { method: 'DELETE', headers: authH });
      load();
    } catch { /* تجاهل */ }
  };

  return (
    <div style={overlay}>
      <div style={panel} dir="rtl">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#1e293b' }}>
            🔗 مطابقة أسماء المندوبين (ميركاتو)
          </h3>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
          اسم المندوب في ملف ميركاتو هو المندوب العلمي نفسه، وقد يُكتب مختصراً عن
          الاسم المسجَّل في التطبيق. أكّد لكل اسم: هل هو نفس المندوب المقترح؟ ما
          تؤكّده يُحفظ فلا نسألك عنه مرة أخرى، وتُحتسب مبيعاته له مباشرةً.
        </p>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ جاري فحص الأسماء…</div>
        ) : (
          <>
            {pending.length === 0 ? (
              <div style={{ padding: '18px 14px', textAlign: 'center', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, color: '#166534', fontSize: 13, fontWeight: 600 }}>
                ✅ كل الأسماء مطابَقة — لا شيء يحتاج تأكيداً.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>
                    {pending.length} اسم يحتاج تأكيداً · تمّ {answered}
                  </span>
                  <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(
                    pending.map(e => [e.key, e.suggestions[0] ? String(e.suggestions[0].id) : 'none'])))}>
                    ✅ الكل: المقترح الأول
                  </button>
                  <button style={bulkBtn} onClick={() => setChoice(Object.fromEntries(pending.map(e => [e.key, 'none'])))}>
                    🚫 الكل: ليس أحد مندوبينا
                  </button>
                </div>

                <div style={{ maxHeight: '48vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pending.map(e => (
                    <div key={e.key} style={card}>
                      <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 3 }}>الاسم في الملف:</div>
                      <div style={{ fontSize: 14.5, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>{e.raw}</div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {e.suggestions.map(s => (
                          <label key={s.id} style={{ ...opt, ...(choice[e.key] === String(s.id) ? optOn : null) }}>
                            <input type="radio" name={e.key} checked={choice[e.key] === String(s.id)}
                              onChange={() => setChoice(p => ({ ...p, [e.key]: String(s.id) }))} />
                            <span>نعم، هو نفسه: <b>{s.name}</b></span>
                            <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#94a3b8' }}>
                              تطابق {Math.round(s.score * 100)}%
                            </span>
                          </label>
                        ))}

                        {/* اختيار يدوي من كل المندوبين — للأسماء بلا مرشّح أو حين يكون المقترح خاطئاً */}
                        <label style={{ ...opt, ...(choice[e.key] && choice[e.key] !== 'none' && !e.suggestions.some(s => String(s.id) === choice[e.key]) ? optOn : null) }}>
                          <input type="radio" name={e.key}
                            checked={!!choice[e.key] && choice[e.key] !== 'none' && !e.suggestions.some(s => String(s.id) === choice[e.key])}
                            onChange={() => { /* يُحدَّد باختيار مندوب من القائمة */ }} />
                          <span>مندوب آخر:</span>
                          <select
                            value={e.suggestions.some(s => String(s.id) === choice[e.key]) ? '' : (choice[e.key] === 'none' ? '' : (choice[e.key] ?? ''))}
                            onChange={ev => setChoice(p => ({ ...p, [e.key]: ev.target.value }))}
                            style={{ flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12.5, fontFamily: 'inherit' }}>
                            <option value="">— اختر —</option>
                            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                        </label>

                        <label style={{ ...opt, ...(choice[e.key] === 'none' ? optNo : null) }}>
                          <input type="radio" name={e.key} checked={choice[e.key] === 'none'}
                            onChange={() => setChoice(p => ({ ...p, [e.key]: 'none' }))} />
                          <span>لا، ليس أحد مندوبينا — تجاهله ولا تسألني ثانيةً</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {resolved.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569' }}>
                  الأسماء المحسومة ({resolved.length})
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
                  {resolved.map(e => (
                    <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{e.raw}</span>
                      <span style={{ color: '#cbd5e1' }}>←</span>
                      <span style={{ color: e.rep ? '#166534' : '#94a3b8' }}>
                        {e.rep ? e.rep.name : 'مُتجاهَل (ليس أحد المندوبين)'}
                      </span>
                      <span style={{ marginInlineStart: 'auto', fontSize: 10.5, color: '#94a3b8' }}>
                        {e.status === 'exact' ? 'تطابق تام' : 'مؤكَّد سابقاً'}
                      </span>
                      {e.status === 'linked' && (
                        <button onClick={() => unlink(e.key)} title="إلغاء الربط وإعادة السؤال"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 12, fontWeight: 800, padding: 0 }}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        {error && <div style={errBox}>⚠️ {error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={cancelBtn}>إغلاق</button>
          {pending.length > 0 && (
            <button onClick={save} disabled={saving || answered === 0}
              style={{ ...okBtn, opacity: saving || answered === 0 ? 0.5 : 1 }}>
              {saving ? '⏳ جاري الحفظ…' : `حفظ المطابقة (${answered})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── styles ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10050, padding: 16 };
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 640, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 19, color: '#94a3b8', cursor: 'pointer', lineHeight: 1 };
const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, background: '#f8fafc' };
const opt: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' };
const optOn: React.CSSProperties = { borderColor: '#6366f1', background: '#eef2ff', fontWeight: 700 };
const optNo: React.CSSProperties = { borderColor: '#f59e0b', background: '#fffbeb', fontWeight: 700 };
const bulkBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const errBox: React.CSSProperties = { marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12.5 };
const cancelBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const okBtn: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
