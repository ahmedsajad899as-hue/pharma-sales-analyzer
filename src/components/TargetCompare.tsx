import { useEffect } from 'react';

/**
 * مقارنة التارگت بالمبيع النت لشخص واحد: الجلب من GET /api/targets/actuals (نفس أرقام
 * التقارير) ونافذة تفاصيله ايتماً ايتماً. تُفتح بالضغط على اسمه في جدول التارگت.
 */

const API = import.meta.env.VITE_API_URL || '';

export interface ActualRow { itemIds: number[]; itemName: string; target: number; net: number; pct: number | null; }
export interface RepActuals {
  hasFiles: boolean;
  rows: ActualRow[];
  unTargeted: { itemName: string; net: number }[];
  totalTarget: number;
  totalNet: number;
  pct: number | null;
}

export const fmtQty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
export const pctClass = (p: number | null) => (p === null ? '' : p >= 100 ? 'tc-good' : p < 70 ? 'tc-low' : '');
export const pctText = (p: number | null) => (p === null ? '—' : `${p}%`);

export async function fetchActuals(
  id: number | null,
  period: { month: number; year: number; fileIds: number[] },
  token: string | null,
): Promise<RepActuals> {
  const qs = new URLSearchParams({ month: String(period.month), year: String(period.year), fileIds: period.fileIds.join(',') });
  if (id !== null) qs.set('id', String(id));
  const r = await fetch(`${API}/api/targets/actuals?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).data;
}

interface ModalProps {
  name: string;
  subtitle: string;
  data: RepActuals | undefined;
  loading: boolean;
  noFiles: boolean;
  onClose: () => void;
}

export function TargetCompareModal({ name, subtitle, data, loading, noFiles, onClose }: ModalProps) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const remaining = data ? Math.max(0, data.totalTarget - data.totalNet) : 0;

  return (
    <div className="tc-overlay" dir="rtl" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tc-modal m-dialog" role="dialog" aria-label={`مقارنة تارگت ${name}`}>
        <div className="tc-head">
          <div>
            <div className="tc-name">{name}</div>
            <div className="tc-sub">{subtitle}</div>
          </div>
          <button className="tg-btn" onClick={onClose}>إغلاق</button>
        </div>

        {noFiles ? (
          <div className="tm-empty">فعّل ملف مبيعات لعرض المبيع النت</div>
        ) : !data ? (
          <div className="tm-empty">{loading ? 'جاري حساب المبيع النت…' : 'تعذّر حساب المبيع النت'}</div>
        ) : (
          <>
            <div className="tc-kpis">
              <div><span>التارگت</span><b>{fmtQty(data.totalTarget)}</b></div>
              <div><span>المبيع النت</span><b>{fmtQty(data.totalNet)}</b></div>
              <div><span>الإنجاز</span><b className={pctClass(data.pct)}>{pctText(data.pct)}</b></div>
              <div><span>المتبقي</span><b>{fmtQty(remaining)}</b></div>
            </div>

            <div className="tc-body">
              {data.rows.length === 0 ? (
                <div className="tm-empty">لا يوجد تارگت لهذا الشهر</div>
              ) : (
                <table className="tc-table">
                  <thead>
                    <tr><th className="tc-item">الايتم</th><th>التارگت</th><th>المبيع النت</th><th>الإنجاز</th><th>المتبقي</th></tr>
                  </thead>
                  <tbody>
                    {data.rows.map(r => (
                      <tr key={r.itemIds[0]}>
                        <td className="tc-item" title={r.itemName}><span dir="auto">{r.itemName}</span></td>
                        <td>{fmtQty(r.target)}</td>
                        <td>{fmtQty(r.net)}</td>
                        <td className={pctClass(r.pct)}>{pctText(r.pct)}</td>
                        <td>{fmtQty(Math.max(0, r.target - r.net))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {data.unTargeted.length > 0 && (
                <>
                  <div className="tc-section">مبيع نت على ايتمات بلا تارگت — لا يدخل في الإنجاز</div>
                  <table className="tc-table">
                    <tbody>
                      {data.unTargeted.map(r => (
                        <tr key={r.itemName}>
                          <td className="tc-item" title={r.itemName}><span dir="auto">{r.itemName}</span></td>
                          <td>{fmtQty(r.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
