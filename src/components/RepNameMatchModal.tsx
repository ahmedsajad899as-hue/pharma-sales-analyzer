import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

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
/** staff = تيم ليدر/مدير/موظف مكتب (ليس مندوباً علمياً) — id سالب إن لم يكن له سجل مندوب بعد */
/** section/group/depth: موضعه في هيكلية المكتب (server/lib/repNamePickerTree.js) — الترتيب يأتي من الخادم */
interface RepOpt { id: number; name: string; company?: string | null; roleLabel?: string | null; outOfTeam?: boolean; staff?: boolean; section?: string; group?: string; depth?: number }

const repLabel = (r: { name: string; company?: string | null }) => r.company ? `${r.name} — ${r.company}` : r.name;

/** تطبيع للبحث: الهمزات والتاء المربوطة والألف المقصورة والتشكيل */
const norm = (t: string) => t.toLowerCase()
  .replace(/[\u064B-\u0652\u0640]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/\s+/g, ' ').trim();

const SECTION_ICON: Record<string, string> = {
  'الشركات': '🏢', 'المحافظات': '🗺️', 'مسوقو بغداد': '💊', 'مسوقو المحافظات': '🧭', 'إدارة المكتب': '🏛️',
};

/**
 * قائمة اختيار حساب قابلة للبحث بهيكلية المكتب: الشركات (المدير ← تيم ليدر الكرخ ومندوبوه ←
 * تيم ليدر الرصافة ومندوبوه)، المحافظات (القائد ← مندوبوه)، مسوقو بغداد، مسوقو المحافظات،
 * إدارة المكتب. الترتيب من الخادم كما هو. الحساب المربوط مسبقاً باسم آخر يظهر باهتاً مع الاسم المربوط
 * (يبقى قابلاً للاختيار: قد يُكتب المندوب نفسه بأكثر من صيغة في الملف).
 */
function RepSelect({ reps, value, onChange, withNone, placeholder, linkedBy }: {
  reps: RepOpt[]; value: string; onChange: (v: string) => void; withNone?: boolean; placeholder: string;
  linkedBy?: Map<number, string[]>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({ top: 0, left: 0, width: 0, up: false });
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = value && value !== 'none' ? reps.find(r => String(r.id) === value) : null;
  const shown = value === 'none' ? '🚫 ليس أحد المندوبين — تجاهله' : selected ? repLabel(selected) : placeholder;

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (!boxRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    // القائمة بموضع ثابت — تمرير الحاوية يُبعدها عن الزر فنغلقها
    const onScroll = (ev: Event) => { if (!boxRef.current?.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom;
      const up = below < 420 && r.top > below;
      const width = Math.min(Math.max(r.width, 560), window.innerWidth - 16);
      setPos({ top: up ? r.top - 4 : r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width, up });
    }
    setQ('');
    setOpen(true);
  };
  const pick = (v: string) => { onChange(v); setOpen(false); };

  /** أقسام ← مجموعات ← حسابات، بترتيب الخادم. البحث يُبقي رأس القسم/المجموعة لما تبقّى. */
  const groups = useMemo(() => {
    const terms = norm(q).split(' ').filter(Boolean);
    const hit = (r: RepOpt) => {
      if (!terms.length) return true;
      const hay = norm(`${r.name} ${r.company ?? ''} ${r.roleLabel ?? ''} ${r.group ?? ''} ${r.section ?? ''}`);
      return terms.every(t => hay.includes(t));
    };
    const sections: { section: string; groups: { group: string; list: RepOpt[] }[] }[] = [];
    for (const r of reps) {
      if (!hit(r)) continue;
      const sec = r.section || 'حسابات أخرى';
      const grp = r.group || r.company || 'أخرى';
      let S = sections[sections.length - 1];
      if (!S || S.section !== sec) { S = sections.find(x => x.section === sec) ?? (sections.push({ section: sec, groups: [] }), sections[sections.length - 1]); }
      let G = S.groups.find(x => x.group === grp);
      if (!G) { G = { group: grp, list: [] }; S.groups.push(G); }
      G.list.push(r);
    }
    return sections;
  }, [reps, q]);
  const total = groups.reduce((n, S) => n + S.groups.reduce((m, G) => m + G.list.length, 0), 0);

  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle}
        style={{ flex: 1, minWidth: 160, padding: '5px 8px', borderRadius: 6, border: `1px solid ${open ? '#6366f1' : '#cbd5e1'}`, fontSize: 12.5, fontFamily: 'inherit', background: '#fff', textAlign: 'start', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: selected || value === 'none' ? '#0f172a' : '#64748b' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}</span>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>▾</span>
      </button>
      {open && (
        <div ref={boxRef} dir="rtl"
          style={{ position: 'fixed', zIndex: 10100, left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            background: '#fff', border: '1px solid #c7d2fe', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.25)', display: 'flex', flexDirection: 'column', maxHeight: 'min(72vh, 620px)' }}>
          <div style={{ padding: 6, borderBottom: '1px solid #e2e8f0' }}>
            <input autoFocus value={q} onChange={ev => setQ(ev.target.value)} placeholder="🔍 ابحث بالاسم أو الشركة أو الدور…"
              style={{ width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 7, border: '1px solid #cbd5e1', fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }} />
          </div>
          <div style={{ overflowY: 'auto', paddingBottom: 4 }}>
            <div style={{ ...rowSt, color: '#64748b' }} onClick={() => pick('')}>{placeholder}</div>
            {withNone && <div style={{ ...rowSt, color: '#b45309' }} onClick={() => pick('none')}>🚫 ليس أحد المندوبين — تجاهله</div>}
            {total === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: '#94a3b8' }}>لا نتائج</div>}
            {groups.map(S => (
              <div key={S.section}>
                <div style={{ position: 'sticky', top: 0, zIndex: 2, background: '#312e81', color: '#fff', padding: '6px 12px', fontSize: 12.5, fontWeight: 800 }}>
                  {SECTION_ICON[S.section] ?? '👥'} {S.section}
                </div>
                {S.groups.map(G => (
                  <div key={G.group}>
                    <div style={{ background: '#eef2ff', padding: '4px 14px', fontSize: 11.5, fontWeight: 800, color: '#3730a3', borderBottom: '1px solid #e0e7ff' }}>
                      {G.group} <span style={{ fontWeight: 600, color: '#818cf8' }}>({G.list.length})</span>
                    </div>
                    {G.list.map(r => {
                      const linked = linkedBy?.get(r.id);
                      const isSel = String(r.id) === value;
                      const head = (r.depth ?? 0) === 0 && !!r.staff;
                      return (
                        <div key={r.id} onClick={() => pick(String(r.id))}
                          title={linked ? `مربوط مسبقاً بـ: ${linked.join('، ')}` : undefined}
                          style={{ ...rowSt, paddingInlineStart: 14 + (r.depth ?? 0) * 22, background: isSel ? '#e0e7ff' : undefined, opacity: linked && !isSel ? 0.45 : 1 }}>
                          {(r.depth ?? 0) > 0 && <span style={{ color: '#cbd5e1' }}>└</span>}
                          <span style={{ fontWeight: isSel || head ? 800 : 600, color: '#0f172a' }}>{r.name}</span>
                          {r.roleLabel && r.roleLabel !== 'مندوب' && <span style={tagSt(head ? '#fef3c7' : '#f1f5f9', head ? '#92400e' : '#475569')}>{r.roleLabel}</span>}
                          {!r.outOfTeam && <span style={tagSt('#dcfce7', '#166534')}>مندوبك</span>}
                          {linked && <span style={{ marginInlineStart: 'auto', fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>🔗 {linked.join('، ')}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const rowSt: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer', color: '#334155' };
const tagSt = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 8, padding: '0 6px', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' });

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
  // المطابقة يحسمها موظف المكتب وحده (server/lib/repNameResolver.js) — غيره يرى المحسوم فقط.
  const [readOnly, setReadOnly] = useState(false);

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
        setReadOnly(!!j.data?.readOnly);
        setChoice({});
        setEditing({});
      })
      .catch(e => setError(e instanceof Error ? e.message : 'خطأ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fileIds.join(',')]);
  useEffect(load, [load]);

  const answered = Object.values(choice).filter(Boolean).length;
  /** الحساب ← أسماء الملف المربوطة به (المحسوم + اختيارات الجلسة غير المحفوظة) — للتغويش في القائمة.
   *  exceptKey يستثني الصف نفسه كي لا يبدو اختياره الحالي «مربوطاً». */
  const linkedFor = useCallback((exceptKey: string) => {
    const m = new Map<number, string[]>();
    const add = (id: number, raw: string) => { if (!m.has(id)) m.set(id, []); m.get(id)!.push(raw); };
    for (const e of resolved) if (e.rep && e.key !== exceptKey && !choice[e.key]) add(e.rep.id, e.raw);
    for (const e of [...pending, ...unrelated, ...resolved]) {
      const v = choice[e.key];
      if (e.key !== exceptKey && v && v !== 'none') add(Number(v), e.raw);
    }
    return m;
  }, [resolved, pending, unrelated, choice]);
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
        {readOnly ? (
          <div style={{ margin: '0 0 14px', padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, color: '#1e40af', fontSize: 12.5, fontWeight: 700 }}>
            🔒 مطابقة الأسماء يحسمها موظف المكتب (من يرفع الملفات) — هنا للعرض فقط.
          </div>
        ) : (
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b', lineHeight: 1.7 }}>
          اسم المندوب في ملف ميركاتو هو المندوب العلمي نفسه، وقد يُكتب مختصراً عن
          الاسم المسجَّل في التطبيق. المطابقة تتم مع <b>مندوبيك أنت فقط</b> — وأي
          اسم لا يخصّهم يُتجاهل بلا سؤال. أكّد لكل اسم أدناه: هل هو نفس المندوب
          المقترح؟ ما تؤكّده يُحفظ فلا نسألك عنه ثانيةً، وتُحتسب مبيعاته له مباشرةً.
          <br />القرار <b>مشترك مع زملائك في المكتب</b>: ما يؤكّده أحدكم لا يُسأل عنه أحد بعده.
          <br />الأسماء التي لم تُطابَق يمكنك <b>نسبها يدوياً</b> لأي حساب في شركتك (حتى الحسابات الجديدة)،
          وأي اسم محسوم تستطيع تعديله بزر ✎.
        </p>
        )}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ جاري فحص الأسماء…</div>
        ) : (
          <>
            {readOnly ? null : pending.length === 0 ? (
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
                          <RepSelect reps={reps} placeholder="— اختر —" linkedBy={linkedFor(e.key)}
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
                        <RepSelect reps={reps} linkedBy={linkedFor(u.key)} value={picked} onChange={v => setPick(u.key, v)} placeholder="— اتركه بلا نسبة —" />
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
                      {e.status === 'linked' && !readOnly && (
                        <button onClick={() => {
                          setEditing(p => ({ ...p, [e.key]: !p[e.key] }));
                          setChoice(p => { const n = { ...p }; delete n[e.key]; return n; });
                        }} title="تعديل: نسب الاسم لمندوب آخر"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontSize: 12.5, fontWeight: 800, padding: 0 }}>✎</button>
                      )}
                      {e.status === 'linked' && !readOnly && (
                        <button onClick={() => unlink(e.key)} title="إلغاء الربط وإعادة السؤال (يشمل قرار الزميل — القرار مشترك)"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 12, fontWeight: 800, padding: 0 }}>✕</button>
                      )}
                      {editing[e.key] && (
                        <div style={{ flexBasis: '100%', display: 'flex' }}>
                          <RepSelect reps={reps} withNone linkedBy={linkedFor(e.key)} value={choice[e.key] ?? ''} onChange={v => setPick(e.key, v)} placeholder="— اختر المندوب الصحيح —" />
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
const panel: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, width: '100%', maxWidth: 820, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
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
