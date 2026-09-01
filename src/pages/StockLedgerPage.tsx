/**
 * صفحة «رصيد المذاخر» — تتبّع نفاد الستوك وتنبيه إعادة الطلبية.
 *
 *   المتبقي = آخر ستوك افتتاحي مرفوع + التعزيزات الداخلة − المبيع الخارج
 *
 * صفحة Stock تعرض لقطة ساكنة؛ هذه الصفحة تضيف البُعد الزمني: كل ما يخرج من
 * المذخر يُنقص الرصيد، وكل تعزيز يزيده، وإعادة رفع الستوك تصفّر الأزواج الواردة
 * فيه وحدها. الحساب كله في الخادم (server/modules/stock-ledger).
 *
 * الهوية البصرية: نفس نظام App.css المستخدَم في صفحة Stock — بلا عنوان داخلي
 * (الشريط العلوي يعرضه)، شريط مؤشرات مضغوط، أزرار btn--sm بأيقونات Lucide بدل
 * الإيموجي، وألوان محصورة في توكنات accent / success / danger / gray بلا هاردكود.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import { Icon } from '../config/icons';
import type { IconName } from '../config/icons';

const API = import.meta.env.VITE_API_URL || '';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('auth_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ── الأنواع ────────────────────────────────────────────────────
interface Balance {
  warehouseId: number; warehouse: string; region: string;
  itemKey: string; itemName: string; companyName: string | null;
  opening: number; openingAt: string | null;
  inQty: number; outQty: number; remaining: number;
  pctLeft: number | null; lastMovementAt: string | null;
}
type Severity = 'out' | 'critical' | 'low';
interface AlertItem {
  itemKey: string; itemName: string; companyName: string | null;
  opening: number; inQty: number; outQty: number; remaining: number;
  suggestedQty: number; pctLeft: number; lastMovementAt: string | null;
  severity: Severity;
}
interface AlertGroup {
  warehouseId: number; warehouse: string; region: string;
  items: AlertItem[]; counts: Record<Severity, number>; total: number;
}
interface AlertsData {
  groups: AlertGroup[];
  totals: Record<Severity, number>;
  totalItems: number;
}
interface Unmatched {
  created: { name: string; region: string; suggestions: { name: string; region: string }[] }[];
  fuzzyLinked: { raw: string; matchedTo: string }[];
  itemsWithoutBaseline: { itemName: string; warehouse: string; region: string; qty: number }[];
  healed?: { name: string; region: string }[];
}
interface Batch {
  id: number; kind: 'baseline' | 'in' | 'out'; name: string;
  movementDate: string; rowCount: number; uploadedAt: string;
  unmatched: Unmatched | null;
}
interface StockFile { id: number; name: string; uploadedAt: string }
interface Movement {
  id: number; qty: number; direction: 'baseline' | 'in' | 'out'; movementDate: string;
  itemName: string; batch: { id: number; name: string; kind: string };
}

// ── ثوابت العرض ────────────────────────────────────────────────
// النوع والحالة يُعرضان بشارات (badge) من نظام التصميم — بلا ألوان هاردكود.
const KIND_META: Record<'baseline' | 'in' | 'out', { label: string; badge: string; icon: IconName }> = {
  baseline: { label: 'افتتاحي', badge: 'badge--blue',  icon: 'import' },
  in:       { label: 'تعزيز',   badge: 'badge--green', icon: 'uploadSales' },
  out:      { label: 'مبيع',    badge: 'badge--red',   icon: 'uploadReturns' },
};

const SEV_META: Record<Severity, { label: string; badge: string; color: string }> = {
  out:      { label: 'نفد',   badge: 'badge--red sl-badge--solid', color: 'var(--c-danger)' },
  critical: { label: 'حرج',   badge: 'badge--red',                 color: 'var(--c-danger)' },
  low:      { label: 'منخفض', badge: 'badge--gray',                color: 'var(--c-text-secondary)' },
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtNum = (n: number) => Number(n).toLocaleString('en');
const fmtDate = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

export default function StockLedgerPage() {
  const { user, hasFeature } = useAuth();
  const userId = user?.id ?? 0;

  const [tab, setTab] = useState<'balances' | 'alerts' | 'batches'>('balances');
  const [balances, setBalances] = useState<Balance[]>([]);
  const [alerts, setAlerts] = useState<AlertsData | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [stockFiles, setStockFiles] = useState<StockFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // عتبات التنبيه — محفوظة لكل مستخدم على حدة (نفس نمط رادار النقص في صفحة Stock)
  const [pct, setPct] = useState(20);
  const [qtyT, setQtyT] = useState(10);
  useEffect(() => {
    if (!userId) return;
    const p = localStorage.getItem(`sl_pct_u${userId}`);
    const q = localStorage.getItem(`sl_qty_u${userId}`);
    if (p !== null) setPct(Number(p) || 0);
    if (q !== null) setQtyT(Number(q) || 0);
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    localStorage.setItem(`sl_pct_u${userId}`, String(pct));
    localStorage.setItem(`sl_qty_u${userId}`, String(qtyT));
  }, [userId, pct, qtyT]);

  // فلاتر جدول الأرصدة
  const [fRegion, setFRegion] = useState<string>('all');
  const [fWarehouse, setFWarehouse] = useState<number | 'all'>('all');
  const [fCompany, setFCompany] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [onlyAlerting, setOnlyAlerting] = useState(false);

  // ── تحميل البيانات ───────────────────────────────────────────
  const loadBalances = useCallback(async () => {
    const r = await fetch(`${API}/api/stock-ledger/balances`, { headers: authHeaders() });
    const j = await r.json();
    if (j.success) setBalances(j.data);
  }, []);

  const loadAlerts = useCallback(async () => {
    const r = await fetch(`${API}/api/stock-ledger/alerts?pct=${pct}&qty=${qtyT}`, { headers: authHeaders() });
    const j = await r.json();
    if (j.success) setAlerts(j.data);
  }, [pct, qtyT]);

  const loadBatches = useCallback(async () => {
    const [b, f] = await Promise.all([
      fetch(`${API}/api/stock-ledger/batches`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API}/api/stock-ledger/stock-files`, { headers: authHeaders() }).then(r => r.json()),
    ]);
    if (b.success) setBatches(b.data);
    if (f.success) setStockFiles(f.data);
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    try { await Promise.all([loadBalances(), loadAlerts(), loadBatches()]); }
    finally { setLoading(false); }
  }, [loadBalances, loadAlerts, loadBatches]);

  useEffect(() => { reloadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadAlerts(); }, [pct, qtyT, loadAlerts]);

  // ── قوائم الفلاتر ────────────────────────────────────────────
  const regions = useMemo(
    () => [...new Set(balances.map(b => b.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar')),
    [balances]);
  const warehouses = useMemo(() => {
    const m = new Map<number, { id: number; name: string; region: string }>();
    for (const b of balances) {
      if (fRegion !== 'all' && b.region !== fRegion) continue;
      if (!m.has(b.warehouseId)) m.set(b.warehouseId, { id: b.warehouseId, name: b.warehouse, region: b.region });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [balances, fRegion]);
  const companies = useMemo(
    () => [...new Set(balances.map(b => b.companyName).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'ar')),
    [balances]);

  const alertingKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of alerts?.groups ?? []) for (const it of g.items) s.add(`${g.warehouseId}|${it.itemKey}`);
    return s;
  }, [alerts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return balances.filter(b => {
      if (fRegion !== 'all' && b.region !== fRegion) return false;
      if (fWarehouse !== 'all' && b.warehouseId !== fWarehouse) return false;
      if (fCompany !== 'all' && b.companyName !== fCompany) return false;
      if (onlyAlerting && !alertingKeys.has(`${b.warehouseId}|${b.itemKey}`)) return false;
      if (q && !b.itemName.toLowerCase().includes(q) && !b.warehouse.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [balances, fRegion, fWarehouse, fCompany, search, onlyAlerting, alertingKeys]);

  const kpis = useMemo(() => ({
    warehouses: new Set(filtered.map(b => b.warehouseId)).size,
    pairs: filtered.length,
    remaining: filtered.reduce((s, b) => s + b.remaining, 0),
    alerts: alerts?.totalItems ?? 0,
  }), [filtered, alerts]);

  // ── العمليات ─────────────────────────────────────────────────
  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 6000); };

  const afterWrite = async (label: string, res: any) => {
    const u: Unmatched | null = res?.unmatched ?? null;
    const notes: string[] = [];
    if (u?.created?.length) notes.push(`${u.created.length} مذخر جديد`);
    if (u?.fuzzyLinked?.length) notes.push(`${u.fuzzyLinked.length} رُبط بالتشابه`);
    if (u?.itemsWithoutBaseline?.length) notes.push(`${u.itemsWithoutBaseline.length} ايتم بلا ستوك افتتاحي`);
    if (u?.healed?.length) notes.push(`صُححت منطقة ${u.healed.length} مذخر`);
    flash(`${label}: ${fmtNum(res?.rowCount ?? 0)} سطر${notes.length ? ' — للمراجعة: ' + notes.join('، ') : ''}`);
    await reloadAll();
  };

  const post = async (url: string, body: any, label: string, key: string) => {
    setBusy(key); setErr('');
    try {
      const r = await fetch(`${API}${url}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشلت العملية');
      await afterWrite(label, j.data);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const postFile = async (file: File, kind: 'baseline' | 'in' | 'out', date: string, label: string) => {
    setBusy('upload'); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', kind);
      fd.append('movementDate', date);
      const r = await fetch(`${API}/api/stock-ledger/movements/upload`, {
        method: 'POST', headers: authHeaders(), body: fd,
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل رفع الملف');
      await afterWrite(label, j.data);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const deleteBatch = async (b: Batch) => {
    if (!confirm(`حذف «${b.name}» (${fmtNum(b.rowCount)} سطر)؟ ستُعاد حسبة الأرصدة المتأثرة.`)) return;
    setBusy(`del-${b.id}`); setErr('');
    try {
      const r = await fetch(`${API}/api/stock-ledger/batches/${b.id}`, { method: 'DELETE', headers: authHeaders() });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'فشل الحذف');
      flash('حُذفت الدفعة وأُعيد حساب الأرصدة');
      await reloadAll();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const TABS: { id: 'balances' | 'alerts' | 'batches'; label: string; icon: IconName; count?: number }[] = [
    { id: 'balances', label: 'الأرصدة',   icon: 'netBalance' },
    { id: 'alerts',   label: 'التنبيهات', icon: 'alert', count: alerts?.totalItems ?? 0 },
    { id: 'batches',  label: 'الدفعات',   icon: 'folder' },
  ];

  return (
    <div className="sl-page" dir="rtl">
      {err && <div className="alert alert--error sl-alert"><Icon name="warning" size={14} /> {err}</div>}
      {msg && <div className="alert alert--success sl-alert"><Icon name="check" size={14} /> {msg}</div>}

      {/* ── شريط المؤشرات ── */}
      <div className="sl-kpis">
        <Kpi label="المذاخر" value={fmtNum(kpis.warehouses)} />
        <Kpi label="مذخر × ايتم" value={fmtNum(kpis.pairs)} />
        <Kpi label="مجموع المتبقي" value={fmtNum(Math.round(kpis.remaining))} />
        <Kpi label="تحتاج طلبية" value={fmtNum(kpis.alerts)} danger={kpis.alerts > 0} />
        <div className="sl-kpis-note">المتبقي = الافتتاحي + التعزيز − المبيع</div>
      </div>

      {/* ── التبويبات + التحديث ── */}
      <div className="sl-bar">
        <div className="tabs">
          {TABS.map(t => (
            (t.id !== 'alerts' || hasFeature('stock_ledger_alerts')) && (
              <button key={t.id} className={`tab ${tab === t.id ? 'tab--active' : ''}`} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={14} /> {t.label}
                {t.count ? <span className="sl-tab-count">{t.count}</span> : null}
              </button>
            )
          ))}
        </div>
        <button className="btn btn--secondary btn--sm" onClick={reloadAll} disabled={loading} title="إعادة تحميل الأرصدة والتنبيهات">
          <Icon name="refresh" size={13} className={loading ? 'sl-spin' : undefined} /> تحديث
        </button>
      </div>

      {loading && <div className="sl-empty">جارٍ التحميل…</div>}

      {!loading && tab === 'balances' && (
        <BalancesTab
          rows={filtered} regions={regions} warehouses={warehouses} companies={companies}
          fRegion={fRegion} setFRegion={(r) => { setFRegion(r); setFWarehouse('all'); }}
          fWarehouse={fWarehouse} setFWarehouse={setFWarehouse}
          fCompany={fCompany} setFCompany={setFCompany}
          search={search} setSearch={setSearch}
          onlyAlerting={onlyAlerting} setOnlyAlerting={setOnlyAlerting}
          alertingKeys={alertingKeys}
          canExport={hasFeature('stock_ledger_export')}
        />
      )}

      {!loading && tab === 'alerts' && hasFeature('stock_ledger_alerts') && (
        <AlertsTab
          data={alerts} pct={pct} setPct={setPct} qty={qtyT} setQty={setQtyT}
          canExport={hasFeature('stock_ledger_export')}
        />
      )}

      {!loading && tab === 'batches' && (
        <BatchesTab
          batches={batches} stockFiles={stockFiles} busy={busy}
          onBaselineFromStock={(fileId, date) =>
            post('/api/stock-ledger/baseline/from-stock-file', { salesDataFileId: fileId, movementDate: date }, 'استُورد الستوك الافتتاحي', 'baseline')}
          onUpload={postFile}
          onManual={(kind, date, rows) =>
            post('/api/stock-ledger/movements/manual', { kind, movementDate: date, rows }, 'أُضيفت الحركة', 'manual')}
          onDelete={deleteBatch}
          canBaseline={hasFeature('stock_ledger_baseline')}
          canUpload={hasFeature('stock_ledger_movement_upload')}
          canManual={hasFeature('stock_ledger_manual')}
          canDelete={hasFeature('stock_ledger_delete')}
        />
      )}
    </div>
  );
}

/** خلية مؤشر واحدة — رقم فوق تسمية، بلا أيقونة ملوّنة ولا بطاقة مستقلة */
function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="sl-kpi">
      <div className={`sl-kpi-value${danger ? ' sl-kpi-value--danger' : ''}`}>{value}</div>
      <div className="sl-kpi-label">{label}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب الأرصدة
// ═══════════════════════════════════════════════════════════════
function BalancesTab(p: {
  rows: Balance[];
  regions: string[]; warehouses: { id: number; name: string; region: string }[]; companies: string[];
  fRegion: string; setFRegion: (v: string) => void;
  fWarehouse: number | 'all'; setFWarehouse: (v: number | 'all') => void;
  fCompany: string; setFCompany: (v: string) => void;
  search: string; setSearch: (v: string) => void;
  onlyAlerting: boolean; setOnlyAlerting: (v: boolean) => void;
  alertingKeys: Set<string>;
  canExport: boolean;
}) {
  const [limit, setLimit] = useState(200);
  const [history, setHistory] = useState<{ row: Balance; movements: Movement[] } | null>(null);

  const openHistory = async (row: Balance) => {
    const r = await fetch(
      `${API}/api/stock-ledger/warehouse/${row.warehouseId}/history?itemKey=${encodeURIComponent(row.itemKey)}`,
      { headers: authHeaders() });
    const j = await r.json();
    setHistory({ row, movements: j.success ? j.data : [] });
  };

  const exportXlsx = () => {
    const data = p.rows.map(b => ({
      'المنطقة': b.region, 'المذخر': b.warehouse, 'الشركة': b.companyName ?? '',
      'الايتم': b.itemName, 'الستوك الافتتاحي': b.opening, 'تاريخ الافتتاحي': fmtDate(b.openingAt),
      'تعزيزات ↑': b.inQty, 'مبيع ↓': b.outQty, 'المتبقي': b.remaining,
      'نسبة المتبقي %': b.pctLeft ?? '', 'آخر حركة': fmtDate(b.lastMovementAt),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, 'أرصدة المذاخر');
    XLSX.writeFile(wb, `stock_balances_${todayISO()}.xlsx`);
  };

  return (
    <>
      <div className="sl-filters">
        <div className="sl-field sl-field--grow">
          <label className="sl-label">بحث</label>
          <input className="form-input sl-input" value={p.search} onChange={e => p.setSearch(e.target.value)} placeholder="ايتم أو مذخر…" />
        </div>
        <div className="sl-field">
          <label className="sl-label">المنطقة</label>
          <select className="form-input sl-input" value={p.fRegion} onChange={e => p.setFRegion(e.target.value)}>
            <option value="all">الكل</option>
            {p.regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="sl-field">
          <label className="sl-label">المذخر</label>
          <select className="form-input sl-input" value={String(p.fWarehouse)}
            onChange={e => p.setFWarehouse(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">الكل</option>
            {p.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="sl-field">
          <label className="sl-label">الشركة</label>
          <select className="form-input sl-input" value={p.fCompany} onChange={e => p.setFCompany(e.target.value)}>
            <option value="all">الكل</option>
            {p.companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="sl-actions">
          <button
            className={`filter-chip${p.onlyAlerting ? ' filter-chip--active' : ''}`}
            onClick={() => p.setOnlyAlerting(!p.onlyAlerting)}
            title="عرض ما يحتاج طلبية فقط"
          >
            <Icon name="alert" size={12} /> تحتاج طلبية
          </button>
          {p.canExport && (
            <button className="btn btn--secondary btn--sm" onClick={exportXlsx} disabled={!p.rows.length} title="تصدير الأرصدة إلى Excel">
              <Icon name="export" size={13} /> تصدير
            </button>
          )}
        </div>
      </div>

      {!p.rows.length ? (
        <div className="sl-empty">لا توجد أرصدة بعد — ابدأ من تبويب «الدفعات» باستيراد الستوك الافتتاحي من ملف Stock.</div>
      ) : (
        <div className="table-wrapper sl-table-wrap">
          <table className="data-table sl-table">
            <thead>
              <tr>
                <th>المنطقة</th><th>المذخر</th><th>الشركة</th><th>الايتم</th>
                <th>الافتتاحي</th><th>تعزيز</th><th>مبيع</th><th>المتبقي</th><th>المتبقي %</th><th>آخر حركة</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.slice(0, limit).map((b, i) => {
                const alerting = p.alertingKeys.has(`${b.warehouseId}|${b.itemKey}`);
                const out = b.remaining <= 0;
                return (
                  <tr key={i} onClick={() => openHistory(b)} title="عرض سجل الحركات"
                    className={`sl-row${out ? ' sl-row--out' : alerting ? ' sl-row--warn' : ''}`}>
                    <td className="sl-dim">{b.region}</td>
                    <td className="sl-strong">{b.warehouse}</td>
                    <td className="sl-dim">{b.companyName ?? '—'}</td>
                    <td>{b.itemName}</td>
                    <td>{fmtNum(b.opening)}</td>
                    <td className={b.inQty ? 'sl-in' : 'sl-dim'}>{b.inQty ? fmtNum(b.inQty) : '—'}</td>
                    <td className={b.outQty ? 'sl-out' : 'sl-dim'}>{b.outQty ? fmtNum(b.outQty) : '—'}</td>
                    <td className={`sl-strong${out ? ' sl-out' : ''}`}>{fmtNum(b.remaining)}</td>
                    <td>
                      {b.pctLeft === null ? <span className="sl-dim">—</span> : (
                        <div className="sl-pct">
                          <span className="sl-pct-track">
                            <span className={`sl-pct-fill${out || alerting ? ' sl-pct-fill--low' : ''}`}
                              style={{ width: `${Math.max(0, Math.min(100, b.pctLeft))}%` }} />
                          </span>
                          <span className="sl-pct-num">{b.pctLeft}%</span>
                        </div>
                      )}
                    </td>
                    <td className="sl-dim">{fmtDate(b.lastMovementAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="sl-table-foot">
            <span>عرض {Math.min(limit, p.rows.length)} من {fmtNum(p.rows.length)} — انقر أي صف لسجل حركاته</span>
            {limit < p.rows.length && (
              <button className="btn btn--secondary btn--sm" onClick={() => setLimit(l => l + 200)}>عرض المزيد</button>
            )}
          </div>
        </div>
      )}

      {history && <HistoryModal data={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function HistoryModal({ data, onClose }: { data: { row: Balance; movements: Movement[] }; onClose: () => void }) {
  const { row, movements } = data;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ fontWeight: 700 }}>{row.itemName}</div>
            <div className="sl-hint">{row.warehouse} — {row.region}</div>
          </div>
          <button className="btn-icon btn-icon--red" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="sl-kpis sl-kpis--modal">
            <Kpi label="الافتتاحي" value={fmtNum(row.opening)} />
            <Kpi label="تعزيزات" value={fmtNum(row.inQty)} />
            <Kpi label="مبيع" value={fmtNum(row.outQty)} />
            <Kpi label="المتبقي" value={fmtNum(row.remaining)} danger={row.remaining <= 0} />
          </div>
          <div className="table-wrapper sl-table-wrap sl-table-wrap--scroll">
            <table className="data-table sl-table">
              <thead><tr><th>التاريخ</th><th>النوع</th><th>الكمية</th><th>الدفعة</th></tr></thead>
              <tbody>
                {movements.map(m => (
                  <tr key={m.id}>
                    <td className="sl-dim">{fmtDate(m.movementDate)}</td>
                    <td><span className={`badge ${KIND_META[m.direction].badge}`}>{KIND_META[m.direction].label}</span></td>
                    <td className="sl-strong">{fmtNum(m.qty)}</td>
                    <td className="sl-dim">{m.batch?.name}</td>
                  </tr>
                ))}
                {!movements.length && <tr><td colSpan={4} className="empty-row">لا حركات</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب التنبيهات
// ═══════════════════════════════════════════════════════════════
function AlertsTab(p: {
  data: AlertsData | null;
  pct: number; setPct: (v: number) => void;
  qty: number; setQty: (v: number) => void;
  canExport: boolean;
}) {
  const groups = p.data?.groups ?? [];

  const copyList = () => {
    const lines: string[] = [];
    for (const g of groups) {
      lines.push(`▪ ${g.warehouse} — ${g.region} (${g.total} ايتم)`);
      for (const it of g.items) {
        lines.push(`   • ${it.itemName}: متبقي ${fmtNum(it.remaining)} — يُقترح طلب ${fmtNum(it.suggestedQty)}`);
      }
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n'));
  };

  const exportXlsx = () => {
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(groups.map(g => ({
      'المنطقة': g.region, 'المذخر': g.warehouse,
      'نفد': g.counts.out, 'حرج': g.counts.critical, 'منخفض': g.counts.low, 'المجموع': g.total,
    }))), 'ملخص المذاخر');
    const detail = groups.flatMap(g => g.items.map(it => ({
      'المنطقة': g.region, 'المذخر': g.warehouse, 'الشركة': it.companyName ?? '',
      'الايتم': it.itemName, 'الحالة': SEV_META[it.severity].label,
      'الافتتاحي': it.opening, 'تعزيزات': it.inQty, 'مبيع': it.outQty,
      'المتبقي': it.remaining, 'نسبة المتبقي %': it.pctLeft,
      'الكمية المقترحة للطلبية': it.suggestedQty, 'آخر حركة': fmtDate(it.lastMovementAt),
    })));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), 'تفصيل الطلبيات');
    XLSX.writeFile(wb, `reorder_alerts_${todayISO()}.xlsx`);
  };

  return (
    <>
      <div className="sl-filters">
        <div className="sl-field sl-field--xs">
          <label className="sl-label">أقل من % من الافتتاحي</label>
          <input className="form-input sl-input" type="number" min={0} max={100} value={p.pct}
            onChange={e => p.setPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
        </div>
        <div className="sl-field sl-field--xs">
          <label className="sl-label">أو كمية أقل من</label>
          <input className="form-input sl-input" type="number" min={0} value={p.qty}
            onChange={e => p.setQty(Math.max(0, Number(e.target.value) || 0))} />
        </div>
        {p.data && (
          <div className="sl-badges">
            {(['out', 'critical', 'low'] as Severity[]).map(s => (
              <span key={s} className={`badge ${SEV_META[s].badge}`}>{SEV_META[s].label} {p.data!.totals[s]}</span>
            ))}
          </div>
        )}
        <div className="sl-actions">
          <button className="btn btn--secondary btn--sm" onClick={copyList} disabled={!groups.length} title="نسخ قائمة الطلبيات كنص">
            <Icon name="file" size={13} /> نسخ
          </button>
          {p.canExport && (
            <button className="btn btn--secondary btn--sm" onClick={exportXlsx} disabled={!groups.length} title="تصدير التنبيهات إلى Excel">
              <Icon name="export" size={13} /> تصدير
            </button>
          )}
        </div>
      </div>
      <div className="sl-hint sl-hint--block">يُطلق التنبيه بأيّ الشرطين تحقق أولاً — فايتم ستوكه 1000 لا يُعامَل كايتم ستوكه 30.</div>

      {!groups.length ? (
        <div className="sl-empty">لا يوجد مذخر يحتاج طلبية بهذه العتبات.</div>
      ) : (
        <div className="sl-groups">
          {groups.map(g => (
            <div key={g.warehouseId} className="table-wrapper sl-table-wrap">
              <div className="sl-group-head">
                <div>
                  <div className="sl-group-title">{g.warehouse}</div>
                  <div className="sl-hint">{g.region} — {g.total} ايتم يحتاج طلبية</div>
                </div>
                <div className="sl-badges">
                  {(['out', 'critical', 'low'] as Severity[]).filter(s => g.counts[s] > 0).map(s => (
                    <span key={s} className={`badge ${SEV_META[s].badge}`}>{SEV_META[s].label} {g.counts[s]}</span>
                  ))}
                </div>
              </div>
              <table className="data-table sl-table">
                <thead>
                  <tr><th>الحالة</th><th>الايتم</th><th>الشركة</th><th>الافتتاحي</th><th>المتبقي</th><th>%</th><th>الكمية المقترحة</th><th>آخر حركة</th></tr>
                </thead>
                <tbody>
                  {g.items.map((it, i) => (
                    <tr key={i}>
                      <td><span className={`badge ${SEV_META[it.severity].badge}`}>{SEV_META[it.severity].label}</span></td>
                      <td className="sl-strong">{it.itemName}</td>
                      <td className="sl-dim">{it.companyName ?? '—'}</td>
                      <td>{fmtNum(it.opening)}</td>
                      <td className="sl-strong" style={{ color: SEV_META[it.severity].color }}>{fmtNum(it.remaining)}</td>
                      <td className="sl-dim">{it.pctLeft}%</td>
                      <td className="sl-suggest">{fmtNum(it.suggestedQty)}</td>
                      <td className="sl-dim">{fmtDate(it.lastMovementAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
//  تبويب الدفعات والرفع
// ═══════════════════════════════════════════════════════════════
function BatchesTab(p: {
  batches: Batch[]; stockFiles: StockFile[]; busy: string | null;
  onBaselineFromStock: (fileId: number, date: string) => void;
  onUpload: (file: File, kind: 'baseline' | 'in' | 'out', date: string, label: string) => void;
  onManual: (kind: 'baseline' | 'in' | 'out', date: string, rows: any[]) => void;
  onDelete: (b: Batch) => void;
  canBaseline: boolean; canUpload: boolean; canManual: boolean; canDelete: boolean;
}) {
  const [date, setDate] = useState(todayISO());
  const [stockFileId, setStockFileId] = useState<number | ''>('');
  const [showManual, setShowManual] = useState(false);
  const outRef = useRef<HTMLInputElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  const baseRef = useRef<HTMLInputElement>(null);

  const pick = (ref: React.RefObject<HTMLInputElement>) => ref.current?.click();
  const onPicked = (e: React.ChangeEvent<HTMLInputElement>, kind: 'baseline' | 'in' | 'out', label: string) => {
    const f = e.target.files?.[0];
    if (f) p.onUpload(f, kind, date, label);
    e.target.value = '';
  };

  const uploading = p.busy === 'upload';
  const reviewBatches = p.batches.filter(b => b.unmatched);

  return (
    <>
      <div className="sl-toolbar">
        {/* صف 1: التاريخ + الاستيراد من ملف Stock موجود (المسار الأكثر استخداماً) */}
        <div className="sl-toolbar-row">
          <div className="sl-field sl-field--sm">
            <label className="sl-label">تاريخ السريان</label>
            <input className="form-input sl-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          {p.canBaseline && (
            <div className="sl-field sl-field--grow">
              <label className="sl-label">استيراد الافتتاحي من ملف Stock موجود</label>
              <div className="sl-inline">
                <select className="form-input sl-input" value={stockFileId}
                  onChange={e => setStockFileId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">اختر ملف…</option>
                  {p.stockFiles.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <button className="btn btn--primary btn--sm" disabled={!stockFileId || p.busy === 'baseline'}
                  onClick={() => stockFileId && p.onBaselineFromStock(stockFileId, date)}>
                  <Icon name={p.busy === 'baseline' ? 'refresh' : 'import'} size={13} className={p.busy === 'baseline' ? 'sl-spin' : undefined} /> استيراد
                </button>
              </div>
            </div>
          )}
        </div>

        {(p.canBaseline || p.canUpload || p.canManual) && <div className="sl-toolbar-divider" />}

        {/* صف 2: رفع حركة من ملف Excel، أو إدخال يدوي — مجموعتان منفصلتان بصرياً */}
        <div className="sl-toolbar-row">
          {(p.canBaseline || p.canUpload) && (
            <div className="sl-field">
              <span className="sl-label">أو ارفع ملف حركة</span>
              <div className="sl-action-group">
                {p.canBaseline && (
                  <button className="sl-action sl-action--blue" disabled={uploading} onClick={() => pick(baseRef)}
                    title="رفع ستوك افتتاحي من ملف Excel — يصفّر أزواج (مذخر+ايتم) الواردة فيه">
                    <span className="sl-action-icon"><Icon name="import" size={12} /></span> ملف افتتاحي
                  </button>
                )}
                {p.canUpload && (
                  <>
                    <button className="sl-action sl-action--green" disabled={uploading} onClick={() => pick(inRef)}
                      title="رفع تعزيز داخل إلى المذاخر — يزيد الرصيد">
                      <span className="sl-action-icon"><Icon name="uploadSales" size={12} /></span> تعزيز
                    </button>
                    <button className="sl-action sl-action--red" disabled={uploading} onClick={() => pick(outRef)}
                      title="رفع مبيع خارج من المذاخر — ينقص الرصيد">
                      <span className="sl-action-icon"><Icon name="uploadReturns" size={12} /></span> مبيع
                    </button>
                  </>
                )}
                {uploading && <Icon name="refresh" size={14} className="sl-spin" />}
              </div>
            </div>
          )}

          {p.canManual && (
            <button className="btn btn--secondary btn--sm sl-manual-btn" onClick={() => setShowManual(true)} title="إدخال حركة يدوية سطراً سطراً">
              <Icon name="edit" size={13} /> إدخال يدوي
            </button>
          )}
        </div>

        <div className="sl-hint sl-hint--block sl-hint--tight">
          أعمدة ملف الحركات: <b>المذخر</b> · المنطقة · الشركة · <b>الايتم</b> · <b>الكمية</b> · التاريخ (الغامق إلزامي).
          ستوك افتتاحي جديد يصفّر أزواج (مذخر+ايتم) الواردة فيه ويهمل حركاتها الأقدم من تاريخ السريان.
        </div>
      </div>

      <input ref={baseRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'baseline', 'استُورد الستوك الافتتاحي')} />
      <input ref={outRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'out', 'أُضيف المبيع')} />
      <input ref={inRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'in', 'أُضيف التعزيز')} />

      {reviewBatches.length > 0 && <ReviewPanel batches={reviewBatches} />}

      <div className="table-wrapper sl-table-wrap">
        <div className="sl-group-head">
          <div className="sl-group-title">الدفعات المرفوعة ({p.batches.length})</div>
        </div>
        {!p.batches.length ? (
          <div className="sl-empty sl-empty--flat">لا دفعات بعد — ابدأ باستيراد الستوك الافتتاحي من ملف Stock.</div>
        ) : (
          <table className="data-table sl-table">
            <thead><tr><th>النوع</th><th>الاسم</th><th>تاريخ السريان</th><th>الأسطر</th><th>رُفعت</th><th></th></tr></thead>
            <tbody>
              {p.batches.map(b => (
                <tr key={b.id}>
                  <td><span className={`badge ${KIND_META[b.kind].badge}`}>{KIND_META[b.kind].label}</span></td>
                  <td className="sl-strong">{b.name}</td>
                  <td>{fmtDate(b.movementDate)}</td>
                  <td>{fmtNum(b.rowCount)}</td>
                  <td className="sl-dim">{fmtDate(b.uploadedAt)}</td>
                  <td>
                    {p.canDelete && (
                      <button className="btn-icon btn-icon--red" title="حذف الدفعة وإعادة الحساب"
                        disabled={p.busy === `del-${b.id}`} onClick={() => p.onDelete(b)}>
                        <Icon name="delete" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showManual && (
        <ManualModal
          date={date}
          busy={p.busy === 'manual'}
          onClose={() => setShowManual(false)}
          onSave={(kind, rows) => { p.onManual(kind, date, rows); setShowManual(false); }}
        />
      )}
    </>
  );
}

function ReviewPanel({ batches }: { batches: Batch[] }) {
  const [open, setOpen] = useState(false);
  const created = batches.flatMap(b => b.unmatched?.created ?? []);
  const fuzzy = batches.flatMap(b => b.unmatched?.fuzzyLinked ?? []);
  const orphans = batches.flatMap(b => b.unmatched?.itemsWithoutBaseline ?? []);
  const healed = batches.flatMap(b => b.unmatched?.healed ?? []);

  return (
    <div className="sl-review">
      <div className="sl-review-head" onClick={() => setOpen(o => !o)}>
        <div className="sl-review-title">
          <Icon name="warning" size={14} /> مراجعة غير المطابق — {created.length} مذخر جديد · {fuzzy.length} رُبط بالتشابه · {orphans.length} ايتم بلا افتتاحي{healed.length ? ` · ${healed.length} صُححت منطقته` : ''}
        </div>
        <span className="sl-hint">{open ? 'إخفاء ▲' : 'عرض ▼'}</span>
      </div>
      {open && (
        <div className="sl-review-body">
          {healed.length > 0 && (
            <div>
              <div className="sl-review-sub">مذاخر كانت منطقتها فاسدة (من استيراد قديم معطوب) وصُححت تلقائياً الآن:</div>
              {healed.map((h, i) => <div key={i} className="sl-review-line sl-dim">{h.name} ← {h.region}</div>)}
            </div>
          )}
          {created.length > 0 && (
            <div>
              <div className="sl-review-sub">مذاخر أُنشئت جديدة (تأكد أنها ليست تكراراً لاسم موجود):</div>
              {created.map((c, i) => (
                <div key={i} className="sl-review-line">
                  <b>{c.name}</b> — {c.region}
                  {c.suggestions.length > 0 && (
                    <span className="sl-dim"> · قريب من: {c.suggestions.map(s => `${s.name} (${s.region})`).join('، ')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {fuzzy.length > 0 && (
            <div>
              <div className="sl-review-sub">رُبطت تلقائياً بالتشابه:</div>
              {fuzzy.map((f, i) => <div key={i} className="sl-review-line sl-dim">{f.raw} ← {f.matchedTo}</div>)}
            </div>
          )}
          {orphans.length > 0 && (
            <div>
              <div className="sl-review-sub">ايتمات تحرّكت بلا ستوك افتتاحي (رصيدها سالب حتى ترفع ستوكها):</div>
              {orphans.slice(0, 40).map((o, i) => (
                <div key={i} className="sl-review-line sl-dim">{o.itemName} — {o.warehouse} ({o.region}) · خرج {fmtNum(o.qty)}</div>
              ))}
              {orphans.length > 40 && <div className="sl-review-line sl-dim">… و{orphans.length - 40} غيرها</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ManualRow { warehouse: string; region: string; itemName: string; companyName: string; qty: string }
const emptyManualRow = (): ManualRow => ({ warehouse: '', region: '', itemName: '', companyName: '', qty: '' });

function ManualModal(p: {
  date: string; busy: boolean;
  onClose: () => void;
  onSave: (kind: 'baseline' | 'in' | 'out', rows: any[]) => void;
}) {
  const [kind, setKind] = useState<'baseline' | 'in' | 'out'>('out');
  const [rows, setRows] = useState<ManualRow[]>([emptyManualRow()]);

  const set = (i: number, k: keyof ManualRow, v: string) =>
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  // سطر جديد يرث المذخر والمنطقة من السطر السابق — أغلب الإدخال لمذخر واحد
  const addRow = () => setRows(rs => {
    const last = rs[rs.length - 1];
    return [...rs, { ...emptyManualRow(), warehouse: last?.warehouse ?? '', region: last?.region ?? '' }];
  });

  const valid = rows.filter(r => r.warehouse.trim() && r.itemName.trim() && Number(r.qty) > 0);

  return (
    <div className="modal-overlay" onClick={p.onClose}>
      <div className="modal" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ fontWeight: 700 }}>إدخال حركة يدوية — {fmtDate(p.date)}</div>
          <button className="btn-icon btn-icon--red" onClick={p.onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="tabs">
            {(['out', 'in', 'baseline'] as const).map(k => (
              <button key={k} className={`tab ${kind === k ? 'tab--active' : ''}`} onClick={() => setKind(k)}>
                <Icon name={KIND_META[k].icon} size={13} /> {KIND_META[k].label}
              </button>
            ))}
          </div>
          <div className="table-wrapper sl-table-wrap sl-table-wrap--scroll">
            <table className="data-table sl-table">
              <thead><tr><th>المذخر *</th><th>المنطقة</th><th>الايتم *</th><th>الشركة</th><th>الكمية *</th><th></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input className="form-input sl-input" value={r.warehouse} onChange={e => set(i, 'warehouse', e.target.value)} /></td>
                    <td><input className="form-input sl-input" value={r.region} onChange={e => set(i, 'region', e.target.value)} /></td>
                    <td><input className="form-input sl-input" value={r.itemName} onChange={e => set(i, 'itemName', e.target.value)} /></td>
                    <td><input className="form-input sl-input" value={r.companyName} onChange={e => set(i, 'companyName', e.target.value)} /></td>
                    <td><input className="form-input sl-input" type="number" min={0} value={r.qty} onChange={e => set(i, 'qty', e.target.value)} style={{ width: 80 }} /></td>
                    <td>
                      {rows.length > 1 && (
                        <button className="btn-icon btn-icon--red" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>
                          <Icon name="delete" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn--secondary btn--sm" style={{ alignSelf: 'flex-start' }} onClick={addRow}>
            <Icon name="add" size={13} /> سطر جديد
          </button>
        </div>
        <div className="modal-footer">
          <button className="btn btn--secondary btn--sm" onClick={p.onClose}>إلغاء</button>
          <button className="btn btn--primary btn--sm" disabled={!valid.length || p.busy}
            onClick={() => p.onSave(kind, valid.map(r => ({
              warehouse: r.warehouse, region: r.region, itemName: r.itemName,
              companyName: r.companyName, qty: Number(r.qty),
            })))}>
            {p.busy ? 'جارٍ الحفظ…' : `حفظ ${valid.length} سطر`}
          </button>
        </div>
      </div>
    </div>
  );
}
