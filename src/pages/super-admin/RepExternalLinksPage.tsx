import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Spinner, UI } from './OfficesPage';
import { Bar, Section, Seg, Notice, Empty, ghost, solid, tag, TAG, inputSm, th, td } from './saKit';

// «ربط دوفايد وميركاتو» — لكل مندوب: هل هو مربوط باسم في دوفايد (زياراته) وباسم في
// ميركاتو (مبيعاته)؟ مع الربط اليدوي وفكّه. الخادم: /api/sa/rep-external-links
// (server/lib/externalRepNames.js). الربط يُحفظ في نفس جدول نافذة «مطابقة أسماء
// المندوبين» فيسري على استيراد الزيارات ونسبة مبيعات ميركاتو معاً.

type Src = 'dofied' | 'mercato';
interface LinkName { name: string; key: string; via: 'exact' | 'link'; linkId?: number; rows?: number }
interface Row {
  userId: number; repId: number; name: string; repName: string | null; role: string; isMarketer: boolean;
  company: string | null; office: string | null;
  dofied: { linked: boolean; names: LinkName[]; visits: number; lastVisit: string | null };
  mercato: { linked: boolean; names: LinkName[] };
  other: { key: string; name: string; linkId: number }[];
}
interface PoolName { name: string; key: string; rows: number | null; lastSeenAt: string | null; linkedTo: string[] }
interface Data {
  rows: Row[]; dofiedNames: PoolName[]; mercatoNames: PoolName[];
  sources: { dofied: { names: number; lastSeenAt: string | null; evidenceReps: number }; mercato: { names: number } };
}

const SRC: Record<Src, { label: string; color: string; bg: string }> = {
  dofied: { label: 'دوفايد', color: '#0f766e', bg: '#f0fdfa' },
  mercato: { label: 'ميركاتو', color: '#6d28d9', bg: '#f5f3ff' },
};
const ROLE: Record<string, string> = { scientific_rep: 'مندوب', team_leader: 'تيم ليدر' };
type Filter = 'all' | 'no-dofied' | 'no-mercato';

const norm = (s: string) => String(s || '').trim().replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').toLowerCase();
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ar-IQ', { month: 'short', day: 'numeric' }) : '');

export default function RepExternalLinksPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [office, setOffice] = useState('');
  const [adding, setAdding] = useState<{ repId: number; src: Src } | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    return fetch('/api/sa/rep-external-links', { headers: H() }).then(r => r.json())
      .then(j => { if (j.success) { setData(j.data); setError(''); } else setError(j.error || 'فشل التحميل'); })
      .catch(() => setError('فشل التحميل'));
  }, [H]);
  useEffect(() => { load(); }, [load]);

  const send = async (id: string, url: string, init: RequestInit, okText?: string) => {
    setBusy(id); setNotice(null);
    try {
      const j = await (await fetch(url, { ...init, headers: H() })).json();
      if (!j.success) { setNotice({ tone: 'bad', text: j.error || 'فشلت العملية' }); return false; }
      if (okText || j.message) setNotice({ tone: 'ok', text: j.message || okText! });
      await load();
      return true;
    } catch { setNotice({ tone: 'bad', text: 'تعذّر الاتصال بالخادم' }); return false; }
    finally { setBusy(''); }
  };
  const addLink = async (repId: number, name: string) => {
    if (!name.trim()) return;
    if (await send(`add-${repId}`, '/api/sa/rep-external-links/link', { method: 'POST', body: JSON.stringify({ repId, name: name.trim() }) }, `رُبط «${name.trim()}»`)) {
      setAdding(null); setDraft('');
    }
  };
  const removeLink = (repId: number, key: string, name: string) => {
    if (!confirm(`فكّ ربط «${name}» عن هذا المندوب؟`)) return;
    send(`rm-${repId}-${key}`, '/api/sa/rep-external-links/link', { method: 'DELETE', body: JSON.stringify({ repId, key }) }, `فُكّ ربط «${name}»`);
  };

  const offices = useMemo(() => [...new Set((data?.rows ?? []).map(r => r.office).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'ar')), [data]);
  const rows = useMemo(() => {
    const nq = norm(q);
    return (data?.rows ?? []).filter(r => {
      if (office && r.office !== office) return false;
      if (filter === 'no-dofied' && r.dofied.linked) return false;
      if (filter === 'no-mercato' && r.mercato.linked) return false;
      if (!nq) return true;
      const hay = norm([r.name, r.repName, r.company, ...r.dofied.names.map(n => n.name), ...r.mercato.names.map(n => n.name)].join(' '));
      return nq.split(' ').every(t => hay.includes(t));
    }).sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ar') || a.name.localeCompare(b.name, 'ar'));
  }, [data, q, filter, office]);

  if (!data) return error ? <ErrBox msg={error} /> : <Spinner />;
  const total = data.rows.length;
  const dCount = data.rows.filter(r => r.dofied.linked).length;
  const mCount = data.rows.filter(r => r.mercato.linked).length;
  const orphan = (src: Src) => (src === 'dofied' ? data.dofiedNames : data.mercatoNames).filter(n => n.linkedTo.length === 0);
  const dofiedEmpty = data.sources.dofied.names === 0;

  const pool = (src: Src) => (src === 'dofied' ? data.dofiedNames : data.mercatoNames);

  const cell = (r: Row, src: Src) => {
    const s = r[src];
    const isAdding = adding?.repId === r.repId && adding.src === src;
    const listId = `ext-${src}-names`;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {s.names.map(n => (
          <span key={n.key} style={{ ...tag(n.via === 'exact' ? '#15803d' : SRC[src].color, n.via === 'exact' ? '#f0fdf4' : SRC[src].bg), display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title={n.via === 'exact' ? 'تطابق تام مع اسم المندوب — يُربط تلقائياً' : 'ربط محفوظ (يدوي أو من نافذة مطابقة الأسماء)'}>
            {n.via === 'exact' ? '✓' : '🔗'} {n.name}{n.rows != null && <span style={{ opacity: .6, fontWeight: 500 }}>· {n.rows}</span>}
            {n.via === 'link' && (
              <button type="button" disabled={!!busy} onClick={() => removeLink(r.repId, n.key, n.name)} title="فكّ الربط"
                style={{ border: 'none', background: 'none', color: '#b91c1c', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
            )}
          </span>
        ))}
        {src === 'dofied' && s.names.length === 0 && r.dofied.visits > 0 && (
          <span style={TAG.info} title="الاسم غير مسجَّل بعد في سجلّ أسماء دوفايد، لكن له زيارات محفوظة من سحب دوفايد">عبر السحب · {r.dofied.visits} زيارة{r.dofied.lastVisit ? ` · آخرها ${fmtDay(r.dofied.lastVisit)}` : ''}</span>
        )}
        {!s.linked && <span style={TAG.bad}>غير مربوط</span>}
        {isAdding ? (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input autoFocus list={listId} value={draft} onChange={e => setDraft(e.target.value)} placeholder={`اسم في ${SRC[src].label}…`}
              onKeyDown={e => { if (e.key === 'Enter') addLink(r.repId, draft); if (e.key === 'Escape') { setAdding(null); setDraft(''); } }}
              style={{ ...inputSm, width: 190, padding: '3px 8px', fontSize: 12 }} />
            <button type="button" style={solid(SRC[src].color)} disabled={!draft.trim() || !!busy} onClick={() => addLink(r.repId, draft)}>{busy === `add-${r.repId}` ? '…' : 'ربط'}</button>
            <button type="button" style={ghost()} onClick={() => { setAdding(null); setDraft(''); }}>إلغاء</button>
          </span>
        ) : (
          <button type="button" onClick={() => { setAdding({ repId: r.repId, src }); setDraft(''); }} title={`ربط اسم من ${SRC[src].label} بهذا المندوب`}
            style={{ ...ghost(SRC[src].color), padding: '1px 8px', fontSize: 11.5 }}>+ ربط</button>
        )}
      </div>
    );
  };

  return (
    <div style={{ direction: 'rtl', maxWidth: 1250 }}>
      {/* قوائم الأسماء لحقل الإضافة — غير المربوطة أولاً */}
      {(['dofied', 'mercato'] as Src[]).map(src => (
        <datalist key={src} id={`ext-${src}-names`}>
          {[...pool(src)].sort((a, b) => a.linkedTo.length - b.linkedTo.length).map(n => (
            <option key={n.key} value={n.name}>{n.linkedTo.length ? `مربوط بـ ${n.linkedTo.join('، ')}` : 'غير مربوط بأحد'}</option>
          ))}
        </datalist>
      ))}

      <Bar end={<>
        <button style={ghost('#0f766e')} disabled={!!busy} onClick={() => send('refresh', '/api/sa/rep-external-links/refresh-dofied', { method: 'POST', body: JSON.stringify({ days: 7 }) })}
          title="دخول واحد لدوفايد وتصدير آخر 7 أيام لقراءة أسماء المندوبين فقط — لا يُنشئ ملف مراجعة ولا يغيّر السحب اليومي">
          {busy === 'refresh' ? '…' : 'تحديث أسماء دوفايد'}
        </button>
        <button style={ghost()} disabled={!!busy} onClick={() => { setBusy('reload'); load().finally(() => setBusy('')); }}>{busy === 'reload' ? '…' : 'تحديث'}</button>
      </>}>
        <span style={tag(SRC.dofied.color, SRC.dofied.bg)}>دوفايد: {dCount} / {total} مربوط</span>
        <span style={tag(SRC.mercato.color, SRC.mercato.bg)}>ميركاتو: {mCount} / {total} مربوط</span>
        <span style={TAG.mute}>أسماء دوفايد المعروفة: {data.sources.dofied.names}{data.sources.dofied.lastSeenAt ? ` · آخر قراءة ${fmtDay(data.sources.dofied.lastSeenAt)}` : ''}</span>
        <span style={TAG.mute}>أسماء ميركاتو: {data.sources.mercato.names}</span>
      </Bar>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {dofiedEmpty && (
        <Notice tone="warn">
          سجلّ أسماء دوفايد فارغ بعد — يُملأ تلقائياً مع كل ملف دوفايد يُقرأ (السحب اليومي، زر الكولات، الرفع اليدوي). اضغط «تحديث أسماء دوفايد» لملئه الآن.
          حتى ذلك الحين يُعدّ المندوب مربوطاً بدوفايد إن كانت له زيارات محفوظة من السحب.
        </Notice>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث بالاسم أو الشركة أو اسم دوفايد/ميركاتو…" style={{ ...inputSm, width: 280 }} />
        <Seg<Filter> value={filter} onChange={setFilter} options={[
          ['all', 'الكل'],
          ['no-dofied', 'غير مربوط بدوفايد'],
          ['no-mercato', 'غير مربوط بميركاتو'],
        ] as const} />
        {offices.length > 1 && (
          <select value={office} onChange={e => setOffice(e.target.value)} style={inputSm}>
            <option value="">كل المكاتب</option>
            {offices.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <span style={{ fontSize: 11.5, color: UI.muted }}>{rows.length} مندوب</span>
      </div>

      <Section title="المندوبون" count={rows.length} flush>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>المندوب</th>
                <th style={{ ...th, color: SRC.dofied.color }}>دوفايد (الكولات)</th>
                <th style={{ ...th, color: SRC.mercato.color }}>ميركاتو (المبيعات)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={3} style={td}><Empty text="لا مندوبين بهذا الفلتر" /></td></tr>
              ) : rows.map(r => (
                <tr key={`${r.userId}`} style={{ verticalAlign: 'top' }}>
                  <td style={{ ...td, minWidth: 190 }}>
                    <div style={{ fontWeight: 700 }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: UI.muted, marginTop: 2 }}>
                      {[ROLE[r.role] ?? r.role, r.isMarketer ? 'مسوّق' : null, r.company, r.office].filter(Boolean).join(' · ')}
                    </div>
                    {r.repName && norm(r.repName) !== norm(r.name) && <div style={{ fontSize: 11, color: UI.faint }} title="اسم سجل المندوب الذي تُطابَق عليه الأسماء">سجلّ: {r.repName}</div>}
                    {r.other.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        {r.other.map(o => (
                          <span key={o.key} style={{ ...TAG.mute, display: 'inline-flex', gap: 4, alignItems: 'center' }} title="ربط محفوظ لاسم لا يرد حالياً في دوفايد ولا في ملفات ميركاتو">
                            🔗 {o.name}
                            <button type="button" disabled={!!busy} onClick={() => removeLink(r.repId, o.key, o.name)} style={{ border: 'none', background: 'none', color: '#b91c1c', cursor: 'pointer', padding: 0, fontSize: 12 }}>✕</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, minWidth: 260 }}>{cell(r, 'dofied')}</td>
                  <td style={{ ...td, minWidth: 260 }}>{cell(r, 'mercato')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 12, marginTop: 12 }}>
        {(['dofied', 'mercato'] as Src[]).map(src => (
          <OrphanNames key={src} src={src} names={orphan(src)} reps={data.rows} busy={!!busy} onLink={addLink} />
        ))}
      </div>
    </div>
  );
}

/** أسماء وردت في المصدر ولا يقابلها أي مندوب — ربط سريع من هنا. */
function OrphanNames({ src, names, reps, busy, onLink }: { src: Src; names: PoolName[]; reps: Row[]; busy: boolean; onLink: (repId: number, name: string) => void }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const repOptions = useMemo(() => {
    const seen = new Set<number>();
    return reps.filter(r => (seen.has(r.repId) ? false : (seen.add(r.repId), true)))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [reps]);
  return (
    <Section title={`أسماء ${SRC[src].label} بلا مندوب`} count={names.length} accent={SRC[src].color}>
      {names.length === 0 ? <Empty text="كل الأسماء مربوطة" /> : names.map(n => (
        <div key={n.key} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: UI.ink, minWidth: 150 }}>{n.name}</span>
          {n.rows != null && <span style={{ fontSize: 11, color: UI.faint }}>{n.rows} صف</span>}
          {n.lastSeenAt && <span style={{ fontSize: 11, color: UI.faint }}>آخر ظهور {fmtDay(n.lastSeenAt)}</span>}
          <span style={{ marginInlineStart: 'auto', display: 'inline-flex', gap: 4 }}>
            <select value={pick[n.key] ?? ''} onChange={e => setPick(p => ({ ...p, [n.key]: e.target.value }))} style={{ ...inputSm, padding: '3px 6px', fontSize: 12, maxWidth: 200 }}>
              <option value="">اختر المندوب…</option>
              {repOptions.map(r => <option key={r.repId} value={r.repId}>{r.name}{r.company ? ` — ${r.company}` : ''}</option>)}
            </select>
            <button type="button" style={solid(SRC[src].color)} disabled={busy || !pick[n.key]} onClick={() => onLink(Number(pick[n.key]), n.name)}>ربط</button>
          </span>
        </div>
      ))}
    </Section>
  );
}
