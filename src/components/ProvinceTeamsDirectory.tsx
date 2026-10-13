// ════════════════════════════════════════════════════════════════════════════
// ProvinceTeamsDirectory — نافذة «فرق المحافظات» داخل خريطة المحافظات:
// محافظة ← التيم ليدر ← المندوبون العلميون؛ وبالضغط على مندوب تظهر ايتماته
// وكمية/قيمة مبيع كل ايتم في تلك المحافظة.
// التقييد بحسب الدور (مدير الشركة: مندوبو شركاته على ايتماته فقط) يحدث في السيرفر:
// GET /api/province-teams/directory — القيم بالدولار، و fmtVal يحوّلها لعملة العرض.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';

interface DirItem { itemId: number; name: string; company: string; net: number; qty: number }
interface DirRep { repUserId: number; repName: string; repActive: boolean; companies: string[]; net: number; qty: number; items: DirItem[] }
interface DirTeam { id: number; provinceId: number; provinceName: string; leaderName: string | null; reps: DirRep[] }

interface Props {
  token: string | null;
  fileIds: number[];
  applyMonth: (p: URLSearchParams) => void;
  fmtVal: (n: number) => string;
  currencyLabel: string;
  onClose: () => void;
}

const nf = (n: number) => Math.round(n).toLocaleString('en-US');

export default function ProvinceTeamsDirectory({ token, fileIds, applyMonth, fmtVal, currencyLabel, onClose }: Props) {
  const [teams, setTeams] = useState<DirTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [openRep, setOpenRep] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const p = new URLSearchParams();
        applyMonth(p);
        if (fileIds.length) p.set('fileIds', fileIds.join(','));
        const r = await fetch(`/api/province-teams/directory?${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        const j = await r.json();
        if (!r.ok || j.success === false) throw new Error(j.message || 'تعذّر تحميل الفرق');
        setTeams(j.teams ?? []);
      } catch (e: any) { if (e.name !== 'AbortError') setErr(e.message || 'تعذّر تحميل الفرق'); }
      finally { if (!ac.signal.aborted) setLoading(false); }
    })();
    return () => ac.abort();
  // الجلب مرة عند فتح النافذة (الشهر والملفات ثابتان وقت الفتح)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const s = q.trim();
    if (!s) return teams;
    return teams.filter(t =>
      t.provinceName.includes(s) || (t.leaderName ?? '').includes(s) ||
      t.reps.some(r => r.repName.includes(s) || r.companies.some(c => c.includes(s))));
  }, [teams, q]);

  return (
    <div dir="rtl" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, width: 'min(980px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(15,23,42,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a' }}>فرق المحافظات</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="بحث: محافظة / تيم ليدر / مندوب / شركة"
            style={{ flex: 1, minWidth: 180, border: '1px solid #cbd5e1', borderRadius: 999, padding: '7px 14px', fontSize: 13 }} />
          <button type="button" onClick={onClose} style={{ border: 'none', background: '#f1f5f9', borderRadius: 999, width: 32, height: 32, cursor: 'pointer', fontSize: 16 }} aria-label="إغلاق">✕</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 14 }}>
          {loading && <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>جاري التحميل…</div>}
          {err && <div style={{ color: '#be123c', padding: 12 }}>{err}</div>}
          {!loading && !err && shown.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>لا توجد فرق محافظات لعرضها.</div>
          )}

          {shown.map(t => (
            <div key={t.id} style={{ border: '1px solid #e2e8f0', borderRadius: 16, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#f8fafc', padding: '10px 14px' }}>
                <span style={{ fontWeight: 900, fontSize: 16, color: '#0f172a' }}>{t.provinceName}</span>
                <span style={{ fontSize: 12.5, color: '#475569' }}>
                  التيم ليدر: <b style={{ color: '#1f4fb4' }}>{t.leaderName ?? 'غير معيَّن'}</b>
                </span>
              </div>

              {t.reps.length === 0 && <div style={{ padding: '10px 14px', fontSize: 12.5, color: '#94a3b8' }}>لا يوجد مندوبون معيَّنون.</div>}

              {t.reps.map(r => {
                const key = `${t.id}:${r.repUserId}`;
                const on = openRep === key;
                return (
                  <div key={key} style={{ borderTop: '1px solid #eef2f7' }}>
                    <button type="button" onClick={() => setOpenRep(on ? null : key)}
                      style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', background: on ? '#eef3fd' : '#fff', border: 'none', cursor: 'pointer', textAlign: 'right' }}>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: r.repActive ? '#0f172a' : '#94a3b8' }}>{on ? '▾' : '◂'} {r.repName}{r.repActive ? '' : ' (غير نشط)'}</span>
                        <span style={{ fontSize: 11.5, color: '#64748b' }}>{r.companies.join(' · ')}</span>
                      </span>
                      <span style={{ textAlign: 'left', direction: 'ltr' }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: r.net < 0 ? '#be123c' : '#0f766e' }}>{fmtVal(r.net)} {currencyLabel}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: '#64748b' }}>الكمية {nf(r.qty)}</span>
                      </span>
                    </button>

                    {on && (
                      <div style={{ padding: '4px 14px 12px', background: '#fbfcfe', overflowX: 'auto' }}>
                        {r.items.length === 0
                          ? <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '6px 0' }}>لا مبيع لايتمات هذا المندوب في هذه المحافظة للفترة المختارة.</div>
                          : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                              <thead>
                                <tr style={{ color: '#64748b', textAlign: 'right' }}>
                                  <th style={{ padding: '6px 4px', fontWeight: 700 }}>الايتم</th>
                                  <th style={{ padding: '6px 4px', fontWeight: 700 }}>الشركة</th>
                                  <th style={{ padding: '6px 4px', fontWeight: 700, textAlign: 'left' }}>الكمية</th>
                                  <th style={{ padding: '6px 4px', fontWeight: 700, textAlign: 'left' }}>القيمة ({currencyLabel})</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.items.map(i => (
                                  <tr key={i.itemId} style={{ borderTop: '1px solid #eef2f7' }}>
                                    <td style={{ padding: '6px 4px', fontWeight: 700, color: '#0f172a' }}>{i.name}</td>
                                    <td style={{ padding: '6px 4px', color: '#64748b' }}>{i.company}</td>
                                    <td style={{ padding: '6px 4px', textAlign: 'left', direction: 'ltr' }}>{nf(i.qty)}</td>
                                    <td style={{ padding: '6px 4px', textAlign: 'left', direction: 'ltr', fontWeight: 700, color: i.net < 0 ? '#be123c' : '#1f4fb4' }}>{fmtVal(i.net)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
