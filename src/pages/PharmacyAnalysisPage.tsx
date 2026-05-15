import { useState, useEffect, useCallback, useRef, DragEvent } from 'react';
import { useAuth } from '../context/AuthContext';

const API = import.meta.env.VITE_API_URL || '';

// ── Types ─────────────────────────────────────────────────────
interface UpFile { id: number; originalName: string; uploadedAt: string; rowCount: number; }

interface PharmacySummary {
  name: string; areaName: string; repName: string;
  totalOrders: number; totalQty: number; totalValue: number;
  returnsQty: number; returnsValue: number;
  firstOrder: string | null; lastOrder: string | null; itemCount: number; daysSinceLast: number;
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

// ── Helpers ───────────────────────────────────────────────────
function fmt(n: number) { return n.toLocaleString('ar-IQ'); }
function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString('ar-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return d; }
}
function dayColor(d: number): { bg: string; color: string } {
  if (d < 15)  return { bg: '#ecfdf5', color: '#059669' };
  if (d < 30)  return { bg: '#fefce8', color: '#b45309' };
  if (d < 60)  return { bg: '#fff7ed', color: '#c2410c' };
  return              { bg: '#fef2f2', color: '#dc2626' };
}

const TABS = [
  { id: 'pharmacies', label: 'الصيدليات',  icon: '🏪' },
  { id: 'items',      label: 'الايتمات',   icon: '💊' },
  { id: 'alerts',     label: 'التنبيهات',  icon: '🔔' },
] as const;
type Tab = typeof TABS[number]['id'];
type GroupBy = 'none' | 'area' | 'rep' | 'item' | 'date';

// ── Main Page ─────────────────────────────────────────────────
export default function PharmacyAnalysisPage() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [files, setFiles]           = useState<UpFile[]>([]);
  const [selFiles, setSelFiles]     = useState<Set<number>>(new Set());
  const [filesLoading, setFilesLoading] = useState(false);
  const [tab, setTab]               = useState<Tab>('pharmacies');

  // Pharmacies
  const [pharmacies, setPharmacies]         = useState<PharmacySummary[]>([]);
  const [pharmaLoading, setPharmaLoading]   = useState(false);
  const [pharmaSearch, setPharmaSearch]     = useState('');
  const [groupBy, setGroupBy]               = useState<GroupBy>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [pharmaDetail, setPharmaDetail]     = useState<PharmacyDetail | null>(null);
  const [pharmaDetailLoading, setPharmaDetailLoading] = useState(false);
  const [selectedPharma, setSelectedPharma] = useState<string | null>(null);
  const [expandedRows, setExpandedRows]     = useState<Set<string>>(new Set());

  // Sort
  const [pharmaSortCol, setPharmaSortCol] = useState<string | null>(null);
  const [pharmaSortDir, setPharmaSortDir] = useState<'asc' | 'desc'>('asc');
  const [itemSortCol, setItemSortCol]     = useState<string | null>(null);
  const [itemSortDir, setItemSortDir]     = useState<'asc' | 'desc'>('asc');
  const [alertSortCol, setAlertSortCol]   = useState<string | null>(null);
  const [alertSortDir, setAlertSortDir]   = useState<'asc' | 'desc'>('asc');

  // Items
  const [items, setItems]               = useState<ItemSummary[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemSearch, setItemSearch]     = useState('');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [itemDetail, setItemDetail]     = useState<any | null>(null);
  const [itemDetailLoading, setItemDetailLoading] = useState(false);

  // Alerts
  const [alerts, setAlerts]             = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertDays, setAlertDays]       = useState(30);
  const [alertSearch, setAlertSearch]   = useState('');

  // Upload
  // Currency display toggle
  const [dispCurrency, setDispCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [dispRate, setDispRate]         = useState<number>(1470);
  const [showRateEdit, setShowRateEdit] = useState(false);
  const [rateInput, setRateInput]       = useState('1470');
  // cv: convert IQD value for display
  const cv = (v: number) => dispCurrency === 'USD' ? v / dispRate : v;
  const fmtV = (v: number) => dispCurrency === 'USD'
    ? (v / dispRate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : fmt(Math.round(v));
  const currLabel = dispCurrency === 'IQD' ? 'د.ع' : '$';

  const [uploading, setUploading]       = useState(false);
  const [uploadMsg, setUploadMsg]       = useState<{ ok: boolean; text: string } | null>(null);
  const [dragOver, setDragOver]         = useState(false);
  const [showUpload, setShowUpload]     = useState(false);
  const [clearing, setClearing]         = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<number | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const searchTimer    = useRef<ReturnType<typeof setTimeout>>();

  // Pre-upload currency selection
  const [pendingFile, setPendingFile]   = useState<File | null>(null);
  const [preCurrency, setPreCurrency]   = useState<'IQD' | 'USD'>('USD');
  const [preRate, setPreRate]           = useState<string>('1470');

  const requestUpload = (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setUploadMsg({ ok: false, text: 'يُسمح فقط بـ Excel أو CSV' }); return; }
    setPreCurrency('USD');
    setPreRate('1470');
    setPendingFile(file);
  };

  const uploadFile = useCallback(async (file: File, sourceCurrency: 'IQD' | 'USD', exchangeRate: number) => {
    setUploading(true); setUploadMsg(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('fileType', 'pharmacy_net');
    fd.append('sourceCurrency', sourceCurrency);
    try {
      const res  = await fetch(`${API}/api/upload-sales`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل الرفع');
      const newId = data.data?.uploadedFile?.id ?? data.uploadedFile?.id;
      // Save exchange rate on the uploaded file
      if (newId) {
        await fetch(`${API}/api/files/${newId}/currency`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ currencyMode: sourceCurrency, exchangeRate, sourceCurrency }),
        });
      }
      setUploadMsg({ ok: true, text: `تم رفع ${file.name} — ${data.data?.rowCount ?? ''} سجل` });
      const r2 = await fetch(`${API}/api/files?context=pharmacy_net`, { headers: { Authorization: `Bearer ${token}` } });
      const d2 = await r2.json();
      const all: UpFile[] = Array.isArray(d2.data) ? d2.data : [];
      setFiles(all);
      setSelFiles(prev => { const s = new Set(prev); if (newId) s.add(newId); return s; });
      setTimeout(() => setUploadMsg(null), 7000);
    } catch (e: any) { setUploadMsg({ ok: false, text: e.message || 'حدث خطأ' }); }
    finally { setUploading(false); }
  }, [token]);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) requestUpload(file); };

  const clearAllData = async () => {
    setClearing(true);
    try {
      for (const f of files) {
        await fetch(`${API}/api/files/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      }
      setFiles([]);
      setSelFiles(new Set());
      setPharmacies([]);
      setItems([]);
      setAlerts([]);
      setSelectedPharma(null);
      setSelectedItem(null);
    } finally { setClearing(false); setShowClearConfirm(false); }
  };

  const deleteOneFile = async (id: number) => {
    setDeletingFileId(id);
    try {
      await fetch(`${API}/api/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setFiles(prev => prev.filter(f => f.id !== id));
      setSelFiles(prev => { const s = new Set(prev); s.delete(id); return s; });
      if (selectedPharma) setSelectedPharma(null);
      if (selectedItem)   setSelectedItem(null);
    } finally { setDeletingFileId(null); setConfirmDeleteFileId(null); }
  };

  const fileIdsParam = [...selFiles].join(',');
  const fileQuery    = fileIdsParam ? `?fileIds=${fileIdsParam}` : '?';

  useEffect(() => {
    setFilesLoading(true);
    fetch(`${API}/api/files?context=pharmacy_net`, { headers }).then(r => r.json()).then(d => {
      const all: UpFile[] = Array.isArray(d.data) ? d.data : [];
      setFiles(all);
      if (all.length > 0) setSelFiles(new Set(all.map(f => f.id)));
    }).catch(() => {}).finally(() => setFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadPharmacies = useCallback((search = pharmaSearch) => {
    if (selFiles.size === 0) { setPharmacies([]); setPharmaLoading(false); return; }
    setPharmaLoading(true);
    const q = fileQuery + (search ? `&search=${encodeURIComponent(search)}` : '');
    fetch(`${API}/api/pharmacy-analysis/pharmacies${q}`, { headers })
      .then(r => r.json()).then(d => setPharmacies(d.pharmacies || [])).catch(() => {}).finally(() => setPharmaLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, pharmaSearch, token]);

  const loadItems = useCallback((search = itemSearch) => {
    if (selFiles.size === 0) { setItems([]); setItemsLoading(false); return; }
    setItemsLoading(true);
    const q = fileQuery + (search ? `&search=${encodeURIComponent(search)}` : '');
    fetch(`${API}/api/pharmacy-analysis/items${q}`, { headers })
      .then(r => r.json()).then(d => setItems(d.items || [])).catch(() => {}).finally(() => setItemsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, itemSearch, token]);

  const loadAlerts = useCallback(() => {
    if (selFiles.size === 0) { setAlerts([]); setAlertsLoading(false); return; }
    setAlertsLoading(true);
    fetch(`${API}/api/pharmacy-analysis/alerts${fileQuery}&days=${alertDays}`, { headers })
      .then(r => r.json()).then(d => setAlerts(d.alerts || [])).catch(() => {}).finally(() => setAlertsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdsParam, alertDays, token]);

  useEffect(() => { if (tab === 'pharmacies') loadPharmacies(); }, [fileIdsParam]);
  useEffect(() => { if (tab === 'items')      loadItems();      }, [fileIdsParam]);
  useEffect(() => { if (tab === 'alerts')     loadAlerts();     }, [fileIdsParam, alertDays]);
  useEffect(() => {
    if (tab === 'pharmacies') loadPharmacies();
    else if (tab === 'items') loadItems();
    else if (tab === 'alerts') loadAlerts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const openPharma = (name: string) => {
    setSelectedPharma(name); setPharmaDetailLoading(true);
    fetch(`${API}/api/pharmacy-analysis/pharmacy/${encodeURIComponent(name)}${fileQuery}`, { headers })
      .then(r => r.json()).then(d => setPharmaDetail(d)).catch(() => {}).finally(() => setPharmaDetailLoading(false));
  };
  const openItem = (name: string) => {
    setSelectedItem(name); setItemDetailLoading(true);
    fetch(`${API}/api/pharmacy-analysis/item/${encodeURIComponent(name)}${fileQuery}`, { headers })
      .then(r => r.json()).then(d => setItemDetail(d)).catch(() => {}).finally(() => setItemDetailLoading(false));
  };

  const onPharmaSearch = (v: string) => { setPharmaSearch(v); clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => loadPharmacies(v), 350); };
  const onItemSearch   = (v: string) => { setItemSearch(v);   clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => loadItems(v),    350); };

  const toggleGroup = (key: string) => setCollapsedGroups(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  const toggleRow   = (key: string) => setExpandedRows(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  const toggleFile  = (id: number)  => setSelFiles(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const filteredAlerts = alerts.filter(a => {
    if (!alertSearch) return true;
    const q = alertSearch.toLowerCase();
    return (
      a.pharmaName.toLowerCase().includes(q) ||
      a.itemName.toLowerCase().includes(q) ||
      (a.areaName || '').toLowerCase().includes(q)
    );
  });

  // ── Sort handlers ─────────────────────────────────────────────
  const handlePharmaSort = (col: string) => {
    if (pharmaSortCol === col) setPharmaSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setPharmaSortCol(col); setPharmaSortDir('asc'); }
  };
  const handleItemSort = (col: string) => {
    if (itemSortCol === col) setItemSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setItemSortCol(col); setItemSortDir('asc'); }
  };
  const handleAlertSort = (col: string) => {
    if (alertSortCol === col) setAlertSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setAlertSortCol(col); setAlertSortDir('asc'); }
  };
  const sortArrow = (col: string, activeCol: string | null, dir: 'asc' | 'desc') =>
    activeCol === col ? (dir === 'asc' ? ' ↑' : ' ↓') : '';

  const sortedPharmacies: PharmacySummary[] = (() => {
    if (!pharmaSortCol) return pharmacies;
    return [...pharmacies].sort((a, b) => {
      let av: any, bv: any;
      if      (pharmaSortCol === 'name')   { av = a.name;            bv = b.name; }
      else if (pharmaSortCol === 'area')   { av = a.areaName || '';  bv = b.areaName || ''; }
      else if (pharmaSortCol === 'orders') { av = a.totalOrders;     bv = b.totalOrders; }
      else if (pharmaSortCol === 'qty')    { av = a.totalQty;        bv = b.totalQty; }
      else if (pharmaSortCol === 'value')   { av = a.totalValue;        bv = b.totalValue; }
      else if (pharmaSortCol === 'returns')  { av = a.returnsQty;        bv = b.returnsQty; }
      else if (pharmaSortCol === 'items')    { av = a.itemCount;          bv = b.itemCount; }
      else if (pharmaSortCol === 'last')     { av = new Date(a.lastOrder ?? 0).getTime(); bv = new Date(b.lastOrder ?? 0).getTime(); }
      else if (pharmaSortCol === 'days')   { av = a.daysSinceLast;   bv = b.daysSinceLast; }
      else return 0;
      if (typeof av === 'string') return pharmaSortDir === 'asc' ? av.localeCompare(bv, 'ar') : bv.localeCompare(av, 'ar');
      return pharmaSortDir === 'asc' ? av - bv : bv - av;
    });
  })();

  const sortedItems: ItemSummary[] = (() => {
    if (!itemSortCol) return items;
    return [...items].sort((a, b) => {
      let av: any, bv: any;
      if      (itemSortCol === 'name')    { av = a.name;           bv = b.name; }
      else if (itemSortCol === 'qty')    { av = a.totalQty;       bv = b.totalQty; }
      else if (itemSortCol === 'value')  { av = a.totalValue;     bv = b.totalValue; }
      else if (itemSortCol === 'pharmas'){ av = a.pharmacyCount;  bv = b.pharmacyCount; }
      else if (itemSortCol === 'first')  { av = new Date(a.firstOrder).getTime(); bv = new Date(b.firstOrder).getTime(); }
      else if (itemSortCol === 'last')   { av = new Date(a.lastOrder).getTime();  bv = new Date(b.lastOrder).getTime(); }
      else return 0;
      if (typeof av === 'string') return itemSortDir === 'asc' ? av.localeCompare(bv, 'ar') : bv.localeCompare(av, 'ar');
      return itemSortDir === 'asc' ? av - bv : bv - av;
    });
  })();

  const sortedAlerts = (() => {
    const base = filteredAlerts;
    if (!alertSortCol) return base;
    return [...base].sort((a, b) => {
      let av: any, bv: any;
      if      (alertSortCol === 'pharma') { av = a.pharmaName;       bv = b.pharmaName; }
      else if (alertSortCol === 'item')   { av = a.itemName;         bv = b.itemName; }
      else if (alertSortCol === 'area')   { av = a.areaName || '';   bv = b.areaName || ''; }
      else if (alertSortCol === 'qty')    { av = a.totalQty;         bv = b.totalQty; }
      else if (alertSortCol === 'orders') { av = a.orderCount;       bv = b.orderCount; }
      else if (alertSortCol === 'last')   { av = new Date(a.lastOrder).getTime(); bv = new Date(b.lastOrder).getTime(); }
      else if (alertSortCol === 'days')   { av = a.daysSinceLast;    bv = b.daysSinceLast; }
      else return 0;
      if (typeof av === 'string') return alertSortDir === 'asc' ? av.localeCompare(bv, 'ar') : bv.localeCompare(av, 'ar');
      return alertSortDir === 'asc' ? av - bv : bv - av;
    });
  })();

  // ── Group pharmacies ─────────────────────────────────────────
  type Group = { key: string; label: string; rows: PharmacySummary[] };
  const grouped: Group[] = (() => {
    if (groupBy === 'none') return [{ key: '__all__', label: '', rows: sortedPharmacies }];
    const map = new Map<string, PharmacySummary[]>();
    for (const p of sortedPharmacies) {
      let key: string;
      if (groupBy === 'area')   key = p.areaName?.trim() || 'غير محدد';
      else if (groupBy === 'rep')  key = p.repName?.trim() || 'غير محدد';
      else if (groupBy === 'item') key = p.topItems[0]?.name?.trim() || 'غير محدد';
      else if (groupBy === 'date') key = p.lastOrder ? new Date(p.lastOrder).toLocaleDateString('ar-IQ', { year: 'numeric', month: 'long' }) : 'غير محدد';
      else key = 'غير محدد';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar')).map(([k, rows]) => ({ key: k, label: k, rows }));
  })();

  // ─────────────────────────────────────────────────────────────
  return (
    <div dir="rtl" style={{ fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif', background: '#f0f4f8', minHeight: '100vh', padding: '16px 18px' }}>

      {/* ── Pre-upload currency dialog ─────────────────────── */}
      {pendingFile && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', minWidth: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', textAlign: 'center' }} dir="rtl">
            <div style={{ fontSize: 22, marginBottom: 6 }}>💱</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#1e293b', marginBottom: 4 }}>عملة الملف</div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18 }}>{pendingFile.name}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
              {(['IQD', 'USD'] as const).map(c => (
                <button key={c} onClick={() => setPreCurrency(c)} style={{
                  padding: '8px 22px', borderRadius: 8, border: `2px solid ${preCurrency === c ? '#1e40af' : '#e2e8f0'}`,
                  background: preCurrency === c ? '#eff6ff' : '#f8fafc',
                  color: preCurrency === c ? '#1e40af' : '#64748b',
                  fontWeight: preCurrency === c ? 700 : 500, fontSize: 14, cursor: 'pointer',
                }}>
                  {c === 'IQD' ? 'د.ع دينار عراقي' : '$ دولار'}
                </button>
              ))}
            </div>
            {preCurrency === 'USD' && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: '#64748b' }}>سعر الصرف (دولار → دينار):</span>
                <input
                  type="number" min="1" value={preRate}
                  onChange={e => setPreRate(e.target.value)}
                  style={{ width: 90, padding: '5px 8px', borderRadius: 7, border: '1.5px solid #cbd5e1', fontSize: 13, textAlign: 'center' }}
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                onClick={() => {
                  const rate = parseFloat(preRate);
                  uploadFile(pendingFile, preCurrency, isFinite(rate) && rate > 0 ? rate : 1470);
                  setPendingFile(null);
                }}
                style={{ padding: '9px 24px', borderRadius: 8, background: '#1e40af', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
              >
                ✔ رفع الملف
              </button>
              <button
                onClick={() => setPendingFile(null)}
                style={{ padding: '9px 20px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', border: 'none', fontWeight: 500, fontSize: 14, cursor: 'pointer' }}
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page Header ────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#1e40af', borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: 20 }}>🔬</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: '#1e293b' }}>تحليل الصيدليات والمبيعات</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>تحليل شامل عبر الملفات المرفوعة</p>
        </div>
      </div>

      {/* ── File Selector card ──────────────────────────────── */}
      <div style={CARD}>
        {/* Clear confirm dialog */}
        {showClearConfirm && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => !clearing && setShowClearConfirm(false)}>
            <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', minWidth: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', textAlign: 'center' }} dir="rtl" onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>🗑️</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', marginBottom: 6 }}>مسح كل البيانات</div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>سيتم حذف جميع الملفات ({files.length}) وبياناتها نهائياً. هل أنت متأكد؟</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button onClick={clearAllData} disabled={clearing} style={{ padding: '9px 24px', borderRadius: 8, background: '#dc2626', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: clearing ? 'default' : 'pointer', opacity: clearing ? .7 : 1 }}>
                  {clearing ? '⏳ جاري الحذف...' : '✔ نعم، احذف'}
                </button>
                <button onClick={() => setShowClearConfirm(false)} disabled={clearing} style={{ padding: '9px 20px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', border: 'none', fontWeight: 500, fontSize: 14, cursor: 'pointer' }}>إلغاء</button>
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>الملفات:</span>
          <button onClick={() => setSelFiles(new Set(files.map(f => f.id)))} style={PILL_BTN('#eff6ff','#1d4ed8')}>تحديد الكل</button>
          <button onClick={() => setSelFiles(new Set())}                     style={PILL_BTN('#f1f5f9','#64748b')}>إلغاء الكل</button>
          {files.length > 0 && (
            <button onClick={() => setShowClearConfirm(true)} style={{ ...PILL_BTN('#fef2f2','#dc2626'), border: '1px solid #fecaca' }}>🗑 مسح كل البيانات</button>
          )}
          <span style={{ marginRight: 'auto', fontSize: 11, color: '#94a3b8' }}>{selFiles.size} / {files.length} ملف</span>
        </div>
        {/* Confirm single-file delete dialog */}
        {confirmDeleteFileId !== null && (() => {
          const cf = files.find(f => f.id === confirmDeleteFileId);
          return (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => !deletingFileId && setConfirmDeleteFileId(null)}>
              <div style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', minWidth: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', textAlign: 'center' }} dir="rtl" onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>🗑️</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', marginBottom: 6 }}>حذف الملف</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18, wordBreak: 'break-all' }}>{cf?.originalName}</div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <button onClick={() => deleteOneFile(confirmDeleteFileId)} disabled={!!deletingFileId} style={{ padding: '8px 22px', borderRadius: 8, background: '#dc2626', color: '#fff', border: 'none', fontWeight: 700, fontSize: 13, cursor: deletingFileId ? 'default' : 'pointer', opacity: deletingFileId ? .7 : 1 }}>
                    {deletingFileId ? '⏳ جاري الحذف...' : '✔ نعم، احذف'}
                  </button>
                  <button onClick={() => setConfirmDeleteFileId(null)} disabled={!!deletingFileId} style={{ padding: '8px 18px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', border: 'none', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>إلغاء</button>
                </div>
              </div>
            </div>
          );
        })()}

        {filesLoading ? <span style={{ fontSize: 12, color: '#94a3b8' }}>جاري التحميل...</span> : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {files.map(f => (
              <div key={f.id} style={{
                display: 'flex', alignItems: 'center', gap: 0,
                borderRadius: 6, fontSize: 12,
                border: selFiles.has(f.id) ? '1.5px solid #1e40af' : '1.5px solid #e2e8f0',
                background: selFiles.has(f.id) ? '#eff6ff' : '#fff',
                color: selFiles.has(f.id) ? '#1e40af' : '#6b7280',
                fontWeight: selFiles.has(f.id) ? 600 : 400,
                overflow: 'hidden',
              }}>
                <span onClick={() => toggleFile(f.id)} style={{ padding: '5px 10px', cursor: 'pointer' }}>
                  {selFiles.has(f.id) ? '✓ ' : ''}{f.originalName}
                  <span style={{ opacity: .55, marginRight: 4 }}>({f.rowCount})</span>
                </span>
                <button
                  onClick={e => { e.stopPropagation(); setConfirmDeleteFileId(f.id); }}
                  title="حذف الملف"
                  style={{
                    padding: '5px 7px', border: 'none', background: 'transparent',
                    cursor: 'pointer', color: '#94a3b8', fontSize: 13, lineHeight: 1,
                    borderRight: selFiles.has(f.id) ? '1px solid #bfdbfe' : '1px solid #e2e8f0',
                    order: -1,
                  }}
                >×</button>
              </div>
            ))}
            {files.length === 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>لا توجد ملفات</span>}
          </div>
        )}

        {/* Upload row */}
        <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 10, paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setShowUpload(v => !v)} style={{ ...PILL_BTN('#f5f3ff','#6d28d9'), border: '1.5px dashed #a5b4fc' }}>
              {showUpload ? '✕ إخفاء' : '⬆ رفع ملف جديد'}
            </button>
            {uploadMsg && <span style={{ fontSize: 12, color: uploadMsg.ok ? '#16a34a' : '#dc2626' }}>{uploadMsg.text}</span>}
          </div>
          {showUpload && (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
              onClick={() => !uploading && uploadInputRef.current?.click()}
              style={{ border: `2px dashed ${dragOver ? '#6366f1' : '#c7d2fe'}`, borderRadius: 10, background: dragOver ? '#eef2ff' : '#fafbff', padding: '18px 16px', textAlign: 'center', cursor: uploading ? 'default' : 'pointer', marginTop: 8 }}
            >
              <input ref={uploadInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) { requestUpload(f); e.target.value = ''; } }} />
              {uploading
                ? <span style={{ color: '#6366f1', fontSize: 13, fontWeight: 600 }}>⏳ جاري الرفع...</span>
                : <><div style={{ fontSize: 11, fontWeight: 600, color: '#4f46e5' }}>اسحب وأفلت أو اضغط للاختيار</div><div style={{ fontSize: 10, color: '#94a3b8' }}>.xlsx / .xls / .csv</div></>
              }
            </div>
          )}
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: '2px solid #e2e8f0', alignItems: 'flex-end' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedPharma(null); setSelectedItem(null); }} style={{
            padding: '8px 18px', border: 'none', borderRadius: '6px 6px 0 0', cursor: 'pointer',
            background: tab === t.id ? '#fff' : 'transparent',
            color: tab === t.id ? '#1e40af' : '#6b7280',
            fontWeight: tab === t.id ? 700 : 500, fontSize: 13,
            borderBottom: tab === t.id ? '2px solid #1e40af' : '2px solid transparent', marginBottom: -2,
          }}>
            {t.label}
            {t.id === 'alerts' && alerts.length > 0 && (
              <span style={{ background: '#dc2626', color: '#fff', borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 700, marginRight: 5 }}>{alerts.length}</span>
            )}
          </button>
        ))}
        {/* Currency toggle — pinned to left */}
        <div style={{ marginRight: 'auto', marginBottom: -2, display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
          {showRateEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>سعر الصرف:</span>
              <input
                value={rateInput}
                onChange={e => setRateInput(e.target.value)}
                onBlur={() => { const r = parseFloat(rateInput); if (r > 0) { setDispRate(r); } setShowRateEdit(false); }}
                onKeyDown={e => { if (e.key === 'Enter') { const r = parseFloat(rateInput); if (r > 0) { setDispRate(r); } setShowRateEdit(false); } }}
                autoFocus
                style={{ width: 72, padding: '3px 7px', borderRadius: 5, border: '1px solid #cbd5e1', fontSize: 12, textAlign: 'center' }}
              />
            </div>
          )}
          {!showRateEdit && dispCurrency === 'USD' && (
            <button onClick={() => { setRateInput(String(dispRate)); setShowRateEdit(true); }}
              style={{ fontSize: 10, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
              title="تعديل سعر الصرف"
            >✏ {dispRate}</button>
          )}
          <button
            onClick={() => setDispCurrency(v => v === 'IQD' ? 'USD' : 'IQD')}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 42, height: 30, borderRadius: 6,
              border: `1.5px solid ${dispCurrency === 'USD' ? '#f59e0b' : '#1e40af'}`,
              background: dispCurrency === 'USD' ? '#fffbeb' : '#eff6ff',
              color: dispCurrency === 'USD' ? '#b45309' : '#1e40af',
              fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}
            title={dispCurrency === 'IQD' ? 'التحويل إلى دولار' : 'التحويل إلى دينار عراقي'}
          >
            {dispCurrency === 'IQD' ? '$' : 'IQ'}
          </button>
        </div>
      </div>

      {/* ════════ PHARMACIES TAB ════════ */}
      {tab === 'pharmacies' && !selectedPharma && (
        <div>
          {selFiles.size === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#64748b', marginBottom: 6 }}>لا توجد ملفات محددة</div>
              <div style={{ fontSize: 12 }}>اختر ملفاً أو ارفع ملفاً جديداً لعرض بيانات الصيدليات</div>
            </div>
          ) : (
          <>
          {/* Toolbar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={pharmaSearch} onChange={e => onPharmaSearch(e.target.value)}
              placeholder="بحث باسم الصيدلية أو المنطقة..."
              style={{ flex: 1, minWidth: 200, maxWidth: 320, padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, background: '#fff' }} />

            {/* Group by */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '3px 4px' }}>
              <span style={{ fontSize: 11, color: '#6b7280', padding: '0 6px' }}>تجميع:</span>
              {([['none','بدون'],['area','المنطقة'],['rep','المندوب'],['item','الايتم'],['date','التاريخ']] as [GroupBy,string][]).map(([v, label]) => (
                <button key={v} onClick={() => setGroupBy(v)} style={{
                  padding: '4px 10px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  background: groupBy === v ? '#1e40af' : 'transparent',
                  color: groupBy === v ? '#fff' : '#374151',
                }}>{label}</button>
              ))}
            </div>

            <button onClick={() => loadPharmacies()} style={{ padding: '7px 14px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#374151' }}>↻ تحديث</button>
            <span style={{ fontSize: 12, color: '#6b7280' }}>{pharmacies.length} صيدلية</span>
          </div>

          {pharmaLoading ? <Loader /> : (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
              {/* Table header */}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#1e40af', color: '#fff' }}>
                    <th style={TH}>#</th>
                    <th style={{ ...TH, textAlign: 'right', minWidth: 160, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('name')}>الصيدلية{sortArrow('name', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('area')}>المنطقة{sortArrow('area', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('orders')}>الطلبيات{sortArrow('orders', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('qty')}>الكمية{sortArrow('qty', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('value')}>القيمة ({currLabel}){sortArrow('value', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('returns')}>الارجاعات{sortArrow('returns', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('items')}>الايتمات{sortArrow('items', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('last')}>آخر طلبية{sortArrow('last', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handlePharmaSort('days')}>الأيام{sortArrow('days', pharmaSortCol, pharmaSortDir)}</th>
                    <th style={{ ...TH, width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(g => (
                    <>
                      {/* Group header */}
                      {groupBy !== 'none' && (
                        <tr key={`gh-${g.key}`} style={{ background: '#e8f0fe', cursor: 'pointer' }} onClick={() => toggleGroup(g.key)}>
                          <td colSpan={11} style={{ padding: '7px 14px', fontWeight: 700, fontSize: 12, color: '#1e40af' }}>
                            {collapsedGroups.has(g.key) ? '▶' : '▼'}&nbsp;
                            {g.label}
                            <span style={{ fontWeight: 400, color: '#6b7280', marginRight: 8, fontSize: 11 }}>({g.rows.length} صيدلية)</span>
                          </td>
                        </tr>
                      )}
                      {/* Rows */}
                      {!collapsedGroups.has(g.key) && g.rows.map((p, i) => {
                        const dc = dayColor(p.daysSinceLast);
                        const expanded = expandedRows.has(p.name);
                        return (
                          <>
                            <tr key={p.name}
                              style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer', transition: 'background .1s' }}
                              onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#eff6ff'}
                              onMouseOut={e  => (e.currentTarget as HTMLElement).style.background  = i % 2 === 0 ? '#fff' : '#f9fafb'}
                            >
                              <td style={TD} onClick={() => openPharma(p.name)}>{i + 1}</td>
                              <td style={{ ...TD, fontWeight: 600, color: '#1e293b', textAlign: 'right' }} onClick={() => openPharma(p.name)}>{p.name}</td>
                              <td style={{ ...TD, color: '#6b7280' }}       onClick={() => openPharma(p.name)}>{p.areaName || '—'}</td>
                              <td style={{ ...TD, textAlign: 'right' }}    onClick={() => openPharma(p.name)}>{p.totalOrders}</td>
                              <td style={{ ...TD, textAlign: 'right' }}    onClick={() => openPharma(p.name)}>{fmt(p.totalQty)}</td>
                              <td style={{ ...TD, textAlign: 'right', color: '#047857' }} onClick={() => openPharma(p.name)}>{fmtV(p.totalValue)}</td>
                              <td style={{ ...TD, textAlign: 'center' }} onClick={() => openPharma(p.name)}>
                                {p.returnsQty > 0 ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
                                    <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 12 }}>{fmt(p.returnsQty)}</span>
                                    <span style={{ color: '#ef4444', fontSize: 10 }}>{fmtV(p.returnsValue)}</span>
                                  </div>
                                ) : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
                              </td>
                              <td style={{ ...TD, textAlign: 'right' }}    onClick={() => openPharma(p.name)}>{p.itemCount}</td>
                              <td style={{ ...TD, color: '#6b7280' }}       onClick={() => openPharma(p.name)}>{p.lastOrder ? fmtDate(p.lastOrder) : '—'}</td>
                              <td style={{ ...TD, textAlign: 'center' }}    onClick={() => openPharma(p.name)}>
                                <span style={{ background: dc.bg, color: dc.color, borderRadius: 4, padding: '2px 7px', fontWeight: 700, fontSize: 11 }}>{p.daysSinceLast}</span>
                              </td>
                              <td style={{ ...TD, textAlign: 'center' }} onClick={() => toggleRow(p.name)}>
                                <span style={{ fontSize: 10, color: '#94a3b8', cursor: 'pointer' }}>{expanded ? '▲' : '▼'}</span>
                              </td>
                            </tr>
                            {/* Expanded: top items as small chips */}
                            {expanded && (
                              <tr key={`exp-${p.name}`} style={{ background: '#f8fafc' }}>
                                <td colSpan={11} style={{ padding: '8px 16px', borderBottom: '1px solid #e2e8f0' }}>
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>الايتمات:</span>
                                    {p.topItems.map(it => (
                                      <span key={it.name} style={{ background: '#e0e7ff', color: '#3730a3', borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>
                                        {it.name}&nbsp;<b>×{it.qty}</b>
                                      </span>
                                    ))}
                                    {p.topItems.length === 0 && <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                      {/* Group summary row */}
                      {!collapsedGroups.has(g.key) && groupBy !== 'none' && (() => {
                        const totalVal    = g.rows.reduce((s, p) => s + p.totalValue,   0);
                        const totalRetQty = g.rows.reduce((s, p) => s + p.returnsQty,   0);
                        const totalRetVal = g.rows.reduce((s, p) => s + p.returnsValue, 0);
                        return (
                          <tr key={`gs-${g.key}`} style={{ background: '#eef2ff', borderTop: '2px solid #c7d2fe' }}>
                            <td colSpan={5} style={{ padding: '5px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#4338ca' }}>الإجمالي</td>
                            <td style={{ ...TD, textAlign: 'right', fontWeight: 800, color: '#047857', fontSize: 12 }}>{fmtV(totalVal)}</td>
                            <td style={{ ...TD, textAlign: 'center', fontWeight: 800, fontSize: 12 }}>
                              {totalRetQty > 0 ? (
                                <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 12 }}>{fmtV(totalRetVal)}</span>
                              ) : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
                            </td>
                            <td colSpan={4} />
                          </tr>
                        );
                      })()}
                    </>
                  ))}
                  {pharmacies.length === 0 && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>لا توجد بيانات. ارفع ملفات مبيعات أولاً.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          </>
          )}
        </div>
      )}

      {/* ── Pharmacy Detail ───────────────────────────────── */}
      {tab === 'pharmacies' && selectedPharma && (
        <div>
          <button onClick={() => { setSelectedPharma(null); setPharmaDetail(null); }} style={BACK_BTN}>← رجوع</button>
          <div style={{ ...CARD, marginTop: 10 }}>
            <h2 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#1e293b' }}>{selectedPharma}</h2>
            {pharmaDetailLoading ? <Loader /> : pharmaDetail && (
              <>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  <KPI label="إجمالي الطلبيات" value={fmt(pharmaDetail.totalOrders)} />
                </div>
                {pharmaDetail.byItem.map(b => {
                  // آخر تاريخ بيع (غير مرتجع) لهذا الايتم
                  const lastSaleOrder = b.orders
                    .filter((o: any) => o.type !== 'return' && o.date)
                    .map((o: any) => o.date)
                    .sort()
                    .at(-1);
                  const itemDays = lastSaleOrder
                    ? Math.floor((Date.now() - new Date(lastSaleOrder).getTime()) / 86400000)
                    : null;
                  const idc = itemDays !== null ? dayColor(itemDays) : null;
                  return (
                  <div key={b.name} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 12px', background: '#f1f5f9', borderRadius: '6px 6px 0 0', borderBottom: '1px solid #e2e8f0' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{b.name}</span>
                      <div style={{ display: 'flex', gap: 16, fontSize: 12, alignItems: 'center' }}>
                        <span style={{ color: '#374151' }}>الكمية: <b>{fmt(b.totalQty)}</b></span>
                        <span style={{ color: '#047857' }}>القيمة: <b>{fmtV(b.totalValue)}</b></span>
                        {idc !== null && itemDays !== null && (
                          <span style={{ background: idc.bg, color: idc.color, borderRadius: 5, padding: '2px 9px', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>
                            ⏱ {itemDays} يوم
                          </span>
                        )}
                      </div>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {['التاريخ','الكمية',`القيمة (${currLabel})`,'المندوب','النوع'].map(h => <th key={h} style={TH2}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {b.orders.map((o: any, i: number) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                            <td style={TD2}>{fmtDate(o.date)}</td>
                            <td style={{ ...TD2, textAlign: 'right' }}>{fmt(o.qty)}</td>
                            <td style={{ ...TD2, textAlign: 'right', color: '#047857' }}>{fmtV(o.value)}</td>
                            <td style={TD2}>{o.rep || '—'}</td>
                            <td style={TD2}>
                              <span style={{ background: o.type === 'return' ? '#fee2e2' : '#dcfce7', color: o.type === 'return' ? '#dc2626' : '#15803d', borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
                                {o.type === 'return' ? 'مرتجع' : 'بيع'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}

      {/* ════════ ITEMS TAB ════════ */}
      {tab === 'items' && !selectedItem && (
        <div>
          {selFiles.size === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#64748b', marginBottom: 6 }}>لا توجد ملفات محددة</div>
              <div style={{ fontSize: 12 }}>اختر ملفاً أو ارفع ملفاً جديداً لعرض بيانات الايتمات</div>
            </div>
          ) : (
          <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={itemSearch} onChange={e => onItemSearch(e.target.value)} placeholder="بحث باسم الايتم..."
              style={{ flex: 1, minWidth: 200, maxWidth: 320, padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, background: '#fff' }} />
            <button onClick={() => loadItems()} style={{ padding: '7px 14px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12 }}>↻ تحديث</button>
            <span style={{ fontSize: 12, color: '#6b7280' }}>{items.length} ايتم</span>
          </div>
          {itemsLoading ? <Loader /> : (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#1e40af', color: '#fff' }}>
                    <th style={TH}>#</th>
                    <th style={{ ...TH, textAlign: 'right', minWidth: 180, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('name')}>الايتم{sortArrow('name', itemSortCol, itemSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('qty')}>الكمية{sortArrow('qty', itemSortCol, itemSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('value')}>القيمة ({currLabel}){sortArrow('value', itemSortCol, itemSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('pharmas')}>الصيدليات{sortArrow('pharmas', itemSortCol, itemSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('first')}>أول طلبية{sortArrow('first', itemSortCol, itemSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleItemSort('last')}>آخر طلبية{sortArrow('last', itemSortCol, itemSortDir)}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map((it, i) => (
                    <tr key={it.name} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer' }}
                      onClick={() => openItem(it.name)}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#eff6ff'}
                      onMouseOut={e  => (e.currentTarget as HTMLElement).style.background  = i % 2 === 0 ? '#fff' : '#f9fafb'}
                    >
                      <td style={TD}>{i + 1}</td>
                      <td style={{ ...TD, fontWeight: 600, color: '#1e293b', textAlign: 'right' }}>{it.name}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(it.totalQty)}</td>
                      <td style={{ ...TD, textAlign: 'right', color: '#047857' }}>{fmtV(it.totalValue)}</td>
                      <td style={{ ...TD, textAlign: 'center' }}>{it.pharmacyCount}</td>
                      <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(it.firstOrder)}</td>
                      <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(it.lastOrder)}</td>
                    </tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>لا توجد بيانات.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          </>
          )}
        </div>
      )}

      {/* ── Item Detail ───────────────────────────────────── */}
      {tab === 'items' && selectedItem && (
        <div>
          <button onClick={() => { setSelectedItem(null); setItemDetail(null); }} style={BACK_BTN}>← رجوع</button>
          <div style={{ ...CARD, marginTop: 10 }}>
            <h2 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#1e293b' }}>{selectedItem}</h2>
            {itemDetailLoading ? <Loader /> : itemDetail && (
              <>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  <KPI label="الصيدليات" value={fmt(itemDetail.pharmacies?.length || 0)} />
                  <KPI label="إجمالي الطلبيات" value={fmt(itemDetail.totalOrders || 0)} />
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      {['الصيدلية','المنطقة','الكمية','آخر طلبية','الأيام'].map(h => <th key={h} style={TH2}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(itemDetail.pharmacies || []).map((ph: any, i: number) => {
                      const days = Math.floor((Date.now() - new Date(ph.lastOrder).getTime()) / 86400000);
                      const dc = dayColor(days);
                      return (
                        <tr key={ph.name} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                          <td style={{ ...TD2, fontWeight: 600 }}>{ph.name}</td>
                          <td style={{ ...TD2, color: '#6b7280' }}>{ph.areaName || '—'}</td>
                          <td style={{ ...TD2, textAlign: 'right' }}>{fmt(ph.totalQty)}</td>
                          <td style={{ ...TD2, color: '#6b7280' }}>{fmtDate(ph.lastOrder)}</td>
                          <td style={{ ...TD2, textAlign: 'center' }}>
                            <span style={{ background: dc.bg, color: dc.color, borderRadius: 4, padding: '2px 7px', fontWeight: 700, fontSize: 11 }}>{days}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {/* ════════ ALERTS TAB ════════ */}
      {tab === 'alerts' && (
        <div>
          {selFiles.size === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#64748b', marginBottom: 6 }}>لا توجد ملفات محددة</div>
              <div style={{ fontSize: 12 }}>اختر ملفاً أو ارفع ملفاً جديداً لعرض التنبيهات</div>
            </div>
          ) : (
          <>
          {/* Alert controls */}
          <div style={{ ...CARD, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>حد التنبيه:</span>
            {[14, 30, 60, 90].map(d => (
              <button key={d} onClick={() => setAlertDays(d)} style={{
                padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12,
                background: alertDays === d ? '#1e40af' : '#f1f5f9',
                color: alertDays === d ? '#fff' : '#374151', fontWeight: alertDays === d ? 700 : 500,
              }}>{d} يوم</button>
            ))}
            <input type="number" value={alertDays} min={1} max={365} onChange={e => setAlertDays(Number(e.target.value))}
              style={{ width: 64, padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, textAlign: 'center' }} />
            <input value={alertSearch} onChange={e => setAlertSearch(e.target.value)} placeholder="بحث..."
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, marginRight: 'auto' }} />
            <button onClick={loadAlerts} style={{ padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12 }}>↻</button>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{filteredAlerts.length} تنبيه</span>
          </div>

          {alertsLoading ? <Loader /> : (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#1e40af', color: '#fff' }}>
                    <th style={{ ...TH, textAlign: 'right', minWidth: 160, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('pharma')}>الصيدلية{sortArrow('pharma', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('item')}>الايتم{sortArrow('item', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('area')}>المنطقة{sortArrow('area', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('qty')}>الكمية السابقة{sortArrow('qty', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('orders')}>الطلبيات{sortArrow('orders', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('last')}>آخر طلبية{sortArrow('last', alertSortCol, alertSortDir)}</th>
                    <th style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleAlertSort('days')}>الأيام{sortArrow('days', alertSortCol, alertSortDir)}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAlerts.map((a, i) => {
                    const dc = dayColor(a.daysSinceLast);
                    return (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                        <td style={{ ...TD, fontWeight: 600, color: '#1e293b', textAlign: 'right' }}>{a.pharmaName}</td>
                        <td style={TD}>{a.itemName}</td>
                        <td style={{ ...TD, color: '#6b7280' }}>{a.areaName || '—'}</td>
                        <td style={{ ...TD, textAlign: 'center' }}>{fmt(a.totalQty)}</td>
                        <td style={{ ...TD, textAlign: 'center' }}>{a.orderCount}</td>
                        <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(a.lastOrder)}</td>
                        <td style={{ ...TD, textAlign: 'center' }}>
                          <span style={{ background: dc.bg, color: dc.color, borderRadius: 4, padding: '2px 7px', fontWeight: 700 }}>{a.daysSinceLast}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {sortedAlerts.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>
                      {alertSearch ? 'لا يوجد تنبيه يطابق البحث.' : `لا توجد صيدلية متأخرة عن ${alertDays} يوم. ✅`}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small reusable components ─────────────────────────────────
function KPI({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 14px' }}>
      <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#1e293b' }}>{value}</div>
    </div>
  );
}
function Loader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 100, color: '#94a3b8', gap: 8 }}>
      <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2.5px solid #dde3ef', borderTopColor: '#1e40af', animation: 'spin .7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize: 13 }}>جاري التحميل...</span>
    </div>
  );
}

// ── Style constants ───────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
  padding: '12px 16px', marginBottom: 14, boxShadow: '0 1px 3px rgba(0,0,0,.04)',
};
const TH: React.CSSProperties = {
  padding: '9px 12px', textAlign: 'right', fontWeight: 600, fontSize: 12,
  whiteSpace: 'nowrap', borderLeft: '1px solid rgba(255,255,255,.15)',
};
const TD: React.CSSProperties = {
  padding: '7px 12px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#374151',
};
const TH2: React.CSSProperties = {
  padding: '7px 12px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: '#374151',
  borderBottom: '1.5px solid #e2e8f0', whiteSpace: 'nowrap',
};
const TD2: React.CSSProperties = {
  padding: '6px 12px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#374151',
};
const BACK_BTN: React.CSSProperties = {
  padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6,
  background: '#fff', cursor: 'pointer', fontSize: 12, color: '#374151',
};
function PILL_BTN(bg: string, color: string): React.CSSProperties {
  return { padding: '3px 10px', borderRadius: 6, border: 'none', background: bg, color, fontWeight: 600, fontSize: 11, cursor: 'pointer' };
}
