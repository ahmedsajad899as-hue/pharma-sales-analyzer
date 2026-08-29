import { useState, useEffect, useCallback } from 'react';

/**
 * طابور مراجعة تطابق أسماء الأطباء — يعرض كل DoctorNameLink حيث needsReview=true:
 * روابط أُنشئت من تشابه اسم لا تطابق نصي تام (تلقائياً بثقة عالية، أو باختيار
 * المستخدم لمرشّح غير مؤكَّد 100% أثناء استيراد زيارات من إكسل). السوبر أدمن
 * يتحقّق من كل تطابق: "تأكيد" يبقيه كما هو، "إلغاء الربط" يحذفه فيُسأل عنه من
 * جديد في الاستيراد القادم لهذا الاسم.
 */
interface MatchRow {
  id: number;
  fromName: string;
  areaName: string | null;
  confidence: string;
  createdAt: string;
  owner: string;
  doctor: { id: number; name: string; specialty: string | null; pharmacyName: string | null; areaName: string | null } | null;
}

export default function DoctorNameMatchesTab({ token }: { token: string | null }) {
  const H = { Authorization: `Bearer ${token}` };
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const limit = 50;

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) });
      const r = await fetch(`/api/super-admin/doctor-name-matches?${qs}`, { headers: H });
      const d = await r.json();
      if (d.success) {
        setRows(d.data);
        setTotal(d.total);
        setPage(d.page);
        setPages(Math.max(1, Math.ceil(d.total / limit)));
      }
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { load(1); /* eslint-disable-next-line */ }, []);

  const resolve = async (id: number, action: 'confirm' | 'unlink') => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/super-admin/doctor-name-matches/${id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...H },
        body: JSON.stringify({ action }),
      });
      const d = await r.json();
      if (d.success) setRows(rs => rs.filter(x => x.id !== id));
      setTotal(t => Math.max(0, t - 1));
    } finally { setBusyId(null); }
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', fontSize: 14 }}>⏳ جاري التحميل...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: '#78716c', lineHeight: 1.7 }}>
          تطابقات أسماء أطباء تمّت تلقائياً أو باختيار مستخدم لمرشّح غير مؤكَّد 100% — راجعها وأكّد صحّتها أو ألغِ الربط إن كانت خاطئة.
        </p>
        <div style={{ fontSize: 13, color: '#d97706', fontWeight: 700, background: '#fffbeb', padding: '6px 14px', borderRadius: 10, whiteSpace: 'nowrap' }}>
          {total.toLocaleString('ar-IQ')} بانتظار المراجعة
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#94a3b8', background: '#f8fafc', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
          لا توجد تطابقات بحاجة مراجعة حالياً ✅
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => (
            <div key={r.id} style={{
              background: '#fff', border: '1.5px solid #fde68a', borderRadius: 14, padding: '14px 16px',
              boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 800, color: '#b91c1c' }}>{r.fromName}</span>
                <span style={{ color: '#94a3b8', fontSize: 16 }}>→</span>
                <span style={{ fontSize: 14.5, fontWeight: 800, color: '#059669' }}>{r.doctor?.name ?? '— (بلا ربط)'}</span>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                  background: r.confidence === 'fuzzy' ? '#fef3c7' : '#e0e7ff',
                  color: r.confidence === 'fuzzy' ? '#92400e' : '#4338ca',
                }}>
                  {r.confidence === 'fuzzy' ? '🤖 تلقائي (تشابه)' : '👤 اختيار مستخدم'}
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {r.areaName && <span style={chip}>📍 منطقة الرفع: {r.areaName}</span>}
                {r.doctor?.specialty && <span style={chip}>🩺 {r.doctor.specialty}</span>}
                {r.doctor?.pharmacyName && <span style={chip}>🏪 {r.doctor.pharmacyName}</span>}
                {r.doctor?.areaName && <span style={chip}>📍 منطقة الطبيب: {r.doctor.areaName}</span>}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span>👤 الحساب: <strong style={{ color: '#475569' }}>{r.owner}</strong></span>
                  <span>🕐 {fmtDate(r.createdAt)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button disabled={busyId === r.id} onClick={() => resolve(r.id, 'unlink')} style={rejectBtn}>
                    ↩️ إلغاء الربط
                  </button>
                  <button disabled={busyId === r.id} onClick={() => resolve(r.id, 'confirm')} style={confirmBtn}>
                    ✅ تأكيد صحّة التطابق
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 18 }}>
          <button disabled={page <= 1} onClick={() => load(page - 1)} style={pgBtn(page <= 1)}>←</button>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => load(page + 1)} style={pgBtn(page >= pages)}>→</button>
        </div>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #e8edf5', borderRadius: 20,
  padding: '3px 10px', fontSize: 12, color: '#475569', fontWeight: 500,
};
const confirmBtn: React.CSSProperties = {
  border: '1.5px solid #16a34a', background: '#f0fdf4', color: '#166534', borderRadius: 9,
  padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
const rejectBtn: React.CSSProperties = {
  border: '1.5px solid #e2e8f0', background: '#fff', color: '#475569', borderRadius: 9,
  padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
const pgBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 9, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', cursor: disabled ? 'default' : 'pointer',
  fontWeight: 700, opacity: disabled ? 0.4 : 1, fontFamily: 'inherit',
});
