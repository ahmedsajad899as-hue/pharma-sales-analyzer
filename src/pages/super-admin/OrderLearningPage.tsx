import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { ErrBox, Spinner, UI } from './OfficesPage';
import { Bar, Section, Seg, Card, Empty, Notice, Stat, statGrid, ghost, inputSm, TAG, th, td } from './saKit';

interface Lesson {
  id: number; scope: string; scopeName: string; field: string; fromName: string; toName: string;
  hits: number; lastUsedAt: string | null; createdByName: string | null; updatedAt: string;
}
interface ItemRule { id: number; fromName: string; toName: string; company: string | null; by: string | null; createdAt: string }
interface Side { pharmacy: string; area: string; warehouse: string; lines: { item: string; qty: number; bonus: number; added?: boolean }[] }
interface Case {
  id: number; scopeName: string; source: string | null; chatTitle: string | null; senderName: string | null;
  sourceText: string | null; reasons: string; parsed: Side[] | null; saved: Side[] | null; status: string;
  createdByName: string | null; createdAt: string;
}

const FIELD: Record<string, string> = {
  area: 'المنطقة', pharmacy: 'الصيدلية', pharmacyArea: 'منطقة الصيدلية', warehouse: 'المذخر', rep: 'المندوب',
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
type Tab = 'lessons' | 'items' | 'cases';

// «ذاكرة التصحيحات» — ما تعلّمه التطبيق من تصحيحات مراجعي طلبيات البوت (يُطبَّق من أول
// تصحيح بشارة 🧠)، ورسائل غيّر فيها المراجعون الأسطر/الكميات لإصلاح المحلّل نفسه.
export default function OrderLearningPage() {
  const { token } = useSuperAdmin();
  const H = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const [data, setData] = useState<{ lessons: Lesson[]; itemRules: ItemRule[]; cases: Case[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('lessons');
  const [q, setQ] = useState('');
  const [caseStatus, setCaseStatus] = useState<'open' | 'fixed'>('open');

  const load = useCallback(() => {
    fetch('/api/sa/order-learning', { headers: H() }).then(r => r.json())
      .then(d => (d.success ? setData(d.data) : setError(d.error || 'تعذّر التحميل')))
      .catch(() => setError('تعذّر الاتصال بالسيرفر'));
  }, [H]);
  useEffect(() => { load(); }, [load]);

  const call = async (url: string, init: RequestInit, ok: string) => {
    setError(''); setNotice('');
    const res = await fetch(url, { headers: H(), ...init }).catch(() => null);
    const d = await res?.json().catch(() => ({}));
    if (!res?.ok || d?.success === false) { setError(d?.error || 'فشلت العملية'); return; }
    setNotice(ok);
    load();
  };

  const needle = q.trim().toLowerCase();
  const hit = (...xs: (string | null | undefined)[]) => !needle || xs.some(x => String(x ?? '').toLowerCase().includes(needle));
  const lessons = useMemo(() => (data?.lessons ?? []).filter(l => hit(l.fromName, l.toName, l.scopeName, FIELD[l.field])), [data, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemRules = useMemo(() => (data?.itemRules ?? []).filter(r => hit(r.fromName, r.toName, r.company)), [data, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const cases = useMemo(() => (data?.cases ?? []).filter(c => c.status === caseStatus && hit(c.sourceText, c.chatTitle, c.senderName, c.reasons)), [data, needle, caseStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && !error) return <Spinner />;
  const openCases = (data?.cases ?? []).filter(c => c.status === 'open');

  const copyOpen = async () => {
    const text = JSON.stringify(openCases.map(c => ({ id: c.id, reasons: c.reasons, sourceText: c.sourceText, parsed: c.parsed, saved: c.saved })), null, 1);
    try { await navigator.clipboard.writeText(text); setNotice(`نُسخت ${openCases.length} رسالة — الصقها لـ Claude ليصلح المحلّل`); }
    catch { setError('تعذّر النسخ'); }
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      {error && <ErrBox msg={error} />}
      {notice && <Notice>{notice}</Notice>}

      <div style={statGrid}>
        <Stat label="دروس الخانات" value={data?.lessons.length ?? 0} sub="منطقة · صيدلية · مذخر · مندوب" />
        <Stat label="أصناف متعلَّمة" value={data?.itemRules.length ?? 0} sub="اسم مكتوب ← صنف الكتالوج" />
        <Stat label="مرات التطبيق" value={(data?.lessons ?? []).reduce((s, l) => s + l.hits, 0)} sub="فتح طلبية طُبّق فيها درس" />
        <Stat label="رسائل بانتظار إصلاح المحلّل" value={openCases.length} tone={openCases.length ? '#b45309' : undefined} />
      </div>

      <Bar end={<input style={{ ...inputSm, width: 220 }} placeholder="بحث…" value={q} onChange={e => setQ(e.target.value)} />}>
        <Seg<Tab> value={tab} onChange={setTab} options={[
          ['lessons', 'دروس الخانات'], ['items', 'الأصناف'], ['cases', 'رسائل صحّحها المراجعون'],
        ]} />
      </Bar>

      {tab === 'lessons' && (
        <Section title="ما تعلّمه التطبيق من التصحيحات" count={lessons.length} flush>
          {!lessons.length ? <Empty text="لا دروس بعد — تُضاف تلقائياً عند تصحيح خانة في مراجعة طلبيات البوت" /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>الخانة</th><th style={th}>قُرئت</th><th style={th}>صارت</th><th style={th}>المكتب</th>
                  <th style={th}>صحّحها</th><th style={th}>طُبّق</th><th style={th}>آخر تعديل</th><th style={th} />
                </tr></thead>
                <tbody>
                  {lessons.map(l => (
                    <tr key={l.id}>
                      <td style={td}><span style={TAG.info}>{FIELD[l.field] ?? l.field}</span></td>
                      <td style={{ ...td, color: UI.muted }}>{l.fromName}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{l.toName}</td>
                      <td style={td}>{l.scopeName}</td>
                      <td style={td}>{l.createdByName ?? '—'}</td>
                      <td style={td}>{l.hits}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: UI.muted }}>{fmt(l.updatedAt)}</td>
                      <td style={td}>
                        <button style={ghost('#b91c1c')} onClick={() => confirm(`حذف الدرس «${l.fromName} ← ${l.toName}»؟`)
                          && call(`/api/sa/order-learning/lessons/${l.id}`, { method: 'DELETE' }, 'حُذف الدرس')}>حذف</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === 'items' && (
        <Section title="أسماء أصناف تعلّمها التطبيق" count={itemRules.length} flush>
          {!itemRules.length ? <Empty text="لا أصناف متعلَّمة بعد" /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>كُتب</th><th style={th}>الصنف</th><th style={th}>الشركة</th><th style={th}>بواسطة</th><th style={th}>التاريخ</th><th style={th} />
                </tr></thead>
                <tbody>
                  {itemRules.map(r => (
                    <tr key={r.id}>
                      <td style={{ ...td, color: UI.muted }}>{r.fromName}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{r.toName}</td>
                      <td style={td}>{r.company ?? '—'}</td>
                      <td style={td}>{r.by ?? '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: UI.muted }}>{fmt(r.createdAt)}</td>
                      <td style={td}>
                        <button style={ghost('#b91c1c')} onClick={() => confirm(`حذف «${r.fromName} ← ${r.toName}»؟`)
                          && call(`/api/sa/order-learning/item-rules/${r.id}`, { method: 'DELETE' }, 'حُذفت القاعدة')}>حذف</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === 'cases' && (
        <Section title="رسائل غيّر فيها المراجعون الأسطر أو الكميات" count={cases.length}
          end={<>
            <Seg value={caseStatus} onChange={setCaseStatus} options={[['open', 'بانتظار الإصلاح'], ['fixed', 'أُصلحت']]} />
            {caseStatus === 'open' && openCases.length > 0 && <button style={ghost()} onClick={copyOpen} title="نسخ الرسائل المفتوحة بصيغة JSON لإصلاح المحلّل دفعة واحدة">نسخ الكل</button>}
          </>}>
          {!cases.length ? <Empty text={caseStatus === 'open' ? 'لا رسائل بانتظار الإصلاح' : 'لا شيء هنا'} /> : cases.map(c => (
            <Card key={c.id}
              title={<>{c.reasons.split(' · ').map(r => <span key={r} style={{ ...TAG.warn, marginInlineEnd: 4 }}>{r}</span>)}</>}
              meta={`${[c.senderName, c.chatTitle, c.scopeName].filter(Boolean).join(' · ')} — ${fmt(c.createdAt)}${c.createdByName ? ` — صحّحها ${c.createdByName}` : ''}`}
              actions={<>
                <button style={ghost('#15803d')} onClick={() => call(`/api/sa/order-learning/cases/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: c.status === 'open' ? 'fixed' : 'open' }) }, 'تم')}>
                  {c.status === 'open' ? 'أُصلحت' : 'إرجاع'}
                </button>
                <button style={ghost('#b91c1c')} onClick={() => confirm('حذف هذه الرسالة؟') && call(`/api/sa/order-learning/cases/${c.id}`, { method: 'DELETE' }, 'حُذفت')}>حذف</button>
              </>}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8 }}>
                <Pane title="الرسالة">
                  <pre dir="auto" style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }}>{c.sourceText || '—'}</pre>
                </Pane>
                <Pane title="قرأها المحلّل"><SideView sides={c.parsed} /></Pane>
                <Pane title="حفظها المراجِع"><SideView sides={c.saved} /></Pane>
              </div>
            </Card>
          ))}
        </Section>
      )}
    </div>
  );
}

function Pane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: UI.bg, borderRadius: 8, padding: '6px 9px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: UI.muted, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function SideView({ sides }: { sides: Side[] | null }) {
  if (!sides?.length) return <span style={{ fontSize: 12, color: UI.faint }}>—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
      {sides.map((s, i) => (
        <div key={i}>
          <div style={{ fontWeight: 700 }}>{s.pharmacy || '(بلا صيدلية)'} <span style={{ color: UI.muted, fontWeight: 400 }}>{[s.area, s.warehouse].filter(Boolean).join(' · ')}</span></div>
          {s.lines.map((l, j) => (
            <div key={j} style={{ color: l.added ? '#15803d' : UI.text }}>
              {l.added ? '+ ' : ''}{l.item || '—'} — {l.qty}{l.bonus ? ` + ${l.bonus}` : ''}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
