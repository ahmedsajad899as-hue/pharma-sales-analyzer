import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, UI } from './OfficesPage';
import InvoiceReadsPanel from './InvoiceReadsPanel';

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
  'telegram-bot-chat': '🤖 محادثة البوت (مبيعات/زيارات)',
  'bot-order-text': '🧾 قراءة طلبية نصية',
  'assistant-command': '🗨️ أوامر المساعد الذكي',
  'invoice-read': '🧾 قراءة صور الفواتير',
  'invoice-read-card': '🗂️ قراءة فاتورة ببطاقة المذخر',
  'invoice-read-card-retry': '🔁 إعادة قراءة فاتورة بالأقوى (بطاقة)',
  'invoice-read-retry': '🔁 إعادة قراءة فاتورة بالأقوى',
  'invoice-orient': '🔄 تصحيح اتجاه الفاتورة',
  'invoice-customer-line': '🏪 قراءة سطر الزبون في الفاتورة',
  'quiz-assist': '❓ مساعد الاختبارات',
  'item-analysis-report': '💊 تقرير تحليل الايتم',
  'survey-analysis': '📋 تحليل السيرفي',
  'visit-feedback': '💬 تصنيف فيدباك الزيارات',
  'visit-pharmacy-match': '🏥 مطابقة صيدليات الزيارات',
  'smart-plan-curator': '🗓️ الخطة الذكية — اختيار الأطباء',
  'smart-plan-names': '🗓️ الخطة الذكية — مطابقة الأسماء',
  'plan-suggest-note': '🗓️ ملاحظة الاقتراح في الخطة',
  'plan-voice-parse': '🗓️ إدخال زيارات الخطة نصاً',
  other: 'ميزات أخرى (غير موسومة)',
};

const fmt = (n: number) => (n ?? 0).toLocaleString('en-US');

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: '12px 16px', minWidth: 150 }}>
      <div style={{ fontSize: 11.5, color: UI.faint, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: UI.ink, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: UI.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'start', padding: '8px 10px', fontSize: 12, color: UI.muted, borderBottom: `1px solid ${UI.line}`, fontWeight: 700 };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: UI.ink, borderBottom: '1px solid #f1f5f9' };

// ─── نموذج الذكاء لكل ميزة (server/lib/aiModelSettings.js) ──────────────────
interface ModelSetting { feature: string; mode: string; modes: string[]; default: string }
const MODE_INFO: Record<string, { label: string; hint: string; color: string }> = {
  strong: { label: '💪 الأقوى', hint: 'gemini-3.8-flash — الأدق والأغلى', color: '#4f46e5' },
  lite:   { label: '💰 الأرخص', hint: 'gemini-3.5-flash-lite — حوالي نصف السعر', color: '#0891b2' },
  auto:   { label: '🧠 تلقائي', hint: 'الأرخص أولاً، وإن لم تتطابق الكمية × السعر مع المجموع (أو مجموع الفاتورة) تُعاد القراءة بالأقوى', color: '#16a34a' },
};
const MODEL_FEATURE_LABEL: Record<string, string> = {
  'invoice-read-card': '🗂️ فواتير المذاخر التي لها بطاقة',
  'invoice-read': '🧾 فواتير باقي المذاخر',
  'bot-order-text': '💬 الطلبيات النصية (الكروبات)',
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
    setBusy(feature + mode); setErr('');
    try {
      const d = await (await fetch('/api/sa/ai-usage/models', { method: 'PUT', headers: H, body: JSON.stringify({ feature, mode }) })).json();
      if (d.success) setRows(d.data); else setErr(d.error || 'تعذّر الحفظ');
    } catch { setErr('تعذّر الاتصال'); } finally { setBusy(''); }
  };
  return (
    <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 14, marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, color: UI.ink, margin: '0 0 4px' }}>⚙️ نموذج الذكاء لكل ميزة</h3>
      <div style={{ fontSize: 12, color: UI.faint, marginBottom: 12, lineHeight: 1.6 }}>
        التغيير يسري خلال دقيقة. «تلقائي» للفواتير فقط: يقرأ بالأرخص ثم يفحص الأرقام، ويعيد بالأقوى عند الشك — راقب بند «🔁 إعادة قراءة» أدناه لمعرفة كم مرة احتاج الأقوى.
      </div>
      {err && <ErrBox msg={err} />}
      {!rows ? <Spinner /> : rows.map(r => (
        <div key={r.feature} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid #f1f5f9' }}>
          <div style={{ flex: '1 1 200px', fontSize: 13, fontWeight: 600, color: UI.ink }}>{MODEL_FEATURE_LABEL[r.feature] || r.feature}</div>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
            {r.modes.map(m => {
              const on = m === r.mode, info = MODE_INFO[m];
              return (
                <button key={m} title={info?.hint} disabled={!!busy} onClick={() => !on && choose(r.feature, m)}
                  style={{ padding: '5px 10px', fontSize: 12, fontWeight: 700, border: 'none', borderInlineEnd: '1px solid #e2e8f0',
                    cursor: on ? 'default' : 'pointer', background: on ? info?.color : '#fff', color: on ? '#fff' : '#475569',
                    opacity: busy && busy !== r.feature + m ? 0.6 : 1 }}>
                  {busy === r.feature + m ? '…' : info?.label || m}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: UI.ink }}>استهلاك الذكاء الاصطناعي (Gemini)</h2>
        <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginInlineStart: 'auto' }}>
          {([['usage', '📊 الاستهلاك'], ['images', '🖼️ الصور المحلَّلة']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, border: 'none', cursor: 'pointer',
                background: view === k ? '#4f46e5' : '#fff', color: view === k ? '#fff' : '#475569' }}>{l}</button>
          ))}
        </div>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 10px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13, color: UI.ink }}>
          <option value={1}>آخر يوم</option>
          <option value={7}>آخر 7 أيام</option>
          <option value={30}>آخر 30 يوماً</option>
          <option value={90}>آخر 90 يوماً</option>
        </select>
      </div>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 16, lineHeight: 1.6 }}>
        كل نداء إلى Gemini يُسجَّل (ناجحاً أو فاشلاً) منذ تفعيل هذه الميزة. «التوكنز» هي ما تحاسب عليه Google؛ الإدخال = ما أرسلناه، الإخراج = ما أجاب به.
      </div>

      {view === 'images' && <InvoiceReadsPanel token={token} days={days} />}
      {view === 'usage' && <ModelSettings token={token} />}

      {view === 'usage' && error && <ErrBox msg={error} />}
      {view === 'usage' && (loading ? <Spinner /> : data && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <Stat label="نداءات اليوم" value={fmt(data.today?.calls)} sub={`${fmt(data.today?.tokens)} توكن`} />
            <Stat label={`نداءات (${data.days} يوم)`} value={fmt(data.totals?.calls)} sub={`ناجح ${fmt(data.totals?.ok)}`} />
            <Stat label="إجمالي التوكنز" value={fmt(data.totals?.tokens)} sub={`إدخال ${fmt(data.totals?.promptTokens)} / إخراج ${fmt(data.totals?.outputTokens)}`} />
            <Stat label="أخطاء الحصّة (429)" value={fmt(data.totals?.rateLimited)} sub={`انتهاء مهلة ${fmt(data.totals?.timeouts)}`} />
          </div>

          <h3 style={{ fontSize: 14, color: UI.ink, margin: '0 0 8px' }}>النداءات يومياً</h3>
          <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, padding: 14, marginBottom: 20 }}>
            {data.daily.length === 0 && <div style={{ color: UI.faint, fontSize: 13 }}>لا نداءات مسجَّلة بعد.</div>}
            {data.daily.map(d => (
              <div key={d.day} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5, fontSize: 12.5 }}>
                <div style={{ width: 82, color: UI.muted, direction: 'ltr', textAlign: 'end' }}>{d.day.slice(5)}</div>
                <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 14 }}>
                  <div style={{ width: `${(d.calls / maxCalls) * 100}%`, background: '#4f46e5', height: 14, borderRadius: 4 }} />
                </div>
                <div style={{ width: 150, color: UI.ink }}>{fmt(d.calls)} نداء · {fmt(d.tokens)} توكن</div>
              </div>
            ))}
          </div>

          <h3 style={{ fontSize: 14, color: UI.ink, margin: '0 0 8px' }}>حسب الميزة</h3>
          <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, overflowX: 'auto', marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>الميزة</th><th style={th}>نداءات</th><th style={th}>ناجحة</th>
                <th style={th}>إدخال</th><th style={th}>إخراج</th><th style={th}>المجموع</th><th style={th}>متوسط الزمن</th>
              </tr></thead>
              <tbody>
                {data.byFeature.map(f => (
                  <tr key={f.feature}>
                    <td style={td}>{FEATURE_LABEL[f.feature] ?? f.feature}</td>
                    <td style={td}>{fmt(f.calls)}</td><td style={td}>{fmt(f.ok)}</td>
                    <td style={td}>{fmt(f.promptTokens)}</td><td style={td}>{fmt(f.outputTokens)}</td>
                    <td style={td}>{fmt(f.tokens)}</td><td style={td}>{(f.avgMs / 1000).toFixed(1)} ث</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ fontSize: 14, color: UI.ink, margin: '0 0 8px' }}>حسب الموديل</h3>
          <div style={{ background: '#fff', border: '1px solid #e9edf3', borderRadius: 10, overflowX: 'auto' }}>
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
        </>
      ))}
    </div>
  );
}
