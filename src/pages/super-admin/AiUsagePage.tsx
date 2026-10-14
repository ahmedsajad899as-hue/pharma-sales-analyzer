import { useState, useEffect } from 'react';
import { useSuperAdmin } from '../../context/SuperAdminContext';
import { Spinner, ErrBox, UI } from './OfficesPage';

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

// صفحة استهلاك Gemini — كل نداء (ناجح أو فاشل) يُسجَّل في callGeminiSmart نفسها فتشمل
// كل ميزات التطبيق لا البوت وحده. الميزة غير الموسومة تظهر «other».
export default function AiUsagePage() {
  const { token } = useSuperAdmin();
  const [days, setDays] = useState(7);
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
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 10px', border: '1px solid #d8dee8', borderRadius: 8, fontSize: 13, color: UI.ink }}>
          <option value={1}>آخر يوم</option>
          <option value={7}>آخر 7 أيام</option>
          <option value={30}>آخر 30 يوماً</option>
          <option value={90}>آخر 90 يوماً</option>
        </select>
      </div>
      <div style={{ fontSize: 12.5, color: UI.faint, marginBottom: 16, lineHeight: 1.6 }}>
        كل نداء إلى Gemini يُسجَّل (ناجحاً أو فاشلاً) منذ تفعيل هذه الميزة. «التوكنز» هي ما يحاسب عليه Gemini؛ الإدخال = ما أرسلناه، الإخراج = ما أجاب به.
      </div>

      {error && <ErrBox msg={error} />}
      {loading ? <Spinner /> : data && (
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
      )}
    </div>
  );
}
