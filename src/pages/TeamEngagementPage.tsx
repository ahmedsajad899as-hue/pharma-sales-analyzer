import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useBackHandler } from '../hooks/useBackHandler';
import { NAV_ITEMS } from '../config/featureConfig';

interface DaySeriesPoint { date: string; opens: number; events: number; minutes: number; }
interface FeatureCount { module: string; count: number; }

interface MemberEngagement {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  isActive: boolean;
  lastActiveAt: string | null;
  opensToday: number;
  minutesToday: number;
  minutesLast7: number;
  avgMinutesPerActiveDay7: number;
  activeDaysLast7: number;
  activeDaysLast30: number;
  distinctFeaturesLast30: number;
  interactionsLast30: number;
  topFeatures: FeatureCount[];
  dailySeries: DaySeriesPoint[];
  score: number;
  status: 'very_active' | 'moderate' | 'low' | 'inactive' | 'never';
}

interface Summary { total: number; activeToday: number; avgScore: number; avgMinutesToday: number; }

const ROLE_LABELS: Record<string, string> = {
  company_manager: '🏭 مدير شركة',
  office_hr:       '🧑‍💼 موارد بشرية',
  office_employee: '👤 موظف مكتب',
};

const STATUS_META: Record<MemberEngagement['status'], { label: string; color: string; bg: string }> = {
  very_active: { label: '🟢 نشط جداً',   color: '#16a34a', bg: '#e6f7f2' },
  moderate:    { label: '🟡 نشاط متوسط', color: '#ca8a04', bg: '#fef9e7' },
  low:         { label: '🟠 نشاط ضعيف',  color: '#ea580c', bg: '#fff1e6' },
  inactive:    { label: '🔴 شبه غائب',   color: '#dc2626', bg: '#fef2f2' },
  never:       { label: '⚪ لم يدخل بعد', color: '#94a3b8', bg: '#f1f5f9' },
};

const FEATURE_LABEL: Record<string, string> = Object.fromEntries(NAV_ITEMS.map(n => [n.id, n.labelAr]));

function relativeTime(iso: string | null): string {
  if (!iso) return 'لم يدخل إطلاقاً';
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1)  return 'الآن';
  if (diffMin < 60) return `قبل ${diffMin} دقيقة`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `قبل ${diffH} ساعة`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'أمس';
  if (diffD < 30) return `قبل ${diffD} يوم`;
  return new Date(iso).toLocaleDateString('ar-SA');
}

function formatMinutes(min: number): string {
  if (min <= 0) return '0 د';
  if (min < 60) return `${min} د`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}س ${m}د` : `${h}س`;
}

function heatColor(events: number): string {
  if (events <= 0) return '#eef1f6';
  if (events <= 2) return '#c7d7fb';
  if (events <= 5) return '#8aa8f5';
  if (events <= 10) return '#4f74e8';
  return '#1a56db';
}

function ScoreRing({ score, color }: { score: number; color: string }) {
  return (
    <div style={{
      width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
      background: `conic-gradient(${color} ${score * 3.6}deg, #e7ebf3 0deg)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 46, height: 46, borderRadius: '50%', background: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 14, color,
      }}>
        {score}%
      </div>
    </div>
  );
}

function MiniHeatmap({ series }: { series: DaySeriesPoint[] }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {series.map(d => (
        <div key={d.date} title={`${d.date} — ${d.events} حدث`}
          style={{ width: 11, height: 11, borderRadius: 3, background: heatColor(d.events) }} />
      ))}
    </div>
  );
}

export default function TeamEngagementPage() {
  const { token } = useAuth();
  const authH = () => ({ Authorization: `Bearer ${token}` });

  const [members, setMembers]   = useState<MemberEngagement[]>([]);
  const [summary, setSummary]   = useState<Summary>({ total: 0, activeToday: 0, avgScore: 0, avgMinutesToday: 0 });
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [detail, setDetail]     = useState<MemberEngagement | null>(null);

  useBackHandler([[detail !== null, () => setDetail(null)]]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/engagement/team', { headers: authH() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'فشل تحميل بيانات نشاط الفريق');
      setMembers(j.data ?? []);
      setSummary(j.summary ?? { total: 0, activeToday: 0, avgScore: 0, avgMinutesToday: 0 });
    } catch (err: any) { setError(err.message || 'فشل تحميل بيانات نشاط الفريق'); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <div className="page-header" style={{ justifyContent: 'flex-end' }}>
        <button onClick={load} style={{ fontSize: 13, padding: '6px 14px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>🔄 تحديث</button>
      </div>

      {error && <div className="alert alert--error" onClick={() => setError('')}>{error} ✕</div>}

      {loading ? (
        <div className="loading-spinner">جاري التحميل...</div>
      ) : (
        <>
          <div className="stats-grid stats-grid--4" style={{ marginBottom: 18 }}>
            <div className="stat-card" style={{ borderTop: '4px solid var(--c-accent)' }}>
              <div className="stat-card-icon stat-card-icon--blue">👥</div>
              <div className="stat-card-body">
                <div className="stat-card-value">{summary.total}</div>
                <div className="stat-card-label">إجمالي أعضاء المكتب</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderTop: '4px solid var(--c-success)' }}>
              <div className="stat-card-icon stat-card-icon--green">✅</div>
              <div className="stat-card-body">
                <div className="stat-card-value">{summary.activeToday} / {summary.total}</div>
                <div className="stat-card-label">فتحوا التطبيق اليوم</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderTop: '4px solid #ca8a04' }}>
              <div className="stat-card-icon stat-card-icon--amber">📈</div>
              <div className="stat-card-body">
                <div className="stat-card-value">{summary.avgScore}%</div>
                <div className="stat-card-label">متوسط التزام الفريق</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderTop: '4px solid var(--c-purple)' }}>
              <div className="stat-card-icon stat-card-icon--purple">⏱️</div>
              <div className="stat-card-body">
                <div className="stat-card-value">{formatMinutes(summary.avgMinutesToday)}</div>
                <div className="stat-card-label">متوسط وقت الاستخدام اليوم</div>
              </div>
            </div>
          </div>

          {members.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
              <p>لا يوجد أعضاء في مكتبك بعد (مدير شركة / موارد بشرية / موظف مكتب)</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {members.map(m => {
                const meta = STATUS_META[m.status];
                return (
                  <div key={m.id} onClick={() => setDetail(m)} style={{
                    background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0',
                    padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
                    boxShadow: '0 1px 4px rgba(0,0,0,0.04)', cursor: 'pointer',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                      background: meta.bg, color: meta.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 900, fontSize: 18,
                    }}>
                      {(m.displayName || m.username)[0]?.toUpperCase()}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 15, color: '#1e293b' }}>{m.displayName || m.username}</strong>
                        <span style={{ fontSize: 12, color: '#6366f1' }}>{ROLE_LABELS[m.role] ?? m.role}</span>
                        {!m.isActive && <span style={{ fontSize: 11, color: '#ef4444' }}>● حساب معطّل</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
                        <span style={{ fontWeight: 700, color: meta.color }}>{meta.label}</span>
                        {' · '}آخر ظهور: {relativeTime(m.lastActiveAt)}
                        {' · '}فتح التطبيق {m.opensToday} مرة اليوم
                        {' · '}⏱️ {formatMinutes(m.minutesToday)} استخدام فعلي اليوم
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <MiniHeatmap series={m.dailySeries} />
                      </div>
                    </div>

                    <ScoreRing score={m.score} color={meta.color} />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── Detail Modal ── */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📊 {detail.displayName || detail.username}</h2>
              <button className="modal-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: '#475569' }}>⏱️ وقت الاستخدام اليوم: <strong>{formatMinutes(detail.minutesToday)}</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>⏱️ إجمالي 7 أيام: <strong>{formatMinutes(detail.minutesLast7)}</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>⏱️ متوسط اليوم النشط: <strong>{formatMinutes(detail.avgMinutesPerActiveDay7)}</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>🗓️ أيام نشاط (7 أيام): <strong>{detail.activeDaysLast7}/7</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>🗓️ أيام نشاط (30 يوم): <strong>{detail.activeDaysLast30}/30</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>🧩 صفحات مختلفة استُخدمت: <strong>{detail.distinctFeaturesLast30}</strong></div>
                <div style={{ fontSize: 13, color: '#475569' }}>✍️ إجراءات فعلية (30 يوم): <strong>{detail.interactionsLast30}</strong></div>
              </div>

              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 8 }}>أكثر الصفحات استخداماً</h3>
              {detail.topFeatures.length === 0 ? (
                <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>لا يوجد استخدام مسجَّل لأي صفحة بعد.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                  {detail.topFeatures.map(f => (
                    <div key={f.module} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, background: '#f8fafc', borderRadius: 8, padding: '6px 10px' }}>
                      <span>{FEATURE_LABEL[f.module] ?? f.module}</span>
                      <strong style={{ color: '#6366f1' }}>{f.count}</strong>
                    </div>
                  ))}
                </div>
              )}

              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 8 }}>آخر 14 يوماً</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[...detail.dailySeries].reverse().map(d => (
                  <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ width: 78, color: '#64748b' }}>
                      {new Date(d.date).toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'numeric' })}
                    </span>
                    <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 6, height: 10, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(d.events * 10, 100)}%`, height: '100%', background: heatColor(d.events) }} />
                    </div>
                    <span style={{ width: 130, color: '#334155', textAlign: 'left' }}>{d.opens} فتح / {formatMinutes(d.minutes)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn--secondary" onClick={() => setDetail(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
