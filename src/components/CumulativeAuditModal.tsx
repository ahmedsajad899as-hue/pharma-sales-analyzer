// ════════════════════════════════════════════════════════════════════════════
// CumulativeAuditModal — «تدقيق التكرار» لملف تراكمي.
//
// يعرض لكل شهر المبيع قبل/بعد إزالة الصفوف التي دخلت الملف مرتين عبر رفعتين،
// ولكل رفعة ما تكرّر منها، ثم يتيح الإصلاح (صاحب الملف فقط). الخادم:
// GET /api/files/:id/audit (معاينة) و POST /api/files/:id/audit/fix.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type CSSProperties } from 'react';

type Bucket = { rows: number; qty: number; value: number };
type MonthRow = {
  ym: string; label: string;
  saleBefore: Bucket; saleAfter: Bucket; dupSale: Bucket;
  returnAfter: Bucket; dupReturn: Bucket;
  suspectSale: { rows: number; value: number };
};
type BatchRow = { id: number | null; name: string; uploadedAt: string | null; rows: number; duplicates: number; dupSaleValue: number; dupReturnValue: number };
type Example = { batch: number | null; month: string; recordType: string; orderNo: string; date: string; pharmacy: string; item: string; quantity: number; value: number };
type Report = {
  fileId: number; fileName: string; currency: string;
  scanned: number; staleKeys: number; duplicates: number;
  suspects: { rows: number; value: number };
  applied: boolean; removed: number;
  months: MonthRow[]; batches: BatchRow[]; examples: Example[];
};

interface Props {
  fileId: number;
  token: string | null;
  canFix: boolean;
  onClose: () => void;
  onFixed: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB') : '—');

export default function CumulativeAuditModal({ fileId, token, canFix, onClose, onFixed }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState('');
  const [doneMsg, setDoneMsg] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch(`/api/files/${fileId}/audit`, { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'تعذّر التدقيق');
        if (alive) setReport(j.data);
      } catch (e: any) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [fileId, token]);

  const fix = async () => {
    if (!report) return;
    if (!window.confirm(`سيُحذف ${fmt(report.duplicates)} صف مكرر (نسخة ثانية لنفس صف الإكسل جاءت من رفعة أخرى) وتبقى النسخة الأقدم. متابعة؟`)) return;
    setFixing(true); setError('');
    try {
      const res = await fetch(`/api/files/${fileId}/audit/fix`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'تعذّر الإصلاح');
      setDoneMsg(`تم: حُذف ${fmt(j.data.removed)} صف مكرر. الأرقام أدناه بعد الإصلاح.`);
      // بعد الإصلاح «قبل» = «بعد» — نعيد المعاينة كي تعكس الملف الحالي فعلاً.
      const again = await fetch(`/api/files/${fileId}/audit`, { headers: { Authorization: `Bearer ${token}` } });
      const j2 = await again.json();
      if (again.ok) setReport(j2.data);
      onFixed();
    } catch (e: any) { setError(e.message); }
    finally { setFixing(false); }
  };

  const months = (report?.months ?? []).filter(m => m.saleBefore.rows > 0 || m.returnAfter.rows > 0);
  const th: CSSProperties = { padding: '6px 8px', background: '#f1f5f9', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap', textAlign: 'center' };
  const td: CSSProperties = { padding: '6px 8px', borderTop: '1px solid #e2e8f0', fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} dir="rtl" style={{ background: '#fff', borderRadius: 14, width: 'min(920px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>🔍 تدقيق التكرار — {report?.fileName ?? ''}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {loading && <div style={{ color: '#64748b', fontSize: 13 }}>جاري فحص كل صفوف الملف…</div>}
        {error && <div style={{ color: 'var(--c-danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {doneMsg && <div style={{ color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 }}>{doneMsg}</div>}

        {report && (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.8, background: report.duplicates > 0 ? '#fff7ed' : '#f0fdf4', border: `1px solid ${report.duplicates > 0 ? '#fed7aa' : '#bbf7d0'}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              فُحص <b>{fmt(report.scanned)}</b> صف.{' '}
              {report.duplicates > 0
                ? <>وُجد <b style={{ color: '#b45309' }}>{fmt(report.duplicates)}</b> صف دخل الملف مرتين (نفس صف الإكسل في رفعتين). السبب: دمج ايتمات بين الرفعتين غيّر رقم الايتم فلم تتعرّف الرفعة اللاحقة على الصف — أُصلح هذا في البصمة الآن.</>
                : <>لا يوجد أي صف مكرر بين الرفعات.</>}
              {report.suspects.rows > 0 && (
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  للعلم: {fmt(report.suspects.rows)} صف «مشتبه» (نفس الصيدلية والايتم والكمية والقيمة واليوم في رفعتين لكن برقم طلبية/صيغة تاريخ مختلفة) — لا تُحذف تلقائياً لأنها قد تكون طلبيات حقيقية.
                </div>
              )}
            </div>

            <div style={{ fontWeight: 700, fontSize: 13, margin: '6px 0' }}>حسب الشهر ({report.currency})</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <thead>
                  <tr>
                    <th style={th}>الشهر</th>
                    <th style={th}>مبيع حالياً</th>
                    <th style={th}>مكرر</th>
                    <th style={th}>مبيع صحيح</th>
                    <th style={th}>كمية صحيحة</th>
                    <th style={th}>صفوف</th>
                    <th style={th}>إرجاع</th>
                    <th style={th}>إرجاع مكرر</th>
                    <th style={th}>مشتبه</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map(m => (
                    <tr key={m.ym}>
                      <td style={{ ...td, fontWeight: 700 }}>{m.label}</td>
                      <td style={td}>{fmt(m.saleBefore.value)}</td>
                      <td style={{ ...td, color: m.dupSale.rows ? '#b45309' : '#94a3b8', fontWeight: m.dupSale.rows ? 700 : 400 }}>
                        {m.dupSale.rows ? `${fmt(m.dupSale.value)} (${fmt(m.dupSale.rows)} صف)` : '—'}
                      </td>
                      <td style={{ ...td, color: '#065f46', fontWeight: 700 }}>{fmt(m.saleAfter.value)}</td>
                      <td style={td}>{fmt(m.saleAfter.qty)}</td>
                      <td style={td}>{fmt(m.saleAfter.rows)}</td>
                      <td style={td}>{fmt(m.returnAfter.value)}</td>
                      <td style={{ ...td, color: m.dupReturn.rows ? '#b45309' : '#94a3b8' }}>{m.dupReturn.rows ? fmt(m.dupReturn.value) : '—'}</td>
                      <td style={{ ...td, color: '#64748b' }}>{m.suspectSale.rows ? `${fmt(m.suspectSale.value)} (${fmt(m.suspectSale.rows)})` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ fontWeight: 700, fontSize: 13, margin: '14px 0 6px' }}>حسب الرفعة</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {report.batches.map(b => (
                <div key={String(b.id)} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
                  <span style={{ fontWeight: 700, flex: '1 1 180px' }}>{b.name}</span>
                  <span style={{ color: '#64748b' }}>{fmtDate(b.uploadedAt)}</span>
                  <span>{fmt(b.rows)} صف</span>
                  {b.duplicates > 0
                    ? <span style={{ color: '#b45309', fontWeight: 700 }}>مكرر من رفعة أقدم: {fmt(b.duplicates)} صف — مبيع {fmt(b.dupSaleValue)}{b.dupReturnValue ? ` · إرجاع ${fmt(b.dupReturnValue)}` : ''}</span>
                    : <span style={{ color: '#16a34a' }}>بلا تكرار</span>}
                </div>
              ))}
            </div>

            {report.examples.length > 0 && (
              <>
                <div style={{ fontWeight: 700, fontSize: 13, margin: '14px 0 6px' }}>أمثلة على الصفوف المكررة</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #e2e8f0' }}>
                    <thead><tr>
                      <th style={th}>الشهر</th><th style={th}>التاريخ</th><th style={th}>رقم الطلبية</th>
                      <th style={th}>الصيدلية</th><th style={th}>الايتم</th><th style={th}>الكمية</th><th style={th}>القيمة</th>
                    </tr></thead>
                    <tbody>
                      {report.examples.map((e, i) => (
                        <tr key={i}>
                          <td style={td}>{e.month}</td><td style={td}>{e.date || '—'}</td><td style={td}>{e.orderNo || '—'}</td>
                          <td style={td}>{e.pharmacy || '—'}</td><td style={td}>{e.item.startsWith('#') ? `ايتم ${e.item}` : e.item}</td>
                          <td style={td}>{fmt(e.quantity)}</td><td style={td}>{fmt(e.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              {report.duplicates > 0 && canFix && (
                <button onClick={fix} disabled={fixing}
                  style={{ border: 'none', background: '#16a34a', color: '#fff', borderRadius: 8, padding: '8px 16px', fontWeight: 700, cursor: 'pointer' }}>
                  {fixing ? 'جاري الإصلاح…' : `🧹 حذف ${fmt(report.duplicates)} صف مكرر`}
                </button>
              )}
              {report.duplicates > 0 && !canFix && (
                <span style={{ fontSize: 12, color: '#64748b', alignSelf: 'center' }}>الإصلاح متاح لصاحب الملف فقط.</span>
              )}
              <button onClick={onClose} style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>إغلاق</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
