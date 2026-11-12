import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, UI } from './OfficesPage';
import InvoiceReadsPanel from './InvoiceReadsPanel';
import { Bar, Seg, Section, Stat, Empty, statGrid, twoCols, th, td, Toggle, TAG, ghost } from './saKit';

interface Summary {
  days: number;
  totals: { calls: number; ok: number; rateLimited: number; timeouts: number; promptTokens: number; outputTokens: number; tokens: number };
  today: { calls: number; tokens: number };
  daily: { day: string; calls: number; ok: number; tokens: number }[];
  byFeature: { feature: string; calls: number; ok: number; promptTokens: number; outputTokens: number; tokens: number; avgMs: number }[];
  byModel: { model: string; calls: number; failed: number; tokens: number }[];
}

// أسماء الميزات الظاهرة — أي وسم غير مذكور يُعرض كما هو.
const FEATURE_LABEL: Record<string, string> = {
  'telegram-bot-chat': 'محادثة البوت',
  'bot-order-text': 'طلبية نصية',
  'assistant-command': 'أوامر المساعد',
  'invoice-read': 'صور الفواتير',
  'invoice-read-card': 'فاتورة ببطاقة المذخر',
  'invoice-read-card-retry': 'إعادة بالأقوى (بطاقة)',
  'invoice-read-retry': 'إعادة بالأقوى',
  'invoice-orient': 'اتجاه الفاتورة',
  'invoice-customer-line': 'سطر الزبون',
  'invoice-gate': 'فحص كروب المذخر',
  'invoice-pdf': 'فاتورة PDF (نص)',
  'invoice-pdf-retry': 'إعادة PDF بالأقوى',
  'invoice-rows-fix': 'أسطر بالأقوى (تلقائي)',
  'invoice-card-gen': 'توليد بطاقة مذخر',
  'invoice-card-check': 'تحقّق بطاقة مذخر',
  'quiz-assist': 'مساعد الاختبارات',
  'item-analysis-report': 'تقرير الايتم',
  'survey-analysis': 'تحليل السيرفي',
  'visit-feedback': 'فيدباك الزيارات',
  'visit-pharmacy-match': 'مطابقة صيدليات الزيارات',
  'smart-plan-curator': 'الخطة الذكية: الأطباء',
  'smart-plan-names': 'الخطة الذكية: الأسماء',
  'plan-suggest-note': 'ملاحظة الخطة',
  'plan-voice-parse': 'إدخال الخطة نصاً',
  other: 'غير موسومة',
};

const fmt = (n: number) => (n ?? 0).toLocaleString('en-US');

// ─── نموذج الذكاء لكل ميزة (server/lib/aiModelSettings.js) ──────────────────
interface ModelSetting { feature: string; mode: string; modes: string[]; default: string }
const MODE_INFO: Record<string, [string, string]> = {
  strong: ['الأقوى', 'gemini-3.8-flash — الأدق والأغلى'],
  lite:   ['الأرخص', 'gemini-3.5-flash-lite — حوالي نصف السعر'],
  auto:   ['تلقائي', 'الأرخص أولاً، والأقوى للجزء المتعذّر فقط (سطر لا تتّسق أرقامه، أو اسم الزبون)'],
};
const MODEL_FEATURE_LABEL: Record<string, string> = {
  'invoice-read-card': 'فواتير بطاقات المذاخر',
  'invoice-read': 'فواتير باقي المذاخر',
  'invoice-pdf': 'فواتير PDF',
  'invoice-gate': 'فحص كروبات المذاخر',
  'bot-order-text': 'الطلبيات النصية',
};

function ModelSettings({ token }: { token: string | null }) {
  const [rows, setRows] = useState<ModelSetting[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  useEffect(() => {
    fetch('/api/sa/ai-usage/models', { headers: H }).then(r => r.json())
      .then(d => { if (d.success) setRows(d.data); else setErr(d.error || 'خطأ'); })
      .catch(() => setErr('تعذّر الاتصال'));
  }, []);
  const choose = async (feature: string, mode: string) => {
    setBusy(feature); setErr('');
    try {
      const d = await (await fetch('/api/sa/ai-usage/models', { method: 'PUT', headers: H, body: JSON.stringify({ feature, mode }) })).json();
      if (d.success) setRows(d.data); else setErr(d.error || 'تعذّر الحفظ');
    } catch { setErr('تعذّر الاتصال'); } finally { setBusy(''); }
  };
  return (
    <Section title="النموذج لكل ميزة">
      {err && <ErrBox msg={err} />}
      {!rows ? <Spinner /> : rows.map(r => (
        <div key={r.feature} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 150px', fontSize: 12.5, fontWeight: 600, color: UI.ink }}>{MODEL_FEATURE_LABEL[r.feature] || r.feature}</span>
          <Seg value={r.mode} disabled={busy === r.feature} onChange={m => choose(r.feature, m)}
            options={r.modes.map(m => [m, MODE_INFO[m]?.[0] || m, MODE_INFO[m]?.[1]] as const)} />
        </div>
      ))}
    </Section>
  );
}

// ─── بطاقات المذاخر (يدوية + تلقائية من صور الكروبات — server/lib/invoiceCardAuto.js) ───
interface InvoiceCard {
  id: number | null; name: string; source: string; enabled: boolean; prompt: string | null; bonusStyle?: string;
  samples: number; sampleCount?: number; checkedOk?: number | null; checkedOf?: number | null;
  useCount?: number; lastUsedAt?: string | null; note?: string | null; pending?: boolean;
}

function CardsPanel({ token }: { token: string | null }) {
  const [rows, setRows] = useState<InvoiceCard[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const load = () => fetch('/api/sa/ai-usage/cards', { headers: H }).then(r => r.json())
    .then(d => { if (d.success) setRows(d.data); else setErr(d.error || 'خطأ'); })
    .catch(() => setErr('تعذّر الاتصال'));
  useEffect(() => { load(); }, []);
  const toggle = async (c: InvoiceCard) => {
    if (c.id == null) return;
    setBusy(c.name); setErr('');
    try {
      const d = await (await fetch(`/api/sa/ai-usage/cards/${c.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: !c.enabled }) })).json();
      if (d.success) setRows(d.data); else setErr(d.error || 'تعذّر الحفظ');
    } catch { setErr('تعذّر الاتصال'); } finally { setBusy(''); }
  };
  const regen = async (c: InvoiceCard) => {
    setBusy(c.name); setErr('');
    try {
      await fetch('/api/sa/ai-usage/cards/regenerate', { method: 'POST', headers: H, body: JSON.stringify({ name: c.name }) });
      setTimeout(() => { load(); setBusy(''); }, 45_000);
    } catch { setErr('تعذّر الاتصال'); setBusy(''); }
  };
  return (
    <Section title="بطاقات المذاخر" count={rows?.length}>
      {err && <ErrBox msg={err} />}
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty text="لا بطاقات" /> : rows.map(c => (
        <div key={c.name} style={{ borderBottom: `1px solid ${UI.line}`, padding: '6px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => setOpen(o => (o === c.name ? null : c.name))} disabled={!c.prompt}
              style={{ flex: '1 1 140px', textAlign: 'start', border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: UI.ink, cursor: c.prompt ? 'pointer' : 'default' }}
              title={c.prompt ? 'عرض نص البطاقة' : ''}>{c.name}</button>
            <span style={c.source === 'auto' ? TAG.violet : TAG.mute} title={c.source === 'auto' ? 'كُتبت تلقائياً من صور كروب المذخر' : 'مكتوبة يدوياً'}>{c.source === 'auto' ? 'تلقائية' : 'يدوية'}</span>
            <span style={TAG.info} title="صور العيّنات المحفوظة (أفضل 10)">🖼️ {c.samples}/10</span>
            {c.checkedOf ? <span style={(c.checkedOk ?? 0) >= Math.ceil(c.checkedOf * 2 / 3) ? TAG.ok : TAG.warn} title="صور قُرئت بالبطاقة واتّسقت أرقامها وزبونها">✔ {c.checkedOk}/{c.checkedOf}</span> : null}
            {c.pending ? <span style={TAG.warn} title="تُكتب البطاقة عند 5 صور">بانتظار الصور</span>
              : <Toggle on={c.enabled} disabled={busy === c.name} label={c.enabled ? 'مفعّلة' : 'معطّلة'} onToggle={() => toggle(c)} title={c.note || ''} />}
            {c.source === 'auto' && c.samples >= 3 && (
              <button style={ghost()} disabled={busy === c.name} onClick={() => regen(c)} title="إعادة كتابتها من أفضل الصور الآن">{busy === c.name ? '…' : '↻'}</button>
            )}
          </div>
          {open === c.name && c.prompt && (
            <div style={{ marginTop: 6, padding: '8px 10px', background: UI.bg, borderRadius: 8, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: UI.ink }}>{c.prompt}</div>
          )}
        </div>
      ))}
    </Section>
  );
}

// صفحة استهلاك الذكاء الاصطناعي — كل نداء (ناجح أو فاشل) يُسجَّل في callAI نفسها فتشمل
// كل ميزات التطبيق لا البوت وحده. الميزة غير الموسومة تظهر «other».
export default function AiUsagePage() {
  const { token } = useSuperAdmin();
  const [days, setDays] = useState(7);
  const [view, setView] = useState<'usage' | 'images'>('usage');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    fetch(`/api/sa/ai-usage?days=${days}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setData(d.data); else setError(d.error || 'خطأ'); })
      .catch(() => setError('تعذّر الاتصال'))
      .finally(() => setLoading(false));
  }, [days]);

  const maxCalls = Math.max(1, ...(data?.daily ?? []).map(d => d.calls));
  const okRate = data?.totals?.calls ? Math.round((data.totals.ok / data.totals.calls) * 100) : 0;

  return (
    <div style={{ direction: 'rtl', maxWidth: 1100 }}>
      <Bar end={<Seg value={days} onChange={setDays} options={[[1, 'يوم'], [7, '7 أيام'], [30, '30 يوم'], [90, '90 يوم']] as const} />}>
        <Seg value={view} onChange={setView} options={[['usage', 'الاستهلاك'], ['images', 'الطلبيات المحلَّلة']] as const} />
      </Bar>

      {view === 'images' && <InvoiceReadsPanel token={token} days={days} />}

      {view === 'usage' && error && <ErrBox msg={error} />}
      {view === 'usage' && (loading ? <Spinner /> : data && (
        <>
          <div style={statGrid}>
            <Stat label="اليوم" value={fmt(data.today?.calls)} sub={`${fmt(data.today?.tokens)} توكن`} />
            <Stat label={`النداءات (${data.days} يوم)`} value={fmt(data.totals?.calls)} sub={`نجاح ${okRate}%`} />
            <Stat label="التوكنز" value={fmt(data.totals?.tokens)} sub={`إدخال ${fmt(data.totals?.promptTokens)} · إخراج ${fmt(data.totals?.outputTokens)}`} />
            <Stat label="أخطاء الحصّة" value={fmt(data.totals?.rateLimited)} sub={`مهلة ${fmt(data.totals?.timeouts)}`} tone={data.totals?.rateLimited ? '#b91c1c' : undefined} />
          </div>

          <div style={{ ...twoCols, marginBottom: 12 }}>
            <Section title="يومياً">
              {data.daily.length === 0 && <Empty text="لا نداءات" />}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.daily.map(d => (
                  <div key={d.day} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }} title={`${fmt(d.tokens)} توكن`}>
                    <span style={{ width: 40, color: UI.muted, direction: 'ltr', textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{d.day.slice(5)}</span>
                    <div style={{ flex: 1, background: UI.bg, borderRadius: 3, height: 10 }}>
                      <div style={{ width: `${(d.calls / maxCalls) * 100}%`, background: '#4f46e5', height: 10, borderRadius: 3 }} />
                    </div>
                    <span style={{ width: 52, color: UI.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(d.calls)}</span>
                  </div>
                ))}
              </div>
            </Section>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <ModelSettings token={token} />
              <CardsPanel token={token} />
              <Section title="حسب الموديل" flush>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={th}>الموديل</th><th style={th}>نداءات</th><th style={th}>فاشلة</th><th style={th}>توكنز</th></tr></thead>
                    <tbody>
                      {data.byModel.map(m => (
                        <tr key={m.model}>
                          <td style={{ ...td, direction: 'ltr', textAlign: 'start' }}>{m.model}</td>
                          <td style={td}>{fmt(m.calls)}</td>
                          <td style={{ ...td, color: m.failed ? '#b91c1c' : UI.ink }}>{fmt(m.failed)}</td>
                          <td style={td}>{fmt(m.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>
          </div>

          <Section title="حسب الميزة" count={data.byFeature.length} flush>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>الميزة</th><th style={th}>نداءات</th><th style={th}>ناجحة</th>
                  <th style={th}>إدخال</th><th style={th}>إخراج</th><th style={th}>المجموع</th><th style={th}>الزمن</th>
                </tr></thead>
                <tbody>
                  {data.byFeature.map(f => (
                    <tr key={f.feature}>
                      <td style={{ ...td, fontWeight: 600 }} title={f.feature}>{FEATURE_LABEL[f.feature] ?? f.feature}</td>
                      <td style={td}>{fmt(f.calls)}</td>
                      <td style={{ ...td, color: f.ok < f.calls ? '#b45309' : UI.ink }}>{fmt(f.ok)}</td>
                      <td style={td}>{fmt(f.promptTokens)}</td><td style={td}>{fmt(f.outputTokens)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{fmt(f.tokens)}</td><td style={td}>{(f.avgMs / 1000).toFixed(1)} ث</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      ))}
    </div>
  );
}
