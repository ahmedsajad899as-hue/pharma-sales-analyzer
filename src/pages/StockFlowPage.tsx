/**
 * صفحة «تحريك المذاخر» — دورة شهرية لكل مذخر: كم تحرّك فعلاً، وكيف توزّع.
 *
 *   الكمية المتحركة = الستوك الافتتاحي + التعزيز − الستوك الثانوي
 *   مباشر (مذخر)     = المتحركة − مبيع التجاري − مبيع العلمي
 *
 * التعزيز يُشتق تلقائياً من حركات «تعزيز» المسجّلة أصلاً في صفحة رصيد المذاخر
 * (لا إدخال مكرَّر). مبيع التجاري والعلمي يُرفعان هنا بملف Excel مستقل لكل
 * فريق (مذخر + كمية)، والافتتاحي/الثانوي يُدخَلان هنا كنقطتي عدّ بتاريخ حر.
 *
 * صفحة مستقلة تماماً عن «رصيد المذاخر» (لا تعديل عليها) — نفس الهوية البصرية
 * (App.css، فئات sl-*) ونفس هوية المذخر (StockWarehouse) ونفس دفتر المكتب
 * المشترك، لكن حساب ومسار بيانات مختلفَين بالكامل.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Icon } from '../config/icons';
import type { IconName } from '../config/icons';
import { useAuth } from '../context/AuthContext';
import StockMovementImportModal, { isPendingEmpty } from '../components/StockMovementImportModal';
import type { PendingMatches, StockNameChoices } from '../components/StockMovementImportModal';

const API = import.meta.env.VITE_API_URL || '';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ── الأنواع ────────────────────────────────────────────────────
interface Warehouse { id: number; name: string; region: string }
type Team = 'commercial' | 'scientific';

interface Cycle {
  warehouseId: number; warehouse: string; region: string;
  openId: number; openDate: string; opening: number;
  closeId: number; closeDate: string; closing: number;
  reinforcement: number; movedQty: number;
  commercialQty: number; scientificQty: number; directQty: number;
}
interface OpenCycle {
  warehouseId: number; warehouse: string; region: string;
  openId: number; openDate: string; opening: number; reinforcementSoFar: number;
}
interface TeamSaleRow {
  id: number; warehouseId: number; warehouse: string; region: string;
  asOfDate: string; team: Team; qty: number; sourceLabel: string | null;
  uploadedAt: string; linked: boolean;
}
interface CyclesData {
  cycles: Cycle[]; openCycles: OpenCycle[];
  unlinkedTeamSales: TeamSaleRow[]; teamSales: TeamSaleRow[];
}
interface StockCountRow { id: number; warehouseId: number; countDate: string; qty: number; note: string | null }

const TEAM_META: Record<Team, { label: string; color: string; icon: IconName }> = {
  commercial: { label: 'تجاري', color: 'var(--c-accent)', icon: 'money' },
  scientific: { label: 'علمي', color: 'var(--c-success)', icon: 'drug' },
};
const DIRECT_COLOR = 'var(--c-text-muted)';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtNum = (n: number) => Math.round(Number(n) || 0).toLocaleString('en');
const fmtDate = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};
const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

export default function StockFlowPage() {
  const { hasFeature } = useAuth();
  const [tab, setTab] = useState<'cycles' | 'counts' | 'teams'>('cycles');

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [data, setData] = useState<CyclesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 6000); };

  const loadWarehouses = useCallback(async () => {
    const r = await fetch(`${API}/api/stock-ledger/warehouses`, { headers: authHeaders() });
    const j = await r.json();
    if (j.success) setWarehouses(j.data.warehouses);
  }, []);

  const loadCycles = useCallback(async () => {
    const r = await fetch(`${API}/api/stock-flow/cycles`, { headers: authHeaders() });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'تعذّر تحميل الدورات');
    setData(j.data);
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true); setErr('');
    try { await Promise.all([loadWarehouses(), loadCycles()]); }
    catch (e: any) { setErr(e.message || 'تعذّر تحميل البيانات'); }
    finally { setLoading(false); }
  }, [loadWarehouses, loadCycles]);

  useEffect(() => { reloadAll(); }, [reloadAll]);

  const kpis = useMemo(() => {
    const cycles = data?.cycles ?? [];
    const warehouseIds = new Set(cycles.map(c => c.warehouseId));
    const moved = cycles.reduce((s, c) => s + Math.max(0, c.movedQty), 0);
    const commercial = cycles.reduce((s, c) => s + c.commercialQty, 0);
    const scientific = cycles.reduce((s, c) => s + c.scientificQty, 0);
    const direct = cycles.reduce((s, c) => s + c.directQty, 0);
    return { warehouses: warehouseIds.size, cycles: cycles.length, moved, commercial, scientific, direct };
  }, [data]);

  const TABS: { id: 'cycles' | 'counts' | 'teams'; label: string; icon: IconName; count?: number }[] = [
    { id: 'cycles', label: 'الدورات', icon: 'netBalance', count: data?.cycles.length ?? 0 },
    { id: 'counts', label: 'نقاط الستوك', icon: 'calendar' },
    { id: 'teams', label: 'مبيعات الفرق', icon: 'transfer', count: data?.unlinkedTeamSales.length ?? 0 },
  ];

  return (
    <div className="sl-page" dir="rtl">
      {err && <div className="alert alert--error sl-alert"><Icon name="warning" size={14} /> {err}</div>}
      {msg && <div className="alert alert--success sl-alert"><Icon name="check" size={14} /> {msg}</div>}

      {/* ── شريط المؤشرات ── */}
      <div className="sl-kpis">
        <Kpi label="مذاخر لها دورات" value={fmtNum(kpis.warehouses)} />
        <Kpi label="دورات مكتملة" value={fmtNum(kpis.cycles)} />
        <Kpi label="إجمالي المتحرك" value={fmtNum(kpis.moved)} />
        <SplitKpi label="تجاري" value={kpis.commercial} pctOf={kpis.moved} color={TEAM_META.commercial.color} />
        <SplitKpi label="علمي" value={kpis.scientific} pctOf={kpis.moved} color={TEAM_META.scientific.color} />
        <SplitKpi label="مباشر" value={kpis.direct} pctOf={kpis.moved} color={DIRECT_COLOR} />
        <div className="sl-kpis-note">المتحركة = الافتتاحي + التعزيز − الثانوي · التعزيز من حركات «رصيد المذاخر» تلقائياً</div>
      </div>

      {/* ── التبويبات + التحديث ── */}
      <div className="sl-bar">
        <div className="tabs">
          {TABS.map(t => (
            <button key={t.id} className={`tab ${tab === t.id ? 'tab--active' : ''}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={14} /> {t.label}
              {!!t.count && <span className="sl-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>
        <button className="btn btn--secondary btn--sm" onClick={reloadAll} disabled={loading} title="إعادة تحميل الدورات">
          <Icon name="refresh" size={13} className={loading ? 'sl-spin' : undefined} /> تحديث
        </button>
      </div>

      {loading && <div className="sl-empty">جارٍ التحميل…</div>}

      {!loading && tab === 'cycles' && (
        <CyclesTab
          data={data} warehouses={warehouses}
          canExport={hasFeature('stock_flow_export')}
          onGoToTeams={() => setTab('teams')}
        />
      )}
      {!loading && tab === 'counts' && (
        <CountsTab
          warehouses={warehouses}
          canEdit={hasFeature('stock_flow_counts')}
          canDelete={hasFeature('stock_flow_delete')}
          flash={flash} setErr={setErr} reloadAll={reloadAll}
        />
      )}
      {!loading && tab === 'teams' && (
        <TeamsTab
          data={data} warehouses={warehouses}
          canUpload={hasFeature('stock_flow_team_upload')}
          canDelete={hasFeature('stock_flow_delete')}
          flash={flash} setErr={setErr} reloadAll={reloadAll}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="sl-kpi">
      <div className={`sl-kpi-value${danger ? ' sl-kpi-value--danger' : ''}`}>{value}</div>
      <div className="sl-kpi-label">{label}</div>
    </div>
  );
}

/** مؤشر حصة فريق من إجمالي المتحرك — رقم + نسبة% بلون الفريق */
function SplitKpi({ label, value, pctOf, color }: { label: string; value: number; pctOf: number; color: string }) {
  return (
    <div className="sl-kpi">
      <div className="sl-kpi-value" style={{ color }}>{fmtNum(value)}</div>
      <div className="sl-kpi-label">{label} ({pct(value, pctOf)}%)</div>
    </div>
  );
}

/** شريط توزيع أفقي مصغّر — ثلاث شرائح بنسب تجاري/علمي/مباشر من الكمية المتحركة */
function SplitBar({ commercial, scientific, direct }: { commercial: number; scientific: number; direct: number }) {
  const total = Math.max(0, commercial) + Math.max(0, scientific) + Math.max(0, direct);
  if (total <= 0) return <span style={{ color: 'var(--c-text-secondary)' }}>—</span>;
  const segs: { qty: number; color: string }[] = [
    { qty: Math.max(0, commercial), color: TEAM_META.commercial.color },
    { qty: Math.max(0, scientific), color: TEAM_META.scientific.color },
    { qty: Math.max(0, direct), color: DIRECT_COLOR },
  ];
  return (
    <span className="sl-pct-track" style={{ display: 'inline-flex', overflow: 'hidden' }}>
      {segs.map((s, i) => s.qty > 0 && (
        <span key={i} style={{ display: 'inline-block', height: '100%', width: `${(s.qty / total) * 100}%`, background: s.color }} />
      ))}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب الدورات
// ═══════════════════════════════════════════════════════════════
function CyclesTab(p: {
  data: CyclesData | null; warehouses: Warehouse[]; canExport: boolean; onGoToTeams: () => void;
}) {
  const [fRegion, setFRegion] = useState('all');
  const [fWarehouse, setFWarehouse] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<Cycle | null>(null);

  const cycles = p.data?.cycles ?? [];
  const openCycles = p.data?.openCycles ?? [];
  const regions = useMemo(() => [...new Set(cycles.map(c => c.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar')), [cycles]);

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return cycles.filter(c => {
      if (fRegion !== 'all' && c.region !== fRegion) return false;
      if (fWarehouse !== 'all' && c.warehouseId !== fWarehouse) return false;
      if (terms.length) {
        const hay = `${c.warehouse} ${c.region}`.toLowerCase();
        if (!terms.every(t => hay.includes(t))) return false;
      }
      return true;
    });
  }, [cycles, fRegion, fWarehouse, search]);

  const exportXlsx = () => {
    const rows = filtered.map(c => ({
      'المنطقة': c.region, 'المذخر': c.warehouse,
      'تاريخ الافتتاحي': fmtDate(c.openDate), 'الافتتاحي': c.opening,
      'تعزيز': c.reinforcement,
      'تاريخ الثانوي': fmtDate(c.closeDate), 'الثانوي': c.closing,
      'الكمية المتحركة': c.movedQty,
      'تجاري': c.commercialQty, 'علمي': c.scientificQty, 'مباشر (مذخر)': c.directQty,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, 'دورات المذاخر');
    XLSX.writeFile(wb, `stock_flow_cycles_${todayISO()}.xlsx`);
  };

  return (
    <>
      <div className="sl-filters">
        <div className="sl-field sl-field--grow">
          <label className="sl-label">بحث</label>
          <input className="form-input sl-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="مذخر أو منطقة…" />
        </div>
        <div className="sl-field">
          <label className="sl-label">المنطقة</label>
          <select className="form-input sl-input" value={fRegion} onChange={e => { setFRegion(e.target.value); setFWarehouse('all'); }}>
            <option value="all">الكل</option>
            {regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="sl-field">
          <label className="sl-label">المذخر</label>
          <select className="form-input sl-input" value={String(fWarehouse)} onChange={e => setFWarehouse(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">الكل</option>
            {p.warehouses.filter(w => fRegion === 'all' || w.region === fRegion).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        {p.canExport && (
          <div className="sl-actions">
            <button className="btn btn--secondary btn--sm" onClick={exportXlsx} disabled={!filtered.length} title="تصدير الدورات إلى Excel">
              <Icon name="export" size={13} /> تصدير
            </button>
          </div>
        )}
      </div>

      {(p.data?.unlinkedTeamSales.length ?? 0) > 0 && (
        <div className="alert alert--error sl-alert" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span><Icon name="warning" size={14} /> {p.data!.unlinkedTeamSales.length} صف مبيعات فريق مرفوع لتاريخ لا يطابق أي دورة مغلقة بعد — تأكد من إدخال الستوك الثانوي لنفس التاريخ.</span>
          <button className="btn btn--secondary btn--sm" onClick={p.onGoToTeams}>عرض</button>
        </div>
      )}

      {!filtered.length ? (
        <div className="sl-empty">
          {cycles.length ? 'لا توجد دورات مطابقة للفلاتر الحالية.' : 'لا توجد دورات مكتملة بعد — أدخل نقطتي عدّ متتاليتين (افتتاحي وثانوي) لأي مذخر من تبويب «نقاط الستوك».'}
        </div>
      ) : (
        <div className="table-wrapper sl-table-wrap">
          <table className="data-table sl-table">
            <thead>
              <tr>
                <th>المنطقة</th><th>المذخر</th>
                <th>الافتتاحي</th><th>تعزيز</th><th>الثانوي</th><th>المتحركة</th>
                <th>تجاري</th><th>علمي</th><th>مباشر</th><th>التوزيع</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={i} className="sl-row" onClick={() => setDetail(c)} title="عرض تفاصيل الدورة">
                  <td className="sl-dim">{c.region}</td>
                  <td className="sl-strong">{c.warehouse}</td>
                  <td>{fmtNum(c.opening)}<div className="sl-dim" style={{ fontSize: 11 }}>{fmtDate(c.openDate)}</div></td>
                  <td className={c.reinforcement ? 'sl-in' : 'sl-dim'}>{fmtNum(c.reinforcement)}</td>
                  <td>{fmtNum(c.closing)}<div className="sl-dim" style={{ fontSize: 11 }}>{fmtDate(c.closeDate)}</div></td>
                  <td className="sl-strong">{fmtNum(c.movedQty)}</td>
                  <td style={{ color: TEAM_META.commercial.color }}>{fmtNum(c.commercialQty)}</td>
                  <td style={{ color: TEAM_META.scientific.color }}>{fmtNum(c.scientificQty)}</td>
                  <td style={{ color: DIRECT_COLOR }}>{fmtNum(c.directQty)}</td>
                  <td style={{ minWidth: 90 }}><SplitBar commercial={c.commercialQty} scientific={c.scientificQty} direct={c.directQty} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCycles.length > 0 && (
        <div className="sl-parent-companies" style={{ marginTop: 16 }}>
          <div className="sl-label sl-parent-companies-label"><Icon name="history" size={11} /> دورات قيد التقدم — بانتظار الستوك الثانوي ({openCycles.length})</div>
          <div className="table-wrapper sl-table-wrap">
            <table className="data-table sl-table">
              <thead><tr><th>المنطقة</th><th>المذخر</th><th>تاريخ الافتتاحي</th><th>الافتتاحي</th><th>تعزيز حتى الآن</th></tr></thead>
              <tbody>
                {openCycles.map((o, i) => (
                  <tr key={i}>
                    <td className="sl-dim">{o.region}</td>
                    <td className="sl-strong">{o.warehouse}</td>
                    <td className="sl-dim">{fmtDate(o.openDate)}</td>
                    <td>{fmtNum(o.opening)}</td>
                    <td className={o.reinforcementSoFar ? 'sl-in' : 'sl-dim'}>{fmtNum(o.reinforcementSoFar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {detail && <CycleDetailModal cycle={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function CycleDetailModal({ cycle: c, onClose }: { cycle: Cycle; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ fontWeight: 700 }}>{c.warehouse}</div>
            <div className="sl-hint">{c.region} — {fmtDate(c.openDate)} → {fmtDate(c.closeDate)}</div>
          </div>
          <button className="btn-icon btn-icon--red" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="sl-kpis sl-kpis--modal">
            <Kpi label="الافتتاحي" value={fmtNum(c.opening)} />
            <Kpi label="تعزيز" value={fmtNum(c.reinforcement)} />
            <Kpi label="الثانوي" value={fmtNum(c.closing)} />
            <Kpi label="المتحركة" value={fmtNum(c.movedQty)} />
          </div>
          <div style={{ margin: '18px 0 10px' }}>
            <div className="sl-hint" style={{ marginBottom: 6 }}>توزيع الكمية المتحركة</div>
            <SplitBar commercial={c.commercialQty} scientific={c.scientificQty} direct={c.directQty} />
          </div>
          <div className="table-wrapper sl-table-wrap">
            <table className="data-table sl-table">
              <thead><tr><th>الجهة</th><th>الكمية</th><th>النسبة</th></tr></thead>
              <tbody>
                <tr>
                  <td><span style={{ color: TEAM_META.commercial.color }}><Icon name={TEAM_META.commercial.icon} size={13} /> تجاري</span></td>
                  <td className="sl-strong">{fmtNum(c.commercialQty)}</td>
                  <td className="sl-dim">{pct(c.commercialQty, c.movedQty)}%</td>
                </tr>
                <tr>
                  <td><span style={{ color: TEAM_META.scientific.color }}><Icon name={TEAM_META.scientific.icon} size={13} /> علمي</span></td>
                  <td className="sl-strong">{fmtNum(c.scientificQty)}</td>
                  <td className="sl-dim">{pct(c.scientificQty, c.movedQty)}%</td>
                </tr>
                <tr>
                  <td><span style={{ color: DIRECT_COLOR }}><Icon name="pharmacy" size={13} /> مباشر (المذخر)</span></td>
                  <td className="sl-strong">{fmtNum(c.directQty)}</td>
                  <td className="sl-dim">{pct(c.directQty, c.movedQty)}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          {c.directQty < 0 && (
            <div className="alert alert--error sl-alert" style={{ marginTop: 10 }}>
              <Icon name="warning" size={14} /> مباشر سالب — مجموع تجاري + علمي أكبر من الكمية المتحركة، راجع الأرقام المُدخلة لهذه الدورة.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب نقاط الستوك (الافتتاحي/الثانوي)
// ═══════════════════════════════════════════════════════════════
function CountsTab(p: {
  warehouses: Warehouse[]; canEdit: boolean; canDelete: boolean;
  flash: (t: string) => void; setErr: (t: string) => void; reloadAll: () => Promise<void>;
}) {
  const [warehouseId, setWarehouseId] = useState<number | ''>('');
  const [countDate, setCountDate] = useState(todayISO());
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<StockCountRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = useCallback(async (whId: number) => {
    setHistoryLoading(true);
    try {
      const r = await fetch(`${API}/api/stock-flow/counts?warehouseId=${whId}`, { headers: authHeaders() });
      const j = await r.json();
      setHistory(j.success ? j.data : []);
    } finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => { if (warehouseId) loadHistory(warehouseId); else setHistory([]); }, [warehouseId, loadHistory]);

  const submit = async () => {
    if (!warehouseId) { p.setErr('اختر مذخر'); return; }
    const q = Number(qty);
    if (!(q >= 0)) { p.setErr('أدخل كمية صالحة'); return; }
    setBusy(true); p.setErr('');
    try {
      const r = await fetch(`${API}/api/stock-flow/counts`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId, countDate, qty: q, note: note || undefined }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      p.flash('حُفظت نقطة الستوك');
      setQty(''); setNote('');
      await Promise.all([loadHistory(warehouseId), p.reloadAll()]);
    } catch (e: any) { p.setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('حذف نقطة الستوك هذه؟ ستُعاد حسبة الدورات المرتبطة بها.')) return;
    try {
      const r = await fetch(`${API}/api/stock-flow/counts/${id}`, { method: 'DELETE', headers: authHeaders() });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحذف');
      p.flash('حُذفت نقطة الستوك');
      if (warehouseId) await loadHistory(warehouseId);
      await p.reloadAll();
    } catch (e: any) { p.setErr(e.message); }
  };

  return (
    <>
      <div className="sl-hint sl-hint--block">
        أدخل نقطة عدّ (كامل ستوك المذخر لكل الايتمات) عند بداية كل شهر. كل نقطتين متتاليتين لنفس المذخر تشكّلان دورة تُحسب تلقائياً في تبويب «الدورات».
      </div>

      {p.canEdit && (
        <div className="table-wrapper sl-table-wrap" style={{ padding: 14, marginBottom: 16 }}>
          <div className="sl-toolbar-row" style={{ flexWrap: 'wrap' }}>
            <div className="sl-field">
              <label className="sl-label">المذخر</label>
              <select className="form-input sl-input" value={warehouseId} onChange={e => setWarehouseId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">اختر مذخر…</option>
                {p.warehouses.map(w => <option key={w.id} value={w.id}>{w.name} — {w.region}</option>)}
              </select>
            </div>
            <div className="sl-field sl-field--sm">
              <label className="sl-label">تاريخ العدّ</label>
              <input className="form-input sl-input" type="date" value={countDate} onChange={e => setCountDate(e.target.value)} />
            </div>
            <div className="sl-field sl-field--sm">
              <label className="sl-label">الكمية</label>
              <input className="form-input sl-input" type="number" min={0} value={qty} onChange={e => setQty(e.target.value)} placeholder="إجمالي الستوك" />
            </div>
            <div className="sl-field sl-field--grow">
              <label className="sl-label">ملاحظة (اختياري)</label>
              <input className="form-input sl-input" value={note} onChange={e => setNote(e.target.value)} placeholder="مثال: عدّ بداية سبتمبر" />
            </div>
            <button className="btn btn--primary btn--sm" onClick={submit} disabled={busy} style={{ alignSelf: 'flex-end' }}>
              <Icon name={busy ? 'refresh' : 'add'} size={13} className={busy ? 'sl-spin' : undefined} /> حفظ
            </button>
          </div>
        </div>
      )}

      {warehouseId ? (
        historyLoading ? <div className="sl-empty">جارٍ التحميل…</div> : !history.length ? (
          <div className="sl-empty">لا توجد نقاط ستوك مسجَّلة لهذا المذخر بعد.</div>
        ) : (
          <div className="table-wrapper sl-table-wrap">
            <table className="data-table sl-table">
              <thead><tr><th>التاريخ</th><th>الكمية</th><th>ملاحظة</th>{p.canDelete && <th></th>}</tr></thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id}>
                    <td className="sl-strong">{fmtDate(h.countDate)}</td>
                    <td>{fmtNum(h.qty)}</td>
                    <td className="sl-dim">{h.note || '—'}</td>
                    {p.canDelete && (
                      <td>
                        <button className="btn-icon btn-icon--red" onClick={() => remove(h.id)} title="حذف">
                          <Icon name="delete" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="sl-empty">اختر مذخر لعرض نقاط الستوك المسجَّلة له.</div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب مبيعات الفرق (تجاري/علمي)
// ═══════════════════════════════════════════════════════════════
function TeamsTab(p: {
  data: CyclesData | null; warehouses: Warehouse[]; canUpload: boolean; canDelete: boolean;
  flash: (t: string) => void; setErr: (t: string) => void; reloadAll: () => Promise<void>;
}) {
  const [team, setTeam] = useState<Team>('commercial');
  const [asOfDate, setAsOfDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ pending: PendingMatches; rows: { warehouse: string; qty: number }[]; fileName: string } | null>(null);

  // إدخال يدوي سريع
  const [mWarehouse, setMWarehouse] = useState<number | ''>('');
  const [mQty, setMQty] = useState('');

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); p.setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('team', team);
      const r = await fetch(`${API}/api/stock-flow/team-sales/extract`, { method: 'POST', headers: authHeaders(), body: fd });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل رفع الملف');
      const { rows, pending, fileName } = j.data;
      if (isPendingEmpty(pending)) await commit(rows, fileName, { warehouseChoices: [], itemChoices: [], companyChoices: [] });
      else { setReview({ pending, rows, fileName }); setBusy(false); }
    } catch (e: any) { p.setErr(e.message); setBusy(false); }
  };

  const commit = async (rows: { warehouse: string; qty: number }[], fileName: string, choices: StockNameChoices) => {
    setBusy(true); p.setErr('');
    try {
      const r = await fetch(`${API}/api/stock-flow/team-sales/commit`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ team, asOfDate, rows, fileName, ...choices }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      const u = j.data?.unmatched;
      const notes: string[] = [];
      if (u?.created?.length) notes.push(`${u.created.length} مذخر جديد`);
      if (u?.fuzzyLinked?.length) notes.push(`${u.fuzzyLinked.length} رُبط بالتشابه`);
      p.flash(`حُفظت ${j.data?.saved ?? 0} مذخر${notes.length ? ' — ' + notes.join('، ') : ''}`);
      setReview(null);
      await p.reloadAll();
    } catch (e: any) { p.setErr(e.message); }
    finally { setBusy(false); }
  };

  const manualAdd = async () => {
    if (!mWarehouse) { p.setErr('اختر مذخر'); return; }
    const q = Number(mQty);
    if (!(q >= 0)) { p.setErr('أدخل كمية صالحة'); return; }
    setBusy(true); p.setErr('');
    try {
      const r = await fetch(`${API}/api/stock-flow/team-sales/manual`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ team, asOfDate, warehouseId: mWarehouse, qty: q }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحفظ');
      p.flash('حُفظت الكمية');
      setMQty('');
      await p.reloadAll();
    } catch (e: any) { p.setErr(e.message); }
    finally { setBusy(false); }
  };

  const removeRow = async (id: number) => {
    if (!confirm('حذف هذا الصف؟')) return;
    try {
      const r = await fetch(`${API}/api/stock-flow/team-sales/${id}`, { method: 'DELETE', headers: authHeaders() });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحذف');
      p.flash('حُذف الصف');
      await p.reloadAll();
    } catch (e: any) { p.setErr(e.message); }
  };

  const rows = p.data?.teamSales ?? [];

  return (
    <>
      <div className="sl-hint sl-hint--block">
        ملف Excel بعمودين: المذخر والكمية — رقم إجمالي واحد لكل مذخر عن الدورة المنتهية بالتاريخ المحدّد. التاريخ يجب أن يطابق تاريخ الستوك الثانوي لنفس الدورة في تبويب «نقاط الستوك».
      </div>

      {p.canUpload && (
        <div className="table-wrapper sl-table-wrap" style={{ padding: 14, marginBottom: 16 }}>
          <div className="sl-toolbar-row" style={{ flexWrap: 'wrap' }}>
            <div className="sl-field sl-field--sm">
              <label className="sl-label">الفريق</label>
              <select className="form-input sl-input" value={team} onChange={e => setTeam(e.target.value as Team)}>
                <option value="commercial">تجاري (المسوقين)</option>
                <option value="scientific">علمي</option>
              </select>
            </div>
            <div className="sl-field sl-field--sm">
              <label className="sl-label">تاريخ نهاية الدورة</label>
              <input className="form-input sl-input" type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} />
            </div>
            <div className="sl-field">
              <label className="sl-label">رفع ملف Excel (مذخر + كمية)</label>
              <input className="form-input sl-input" type="file" accept=".xlsx,.xls,.csv" onChange={onFile} disabled={busy} />
            </div>
          </div>

          <div className="sl-toolbar-divider" />

          <div className="sl-toolbar-row" style={{ flexWrap: 'wrap' }}>
            <div className="sl-field">
              <label className="sl-label">أو إدخال يدوي — مذخر واحد</label>
              <select className="form-input sl-input" value={mWarehouse} onChange={e => setMWarehouse(e.target.value ? Number(e.target.value) : '')}>
                <option value="">اختر مذخر…</option>
                {p.warehouses.map(w => <option key={w.id} value={w.id}>{w.name} — {w.region}</option>)}
              </select>
            </div>
            <div className="sl-field sl-field--sm">
              <label className="sl-label">الكمية</label>
              <input className="form-input sl-input" type="number" min={0} value={mQty} onChange={e => setMQty(e.target.value)} />
            </div>
            <button className="btn btn--secondary btn--sm" onClick={manualAdd} disabled={busy} style={{ alignSelf: 'flex-end' }}>
              <Icon name="add" size={13} /> إضافة
            </button>
          </div>
        </div>
      )}

      {!rows.length ? (
        <div className="sl-empty">لا توجد مبيعات فرق مرفوعة بعد.</div>
      ) : (
        <div className="table-wrapper sl-table-wrap">
          <table className="data-table sl-table">
            <thead>
              <tr><th>الفريق</th><th>المذخر</th><th>المنطقة</th><th>تاريخ الدورة</th><th>الكمية</th><th>المصدر</th><th>الحالة</th>{p.canDelete && <th></th>}</tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id}>
                  <td><span style={{ color: TEAM_META[t.team].color }}><Icon name={TEAM_META[t.team].icon} size={13} /> {TEAM_META[t.team].label}</span></td>
                  <td className="sl-strong">{t.warehouse}</td>
                  <td className="sl-dim">{t.region}</td>
                  <td className="sl-dim">{fmtDate(t.asOfDate)}</td>
                  <td>{fmtNum(t.qty)}</td>
                  <td className="sl-dim">{t.sourceLabel || 'يدوي'}</td>
                  <td>
                    {t.linked
                      ? <span className="badge badge--green">مرتبطة بدورة</span>
                      : <span className="badge badge--gray" title="لا توجد عدّة ثانوية لهذا التاريخ بعد">بانتظار الثانوي</span>}
                  </td>
                  {p.canDelete && (
                    <td><button className="btn-icon btn-icon--red" onClick={() => removeRow(t.id)} title="حذف"><Icon name="delete" size={14} /></button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {review && (
        <StockMovementImportModal
          pending={review.pending}
          busy={busy}
          onCancel={() => setReview(null)}
          onConfirm={(choices) => commit(review.rows, review.fileName, choices)}
        />
      )}
    </>
  );
}
