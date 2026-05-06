import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

// ── Types ──────────────────────────────────────────────────────
interface UpFile { id: number; originalName: string; uploadedAt: string; rowCount: number; }

interface PharmacySummary {
  name: string; areaName: string;
  totalOrders: number; totalQty: number; totalValue: number;
  firstOrder: string; lastOrder: string; itemCount: number; daysSinceLast: number;
  topItems: { name: string; qty: number; value: number; count: number }[];
}

interface ItemSummary {
  name: string; totalQty: number; totalValue: number;
  pharmacyCount: number; firstOrder: string; lastOrder: string;
  topPharmacies: { name: string; areaName: string; qty: number; value: number }[];
}

interface Alert {
  pharmaName: string; itemName: string; areaName: string;
  lastOrder: string; daysSinceLast: number; totalQty: number; orderCount: number;
}

interface PharmacyOrder {
  id: number; itemName: string; areaName: string; repName: string;
  quantity: number; totalValue: number; saleDate: string; recordType: string;
}

interface PharmacyDetail {
  pharmacyName: string; totalOrders: number;
  orders: PharmacyOrder[];
  byItem: { name: string; orders: any[]; totalQty: number; totalValue: number }[];
}

// ── Helpers ─────────────────────────────────────────────────────
function fmt(n: number) { return n.toLocaleString('ar-IQ'); }
function fmtDate(d: string) { return new Date(d).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' }); }
function dayBadge(d: number) {
  if (d < 15)  return { bg: '#dcfce7', color: '#16a34a', label: `${d}` };
  if (d < 30)  return { bg: '#fef9c3', color: '#ca8a04', label: `${d}` };
  if (d < 60)  return { bg: '#ffedd5', color: '#ea580c', label: `${d}` };
  return              { bg: '#fee2e2', color: '#dc2626', label: `${d}` };
}

const TABS = [
  { id: 'pharmacies', label: 'الصيدليات', icon: '🏪' },
  { id: 'items',      label: 'الايتمات',  icon: '💊' },
  { id: 'alerts',     label: 'التنبيهات', icon: '🔔' },
] as const;
type Tab = typeof TABS[number]['id'];

// ── Main Page ────────────────────────────────────────────────────
export default function PharmacyAnalysisPage() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  // File selection
  const [files, setFiles]           = useState<UpFile[]>([]);
  const [selFiles, setSelFiles]     = useState<Set<number>>(new Set());
  const [filesLoading, setFilesLoading] = useState(false);

  // Tab
  const [tab, setTab] = useState<Tab>('pharmacies');

  // Pharmacies tab
  const [pharmacies, setPharmacies]     = useState<PharmacySummary[]>([]);
  const [pharmaLoading, setPharmaLoading] = useState(false);
  const [pharmaSearch, setPharmaSearch] = useState('');
  const [pharmaDetail, setPharmaDetail] = useState<PharmacyDetail | null>(null);
  const [pharmaDetailLoading, setPharmaDetailLoading] = useState(false);
  const [selectedPharma, setSelectedPharma] = useState<string | null>(null);

  // Items tab
  const [items, setItems]         = useState<ItemSummary[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [itemDetail, setItemDetail] = useState<any | null>(null);
  const [itemDetailLoading, setItemDetailLoading] = useState(false);

  // Alerts tab
  const [alerts, setAlerts]         = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertDays, setAlertDays]   = useState(30);
  const [alertSearch, setAlertSearch] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);

  // Build fileIds query string
  const fileIdsParam = [...selFiles].join(',');
  const fileQuery    = fileIdsParam ? `?fileIds=${fileIdsParam}` : '?';

  // ── Load uploaded files ────────────────────────────────────────
  useEffect(() => {
    setFilesLoading(true);
    fetch(`${API}/api/files`, { headers })
      .then(r => r.json())
      .then(d => {
        const all: UpFile[] = Array.isArray(d.data) ? d.data : [];
        setFiles(all);
        // Auto-select all if none chosen yet
        if (all.length > 0) setSelFiles(new Set(all.map(f => f.id)));
      })
      .catch(() => {})
      .finally(() => setFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Load pharmacies ────────────────────────────────────────────
  const loadPharmacies = useCallback((search = pharmaSearch) => {
    setPharmaLoading(true);
    const q = fileQuery + (search ? `&search=${encodeURIComponent(search)}` : '');
    fetch(`${API}/api/pharmacy-analysis/pharmacies${q}`, { headers })
      .then(r => r.json())
      .then(d => setPharmacies(d.pharmacies || []))
      .catch(() => {})
      .finally(() => setPharmaLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, pharmaSearch, token]);

  // ── Load items ─────────────────────────────────────────────────
  const loadItems = useCallback((search = itemSearch) => {
    setItemsLoading(true);
    const q = fileQuery + (search ? `&search=${encodeURIComponent(search)}` : '');
    fetch(`${API}/api/pharmacy-analysis/items${q}`, { headers })
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(() => {})
      .finally(() => setItemsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, itemSearch, token]);

  // ── Load alerts ────────────────────────────────────────────────
  const loadAlerts = useCallback(() => {
    setAlertsLoading(true);
    fetch(`${API}/api/pharmacy-analysis/alerts${fileQuery}&days=${alertDays}`, { headers })
      .then(r => r.json())
      .then(d => setAlerts(d.alerts || []))
      .catch(() => {})
      .finally(() => setAlertsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, alertDays, token]);

  // Auto-load on file selection change
  useEffect(() => { if (tab === 'pharmacies') loadPharmacies(); }, [fileIdsParam]);
  useEffect(() => { if (tab === 'items') loadItems(); }, [fileIdsParam]);
  useEffect(() => { if (tab === 'alerts') loadAlerts(); }, [fileIdsParam, alertDays]);

  // Load on tab change
  useEffect(() => {
    if (tab === 'pharmacies') loadPharmacies();
    else if (tab === 'items') loadItems();
    else if (tab === 'alerts') loadAlerts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ── Open pharmacy detail ───────────────────────────────────────
  const openPharma = (name: string) => {
    setSelectedPharma(name);
    setPharmaDetailLoading(true);
    fetch(`${API}/api/pharmacy-analysis/pharmacy/${encodeURIComponent(name)}${fileQuery}`, { headers })
      .then(r => r.json())
      .then(d => setPharmaDetail(d))
      .catch(() => {})
      .finally(() => setPharmaDetailLoading(false));
  };

  // ── Open item detail ───────────────────────────────────────────
  const openItem = (name: string) => {
    setSelectedItem(name);
    setItemDetailLoading(true);
    fetch(`${API}/api/pharmacy-analysis/item/${encodeURIComponent(name)}${fileQuery}`, { headers })
      .then(r => r.json())
      .then(d => setItemDetail(d))
      .catch(() => {})
      .finally(() => setItemDetailLoading(false));
  };

  // ── Search debounce ────────────────────────────────────────────
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const onPharmaSearch = (v: string) => {
    setPharmaSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadPharmacies(v), 350);
  };
  const onItemSearch = (v: string) => {
    setItemSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadItems(v), 350);
  };

  // Filter alerts client-side (already small dataset)
  const filteredAlerts = alerts.filter(a =>
    !alertSearch ||
    a.pharmaName.includes(alertSearch) ||
    a.itemName.includes(alertSearch) ||
    a.areaName.includes(alertSearch)
  );

  const toggleFile = (id: number) => {
    setSelFiles(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  return (
    <div style={{ padding: '20px 16px', direction: 'rtl', fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif', background: '#f8fafc', minHeight: '100vh' }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ background: 'linear-gradient(135deg, #1a56db, #7c3aed)', borderRadius: 14, padding: '10px 14px', fontSize: 24 }}>🔬</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#1e293b' }}>تحليل عميق للصيدليات والمبيعات</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>تحليل شامل لكل صيدلية وكل ايتم عبر الملفات المرفوعة</p>
        </div>
      </div>

      {/* ── File Selector ── */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 18px', marginBottom: 18, boxShadow: '0 1px 4px rgba(0,0,0,.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>📂 اختر الملفات للتحليل</span>
          <button onClick={() => setSelFiles(new Set(files.map(f => f.id)))} style={btnStyle('#eff6ff', '#1d4ed8')}>تحديد الكل</button>
          <button onClick={() => setSelFiles(new Set())} style={btnStyle('#f1f5f9', '#64748b')}>إلغاء الكل</button>
          <span style={{ marginRight: 'auto', fontSize: 12, color: '#94a3b8' }}>
            {selFiles.size} / {files.length} ملف محدد
          </span>
        </div>
        {filesLoading ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>جاري تحميل الملفات...</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {files.map(f => (
              <div
                key={f.id}
                onClick={() => toggleFile(f.id)}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                  border: selFiles.has(f.id) ? '1.5px solid #1a56db' : '1.5px solid #e2e8f0',
                  background: selFiles.has(f.id) ? '#eff6ff' : '#f8fafc',
                  color: selFiles.has(f.id) ? '#1a56db' : '#64748b',
                  fontWeight: selFiles.has(f.id) ? 700 : 400,
                  transition: 'all .15s',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {selFiles.has(f.id) ? '✓' : '○'} {f.originalName}
                <span style={{ opacity: .6 }}>({f.rowCount} سجل)</span>
              </div>
            ))}
            {files.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>لا توجد ملفات مرفوعة</span>}
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setSelectedPharma(null); setSelectedItem(null); }}
            style={{
              padding: '9px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: tab === t.id ? 'linear-gradient(135deg, #1a56db, #7c3aed)' : '#fff',
              color: tab === t.id ? '#fff' : '#374151',
              fontWeight: tab === t.id ? 700 : 500,
              fontSize: 14,
              boxShadow: tab === t.id ? '0 2px 8px rgba(26,86,219,.25)' : '0 1px 3px rgba(0,0,0,.06)',
              transition: 'all .15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span>{t.icon}</span> {t.label}
            {t.id === 'alerts' && alerts.length > 0 && (
              <span style={{ background: '#dc2626', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 800 }}>{alerts.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ════════ PHARMACIES TAB ════════ */}
      {tab === 'pharmacies' && !selectedPharma && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={searchRef}
              value={pharmaSearch} onChange={e => onPharmaSearch(e.target.value)}
              placeholder="🔍  بحث باسم الصيدلية أو المنطقة..."
              style={searchStyle}
            />
            <button onClick={() => loadPharmacies()} style={refreshBtn}>↻ تحديث</button>
            <span style={{ fontSize: 13, color: '#64748b' }}>{pharmacies.length} صيدلية</span>
          </div>
          {pharmaLoading ? <Loader /> : (
            <div style={{ display: 'grid', gap: 12 }}>
              {pharmacies.map(p => (
                <PharmacyCard key={p.name} p={p} onClick={() => openPharma(p.name)} />
              ))}
              {pharmacies.length === 0 && <Empty msg="لا توجد بيانات. ارفع ملفات مبيعات وابدأ التحليل." />}
            </div>
          )}
        </div>
      )}

      {/* ── Pharmacy Detail ── */}
      {tab === 'pharmacies' && selectedPharma && (
        <div>
          <button onClick={() => { setSelectedPharma(null); setPharmaDetail(null); }} style={backBtn}>
            ← رجوع للقائمة
          </button>
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '20px 24px', marginTop: 10, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#1e293b' }}>🏪 {selectedPharma}</h2>
            {pharmaDetailLoading ? <Loader /> : pharmaDetail ? (
              <>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
                  <StatChip icon="📦" label="إجمالي الطلبيات" value={fmt(pharmaDetail.totalOrders)} />
                </div>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#374151', margin: '20px 0 10px' }}>📊 تفاصيل حسب الايتم</h3>
                <div style={{ display: 'grid', gap: 10 }}>
                  {pharmaDetail.byItem.map(b => (
                    <div key={b.name} style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 16px', border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                        <span style={{ fontWeight: 700, color: '#1e293b', fontSize: 15 }}>💊 {b.name}</span>
                        <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                          <span style={{ color: '#7c3aed' }}>الكمية: <b>{fmt(b.totalQty)}</b></span>
                          <span style={{ color: '#059669' }}>القيمة: <b>{fmt(b.totalValue)}</b></span>
                        </div>
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={tableStyle}>
                          <thead><tr>
                            <th style={thStyle}>التاريخ</th>
                            <th style={thStyle}>الكمية</th>
                            <th style={thStyle}>القيمة</th>
                            <th style={thStyle}>المندوب</th>
                            <th style={thStyle}>النوع</th>
                          </tr></thead>
                          <tbody>
                            {b.orders.map((o: any, i: number) => (
                              <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                                <td style={tdStyle}>{fmtDate(o.date)}</td>
                                <td style={tdStyle}>{fmt(o.qty)}</td>
                                <td style={tdStyle}>{fmt(o.value)}</td>
                                <td style={tdStyle}>{o.rep || '—'}</td>
                                <td style={tdStyle}>
                                  <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: o.type === 'return' ? '#fee2e2' : '#dcfce7', color: o.type === 'return' ? '#dc2626' : '#16a34a' }}>
                                    {o.type === 'return' ? 'مرتجع' : 'بيع'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* ════════ ITEMS TAB ════════ */}
      {tab === 'items' && !selectedItem && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={itemSearch} onChange={e => onItemSearch(e.target.value)}
              placeholder="🔍  بحث باسم الايتم..."
              style={searchStyle}
            />
            <button onClick={() => loadItems()} style={refreshBtn}>↻ تحديث</button>
            <span style={{ fontSize: 13, color: '#64748b' }}>{items.length} ايتم</span>
          </div>
          {itemsLoading ? <Loader /> : (
            <div style={{ display: 'grid', gap: 12 }}>
              {items.map(it => (
                <ItemCard key={it.name} it={it} onClick={() => openItem(it.name)} />
              ))}
              {items.length === 0 && <Empty msg="لا توجد بيانات ايتمات." />}
            </div>
          )}
        </div>
      )}

      {/* ── Item Detail ── */}
      {tab === 'items' && selectedItem && (
        <div>
          <button onClick={() => { setSelectedItem(null); setItemDetail(null); }} style={backBtn}>
            ← رجوع للقائمة
          </button>
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '20px 24px', marginTop: 10, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#1e293b' }}>💊 {selectedItem}</h2>
            {itemDetailLoading ? <Loader /> : itemDetail ? (
              <>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
                  <StatChip icon="🏪" label="عدد الصيدليات" value={fmt(itemDetail.pharmacies?.length || 0)} />
                  <StatChip icon="📦" label="إجمالي الطلبيات" value={fmt(itemDetail.totalOrders || 0)} />
                </div>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#374151', margin: '20px 0 10px' }}>🏪 الصيدليات التي اشترت هذا الايتم</h3>
                <div style={{ display: 'grid', gap: 10 }}>
                  {(itemDetail.pharmacies || []).map((ph: any) => {
                    const badge = dayBadge(Math.floor((Date.now() - new Date(ph.lastOrder).getTime()) / 86400000));
                    return (
                      <div key={ph.name} style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 16px', border: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                          <div>
                            <span style={{ fontWeight: 700, color: '#1e293b', fontSize: 15 }}>🏪 {ph.name}</span>
                            {ph.areaName && <span style={{ marginRight: 8, fontSize: 12, color: '#64748b' }}>📍 {ph.areaName}</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
                            <span style={{ color: '#7c3aed' }}>الكمية: <b>{fmt(ph.totalQty)}</b></span>
                            <span style={{ background: badge.bg, color: badge.color, padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700 }}>
                              آخر طلبية: {badge.label} يوم
                            </span>
                          </div>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={tableStyle}>
                            <thead><tr>
                              <th style={thStyle}>التاريخ</th>
                              <th style={thStyle}>الكمية</th>
                              <th style={thStyle}>القيمة</th>
                              <th style={thStyle}>المندوب</th>
                              <th style={thStyle}>النوع</th>
                            </tr></thead>
                            <tbody>
                              {ph.orders.map((o: any, i: number) => (
                                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                                  <td style={tdStyle}>{fmtDate(o.date)}</td>
                                  <td style={tdStyle}>{fmt(o.qty)}</td>
                                  <td style={tdStyle}>{fmt(o.value)}</td>
                                  <td style={tdStyle}>{o.rep || '—'}</td>
                                  <td style={tdStyle}>
                                    <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: o.type === 'return' ? '#fee2e2' : '#dcfce7', color: o.type === 'return' ? '#dc2626' : '#16a34a' }}>
                                      {o.type === 'return' ? 'مرتجع' : 'بيع'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* ════════ ALERTS TAB ════════ */}
      {tab === 'alerts' && (
        <div>
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 18px', marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,.04)', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: '#374151' }}>⚙️ حد التنبيه:</span>
            {[14, 30, 60, 90].map(d => (
              <button key={d} onClick={() => setAlertDays(d)} style={{
                padding: '5px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 13,
                background: alertDays === d ? '#1a56db' : '#f1f5f9',
                color: alertDays === d ? '#fff' : '#374151',
                fontWeight: alertDays === d ? 700 : 500,
              }}>{d} يوم</button>
            ))}
            <input
              type="number" value={alertDays} min={1} max={365}
              onChange={e => setAlertDays(Number(e.target.value))}
              style={{ width: 70, padding: '5px 8px', borderRadius: 8, border: '1.5px solid #e2e8f0', fontSize: 13, textAlign: 'center' }}
            />
            <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 'auto' }}>
              {filteredAlerts.length} تنبيه نشط
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <input
              value={alertSearch} onChange={e => setAlertSearch(e.target.value)}
              placeholder="🔍  بحث في التنبيهات..."
              style={searchStyle}
            />
            <button onClick={loadAlerts} style={refreshBtn}>↻ تحديث</button>
          </div>

          {alertsLoading ? <Loader /> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {filteredAlerts.map((a, i) => {
                const badge = dayBadge(a.daysSinceLast);
                return (
                  <div key={i} style={{
                    background: '#fff', borderRadius: 12, padding: '14px 18px',
                    border: `1.5px solid ${a.daysSinceLast >= 60 ? '#fca5a5' : a.daysSinceLast >= 30 ? '#fdba74' : '#e2e8f0'}`,
                    boxShadow: '0 1px 4px rgba(0,0,0,.04)',
                    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
                  }}>
                    <div style={{ fontSize: 20 }}>{a.daysSinceLast >= 60 ? '🚨' : a.daysSinceLast >= 30 ? '⚠️' : '🔔'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', marginBottom: 3 }}>
                        🏪 {a.pharmaName}
                      </div>
                      <div style={{ fontSize: 13, color: '#64748b', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <span>💊 {a.itemName}</span>
                        {a.areaName && <span>📍 {a.areaName}</span>}
                        <span>📦 الكمية السابقة: {fmt(a.totalQty)}</span>
                        <span>🔁 عدد الطلبيات: {a.orderCount}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ background: badge.bg, color: badge.color, borderRadius: 10, padding: '4px 14px', fontWeight: 800, fontSize: 16 }}>
                        {badge.label}
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>يوم بدون طلبية</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>آخر طلبية: {fmtDate(a.lastOrder)}</div>
                    </div>
                  </div>
                );
              })}
              {filteredAlerts.length === 0 && (
                <Empty msg={alertSearch ? 'لا يوجد تنبيه يطابق البحث.' : `لا توجد صيدلية متأخرة عن ${alertDays} يوم. ✅`} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function PharmacyCard({ p, onClick }: { p: PharmacySummary; onClick: () => void }) {
  const badge = dayBadge(p.daysSinceLast);
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff', borderRadius: 14, padding: '16px 20px', cursor: 'pointer',
        border: '1.5px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.04)',
        transition: 'transform .12s, box-shadow .12s',
      }}
      onMouseOver={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(26,86,219,.12)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
      onMouseOut={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 1px 4px rgba(0,0,0,.04)'; (e.currentTarget as HTMLElement).style.transform = ''; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#1e293b' }}>🏪 {p.name}</div>
          {p.areaName && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>📍 {p.areaName}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ background: badge.bg, color: badge.color, borderRadius: 10, padding: '3px 12px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>{badge.label}</div>
            <div style={{ fontSize: 10 }}>يوم</div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: '#64748b' }}>📦 <b style={{ color: '#1e293b' }}>{p.totalOrders}</b> طلبية</div>
        <div style={{ fontSize: 13, color: '#64748b' }}>💊 <b style={{ color: '#7c3aed' }}>{p.itemCount}</b> ايتم</div>
        <div style={{ fontSize: 13, color: '#64748b' }}>📊 <b style={{ color: '#059669' }}>{fmt(p.totalValue)}</b> د.ع</div>
        <div style={{ fontSize: 13, color: '#64748b' }}>📅 آخر طلبية: <b>{new Date(p.lastOrder).toLocaleDateString('ar-IQ')}</b></div>
      </div>
      {p.topItems.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {p.topItems.map(it => (
            <span key={it.name} style={{ background: '#f1f5f9', borderRadius: 8, padding: '3px 9px', fontSize: 11, color: '#374151' }}>
              {it.name} <span style={{ color: '#7c3aed', fontWeight: 700 }}>×{it.qty}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemCard({ it, onClick }: { it: ItemSummary; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff', borderRadius: 14, padding: '16px 20px', cursor: 'pointer',
        border: '1.5px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,.04)',
        transition: 'transform .12s, box-shadow .12s',
      }}
      onMouseOver={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(124,58,237,.12)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
      onMouseOut={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 1px 4px rgba(0,0,0,.04)'; (e.currentTarget as HTMLElement).style.transform = ''; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: '#1e293b' }}>💊 {it.name}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
          <span style={{ color: '#7c3aed', fontWeight: 700 }}>الكمية: {fmt(it.totalQty)}</span>
          <span style={{ color: '#059669', fontWeight: 700 }}>{fmt(it.totalValue)} د.ع</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: '#64748b' }}>🏪 <b style={{ color: '#1e293b' }}>{it.pharmacyCount}</b> صيدلية</div>
        <div style={{ fontSize: 13, color: '#64748b' }}>📅 أول طلبية: <b>{new Date(it.firstOrder).toLocaleDateString('ar-IQ')}</b></div>
        <div style={{ fontSize: 13, color: '#64748b' }}>📅 آخر طلبية: <b>{new Date(it.lastOrder).toLocaleDateString('ar-IQ')}</b></div>
      </div>
      {it.topPharmacies.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {it.topPharmacies.map(ph => (
            <span key={ph.name} style={{ background: '#f3f0ff', borderRadius: 8, padding: '3px 9px', fontSize: 11, color: '#5b21b6' }}>
              {ph.name} <span style={{ fontWeight: 700 }}>×{fmt(ph.qty)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatChip({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 18 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, color: '#64748b' }}>{label}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#1e293b' }}>{value}</div>
      </div>
    </div>
  );
}

function Loader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#94a3b8', gap: 10 }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: '3px solid #dde3ef', borderTopColor: '#1a56db', animation: 'spin .7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize: 14 }}>جاري تحميل البيانات...</span>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: '#94a3b8', background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
      <div style={{ fontSize: 15 }}>{msg}</div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────
const searchStyle: React.CSSProperties = {
  flex: 1, minWidth: 200, maxWidth: 420,
  padding: '9px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  fontSize: 14, outline: 'none', direction: 'rtl',
  background: '#fff',
};
const refreshBtn: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 14, fontWeight: 600,
};
const backBtn: React.CSSProperties = {
  padding: '8px 18px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 14, fontWeight: 600,
};
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13, direction: 'rtl',
};
const thStyle: React.CSSProperties = {
  padding: '8px 12px', background: '#f1f5f9', color: '#374151',
  fontWeight: 700, textAlign: 'right', borderBottom: '1.5px solid #e2e8f0',
};
const tdStyle: React.CSSProperties = {
  padding: '7px 12px', borderBottom: '1px solid #f1f5f9', color: '#374151',
};
function btnStyle(bg: string, color: string): React.CSSProperties {
  return { padding: '4px 12px', borderRadius: 8, border: 'none', background: bg, color, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
}
