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

interface Suggestion { id: number; name: string; score: number; company?: string | null }
interface Entry {
  raw: string;
  key: string;
  status: 'linked' | 'exact' | 'ask';
  rep: { id: number; name: string } | null;
  /** اسم الزميل الذي حسم هذا الاسم — null إن كان القرار قرارك أنت */
  by?: string | null;
  suggestions: Suggestion[];
}
/** اسم لم يُطابَق مندوبيك — suggestions من حسابات شركتك خارج فريقك (اقتراح لا حسم) */
interface Unrelated { raw: string; key: string; suggestions?: Suggestion[] }
/** outOfTeam = حساب في شركتك لكنه غير معيَّن تحتك (مثل حساب جديد لم يُعيَّن بعد) */
interface RepOpt { id: number; name: string; company?: string | null; outOfTeam?: boolean }

const repLabel = (r: { name: string; company?: string | null }) => r.company ? `${r.name} — ${r.company}` : r.name;

/** قائمة اختيار مندوب: مندوبوك أولاً ثم بقية حسابات شركتك. */
function RepSelect({ reps, value, onChange, withNone, placeholder }: {
  reps: RepOpt[]; value: string; onChange: (v: string) => void; withNone?: boolean; placeholder: string;
}) {
  const mine = reps.filter(r => !r.outOfTeam);
  const others = reps.filter(r => r.outOfTeam);
  return (
    <select value={value} onChange={ev => onChange(ev.target.value)}
      style={{ flex: 1, minWidth: 160, padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12.5, fontFamily: 'inherit' }}>
      <option value="">{placeholder}</option>
      {withNone && <option value="none">🚫 ليس أحد المندوبين — تجاهله</option>}
      {mine.length > 0 && (
        <optgroup label="مندوبوك">
          {mine.map(r => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="حسابات أخرى في شركتك (خارج فريقك)">
          {others.map(r => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
        </optgroup>
      )}
    </select>
  );
}

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
  const [pending, setPending]     = useState<Entry[]>([]);
  const [resolved, setResolved]   = useState<Entry[]>([]);
  const [unrelated, setUnrelated] = useState<Unrelated[]>([]);
  const [reps, setReps]           = useState<RepOpt[]>([]);
  // اختيار المستخدم لكل اسم (أسئلة + غير مطابَقة + محسوم قيد التعديل — المفاتيح
  // لا تتكرّر بين القوائم): معرّف المندوب، أو 'none' = ليس أحد مندوبينا
  const [choice, setChoice]   = useState<Record<string, string>>({});
  // أسماء محسومة فُتح تعديلها
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    setLoading(true); setError('');
    fetch(`${API}/api/scientific-reps/rep-names/check?fileIds=${fileIds.join(',')}`, { headers: authH })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'تعذّر فحص الأسماء');
        setPending(j.data?.pending ?? []);
        setResolved(j.data?.resolved ?? []);
        setUnrelated(j.data?.unrelated ?? []);
        setReps(j.data?.reps ?? []);
        setChoice({});
        setEditing({});
      })
      .catch(e => setError(e instanceof Error ? e.message : 'خطأ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fileIds.join(',')]);
  useEffect(load, [load]);

  const answered = Object.values(choice).filter(Boolean).length;
  const setPick = (key: string, v: string) => setChoice(p => ({ ...p, [key]: v }));
  // الأسماء التي تشبه حساباً في شركتك أولاً — هي غالباً حسابات جديدة لم تُعيَّن تحتك
  const unrelatedSorted = [...unrelated].sort((a, b) => (b.suggestions?.length ? 1 : 0) - (a.suggestions?.length ? 1 : 0));
  const hinted = unrelated.filter(u => u.suggestions?.length).length;

  const save = async () => {
    const links = [...pending, ...unrelated, ...resolved]
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
          الاسم المسجَّل في التطبيق. المطابقة تتم مع <b>مندوبيك أنت فقط</b> — وأي
          اسم لا يخصّهم يُتجاهل بلا سؤال. أكّد لكل اسم أدناه: هل هو نفس المندوب
          المقترح؟ ما تؤكّده يُحفظ فلا نسألك عنه ثانيةً، وتُحتسب مبيعاته له مباشرةً.
          <br />القرار <b>مشترك مع زملائك في المكتب</b>: ما يؤكّده أحدكم لا يُسأل عنه أحد بعده.
          <br />الأسماء التي لم تُطابَق يمكنك <b>نسبها يدوياً</b> لأي حساب في شركتك (حتى الحسابات الجديدة)،
          وأي اسم محسوم تستطيع تعديله بزر ✎.
        </p>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ جاري فحص الأسماء…</div>
        ) : (
          <>
            {pending.length === 0 ? (
              <div style={{ padding: '18px 14px', textAlign: 'center', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, color: '#166534', fontSize: 13, fontWeight: 600 }}>
                ✅ لا أسئلة معلّقة — كل الأسماء القريبة من مندوبيك محسومة.
                {hinted > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', fontWeight: 700 }}>
                    لكن {hinted} اسماً غير مطابَق يشبه حسابات في شركتك — راجعها أدناه.
                  </div>
                )}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>
                    {pending.length} اسم يحتاج تأكيداً · تمّ {pending.filter(e => choice[e.key]).length}
                  </span>
                  <button style={bulkBtn} onClick={() => setChoice(p => ({ ...p, ...Object.fromEntries(
                    pending.map(e => [e.key, String(e.suggestions[0].id)])) }))}>
                    ✅ الكل: المقترح الأول
                  </button>
                  <button style={bulkBtn} onClick={() => setChoice(p => ({ ...p, ...Object.fromEntries(pending.map(e => [e.key, 'none'])) }))}>
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
                          <RepSelect reps={reps} placeholder="— اختر —"
                            value={e.suggestions.some(s => String(s.id) === choice[e.key]) ? '' : (choice[e.key] === 'none' ? '' : (choice[e.key] ?? ''))}
                            onChange={v => setPick(e.key, v)} />
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

            {unrelated.length > 0 && (
              <details style={{ marginTop: 12 }} open={hinted > 0}>
                <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#64748b' }}>
                  🚫 {unrelated.length} اسم لم يُطابَق مندوبيك — لم يُسأل عنها · انسبها يدوياً لأي حساب
                  {hinted > 0 && <span style={{ color: '#b45309' }}> ({hinted} يشبه حساباً في شركتك)</span>}
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, maxHeight: 280, overflowY: 'auto' }}>
                  {unrelatedSorted.map(u => {
                    const picked = choice[u.key] ?? '';
                    return (
                      <div key={u.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 10px', background: picked ? '#eef2ff' : '#f8fafc', border: `1px solid ${picked ? '#6366f1' : '#e2e8f0'}`, borderRadius: 8 }}>
                        <span style={{ fontWeight: 700, color: '#0f172a', minWidth: 130 }}>{u.raw}</span>
                        {(u.suggestions ?? []).map(s => (
                          <button key={s.id} onClick={() => setPick(u.key, picked === String(s.id) ? '' : String(s.id))}
                            title="نسبه لهذا الحساب"
                            style={{ ...chipBtn, ...(picked === String(s.id) ? chipOn : null) }}>
                            {picked === String(s.id) ? '✓' : '؟'} {repLabel(s)}
                          </button>
                        ))}
                        <RepSelect reps={reps} value={picked} onChange={v => setPick(u.key, v)} placeholder="— اتركه بلا نسبة —" />
                      </div>
                    );
                  })}
                </div>
              </details>
            )}

            {resolved.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569' }}>
                  الأسماء المحسومة ({resolved.length})
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
                  {resolved.map(e => (
                    <div key={e.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 10px', background: choice[e.key] ? '#eef2ff' : '#f8fafc', border: `1px solid ${choice[e.key] ? '#6366f1' : '#e2e8f0'}`, borderRadius: 8 }}>
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{e.raw}</span>
                      <span style={{ color: '#cbd5e1' }}>←</span>
                      <span style={{ color: e.rep ? '#166534' : '#94a3b8' }}>
                        {e.rep ? e.rep.name : 'مُتجاهَل (ليس أحد المندوبين)'}
                      </span>
                      <span style={{ marginInlineStart: 'auto', fontSize: 10.5, color: '#94a3b8' }}>
                        {e.status === 'exact' ? 'تطابق تام' : e.by ? `أكّده ${e.by}` : 'مؤكَّد سابقاً'}
                      </span>
                      {/* تطابق الاسم الكامل حرفياً يُنسب لصاحبه دائماً (resolveSciRepSales)، فربطه بغيره
                          يجعله منسوباً للاثنين — التعديل للأسماء المحسومة بقرار فقط */}
                      {e.status === 'linked' && (
                        <button onClick={() => {
                          setEditing(p => ({ ...p, [e.key]: !p[e.key] }));
                          setChoice(p => { const n = { ...p }; delete n[e.key]; return n; });
                        }} title="تعديل: نسب الاسم لمندوب آخر"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontSize: 12.5, fontWeight: 800, padding: 0 }}>✎</button>
                      )}
                      {e.status === 'linked' && (
                        <button onClick={() => unlink(e.key)} title="إلغاء الربط وإعادة السؤال (يشمل قرار الزميل — القرار مشترك)"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 12, fontWeight: 800, padding: 0 }}>✕</button>
                      )}
                      {editing[e.key] && (
                        <div style={{ flexBasis: '100%', display: 'flex' }}>
                          <RepSelect reps={reps} withNone value={choice[e.key] ?? ''} onChange={v => setPick(e.key, v)} placeholder="— اختر المندوب الصحيح —" />
                        </div>
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
          {(pending.length > 0 || answered > 0) && (
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
const chipBtn: React.CSSProperties = { border: '1px dashed #f59e0b', background: '#fffbeb', color: '#92400e', borderRadius: 14, padding: '2px 9px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const chipOn: React.CSSProperties = { borderStyle: 'solid', borderColor: '#6366f1', background: '#e0e7ff', color: '#3730a3' };
const errBox: React.CSSProperties = { marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12.5 };
const cancelBtn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' };
const okBtn: React.CSSProperties = { border: 'none', background: '#4f46e5', color: '#fff', borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
