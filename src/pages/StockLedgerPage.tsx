/**
 * صفحة «رصيد المذاخر» — تتبّع نفاد الستوك وتنبيه إعادة الطلبية.
 *
 *   المتبقي = آخر ستوك افتتاحي مرفوع + التعزيزات الداخلة − المبيع الخارج
 *
 * صفحة Stock تعرض لقطة ساكنة؛ هذه الصفحة تضيف البُعد الزمني: كل ما يخرج من
 * المذخر يُنقص الرصيد، وكل تعزيز يزيده، وإعادة رفع الستوك تصفّر الأزواج الواردة
 * فيه وحدها. الحساب كله في الخادم (server/modules/stock-ledger).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import { Icon } from '../config/icons';

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
const KIND_META = {
  baseline: { label: 'ستوك افتتاحي', color: 'var(--c-accent)',  bg: 'var(--c-accent-light)', icon: '📦' },
  in:       { label: 'تعزيز',        color: 'var(--c-success)', bg: 'var(--c-success-bg)',   icon: '⬆️' },
  out:      { label: 'مبيع',         color: 'var(--c-danger)',  bg: 'var(--c-danger-bg)',    icon: '⬇️' },
} as const;

const SEV_META: Record<Severity, { label: string; color: string; bg: string }> = {
  out:      { label: 'نفد',    color: '#b91c1c', bg: '#fee2e2' },
  critical: { label: 'حرج',    color: '#c2410c', bg: '#ffedd5' },
  low:      { label: 'منخفض',  color: '#a16207', bg: '#fef3c7' },
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

  return (
    <div className="page" dir="rtl" style={{ maxWidth: 1500 }}>
      <div className="page-header">
        <div>
          <div className="page-title">📉 رصيد المذاخر</div>
          <div className="page-subtitle">
            المتبقي = الستوك الافتتاحي + التعزيزات − المبيع الخارج · تنبيه عند اقتراب النفاد
          </div>
        </div>
        <button className="btn btn--secondary" onClick={reloadAll} disabled={loading}>
          <Icon name="loading" size={15} /> تحديث
        </button>
      </div>

      {err && <div className="alert alert--error" style={{ marginBottom: 12 }}>⚠️ {err}</div>}
      {msg && <div className="alert alert--success" style={{ marginBottom: 12 }}>✓ {msg}</div>}

      {/* ── بطاقات المؤشرات ── */}
      <div className="stats-grid stats-grid--4" style={{ marginBottom: 16 }}>
        {[
          { icon: '🏬', label: 'المذاخر المتتبَّعة', value: fmtNum(kpis.warehouses), cls: 'stat-card-icon--blue',  color: 'var(--c-accent)' },
          { icon: '🔗', label: 'أزواج (مذخر × ايتم)', value: fmtNum(kpis.pairs),     cls: 'stat-card-icon--purple', color: 'var(--c-purple)' },
          { icon: '📦', label: 'مجموع المتبقي',       value: fmtNum(Math.round(kpis.remaining)), cls: 'stat-card-icon--green', color: 'var(--c-success)' },
          { icon: '🚨', label: 'تحتاج طلبية',         value: fmtNum(kpis.alerts),    cls: 'stat-card-icon--red',   color: 'var(--c-danger)' },
        ].map((k, i) => (
          <div key={i} className="stat-card">
            <div className={`stat-card-icon ${k.cls}`}>{k.icon}</div>
            <div className="stat-card-body">
              <div className="stat-card-value" style={{ color: k.color }}>{k.value}</div>
              <div className="stat-card-label">{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="tabs">
        {([
          ['balances', '📊 الأرصدة'],
          ['alerts', `🚨 تنبيهات الطلبيات${alerts?.totalItems ? ` (${alerts.totalItems})` : ''}`],
          ['batches', '🗂️ الدفعات والرفع'],
        ] as const).map(([id, label]) => (
          (id !== 'alerts' || hasFeature('stock_ledger_alerts')) && (
            <button key={id} className={`tab ${tab === id ? 'tab--active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          )
        ))}
      </div>

      {loading && <div className="card" style={{ textAlign: 'center', color: 'var(--c-accent)' }}>⏳ جاري التحميل...</div>}

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
      <div className="filter-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="form-group" style={{ flex: 1, minWidth: 200 }}>
          <label className="form-label">بحث (ايتم أو مذخر)</label>
          <input className="form-input" value={p.search} onChange={e => p.setSearch(e.target.value)} placeholder="اكتب للبحث..." />
        </div>
        <div className="form-group">
          <label className="form-label">المنطقة</label>
          <select className="form-input" value={p.fRegion} onChange={e => p.setFRegion(e.target.value)} style={{ width: 'auto', minWidth: 140 }}>
            <option value="all">الكل</option>
            {p.regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">المذخر</label>
          <select className="form-input" value={String(p.fWarehouse)}
            onChange={e => p.setFWarehouse(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            style={{ width: 'auto', minWidth: 170 }}>
            <option value="all">الكل</option>
            {p.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">الشركة</label>
          <select className="form-input" value={p.fCompany} onChange={e => p.setFCompany(e.target.value)} style={{ width: 'auto', minWidth: 140 }}>
            <option value="all">الكل</option>
            {p.companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={p.onlyAlerting} onChange={e => p.setOnlyAlerting(e.target.checked)} />
          التي تحتاج طلبية فقط
        </label>
        {p.canExport && (
          <button className="btn btn--secondary" onClick={exportXlsx} disabled={!p.rows.length} style={{ marginBottom: 4 }}>
            ⬇️ تصدير Excel
          </button>
        )}
      </div>

      {!p.rows.length ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--c-text-secondary)' }}>
          لا توجد أرصدة بعد — ابدأ من تبويب «الدفعات والرفع» باستيراد الستوك الافتتاحي من ملف Stock.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>المنطقة</th><th>المذخر</th><th>الشركة</th><th>الايتم</th>
                  <th>الافتتاحي</th><th>تعزيز ↑</th><th>مبيع ↓</th><th>المتبقي</th><th>%</th><th>آخر حركة</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.slice(0, limit).map((b, i) => {
                  const alerting = p.alertingKeys.has(`${b.warehouseId}|${b.itemKey}`);
                  const neg = b.remaining <= 0;
                  return (
                    <tr key={i} onClick={() => openHistory(b)} style={{ cursor: 'pointer', background: neg ? '#fef2f2' : alerting ? '#fffbeb' : undefined }}>
                      <td>{b.region}</td>
                      <td style={{ fontWeight: 600 }}>{b.warehouse}</td>
                      <td style={{ color: 'var(--c-text-secondary)', fontSize: 12 }}>{b.companyName ?? '—'}</td>
                      <td>{b.itemName}</td>
                      <td>{fmtNum(b.opening)}</td>
                      <td style={{ color: b.inQty ? 'var(--c-success)' : undefined }}>{b.inQty ? fmtNum(b.inQty) : '—'}</td>
                      <td style={{ color: b.outQty ? 'var(--c-danger)' : undefined }}>{b.outQty ? fmtNum(b.outQty) : '—'}</td>
                      <td style={{ fontWeight: 700, color: neg ? '#b91c1c' : alerting ? '#a16207' : 'var(--c-text-primary)' }}>
                        {fmtNum(b.remaining)}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{b.pctLeft === null ? '—' : `${b.pctLeft}%`}</td>
                      <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{fmtDate(b.lastMovementAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--c-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>عرض {Math.min(limit, p.rows.length)} من {fmtNum(p.rows.length)} — انقر أي صف لعرض سجل حركاته</span>
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
            <div style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{row.warehouse} — {row.region}</div>
          </div>
          <button className="btn-icon btn-icon--red" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[
              ['الافتتاحي', fmtNum(row.opening), 'var(--c-accent)'],
              ['تعزيزات', fmtNum(row.inQty), 'var(--c-success)'],
              ['مبيع', fmtNum(row.outQty), 'var(--c-danger)'],
              ['المتبقي', fmtNum(row.remaining), row.remaining <= 0 ? '#b91c1c' : 'var(--c-text-primary)'],
            ].map(([l, v, c], i) => (
              <div key={i} className="card card--compact" style={{ flex: 1, minWidth: 100, textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: c as string }}>{v}</div>
                <div style={{ fontSize: 11, color: 'var(--c-text-secondary)' }}>{l}</div>
              </div>
            ))}
          </div>
          <div className="table-wrapper" style={{ maxHeight: 340 }}>
            <table className="table">
              <thead><tr><th>التاريخ</th><th>النوع</th><th>الكمية</th><th>الدفعة</th></tr></thead>
              <tbody>
                {movements.map(m => (
                  <tr key={m.id}>
                    <td>{fmtDate(m.movementDate)}</td>
                    <td>
                      <span style={{ background: KIND_META[m.direction].bg, color: KIND_META[m.direction].color, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>
                        {KIND_META[m.direction].icon} {KIND_META[m.direction].label}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{fmtNum(m.qty)}</td>
                    <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{m.batch?.name}</td>
                  </tr>
                ))}
                {!movements.length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--c-text-secondary)' }}>لا حركات</td></tr>}
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
      <div className="filter-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="form-group">
          <label className="form-label">نسبة من الستوك الأصلي (%)</label>
          <input className="form-input" type="number" min={0} max={100} value={p.pct}
            onChange={e => p.setPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={{ width: 110 }} />
        </div>
        <div className="form-group">
          <label className="form-label">أو كمية متبقية أقل من</label>
          <input className="form-input" type="number" min={0} value={p.qty}
            onChange={e => p.setQty(Math.max(0, Number(e.target.value) || 0))} style={{ width: 110 }} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', paddingBottom: 10, flex: 1, minWidth: 220 }}>
          يُطلق التنبيه بأيّ الشرطين تحقق أولاً — فايتم ستوكه 1000 لا يُعامَل كايتم ستوكه 30.
        </div>
        {p.data && (
          <div style={{ display: 'flex', gap: 8, paddingBottom: 6 }}>
            {(['out', 'critical', 'low'] as Severity[]).map(s => (
              <span key={s} style={{ background: SEV_META[s].bg, color: SEV_META[s].color, padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700 }}>
                {SEV_META[s].label}: {p.data!.totals[s]}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, paddingBottom: 4 }}>
          <button className="btn btn--secondary" onClick={copyList} disabled={!groups.length}>📋 نسخ القائمة</button>
          {p.canExport && <button className="btn btn--primary" onClick={exportXlsx} disabled={!groups.length}>⬇️ تصدير Excel</button>}
        </div>
      </div>

      {!groups.length ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--c-success)' }}>
          ✓ لا يوجد مذخر يحتاج طلبية بهذه العتبات
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {groups.map(g => (
            <div key={g.warehouseId} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--c-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>🏬 {g.warehouse}</div>
                  <div style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{g.region} — {g.total} ايتم يحتاج طلبية</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['out', 'critical', 'low'] as Severity[]).filter(s => g.counts[s] > 0).map(s => (
                    <span key={s} style={{ background: SEV_META[s].bg, color: SEV_META[s].color, padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                      {SEV_META[s].label} {g.counts[s]}
                    </span>
                  ))}
                </div>
              </div>
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr><th>الحالة</th><th>الايتم</th><th>الشركة</th><th>الافتتاحي</th><th>المتبقي</th><th>%</th><th>الكمية المقترحة</th><th>آخر حركة</th></tr>
                  </thead>
                  <tbody>
                    {g.items.map((it, i) => (
                      <tr key={i}>
                        <td>
                          <span style={{ background: SEV_META[it.severity].bg, color: SEV_META[it.severity].color, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                            {SEV_META[it.severity].label}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{it.itemName}</td>
                        <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{it.companyName ?? '—'}</td>
                        <td>{fmtNum(it.opening)}</td>
                        <td style={{ fontWeight: 700, color: SEV_META[it.severity].color }}>{fmtNum(it.remaining)}</td>
                        <td style={{ fontSize: 12 }}>{it.pctLeft}%</td>
                        <td style={{ fontWeight: 700, color: 'var(--c-accent)' }}>{fmtNum(it.suggestedQty)}</td>
                        <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{fmtDate(it.lastMovementAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

  const reviewBatches = p.batches.filter(b => b.unmatched);

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-group">
            <label className="form-label">تاريخ سريان الدفعة</label>
            <input className="form-input" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 'auto' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--c-text-secondary)', paddingBottom: 10, flex: 1, minWidth: 240 }}>
            ستوك افتتاحي جديد يصفّر أزواج (مذخر+ايتم) الواردة فيه ويهمل حركاتها الأقدم من هذا التاريخ.
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--c-border)' }}>
          {p.canBaseline && (
            <>
              <div className="form-group" style={{ minWidth: 260 }}>
                <label className="form-label">📦 تحديث الستوك من ملف Stock موجود</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="form-input" value={stockFileId}
                    onChange={e => setStockFileId(e.target.value ? Number(e.target.value) : '')} style={{ minWidth: 200 }}>
                    <option value="">اختر ملف...</option>
                    {p.stockFiles.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  <button className="btn btn--primary" disabled={!stockFileId || p.busy === 'baseline'}
                    onClick={() => stockFileId && p.onBaselineFromStock(stockFileId, date)}>
                    {p.busy === 'baseline' ? '⏳' : 'استيراد'}
                  </button>
                </div>
              </div>
              <button className="btn btn--secondary" style={{ marginBottom: 4 }} disabled={p.busy === 'upload'} onClick={() => pick(baseRef)}>
                📥 ستوك افتتاحي من ملف Excel
              </button>
            </>
          )}
          {p.canUpload && (
            <>
              <button className="btn btn--danger" style={{ marginBottom: 4 }} disabled={p.busy === 'upload'} onClick={() => pick(outRef)}>
                ⬇️ رفع مبيع من المذاخر
              </button>
              <button className="btn btn--success" style={{ marginBottom: 4 }} disabled={p.busy === 'upload'} onClick={() => pick(inRef)}>
                ⬆️ رفع تعزيز للمذاخر
              </button>
            </>
          )}
          {p.canManual && (
            <button className="btn btn--secondary" style={{ marginBottom: 4 }} onClick={() => setShowManual(true)}>
              ✍️ إدخال حركة يدوية
            </button>
          )}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--c-text-secondary)' }}>
          أعمدة ملف الحركات: <b>المذخر</b> · المنطقة · الشركة · <b>الايتم</b> · <b>الكمية</b> · التاريخ (الغامق إلزامي).
        </div>
        <input ref={baseRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'baseline', 'استُورد الستوك الافتتاحي')} />
        <input ref={outRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'out', 'أُضيف المبيع')} />
        <input ref={inRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => onPicked(e, 'in', 'أُضيف التعزيز')} />
      </div>

      {reviewBatches.length > 0 && <ReviewPanel batches={reviewBatches} />}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--c-border)', fontWeight: 700 }}>
          🗂️ الدفعات المرفوعة ({p.batches.length})
        </div>
        {!p.batches.length ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--c-text-secondary)' }}>
            لا دفعات بعد — ابدأ باستيراد الستوك الافتتاحي من ملف Stock.
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead><tr><th>النوع</th><th>الاسم</th><th>تاريخ السريان</th><th>الأسطر</th><th>رُفعت</th><th></th></tr></thead>
              <tbody>
                {p.batches.map(b => (
                  <tr key={b.id}>
                    <td>
                      <span style={{ background: KIND_META[b.kind].bg, color: KIND_META[b.kind].color, padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {KIND_META[b.kind].icon} {KIND_META[b.kind].label}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{b.name}</td>
                    <td>{fmtDate(b.movementDate)}</td>
                    <td>{fmtNum(b.rowCount)}</td>
                    <td style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{fmtDate(b.uploadedAt)}</td>
                    <td>
                      {p.canDelete && (
                        <button className="btn-icon btn-icon--red" title="حذف الدفعة وإعادة الحساب"
                          disabled={p.busy === `del-${b.id}`} onClick={() => p.onDelete(b)}>
                          <Icon name="delete" size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

  return (
    <div className="card" style={{ marginBottom: 14, borderRight: '4px solid var(--c-warning)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div style={{ fontWeight: 700 }}>
          ⚠️ مراجعة غير المطابق — {created.length} مذخر جديد · {fuzzy.length} رُبط بالتشابه · {orphans.length} ايتم بلا ستوك افتتاحي
        </div>
        <span style={{ fontSize: 12, color: 'var(--c-text-secondary)' }}>{open ? 'إخفاء ▲' : 'عرض ▼'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12, fontSize: 13 }}>
          {created.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>مذاخر أُنشئت جديدة (تأكد أنها ليست تكراراً لاسم موجود):</div>
              {created.map((c, i) => (
                <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--c-border)' }}>
                  <b>{c.name}</b> — {c.region}
                  {c.suggestions.length > 0 && (
                    <span style={{ color: 'var(--c-warning)', fontSize: 12 }}>
                      {' '}· قريب من: {c.suggestions.map(s => `${s.name} (${s.region})`).join('، ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {fuzzy.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>رُبطت تلقائياً بالتشابه:</div>
              {fuzzy.map((f, i) => (
                <div key={i} style={{ padding: '3px 0', color: 'var(--c-text-secondary)' }}>{f.raw} ← {f.matchedTo}</div>
              ))}
            </div>
          )}
          {orphans.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>ايتمات تحرّكت بلا ستوك افتتاحي (رصيدها سالب حتى ترفع ستوكها):</div>
              {orphans.slice(0, 40).map((o, i) => (
                <div key={i} style={{ padding: '3px 0', color: 'var(--c-text-secondary)' }}>
                  {o.itemName} — {o.warehouse} ({o.region}) · خرج {fmtNum(o.qty)}
                </div>
              ))}
              {orphans.length > 40 && <div style={{ color: 'var(--c-text-secondary)' }}>... و{orphans.length - 40} غيرها</div>}
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
          <div style={{ fontWeight: 700 }}>✍️ إدخال حركة يدوية — {fmtDate(p.date)}</div>
          <button className="btn-icon btn-icon--red" onClick={p.onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['out', 'in', 'baseline'] as const).map(k => (
              <button key={k} className={`btn ${kind === k ? 'btn--primary' : 'btn--secondary'}`} onClick={() => setKind(k)}>
                {KIND_META[k].icon} {KIND_META[k].label}
              </button>
            ))}
          </div>
          <div className="table-wrapper" style={{ maxHeight: 320 }}>
            <table className="table">
              <thead><tr><th>المذخر *</th><th>المنطقة</th><th>الايتم *</th><th>الشركة</th><th>الكمية *</th><th></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input className="form-input" value={r.warehouse} onChange={e => set(i, 'warehouse', e.target.value)} /></td>
                    <td><input className="form-input" value={r.region} onChange={e => set(i, 'region', e.target.value)} /></td>
                    <td><input className="form-input" value={r.itemName} onChange={e => set(i, 'itemName', e.target.value)} /></td>
                    <td><input className="form-input" value={r.companyName} onChange={e => set(i, 'companyName', e.target.value)} /></td>
                    <td><input className="form-input" type="number" min={0} value={r.qty} onChange={e => set(i, 'qty', e.target.value)} style={{ width: 90 }} /></td>
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
          <button className="btn btn--secondary btn--sm" style={{ marginTop: 10 }} onClick={addRow}>+ سطر جديد</button>
        </div>
        <div className="modal-footer">
          <button className="btn btn--secondary" onClick={p.onClose}>إلغاء</button>
          <button className="btn btn--primary" disabled={!valid.length || p.busy}
            onClick={() => p.onSave(kind, valid.map(r => ({
              warehouse: r.warehouse, region: r.region, itemName: r.itemName,
              companyName: r.companyName, qty: Number(r.qty),
            })))}>
            {p.busy ? '⏳ جاري الحفظ...' : `حفظ ${valid.length} سطر`}
          </button>
        </div>
      </div>
    </div>
  );
}
