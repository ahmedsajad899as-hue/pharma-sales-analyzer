// تفصيل فريق محافظة: مؤشرات المحافظة، ثم المندوبون (المشترك بين شركتين يظهر
// بسطر لكل شركة)، وكل سطر شركة ينفتح على ايتماته ومناطقه وأهم زبائنه.

import { Fragment, useState } from 'react';
import { ArrowRight, Store, Warehouse, ClipboardCheck, AlertTriangle } from 'lucide-react';
import type { Team, Viewer, RepCompany, RepRow } from './types';
import { fmtInt, pct, initials, type Money } from './format';

interface Props {
  team: Team;
  viewer: Viewer;
  money: Money;
  onBack: () => void;
  onOpenPersonal?: () => void;
}

export default function TeamDetail({ team, viewer, money, onBack, onOpenPersonal }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const t = team.totals;
  const uncoveredNet = team.uncovered.reduce((s, u) => s + u.net, 0);
  const pharm = Math.max(0, t.pharmacyNet), wh = Math.max(0, t.warehouseNet);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <button className="pt-back" onClick={onBack}><ArrowRight size={15} /> كل المحافظات</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--c-primary)' }}>{team.provinceName}</h2>
            <span className="pt-card__sub" style={{ marginTop: 0 }}>
              <span className={`pt-avatar ${team.leaderName ? '' : 'pt-avatar--muted'}`}>{team.leaderName ? initials(team.leaderName) : '؟'}</span>
              {team.leaderName ? `تيم ليدر المحافظة: ${team.leaderName}` : 'بلا تيم ليدر'}
            </span>
          </div>
        </div>
        {onOpenPersonal && (
          <button className="btn btn--secondary btn--sm" onClick={onOpenPersonal}>
            <ClipboardCheck size={14} /> الجهد الشخصي للفريق
            {team.pendingPersonal > 0 && <span className="pt-count" style={{ marginRight: 6 }}>{team.pendingPersonal}</span>}
          </button>
        )}
      </div>

      {!team.fullView && (
        <div className="pt-note">
          <span>ℹ️</span>
          <span>
            {viewer.mode === 'company'
              ? <>تظهر هنا مبيعات <strong>شركاتك فقط</strong> — المندوب المشترك مع شركة أخرى يظهر بنصيب شركتك وحده.</>
              : <>تظهر هنا <strong>تعييناتك أنت</strong> في هذه المحافظة.</>}
          </span>
        </div>
      )}

      <div className="pt-kpis">
        <Kpi tone="coverage" label="تغطية المحافظة (صافي)" value={money.usd(t.net)} title={money.usdFull(t.net)}
          hint={`مبيع ${money.usd(t.salesValue)} − إرجاع ${money.usd(t.returnValue)}`} />
        <Kpi tone="coverage" label="إلى الصيدليات" value={money.usd(t.pharmacyNet)} hint={`${Math.round(pct(pharm, pharm + wh))}% من الصافي`} />
        <Kpi tone="coverage" label="إلى المذاخر" value={money.usd(t.warehouseNet)} hint={`${Math.round(pct(wh, pharm + wh))}% من الصافي`} />
        <Kpi tone="coverage" label="الطلبيات / الزبائن" value={`${fmtInt(t.orders)} / ${fmtInt(t.customers)}`} hint={`صافي الكمية ${fmtInt(t.netQty)}`} />
        <Kpi tone="personal" label="الجهد الشخصي (معتمد)" value={money.usd(team.personalUSD)} hint="مؤشر منفصل — لا يُجمع مع التغطية" />
        {team.uncovered.length > 0 && (
          <Kpi tone="alert" label="مبيعات غير منسوبة" value={money.usd(uncoveredNet)} hint="ايتمات بلا مندوب في المحافظة" />
        )}
      </div>

      {team.overlaps.length > 0 && (
        <div className="pt-note pt-note--warn">
          <AlertTriangle size={16} />
          <span>{team.overlaps.length} ايتم معيَّن لأكثر من مندوب لنفس الشركة (بيانات سابقة) — يُنسب للأقدم تعييناً. صحّحه من «الهيكلية».</span>
        </div>
      )}

      <div className="pt-panel">
        <div className="pt-panel__head">
          <div className="pt-panel__title">المندوبون العلميون</div>
          <div className="pt-chips">
            <span className="pt-chip"><span className="pt-dot" style={{ background: 'var(--c-accent)' }} />تغطية المحافظة</span>
            <span className="pt-chip"><span className="pt-dot" style={{ background: 'var(--c-success)' }} />الجهد الشخصي</span>
          </div>
        </div>
        {team.reps.length === 0 ? (
          <div className="pt-empty"><div className="pt-empty__title">لا مندوبين معيَّنين في هذه المحافظة</div></div>
        ) : (
          <div className="pt-scroll">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>المندوب / الشركة</th>
                  <th>الايتمات</th>
                  <th className="num">تغطية المحافظة</th>
                  <th>الحصة</th>
                  <th className="num">الكمية</th>
                  <th className="num">طلبيات</th>
                  <th className="num">زبائن</th>
                  <th>صيدليات : مذاخر</th>
                  <th className="num">الجهد الشخصي</th>
                </tr>
              </thead>
              <tbody>
                {team.reps.map(rep => (
                  <RepRows key={rep.repUserId} rep={rep} teamNet={t.net} money={money} open={open} setOpen={setOpen} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>إجمالي المندوبين</td>
                  <td className="num">{money.usd(team.reps.reduce((s, r) => s + r.totalNet, 0))}</td>
                  <td />
                  <td className="num">{fmtInt(team.reps.reduce((s, r) => s + r.totalQty, 0))}</td>
                  <td colSpan={3} />
                  <td className="num">{money.usd(team.personalUSD)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {team.uncovered.length > 0 && (
        <div className="pt-panel">
          <div className="pt-panel__head">
            <div className="pt-panel__title">مبيعات غير منسوبة لأي مندوب</div>
            <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>ايتمات شركات الفريق التي بيعت في المحافظة ولم تُعيَّن لمندوب — تُعرض كي لا تضيع بصمت</span>
          </div>
          <div className="pt-panel__body pt-detail-grid">
            {team.uncovered.map(u => (
              <div key={u.companyId}>
                <h4>{u.companyName} — {money.usd(u.net)}</h4>
                <div className="pt-list">
                  {u.topItems.map(i => (
                    <div key={i.itemId ?? i.name} className="pt-list__row"><span>{i.name}</span><span>{money.usd(i.net)}</span></div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ tone, label, value, hint, title }: { tone: 'coverage' | 'personal' | 'alert'; label: string; value: string; hint?: string; title?: string }) {
  return (
    <div className={`pt-kpi pt-kpi--${tone}`} title={title}>
      <div className="pt-kpi__label">{label}</div>
      <div className="pt-kpi__value">{value}</div>
      {hint && <div className="pt-kpi__hint">{hint}</div>}
    </div>
  );
}

function RepRows({ rep, teamNet, money, open, setOpen }: {
  rep: RepRow; teamNet: number; money: Money; open: number | null; setOpen: (id: number | null) => void;
}) {
  const shared = rep.companies.length > 1;
  return (
    <>
      {shared && (
        <tr className="pt-row--rep">
          <td>
            <span className="pt-avatar" style={{ marginLeft: 8 }}>{initials(rep.repName)}</span>
            {rep.repName}
            <span className="pt-chip" style={{ marginRight: 8 }}>مشترك · {rep.companies.length} شركات</span>
          </td>
          <td />
          <td className="num">{money.usd(rep.totalNet)}</td>
          <td><ShareBar value={rep.totalNet} total={teamNet} /></td>
          <td className="num">{fmtInt(rep.totalQty)}</td>
          <td colSpan={3} />
          <td className="num" style={{ color: 'var(--c-success)' }}>{money.usd(rep.personalUSD)}</td>
        </tr>
      )}
      {rep.companies.map(c => (
        <CompanyRow key={c.assignmentId} rep={rep} c={c} shared={shared} teamNet={teamNet} money={money}
          isOpen={open === c.assignmentId} onToggle={() => setOpen(open === c.assignmentId ? null : c.assignmentId)} />
      ))}
    </>
  );
}

function CompanyRow({ rep, c, shared, teamNet, money, isOpen, onToggle }: {
  rep: RepRow; c: RepCompany; shared: boolean; teamNet: number; money: Money; isOpen: boolean; onToggle: () => void;
}) {
  const cov = c.coverage;
  const pharm = Math.max(0, cov.pharmacyNet), wh = Math.max(0, cov.warehouseNet);
  return (
    <Fragment>
      <tr className={`is-clickable ${shared ? 'pt-row--sub' : ''}`} onClick={onToggle} aria-expanded={isOpen}>
        <td>
          <span className={`pt-caret ${isOpen ? 'is-open' : ''}`}>‹</span>
          {!shared && <><span className="pt-avatar" style={{ marginLeft: 8 }}>{initials(rep.repName)}</span>{rep.repName} · </>}
          <span className="pt-chip pt-chip--accent">{c.companyName}</span>
          {!rep.repActive && <span className="pt-chip pt-chip--red" style={{ marginRight: 6 }}>حساب معطّل</span>}
        </td>
        <td>{c.allItems ? <span className="pt-chip">كل الايتمات ({c.itemCount})</span> : <span className="pt-chip">{c.itemCount} ايتم</span>}</td>
        <td className="num" title={money.usdFull(cov.net)}>{money.usd(cov.net)}</td>
        <td><ShareBar value={cov.net} total={teamNet} /></td>
        <td className="num">{fmtInt(cov.netQty)}</td>
        <td className="num">{fmtInt(cov.orders)}</td>
        <td className="num">{fmtInt(cov.customers)}</td>
        <td style={{ minWidth: 120 }}>
          <div className="pt-split__bar" title={`صيدليات ${money.usd(cov.pharmacyNet)} · مذاخر ${money.usd(cov.warehouseNet)}`}>
            <span className="pt-split__pharm" style={{ width: `${pct(pharm, pharm + wh)}%` }} />
            <span className="pt-split__wh" style={{ width: `${pct(wh, pharm + wh)}%` }} />
          </div>
        </td>
        <td className="num" style={{ color: 'var(--c-success)' }} title={`${c.personal.rows} سطر · ${c.personal.pharmacies} صيدلية`}>
          {c.personal.rows ? money.usd(c.personal.valueUSD) : '—'}
        </td>
      </tr>
      {isOpen && (
        <tr className="pt-row--detail">
          <td colSpan={9}>
            <div className="pt-detail-grid">
              <div>
                <h4>الايتمات</h4>
                <List rows={cov.byItem.map(i => ({ k: String(i.itemId ?? i.name), name: i.name, right: `${money.usd(i.net)} · ${fmtInt(i.qty)}` }))} empty="لا مبيعات لايتماته في هذا الشهر" />
              </div>
              <div>
                <h4>المناطق</h4>
                <List rows={cov.byArea.map(a => ({ k: a.name, name: a.name, right: money.usd(a.net) }))} empty="—" />
              </div>
              <div>
                <h4>أهم الزبائن</h4>
                <List rows={cov.topCustomers.map(x => ({
                  k: x.name,
                  name: <>{x.channel === 'warehouse' ? <Warehouse size={12} style={{ verticalAlign: -2, marginLeft: 4 }} /> : <Store size={12} style={{ verticalAlign: -2, marginLeft: 4 }} />}{x.name}</>,
                  right: money.usd(x.net),
                }))} empty="—" />
              </div>
              <div>
                <h4>الجهد الشخصي (معتمد)</h4>
                <div className="pt-list">
                  <div className="pt-list__row"><span>القيمة</span><span>{money.usd(c.personal.valueUSD)}</span></div>
                  <div className="pt-list__row"><span>الكمية</span><span>{fmtInt(c.personal.qty)}</span></div>
                  <div className="pt-list__row"><span>صيدليات باعها بنفسه</span><span>{fmtInt(c.personal.pharmacies)}</span></div>
                  <div className="pt-list__row">
                    <span>نسبته من التغطية</span>
                    <span>{cov.net > 0 ? `${Math.round((c.personal.valueUSD / cov.net) * 100)}%` : '—'}</span>
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ShareBar({ value, total }: { value: number; total: number }) {
  const p = pct(value, total);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="pt-bar" style={{ flex: 1 }}><span style={{ width: `${p}%` }} /></div>
      <span style={{ fontSize: 11, color: 'var(--c-text-muted)', minWidth: 30 }}>{Math.round(p)}%</span>
    </div>
  );
}

function List({ rows, empty }: { rows: { k: string; name: React.ReactNode; right: string }[]; empty: string }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{empty}</div>;
  return (
    <div className="pt-list">
      {rows.map(r => <div key={r.k} className="pt-list__row"><span>{r.name}</span><span>{r.right}</span></div>)}
    </div>
  );
}
