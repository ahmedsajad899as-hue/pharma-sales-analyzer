// ════════════════════════════════════════════════════════════════════════════
// ProvinceTeamsPage — «فرق المحافظات»: هيكلية مكاتب مثل النسق العلمي.
//
// المحافظة يديرها تيم ليدر مشترك بين شركات المكتب، وتحته مندوب علمي لكل شركة
// (وقد يعمل مندوب واحد لشركتين — يُحسب لكلٍّ منهما بايتماتها). لكل مندوب حسبتان
// تُعرضان جنباً إلى جنب ولا تُجمعان أبداً:
//   • تغطية المحافظة — كل مبيع ايتماته في محافظته (المكتب ← مذاخر/صيدليات).
//   • الجهد الشخصي   — ما باعه بنفسه، يُدخَل من التطبيق أو البوت ويعتمده القائد.
//
// الطبقات: بطاقات المحافظات ← تفصيل فريق (مندوب ← شركة ← ايتمات/مناطق/زبائن).
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin, Users, Warehouse, Store, ClipboardCheck, Network, RefreshCw, Info } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import MonthChips, { MONTH_ALL, type SalesMonth } from '../components/MonthChips';
import { api } from './province-teams/api';
import type { Overview, Team } from './province-teams/types';
import { makeMoney, fmtInt, pct, initials, MODE_LABEL, type DisplayCurrency, type Money } from './province-teams/format';
import TeamDetail from './province-teams/TeamDetail';
import PersonalTab from './province-teams/PersonalTab';
import StructureTab from './province-teams/StructureTab';
import './province-teams/province-teams.css';

type Tab = 'provinces' | 'personal' | 'structure';

interface Props { activeFileIds: number[] }

export default function ProvinceTeamsPage({ activeFileIds }: Props) {
  const { token, hasFeature } = useAuth();
  const [tab, setTab] = useState<Tab>('provinces');
  const [months, setMonths] = useState<{ list: SalesMonth[]; undated: number; loading: boolean }>({ list: [], undated: 0, loading: false });
  const [month, setMonth] = useState<string>('');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [personalTeamFilter, setPersonalTeamFilter] = useState<number | null>(null);
  const [currency, setCurrency] = useState<DisplayCurrency | null>(null);
  const fileKey = activeFileIds.join(',');

  // الأشهر من ملفات الحساب (أو ملفات المكتب لمن لا ملفات له) — الأحدث افتراضياً.
  useEffect(() => {
    if (!token) return;
    let dead = false;
    setMonths(m => ({ ...m, loading: true }));
    api<{ months: SalesMonth[]; undatedCount: number; latest: string | null }>(token, `/months?fileIds=${fileKey}`)
      .then(r => {
        if (dead) return;
        setMonths({ list: r.months, undated: r.undatedCount, loading: false });
        setMonth(prev => (prev && (prev === MONTH_ALL || r.months.some(m => m.ym === prev)) ? prev : (r.latest ?? MONTH_ALL)));
      })
      .catch(() => { if (!dead) { setMonths({ list: [], undated: 0, loading: false }); setMonth(m => m || MONTH_ALL); } });
    return () => { dead = true; };
  }, [token, fileKey]);

  const load = useCallback(async () => {
    if (!token || !month) return;
    setLoading(true); setErr(null);
    try {
      const r = await api<Overview & { success: boolean }>(token, `/overview?fileIds=${fileKey}&month=${encodeURIComponent(month)}`);
      setData(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, fileKey, month]);

  useEffect(() => { load(); }, [load]);

  const money: Money = useMemo(
    () => makeMoney(currency ?? data?.files.currency ?? 'IQD', data?.files.rate ?? 1470),
    [currency, data?.files.currency, data?.files.rate],
  );

  const viewer = data?.viewer;
  const teams = data?.teams ?? [];
  const selectedTeam = teams.find(t => t.id === selectedTeamId) ?? null;
  const pendingTotal = teams.reduce((s, t) => s + t.pendingPersonal, 0);
  const canStructure = !!viewer?.canEditStructure && hasFeature('province_teams_structure');
  const canPersonal = hasFeature('province_teams_personal');

  const openPersonalFor = (teamId: number | null) => { setPersonalTeamFilter(teamId); setTab('personal'); };

  return (
    <div className="page-container" dir="rtl">
      <div className="pt-page">
        {/* شريط الأدوات: الشهر + العملة + مصدر الأرقام */}
        <div className="pt-toolbar">
          <MonthChips months={months.list} undatedCount={months.undated} value={month} onChange={setMonth} loading={months.loading} hideWhenEmpty={false} />
          <span className="pt-toolbar__spacer" />
          <div className="pt-segment" role="group" aria-label="عملة العرض">
            {(['IQD', 'USD'] as DisplayCurrency[]).map(c => (
              <button key={c} className={(currency ?? data?.files.currency ?? 'IQD') === c ? 'is-active' : ''} onClick={() => setCurrency(c)}>
                {c === 'IQD' ? 'دينار' : 'دولار'}
              </button>
            ))}
          </div>
          <button className="btn btn--secondary btn--sm" onClick={load} disabled={loading} title="تحديث">
            <RefreshCw size={14} className={loading ? 'icon-spin' : ''} />
          </button>
        </div>

        {data && (
          <div className="pt-toolbar__meta" style={{ marginTop: -8 }}>
            <Info size={13} />
            <span>
              {MODE_LABEL[data.viewer.mode]} · الأرقام من {data.files.source}
              {data.files.count ? ` (${data.files.count} ملف)` : ''}
              {data.files.excludedMercato ? ` · استُبعد ${data.files.excludedMercato} ملف ميركاتو (بيع المذاخر لا يُحسب تغطية)` : ''}
            </span>
          </div>
        )}

        <div className="pt-tabs" role="tablist">
          <button className={`pt-tab ${tab === 'provinces' ? 'is-active' : ''}`} onClick={() => setTab('provinces')} role="tab">
            <MapPin size={16} /> المحافظات
            {teams.length > 0 && <span className="pt-count pt-count--muted">{teams.length}</span>}
          </button>
          {canPersonal && (
            <button className={`pt-tab ${tab === 'personal' ? 'is-active' : ''}`} onClick={() => openPersonalFor(null)} role="tab">
              <ClipboardCheck size={16} /> الجهد الشخصي
              {pendingTotal > 0 && <span className="pt-count" title="بانتظار اعتمادك">{pendingTotal}</span>}
            </button>
          )}
          {canStructure && (
            <button className={`pt-tab ${tab === 'structure' ? 'is-active' : ''}`} onClick={() => setTab('structure')} role="tab">
              <Network size={16} /> الهيكلية
            </button>
          )}
        </div>

        {err && <div className="pt-note pt-note--warn">⚠️ {err}</div>}

        {tab === 'provinces' && (
          selectedTeam && viewer ? (
            <TeamDetail
              team={selectedTeam}
              viewer={viewer}
              money={money}
              onBack={() => setSelectedTeamId(null)}
              onOpenPersonal={canPersonal ? () => openPersonalFor(selectedTeam.id) : undefined}
            />
          ) : (
            <ProvinceGrid
              loading={loading && !data}
              teams={teams}
              provinces={data?.provinces ?? []}
              money={money}
              hasOffice={viewer?.hasOffice ?? true}
              canStructure={canStructure}
              onOpen={setSelectedTeamId}
              onSetup={() => setTab('structure')}
            />
          )
        )}

        {tab === 'personal' && viewer && canPersonal && (
          <PersonalTab
            token={token}
            viewer={viewer}
            teams={teams}
            month={month}
            money={money}
            teamFilter={personalTeamFilter}
            onTeamFilter={setPersonalTeamFilter}
            onChanged={load}
          />
        )}

        {tab === 'structure' && canStructure && (
          <StructureTab token={token} teams={teams} onChanged={load} />
        )}
      </div>
    </div>
  );
}

// ─── شبكة بطاقات المحافظات ───────────────────────────────────────────────────

function ProvinceGrid({ loading, teams, provinces, money, hasOffice, canStructure, onOpen, onSetup }: {
  loading: boolean; teams: Team[]; provinces: { id: number; name: string }[]; money: Money; hasOffice: boolean; canStructure: boolean;
  onOpen: (id: number) => void; onSetup: () => void;
}) {
  if (loading) {
    return <div className="pt-grid">{[0, 1, 2].map(i => <div key={i} className="pt-skeleton" style={{ height: 230 }} />)}</div>;
  }
  if (!teams.length && !provinces.length) {
    return (
      <div className="pt-panel">
        <div className="pt-empty">
          <div className="pt-empty__icon"><MapPin size={26} /></div>
          <div className="pt-empty__title">لا توجد فرق محافظات بعد</div>
          <div style={{ maxWidth: 520, lineHeight: 1.8, fontSize: 13 }}>
            {!hasOffice
              ? 'هذا الحساب غير مرتبط بمكتب علمي.'
              : canStructure
                ? 'ابدأ من «الهيكلية»: أنشئ فريقاً لكل محافظة، عيّن تيم ليدر المحافظة، ثم أضف المندوبين مع شركة كل منهم وايتماتها.'
                : 'لم تُعيَّن بعد في أي فريق محافظة. تتولّى إدارة المكتب بناء الهيكلية.'}
          </div>
          {canStructure && <button className="btn btn--primary" onClick={onSetup}>بناء الهيكلية</button>}
        </div>
      </div>
    );
  }

  const max = Math.max(...teams.map(t => t.totals.net), 1);
  const withTeam = new Set(teams.map(t => t.provinceId));
  const empty = provinces.filter(p => !withTeam.has(p.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    {!teams.length && (
      <div className="pt-note">
        <span>🧭</span>
        <span>
          لم يُنشأ أي فريق محافظة بعد. اختر محافظة من القائمة أدناه (أو من «الهيكلية») لتعيين تيم ليدرها ومندوبيها. تظهر الأرقام هنا بعد إضافة المندوبين وايتماتهم.
        </span>
      </div>
    )}
    <div className="pt-grid">
      {teams.map(t => {
        const pharm = Math.max(0, t.totals.pharmacyNet);
        const wh = Math.max(0, t.totals.warehouseNet);
        const base = pharm + wh;
        return (
          <button key={t.id} className="pt-card" onClick={() => onOpen(t.id)}>
            <div className="pt-card__head">
              <div>
                <div className="pt-card__title">{t.provinceName}</div>
                <div className="pt-card__sub">
                  <span className={`pt-avatar ${t.leaderName ? '' : 'pt-avatar--muted'}`}>{t.leaderName ? initials(t.leaderName) : '؟'}</span>
                  {t.leaderName ? `تيم ليدر: ${t.leaderName}` : 'بلا تيم ليدر'}
                </div>
              </div>
              <span className="pt-chip"><Users size={11} style={{ verticalAlign: -1 }} /> {t.reps.length} مندوب</span>
            </div>

            <div className="pt-chips">
              {t.companies.map(c => <span key={c.id} className="pt-chip pt-chip--accent">{c.name}</span>)}
              {t.pendingPersonal > 0 && <span className="pt-chip pt-chip--red">{t.pendingPersonal} بانتظار الاعتماد</span>}
            </div>

            <div className="pt-mini">
              <div className="pt-mini__item" title={money.usdFull(t.totals.net)}>
                <div className="pt-mini__label">تغطية المحافظة</div>
                <div className="pt-mini__value">{money.usd(t.totals.net)}</div>
              </div>
              <div className="pt-mini__item" title={money.usdFull(t.personalUSD)}>
                <div className="pt-mini__label">الجهد الشخصي (معتمد)</div>
                <div className="pt-mini__value pt-mini__value--green">{money.usd(t.personalUSD)}</div>
              </div>
            </div>

            <div className="pt-split">
              <div className="pt-split__bar" aria-hidden>
                <span className="pt-split__pharm" style={{ width: `${pct(pharm, base)}%` }} />
                <span className="pt-split__wh" style={{ width: `${pct(wh, base)}%` }} />
              </div>
              <div className="pt-split__legend">
                <span><Store size={11} style={{ verticalAlign: -1 }} /> صيدليات {money.usd(t.totals.pharmacyNet)}</span>
                <span><Warehouse size={11} style={{ verticalAlign: -1 }} /> مذاخر {money.usd(t.totals.warehouseNet)}</span>
              </div>
            </div>

            <div className="pt-split">
              <div className="pt-bar"><span style={{ width: `${pct(t.totals.net, max)}%` }} /></div>
              <div className="pt-split__legend">
                <span>{fmtInt(t.totals.orders)} طلبية · {fmtInt(t.totals.customers)} زبون</span>
                {t.uncovered.length > 0 && <span style={{ color: 'var(--c-danger)' }}>مبيعات غير منسوبة</span>}
              </div>
            </div>
          </button>
        );
      })}
    </div>
    {empty.length > 0 && (
      <div className="pt-panel">
        <div className="pt-panel__head">
          <div className="pt-panel__title">محافظات بلا فريق</div>
          <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{empty.length} محافظة</span>
        </div>
        <div className="pt-panel__body">
          <div className="pt-chips">
            {empty.map(p => (
              canStructure
                ? <button key={p.id} className="pt-chip" style={{ cursor: 'pointer', borderStyle: 'dashed' }} onClick={onSetup} title="إنشاء فريق هذه المحافظة">{p.name}</button>
                : <span key={p.id} className="pt-chip">{p.name}</span>
            ))}
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
